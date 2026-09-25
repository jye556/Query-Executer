"""Authentication primitives for Query Execute.

The application deliberately keeps this module small: passwords are hashed with
Argon2id and session cookies contain only random, opaque values.  Session
persistence and authorization queries live in :mod:`app.main` and
:mod:`app.migrations`.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import os
import secrets
import struct
import time
from typing import Tuple

try:  # argon2-cffi is a required application dependency.
    from argon2 import PasswordHasher, Type
    from argon2.exceptions import InvalidHashError, VerificationError, VerifyMismatchError
except ImportError:  # pragma: no cover - gives a useful startup error if packaging is broken
    PasswordHasher = None  # type: ignore[assignment]
    Type = None  # type: ignore[assignment]
    InvalidHashError = VerificationError = VerifyMismatchError = Exception  # type: ignore[misc,assignment]


SESSION_COOKIE_NAME = "qe_session"
CSRF_COOKIE_NAME = "qe_csrf"
CSRF_HEADER_NAME = "X-CSRF-Token"
DEFAULT_SESSION_TTL_SECONDS = 24 * 60 * 60
DEFAULT_IDLE_TIMEOUT_SECONDS = 15 * 60


def idle_timeout_seconds() -> int:
    try:
        value = int(os.getenv("IDLE_TIMEOUT_SECONDS", str(DEFAULT_IDLE_TIMEOUT_SECONDS)))
    except ValueError:
        value = DEFAULT_IDLE_TIMEOUT_SECONDS
    return max(60, min(value, 24 * 60 * 60))


_password_hasher = None
if PasswordHasher is not None:
    # Explicitly select Argon2id.  These values are intentionally configurable
    # only by changing the application, not by request data.
    _password_hasher = PasswordHasher(
        time_cost=3,
        memory_cost=65536,
        parallelism=2,
        hash_len=32,
        salt_len=16,
        type=Type.ID,
    )


def hash_password(password: str) -> str:
    """Return an Argon2id password hash without ever logging the password."""
    if _password_hasher is None:
        raise RuntimeError("argon2-cffi is required for password authentication")
    if not isinstance(password, str) or not password:
        raise ValueError("Password must not be empty")
    return _password_hasher.hash(password)


def verify_password(password: str, password_hash: str) -> bool:
    """Verify a password while treating malformed hashes as a normal failure."""
    if _password_hasher is None or not isinstance(password, str) or not isinstance(password_hash, str):
        return False
    try:
        return bool(_password_hasher.verify(password_hash, password))
    except (VerifyMismatchError, VerificationError, InvalidHashError, ValueError):
        return False


def needs_rehash(password_hash: str) -> bool:
    if _password_hasher is None:
        return False
    try:
        return bool(_password_hasher.check_needs_rehash(password_hash))
    except Exception:
        return False


def generate_totp_secret() -> str:
    """Create a 160-bit Base32 secret compatible with authenticator apps."""
    return base64.b32encode(secrets.token_bytes(20)).decode("ascii").rstrip("=")


def totp_code(secret: str, timestamp: float | None = None) -> str:
    """Generate a six-digit RFC 6238 TOTP using SHA-1 and a 30-second step."""
    normalized = "".join(secret.upper().split())
    key = base64.b32decode(normalized + "=" * (-len(normalized) % 8), casefold=True)
    counter = int((time.time() if timestamp is None else timestamp) // 30)
    digest = hmac.new(key, struct.pack(">Q", counter), hashlib.sha1).digest()
    offset = digest[-1] & 0x0F
    value = struct.unpack(">I", digest[offset:offset + 4])[0] & 0x7FFFFFFF
    return f"{value % 1_000_000:06d}"


def verify_totp(secret: str, code: str, timestamp: float | None = None) -> bool:
    """Validate a TOTP, allowing one adjacent 30-second step for clock skew."""
    if not isinstance(code, str) or not code.isascii() or not code.isdigit() or len(code) != 6:
        return False
    current = time.time() if timestamp is None else timestamp
    try:
        return any(hmac.compare_digest(totp_code(secret, current + offset * 30), code) for offset in (-1, 0, 1))
    except (ValueError, TypeError):
        return False


def totp_provisioning_uri(secret: str, username: str, issuer: str = "Query Execute") -> str:
    """Return the otpauth URI consumed by common authenticator applications."""
    from urllib.parse import quote, urlencode

    label = quote(f"{issuer}:{username}", safe="")
    query = urlencode({"secret": secret, "issuer": issuer, "algorithm": "SHA1", "digits": 6, "period": 30})
    return f"otpauth://totp/{label}?{query}"


def new_session_tokens() -> Tuple[str, str]:
    """Create the raw session and CSRF tokens sent to a browser once."""
    return secrets.token_urlsafe(48), secrets.token_urlsafe(32)


def digest_token(token: str) -> str:
    """Hash a bearer token before it is stored in metadata."""
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


def constant_time_token_equal(raw_token: str, stored_digest: str) -> bool:
    if not raw_token or not stored_digest:
        return False
    return hmac.compare_digest(digest_token(raw_token), stored_digest)


def session_ttl_seconds() -> int:
    try:
        value = int(os.getenv("SESSION_TTL_SECONDS", str(DEFAULT_SESSION_TTL_SECONDS)))
    except ValueError:
        value = DEFAULT_SESSION_TTL_SECONDS
    return max(300, min(value, 7 * 24 * 60 * 60))


def encryption_key_bytes() -> bytes | None:
    """Return a stable Fernet key derived from APP_ENCRYPTION_KEY.

    Fernet accepts a base64-encoded 32-byte key.  Operators may provide either
    one directly or any sufficiently secret environment value; the latter is
    deterministically expanded with SHA-256.  With no configured key, callers
    retain legacy plaintext rows for backwards compatibility, but new
    deployments should always set APP_ENCRYPTION_KEY.
    """
    configured = os.getenv("APP_ENCRYPTION_KEY")
    if not configured:
        return None
    try:
        decoded = base64.urlsafe_b64decode(configured.encode("ascii"))
        if len(decoded) == 32:
            return base64.urlsafe_b64encode(decoded)
    except Exception:
        pass
    return base64.urlsafe_b64encode(hashlib.sha256(configured.encode("utf-8")).digest())
