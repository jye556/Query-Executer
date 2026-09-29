import unittest
from unittest.mock import patch
import os
import sqlite3
import tempfile
from fastapi.testclient import TestClient

from app.db_service import (
    execute_query,
    generate_table_ddl,
    get_schema_diff,
    validate_query,
)
from app.main import app


class V130EnhancementBackendTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
        self.tmp.close()
        self.db_path = self.tmp.name
        conn = sqlite3.connect(self.db_path)
        conn.execute("CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT NOT NULL, email TEXT)")
        conn.execute("CREATE TABLE orders (id INTEGER PRIMARY KEY, user_id INTEGER, amount REAL, FOREIGN KEY(user_id) REFERENCES users(id))")
        conn.commit()
        conn.close()

    def tearDown(self):
        if os.path.exists(self.db_path):
            os.unlink(self.db_path)

    def test_strict_read_only_validation(self):
        conn_params = {
            "db_type": "sqlite",
            "database": self.db_path,
            "extra_params": {"strict_read_only": True}
        }
        # Allowed read queries
        ok, err, _, _ = validate_query("SELECT * FROM users", connection_params=conn_params)
        self.assertTrue(ok)
        ok, err, _, _ = validate_query("EXPLAIN SELECT * FROM users", connection_params=conn_params)
        self.assertTrue(ok)

        # Blocked write/destructive queries
        ok, err, _, _ = validate_query("DELETE FROM users WHERE id = 1", connection_params=conn_params)
        self.assertFalse(ok)
        self.assertIn("Strict Read-Only", err)

        ok, err, _, _ = validate_query("UPDATE users SET name = 'foo'", connection_params=conn_params)
        self.assertFalse(ok)
        self.assertIn("Strict Read-Only", err)

        ok, err, _, _ = validate_query("DROP TABLE users", connection_params=conn_params)
        self.assertFalse(ok)
        self.assertIn("Strict Read-Only", err)

        ok, err, _, _ = validate_query("INSERT INTO users VALUES (1, 'a', 'b')", connection_params=conn_params)
        self.assertFalse(ok)
        self.assertIn("Strict Read-Only", err)

    def test_generate_table_ddl(self):
        res = generate_table_ddl("users", db_type="sqlite", database=self.db_path)
        self.assertTrue(res["success"])
        self.assertIn("CREATE TABLE", res["ddl"].upper())
        self.assertIn("users", res["ddl"].lower())

    def test_get_schema_diff(self):
        # Create second database with missing table and modified column
        tmp2 = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
        tmp2.close()
        try:
            conn2 = sqlite3.connect(tmp2.name)
            conn2.execute("CREATE TABLE users (id INTEGER PRIMARY KEY, name VARCHAR(100) NOT NULL)")
            conn2.execute("CREATE TABLE logs (id INTEGER PRIMARY KEY, message TEXT)")
            conn2.commit()
            conn2.close()

            diff = get_schema_diff(
                {"db_type": "sqlite", "database": self.db_path},
                {"db_type": "sqlite", "database": tmp2.name},
            )
            self.assertTrue(diff["success"])
            self.assertTrue(diff["has_differences"])
            # orders only in db1
            self.assertIn("orders", diff["tables_only_in_a"])
            # logs only in db2
            self.assertIn("logs", diff["tables_only_in_b"])
            # users is in both
            user_diff = next(t for t in diff["common_tables"] if t["name"].lower() == "users")
            # email only in db1
            self.assertTrue(any(c["name"] == "email" for c in user_diff["columns_only_in_a"]))
        finally:
            if os.path.exists(tmp2.name):
                os.unlink(tmp2.name)

    def test_saved_queries_api_crud(self):
        with patch("app.main._session_user", return_value={"id": 1, "username": "admin", "role": "admin"}), \
             patch("app.main._csrf_valid", return_value=True):
            with TestClient(app) as client:
                client.cookies.set("csrf_token", "ok")
                headers = {"X-CSRF-Token": "ok"}

                # Create saved query
                create_res = client.post(
                    "/api/saved-queries",
                    json={
                        "name": "Active Users",
                        "sql": "SELECT * FROM users WHERE active = 1",
                        "category": "Reporting",
                        "description": "Get active users",
                        "tags": "users,prod"
                    },
                    headers=headers
                )
                self.assertEqual(create_res.status_code, 200)
                data = create_res.json()
                self.assertEqual(data["name"], "Active Users")
                q_id = data["id"]

                # List saved queries
                list_res = client.get("/api/saved-queries")
                self.assertEqual(list_res.status_code, 200)
                self.assertTrue(any(q["id"] == q_id for q in list_res.json()))

                # Update saved query
                upd_res = client.put(
                    f"/api/saved-queries/{q_id}",
                    json={
                        "name": "Active Users Updated",
                        "sql": "SELECT * FROM users WHERE active = 1 AND verified = 1",
                        "category": "Reporting",
                        "description": "Updated description",
                        "tags": "users,verified"
                    },
                    headers=headers
                )
                self.assertEqual(upd_res.status_code, 200)
                self.assertEqual(upd_res.json()["name"], "Active Users Updated")

                # Delete saved query
                del_res = client.delete(f"/api/saved-queries/{q_id}", headers=headers)
                self.assertEqual(del_res.status_code, 200)

    def test_workspace_state_api(self):
        with patch("app.main._session_user", return_value={"id": 1, "username": "admin", "role": "admin"}), \
             patch("app.main._csrf_valid", return_value=True):
            with TestClient(app) as client:
                client.cookies.set("csrf_token", "ok")
                headers = {"X-CSRF-Token": "ok"}

                # Save workspace state
                save_res = client.put(
                    "/api/workspace",
                    json={"state_json": '{"tabs":[{"name":"Tab 1","query":"SELECT 1;"}]}'},
                    headers=headers
                )
                self.assertEqual(save_res.status_code, 200)

                # Get workspace state
                get_res = client.get("/api/workspace")
                self.assertEqual(get_res.status_code, 200)
                self.assertIn("Tab 1", get_res.json()["state_json"])


if __name__ == "__main__":
    unittest.main()
