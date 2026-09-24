import asyncio
from unittest.mock import patch

from app.db_service import get_supported_databases
from app.main import ConnectionTestInput, test_unsaved_connection


def test_every_database_type_exposes_default_connection_settings():
    databases = {item["type"]: item for item in get_supported_databases()}
    assert set(databases) == {"postgresql", "mysql", "firebird", "mssql", "sqlite"}

    expected = {
        "postgresql": ("localhost", 5432, "postgres", "postgres"),
        "mysql": ("localhost", 3306, "mysql", "root"),
        "firebird": ("localhost", 3050, "", "SYSDBA"),
        "mssql": ("localhost", 1433, "master", "sa"),
        "sqlite": ("", None, ":memory:", ""),
    }
    for db_type, (host, port, database, username) in expected.items():
        defaults = databases[db_type]["defaults"]
        assert defaults["host"] == host
        assert defaults["port"] == port
        assert defaults["database"] == database
        assert defaults["username"] == username
        assert isinstance(defaults["extra_params"], dict)


def test_unsaved_connection_test_does_not_save_and_uses_form_values():
    payload = ConnectionTestInput(
        db_type="sqlite",
        database=":memory:",
        extra_params={},
    )
    user = {"id": 1, "role": "admin"}
    with patch("app.main.test_connection", return_value={"success": True, "message": "ok"}) as test:
        result = asyncio.run(test_unsaved_connection(payload, user))

    assert result == {"success": True, "message": "ok"}
    test.assert_called_once_with(
        db_type="sqlite",
        host="",
        port=None,
        database=":memory:",
        username="",
        password=None,
        extra_params={},
    )
