"""FastAPI application for Query Execute.

The metadata database is intentionally the authorization boundary: customer
database credentials never come from a normal query request, and every
connection/history operation is scoped to the authenticated user.
"""

from __future__ import annotations

import base64
import json
import os
from pathlib import Path
import re
from urllib.error import URLError
from urllib.request import Request as UrlRequest, urlopen
import sqlite3
import threading
import time
import uuid
from datetime import datetime, timedelta, timezone
from urllib.parse import quote
from typing import Any, Dict, Iterable, List, Optional, Union

from fastapi import Depends, FastAPI, HTTPException, Query, Request, status
from fastapi.exceptions import RequestValidationError
from fastapi.responses import HTMLResponse, JSONResponse, RedirectResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates
from pydantic import BaseModel, Field, field_validator

try:
    import psycopg2
    from psycopg2.extras import Json as PostgresJson, RealDictCursor
except ImportError:  # pragma: no cover - optional for SQLite-only development
    psycopg2 = None
    PostgresJson = None
    RealDictCursor = None

try:
    from cryptography.fernet import Fernet, InvalidToken
except ImportError:  # pragma: no cover - requirements install this dependency
    Fernet = None
    InvalidToken = Exception

from app.auth import (
    CSRF_COOKIE_NAME,
    CSRF_HEADER_NAME,
    SESSION_COOKIE_NAME,
    constant_time_token_equal,
    digest_token,
    encryption_key_bytes,
    hash_password,
    idle_timeout_seconds,
    new_session_tokens,
    needs_rehash,
    session_ttl_seconds,
    verify_password,
    generate_totp_secret,
    totp_provisioning_uri,
    verify_totp,
)
from app.db_service import DatabaseType, apply_query_edits, cancel_query, execute_query, generate_table_ddl, get_schema_diff, get_schema_metadata, get_supported_databases, test_connection, validate_query
from app.migrations import normalize_json, run_migrations


BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
_RELEASE_METADATA_PATH = Path(__file__).with_name("releases.json")

def _release_metadata() -> Dict[str, Any]:
    try:
        metadata = json.loads(_RELEASE_METADATA_PATH.read_text(encoding="utf-8"))
        if not isinstance(metadata, dict) or not isinstance(metadata.get("releases"), list):
            raise ValueError("Invalid release metadata")
        return metadata
    except (OSError, ValueError, json.JSONDecodeError):
        return {"version": "1.0.3", "releases": []}


STATIC_DIR = os.path.join(BASE_DIR, "app", "static")
TEMPLATES_DIR = os.path.join(BASE_DIR, "app", "templates")
DATABASE_URL = os.getenv("DATABASE_URL")
USE_POSTGRES = bool(DATABASE_URL)

app = FastAPI(
    title="Query Execute",
    description="A secure, multi-database SQL query workspace.",
    version="1.3.0",
)
app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")
templates = Jinja2Templates(directory=TEMPLATES_DIR)


_SENSITIVE_VALIDATION_FIELDS = {
    "password", "password_hash", "token", "csrf_token", "secret",
    "extra_params", "dsn", "connection_string",
}


@app.exception_handler(RequestValidationError)
async def validation_error_handler(request: Request, exc: RequestValidationError):
    """Avoid echoing submitted credentials in Pydantic 422 responses."""
    safe_errors: List[Dict[str, Any]] = []
    for error in exc.errors():
        safe_error = dict(error)
        location = tuple(str(part).lower() for part in error.get("loc", ()))
        if any(
            part in _SENSITIVE_VALIDATION_FIELDS
            or any(field in part for field in _SENSITIVE_VALIDATION_FIELDS)
            for part in location
        ):
            safe_error.pop("input", None)
            safe_error["msg"] = "Invalid value"
        # Pydantic v2 includes the original exception in ``ctx.error`` for
        # custom validators.  It is not JSON serializable and can itself carry
        # submitted data, so keep only a safe message in the public 422 body.
        ctx = safe_error.get("ctx")
        if isinstance(ctx, dict):
            safe_error["ctx"] = {key: value for key, value in ctx.items() if key != "error"}
            if not safe_error["ctx"]:
                safe_error.pop("ctx", None)
        safe_errors.append(safe_error)
    return JSONResponse({"detail": safe_errors}, status_code=422)


# ---------------------------------------------------------------------------
# Metadata database and secret handling
# ---------------------------------------------------------------------------


def get_db_conn():
    """Open a metadata connection using PostgreSQL or the local SQLite file."""
    if USE_POSTGRES:
        if psycopg2 is None:
            raise RuntimeError("psycopg2 is required when DATABASE_URL is configured")
        return psycopg2.connect(DATABASE_URL)
    db_path = os.getenv("SQLITE_DB_PATH", os.path.join(BASE_DIR, "query_execute.db"))
    conn = sqlite3.connect(db_path, timeout=30)
    conn.row_factory = sqlite3.Row
    return conn


def _now_utc() -> datetime:
    # Naive UTC works consistently with PostgreSQL TIMESTAMP and SQLite's
    # timestamp adapter while still being unambiguous in this application.
    return datetime.now(timezone.utc).replace(tzinfo=None)


def _safe_local_path(value: Optional[str]) -> Optional[str]:
    """Return a normalized SQLite path, rejecting URI/virtual databases."""
    if value is None:
        return None
    path = str(value).strip()
    if not path or path == ":memory:":
        return path or None
    # sqlite3 accepts URI filenames (``file:...``) that can open arbitrary
    # resources and attach query parameters.  Saved SQLite targets are plain
    # filesystem paths only; this keeps a connection record from becoming a
    # metadata-file or arbitrary URI access primitive.
    if path.lower().startswith(("file:", "\\\\", "//")):
        raise ValueError("SQLite database paths must be local filesystem paths")
    return os.path.abspath(os.path.expanduser(path))


def _validate_connection_input(payload: "ConnectionInput") -> None:
    """Validate and normalize the form's database-specific parameters."""
    allowed_types = {item.value for item in DatabaseType}
    db_type = payload.db_type.strip().lower()
    if db_type not in allowed_types:
        raise HTTPException(status_code=400, detail="Unsupported database type")
    if db_type == DatabaseType.SQLITE.value:
        try:
            _safe_local_path(payload.database)
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
    if db_type == DatabaseType.MYSQL.value:
        if not payload.database or not payload.database.strip():
            raise HTTPException(status_code=400, detail="MySQL database name is required")
        payload.database = payload.database.strip()
    if payload.extra_params and not isinstance(payload.extra_params, dict):
        raise HTTPException(status_code=400, detail="Extra parameters must be a JSON object")


def _db_param(value: Any) -> Any:
    if USE_POSTGRES and isinstance(value, (dict, list)) and PostgresJson is not None:
        return PostgresJson(value)
    if not USE_POSTGRES and isinstance(value, (dict, list)):
        return json.dumps(value, separators=(",", ":"))
    return value


def _placeholders(count: int) -> str:
    return ", ".join(["%s" if USE_POSTGRES else "?"] * count)


def _one(row: Any) -> Optional[Dict[str, Any]]:
    if row is None:
        return None
    return dict(row)


def _rows(cursor: Any) -> List[Dict[str, Any]]:
    return [dict(row) for row in cursor.fetchall()]


def _cursor(conn: Any, *, dict_rows: bool = False):
    if USE_POSTGRES and dict_rows and RealDictCursor is not None:
        return conn.cursor(cursor_factory=RealDictCursor)
    return conn.cursor()


def _fernet() -> Optional[Any]:
    if Fernet is None:
        return None
    key = encryption_key_bytes()
    return Fernet(key) if key else None


def _encrypt_password(password: Optional[str]) -> Optional[str]:
    if password is None or password == "":
        return None
    fernet = _fernet()
    if fernet is None:
        # Existing installations without APP_ENCRYPTION_KEY retain compatibility
        # through the legacy password column.  It is never returned to clients.
        return None
    return fernet.encrypt(password.encode("utf-8")).decode("ascii")


def _decrypt_password(row: Dict[str, Any]) -> Optional[str]:
    encrypted = row.get("password_encrypted")
    if encrypted:
        fernet = _fernet()
        if fernet is None:
            raise RuntimeError("APP_ENCRYPTION_KEY is required to use this saved connection")
        try:
            return fernet.decrypt(str(encrypted).encode("ascii")).decode("utf-8")
        except (InvalidToken, ValueError, UnicodeError) as exc:
            raise RuntimeError("Saved connection password cannot be decrypted") from exc
    # Legacy rows are read only for server-side connection attempts.  They never
    # appear in response DTOs, logs, or browser state.
    return row.get("password")


def totp_qr_svg_data_url(otpauth_uri: str) -> str:
    """Generate locally pinned SVG QR; provisioning data stays server-side."""
    try:
        import qrcode

        qr = qrcode.QRCode(error_correction=qrcode.constants.ERROR_CORRECT_M, box_size=6, border=4)
        qr.add_data(otpauth_uri)
        qr.make(fit=True)
        matrix = qr.get_matrix()
        quiet = 4
        size = len(matrix) + quiet * 2
        modules = "".join(
            f"M{x + quiet},{y + quiet}h1v1h-1z"
            for y, row in enumerate(matrix)
            for x, dark in enumerate(row)
            if dark
        )
        svg = (
            f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {size} {size}" '
            f'role="img" aria-label="Authenticator setup QR code" shape-rendering="crispEdges">'
            f'<path fill="#fff" d="M0 0h{size}v{size}H0z"/>'
            f'<path d="{modules}"/></svg>'
        ).encode("utf-8")
        return "data:image/svg+xml;base64," + base64.b64encode(svg).decode("ascii")
    except ImportError as exc:  # pragma: no cover - installed in the application image
        raise HTTPException(status_code=503, detail="QR code support is unavailable") from exc


def _encrypt_totp_secret(secret: str) -> str:
    fernet = _fernet()
    if fernet is None:
        raise HTTPException(status_code=503, detail="APP_ENCRYPTION_KEY is required for authenticator setup")
    return fernet.encrypt(secret.encode("utf-8")).decode("ascii")


def _decrypt_totp_secret(encrypted: str) -> str:
    fernet = _fernet()
    if fernet is None:
        raise HTTPException(status_code=503, detail="APP_ENCRYPTION_KEY is required for authenticator login")
    try:
        return fernet.decrypt(encrypted.encode("ascii")).decode("utf-8")
    except (InvalidToken, ValueError, UnicodeError) as exc:
        raise HTTPException(status_code=503, detail="Authenticator secret cannot be decrypted") from exc


def _safe_extra_params(value: Any) -> Dict[str, Any]:
    return normalize_json(value)


def _public_extra_params(value: Any) -> Dict[str, Any]:
    """Return connection options with credential-like fields redacted."""
    sensitive_tokens = (
        "password", "passwd", "secret", "token", "api_key", "private_key",
        "access_key", "credential", "keyfile", "certificate", "cert", "dsn",
    )

    def redact(item: Any) -> Any:
        if isinstance(item, dict):
            safe: Dict[str, Any] = {}
            for key, nested in item.items():
                key_text = str(key)
                if any(token in key_text.lower() for token in sensitive_tokens):
                    safe[key_text] = "[redacted]"
                else:
                    safe[key_text] = redact(nested)
            return safe
        if isinstance(item, list):
            return [redact(nested) for nested in item]
        return item

    return redact(_safe_extra_params(value))


def _connection_select_sql() -> str:
    return """
        SELECT c.id, c.name, c.db_type, c.host, c.port, c.database, c.username,
               c.extra_params, c.owner_id, c.password_encrypted, c.password,
               c.connection_group
        FROM connections c
    """


def _group_rows_for_connections(
    conn: Any,
    connection_ids: Iterable[str],
    user: Optional[Dict[str, Any]] = None,
) -> Dict[str, List[Dict[str, Any]]]:
    """Return only group metadata the caller is allowed to know.

    Admins may see every group attached to a connection.  Other callers only
    receive groups they belong to; otherwise a shared connection could disclose
    the names of unrelated groups through its response DTO.
    """
    ids = list(connection_ids)
    result: Dict[str, List[Dict[str, Any]]] = {connection_id: [] for connection_id in ids}
    if not ids:
        return result
    marks = _placeholders(len(ids))
    cur = _cursor(conn, dict_rows=True)
    params: List[Any] = []
    visibility = ""
    if user is not None and user.get("role") != "admin":
        visibility = (
            " JOIN user_groups visible_ug ON visible_ug.group_id = cg.group_id"
            " AND visible_ug.user_id = " + ("%s" if USE_POSTGRES else "?")
        )
        # The membership placeholder appears before the IN-list placeholders
        # in the SQL text, so keep parameter order aligned with the statement.
        params.append(user["id"])
    params.extend(ids)
    cur.execute(
        f'''SELECT cg.connection_id, g.id, g.name
            FROM connection_groups cg{visibility} JOIN "groups" g ON g.id = cg.group_id
            WHERE cg.connection_id IN ({marks}) ORDER BY g.name''',
        tuple(params),
    )
    for row in _rows(cur):
        result.setdefault(str(row["connection_id"]), []).append(
            {"id": int(row["id"]), "name": row["name"]}
        )
    cur.close()
    return result


def _connection_response(
    row: Dict[str, Any],
    groups: Optional[List[Dict[str, Any]]] = None,
    user: Optional[Dict[str, Any]] = None,
) -> Dict[str, Any]:
    group_list = groups or []
    # Owners are useful to administrators, but exposing internal user IDs to
    # ordinary users is unnecessary metadata and can aid account enumeration.
    owner_id = row.get("owner_id") if user is None or user.get("role") == "admin" else None
    return {
        "id": str(row["id"]),
        "name": row["name"],
        "db_type": row["db_type"],
        "host": row.get("host"),
        "port": row.get("port"),
        "database": row.get("database"),
        "username": row.get("username"),
        "extra_params": _public_extra_params(row.get("extra_params")),
        "owner_id": owner_id,
        "groups": group_list,
        "group_ids": [group["id"] for group in group_list],
        "has_password": bool(row.get("password_encrypted") or row.get("password")),
    }


def _group_response(row: Dict[str, Any]) -> Dict[str, Any]:
    return {"id": int(row["id"]), "name": row["name"], "created_by": row.get("created_by")}


def _user_response(row: Dict[str, Any], group_ids: Optional[List[int]] = None) -> Dict[str, Any]:
    return {
        "id": int(row["id"]),
        "username": row["username"],
        "role": row["role"],
        "is_active": bool(row.get("is_active", True)),
        "created_at": _iso_datetime(row.get("created_at")),
        "group_ids": group_ids or [],
        "totp_enabled": bool(row.get("totp_enabled", False)),
    }


def _iso_datetime(value: Any) -> str:
    if value is None:
        return ""
    if hasattr(value, "isoformat"):
        return value.isoformat()
    return str(value)


def _user_group_ids(conn: Any, user_id: int) -> List[int]:
    cur = conn.cursor()
    cur.execute(
        "SELECT group_id FROM user_groups WHERE user_id = %s" if USE_POSTGRES else "SELECT group_id FROM user_groups WHERE user_id = ?",
        (user_id,),
    )
    values = [int(row[0]) for row in cur.fetchall()]
    cur.close()
    return values


def _bootstrap_admin(conn: Any) -> Optional[int]:
    """Create exactly the first admin, only when both bootstrap env values exist."""
    cur = conn.cursor()
    cur.execute("SELECT id FROM users ORDER BY id LIMIT 1")
    existing = cur.fetchone()
    if existing:
        cur.close()
        return int(existing[0])

    username = (os.getenv("BOOTSTRAP_ADMIN_USERNAME") or "").strip()
    password = os.getenv("BOOTSTRAP_ADMIN_PASSWORD") or ""
    if not username or not password:
        cur.close()
        # Do not include either secret value in startup logs.  The message is
        # intentionally generic so operators can inspect configuration without
        # exposing credentials through container logs.
        print("No users exist; configure the bootstrap administrator environment variables before first login.")
        return None
    if len(username) > 150 or len(password) < 8:
        cur.close()
        print("Bootstrap admin was not created: username or password does not meet the minimum requirements.")
        return None

    password_hash = hash_password(password)
    if USE_POSTGRES:
        cur.execute(
            "INSERT INTO users (username, password_hash, role, is_active) VALUES (%s, %s, 'admin', TRUE) RETURNING id",
            (username, password_hash),
        )
        admin_id = int(cur.fetchone()[0])
    else:
        cur.execute(
            "INSERT INTO users (username, password_hash, role, is_active) VALUES (?, ?, 'admin', 1)",
            (username, password_hash),
        )
        admin_id = int(cur.lastrowid)
    conn.commit()
    cur.close()
    print("Bootstrap admin created successfully.")
    return admin_id


def _insert_group(conn: Any, name: str, created_by: Optional[int]) -> int:
    cur = conn.cursor()
    if USE_POSTGRES:
        cur.execute(
            "INSERT INTO \"groups\" (name, created_by) VALUES (%s, %s) RETURNING id",
            (name, created_by),
        )
        group_id = int(cur.fetchone()[0])
    else:
        cur.execute("INSERT INTO \"groups\" (name, created_by) VALUES (?, ?)", (name, created_by))
        group_id = int(cur.lastrowid)
    cur.close()
    return group_id


def _find_group_by_name(conn: Any, name: str) -> Optional[Dict[str, Any]]:
    cur = _cursor(conn, dict_rows=True)
    cur.execute(
        "SELECT id, name, created_by FROM \"groups\" WHERE LOWER(name) = LOWER(%s) LIMIT 1" if USE_POSTGRES else "SELECT id, name, created_by FROM \"groups\" WHERE LOWER(name) = LOWER(?) LIMIT 1",
        (name,),
    )
    row = _one(cur.fetchone())
    cur.close()
    return row


def _normalize_legacy_data(conn: Any, admin_id: Optional[int]) -> None:
    """Copy old connection_group strings into normalized groups without loss."""
    cur = _cursor(conn, dict_rows=True)
    cur.execute(_connection_select_sql())
    connection_rows = _rows(cur)
    cur.close()

    for row in connection_rows:
        connection_id = str(row["id"])
        owner_id = row.get("owner_id")
        if owner_id is None and admin_id is not None:
            cur = conn.cursor()
            cur.execute(
                "UPDATE connections SET owner_id = %s WHERE id = %s" if USE_POSTGRES else "UPDATE connections SET owner_id = ? WHERE id = ?",
                (admin_id, connection_id),
            )
            cur.close()
        legacy_name = (row.get("connection_group") or "").strip()
        if legacy_name:
            group = _find_group_by_name(conn, legacy_name)
            if not group:
                group_id = _insert_group(conn, legacy_name, admin_id)
            else:
                group_id = int(group["id"])
            cur = conn.cursor()
            if USE_POSTGRES:
                cur.execute(
                    "INSERT INTO connection_groups (connection_id, group_id) VALUES (%s, %s) ON CONFLICT DO NOTHING",
                    (connection_id, group_id),
                )
            else:
                cur.execute(
                    "INSERT OR IGNORE INTO connection_groups (connection_id, group_id) VALUES (?, ?)",
                    (connection_id, group_id),
                )
            if admin_id is not None:
                if USE_POSTGRES:
                    cur.execute(
                        "INSERT INTO user_groups (user_id, group_id) VALUES (%s, %s) ON CONFLICT DO NOTHING",
                        (admin_id, group_id),
                    )
                else:
                    cur.execute(
                        "INSERT OR IGNORE INTO user_groups (user_id, group_id) VALUES (?, ?)",
                        (admin_id, group_id),
                    )
            cur.close()
    if admin_id is not None:
        cur = conn.cursor()
        cur.execute(
            "UPDATE query_history SET user_id = %s WHERE user_id IS NULL" if USE_POSTGRES else "UPDATE query_history SET user_id = ? WHERE user_id IS NULL",
            (admin_id,),
        )
        cur.close()
    conn.commit()

    # Move legacy plaintext values into encrypted storage when an encryption key
    # is configured.  No value is printed or returned.
    if _fernet() is not None:
        fernet = _fernet()
        cur = _cursor(conn, dict_rows=True)
        cur.execute(
            "SELECT id, password FROM connections WHERE password IS NOT NULL AND (password_encrypted IS NULL OR password_encrypted = '')"
        )
        rows = _rows(cur)
        cur.close()
        for row in rows:
            encrypted = fernet.encrypt(str(row["password"]).encode("utf-8")).decode("ascii")
            cur = conn.cursor()
            cur.execute(
                "UPDATE connections SET password_encrypted = %s, password = NULL WHERE id = %s" if USE_POSTGRES else "UPDATE connections SET password_encrypted = ?, password = NULL WHERE id = ?",
                (encrypted, row["id"]),
            )
            cur.close()
        conn.commit()


def init_db() -> None:
    conn = None
    try:
        conn = get_db_conn()
        run_migrations(conn, USE_POSTGRES)
        admin_id = _bootstrap_admin(conn)
        _normalize_legacy_data(conn, admin_id)
    except Exception:
        # Startup failures should remain visible without echoing database URLs,
        # driver diagnostics, or any accidentally embedded credential.
        print("Error initializing metadata database; inspect the server configuration and database availability.")
    finally:
        if conn is not None:
            conn.close()


@app.on_event("startup")
async def startup_event() -> None:
    init_db()


# ---------------------------------------------------------------------------
# Authentication, session and CSRF boundaries
# ---------------------------------------------------------------------------


def _session_user(request: Request) -> Optional[Dict[str, Any]]:
    cached = getattr(request.state, "user", None)
    if cached is not None:
        return cached
    raw_token = request.cookies.get(SESSION_COOKIE_NAME)
    if not raw_token:
        return None
    conn = None
    try:
        conn = get_db_conn()
        cur = _cursor(conn, dict_rows=True)
        cur.execute(
            """SELECT s.id AS session_id, s.token_hash, s.csrf_token_hash, s.expires_at,
                      s.last_activity_at,
                      u.id, u.username, u.role, u.is_active, u.created_at
               FROM sessions s JOIN users u ON u.id = s.user_id
               WHERE s.token_hash = %s AND s.revoked_at IS NULL""" if USE_POSTGRES else
            """SELECT s.id AS session_id, s.token_hash, s.csrf_token_hash, s.expires_at,
                      s.last_activity_at,
                      u.id, u.username, u.role, u.is_active, u.created_at
               FROM sessions s JOIN users u ON u.id = s.user_id
               WHERE s.token_hash = ? AND s.revoked_at IS NULL""",
            (digest_token(raw_token),),
        )
        row = _one(cur.fetchone())
        cur.close()
        if not row or not bool(row.get("is_active", True)):
            return None
        expiry = row.get("expires_at")
        if isinstance(expiry, str):
            try:
                expiry = datetime.fromisoformat(expiry.replace("Z", "+00:00")).replace(tzinfo=None)
            except ValueError:
                expiry = None
        if expiry is None or expiry <= _now_utc():
            # Expired tokens should not remain reusable in the metadata store.
            # Cleanup is best effort; authorization already fails closed above.
            try:
                cleanup = conn.cursor()
                cleanup.execute(
                    "UPDATE sessions SET revoked_at = %s WHERE id = %s" if USE_POSTGRES else "UPDATE sessions SET revoked_at = ? WHERE id = ?",
                    (_now_utc(), row["session_id"]),
                )
                conn.commit()
                cleanup.close()
            except Exception:
                pass
            return None
        
        # Check idle timeout
        last_activity = row.get("last_activity_at")
        if isinstance(last_activity, str):
            try:
                last_activity = datetime.fromisoformat(last_activity.replace("Z", "+00:00")).replace(tzinfo=None)
            except ValueError:
                last_activity = None
        if last_activity is not None:
            idle_seconds = (_now_utc() - last_activity).total_seconds()
            if idle_seconds > idle_timeout_seconds():
                # Session idle too long - revoke it
                try:
                    cleanup = conn.cursor()
                    cleanup.execute(
                        "UPDATE sessions SET revoked_at = %s WHERE id = %s" if USE_POSTGRES else "UPDATE sessions SET revoked_at = ? WHERE id = ?",
                        (_now_utc(), row["session_id"]),
                    )
                    conn.commit()
                    cleanup.close()
                except Exception:
                    pass
                return None
        
        # Update last_activity_at on each request
        try:
            update_cur = conn.cursor()
            update_cur.execute(
                "UPDATE sessions SET last_activity_at = %s WHERE id = %s" if USE_POSTGRES else "UPDATE sessions SET last_activity_at = ? WHERE id = ?",
                (_now_utc(), row["session_id"]),
            )
            conn.commit()
            update_cur.close()
        except Exception:
            pass
        
        # Keep only authorization/session metadata in request state.  In
        # particular, never carry the password hash into a response DTO or
        # browser-facing object.
        user = {
            "id": int(row["id"]),
            "username": row["username"],
            "role": row["role"],
            "is_active": bool(row.get("is_active", True)),
            "created_at": row.get("created_at"),
            "session_id": int(row["session_id"]),
            "csrf_token_hash": row["csrf_token_hash"],
        }
        request.state.user = user
        return user
    except Exception:
        return None
    finally:
        if conn is not None:
            conn.close()


def _csrf_valid(request: Request, user: Optional[Dict[str, Any]]) -> bool:
    if not user:
        return False
    raw_cookie = request.cookies.get(CSRF_COOKIE_NAME)
    raw_header = request.headers.get(CSRF_HEADER_NAME)
    return bool(raw_cookie and raw_header and raw_cookie == raw_header and constant_time_token_equal(raw_header, user.get("csrf_token_hash", "")))


@app.middleware("http")
async def api_security_boundary(request: Request, call_next):
    path = request.url.path
    is_api = path == "/api" or path.startswith("/api/")
    public_api = path in {"/api/auth/login", "/api/login", "/api/health", "/api/version"}
    if is_api and not public_api and request.method != "OPTIONS":
        user = _session_user(request)
        if not user:
            return JSONResponse({"detail": "Authentication required"}, status_code=status.HTTP_401_UNAUTHORIZED)
        if request.method in {"POST", "PUT", "PATCH", "DELETE"} and not _csrf_valid(request, user):
            return JSONResponse({"detail": "CSRF token missing or invalid"}, status_code=status.HTTP_403_FORBIDDEN)
    return await call_next(request)


def current_user(request: Request) -> Dict[str, Any]:
    user = _session_user(request)
    if not user:
        raise HTTPException(status_code=401, detail="Authentication required")
    return user


def admin_user(user: Dict[str, Any] = Depends(current_user)) -> Dict[str, Any]:
    if user.get("role") != "admin":
        raise HTTPException(status_code=403, detail="Administrator access required")
    return user


def _set_auth_cookies(response: Any, session_token: str, csrf_token: str) -> None:
    secure = os.getenv("COOKIE_SECURE", "0").lower() in {"1", "true", "yes"}
    # A secure deployment must not silently issue cookies over plaintext HTTP.
    # COOKIE_SECURE is explicit so local SQLite development remains convenient.
    response.set_cookie(
        SESSION_COOKIE_NAME,
        session_token,
        max_age=session_ttl_seconds(),
        httponly=True,
        secure=secure,
        samesite="lax",
        path="/",
    )
    response.set_cookie(
        CSRF_COOKIE_NAME,
        csrf_token,
        max_age=session_ttl_seconds(),
        httponly=False,
        secure=secure,
        samesite="lax",
        path="/",
    )


def _clear_auth_cookies(response: Any) -> None:
    response.delete_cookie(SESSION_COOKIE_NAME, path="/")
    response.delete_cookie(CSRF_COOKIE_NAME, path="/")


# ---------------------------------------------------------------------------
# Pydantic request/response models
# ---------------------------------------------------------------------------


class LoginRequest(BaseModel):
    username: str = Field(..., min_length=1, max_length=150)
    password: str = Field(..., min_length=1, max_length=1024)
    totp_code: Optional[str] = Field(None, min_length=6, max_length=6)


class TotpCodeRequest(BaseModel):
    code: str = Field(..., min_length=6, max_length=6)


class ConnectionInput(BaseModel):
    name: str = Field(..., min_length=1, max_length=100)
    db_type: str = Field(..., min_length=1, max_length=30)

    @field_validator("name")
    @classmethod
    def validate_name(cls, value: str) -> str:
        value = value.strip()
        if not value:
            raise ValueError("Connection name must not be blank")
        return value
    host: Optional[str] = Field(None, max_length=255)
    port: Optional[int] = Field(None, ge=1, le=65535)
    database: Optional[str] = Field(None, max_length=1024)
    username: Optional[str] = Field(None, max_length=255)
    password: Optional[str] = Field(None, max_length=4096)
    extra_params: Dict[str, Any] = Field(default_factory=dict)

    group_ids: List[int] = Field(default_factory=list, max_length=100)
    # Only admins can explicitly remove a saved credential while editing.
    clear_password: bool = False


class ConnectionTestInput(BaseModel):
    """Unsaved form values used for a one-shot connection test."""

    db_type: str = Field(..., min_length=1, max_length=30)
    host: Optional[str] = Field("", max_length=255)
    port: Optional[int] = Field(None, ge=1, le=65535)
    database: Optional[str] = Field(None, max_length=1024)
    username: Optional[str] = Field("", max_length=255)
    password: Optional[str] = Field(None, max_length=4096)
    extra_params: Dict[str, Any] = Field(default_factory=dict)

    @field_validator("db_type")
    @classmethod
    def validate_db_type(cls, value: str) -> str:
        value = value.strip().lower()
        if value not in {item.value for item in DatabaseType}:
            raise ValueError("Unsupported database type")
        return value


class ConnectionResponse(BaseModel):
    id: str
    name: str
    db_type: str
    host: Optional[str] = None
    port: Optional[int] = None
    database: Optional[str] = None
    username: Optional[str] = None
    extra_params: Dict[str, Any] = Field(default_factory=dict)
    owner_id: Optional[int] = None
    groups: List[Dict[str, Any]] = Field(default_factory=list)
    group_ids: List[int] = Field(default_factory=list)
    has_password: bool = False


class QueryEditRequest(BaseModel):
    connection_id: str = Field(..., min_length=1, max_length=50)
    query: str = Field(..., min_length=1, max_length=200_000)
    edits: List[Dict[str, Any]] = Field(..., min_length=1, max_length=1000)


class QueryRequest(BaseModel):
    connection_id: str = Field(..., min_length=1, max_length=50)
    query: str = Field(..., min_length=1, max_length=200_000)
    limit: Optional[int] = Field(default=1000, ge=1, le=10000)
    parameters: Optional[Any] = Field(default=None, description="Query bind parameters (dict or list)")
    execution_id: Optional[str] = Field(default=None, max_length=100, description="Optional client execution tracking ID")


class QueryCancelRequest(BaseModel):
    execution_id: str = Field(..., min_length=1, max_length=100)


class QueryValidationRequest(BaseModel):
    connection_id: str = Field(..., min_length=1, max_length=50)
    query: str = Field(..., min_length=1, max_length=200_000)
    parameters: Optional[Any] = Field(default=None, description="Query bind parameters for validation (dict or list)")


class QueryHistoryItem(BaseModel):
    id: int
    connection_id: Optional[str]
    query: str
    executed_at: str
    success: bool
    row_count: Optional[int]
    execution_time_ms: Optional[int]
    error_message: Optional[str]


class GroupInput(BaseModel):
    name: str = Field(..., min_length=1, max_length=150)

    @field_validator("name")
    @classmethod
    def validate_name(cls, value: str) -> str:
        value = value.strip()
        if not value:
            raise ValueError("Group name must not be blank")
        return value


class GroupResponse(BaseModel):
    id: int
    name: str
    created_by: Optional[int] = None


class MembershipInput(BaseModel):
    user_ids: List[int] = Field(default_factory=list, max_length=100)


class UserInput(BaseModel):
    username: str = Field(..., min_length=1, max_length=150)
    password: Optional[str] = Field(None, min_length=8, max_length=1024)
    role: str = Field(default="viewer", pattern="^(viewer|writer|admin)$")
    is_active: bool = True
    group_ids: List[int] = Field(default_factory=list, max_length=100)


class UserUpdate(BaseModel):
    password: Optional[str] = Field(None, min_length=8, max_length=1024)
    role: Optional[str] = Field(None, pattern="^(viewer|writer|admin)$")
    is_active: Optional[bool] = None
    group_ids: Optional[List[int]] = Field(None, max_length=100)


# ---------------------------------------------------------------------------
# HTML and public health endpoints
# ---------------------------------------------------------------------------


def _login_redirect(request: Request) -> RedirectResponse:
    # Preserve the requested local path so the UI can return after login.  The
    # login page validates this value again before navigating, but keeping it
    # local here prevents the server from generating an open redirect URL.
    target = request.url.path
    if request.url.query:
        target += "?" + request.url.query
    return RedirectResponse("/login.html?next=" + quote(target, safe=""), status_code=303)


@app.get("/", response_class=HTMLResponse)
async def index(request: Request):
    if not _session_user(request):
        return _login_redirect(request)
    return templates.TemplateResponse(request=request, name="index.html")


@app.get("/login.html", response_class=HTMLResponse)
async def login_page(request: Request):
    if _session_user(request):
        return RedirectResponse("/", status_code=303)
    return templates.TemplateResponse(request=request, name="login.html")


@app.get("/api/version")
async def get_version():
    data = _release_metadata()
    releases = data.get("releases", [])
    latest = max(
        releases,
        key=lambda release: tuple(int(part) for part in release.get("version", "0.0.0").lstrip("v").split(".")),
        default={"version": app.version},
    )
    default_feed = f"https://api.github.com/repos/{os.getenv('GITHUB_REPOSITORY', 'jye556/Query-Executer')}/releases/latest"
    update_url = os.getenv("UPDATE_CHECK_URL", default_feed).strip()
    if update_url:
        try:
            request = UrlRequest(update_url, headers={"Accept": "application/vnd.github+json", "User-Agent": "Query-Execute-Version-Check"})
            with urlopen(request, timeout=3) as response:
                remote = json.loads(response.read(65536).decode("utf-8"))
            remote_version = str(remote.get("tag_name", "")).strip()
            if re.fullmatch(r"v?\d+\.\d+\.\d+", remote_version):
                latest = {"version": remote_version, "notes": [str(remote.get("name") or "GitHub release")], "html_url": remote.get("html_url")}
        except (OSError, ValueError, URLError):
            pass
    current = tuple(int(part) for part in app.version.split("."))
    latest_semver = tuple(int(part) for part in str(latest.get("version", app.version)).lstrip("v").split("."))
    return {
        "version": app.version,
        "latest_version": latest.get("version", app.version),
        "update_available": latest_semver > current,
        "release_url": latest.get("html_url") or os.getenv("UPDATE_RELEASES_URL", f"https://github.com/{os.getenv('GITHUB_REPOSITORY', 'jye556/Query-Executer')}/releases/latest"),
        "changelog": releases,
    }


@app.get("/health")
@app.get("/api/health")
async def health():
    return {"status": "ok"}


# ---------------------------------------------------------------------------
# Authentication APIs
# ---------------------------------------------------------------------------


@app.post("/api/auth/login")
@app.post("/api/login")
async def login(payload: LoginRequest):
    conn = get_db_conn()
    try:
        cur = _cursor(conn, dict_rows=True)
        cur.execute(
            "SELECT id, username, password_hash, role, is_active, created_at, totp_secret, totp_enabled FROM users WHERE LOWER(username) = LOWER(%s) LIMIT 1" if USE_POSTGRES else
            "SELECT id, username, password_hash, role, is_active, created_at, totp_secret, totp_enabled FROM users WHERE LOWER(username) = LOWER(?) LIMIT 1",
            (payload.username.strip(),),
        )
        row = _one(cur.fetchone())
        cur.close()
        if not row or not bool(row.get("is_active", True)) or not verify_password(payload.password, row.get("password_hash", "")):
            raise HTTPException(status_code=401, detail="Invalid username or password")
        if row.get("totp_enabled") and (
            not payload.totp_code
            or not verify_totp(_decrypt_totp_secret(row.get("totp_secret") or ""), payload.totp_code)
        ):
            raise HTTPException(status_code=401, detail="Invalid authenticator code")

        if needs_rehash(row["password_hash"]):
            cur = conn.cursor()
            cur.execute(
                "UPDATE users SET password_hash = %s WHERE id = %s" if USE_POSTGRES else "UPDATE users SET password_hash = ? WHERE id = ?",
                (hash_password(payload.password), row["id"]),
            )
            cur.close()

        session_token, csrf_token = new_session_tokens()
        expires_at = _now_utc() + timedelta(seconds=session_ttl_seconds())
        now = _now_utc()
        cur = conn.cursor()
        if USE_POSTGRES:
            cur.execute(
                "INSERT INTO sessions (token_hash, user_id, csrf_token_hash, expires_at, last_activity_at) VALUES (%s, %s, %s, %s, %s)",
                (digest_token(session_token), row["id"], digest_token(csrf_token), expires_at, now),
            )
        else:
            cur.execute(
                "INSERT INTO sessions (token_hash, user_id, csrf_token_hash, expires_at, last_activity_at) VALUES (?, ?, ?, ?, ?)",
                (digest_token(session_token), row["id"], digest_token(csrf_token), expires_at.isoformat(sep=" "), now.isoformat(sep=" ")),
            )
        conn.commit()
        cur.close()
        group_ids = _user_group_ids(conn, int(row["id"]))
        response = JSONResponse({"user": _user_response(row, group_ids)})
        _set_auth_cookies(response, session_token, csrf_token)
        return response
    finally:
        conn.close()


def _prepare_totp_setup(conn: Any, user_id: int) -> str:
    """Store an encrypted pending secret without ever resetting enabled 2FA."""
    cur = _cursor(conn, dict_rows=True)
    cur.execute(
        "SELECT totp_enabled FROM users WHERE id = %s" if USE_POSTGRES else
        "SELECT totp_enabled FROM users WHERE id = ?",
        (user_id,),
    )
    row = _one(cur.fetchone()) or {}
    cur.close()
    if row.get("totp_enabled"):
        raise HTTPException(status_code=409, detail="Authenticator verification is already enabled")
    secret = generate_totp_secret()
    encrypted_secret = _encrypt_totp_secret(secret)
    cur = conn.cursor()
    cur.execute(
        "UPDATE users SET totp_secret = %s WHERE id = %s" if USE_POSTGRES else
        "UPDATE users SET totp_secret = ? WHERE id = ?",
        (encrypted_secret, user_id),
    )
    conn.commit()
    cur.close()
    return secret


def _confirm_totp_setup(conn: Any, user_id: int, code: str) -> None:
    cur = _cursor(conn, dict_rows=True)
    cur.execute(
        "SELECT totp_secret, totp_enabled FROM users WHERE id = %s" if USE_POSTGRES else
        "SELECT totp_secret, totp_enabled FROM users WHERE id = ?",
        (user_id,),
    )
    row = _one(cur.fetchone()) or {}
    cur.close()
    if not row.get("totp_secret") or row.get("totp_enabled"):
        raise HTTPException(status_code=400, detail="Start authenticator setup before enabling it")
    if not verify_totp(_decrypt_totp_secret(row["totp_secret"]), code):
        raise HTTPException(status_code=400, detail="Invalid authenticator code")
    cur = conn.cursor()
    cur.execute(
        "UPDATE users SET totp_enabled = TRUE WHERE id = %s" if USE_POSTGRES else
        "UPDATE users SET totp_enabled = 1 WHERE id = ?",
        (user_id,),
    )
    conn.commit()
    cur.close()


@app.post("/api/auth/totp/setup")
async def setup_totp(user: Dict[str, Any] = Depends(current_user)):
    conn = get_db_conn()
    try:
        secret = _prepare_totp_setup(conn, int(user["id"]))
    finally:
        conn.close()
    issuer = "Query Execute"
    uri = totp_provisioning_uri(secret, user["username"], issuer)
    return {
        "secret": secret,
        "otpauth_uri": uri,
        "qr_code_data_url": totp_qr_svg_data_url(uri),
    }


@app.post("/api/auth/totp/enable")
async def enable_totp(payload: TotpCodeRequest, user: Dict[str, Any] = Depends(current_user)):
    conn = get_db_conn()
    try:
        _confirm_totp_setup(conn, int(user["id"]), payload.code)
        return {"success": True}
    finally:
        conn.close()



def _disable_totp(conn: Any, user_id: int, code: str) -> None:
    cur = _cursor(conn, dict_rows=True)
    cur.execute(
        "SELECT totp_secret, totp_enabled FROM users WHERE id = %s" if USE_POSTGRES else
        "SELECT totp_secret, totp_enabled FROM users WHERE id = ?",
        (user_id,),
    )
    row = _one(cur.fetchone()) or {}
    cur.close()
    if not row.get("totp_enabled") or not verify_totp(_decrypt_totp_secret(row.get("totp_secret") or ""), code):
        raise HTTPException(status_code=400, detail="Invalid authenticator code")
    cur = conn.cursor()
    cur.execute(
        "UPDATE users SET totp_secret = NULL, totp_enabled = FALSE WHERE id = %s" if USE_POSTGRES else
        "UPDATE users SET totp_secret = NULL, totp_enabled = 0 WHERE id = ?",
        (user_id,),
    )
    conn.commit()
    cur.close()


@app.post("/api/auth/totp/disable")
async def disable_totp(payload: TotpCodeRequest, user: Dict[str, Any] = Depends(current_user)):
    conn = get_db_conn()
    try:
        _disable_totp(conn, int(user["id"]), payload.code)
        return {"success": True}
    finally:
        conn.close()



@app.post("/api/auth/logout")
async def logout(request: Request, user: Dict[str, Any] = Depends(current_user)):
    # The middleware already enforces the double-submit CSRF check for this
    # cookie-authenticated mutation.  Keep the explicit dependency here as
    # defense in depth for direct function invocation/tests.
    if not _csrf_valid(request, user):
        raise HTTPException(status_code=403, detail="CSRF token missing or invalid")
    conn = get_db_conn()
    try:
        cur = conn.cursor()
        cur.execute(
            "UPDATE sessions SET revoked_at = %s WHERE id = %s" if USE_POSTGRES else "UPDATE sessions SET revoked_at = ? WHERE id = ?",
            (_now_utc(), user["session_id"]),
        )
        conn.commit()
        cur.close()
    finally:
        conn.close()
    response = JSONResponse({"success": True})
    _clear_auth_cookies(response)
    return response


@app.get("/api/auth/me")
async def me(user: Dict[str, Any] = Depends(current_user)):
    conn = get_db_conn()
    try:
        cur = _cursor(conn, dict_rows=True)
        cur.execute(
            "SELECT id, username, role, is_active, created_at, totp_enabled FROM users WHERE id = %s" if USE_POSTGRES else "SELECT id, username, role, is_active, created_at, totp_enabled FROM users WHERE id = ?",
            (user["id"],),
        )
        row = _one(cur.fetchone())
        cur.close()
        return {"user": _user_response(row or user, _user_group_ids(conn, user["id"]))}
    finally:
        conn.close()


# ---------------------------------------------------------------------------
# Users and groups (authorization management)
# ---------------------------------------------------------------------------


def _validate_group_ids(conn: Any, group_ids: Iterable[int]) -> List[int]:
    unique = list(dict.fromkeys(int(value) for value in group_ids))
    if not unique:
        return []
    cur = conn.cursor()
    cur.execute(
        f"SELECT id FROM \"groups\" WHERE id IN ({_placeholders(len(unique))})",
        tuple(unique),
    )
    found = {int(row[0]) for row in cur.fetchall()}
    cur.close()
    missing = [value for value in unique if value not in found]
    if missing:
        raise HTTPException(status_code=400, detail="One or more group IDs do not exist")
    return unique


def _replace_user_groups(conn: Any, user_id: int, group_ids: Iterable[int]) -> None:
    ids = _validate_group_ids(conn, group_ids)
    cur = conn.cursor()
    cur.execute(
        "DELETE FROM user_groups WHERE user_id = %s" if USE_POSTGRES else "DELETE FROM user_groups WHERE user_id = ?",
        (user_id,),
    )
    for group_id in ids:
        if USE_POSTGRES:
            cur.execute(
                "INSERT INTO user_groups (user_id, group_id) VALUES (%s, %s) ON CONFLICT DO NOTHING",
                (user_id, group_id),
            )
        else:
            cur.execute("INSERT OR IGNORE INTO user_groups (user_id, group_id) VALUES (?, ?)", (user_id, group_id))
    cur.close()


@app.get("/api/groups", response_model=List[GroupResponse])
async def list_groups(user: Dict[str, Any] = Depends(current_user)):
    conn = get_db_conn()
    try:
        cur = _cursor(conn, dict_rows=True)
        if user["role"] == "admin":
            cur.execute("SELECT id, name, created_by FROM \"groups\" ORDER BY name")
        else:
            cur.execute(
                """SELECT g.id, g.name, g.created_by FROM "groups" g
                   JOIN user_groups ug ON ug.group_id = g.id WHERE ug.user_id = %s ORDER BY g.name""" if USE_POSTGRES else
                """SELECT g.id, g.name, g.created_by FROM "groups" g
                   JOIN user_groups ug ON ug.group_id = g.id WHERE ug.user_id = ? ORDER BY g.name""",
                (user["id"],),
            )
        rows = _rows(cur)
        cur.close()
        return [_group_response(row) for row in rows]
    finally:
        conn.close()


@app.post("/api/groups", response_model=GroupResponse)
async def create_group(payload: GroupInput, user: Dict[str, Any] = Depends(admin_user)):
    name = payload.name.strip()
    conn = get_db_conn()
    try:
        if _find_group_by_name(conn, name):
            raise HTTPException(status_code=409, detail="A group with that name already exists")
        group_id = _insert_group(conn, name, user["id"])
        conn.commit()
        return {"id": group_id, "name": name, "created_by": user["id"]}
    finally:
        conn.close()


@app.put("/api/groups/{group_id}", response_model=GroupResponse)
async def update_group(group_id: int, payload: GroupInput, user: Dict[str, Any] = Depends(admin_user)):
    name = payload.name.strip()
    conn = get_db_conn()
    try:
        existing = _find_group_by_name(conn, name)
        if existing and int(existing["id"]) != group_id:
            raise HTTPException(status_code=409, detail="A group with that name already exists")
        cur = _cursor(conn, dict_rows=True)
        cur.execute(
            "SELECT id, name, created_by FROM \"groups\" WHERE id = %s" if USE_POSTGRES else "SELECT id, name, created_by FROM \"groups\" WHERE id = ?",
            (group_id,),
        )
        row = _one(cur.fetchone())
        cur.close()
        if not row:
            raise HTTPException(status_code=404, detail="Group not found")
        cur = conn.cursor()
        cur.execute(
            "UPDATE \"groups\" SET name = %s WHERE id = %s" if USE_POSTGRES else "UPDATE \"groups\" SET name = ? WHERE id = ?",
            (name, group_id),
        )
        conn.commit()
        cur.close()
        row["name"] = name
        return _group_response(row)
    finally:
        conn.close()


@app.delete("/api/groups/{group_id}")
async def delete_group(group_id: int, user: Dict[str, Any] = Depends(admin_user)):
    conn = get_db_conn()
    try:
        cur = conn.cursor()
        cur.execute(
            "DELETE FROM user_groups WHERE group_id = %s" if USE_POSTGRES else "DELETE FROM user_groups WHERE group_id = ?",
            (group_id,),
        )
        cur.execute(
            "DELETE FROM connection_groups WHERE group_id = %s" if USE_POSTGRES else "DELETE FROM connection_groups WHERE group_id = ?",
            (group_id,),
        )
        cur.execute(
            "DELETE FROM \"groups\" WHERE id = %s" if USE_POSTGRES else "DELETE FROM \"groups\" WHERE id = ?",
            (group_id,),
        )
        deleted = cur.rowcount
        conn.commit()
        cur.close()
        if not deleted:
            raise HTTPException(status_code=404, detail="Group not found")
        return {"success": True}
    finally:
        conn.close()


@app.get("/api/groups/{group_id}/members")
async def list_group_members(group_id: int, user: Dict[str, Any] = Depends(admin_user)):
    conn = get_db_conn()
    try:
        cur = _cursor(conn, dict_rows=True)
        cur.execute(
            """SELECT u.id, u.username, u.role, u.is_active, u.created_at, u.totp_enabled
               FROM users u JOIN user_groups ug ON ug.user_id = u.id
               WHERE ug.group_id = %s ORDER BY u.username""" if USE_POSTGRES else
            """SELECT u.id, u.username, u.role, u.is_active, u.created_at, u.totp_enabled
               FROM users u JOIN user_groups ug ON ug.user_id = u.id
               WHERE ug.group_id = ? ORDER BY u.username""",
            (group_id,),
        )
        rows = _rows(cur)
        cur.close()
        return [_user_response(row, [group_id]) for row in rows]
    finally:
        conn.close()


@app.put("/api/groups/{group_id}/members")
async def replace_group_members(group_id: int, payload: MembershipInput, user: Dict[str, Any] = Depends(admin_user)):
    conn = get_db_conn()
    try:
        # Ensure group exists and all users exist before replacing any rows.
        cur = conn.cursor()
        cur.execute(
            "SELECT id FROM \"groups\" WHERE id = %s" if USE_POSTGRES else "SELECT id FROM \"groups\" WHERE id = ?",
            (group_id,),
        )
        if cur.fetchone() is None:
            cur.close()
            raise HTTPException(status_code=404, detail="Group not found")
        user_ids = list(dict.fromkeys(int(value) for value in payload.user_ids))
        if user_ids:
            cur.execute(f"SELECT id FROM users WHERE id IN ({_placeholders(len(user_ids))})", tuple(user_ids))
            if {int(row[0]) for row in cur.fetchall()} != set(user_ids):
                cur.close()
                raise HTTPException(status_code=400, detail="One or more user IDs do not exist")
        cur.execute(
            "DELETE FROM user_groups WHERE group_id = %s" if USE_POSTGRES else "DELETE FROM user_groups WHERE group_id = ?",
            (group_id,),
        )
        for user_id in user_ids:
            if USE_POSTGRES:
                cur.execute("INSERT INTO user_groups (user_id, group_id) VALUES (%s, %s) ON CONFLICT DO NOTHING", (user_id, group_id))
            else:
                cur.execute("INSERT OR IGNORE INTO user_groups (user_id, group_id) VALUES (?, ?)", (user_id, group_id))
        conn.commit()
        cur.close()
        return {"success": True, "group_id": group_id, "user_ids": user_ids}
    finally:
        conn.close()


@app.get("/api/users")
async def list_users(user: Dict[str, Any] = Depends(admin_user)):
    conn = get_db_conn()
    try:
        cur = _cursor(conn, dict_rows=True)
        cur.execute("SELECT id, username, role, is_active, created_at, totp_enabled FROM users ORDER BY username")
        rows = _rows(cur)
        cur.close()
        return [_user_response(row, _user_group_ids(conn, int(row["id"]))) for row in rows]
    finally:
        conn.close()


@app.post("/api/users")
async def create_user(payload: UserInput, user: Dict[str, Any] = Depends(admin_user)):
    if not payload.password:
        raise HTTPException(status_code=400, detail="A password is required when creating a user")
    username = payload.username.strip()
    conn = get_db_conn()
    try:
        cur = _cursor(conn, dict_rows=True)
        cur.execute(
            "SELECT id FROM users WHERE LOWER(username) = LOWER(%s)" if USE_POSTGRES else "SELECT id FROM users WHERE LOWER(username) = LOWER(?)",
            (username,),
        )
        if cur.fetchone():
            cur.close()
            raise HTTPException(status_code=409, detail="Username is already in use")
        group_ids = _validate_group_ids(conn, payload.group_ids)
        if USE_POSTGRES:
            cur.execute(
                "INSERT INTO users (username, password_hash, role, is_active) VALUES (%s, %s, %s, %s) RETURNING id, username, role, is_active, created_at",
                (username, hash_password(payload.password), payload.role, payload.is_active),
            )
            row = _one(cur.fetchone())
        else:
            cur.execute(
                "INSERT INTO users (username, password_hash, role, is_active) VALUES (?, ?, ?, ?)",
                (username, hash_password(payload.password), payload.role, 1 if payload.is_active else 0),
            )
            new_id = cur.lastrowid
            cur.execute("SELECT id, username, role, is_active, created_at, totp_enabled FROM users WHERE id = ?", (new_id,))
            row = _one(cur.fetchone())
        _replace_user_groups(conn, int(row["id"]), group_ids)
        conn.commit()
        cur.close()
        return _user_response(row, group_ids)
    finally:
        conn.close()


@app.put("/api/users/{user_id}")
async def update_user(user_id: int, payload: UserUpdate, user: Dict[str, Any] = Depends(admin_user)):
    conn = get_db_conn()
    try:
        cur = _cursor(conn, dict_rows=True)
        cur.execute(
            "SELECT id, username, role, is_active, created_at, totp_enabled FROM users WHERE id = %s" if USE_POSTGRES else "SELECT id, username, role, is_active, created_at, totp_enabled FROM users WHERE id = ?",
            (user_id,),
        )
        row = _one(cur.fetchone())
        cur.close()
        if not row:
            raise HTTPException(status_code=404, detail="User not found")
        if user_id == user["id"] and payload.is_active is False:
            raise HTTPException(status_code=400, detail="You cannot deactivate your own account")
        changes: List[str] = []
        params: List[Any] = []
        if payload.password is not None:
            changes.append("password_hash = %s" if USE_POSTGRES else "password_hash = ?")
            params.append(hash_password(payload.password))
        if payload.role is not None:
            changes.append("role = %s" if USE_POSTGRES else "role = ?")
            params.append(payload.role)
        if payload.is_active is not None:
            changes.append("is_active = %s" if USE_POSTGRES else "is_active = ?")
            params.append(payload.is_active if USE_POSTGRES else (1 if payload.is_active else 0))
        if changes:
            params.append(user_id)
            cur = conn.cursor()
            cur.execute(
                f"UPDATE users SET {', '.join(changes)} WHERE id = {'%s' if USE_POSTGRES else '?'}",
                tuple(params),
            )
            cur.close()
        if payload.group_ids is not None:
            _replace_user_groups(conn, user_id, payload.group_ids)
        conn.commit()
        cur = _cursor(conn, dict_rows=True)
        cur.execute(
            "SELECT id, username, role, is_active, created_at, totp_enabled FROM users WHERE id = %s" if USE_POSTGRES else "SELECT id, username, role, is_active, created_at, totp_enabled FROM users WHERE id = ?",
            (user_id,),
        )
        row = _one(cur.fetchone())
        cur.close()
        return _user_response(row, _user_group_ids(conn, user_id))
    finally:
        conn.close()


@app.delete("/api/users/{user_id}")
async def delete_user(user_id: int, user: Dict[str, Any] = Depends(admin_user)):
    if user_id == user["id"]:
        raise HTTPException(status_code=400, detail="You cannot delete your own account")
    conn = get_db_conn()
    try:
        cur = conn.cursor()
        # Revoke sessions and remove memberships before deleting the user.
        cur.execute("DELETE FROM user_groups WHERE user_id = %s" if USE_POSTGRES else "DELETE FROM user_groups WHERE user_id = ?", (user_id,))
        cur.execute("DELETE FROM sessions WHERE user_id = %s" if USE_POSTGRES else "DELETE FROM sessions WHERE user_id = ?", (user_id,))
        cur.execute("UPDATE connections SET owner_id = NULL WHERE owner_id = %s" if USE_POSTGRES else "UPDATE connections SET owner_id = NULL WHERE owner_id = ?", (user_id,))
        cur.execute("DELETE FROM users WHERE id = %s" if USE_POSTGRES else "DELETE FROM users WHERE id = ?", (user_id,))
        deleted = cur.rowcount
        conn.commit()
        cur.close()
        if not deleted:
            raise HTTPException(status_code=404, detail="User not found")
        return {"success": True}
    finally:
        conn.close()


# ---------------------------------------------------------------------------
# Connection authorization and management
# ---------------------------------------------------------------------------


def _authorized_connection_row(conn: Any, connection_id: str, user: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    cur = _cursor(conn, dict_rows=True)
    if user["role"] == "admin":
        cur.execute(_connection_select_sql() + (" WHERE c.id = %s" if USE_POSTGRES else " WHERE c.id = ?"), (connection_id,))
    else:
        cur.execute(
            _connection_select_sql() + (""" WHERE c.id = %s AND (
                    c.owner_id = %s OR EXISTS (
                        SELECT 1 FROM connection_groups cg JOIN user_groups ug ON ug.group_id = cg.group_id
                        WHERE cg.connection_id = c.id AND ug.user_id = %s
                    ))""" if USE_POSTGRES else """ WHERE c.id = ? AND (
                    c.owner_id = ? OR EXISTS (
                        SELECT 1 FROM connection_groups cg JOIN user_groups ug ON ug.group_id = cg.group_id
                        WHERE cg.connection_id = c.id AND ug.user_id = ?
                    ))"""),
            (connection_id, user["id"], user["id"]),
        )
    row = _one(cur.fetchone())
    cur.close()
    return row


def _save_connection_groups(conn: Any, connection_id: str, group_ids: Iterable[int]) -> None:
    ids = _validate_group_ids(conn, group_ids)
    cur = conn.cursor()
    cur.execute(
        "DELETE FROM connection_groups WHERE connection_id = %s" if USE_POSTGRES else "DELETE FROM connection_groups WHERE connection_id = ?",
        (connection_id,),
    )
    for group_id in ids:
        if USE_POSTGRES:
            cur.execute("INSERT INTO connection_groups (connection_id, group_id) VALUES (%s, %s) ON CONFLICT DO NOTHING", (connection_id, group_id))
        else:
            cur.execute("INSERT OR IGNORE INTO connection_groups (connection_id, group_id) VALUES (?, ?)", (connection_id, group_id))
    cur.close()


def _connection_params(row: Dict[str, Any]) -> Dict[str, Any]:
    # This DTO is used only inside the server immediately before opening the
    # saved connection.  It must never be returned to an API caller.  Keep
    # extra parameters intact for drivers: the public DTO redacts credential-
    # looking keys, but execution needs the server-side values.
    db_type = str(row["db_type"]).lower()
    database = row.get("database")
    if db_type == DatabaseType.SQLITE.value:
        try:
            database = _safe_local_path(database)
        except ValueError as exc:
            raise RuntimeError(str(exc)) from exc
    return {
        "db_type": db_type,
        "host": row.get("host"),
        "port": row.get("port"),
        "database": database,
        "username": row.get("username"),
        "password": _decrypt_password(row),
        "extra_params": _safe_extra_params(row.get("extra_params")),
    }


@app.get("/api/databases")
async def get_databases(user: Dict[str, Any] = Depends(current_user)):
    return get_supported_databases()


@app.get("/api/connections", response_model=List[ConnectionResponse])
async def get_connections(
    group_id: Optional[int] = Query(None),
    group: Optional[str] = Query(None),
    db_type: Optional[str] = Query(None),
    user: Dict[str, Any] = Depends(current_user),
):
    conn = get_db_conn()
    try:
        clauses: List[str] = []
        params: List[Any] = []
        if user["role"] != "admin":
            clauses.append("(c.owner_id = {p} OR EXISTS (SELECT 1 FROM connection_groups cg JOIN user_groups ug ON ug.group_id = cg.group_id WHERE cg.connection_id = c.id AND ug.user_id = {p}))".format(p="%s" if USE_POSTGRES else "?"))
            params.extend([user["id"], user["id"]])
        # A non-admin may filter only by a group they belong to.  Without this
        # predicate, probing an arbitrary group ID/name could reveal whether a
        # connection is shared with another tenant even when its DTO is hidden.
        if group_id is not None:
            if user["role"] == "admin":
                clauses.append(
                    "EXISTS (SELECT 1 FROM connection_groups filter_cg "
                    "WHERE filter_cg.connection_id = c.id AND filter_cg.group_id = {p})"
                    .format(p="%s" if USE_POSTGRES else "?")
                )
                params.append(group_id)
            else:
                clauses.append(
                    "EXISTS (SELECT 1 FROM connection_groups filter_cg "
                    "JOIN user_groups filter_ug ON filter_ug.group_id = filter_cg.group_id "
                    "WHERE filter_cg.connection_id = c.id AND filter_cg.group_id = {p} "
                    "AND filter_ug.user_id = {p})".format(p="%s" if USE_POSTGRES else "?")
                )
                params.extend([group_id, user["id"]])
        if group and group not in {"all", "ungrouped"}:
            if group.isdigit():
                if user["role"] == "admin":
                    clauses.append(
                        "EXISTS (SELECT 1 FROM connection_groups filter_cg "
                        "WHERE filter_cg.connection_id = c.id AND filter_cg.group_id = {p})"
                        .format(p="%s" if USE_POSTGRES else "?")
                    )
                    params.append(int(group))
                else:
                    clauses.append(
                        "EXISTS (SELECT 1 FROM connection_groups filter_cg "
                        "JOIN user_groups filter_ug ON filter_ug.group_id = filter_cg.group_id "
                        "WHERE filter_cg.connection_id = c.id AND filter_cg.group_id = {p} "
                        "AND filter_ug.user_id = {p})".format(p="%s" if USE_POSTGRES else "?")
                    )
                    params.extend([int(group), user["id"]])
            else:
                # Name filters are retained for backwards-compatible clients,
                # but resolve through the normalized group relation.
                group_param = "%s" if USE_POSTGRES else "?"
                group_clause = (
                    "EXISTS (SELECT 1 FROM connection_groups filter_cg "
                    "JOIN \"groups\" filter_g ON filter_g.id = filter_cg.group_id "
                )
                if user["role"] != "admin":
                    group_clause += (
                        "JOIN user_groups filter_ug ON filter_ug.group_id = filter_cg.group_id "
                    )
                group_clause += (
                    f"WHERE filter_cg.connection_id = c.id AND LOWER(filter_g.name) = LOWER({group_param})"
                )
                if user["role"] != "admin":
                    group_clause += f" AND filter_ug.user_id = {group_param}"
                    params.extend([group, user["id"]])
                else:
                    params.append(group)
                clauses.append(group_clause + ")")
        elif group == "ungrouped":
            clauses.append("NOT EXISTS (SELECT 1 FROM connection_groups ungrouped_cg WHERE ungrouped_cg.connection_id = c.id)")
        if db_type:
            clauses.append("c.db_type = {p}".format(p="%s" if USE_POSTGRES else "?"))
            params.append(db_type)
        sql = _connection_select_sql()
        if clauses:
            sql += " WHERE " + " AND ".join(clauses)
        sql += " ORDER BY c.name"
        cur = _cursor(conn, dict_rows=True)
        cur.execute(sql, tuple(params))
        rows = _rows(cur)
        cur.close()
        groups = _group_rows_for_connections(
            conn,
            [str(row["id"]) for row in rows],
            user,
        )
        return [
            _connection_response(row, groups.get(str(row["id"]), []), user)
            for row in rows
        ]
    finally:
        conn.close()


@app.post("/api/connections", response_model=ConnectionResponse)
async def create_connection(payload: ConnectionInput, user: Dict[str, Any] = Depends(admin_user)):
    _validate_connection_input(payload)
    connection_id = uuid.uuid4().hex[:12]
    encrypted = _encrypt_password(payload.password)
    if payload.password and _fernet() is None:
        raise HTTPException(status_code=500, detail="APP_ENCRYPTION_KEY must be configured before saving a connection password")
    conn = get_db_conn()
    try:
        group_ids = _validate_group_ids(conn, payload.group_ids)
        extra = _safe_extra_params(payload.extra_params)
        cur = conn.cursor()
        fields = "id, name, db_type, host, port, database, username, password, password_encrypted, extra_params, owner_id"
        values = (connection_id, payload.name.strip(), payload.db_type.strip().lower(), payload.host, payload.port, payload.database, payload.username, None, encrypted, _db_param(extra), user["id"])
        marks = _placeholders(len(values))
        cur.execute(f"INSERT INTO connections ({fields}) VALUES ({marks})", values)
        _save_connection_groups(conn, connection_id, group_ids)
        conn.commit()
        cur.close()
        row = _authorized_connection_row(conn, connection_id, user)
        return _connection_response(row or {}, _group_rows_for_connections(conn, [connection_id], user).get(connection_id, []), user)
    finally:
        conn.close()


@app.put("/api/connections/{connection_id}", response_model=ConnectionResponse)
async def update_connection(connection_id: str, payload: ConnectionInput, user: Dict[str, Any] = Depends(admin_user)):
    _validate_connection_input(payload)
    conn = get_db_conn()
    try:
        existing = _authorized_connection_row(conn, connection_id, user)
        if not existing:
            raise HTTPException(status_code=404, detail="Connection not found")
        fields = ["name", "db_type", "host", "port", "database", "username", "extra_params"]
        extra = _safe_extra_params(payload.extra_params)
        values: List[Any] = [payload.name.strip(), payload.db_type.strip().lower(), payload.host, payload.port, payload.database, payload.username, _db_param(extra)]
        if payload.clear_password:
            fields.extend(["password", "password_encrypted"])
            values.extend([None, None])
        elif payload.password:
            encrypted = _encrypt_password(payload.password)
            if encrypted is None:
                raise HTTPException(status_code=500, detail="APP_ENCRYPTION_KEY must be configured before saving a connection password")
            fields.extend(["password", "password_encrypted"])
            values.extend([None, encrypted])
        assignments = ", ".join(f'{field} = {"%s" if USE_POSTGRES else "?"}' for field in fields)
        values.append(connection_id)
        cur = conn.cursor()
        cur.execute(
            f"UPDATE connections SET {assignments} WHERE id = {'%s' if USE_POSTGRES else '?'}",
            tuple(values),
        )
        _save_connection_groups(conn, connection_id, payload.group_ids)
        conn.commit()
        cur.close()
        row = _authorized_connection_row(conn, connection_id, user)
        return _connection_response(row or {}, _group_rows_for_connections(conn, [connection_id], user).get(connection_id, []), user)
    finally:
        conn.close()


@app.delete("/api/connections/{connection_id}")
async def delete_connection(connection_id: str, user: Dict[str, Any] = Depends(admin_user)):
    conn = get_db_conn()
    try:
        cur = conn.cursor()
        cur.execute("DELETE FROM connection_groups WHERE connection_id = %s" if USE_POSTGRES else "DELETE FROM connection_groups WHERE connection_id = ?", (connection_id,))
        cur.execute("DELETE FROM connections WHERE id = %s" if USE_POSTGRES else "DELETE FROM connections WHERE id = ?", (connection_id,))
        deleted = cur.rowcount
        conn.commit()
        cur.close()
        if not deleted:
            raise HTTPException(status_code=404, detail="Connection not found")
        return {"success": True}
    finally:
        conn.close()


@app.get("/api/connections/{connection_id}", response_model=ConnectionResponse)
async def get_connection(connection_id: str, user: Dict[str, Any] = Depends(current_user)):
    conn = get_db_conn()
    try:
        row = _authorized_connection_row(conn, connection_id, user)
        if not row:
            raise HTTPException(status_code=404, detail="Connection not found")
        return _connection_response(row, _group_rows_for_connections(conn, [connection_id], user).get(connection_id, []), user)
    finally:
        conn.close()


@app.post("/api/connections/test")
async def test_unsaved_connection(
    payload: ConnectionTestInput,
    user: Dict[str, Any] = Depends(admin_user),
):
    """Test the current form without creating or changing a saved row."""
    connection_input = ConnectionInput(
        name="unsaved-test",
        db_type=payload.db_type,
        host=payload.host,
        port=payload.port,
        database=payload.database,
        username=payload.username,
        password=payload.password,
        extra_params=payload.extra_params,
    )
    _validate_connection_input(connection_input)
    return test_connection(
        db_type=connection_input.db_type.strip().lower(),
        host=connection_input.host,
        port=connection_input.port,
        database=connection_input.database,
        username=connection_input.username,
        password=connection_input.password,
        extra_params=_safe_extra_params(connection_input.extra_params),
    )


@app.post("/api/connections/{connection_id}/test")
async def test_saved_connection(connection_id: str, user: Dict[str, Any] = Depends(current_user)):
    conn = get_db_conn()
    try:
        row = _authorized_connection_row(conn, connection_id, user)
        if not row:
            raise HTTPException(status_code=404, detail="Connection not found")
        try:
            params = _connection_params(row)
        except RuntimeError as exc:
            raise HTTPException(status_code=409, detail="Saved connection credentials need to be updated") from exc
    finally:
        conn.close()
    return test_connection(**params)


# ---------------------------------------------------------------------------
# Query execution and user-scoped history
# ---------------------------------------------------------------------------


def _save_query_history(
    user_id: int,
    connection_id: Optional[str],
    query: str,
    success: bool,
    row_count: Optional[int],
    execution_time_ms: Optional[int],
    error_message: Optional[str],
) -> None:
    conn = None
    try:
        conn = get_db_conn()
        cur = conn.cursor()
        values = (user_id, connection_id, query, success if USE_POSTGRES else (1 if success else 0), row_count, execution_time_ms, error_message)
        cur.execute(
            "INSERT INTO query_history (user_id, connection_id, query, success, row_count, execution_time_ms, error_message) VALUES (%s, %s, %s, %s, %s, %s, %s)" if USE_POSTGRES else
            "INSERT INTO query_history (user_id, connection_id, query, success, row_count, execution_time_ms, error_message) VALUES (?, ?, ?, ?, ?, ?, ?)",
            values,
        )
        conn.commit()
        cur.close()
    except Exception:
        # History is best-effort and must never leak a driver error (which can
        # contain a connection string or credential) into application logs.
        print("Error saving query history.")
    finally:
        if conn is not None:
            conn.close()


@app.get("/api/connections/{connection_id}/schema")
async def get_connection_schema(connection_id: str, user: Dict[str, Any] = Depends(current_user)):
    conn = get_db_conn()
    try:
        row = _authorized_connection_row(conn, connection_id, user)
        if not row:
            raise HTTPException(status_code=404, detail="Connection not found or not authorized")
        params = _connection_params(row)
        params["db_type"] = row.get("db_type")
    except RuntimeError as exc:
        raise HTTPException(status_code=409, detail="Saved connection credentials need to be updated") from exc
    finally:
        conn.close()
    result = get_schema_metadata(**params)
    if not result.get("success"):
        raise HTTPException(status_code=400, detail=result.get("error", "Could not retrieve schema"))
    return result


@app.post("/api/query/edits")
async def update_query_results(payload: QueryEditRequest, user: Dict[str, Any] = Depends(current_user)):
    conn = get_db_conn()
    try:
        row = _authorized_connection_row(conn, payload.connection_id, user)
        if not row:
            raise HTTPException(status_code=404, detail="Connection not found or not authorized")
        if user.get("role") not in {"admin", "writer"}:
            raise HTTPException(status_code=403, detail="Write permission is required to apply result edits")
        try:
            params = _connection_params(row)
            params["db_type"] = row.get("db_type")
        except RuntimeError as exc:
            raise HTTPException(status_code=409, detail="Saved connection credentials need to be updated") from exc
    finally:
        conn.close()
    result = apply_query_edits(payload.query, payload.edits, **params)
    _save_query_history(user["id"], payload.connection_id, payload.query, bool(result.get("success")), result.get("updated", 0), 0, result.get("error"))
    return result


@app.post("/api/query/check")
async def check_query(payload: QueryValidationRequest, user: Dict[str, Any] = Depends(current_user)):
    conn = get_db_conn()
    try:
        row = _authorized_connection_row(conn, payload.connection_id, user)
        if not row:
            raise HTTPException(status_code=404, detail="Connection not found or not authorized")
        try:
            params = _connection_params(row)
        except RuntimeError as exc:
            raise HTTPException(status_code=409, detail="Saved connection credentials need to be updated") from exc
    finally:
        conn.close()

    # Check parameter validity if provided
    if payload.parameters:
        from app.db_service import validate_query_parameters
        param_valid, param_error = validate_query_parameters(payload.query, payload.parameters, params["db_type"])
        if not param_valid:
            return {"valid": False, "error": param_error}

    ok, error, _, _ = validate_query(payload.query, user.get("role", "viewer"), params["db_type"], params)
    return {"valid": ok, "error": error}


@app.post("/api/query/parameters")
async def get_query_parameters(payload: QueryValidationRequest, user: Dict[str, Any] = Depends(current_user)):
    """Parse and return detected bind parameters from a query."""
    from app.db_service import parse_query_parameters
    conn = get_db_conn()
    try:
        row = _authorized_connection_row(conn, payload.connection_id, user)
        if not row:
            raise HTTPException(status_code=404, detail="Connection not found or not authorized")
        try:
            params = _connection_params(row)
        except RuntimeError as exc:
            raise HTTPException(status_code=409, detail="Saved connection credentials need to be updated") from exc
    finally:
        conn.close()

    detected = parse_query_parameters(payload.query)
    return {"parameters": detected}


@app.post("/api/query")
async def execute_query_endpoint(payload: QueryRequest, user: Dict[str, Any] = Depends(current_user)):
    start_time = time.time()
    conn = get_db_conn()
    try:
        row = _authorized_connection_row(conn, payload.connection_id, user)
        if not row:
            raise HTTPException(status_code=404, detail="Connection not found or not authorized")
        try:
            params = _connection_params(row)
        except RuntimeError as exc:
            raise HTTPException(status_code=409, detail="Saved connection credentials need to be updated") from exc
    finally:
        conn.close()

    try:
        result = execute_query(
            query=payload.query,
            limit=payload.limit or 1000,
            role=user["role"],
            parameters=payload.parameters,
            execution_id=payload.execution_id,
            **params,
        )
        elapsed = int((time.time() - start_time) * 1000)
        _save_query_history(
            user_id=user["id"],
            connection_id=payload.connection_id,
            query=payload.query,
            success=bool(result.get("success")),
            row_count=result.get("count", 0),
            execution_time_ms=elapsed,
            error_message=result.get("error"),
        )
        return result
    except HTTPException:
        raise
    except Exception as exc:
        elapsed = int((time.time() - start_time) * 1000)
        _save_query_history(user["id"], payload.connection_id, payload.query, False, 0, elapsed, str(exc))
        raise HTTPException(status_code=500, detail="Query execution failed") from exc


@app.post("/api/query/cancel")
async def cancel_query_endpoint(payload: QueryCancelRequest, user: Dict[str, Any] = Depends(current_user)):
    return cancel_query(payload.execution_id)


@app.get("/api/history", response_model=List[QueryHistoryItem])
async def get_query_history(limit: int = Query(50, ge=1, le=200), user: Dict[str, Any] = Depends(current_user)):
    conn = get_db_conn()
    try:
        cur = _cursor(conn, dict_rows=True)
        # History is private to the authenticated user, including for admins.
        # Administrators may clear all rows via DELETE, but a global read would
        # expose other users' SQL (which can contain sensitive literals).
        cur.execute(
            "SELECT id, connection_id, query, executed_at, success, row_count, execution_time_ms, error_message FROM query_history WHERE user_id = %s ORDER BY executed_at DESC LIMIT %s" if USE_POSTGRES else
            "SELECT id, connection_id, query, executed_at, success, row_count, execution_time_ms, error_message FROM query_history WHERE user_id = ? ORDER BY executed_at DESC LIMIT ?",
            (user["id"], limit),
        )
        rows = _rows(cur)
        cur.close()
        return [
            QueryHistoryItem(
                id=int(row["id"]),
                connection_id=row.get("connection_id"),
                query=row["query"],
                executed_at=_iso_datetime(row.get("executed_at")),
                success=bool(row.get("success")),
                row_count=row.get("row_count"),
                execution_time_ms=row.get("execution_time_ms"),
                error_message=row.get("error_message"),
            )
            for row in rows
        ]
    finally:
        conn.close()


@app.post("/api/update")
async def update_application(user: Dict[str, Any] = Depends(admin_user)):
    """Trigger application self-update from GitHub (admin only)."""
    import subprocess
    import sys
    import os

    try:
        # Get the repository root
        repo_root = BASE_DIR

        # Step 1: Fetch latest changes
        result = subprocess.run(
            ["git", "fetch", "origin"],
            cwd=repo_root,
            capture_output=True,
            text=True,
            timeout=30,
        )
        if result.returncode != 0:
            return {"success": False, "error": f"Git fetch failed: {result.stderr}"}

        # Step 2: Check if there are updates
        result = subprocess.run(
            ["git", "rev-parse", "HEAD"],
            cwd=repo_root,
            capture_output=True,
            text=True,
            timeout=10,
        )
        local_sha = result.stdout.strip()

        result = subprocess.run(
            ["git", "rev-parse", "origin/main"],
            cwd=repo_root,
            capture_output=True,
            text=True,
            timeout=10,
        )
        remote_sha = result.stdout.strip()

        if local_sha == remote_sha:
            return {"success": True, "message": "Already up to date", "updated": False}

        # Step 3: Switch/reset to latest origin/main
        # Stash any local uncommitted changes including untracked files
        subprocess.run(
            ["git", "stash", "--include-untracked"],
            cwd=repo_root,
            capture_output=True,
            text=True,
            timeout=15,
        )
        # Ensure pull reconciliation config is present
        subprocess.run(
            ["git", "config", "pull.rebase", "false"],
            cwd=repo_root,
            capture_output=True,
            text=True,
            timeout=5,
        )
        # Switch to and align branch 'main' directly with origin/main
        result = subprocess.run(
            ["git", "checkout", "-B", "main", "origin/main"],
            cwd=repo_root,
            capture_output=True,
            text=True,
            timeout=30,
        )
        if result.returncode != 0:
            # Fallback: checkout main and reset hard to origin/main
            subprocess.run(["git", "checkout", "main"], cwd=repo_root, capture_output=True, text=True, timeout=15)
            result = subprocess.run(
                ["git", "reset", "--hard", "origin/main"],
                cwd=repo_root,
                capture_output=True,
                text=True,
                timeout=30,
            )
            if result.returncode != 0:
                return {"success": False, "error": f"Git update failed: {result.stderr}"}

        # Step 4: Install/update dependencies
        python_bin = sys.executable
        venv_python = os.path.join(repo_root, ".venv", "bin", "python")
        if os.path.exists(venv_python):
            python_bin = venv_python

        result = subprocess.run(
            [python_bin, "-m", "pip", "install", "-r", "requirements.txt"],
            cwd=repo_root,
            capture_output=True,
            text=True,
            timeout=120,
        )
        if result.returncode != 0:
            return {"success": False, "error": f"Dependency install failed: {result.stderr}"}

        # Step 5: Run database migrations
        result = subprocess.run(
            [python_bin, "-c", "from app.main import init_db; init_db()"],
            cwd=repo_root,
            capture_output=True,
            text=True,
            timeout=30,
        )
        if result.returncode != 0:
            return {"success": False, "error": f"Database migration failed: {result.stderr}"}

        # Step 6: Verify version
        result = subprocess.run(
            [python_bin, "-c", "import json; print(json.load(open('app/releases.json'))['version'])"],
            cwd=repo_root,
            capture_output=True,
            text=True,
            timeout=10,
        )
        new_version = result.stdout.strip()

        # Schedule process exit after response is sent so Docker restarts the container
        import threading
        import time
        def delayed_exit():
            time.sleep(2)  # Allow response to be sent
            os._exit(0)    # Exit cleanly; Docker restart policy will restart container
        threading.Thread(target=delayed_exit, daemon=True).start()

        return {
            "success": True,
            "message": f"Updated to version {new_version}. Restarting application...",
            "updated": True,
            "new_version": new_version,
            "restart_required": True,
        }

    except subprocess.TimeoutExpired:
        return {"success": False, "error": "Update timed out"}
    except Exception as exc:
        return {"success": False, "error": f"Update failed: {str(exc)}"}


@app.delete("/api/history")
async def clear_query_history(user: Dict[str, Any] = Depends(current_user)):
    conn = get_db_conn()
    try:
        cur = conn.cursor()
        if user["role"] == "admin":
            cur.execute("DELETE FROM query_history")
        else:
            cur.execute("DELETE FROM query_history WHERE user_id = %s" if USE_POSTGRES else "DELETE FROM query_history WHERE user_id = ?", (user["id"],))
        conn.commit()
        deleted = cur.rowcount
        cur.close()
        return {"success": True, "deleted": deleted}
    finally:
        conn.close()


# Snippets API endpoints
class SnippetInput(BaseModel):
    name: str = Field(..., min_length=1, max_length=200)
    category: Optional[str] = Field(None, max_length=100)
    description: Optional[str] = Field(None, max_length=500)
    sql: str = Field(..., min_length=1)
    is_favorite: bool = False
    is_shared: bool = False


class SnippetResponse(BaseModel):
    id: str
    name: str
    category: Optional[str]
    description: Optional[str]
    sql: str
    is_favorite: bool
    is_shared: bool
    user_id: int
    created_at: str
    updated_at: str


def _snippet_response(row: Dict[str, Any]) -> Dict[str, Any]:
    return {
        "id": str(row["id"]),
        "name": row["name"],
        "category": row["category"],
        "description": row["description"],
        "sql": row["sql"],
        "is_favorite": bool(row.get("is_favorite", 0)),
        "is_shared": bool(row.get("is_shared", 0)),
        "user_id": row["user_id"],
        "created_at": row["created_at"],
        "updated_at": row["updated_at"],
    }


@app.get("/api/snippets", response_model=List[SnippetResponse])
async def list_snippets(user: Dict[str, Any] = Depends(current_user)):
    conn = get_db_conn()
    try:
        cur = _cursor(conn, dict_rows=True)
        if user["role"] == "admin":
            cur.execute("SELECT * FROM snippets ORDER BY name")
        else:
            cur.execute(
                """SELECT DISTINCT s.* FROM snippets s
                   WHERE s.user_id = %s OR s.is_shared = TRUE
                   ORDER BY s.name""" if USE_POSTGRES else
                """SELECT DISTINCT s.* FROM snippets s
                   WHERE s.user_id = ? OR s.is_shared = 1
                   ORDER BY s.name""",
                (user["id"],),
            )
        rows = _rows(cur)
        cur.close()
        return [_snippet_response(row) for row in rows]
    finally:
        conn.close()


@app.post("/api/snippets", response_model=SnippetResponse)
async def create_snippet(payload: SnippetInput, user: Dict[str, Any] = Depends(current_user)):
    conn = get_db_conn()
    try:
        snippet_id = str(uuid.uuid4())
        cur = conn.cursor()
        cur.execute(
            """INSERT INTO snippets (id, name, category, description, sql, is_favorite, is_shared, user_id, created_at, updated_at)
               VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s)""" if USE_POSTGRES else
            """INSERT INTO snippets (id, name, category, description, sql, is_favorite, is_shared, user_id, created_at, updated_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            (snippet_id, payload.name, payload.category, payload.description, payload.sql,
             payload.is_favorite, payload.is_shared, user["id"],
             datetime.now(timezone.utc).isoformat(), datetime.now(timezone.utc).isoformat()),
        )
        conn.commit()
        cur.close()
        cur = _cursor(conn, dict_rows=True)
        cur.execute("SELECT * FROM snippets WHERE id = %s" if USE_POSTGRES else "SELECT * FROM snippets WHERE id = ?", (snippet_id,))
        row = _one(cur.fetchone())
        cur.close()
        return _snippet_response(row)
    finally:
        conn.close()


@app.put("/api/snippets/{snippet_id}", response_model=SnippetResponse)
async def update_snippet(snippet_id: str, payload: SnippetInput, user: Dict[str, Any] = Depends(current_user)):
    conn = get_db_conn()
    try:
        cur = _cursor(conn, dict_rows=True)
        cur.execute("SELECT * FROM snippets WHERE id = %s" if USE_POSTGRES else "SELECT * FROM snippets WHERE id = ?", (snippet_id,))
        row = _one(cur.fetchone())
        cur.close()
        if not row:
            raise HTTPException(status_code=404, detail="Snippet not found")
        # Check ownership or admin
        if row["user_id"] != user["id"] and user["role"] != "admin":
            raise HTTPException(status_code=403, detail="Not authorized to edit this snippet")

        cur = conn.cursor()
        cur.execute(
            """UPDATE snippets SET name = %s, category = %s, description = %s, sql = %s, is_favorite = %s, is_shared = %s, updated_at = %s
               WHERE id = %s""" if USE_POSTGRES else
            """UPDATE snippets SET name = ?, category = ?, description = ?, sql = ?, is_favorite = ?, is_shared = ?, updated_at = ?
               WHERE id = ?""",
            (payload.name, payload.category, payload.description, payload.sql,
             payload.is_favorite, payload.is_shared, datetime.now(timezone.utc).isoformat(), snippet_id),
        )
        conn.commit()
        cur.close()
        cur = _cursor(conn, dict_rows=True)
        cur.execute("SELECT * FROM snippets WHERE id = %s" if USE_POSTGRES else "SELECT * FROM snippets WHERE id = ?", (snippet_id,))
        row = _one(cur.fetchone())
        cur.close()
        return _snippet_response(row)
    finally:
        conn.close()


@app.delete("/api/snippets/{snippet_id}")
async def delete_snippet(snippet_id: str, user: Dict[str, Any] = Depends(current_user)):
    conn = get_db_conn()
    try:
        cur = _cursor(conn, dict_rows=True)
        cur.execute("SELECT * FROM snippets WHERE id = %s" if USE_POSTGRES else "SELECT * FROM snippets WHERE id = ?", (snippet_id,))
        row = _one(cur.fetchone())
        cur.close()
        if not row:
            raise HTTPException(status_code=404, detail="Snippet not found")
        if row["user_id"] != user["id"] and user["role"] != "admin":
            raise HTTPException(status_code=403, detail="Not authorized to delete this snippet")

        cur = conn.cursor()
        cur.execute("DELETE FROM snippets WHERE id = %s" if USE_POSTGRES else "DELETE FROM snippets WHERE id = ?", (snippet_id,))
        conn.commit()
        cur.close()
        return {"success": True}
    finally:
        conn.close()


# ==============================================================================
# v1.3.0 Enhancements: Saved Queries, Workspace, Scheduled Queries, DDL, Schema Diff
# ==============================================================================

class SavedQueryInput(BaseModel):
    name: str = Field(..., min_length=1, max_length=200)
    sql: str = Field(..., min_length=1)
    category: Optional[str] = Field("General", max_length=100)
    description: Optional[str] = Field(None, max_length=500)
    connection_id: Optional[str] = Field(None, max_length=50)
    tags: Optional[str] = Field(None, max_length=250)


class SavedQueryResponse(BaseModel):
    id: str
    name: str
    sql: str
    category: Optional[str]
    description: Optional[str]
    connection_id: Optional[str]
    tags: Optional[str]
    user_id: int
    created_at: str
    updated_at: str


def _saved_query_response(row: Dict[str, Any]) -> Dict[str, Any]:
    return {
        "id": row["id"],
        "name": row["name"],
        "sql": row["sql"],
        "category": row.get("category") or "General",
        "description": row.get("description"),
        "connection_id": row.get("connection_id"),
        "tags": row.get("tags"),
        "user_id": row["user_id"],
        "created_at": _iso_datetime(row.get("created_at")),
        "updated_at": _iso_datetime(row.get("updated_at")),
    }


@app.get("/api/saved-queries", response_model=List[SavedQueryResponse])
async def list_saved_queries(user: Dict[str, Any] = Depends(current_user)):
    conn = get_db_conn()
    try:
        cur = _cursor(conn, dict_rows=True)
        if user["role"] == "admin":
            cur.execute("SELECT * FROM saved_queries ORDER BY category, name")
        else:
            cur.execute(
                "SELECT * FROM saved_queries WHERE user_id = %s ORDER BY category, name" if USE_POSTGRES else
                "SELECT * FROM saved_queries WHERE user_id = ? ORDER BY category, name",
                (user["id"],)
            )
        rows = _rows(cur)
        cur.close()
        return [_saved_query_response(row) for row in rows]
    finally:
        conn.close()


@app.post("/api/saved-queries", response_model=SavedQueryResponse)
async def create_saved_query(payload: SavedQueryInput, user: Dict[str, Any] = Depends(current_user)):
    conn = get_db_conn()
    try:
        query_id = str(uuid.uuid4())
        cur = conn.cursor()
        cur.execute(
            """INSERT INTO saved_queries (id, name, category, description, sql, connection_id, tags, user_id)
               VALUES (%s, %s, %s, %s, %s, %s, %s, %s)""" if USE_POSTGRES else
            """INSERT INTO saved_queries (id, name, category, description, sql, connection_id, tags, user_id)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?)""",
            (query_id, payload.name, payload.category or "General", payload.description, payload.sql, payload.connection_id, payload.tags, user["id"])
        )
        conn.commit()
        cur.close()

        cur = _cursor(conn, dict_rows=True)
        cur.execute("SELECT * FROM saved_queries WHERE id = %s" if USE_POSTGRES else "SELECT * FROM saved_queries WHERE id = ?", (query_id,))
        row = _one(cur.fetchone())
        cur.close()
        return _saved_query_response(row)
    finally:
        conn.close()


@app.put("/api/saved-queries/{query_id}", response_model=SavedQueryResponse)
async def update_saved_query(query_id: str, payload: SavedQueryInput, user: Dict[str, Any] = Depends(current_user)):
    conn = get_db_conn()
    try:
        cur = _cursor(conn, dict_rows=True)
        cur.execute("SELECT * FROM saved_queries WHERE id = %s" if USE_POSTGRES else "SELECT * FROM saved_queries WHERE id = ?", (query_id,))
        row = _one(cur.fetchone())
        cur.close()
        if not row:
            raise HTTPException(status_code=404, detail="Saved query not found")
        if row["user_id"] != user["id"] and user["role"] != "admin":
            raise HTTPException(status_code=403, detail="Not authorized to edit this saved query")

        cur = conn.cursor()
        cur.execute(
            """UPDATE saved_queries
               SET name = %s, category = %s, description = %s, sql = %s, connection_id = %s, tags = %s, updated_at = CURRENT_TIMESTAMP
               WHERE id = %s""" if USE_POSTGRES else
            """UPDATE saved_queries
               SET name = ?, category = ?, description = ?, sql = ?, connection_id = ?, tags = ?, updated_at = CURRENT_TIMESTAMP
               WHERE id = ?""",
            (payload.name, payload.category or "General", payload.description, payload.sql, payload.connection_id, payload.tags, query_id)
        )
        conn.commit()
        cur.close()

        cur = _cursor(conn, dict_rows=True)
        cur.execute("SELECT * FROM saved_queries WHERE id = %s" if USE_POSTGRES else "SELECT * FROM saved_queries WHERE id = ?", (query_id,))
        row = _one(cur.fetchone())
        cur.close()
        return _saved_query_response(row)
    finally:
        conn.close()


@app.delete("/api/saved-queries/{query_id}")
async def delete_saved_query(query_id: str, user: Dict[str, Any] = Depends(current_user)):
    conn = get_db_conn()
    try:
        cur = _cursor(conn, dict_rows=True)
        cur.execute("SELECT * FROM saved_queries WHERE id = %s" if USE_POSTGRES else "SELECT * FROM saved_queries WHERE id = ?", (query_id,))
        row = _one(cur.fetchone())
        cur.close()
        if not row:
            raise HTTPException(status_code=404, detail="Saved query not found")
        if row["user_id"] != user["id"] and user["role"] != "admin":
            raise HTTPException(status_code=403, detail="Not authorized to delete this saved query")

        cur = conn.cursor()
        cur.execute("DELETE FROM saved_queries WHERE id = %s" if USE_POSTGRES else "DELETE FROM saved_queries WHERE id = ?", (query_id,))
        conn.commit()
        cur.close()
        return {"success": True}
    finally:
        conn.close()


class WorkspaceStateInput(BaseModel):
    state_json: str


@app.get("/api/workspace")
async def get_workspace_state(user: Dict[str, Any] = Depends(current_user)):
    conn = get_db_conn()
    try:
        cur = _cursor(conn, dict_rows=True)
        cur.execute(
            "SELECT state_json, updated_at FROM workspace_state WHERE user_id = %s" if USE_POSTGRES else
            "SELECT state_json, updated_at FROM workspace_state WHERE user_id = ?",
            (user["id"],)
        )
        row = _one(cur.fetchone())
        cur.close()
        if not row:
            return {"state_json": "{}", "updated_at": None}
        return {"state_json": row["state_json"], "updated_at": _iso_datetime(row.get("updated_at"))}
    finally:
        conn.close()


@app.put("/api/workspace")
async def save_workspace_state(payload: WorkspaceStateInput, user: Dict[str, Any] = Depends(current_user)):
    conn = get_db_conn()
    try:
        cur = conn.cursor()
        if USE_POSTGRES:
            cur.execute(
                """INSERT INTO workspace_state (user_id, state_json, updated_at)
                   VALUES (%s, %s, CURRENT_TIMESTAMP)
                   ON CONFLICT (user_id) DO UPDATE SET state_json = EXCLUDED.state_json, updated_at = CURRENT_TIMESTAMP""",
                (user["id"], payload.state_json)
            )
        else:
            cur.execute(
                """INSERT INTO workspace_state (user_id, state_json, updated_at)
                   VALUES (?, ?, CURRENT_TIMESTAMP)
                   ON CONFLICT (user_id) DO UPDATE SET state_json = excluded.state_json, updated_at = CURRENT_TIMESTAMP""",
                (user["id"], payload.state_json)
            )
        conn.commit()
        cur.close()
        return {"success": True}
    finally:
        conn.close()


class ScheduledQueryInput(BaseModel):
    title: str = Field(..., min_length=1, max_length=200)
    query: str = Field(..., min_length=1)
    connection_id: str = Field(..., min_length=1, max_length=50)
    cron_interval: str = Field("daily", max_length=50)
    webhook_url: Optional[str] = Field(None, max_length=500)
    alert_condition: Optional[str] = Field("always", max_length=100)
    is_active: bool = True


@app.get("/api/scheduled-queries")
async def list_scheduled_queries(user: Dict[str, Any] = Depends(current_user)):
    conn = get_db_conn()
    try:
        cur = _cursor(conn, dict_rows=True)
        if user["role"] == "admin":
            cur.execute("SELECT * FROM scheduled_queries ORDER BY created_at DESC")
        else:
            cur.execute(
                "SELECT * FROM scheduled_queries WHERE user_id = %s ORDER BY created_at DESC" if USE_POSTGRES else
                "SELECT * FROM scheduled_queries WHERE user_id = ? ORDER BY created_at DESC",
                (user["id"],)
            )
        rows = _rows(cur)
        cur.close()
        return [
            {
                "id": r["id"],
                "title": r["title"],
                "query": r["query"],
                "connection_id": r["connection_id"],
                "cron_interval": r.get("cron_interval") or "daily",
                "webhook_url": r.get("webhook_url"),
                "alert_condition": r.get("alert_condition") or "always",
                "is_active": bool(r.get("is_active")),
                "last_run_at": _iso_datetime(r.get("last_run_at")),
                "last_status": r.get("last_status"),
                "created_at": _iso_datetime(r.get("created_at")),
                "updated_at": _iso_datetime(r.get("updated_at")),
            }
            for r in rows
        ]
    finally:
        conn.close()


@app.post("/api/scheduled-queries")
async def create_scheduled_query(payload: ScheduledQueryInput, user: Dict[str, Any] = Depends(current_user)):
    conn = get_db_conn()
    try:
        sched_id = str(uuid.uuid4())
        cur = conn.cursor()
        cur.execute(
            """INSERT INTO scheduled_queries (id, title, query, connection_id, cron_interval, webhook_url, alert_condition, is_active, user_id)
               VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s)""" if USE_POSTGRES else
            """INSERT INTO scheduled_queries (id, title, query, connection_id, cron_interval, webhook_url, alert_condition, is_active, user_id)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            (sched_id, payload.title, payload.query, payload.connection_id, payload.cron_interval, payload.webhook_url, payload.alert_condition, payload.is_active, user["id"])
        )
        conn.commit()
        cur.close()
        return {"id": sched_id, "success": True}
    finally:
        conn.close()


@app.delete("/api/scheduled-queries/{query_id}")
async def delete_scheduled_query(query_id: str, user: Dict[str, Any] = Depends(current_user)):
    conn = get_db_conn()
    try:
        cur = _cursor(conn, dict_rows=True)
        cur.execute("SELECT * FROM scheduled_queries WHERE id = %s" if USE_POSTGRES else "SELECT * FROM scheduled_queries WHERE id = ?", (query_id,))
        row = _one(cur.fetchone())
        cur.close()
        if not row:
            raise HTTPException(status_code=404, detail="Scheduled query not found")
        if row["user_id"] != user["id"] and user["role"] != "admin":
            raise HTTPException(status_code=403, detail="Not authorized to delete this scheduled query")

        cur = conn.cursor()
        cur.execute("DELETE FROM scheduled_queries WHERE id = %s" if USE_POSTGRES else "DELETE FROM scheduled_queries WHERE id = ?", (query_id,))
        conn.commit()
        cur.close()
        return {"success": True}
    finally:
        conn.close()


@app.post("/api/scheduled-queries/{query_id}/run")
async def run_scheduled_query_now(query_id: str, user: Dict[str, Any] = Depends(current_user)):
    """Manually trigger or test run a scheduled query and its webhook."""
    conn = get_db_conn()
    try:
        cur = _cursor(conn, dict_rows=True)
        cur.execute("SELECT * FROM scheduled_queries WHERE id = %s" if USE_POSTGRES else "SELECT * FROM scheduled_queries WHERE id = ?", (query_id,))
        sched = _one(cur.fetchone())
        cur.close()
        if not sched:
            raise HTTPException(status_code=404, detail="Scheduled query not found")
        
        row = _authorized_connection_row(conn, sched["connection_id"], user)
        if not row:
            raise HTTPException(status_code=404, detail="Connection not found or unauthorized")
        conn_params = _connection_params(row)
        conn_params["db_type"] = row.get("db_type")
    finally:
        conn.close()

    result = execute_query(query=sched["query"], limit=100, **conn_params)
    status_str = "Success" if result.get("success") else f"Failed: {result.get('error', 'Unknown error')}"

    webhook_sent = False
    webhook_error = None
    if sched.get("webhook_url"):
        should_send = True
        condition = sched.get("alert_condition") or "always"
        if condition == "row_count > 0" and result.get("count", 0) <= 0:
            should_send = False
        elif condition == "error" and result.get("success"):
            should_send = False

        if should_send:
            try:
                import urllib.request
                payload = json.dumps({
                    "title": sched["title"],
                    "query": sched["query"],
                    "connection": row.get("name"),
                    "row_count": result.get("count", 0),
                    "success": result.get("success", False),
                    "execution_time_ms": result.get("execution_time_ms", 0),
                    "executed_at": datetime.now(timezone.utc).isoformat(),
                }).encode("utf-8")
                req = urllib.request.Request(
                    sched["webhook_url"],
                    data=payload,
                    headers={"Content-Type": "application/json", "User-Agent": "Query-Execute-Alert/1.3"}
                )
                with urllib.request.urlopen(req, timeout=10) as resp:
                    webhook_sent = resp.status < 300
            except Exception as e:
                webhook_error = str(e)

    conn = get_db_conn()
    try:
        cur = conn.cursor()
        cur.execute(
            """UPDATE scheduled_queries SET last_run_at = CURRENT_TIMESTAMP, last_status = %s, updated_at = CURRENT_TIMESTAMP WHERE id = %s""" if USE_POSTGRES else
            """UPDATE scheduled_queries SET last_run_at = CURRENT_TIMESTAMP, last_status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?""",
            (status_str[:50], query_id)
        )
        conn.commit()
        cur.close()
    finally:
        conn.close()

    return {
        "success": result.get("success", False),
        "count": result.get("count", 0),
        "status": status_str,
        "webhook_sent": webhook_sent,
        "webhook_error": webhook_error,
    }


@app.get("/api/connections/{connection_id}/tables/{table_name}/ddl")
async def get_table_ddl_endpoint(connection_id: str, table_name: str, user: Dict[str, Any] = Depends(current_user)):
    conn = get_db_conn()
    try:
        row = _authorized_connection_row(conn, connection_id, user)
        if not row:
            raise HTTPException(status_code=404, detail="Connection not found or not authorized")
        params = _connection_params(row)
        params["db_type"] = row.get("db_type")
    except RuntimeError as exc:
        raise HTTPException(status_code=409, detail="Saved connection credentials need to be updated") from exc
    finally:
        conn.close()

    result = generate_table_ddl(table_name, **params)
    if not result.get("success"):
        raise HTTPException(status_code=400, detail=result.get("error", "Could not generate DDL"))
    return result


class SchemaDiffRequest(BaseModel):
    connection_a: str
    connection_b: str


@app.post("/api/schema/diff")
async def get_schema_diff_endpoint(payload: SchemaDiffRequest, user: Dict[str, Any] = Depends(current_user)):
    conn = get_db_conn()
    try:
        row_a = _authorized_connection_row(conn, payload.connection_a, user)
        row_b = _authorized_connection_row(conn, payload.connection_b, user)
        if not row_a or not row_b:
            raise HTTPException(status_code=404, detail="One or both connections not found or not authorized")
        params_a = _connection_params(row_a)
        params_a["db_type"] = row_a.get("db_type")
        params_b = _connection_params(row_b)
        params_b["db_type"] = row_b.get("db_type")
    except RuntimeError as exc:
        raise HTTPException(status_code=409, detail="Saved connection credentials need to be updated") from exc
    finally:
        conn.close()

    result = get_schema_diff(params_a, params_b)
    result["connection_a_name"] = row_a.get("name")
    result["connection_b_name"] = row_b.get("name")
    return result

