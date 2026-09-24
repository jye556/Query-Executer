"""Connections to supported customer databases and guarded SQL execution."""

from __future__ import annotations

import re
import time
from datetime import date, datetime
from decimal import Decimal
from enum import Enum
from typing import Any, Dict, List, Optional, Tuple

try:
    import psycopg2
    POSTGRESQL_AVAILABLE = True
except ImportError:  # pragma: no cover - optional for local SQLite development
    psycopg2 = None
    POSTGRESQL_AVAILABLE = False

try:
    import pymysql
    MYSQL_AVAILABLE = True
except ImportError:  # pragma: no cover
    class _MissingMySQL:
        class cursors:
            class DictCursor:
                pass

        def connect(self, **kwargs):
            raise RuntimeError("MySQL driver (pymysql) is not installed")
    pymysql = _MissingMySQL()
    MYSQL_AVAILABLE = False

try:
    import fdb
    FIREBIRD_AVAILABLE = True
except ImportError:  # pragma: no cover
    fdb = None
    FIREBIRD_AVAILABLE = False

try:
    import pyodbc
    MSSQL_AVAILABLE = True
except ImportError:  # pragma: no cover
    pyodbc = None
    MSSQL_AVAILABLE = False

try:
    import sqlite3
    SQLITE_AVAILABLE = True
except ImportError:  # pragma: no cover
    sqlite3 = None
    SQLITE_AVAILABLE = False


class DatabaseType(str, Enum):
    POSTGRESQL = "postgresql"
    MYSQL = "mysql"
    FIREBIRD = "firebird"
    MSSQL = "mssql"
    SQLITE = "sqlite"


def _db_name(db_type: Any) -> str:
    return str(getattr(db_type, "value", db_type)).lower()


def get_supported_databases() -> List[Dict[str, Any]]:
    """Return database capabilities and the values used to seed the form.

    A type is marked available only when its Python adapter and required native
    client are usable.  The defaults are connection *settings*, not secrets;
    passwords intentionally remain blank in API responses.
    """
    return [
        {
            "type": DatabaseType.POSTGRESQL.value,
            "name": "PostgreSQL",
            "driver": "psycopg2",
            "available": POSTGRESQL_AVAILABLE,
            "default_port": 5432,
            "defaults": {
                "host": "localhost",
                "port": 5432,
                "database": "postgres",
                "username": "postgres",
                "extra_params": {"sslmode": "prefer"},
            },
            "required_fields": ["host", "database", "username", "password"],
            "optional_fields": ["port", "sslmode"],
        },
        {
            "type": "mysql",
            "name": "MySQL / MariaDB",
            "driver": "pymysql",
            "available": MYSQL_AVAILABLE,
            "default_port": 3306,
            "defaults": {
                "host": "localhost",
                "port": 3306,
                "database": "",
                "username": "root",
                "extra_params": {"charset": "utf8mb4"},
            },
            "required_fields": ["host", "database", "username", "password"],
            "optional_fields": ["port", "charset"],
        },
        {
            "type": DatabaseType.FIREBIRD.value,
            "name": "Firebird",
            "driver": "fdb",
            "available": FIREBIRD_AVAILABLE,
            "default_port": 3050,
            "defaults": {
                "host": "localhost",
                "port": 3050,
                "database": "",
                "username": "SYSDBA",
                "extra_params": {"charset": "UTF8"},
            },
            "required_fields": ["host", "database", "username", "password"],
            "optional_fields": ["port", "charset", "role"],
        },
        {
            "type": DatabaseType.MSSQL.value,
            "name": "Microsoft SQL Server",
            "driver": "pyodbc",
            "available": MSSQL_AVAILABLE,
            "default_port": 1433,
            "defaults": {
                "host": "localhost",
                "port": 1433,
                "database": "master",
                "username": "sa",
                "extra_params": {
                    "driver": "ODBC Driver 18 for SQL Server",
                    "trust_server_certificate": "yes",
                },
            },
            "required_fields": ["host", "database", "username", "password"],
            "optional_fields": ["port", "driver", "trust_server_certificate"],
        },
        {
            "type": DatabaseType.SQLITE.value,
            "name": "SQLite",
            "driver": "sqlite3",
            "available": SQLITE_AVAILABLE,
            "default_port": None,
            "defaults": {
                "host": "",
                "port": None,
                "database": ":memory:",
                "username": "",
                "extra_params": {},
            },
            "required_fields": ["database"],
            "optional_fields": [],
        },
    ]


def _serialize_value(value: Any) -> Any:
    if value is None:
        return None
    if isinstance(value, (datetime, date)):
        return value.isoformat()
    if isinstance(value, Decimal):
        return float(value)
    if isinstance(value, (bytes, bytearray)):
        try:
            return value.decode("utf-8")
        except UnicodeDecodeError:
            return value.hex()
    if isinstance(value, (str, int, float, bool)):
        return value
    return str(value)


def _get_postgresql_connection(params: Dict[str, Any]):
    if not POSTGRESQL_AVAILABLE:
        raise RuntimeError("PostgreSQL driver (psycopg2) is not installed")
    database = params.get("database")
    if not database:
        raise ValueError("PostgreSQL database name is required")
    sslmode = params.get("extra_params", {}).get("sslmode")
    allowed_sslmodes = {"disable", "allow", "prefer", "require", "verify-ca", "verify-full"}
    kwargs = {
        "host": params.get("host") or "localhost",
        "port": params.get("port") or 5432,
        "database": params.get("database"),
        "user": params.get("username"),
        "password": params.get("password"),
        "connect_timeout": 10,
    }
    if sslmode in allowed_sslmodes:
        kwargs["sslmode"] = sslmode
    return psycopg2.connect(**kwargs)


def _get_mysql_connection(params: Dict[str, Any]):
    if not MYSQL_AVAILABLE:
        raise RuntimeError("MySQL driver (pymysql) is not installed")
    database = params.get("database")
    if not database:
        raise ValueError("MySQL database name is required")
    return pymysql.connect(
        host=params.get("host") or "localhost",
        port=params.get("port") or 3306,
        database=database,
        user=params.get("username"),
        password=params.get("password"),
        charset=params.get("extra_params", {}).get("charset", "utf8mb4"),
        connect_timeout=10,
        read_timeout=30,
        write_timeout=30,
        cursorclass=pymysql.cursors.DictCursor,
    )


def _get_firebird_connection(params: Dict[str, Any]):
    if not FIREBIRD_AVAILABLE:
        raise RuntimeError("Firebird driver (fdb) is not installed")
    host = params.get("host") or "localhost"
    port = params.get("port") or 3050
    database = params.get("database")
    if not database:
        raise ValueError("Firebird database path is required")
    dsn = f"{host}/{port}:{database}"
    return fdb.connect(
        dsn=dsn,
        user=params.get("username") or "SYSDBA",
        password=params.get("password") or "masterkey",
        charset=params.get("extra_params", {}).get("charset", "UTF8"),
        role=params.get("extra_params", {}).get("role"),
    )


def _get_mssql_connection(params: Dict[str, Any]):
    if not MSSQL_AVAILABLE:
        raise RuntimeError("MSSQL driver (pyodbc) is not installed")
    extra = params.get("extra_params", {})
    driver = str(extra.get("driver", "ODBC Driver 18 for SQL Server"))
    host = str(params.get("host") or "localhost")
    port = params.get("port") or 1433
    database = params.get("database")
    if not database:
        raise ValueError("SQL Server database name is required")
    database = str(database)
    trust_cert = str(extra.get("trust_server_certificate", "yes")).lower()
    if trust_cert not in {"yes", "no"}:
        trust_cert = "no"
    # Escape ODBC braced values so a host/driver/database value cannot inject
    # additional connection-string attributes.
    def odbc_value(value: str) -> str:
        return "{" + value.replace("}", "}}") + "}"
    conn_str = (
        f"DRIVER={odbc_value(driver)};SERVER={odbc_value(host + ',' + str(port))};"
        f"DATABASE={odbc_value(database)};UID={odbc_value(str(params.get('username') or ''))};"
        f"PWD={odbc_value(str(params.get('password') or ''))};"
        f"TrustServerCertificate={trust_cert};"
    )
    return pyodbc.connect(conn_str, timeout=10)


def _get_sqlite_connection(params: Dict[str, Any]):
    if not SQLITE_AVAILABLE:
        raise RuntimeError("SQLite driver is not available")
    db_path = params.get("database")
    if not db_path:
        raise ValueError("SQLite database path is required")
    # URI filenames can open arbitrary resources and alter SQLite's access
    # mode.  The API stores normalized ordinary paths, so reject them here as
    # defense in depth for legacy rows and direct callers.
    if isinstance(db_path, str) and db_path.lower().startswith(("file:", "\\\\", "//")):
        raise RuntimeError("SQLite database paths must be local filesystem paths")
    conn = sqlite3.connect(db_path, timeout=10, uri=False)
    conn.row_factory = sqlite3.Row
    return conn


def _get_connection(db_type: Any, params: Dict[str, Any]):
    name = _db_name(db_type)
    if name == DatabaseType.POSTGRESQL.value:
        return _get_postgresql_connection(params)
    if name in {"mysql", "mariadb"}:
        return _get_mysql_connection(params)
    if name == DatabaseType.FIREBIRD.value:
        return _get_firebird_connection(params)
    if name in {"mssql", "sqlserver", "sql_server"}:
        return _get_mssql_connection(params)
    if name == DatabaseType.SQLITE.value:
        return _get_sqlite_connection(params)
    raise RuntimeError(f"Unsupported database type: {name}")


def _visible_sql(sql: str) -> str:
    """Blank comments and quoted literals while preserving SQL keywords."""
    out: List[str] = []
    i = 0
    state = "normal"
    while i < len(sql):
        ch = sql[i]
        nxt = sql[i + 1] if i + 1 < len(sql) else ""
        if state == "normal":
            if ch == "-" and nxt == "-":
                out.extend((" ", " "))
                state = "line_comment"
                i += 2
                continue
            if ch == "/" and nxt == "*":
                out.extend((" ", " "))
                state = "block_comment"
                i += 2
                continue
            if ch in ("'", '"', "`"):
                state = ch
                out.append(" ")
            else:
                out.append(ch)
        elif state == "line_comment":
            out.append("\n" if ch == "\n" else " ")
            if ch == "\n":
                state = "normal"
        elif state == "block_comment":
            out.append("\n" if ch == "\n" else " ")
            if ch == "*" and nxt == "/":
                out.append(" ")
                state = "normal"
                i += 1
        else:
            # Quoted values cannot introduce statement delimiters or keywords.
            out.append(" ")
            if ch == state:
                if nxt == state:  # SQL escaped quote, e.g. ''
                    out.append(" ")
                    i += 1
                else:
                    state = "normal"
            elif ch == "\\" and state in ("'", '"', "`"):
                if i + 1 < len(sql):
                    out.append(" ")
                    i += 1
        i += 1
    return "".join(out)


def _balanced_sql(query: str) -> Tuple[bool, str]:
    """Catch common structural errors before sending SQL to a driver."""
    stack: List[str] = []
    quote: Optional[str] = None
    i = 0
    while i < len(query):
        ch = query[i]
        nxt = query[i + 1] if i + 1 < len(query) else ""
        if quote:
            if ch == quote:
                if nxt == quote:
                    i += 1
                else:
                    quote = None
            elif ch == "\\" and quote in ("'", '"', "`"):
                i += 1
        elif ch in ("'", '"', "`"):
            quote = ch
        elif ch in "([{":
            stack.append(ch)
        elif ch in ")]}":
            expected = {')': '(', ']': '[', '}': '{'}[ch]
            if not stack or stack.pop() != expected:
                return False, "Unbalanced parentheses or brackets"
        i += 1
    if quote:
        return False, "Unterminated quoted value"
    if stack:
        return False, "Unbalanced parentheses or brackets"
    return True, ""


def _literal_value(value: str) -> Any:
    if value.upper() == "NULL":
        return None
    if value.startswith("'") and value.endswith("'"):
        return value[1:-1].replace("''", "'")
    if value.startswith('"') and value.endswith('"'):
        return value[1:-1].replace('""', '"')
    try:
        return int(value)
    except ValueError:
        return float(value)


def _single_select_context(query: str) -> Optional[Dict[str, Any]]:
    """Extract a conservative editable SELECT target and key column."""
    match = re.match(
        r"^\s*SELECT\s+(?P<columns>[^;]+?)\s+FROM\s+(?P<table>[A-Za-z_][A-Za-z0-9_$]*(?:\.[A-Za-z_][A-Za-z0-9_$]*)?)\s+WHERE\s+(?P<key>[A-Za-z_][A-Za-z0-9_$]*)\s*=\s*(?P<value>'(?:''|[^'])*'|\"(?:\"\"|[^\"])*\"|[-+]?[0-9]+(?:\.[0-9]+)?|NULL)\s*$",
        query.strip().rstrip(';'),
        flags=re.IGNORECASE | re.DOTALL,
    )
    if not match:
        return None
    if len(match.group("table").split(".")) > 2:
        return None
    if "*" not in match.group("columns"):
        selected_columns = {part.strip().split(".")[-1].strip('"`[]') for part in match.group("columns").split(",")}
        if match.group("key") not in selected_columns:
            return None
        selected_columns = {part.strip().split(".")[-1].strip('"`[]') for part in match.group("columns").split(",") if "*" not in part}
    else:
        selected_columns = set()
    return {**match.groupdict(), "selected_columns": selected_columns, "value": _literal_value(match.group("value"))}


def _edit_context_for_query(query: str, columns: List[str], rows: List[Dict[str, Any]], **params: Any) -> Dict[str, Any]:
    context = _single_select_context(query)
    if not context or not rows:
        return {"editable": False, "reason": "Only a simple SELECT with a WHERE key and returned rows can be edited"}
    key = context["key"]
    if key not in columns:
        return {"editable": False, "reason": "The WHERE key column must be present in the result"}
    name = _db_name(params.get("db_type", "sqlite"))
    conn = None
    cursor = None
    try:
        matches = re.match(r"^([A-Za-z_][A-Za-z0-9_$]*)(?:\.([A-Za-z_][A-Za-z0-9_$]*))?$", context["table"])
        if not matches or (name in {DatabaseType.SQLITE.value, DatabaseType.MSSQL.value} and matches.group(2)) or (name == DatabaseType.POSTGRESQL.value and not matches.group(2)):
            return {"editable": False, "reason": "Qualified table names cannot be edited"}
        schema_name, table_name = (matches.group(1), matches.group(2)) if matches.group(2) else (None, matches.group(1))
        conn = _get_connection(name, params)
        cursor = conn.cursor()
        if name == DatabaseType.SQLITE.value:
            cursor.execute("SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = ?", (table_name,))
        elif name == DatabaseType.MYSQL.value:
            cursor.execute("SELECT COUNT(*) FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name = %s", (table_name,))
        elif name == DatabaseType.POSTGRESQL.value:
            if schema_name:
                cursor.execute("SELECT COUNT(*) FROM information_schema.tables WHERE table_schema = %s AND table_name = %s", (schema_name, table_name))
            else:
                cursor.execute("SELECT COUNT(*) FROM information_schema.tables WHERE table_schema = CURRENT_SCHEMA() AND table_name = %s", (table_name,))
        elif name == DatabaseType.MSSQL.value:
            if schema_name:
                cursor.execute("SELECT COUNT(*) FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?", (schema_name, table_name))
            else:
                cursor.execute("SELECT COUNT(*) FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_NAME = ?", (table_name,))
        elif name == DatabaseType.FIREBIRD.value:
            return {"editable": False, "reason": "Result editing is not supported for this database type"}
        else:
            cursor.execute("SELECT COUNT(*) FROM information_schema.tables WHERE table_schema = CURRENT_SCHEMA() AND table_name = %s", (table_name,))
        if not int(cursor.fetchone()[0]):
            return {"editable": False, "reason": "Query table could not be verified"}
        if name == DatabaseType.SQLITE.value:
            cursor.execute(f'PRAGMA table_info("{table_name.replace(chr(34), chr(34) * 2)}")')
            primary_keys = [row[1] for row in cursor.fetchall() if row[5]]
        elif name == DatabaseType.MYSQL.value:
            cursor.execute("SELECT column_name FROM information_schema.key_column_usage WHERE table_schema = DATABASE() AND table_name = %s AND constraint_name = 'PRIMARY'", (table_name,))
            primary_keys = [row[0] for row in cursor.fetchall()]
        elif name == DatabaseType.POSTGRESQL.value:
            if schema_name:
                cursor.execute("SELECT kcu.column_name FROM information_schema.table_constraints tc JOIN information_schema.key_column_usage kcu ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema WHERE tc.constraint_type = 'PRIMARY KEY' AND tc.table_schema = %s AND tc.table_name = %s", (schema_name, table_name))
            else:
                cursor.execute("SELECT kcu.column_name FROM information_schema.table_constraints tc JOIN information_schema.key_column_usage kcu ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema WHERE tc.constraint_type = 'PRIMARY KEY' AND tc.table_schema = CURRENT_SCHEMA() AND tc.table_name = %s", (table_name,))
            primary_keys = [row[0] for row in cursor.fetchall()]
        elif name == DatabaseType.MSSQL.value:
            if schema_name:
                cursor.execute("SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.KEY_COLUMN_USAGE WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND CONSTRAINT_NAME LIKE 'PK%'", (schema_name, table_name))
            else:
                cursor.execute("SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.KEY_COLUMN_USAGE WHERE TABLE_NAME = ? AND CONSTRAINT_NAME LIKE 'PK%'", (table_name,))
            primary_keys = [row[0] for row in cursor.fetchall()]
        else:
            return {"editable": False, "reason": "Result editing is not supported for this database type"}
        if key not in primary_keys:
            return {"editable": False, "reason": "Only queries filtered by a primary key can be edited"}
        if name == DatabaseType.MSSQL.value:
            table_reference = f"[{table_name.replace(chr(93), chr(93) * 2)}]" if not schema_name else f"[{schema_name.replace(chr(93), chr(93) * 2)}].[{table_name.replace(chr(93), chr(93) * 2)}]"
            safe_key = f"[{key.replace(chr(93), chr(93) * 2)}]"
        elif name == DatabaseType.MYSQL.value:
            table_reference = f"`{table_name.replace('`', '``')}`"
            safe_key = f"`{key.replace('`', '``')}`"
        else:
            table_reference = f'"{table_name.replace(chr(34), chr(34) * 2)}"' if not schema_name else f'"{schema_name.replace(chr(34), chr(34) * 2)}"."{table_name.replace(chr(34), chr(34) * 2)}"'
            safe_key = f'"{key.replace(chr(34), chr(34) * 2)}"'
        if name == DatabaseType.MSSQL.value:
            cursor.execute(f"SELECT COUNT(*) FROM {table_reference} WHERE {safe_key} = ?", (context["value"],))
        else:
            placeholder = "%s" if name in {DatabaseType.MYSQL.value, DatabaseType.POSTGRESQL.value} else "?"
            cursor.execute(f"SELECT COUNT(*) FROM {table_reference} WHERE {safe_key} = {placeholder}", (context["value"],))
        if cursor.fetchone()[0] != 1:
            return {"editable": False, "reason": "The WHERE clause must identify exactly one row"}
        return {"editable": True, "key_column": key, "table": context["table"], "value": context["value"], "selected_columns": sorted(context["selected_columns"])}
    except Exception:
        return {"editable": False, "reason": "The query could not be safely mapped to a table"}
    finally:
        if cursor:
            cursor.close()
        if conn:
            conn.close()


def get_schema_metadata(**params: Any) -> Dict[str, Any]:
    """Return table and column names for editor suggestions."""
    conn = None
    cursor = None
    name = _db_name(params.get("db_type", "sqlite"))
    try:
        conn = _get_connection(name, params)
        cursor = conn.cursor()
        if name == DatabaseType.SQLITE.value:
            cursor.execute("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
            table_names = [row[0] for row in cursor.fetchall()]
            tables = []
            for table in table_names:
                cursor.execute(f'PRAGMA table_info("{str(table).replace(chr(34), chr(34) * 2)}")')
                tables.append({"name": table, "columns": [row[1] for row in cursor.fetchall()]})
        elif name == DatabaseType.MYSQL.value:
            cursor.execute("SELECT table_name FROM information_schema.tables WHERE table_schema = DATABASE() ORDER BY table_name")
            table_names = [row[0] for row in cursor.fetchall()]
            tables = []
            for table in table_names:
                cursor.execute("SELECT column_name FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = %s ORDER BY ordinal_position", (table,))
                tables.append({"name": table, "columns": [row[0] for row in cursor.fetchall()]})
        elif name == DatabaseType.MSSQL.value:
            cursor.execute("SELECT TABLE_SCHEMA, TABLE_NAME FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_TYPE = 'BASE TABLE' ORDER BY TABLE_SCHEMA, TABLE_NAME")
            table_names = [(row[0], row[1]) for row in cursor.fetchall()]
            tables = []
            for schema, table in table_names:
                cursor.execute("SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? ORDER BY ORDINAL_POSITION", (schema, table))
                tables.append({"name": f"{schema}.{table}", "columns": [row[0] for row in cursor.fetchall()]})
        elif name == DatabaseType.FIREBIRD.value:
            cursor.execute("SELECT TRIM(RDB$RELATION_NAME) FROM RDB$RELATIONS WHERE RDB$VIEW_BLR IS NULL AND COALESCE(RDB$SYSTEM_FLAG, 0) = 0 ORDER BY RDB$RELATION_NAME")
            table_names = [row[0] for row in cursor.fetchall()]
            tables = []
            for table in table_names:
                cursor.execute("SELECT TRIM(RDB$FIELD_NAME) FROM RDB$RELATION_FIELDS WHERE RDB$RELATION_NAME = ? ORDER BY RDB$FIELD_POSITION", (table,))
                tables.append({"name": table, "columns": [row[0] for row in cursor.fetchall()]})
        else:
            cursor.execute("SELECT table_name FROM information_schema.tables WHERE table_schema = CURRENT_SCHEMA() ORDER BY table_name")
            table_names = [row[0] for row in cursor.fetchall()]
            tables = []
            for table in table_names:
                cursor.execute("SELECT column_name FROM information_schema.columns WHERE table_schema = CURRENT_SCHEMA() AND table_name = %s ORDER BY ordinal_position", (table,))
                tables.append({"name": table, "columns": [row[0] for row in cursor.fetchall()]})
        return {"success": True, "tables": tables}
    except Exception as exc:
        return {"success": False, "error": _redact_error(exc, params.get("password")), "tables": []}
    finally:
        if cursor:
            cursor.close()
        if conn:
            conn.close()


def apply_query_edits(query: str, edits: List[Dict[str, Any]], **params: Any) -> Dict[str, Any]:
    """Apply cell updates for a conservative single-table SELECT."""
    context = _single_select_context(query)
    if not context:
        return {"success": False, "error": "Only a simple SELECT with a WHERE key can be edited"}
    if not edits:
        return {"success": True, "updated": 0}
    table = context["table"]
    key_column = context["key"]
    selected_columns = context["selected_columns"]
    conn = None
    cursor = None
    try:
        conn = _get_connection(_db_name(params.get("db_type", "sqlite")), params)
        cursor = conn.cursor()
        name = _db_name(params.get("db_type", "sqlite"))
        if name == DatabaseType.FIREBIRD.value:
            return {"success": False, "error": "Result editing is not supported for this database type"}
        edit_context = _edit_context_for_query(query, [key_column], [{key_column: context["value"]}], **params)
        if not edit_context.get("editable"):
            raise ValueError(edit_context.get("reason") or "Result edit context is not safe")
        placeholder = "%s" if name in {DatabaseType.MYSQL.value, DatabaseType.POSTGRESQL.value} else "?"
        table_parts = table.split(".")
        if len(table_parts) > 2 or (name in {DatabaseType.SQLITE.value, DatabaseType.MSSQL.value} and len(table_parts) > 1) or (name == DatabaseType.POSTGRESQL.value and len(table_parts) == 1):
            raise ValueError("Qualified table names are not supported for result editing")
        table_name = table_parts[-1]
        schema_name = table_parts[0] if len(table_parts) == 2 else None
        selected_columns = set(edit_context.get("selected_columns", []))
        if selected_columns and any(edit["column"] not in selected_columns for edit in edits):
            raise ValueError("Edited columns must be present in the query results")
        if name == DatabaseType.MSSQL.value:
            safe_table = f"[{schema_name.replace(chr(93), chr(93) * 2)}].[{table_name.replace(chr(93), chr(93) * 2)}]" if schema_name else f"[{table_name.replace(chr(93), chr(93) * 2)}]"
            safe_key = f"[{key_column.replace(chr(93), chr(93) * 2)}]"
        elif name == DatabaseType.MYSQL.value:
            safe_table = f"`{schema_name.replace('`', '``')}`.`{table_name.replace('`', '``')}`" if schema_name else f"`{table_name.replace('`', '``')}`"
            safe_key = f"`{key_column.replace('`', '``')}`"
        else:
            safe_table = f'"{schema_name.replace(chr(34), chr(34) * 2)}"."{table_name.replace(chr(34), chr(34) * 2)}"' if schema_name else f'"{table_name.replace(chr(34), chr(34) * 2)}"'
            safe_key = f'"{key_column.replace(chr(34), chr(34) * 2)}"'

        if name == DatabaseType.SQLITE.value:
            cursor.execute(f'PRAGMA table_info("{table_name.replace(chr(34), chr(34) * 2)}")')
            metadata = cursor.fetchall()
            valid_columns = {row[1] for row in metadata}
            key_names = {row[1] for row in metadata if row[5]}
            cursor.execute("SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = ?", (table_name,))
            if cursor.fetchone()[0] != 1:
                raise ValueError("Query table could not be verified")
        else:
            table_count_query = f"SELECT COUNT(*) FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_NAME = {placeholder}"
            table_count_params = [table_name]
            if schema_name:
                table_count_query += f" AND TABLE_SCHEMA = {placeholder}"
                table_count_params.append(schema_name)
            elif name == DatabaseType.MYSQL.value:
                table_count_query += " AND TABLE_SCHEMA = DATABASE()"
            elif name == DatabaseType.POSTGRESQL.value:
                table_count_query += " AND TABLE_SCHEMA = CURRENT_SCHEMA()"
            cursor.execute(table_count_query, tuple(table_count_params))
            if cursor.fetchone()[0] != 1:
                raise ValueError("Query table could not be uniquely verified")

            column_query = f"SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME = {placeholder}"
            column_params = [table_name]
            key_query = f"SELECT KU.COLUMN_NAME FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS TC JOIN INFORMATION_SCHEMA.KEY_COLUMN_USAGE KU ON TC.CONSTRAINT_NAME = KU.CONSTRAINT_NAME AND TC.TABLE_SCHEMA = KU.TABLE_SCHEMA AND TC.TABLE_NAME = KU.TABLE_NAME WHERE TC.CONSTRAINT_TYPE = 'PRIMARY KEY' AND TC.TABLE_NAME = {placeholder}"
            key_params = [table_name]
            for query_text, query_params in ((column_query, column_params), (key_query, key_params)):
                if schema_name:
                    query_text += f" AND {'TABLE_SCHEMA' if query_text == column_query else 'TC.TABLE_SCHEMA'} = {placeholder}"
                    query_params.append(schema_name)
                elif name == DatabaseType.MYSQL.value:
                    query_text += " AND TABLE_SCHEMA = DATABASE()" if query_text == column_query else " AND TC.TABLE_SCHEMA = DATABASE()"
                elif name == DatabaseType.POSTGRESQL.value:
                    query_text += " AND TABLE_SCHEMA = CURRENT_SCHEMA()" if query_text == column_query else " AND TC.TABLE_SCHEMA = CURRENT_SCHEMA()"
                if query_text == column_query:
                    cursor.execute(query_text, tuple(query_params))
                    valid_columns = {row[0] for row in cursor.fetchall()}
                else:
                    cursor.execute(query_text, tuple(query_params))
                    key_names = {row[0] for row in cursor.fetchall()}

        if key_column not in valid_columns or key_column not in key_names:
            raise ValueError("Invalid key column")
        for edit in edits:
            column = str(edit.get("column", ""))
            if not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_$]*", column) or column == key_column or column not in valid_columns or (selected_columns and column not in selected_columns):
                raise ValueError("Invalid editable column")
            if edit.get("key_value") != context["value"]:
                raise ValueError("Result row no longer matches the query key")
            if name == DatabaseType.MSSQL.value:
                cursor.execute(f"SELECT COUNT(*) FROM {safe_table} WHERE {safe_key} = ?", (edit.get("key_value"),))
            else:
                cursor.execute(f"SELECT COUNT(*) FROM {safe_table} WHERE {safe_key} = {placeholder}", (edit.get("key_value"),))
            if cursor.fetchone()[0] != 1:
                raise ValueError("The edited row no longer matches a unique key")
            if name == DatabaseType.MSSQL.value:
                safe_column = f"[{column.replace(chr(93), chr(93) * 2)}]"
            elif name == DatabaseType.MYSQL.value:
                safe_column = f"`{column.replace('`', '``')}`"
            else:
                safe_column = f'"{column.replace(chr(34), chr(34) * 2)}"'
            cursor.execute(f"UPDATE {safe_table} SET {safe_column} = {placeholder} WHERE {safe_key} = {placeholder}", (edit.get("value"), edit.get("key_value")))
            if cursor.rowcount != 1:
                raise ValueError("The edited row could not be uniquely updated")
        conn.commit()
        return {"success": True, "updated": len(edits)}
    except Exception as exc:
        if conn:
            conn.rollback()
        return {"success": False, "error": _redact_error(exc, params.get("password"))}
    finally:
        if cursor:
            cursor.close()
        if conn:
            conn.close()


def validate_query(query: str, role: str = "viewer", db_type: Any = None, connection_params: Optional[Dict[str, Any]] = None) -> Tuple[bool, str, str, bool]:
    """Validate one complete SQL statement without restricting its command type.

    The role argument remains part of the public helper signature for callers
    written against the previous policy. This validator enforces only the
    request boundary; the selected database account remains the authority.
    """
    if not isinstance(query, str) or not query.strip():
        return False, "Query is required", "", False
    if len(query) > 200_000 or "\x00" in query:
        return False, "Query is too large or contains invalid characters", "", False

    balanced, balance_error = _balanced_sql(query)
    if not balanced:
        return False, balance_error, "", False

    visible = _visible_sql(query)
    semicolon_positions = [i for i, ch in enumerate(visible) if ch == ";"]
    if len(semicolon_positions) > 1:
        return False, "Multiple SQL statements are not allowed", "", False
    if semicolon_positions:
        tail = visible[semicolon_positions[0] + 1 :].strip()
        if tail:
            return False, "Multiple SQL statements are not allowed", "", False

    without_trailing = visible.strip().rstrip(";").strip()
    match = re.match(r"([A-Za-z]+)", without_trailing)
    if not match:
        return False, "A SQL statement is required", "", False
    first = match.group(1).upper()
    if first == "SELECT" and db_type is not None and _db_name(db_type) == DatabaseType.SQLITE.value:
        conn = None
        try:
            validation_params = connection_params or {}
            conn = _get_connection(db_type, validation_params)
            conn.execute(f"EXPLAIN {query.strip().rstrip(';')}")
        except Exception as exc:
            message = str(exc).splitlines()[0][:240]
            return False, f"SQL syntax error: {message}", "", False
        finally:
            if conn:
                conn.close()
        return True, "", query.strip(), first in {"SELECT", "WITH"}
    return True, "", query.strip(), first in {"SELECT", "WITH"}


def _redact_error(message: str, password: Optional[str]) -> str:
    text = str(message or "")
    if password:
        text = text.replace(password, "[redacted]")
    return text[:2000]


def test_connection(
    db_type: Any,
    host: Optional[str] = None,
    port: Optional[int] = None,
    database: Optional[str] = None,
    username: Optional[str] = None,
    password: Optional[str] = None,
    extra_params: Optional[Dict[str, Any]] = None,
) -> Dict[str, Any]:
    start_time = time.time()
    params = {
        "host": host,
        "port": port,
        "database": database,
        "username": username,
        "password": password,
        "extra_params": extra_params or {},
    }
    try:
        conn = _get_connection(db_type, params)
        conn.close()
        return {
            "success": True,
            "message": f"Connected to {_db_name(db_type)} successfully!",
            "latency_ms": int((time.time() - start_time) * 1000),
        }
    except Exception as exc:
        return {
            "success": False,
            "message": f"Connection failed: {_redact_error(exc, password)}",
        }


def execute_query(
    query: str,
    limit: int = 1000,
    db_type: Any = "postgresql",
    host: Optional[str] = None,
    port: Optional[int] = None,
    database: Optional[str] = None,
    username: Optional[str] = None,
    password: Optional[str] = None,
    extra_params: Optional[Dict[str, Any]] = None,
    role: str = "viewer",
) -> Dict[str, Any]:
    ok, validation_error, query_text, _ = validate_query(query, role, db_type, {"host": host, "port": port, "database": database, "username": username, "password": password, "extra_params": extra_params or {}})
    if not ok:
        return {"success": False, "error": validation_error, "data": [], "count": 0, "columns": []}

    try:
        safe_limit = max(1, min(int(limit or 1000), 10_000))
    except (TypeError, ValueError):
        safe_limit = 1000
    params = {
        "host": host,
        "port": port,
        "database": database,
        "username": username,
        "password": password,
        "extra_params": extra_params or {},
    }
    conn = None
    cursor = None
    start_time = time.time()
    name = _db_name(db_type)
    try:
        conn = _get_connection(name, params)
        cursor = conn.cursor()
        if name == DatabaseType.POSTGRESQL.value:
            # Applies to the current transaction only and prevents runaway
            # queries without changing the saved connection configuration.
            cursor.execute("SET LOCAL statement_timeout = %s", (30_000,))
        elif name == DatabaseType.SQLITE.value:
            cursor.execute("PRAGMA busy_timeout = 30000")
        # Any supported statement may return a result set (for example SHOW,
        # EXPLAIN, PRAGMA, CALL, or DML with RETURNING).  Let the driver tell us
        # whether rows are available instead of limiting results to SELECT/WITH.
        cursor.execute(query_text)

        if cursor.description:
            columns = [description[0] for description in cursor.description]
            raw_rows = cursor.fetchmany(safe_limit)
            results: List[Dict[str, Any]] = []
            for row in raw_rows:
                if isinstance(row, dict):
                    results.append({column: _serialize_value(row.get(column)) for column in columns})
                elif name == DatabaseType.SQLITE.value:
                    results.append({column: _serialize_value(row[column]) for column in columns})
                else:
                    results.append({column: _serialize_value(row[i]) for i, column in enumerate(columns)})
            if len(raw_rows) < safe_limit:
                try:
                    edit_context = _edit_context_for_query(query_text, columns, results, **params)
                except Exception:
                    edit_context = {"editable": False, "reason": "Editing is unavailable for this result"}
            else:
                edit_context = {"editable": False, "reason": "Truncated results cannot be edited"}
            conn.commit()
            return {
                "success": True,
                "data": results,
                "count": len(results),
                "columns": columns,
                "edit_context": edit_context,
                "execution_time_ms": int((time.time() - start_time) * 1000),
                "source": f"live_{name}",
                "truncated": len(results) >= safe_limit,
            }

        conn.commit()
        rowcount = cursor.rowcount if getattr(cursor, "rowcount", -1) >= 0 else 0
        return {
            "success": True,
            "data": [],
            "count": rowcount,
            "columns": [],
            "execution_time_ms": int((time.time() - start_time) * 1000),
            "source": f"live_{name}",
            "message": f"Query executed successfully. {rowcount} row(s) affected.",
        }
    except Exception as exc:
        if conn:
            try:
                conn.rollback()
            except Exception:
                pass
        return {
            "success": False,
            "error": f"Query execution failed: {_redact_error(exc, password)}",
            "data": [],
            "count": 0,
            "columns": [],
        }
    finally:
        if cursor:
            try:
                cursor.close()
            except Exception:
                pass
        if conn:
            try:
                conn.close()
            except Exception:
                pass
