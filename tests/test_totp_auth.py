import base64
import hashlib
import hmac
import struct
import unittest
from unittest.mock import patch

from app.auth import generate_totp_secret, totp_code, verify_totp
from app.migrations import run_migrations
import sqlite3


class TotpAuthenticationTests(unittest.TestCase):
    def test_generated_secret_verifies_for_current_time_and_adjacent_step(self):
        secret = generate_totp_secret()
        with patch("app.auth.time.time", return_value=1_700_000_000):
            code = totp_code(secret)
            self.assertTrue(verify_totp(secret, code))
        with patch("app.auth.time.time", return_value=1_700_000_030):
            self.assertTrue(verify_totp(secret, code))

    def test_verification_rejects_wrong_shape_or_code(self):
        secret = generate_totp_secret()
        with patch("app.auth.time.time", return_value=1_700_000_000):
            self.assertFalse(verify_totp(secret, "abc123"))
            self.assertFalse(verify_totp(secret, "123"))
            self.assertFalse(verify_totp(secret, "999999"))

    def test_totp_code_matches_rfc_6238_sha1_vector(self):
        secret = base64.b32encode(b"12345678901234567890").decode("ascii").rstrip("=")
        self.assertEqual(totp_code(secret, timestamp=59), "287082")

    def test_totp_secret_is_encrypted_with_app_key_and_decrypts(self):
        from cryptography.fernet import Fernet
        from unittest.mock import patch
        from app.main import _encrypt_totp_secret, _decrypt_totp_secret
        fernet = Fernet(Fernet.generate_key())
        with patch("app.main._fernet", return_value=fernet):
            encrypted = _encrypt_totp_secret("JBSWY3DPEHPK3PXP")
            self.assertNotEqual(encrypted, "JBSWY3DPEHPK3PXP")
            self.assertEqual(_decrypt_totp_secret(encrypted), "JBSWY3DPEHPK3PXP")

    def test_provisioning_uri_encodes_account_label_and_issuer(self):
        from urllib.parse import parse_qs, urlparse
        from app.auth import totp_provisioning_uri
        uri = totp_provisioning_uri("JBSWY3DPEHPK3PXP", "alice+test@example.com")
        parsed = urlparse(uri)
        query = parse_qs(parsed.query)
        self.assertEqual(parsed.scheme, "otpauth")
        self.assertEqual(query["secret"], ["JBSWY3DPEHPK3PXP"])
        self.assertEqual(query["issuer"], ["Query Execute"])
        self.assertEqual(query["period"], ["30"])
        self.assertEqual(query["algorithm"], ["SHA1"])

    def test_migration_adds_postgres_boolean_with_boolean_default(self):
        statements = []
        class Cursor:
            def __init__(self):
                self.last_sql = ""
            def execute(self, sql, params=None):
                self.last_sql = sql
                statements.append((sql, params))
            def fetchall(self):
                return [("id",)] if "information_schema.columns" in self.last_sql else []
            def fetchone(self):
                return (1,) if "information_schema.tables" in self.last_sql else None
            def close(self):
                pass
        class Connection:
            def cursor(self):
                return Cursor()
            def commit(self):
                pass
        from app.migrations import run_migrations
        run_migrations(Connection(), postgres=True)
        enabled_column_sql = [sql for sql, _ in statements if 'ADD COLUMN "totp_enabled"' in sql]
        self.assertTrue(enabled_column_sql)
        self.assertTrue(all("BOOLEAN NOT NULL DEFAULT FALSE" in sql for sql in enabled_column_sql))

    def test_migration_adds_totp_columns_to_existing_users_table(self):
        conn = sqlite3.connect(":memory:")
        conn.execute("CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT, password_hash TEXT, role TEXT, is_active INTEGER, created_at TIMESTAMP)")
        run_migrations(conn, postgres=False)
        columns = {row[1] for row in conn.execute("PRAGMA table_info(users)")}
        self.assertIn("totp_secret", columns)
        self.assertIn("totp_enabled", columns)
        self.assertEqual(conn.execute("SELECT COUNT(*) FROM users").fetchone()[0], 0)
        conn.close()


if __name__ == "__main__":
    unittest.main()
