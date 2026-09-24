import asyncio
import sqlite3
import tempfile
import unittest
from unittest.mock import patch

from fastapi import HTTPException

from cryptography.fernet import Fernet

from app.auth import generate_totp_secret, totp_code
from app.main import LoginRequest, login
from app.migrations import run_migrations

TEST_FERNET = Fernet(Fernet.generate_key())


def _connection(path):
    conn = sqlite3.connect(path)
    conn.row_factory = sqlite3.Row
    return conn


class TotpLoginTests(unittest.TestCase):
    def test_password_only_does_not_create_session_when_totp_is_enabled(self):
        with tempfile.NamedTemporaryFile(suffix=".db") as db_file:
            conn = sqlite3.connect(db_file.name)
            run_migrations(conn, postgres=False)
            secret = generate_totp_secret()
            conn.execute(
                "INSERT INTO users (username, password_hash, role, is_active, totp_secret, totp_enabled) VALUES (?, ?, 'admin', 1, ?, 1)",
                ("alice", "[test password hash]", TEST_FERNET.encrypt(secret.encode()).decode()),
            )
            conn.commit()
            conn.close()
            with patch("app.main.USE_POSTGRES", False), patch("app.main.get_db_conn", side_effect=lambda: _connection(db_file.name)), patch("app.main.verify_password", return_value=True), patch("app.main._fernet", return_value=TEST_FERNET):
                with self.assertRaises(HTTPException) as caught:
                    asyncio.run(login(LoginRequest(username="alice", password="example-password")))
            self.assertEqual(caught.exception.status_code, 401)
            self.assertEqual(caught.exception.detail, "Invalid authenticator code")
            verify_db = sqlite3.connect(db_file.name)
            try:
                self.assertEqual(verify_db.execute("SELECT COUNT(*) FROM sessions").fetchone()[0], 0)
            finally:
                verify_db.close()

    def test_enabled_totp_cannot_be_replaced_by_restarting_setup(self):
        with tempfile.NamedTemporaryFile(suffix=".db") as db_file:
            conn = sqlite3.connect(db_file.name)
            run_migrations(conn, postgres=False)
            secret = generate_totp_secret()
            encrypted = TEST_FERNET.encrypt(secret.encode()).decode()
            conn.execute(
                "INSERT INTO users (username, password_hash, role, is_active, totp_secret, totp_enabled) VALUES (?, ?, 'admin', 1, ?, 1)",
                ("alice", "[test password hash]", encrypted),
            )
            conn.commit()
            conn.close()
            with patch("app.main.USE_POSTGRES", False), patch("app.main._fernet", return_value=TEST_FERNET):
                conn = _connection(db_file.name)
                try:
                    from app.main import _prepare_totp_setup
                    with self.assertRaises(HTTPException) as caught:
                        _prepare_totp_setup(conn, 1)
                    self.assertEqual(caught.exception.status_code, 409)
                finally:
                    conn.close()
            verify_db = sqlite3.connect(db_file.name)
            try:
                stored_secret, enabled = verify_db.execute("SELECT totp_secret, totp_enabled FROM users WHERE username = 'alice'").fetchone()
                self.assertEqual(stored_secret, encrypted)
                self.assertEqual(enabled, 1)
            finally:
                verify_db.close()

    def test_totp_setup_secret_is_encrypted_and_requires_code_confirmation(self):
        with tempfile.NamedTemporaryFile(suffix=".db") as db_file:
            conn = sqlite3.connect(db_file.name)
            run_migrations(conn, postgres=False)
            conn.execute(
                "INSERT INTO users (username, password_hash, role, is_active) VALUES ('alice', '[test password hash]', 'admin', 1)"
            )
            conn.commit()
            conn.close()
            with patch("app.main.USE_POSTGRES", False), patch("app.main._fernet", return_value=TEST_FERNET), patch("app.main.generate_totp_secret", return_value=generate_totp_secret()):
                conn = _connection(db_file.name)
                try:
                    from app.main import _prepare_totp_setup, _confirm_totp_setup
                    secret = _prepare_totp_setup(conn, 1)
                    stored, enabled = conn.execute("SELECT totp_secret, totp_enabled FROM users WHERE id = 1").fetchone()
                    self.assertNotEqual(stored, secret)
                    self.assertEqual(TEST_FERNET.decrypt(stored.encode()).decode(), secret)
                    self.assertEqual(enabled, 0)
                    with self.assertRaises(HTTPException):
                        _confirm_totp_setup(conn, 1, "000000" if totp_code(secret) != "000000" else "000001")
                    self.assertEqual(conn.execute("SELECT totp_enabled FROM users WHERE id = 1").fetchone()[0], 0)
                    _confirm_totp_setup(conn, 1, totp_code(secret))
                    self.assertEqual(conn.execute("SELECT totp_enabled FROM users WHERE id = 1").fetchone()[0], 1)
                finally:
                    conn.close()

    def test_valid_password_and_totp_issue_session(self):
        with tempfile.NamedTemporaryFile(suffix=".db") as db_file:
            conn = sqlite3.connect(db_file.name)
            run_migrations(conn, postgres=False)
            secret = generate_totp_secret()
            conn.execute(
                "INSERT INTO users (username, password_hash, role, is_active, totp_secret, totp_enabled) VALUES (?, ?, 'admin', 1, ?, 1)",
                ("alice", "[test password hash]", TEST_FERNET.encrypt(secret.encode()).decode()),
            )
            conn.commit()
            conn.close()
            fixed_time = 1_700_000_000
            with patch("app.main.USE_POSTGRES", False), patch("app.main.get_db_conn", side_effect=lambda: _connection(db_file.name)), patch("app.main._user_group_ids", return_value=[]), patch("app.main.verify_password", return_value=True), patch("app.auth.time.time", return_value=fixed_time), patch("app.main._fernet", return_value=TEST_FERNET):
                response = asyncio.run(login(LoginRequest(username="alice", password="example-password", totp_code=totp_code(secret, fixed_time))))
            self.assertIn("alice", response.body.decode())
            self.assertTrue(response.headers.get("set-cookie"))
            verify_db = sqlite3.connect(db_file.name)
            try:
                self.assertEqual(verify_db.execute("SELECT COUNT(*) FROM sessions").fetchone()[0], 1)
            finally:
                verify_db.close()


if __name__ == "__main__":
    unittest.main()
