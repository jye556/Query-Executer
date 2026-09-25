import unittest
from unittest.mock import patch
import os
import sqlite3
import tempfile

from fastapi import HTTPException
from app.db_service import (
    _get_mysql_connection,
    _single_select_context,
    apply_query_edits,
    execute_query,
    get_schema_metadata,
    validate_query,
)
from app.main import ConnectionInput, _validate_connection_input, app
from fastapi.testclient import TestClient


class RequestedEnhancementTests(unittest.TestCase):
    def test_mysql_connection_uses_database_name(self):
        fake = object()
        with patch("app.db_service.MYSQL_AVAILABLE", True), patch("app.db_service.pymysql.connect", return_value=fake) as connect:
            result = _get_mysql_connection({
                "host": "localhost",
                "port": 3306,
                "database": "appdb",
                "username": "root",
                "password": "[REDACTED]",
                "extra_params": {},
            })
        self.assertIs(result, fake)
        self.assertEqual(connect.call_args.kwargs["database"], "appdb")

    def test_mysql_database_name_is_required_and_trimmed(self):
        payload = ConnectionInput(name="mysql", db_type="mysql", database="  appdb  ")
        _validate_connection_input(payload)
        self.assertEqual(payload.database, "appdb")
        with self.assertRaisesRegex(HTTPException, "MySQL database name is required"):
            _validate_connection_input(ConnectionInput(name="mysql", db_type="mysql"))

    def test_mysql_connection_defaults_require_database_field(self):
        from app.db_service import get_supported_databases
        mysql = next(item for item in get_supported_databases() if item["type"] == "mysql")
        self.assertIn("database", mysql["required_fields"])
        self.assertNotIn("schemas", mysql["required_fields"])
        self.assertNotIn("schemas", mysql["defaults"]["extra_params"])

    def test_settings_sidebar_contains_two_factor_and_version_log(self):
        from pathlib import Path
        template = (Path(__file__).parents[1] / "app/templates/index.html").read_text()
        self.assertIn('data-view="settings-section"', template)
        self.assertIn('id="settings-section"', template)
        self.assertIn('id="btn-account-security"', template)
        self.assertIn('id="btn-apply-update"', template)
        self.assertIn('id="release-log"', template)
        self.assertIn('id="version-update-link"', template)
        self.assertIn('id="app-version-pill"', template)
        self.assertIn('<h1>Query Execute</h1>', template)
        self.assertIn('class="app-header"', template)
        self.assertNotIn('id="btn-account-security"', template.split('</header>', 1)[0])

    def test_login_centering_and_installers_are_documented(self):
        from pathlib import Path
        root = Path(__file__).parents[1]
        css = (root / "app/static/css/style.css").read_text()
        readme = (root / "README.md").read_text()
        installer = (root / "install_linux.sh").read_text()
        compose = (root / "docker-compose.yml").read_text()
        windows_installer = (root / "install_windows.ps1").read_text()
        self.assertIn(".auth-page {", css)
        self.assertIn("place-items: center", css)
        self.assertIn("bash install_linux.sh", readme)
        self.assertIn("install_windows.ps1", readme)
        self.assertIn("v1.0.4", readme)
        self.assertIn("BOOTSTRAP_ADMIN_USERNAME=admin", installer)
        self.assertNotIn("admin/admin", installer)
        self.assertIn("UPDATE_CHECK_URL", readme)
        self.assertIn("POSTGRES_PASSWORD=${POSTGRES_PASSWORD", compose)
        self.assertIn("scripts/init_sqlite_db.py", installer)
        self.assertIn("scripts/init_sqlite_db.py", windows_installer)

    def test_project_version_endpoint_returns_release_metadata(self):
        with patch("app.main._session_user", return_value={"id": 987, "role": "viewer", "csrf_token_hash": "ok"}), \
             patch("app.main.urlopen") as mock_urlopen, \
             TestClient(app) as client:
            # Mock GitHub API to return v1.0.5 as latest
            import json
            from unittest.mock import MagicMock
            response = MagicMock()
            response.__enter__.return_value.read.return_value = json.dumps({
                "tag_name": "v1.0.5",
                "name": "Query Execute 1.0.5",
                "html_url": "https://github.com/example/project/releases/tag/v1.0.5",
            }).encode()
            mock_urlopen.return_value = response
            
            response = client.get("/api/version")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["version"], "1.0.5")
        self.assertEqual(response.json()["latest_version"], "v1.0.5")
        self.assertTrue(response.json()["changelog"])
        self.assertIsInstance(response.json()["update_available"], bool)

    def test_version_endpoint_uses_remote_github_release_when_available(self):
        import asyncio
        import json
        from unittest.mock import MagicMock, patch
        from app.main import get_version
        response = MagicMock()
        response.__enter__.return_value.read.return_value = json.dumps({
            "tag_name": "v1.0.6",
            "name": "Query Execute 1.0.6",
            "html_url": "https://github.com/example/project/releases/tag/v1.0.6",
        }).encode()
        with patch.dict(os.environ, {"UPDATE_CHECK_URL": "https://api.github.test/releases/latest"}), \
             patch("app.main.urlopen", return_value=response):
            result = asyncio.run(get_version())
        self.assertEqual(result["latest_version"], "v1.0.6")
        self.assertTrue(result["update_available"])
        self.assertEqual(result["release_url"], "https://github.com/example/project/releases/tag/v1.0.6")

    def test_totp_setup_endpoint_returns_qr_code_for_authenticator_uri(self):
        import asyncio
        from app.main import setup_totp
        setup_user = {"id": 987, "username": "copy-test"}
        fake_uri = "otpauth://totp/Query%20Execute:copy-test?secret=ABCDEF234567"
        with patch("app.main._prepare_totp_setup", return_value="ABCDEF234567"), \
             patch("app.main.totp_provisioning_uri", return_value=fake_uri), \
             patch("app.main.get_db_conn") as get_db_conn:
            get_db_conn.return_value.close.return_value = None
            result = asyncio.run(setup_totp(user=setup_user))
        self.assertEqual(result["otpauth_uri"], fake_uri)
        self.assertTrue(result["qr_code_data_url"].startswith("data:image/svg+xml;base64,"))
        import base64
        import qrcode
        from xml.etree import ElementTree
        svg = base64.b64decode(result["qr_code_data_url"].split(",", 1)[1])
        root = ElementTree.fromstring(svg)
        self.assertEqual(root.tag, "{http://www.w3.org/2000/svg}svg")
        paths = root.findall("{http://www.w3.org/2000/svg}path")
        self.assertEqual(len(paths), 2)
        qr_matrix = qrcode.QRCode(error_correction=qrcode.constants.ERROR_CORRECT_M)
        qr_matrix.add_data(fake_uri)
        qr_matrix.make(fit=True)
        self.assertEqual(paths[1].attrib["d"].count("z"), sum(map(sum, qr_matrix.get_matrix())))

    def test_totp_setup_displays_copyable_secret_and_qr_code(self):
        from pathlib import Path
        root = Path(__file__).parents[1]
        template = (root / "app/templates/index.html").read_text()
        script = (root / "app/static/js/app.js").read_text()
        self.assertIn('id="totp-setup-secret"', template)
        self.assertIn('id="totp-setup-qr"', template)
        self.assertIn('id="btn-copy-totp-secret"', template)
        self.assertIn('id="totp-step-two-code"', template)
        self.assertIn('id="totp-step-two"', template)
        self.assertIn('navigator.clipboard.writeText', script)
        self.assertIn('setup.qr_code_data_url', script)
        self.assertNotIn("Add this key to your authenticator app", script)

    def test_connection_form_exposes_database_not_schema_field(self):
        from pathlib import Path
        template = (Path(__file__).parents[1] / "app/templates/index.html").read_text()
        self.assertIn('id="conn-database"', template)
        self.assertNotIn('id="conn-schemas"', template)

    def test_mysql_legacy_schema_setting_does_not_override_database_name(self):
        fake = object()
        with patch("app.db_service.MYSQL_AVAILABLE", True), patch("app.db_service.pymysql.connect", return_value=fake) as connect:
            _get_mysql_connection({
                "host": "localhost", "port": 3306, "database": "chosen_db",
                "schemas": "old_schema", "username": "root", "password": "[REDACTED]",
                "extra_params": {"schemas": "old_schema"},
            })
        self.assertEqual(connect.call_args.kwargs["database"], "chosen_db")

    def test_editable_select_requires_projected_key_and_supported_target(self):
        valid = _single_select_context("SELECT id, name FROM demo WHERE id = 1")
        self.assertIsNotNone(valid)
        self.assertEqual(valid["selected_columns"], {"id", "name"})
        self.assertIsNone(_single_select_context("SELECT name FROM demo WHERE id = 1"))
        self.assertIsNone(_single_select_context("SELECT id, name FROM demo WHERE id = 1 OR 1 = 1"))
        self.assertIsNone(_single_select_context("SELECT id, name FROM demo WHERE id = (SELECT 1)"))

    def test_query_check_rejects_invalid_select_syntax(self):
        database_config = {"database": ":memory:"}
        ok, error, _, _ = validate_query("SELECT FROM WHERE", db_type="sqlite", connection_params=database_config)
        self.assertFalse(ok)
        self.assertIn("syntax error", error.lower())

    def test_valid_existing_table_select_passes_schema_context(self):
        fd, database = tempfile.mkstemp(suffix=".db")
        os.close(fd)
        try:
            with sqlite3.connect(database) as connection:
                connection.execute("CREATE TABLE demo (id INTEGER)")
            ok, error, _, _ = validate_query("SELECT * FROM demo", db_type="sqlite", connection_params={"database": database})
            self.assertTrue(ok, error)
        finally:
            os.unlink(database)

    def test_query_check_does_not_apply_sqlite_dialect_to_mssql(self):
        ok, error, _, _ = validate_query("SELECT TOP (1) id FROM demo", db_type="mssql")
        self.assertTrue(ok, error)

    def test_query_check_rejects_unbalanced_sql_structure(self):
        ok, error, _, _ = validate_query("SELECT * FROM demo WHERE (id = 1")
        self.assertFalse(ok)
        self.assertIn("parentheses", error.lower())

        ok, error, _, _ = validate_query("SELECT 'unterminated")
        self.assertFalse(ok)
        self.assertIn("quoted", error.lower())

    def test_check_query_endpoint_returns_select_syntax_feedback(self):
        test_user = {"id": 42, "role": "viewer", "csrf_token_hash": "ok"}
        with patch("app.main._session_user", return_value=test_user), \
             patch("app.main._csrf_valid", return_value=True), \
             patch("app.main.get_db_conn") as get_db_conn, \
             patch("app.main._authorized_connection_row", return_value={"id": "sqlite-1", "db_type": "sqlite", "database": ":memory:", "extra_params": {}}):
            get_db_conn.return_value.close.return_value = None
            with TestClient(app) as client:
                client.cookies.set("csrf_token", "ok")
                response = client.post("/api/query/check", json={"connection_id": "sqlite-1", "query": "SELECT FROM WHERE"}, headers={"X-CSRF-Token": "ok"})
        self.assertEqual(response.status_code, 200)
        self.assertFalse(response.json()["valid"])
        self.assertIn("syntax error", response.json()["error"].lower())

    def test_sqlite_schema_metadata_and_edit_application(self):
        fd, database = tempfile.mkstemp(suffix=".db")
        os.close(fd)
        try:
            self.assertTrue(execute_query("CREATE TABLE demo (id INTEGER PRIMARY KEY, name TEXT)", db_type="sqlite", database=database)["success"])
            self.assertTrue(execute_query("INSERT INTO demo VALUES (1, 'before')", db_type="sqlite", database=database)["success"])
            metadata = get_schema_metadata(db_type="sqlite", database=database)
            self.assertEqual(metadata["tables"][0]["name"], "demo")
            self.assertEqual(metadata["tables"][0]["columns"], ["id", "name"])

            result = execute_query("SELECT id, name FROM demo WHERE id = 1", db_type="sqlite", database=database)
            self.assertTrue(result["edit_context"]["editable"])
            applied = apply_query_edits(
                query="SELECT id, name FROM demo WHERE id = 1",
                edits=[{"key_value": 1, "column": "name", "value": "after"}],
                db_type="sqlite",
                database=database,
            )
            self.assertTrue(applied["success"], applied)
            updated = execute_query("SELECT id, name FROM demo WHERE id = 1", db_type="sqlite", database=database)
            self.assertEqual(updated["data"], [{"id": 1, "name": "after"}])
        finally:
            os.unlink(database)

    def test_result_edit_context_only_allows_a_unique_where_key(self):
        fd, database = tempfile.mkstemp(suffix=".db")
        os.close(fd)
        try:
            execute_query("CREATE TABLE demo (id INTEGER PRIMARY KEY, category TEXT)", db_type="sqlite", database=database)
            execute_query("INSERT INTO demo VALUES (1, 'same')", db_type="sqlite", database=database)
            execute_query("INSERT INTO demo VALUES (2, 'same')", db_type="sqlite", database=database)
            ambiguous = execute_query("SELECT id, category FROM demo WHERE category = 'same'", db_type="sqlite", database=database)
            self.assertFalse(ambiguous["edit_context"]["editable"])
            unique = execute_query("SELECT id, category FROM demo WHERE id = 1", db_type="sqlite", database=database)
            self.assertTrue(unique["edit_context"]["editable"])
            rejected = apply_query_edits(
                query="SELECT id, category FROM demo WHERE id = 1",
                edits=[{"key_value": 2, "column": "category", "value": "wrong-row"}],
                db_type="sqlite",
                database=database,
            )
            self.assertFalse(rejected["success"])
        finally:
            os.unlink(database)


if __name__ == "__main__":
    unittest.main()
