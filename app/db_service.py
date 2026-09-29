"""Connections to supported customer databases and guarded SQL execution."""

from __future__ import annotations

import re
import threading
import time
from datetime import date, datetime
from decimal import Decimal
from enum import Enum
from typing import Any, Dict, List, Optional, Tuple, Union

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


# ---------------------------------------------------------------------------
# Query Execution Tracking and Cancellation
# ---------------------------------------------------------------------------

_ACTIVE_EXECUTIONS: Dict[str, Dict[str, Any]] = {}
_ACTIVE_EXECUTIONS_LOCK = threading.Lock()


def register_execution(execution_id: str, conn: Any, db_type: str) -> None:
    if not execution_id:
        return
    with _ACTIVE_EXECUTIONS_LOCK:
        _ACTIVE_EXECUTIONS[execution_id] = {
            "conn": conn,
            "db_type": db_type,
            "started_at": time.time(),
        }


def unregister_execution(execution_id: Optional[str]) -> None:
    if not execution_id:
        return
    with _ACTIVE_EXECUTIONS_LOCK:
        _ACTIVE_EXECUTIONS.pop(execution_id, None)


def cancel_query(execution_id: str) -> Dict[str, Any]:
    with _ACTIVE_EXECUTIONS_LOCK:
        info = _ACTIVE_EXECUTIONS.get(execution_id)
    if not info:
        return {"success": False, "error": "Query execution not found or already completed"}
    conn = info.get("conn")
    db_type = info.get("db_type")
    try:
        if db_type == DatabaseType.POSTGRESQL.value and hasattr(conn, "cancel"):
            conn.cancel()
        elif db_type == DatabaseType.SQLITE.value and hasattr(conn, "interrupt"):
            conn.interrupt()
        elif db_type == DatabaseType.MYSQL.value and hasattr(conn, "close"):
            conn.close()
        elif hasattr(conn, "close"):
            conn.close()
        return {"success": True, "message": "Query cancelled successfully"}
    except Exception as exc:
        return {"success": False, "error": f"Failed to cancel query: {str(exc)}"}



# ---------------------------------------------------------------------------
# Query Parameter Parsing and Substitution
# ---------------------------------------------------------------------------


# Module-level regex patterns for parameter parsing
# Matches single-quoted strings, double-quoted strings, block comments, and line comments
# to ensure parameter placeholders inside literals and comments are ignored.
SQL_TOKEN_PATTERN = re.compile(
    r"'(?:''|[^'])*'"                             # Single-quoted string
    r'|"(?:""|[^"])*"'                           # Double-quoted string
    r'|/\*[\s\S]*?\*/'                            # Block comment
    r'|--[^\r\n]*'                                # Line comment
    r'|(?P<pg>\$(\d+))'                           # $1, $2 - PostgreSQL positional
    r'|(?P<pyformat>%\(([a-zA-Z_][a-zA-Z0-9_]*)\)s)' # %(name)s - Python format
    r'|(?<!:)(?P<named>:([a-zA-Z_][a-zA-Z0-9_]*))(?!:)' # :name - named params (excluding :: casts)
    r'|(?P<at>@([a-zA-Z_][a-zA-Z0-9_]*))'        # @name - SQL Server
    r'|(?P<num_qmark>\?(\d+))'                   # ?1, ?2 - numbered question marks
    r'|(?P<qmark>\?)'                            # ? - simple positional
)


def _detect_parameter_style(db_type: str) -> str:
    """Return the native driver parameter style ('format' for %s or 'qmark' for ?)."""
    name = _db_name(db_type)
    if name in {DatabaseType.POSTGRESQL.value, DatabaseType.MYSQL.value, "mariadb"}:
        return "format"  # psycopg2 and pymysql use %s
    return "qmark"  # sqlite3, pyodbc, and fdb use ?


def parse_query_parameters(query: str) -> List[Dict[str, Any]]:
    """
    Parse bind parameters from a SQL query.

    Supports multiple parameter styles:
    - PostgreSQL: $1, $2, ...
    - MySQL/SQLite: ? or ?1, ?2 (numbered)
    - SQL Server: @name or @p1
    - Oracle/Generic: :name
    - Named: %(name)s or :name

    Returns a list of parameter info dicts with keys:
    - name: parameter name
    - display_name: full placeholder representation
    - style: parameter style detected
    - positions: character positions in query
    - occurrences: number of occurrences in query
    - is_positional: boolean
    """
    all_matches = []

    for match in SQL_TOKEN_PATTERN.finditer(query):
        if match.group('pg'):
            all_matches.append({
                'name': f"${match.group(2)}",
                'raw_name': match.group(2),
                'style': 'postgresql',
                'start': match.start('pg'),
                'end': match.end('pg')
            })
        elif match.group('pyformat'):
            raw = match.group('pyformat').strip('%()s')
            all_matches.append({
                'name': match.group('pyformat'),
                'raw_name': raw,
                'style': 'pyformat',
                'start': match.start('pyformat'),
                'end': match.end('pyformat')
            })
        elif match.group('named'):
            raw = match.group('named')[1:]
            all_matches.append({
                'name': match.group('named'),
                'raw_name': raw,
                'style': 'named',
                'start': match.start('named'),
                'end': match.end('named')
            })
        elif match.group('at'):
            raw = match.group('at')[1:]
            all_matches.append({
                'name': match.group('at'),
                'raw_name': raw,
                'style': 'at',
                'start': match.start('at'),
                'end': match.end('at')
            })
        elif match.group('num_qmark'):
            raw = match.group('num_qmark')[1:]
            all_matches.append({
                'name': match.group('num_qmark'),
                'raw_name': raw,
                'style': 'numbered_qmark',
                'start': match.start('num_qmark'),
                'end': match.end('num_qmark')
            })
        elif match.group('qmark'):
            all_matches.append({
                'name': '?',
                'raw_name': None,
                'style': 'qmark',
                'start': match.start('qmark'),
                'end': match.end('qmark')
            })

    # Group by parameter identity and deduplicate
    param_groups = {}

    for match in all_matches:
        key = match['name']
        if key not in param_groups:
            param_groups[key] = {
                'name': match['raw_name'] or match['name'],
                'style': match['style'],
                'display_name': match['name'],
                'positions': [],
                'occurrences': 0,
                'is_positional': match['style'] in ('qmark', 'postgresql', 'numbered_qmark')
            }
        param_groups[key]['positions'].append(match['start'])
        param_groups[key]['occurrences'] += 1

    params = []
    for key, info in param_groups.items():
        params.append({
            'name': info['name'],
            'display_name': info['display_name'],
            'style': info['style'],
            'positions': info['positions'],
            'occurrences': info['occurrences'],
            'is_positional': info['is_positional']
        })

    # Sort positional params by their position number
    params.sort(key=lambda p: (
        0 if p['is_positional'] else 1,
        p['positions'][0] if p['positions'] else 999
    ))

    return params


def substitute_parameters(query: str, params: Union[Dict[str, Any], List[Any]], db_type: str) -> Tuple[str, List[Any]]:
    """
    Substitute named/positional parameters in a query with database-specific placeholders.

    Returns a tuple of (modified_query, parameter_values_list) where parameter_values_list
    is ordered correctly for the database driver.
    """
    param_style = _detect_parameter_style(db_type)
    placeholder = "%s" if param_style == "format" else "?"
    param_values: List[Any] = []

    # Normalize input params to dict
    if isinstance(params, list):
        param_dict = {str(i + 1): v for i, v in enumerate(params)}
    elif isinstance(params, dict):
        param_dict = params
    else:
        param_dict = {}

    pos_counter = 0

    def replace_match(match: re.Match) -> str:
        nonlocal pos_counter
        if match.group('pg'):
            num = match.group('pg')[1:]
            val = param_dict.get(num, param_dict.get('$' + num, param_dict.get(int(num) if num.isdigit() else None)))
            param_values.append(val)
            return placeholder
        if match.group('pyformat'):
            raw = match.group('pyformat').strip('%()s')
            val = param_dict.get(raw)
            param_values.append(val)
            return placeholder
        if match.group('named'):
            raw = match.group('named')[1:]
            val = param_dict.get(raw, param_dict.get(':' + raw))
            param_values.append(val)
            return placeholder
        if match.group('at'):
            raw = match.group('at')[1:]
            val = param_dict.get(raw, param_dict.get('@' + raw))
            param_values.append(val)
            return placeholder
        if match.group('num_qmark'):
            num = match.group('num_qmark')[1:]
            val = param_dict.get(num, param_dict.get('?' + num, param_dict.get(int(num) if num.isdigit() else None)))
            param_values.append(val)
            return placeholder
        if match.group('qmark'):
            pos_counter += 1
            val = param_dict.get(str(pos_counter), param_dict.get(pos_counter))
            param_values.append(val)
            return placeholder
        return match.group(0)

    # Single pass substitution
    query = SQL_TOKEN_PATTERN.sub(replace_match, query)

    return query, param_values


def validate_query_parameters(query: str, params: Dict[str, Any], db_type: str) -> Tuple[bool, str]:
    """
    Validate that all required parameters are provided.

    Returns (is_valid, error_message)
    """
    detected = parse_query_parameters(query)
    missing = []

    if isinstance(params, list):
        param_dict = {str(i + 1): v for i, v in enumerate(params)}
    elif isinstance(params, dict):
        param_dict = params
    else:
        param_dict = {}

    # Count simple ? placeholders
    simple_qmark_count = 0
    for param in detected:
        if param['style'] == 'qmark' and param['name'] == '?':
            simple_qmark_count = param['occurrences']
        else:
            name = param['name']
            # Check if parameter value is provided
            if name not in param_dict and param['name'].lstrip('$@:?').isdigit():
                # Try positional
                if param['name'].lstrip('$@:?') not in param_dict:
                    missing.append(param['display_name'])
            elif name not in param_dict:
                missing.append(param['display_name'])

    # Handle simple ? placeholders - need positional params
    if simple_qmark_count > 0:
        # Count how many positional params (1, 2, 3...) are provided
        provided_positional = sum(1 for k in param_dict.keys() if k.isdigit())
        if provided_positional < simple_qmark_count:
            missing.append(f"{simple_qmark_count} positional parameter(s) (?)")

    if missing:
        return False, f"Missing required parameters: {', '.join(missing)}"

    return True, ""


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
    """Return table and column names for editor suggestions with rich metadata."""
    conn = None
    cursor = None
    name = _db_name(params.get("db_type", "sqlite"))
    try:
        conn = _get_connection(name, params)
        cursor = conn.cursor()
        tables = []

        if name == DatabaseType.SQLITE.value:
            cursor.execute("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
            table_names = [row[0] for row in cursor.fetchall()]
            for table in table_names:
                cursor.execute(f'PRAGMA table_info("{str(table).replace(chr(34), chr(34) * 2)}")')
                columns = []
                for row in cursor.fetchall():
                    # row: cid, name, type, notnull, dflt_value, pk
                    columns.append({
                        "name": row[1],
                        "type": row[2],
                        "not_null": bool(row[3]),
                        "default": row[4],
                        "is_primary_key": bool(row[5])
                    })
                # Get foreign keys
                cursor.execute(f'PRAGMA foreign_key_list("{str(table).replace(chr(34), chr(34) * 2)}")')
                foreign_keys = []
                for row in cursor.fetchall():
                    # row: id, seq, table, from, to, on_update, on_delete, match
                    foreign_keys.append({
                        "column": row[3],
                        "ref_table": row[2],
                        "ref_column": row[4]
                    })
                tables.append({"name": table, "columns": columns, "foreign_keys": foreign_keys})

        elif name == DatabaseType.MYSQL.value:
            cursor.execute("SELECT table_name FROM information_schema.tables WHERE table_schema = DATABASE() ORDER BY table_name")
            table_names = [row[0] for row in cursor.fetchall()]
            for table in table_names:
                cursor.execute("""
                    SELECT column_name, data_type, is_nullable, column_default, column_key, extra
                    FROM information_schema.columns
                    WHERE table_schema = DATABASE() AND table_name = %s
                    ORDER BY ordinal_position
                """, (table,))
                columns = []
                for row in cursor.fetchall():
                    columns.append({
                        "name": row[0],
                        "type": row[1],
                        "not_null": row[2] == "NO",
                        "default": row[3],
                        "is_primary_key": row[4] == "PRI",
                        "is_auto_increment": "auto_increment" in str(row[5]).lower()
                    })
                # Get foreign keys
                cursor.execute("""
                    SELECT column_name, referenced_table_name, referenced_column_name
                    FROM information_schema.key_column_usage
                    WHERE table_schema = DATABASE() AND table_name = %s AND referenced_table_name IS NOT NULL
                """, (table,))
                foreign_keys = []
                for row in cursor.fetchall():
                    foreign_keys.append({
                        "column": row[0],
                        "ref_table": row[1],
                        "ref_column": row[2]
                    })
                tables.append({"name": table, "columns": columns, "foreign_keys": foreign_keys})

        elif name == DatabaseType.MSSQL.value:
            cursor.execute("SELECT TABLE_SCHEMA, TABLE_NAME FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_TYPE = 'BASE TABLE' ORDER BY TABLE_SCHEMA, TABLE_NAME")
            table_names = [(row[0], row[1]) for row in cursor.fetchall()]
            for schema, table in table_names:
                cursor.execute("""
                    SELECT COLUMN_NAME, DATA_TYPE, IS_NULLABLE, COLUMN_DEFAULT,
                           CASE WHEN COLUMNPROPERTY(OBJECT_ID(TABLE_SCHEMA + '.' + TABLE_NAME), COLUMN_NAME, 'IsIdentity') = 1 THEN 1 ELSE 0 END as is_identity
                    FROM INFORMATION_SCHEMA.COLUMNS
                    WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?
                    ORDER BY ORDINAL_POSITION
                """, (schema, table))
                columns = []
                for row in cursor.fetchall():
                    columns.append({
                        "name": row[0],
                        "type": row[1],
                        "not_null": row[2] == "NO",
                        "default": row[3],
                        "is_primary_key": False,  # Will be set below
                        "is_auto_increment": bool(row[4])
                    })
                # Get primary keys
                cursor.execute("""
                    SELECT KU.COLUMN_NAME
                    FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS TC
                    JOIN INFORMATION_SCHEMA.KEY_COLUMN_USAGE KU ON TC.CONSTRAINT_NAME = KU.CONSTRAINT_NAME AND TC.TABLE_SCHEMA = KU.TABLE_SCHEMA AND TC.TABLE_NAME = KU.TABLE_NAME
                    WHERE TC.CONSTRAINT_TYPE = 'PRIMARY KEY' AND TC.TABLE_SCHEMA = ? AND TC.TABLE_NAME = ?
                """, (schema, table))
                pk_columns = {row[0] for row in cursor.fetchall()}
                for col in columns:
                    col["is_primary_key"] = col["name"] in pk_columns

                # Get foreign keys
                cursor.execute("""
                    SELECT KU.COLUMN_NAME, C.REFERENCED_TABLE_NAME, KU.REFERENCED_COLUMN_NAME
                    FROM INFORMATION_SCHEMA.REFERENTIAL_CONSTRAINTS RC
                    JOIN INFORMATION_SCHEMA.KEY_COLUMN_USAGE KU ON RC.CONSTRAINT_NAME = KU.CONSTRAINT_NAME AND RC.TABLE_SCHEMA = KU.TABLE_SCHEMA
                    JOIN INFORMATION_SCHEMA.CONSTRAINT_COLUMN_USAGE C ON RC.UNIQUE_CONSTRAINT_NAME = C.CONSTRAINT_NAME AND RC.TABLE_SCHEMA = C.TABLE_SCHEMA
                    WHERE KU.TABLE_SCHEMA = ? AND KU.TABLE_NAME = ?
                """, (schema, table))
                foreign_keys = []
                for row in cursor.fetchall():
                    foreign_keys.append({
                        "column": row[0],
                        "ref_table": row[1],
                        "ref_column": row[2]
                    })
                tables.append({"name": f"{schema}.{table}", "columns": columns, "foreign_keys": foreign_keys})

        elif name == DatabaseType.FIREBIRD.value:
            cursor.execute("SELECT TRIM(RDB$RELATION_NAME) FROM RDB$RELATIONS WHERE RDB$VIEW_BLR IS NULL AND COALESCE(RDB$SYSTEM_FLAG, 0) = 0 ORDER BY RDB$RELATION_NAME")
            table_names = [row[0] for row in cursor.fetchall()]

            # Pre-fetch all field types in a single query to avoid N+1
            cursor.execute("SELECT TRIM(RDB$FIELD_NAME), TRIM(RDB$FIELD_TYPE), RDB$FIELD_LENGTH, RDB$FIELD_SCALE FROM RDB$FIELDS")
            field_types = {}
            type_map = {7: "SMALLINT", 8: "INTEGER", 10: "FLOAT", 12: "DATE", 13: "TIME", 14: "CHAR", 16: "BIGINT", 27: "DOUBLE PRECISION", 35: "TIMESTAMP", 37: "VARCHAR", 261: "BLOB"}
            for row in cursor.fetchall():
                field_name = row[0]
                field_type_row = row[1:]
                if field_type_row:
                    type_str = type_map.get(field_type_row[0], str(field_type_row[0]))
                else:
                    type_str = "unknown"
                field_types[field_name] = type_str

            for table in table_names:
                cursor.execute("""
                    SELECT TRIM(RDB$FIELD_NAME), TRIM(RDB$FIELD_SOURCE)
                    FROM RDB$RELATION_FIELDS
                    WHERE RDB$RELATION_NAME = ? ORDER BY RDB$FIELD_POSITION
                """, (table,))
                columns = []
                for row in cursor.fetchall():
                    field_name = row[0]
                    field_source = row[1]
                    # Get field type from pre-fetched map
                    type_str = field_types.get(field_source, "unknown")
                    columns.append({
                        "name": field_name,
                        "type": type_str,
                        "not_null": False,  # Would need more complex query
                        "default": None,
                        "is_primary_key": False
                    })
                tables.append({"name": table, "columns": columns, "foreign_keys": []})

        else:  # PostgreSQL
            cursor.execute("SELECT table_name FROM information_schema.tables WHERE table_schema = CURRENT_SCHEMA() ORDER BY table_name")
            table_names = [row[0] for row in cursor.fetchall()]
            for table in table_names:
                cursor.execute("""
                    SELECT column_name, data_type, is_nullable, column_default,
                           CASE WHEN pk.column_name IS NOT NULL THEN TRUE ELSE FALSE END as is_primary_key
                    FROM information_schema.columns c
                    LEFT JOIN (
                        SELECT kcu.column_name
                        FROM information_schema.table_constraints tc
                        JOIN information_schema.key_column_usage kcu ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema
                        WHERE tc.constraint_type = 'PRIMARY KEY' AND tc.table_schema = CURRENT_SCHEMA() AND tc.table_name = %s
                    ) pk ON c.column_name = pk.column_name
                    WHERE c.table_schema = CURRENT_SCHEMA() AND c.table_name = %s
                    ORDER BY c.ordinal_position
                """, (table, table))
                columns = []
                for row in cursor.fetchall():
                    columns.append({
                        "name": row[0],
                        "type": row[1],
                        "not_null": row[2] == "NO",
                        "default": row[3],
                        "is_primary_key": row[4]
                    })
                # Get foreign keys
                cursor.execute("""
                    SELECT kcu.column_name, ccu.table_name as ref_table, ccu.column_name as ref_column
                    FROM information_schema.table_constraints tc
                    JOIN information_schema.key_column_usage kcu ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema
                    JOIN information_schema.constraint_column_usage ccu ON tc.constraint_name = ccu.constraint_name AND tc.table_schema = ccu.table_schema
                    WHERE tc.constraint_type = 'FOREIGN KEY' AND tc.table_schema = CURRENT_SCHEMA() AND tc.table_name = %s
                """, (table,))
                foreign_keys = []
                for row in cursor.fetchall():
                    foreign_keys.append({
                        "column": row[0],
                        "ref_table": row[1],
                        "ref_column": row[2]
                    })
                tables.append({"name": table, "columns": columns, "foreign_keys": foreign_keys})

        return {"success": True, "tables": tables}
    except Exception as exc:
        return {"success": False, "error": _redact_error(exc, params.get("password")), "tables": []}
    finally:
        if cursor:
            cursor.close()
        if conn:
            conn.close()


def generate_table_ddl(table_name: str, **params: Any) -> Dict[str, Any]:
    """Generate CREATE TABLE DDL for a specified table using its metadata."""
    name = _db_name(params.get("db_type", "sqlite"))
    if name == DatabaseType.SQLITE.value:
        conn = None
        cursor = None
        try:
            conn = _get_connection(name, params)
            cursor = conn.cursor()
            cursor.execute(
                "SELECT sql FROM sqlite_master WHERE type = 'table' AND LOWER(name) = LOWER(?)",
                (table_name,)
            )
            row = cursor.fetchone()
            if row and row[0]:
                return {"success": True, "table": table_name, "ddl": f"{row[0]};"}
        except Exception:
            pass
        finally:
            if cursor:
                cursor.close()
            if conn:
                conn.close()

    metadata = get_schema_metadata(**params)
    tables = metadata.get("tables", [])
    table_info = next((t for t in tables if str(t["name"]).lower() == table_name.lower()), None)
    if not table_info:
        return {"success": False, "error": f"Table '{table_name}' not found", "ddl": ""}

    lines = []
    pks = []
    for col in table_info.get("columns", []):
        c_name = col["name"]
        c_type = col.get("type", "TEXT") or "TEXT"
        col_str = f'    "{c_name}" {c_type}'
        if col.get("not_null"):
            col_str += " NOT NULL"
        if col.get("default") is not None:
            col_str += f" DEFAULT {col['default']}"
        if col.get("is_primary_key"):
            pks.append(f'"{c_name}"')
        lines.append(col_str)

    if pks:
        lines.append(f"    PRIMARY KEY ({', '.join(pks)})")

    for fk in table_info.get("foreign_keys", []):
        col = fk.get("column")
        ref_t = fk.get("ref_table")
        ref_c = fk.get("ref_column")
        if col and ref_t and ref_c:
            lines.append(f'    FOREIGN KEY ("{col}") REFERENCES "{ref_t}" ("{ref_c}")')

    body = ",\n".join(lines)
    ddl = f'CREATE TABLE "{table_info["name"]}" (\n{body}\n);'
    return {"success": True, "table": table_info["name"], "ddl": ddl}


def get_schema_diff(conn_a_params: Dict[str, Any], conn_b_params: Dict[str, Any]) -> Dict[str, Any]:
    """Compare schemas between two database connections and produce a detailed diff."""
    meta_a = get_schema_metadata(**conn_a_params)
    meta_b = get_schema_metadata(**conn_b_params)

    tables_a = {str(t["name"]).lower(): t for t in meta_a.get("tables", [])}
    tables_b = {str(t["name"]).lower(): t for t in meta_b.get("tables", [])}

    all_table_keys = sorted(set(tables_a.keys()) | set(tables_b.keys()))

    diff = {
        "success": True,
        "tables_only_in_a": [],
        "tables_only_in_b": [],
        "common_tables": [],
        "has_differences": False,
    }

    for t_key in all_table_keys:
        t_a = tables_a.get(t_key)
        t_b = tables_b.get(t_key)

        if t_a and not t_b:
            diff["tables_only_in_a"].append(t_a["name"])
            diff["has_differences"] = True
        elif t_b and not t_a:
            diff["tables_only_in_b"].append(t_b["name"])
            diff["has_differences"] = True
        else:
            cols_a = {str(c["name"]).lower(): c for c in t_a.get("columns", [])}
            cols_b = {str(c["name"]).lower(): c for c in t_b.get("columns", [])}
            all_col_keys = sorted(set(cols_a.keys()) | set(cols_b.keys()))

            table_diff = {
                "name": t_a["name"],
                "columns_only_in_a": [],
                "columns_only_in_b": [],
                "type_mismatches": [],
                "has_differences": False,
            }

            for c_key in all_col_keys:
                c_a = cols_a.get(c_key)
                c_b = cols_b.get(c_key)

                if c_a and not c_b:
                    table_diff["columns_only_in_a"].append({"name": c_a["name"], "type": c_a.get("type", "")})
                    table_diff["has_differences"] = True
                elif c_b and not c_a:
                    table_diff["columns_only_in_b"].append({"name": c_b["name"], "type": c_b.get("type", "")})
                    table_diff["has_differences"] = True
                else:
                    type_a = str(c_a.get("type", "")).upper().split("(")[0]
                    type_b = str(c_b.get("type", "")).upper().split("(")[0]
                    if type_a != type_b:
                        table_diff["type_mismatches"].append({
                            "column": c_a["name"],
                            "type_a": c_a.get("type", ""),
                            "type_b": c_b.get("type", ""),
                        })
                        table_diff["has_differences"] = True

            if table_diff["has_differences"]:
                diff["has_differences"] = True
            diff["common_tables"].append(table_diff)

    return diff


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

    # Strict read-only enforcement
    is_strict_read_only = bool(
        connection_params
        and isinstance(connection_params.get("extra_params"), dict)
        and connection_params["extra_params"].get("strict_read_only")
    )
    if is_strict_read_only:
        allowed_commands = {"SELECT", "EXPLAIN", "SHOW", "DESCRIBE", "DESC", "PRAGMA", "WITH"}
        if first not in allowed_commands:
            return False, f"Connection is configured as Strict Read-Only. Only read queries (SELECT, EXPLAIN) are permitted (attempted {first}).", "", False
        if first == "WITH" and re.search(r"\b(INSERT|UPDATE|DELETE|DROP|ALTER|TRUNCATE)\b", without_trailing, re.IGNORECASE):
            return False, "Connection is configured as Strict Read-Only. Mutating statements in CTEs are not permitted.", "", False

    # Skip EXPLAIN validation for queries that appear to have parameter placeholders
    # as they would fail without bound parameters
    has_params = bool(parse_query_parameters(query))

    if first == "SELECT" and db_type is not None and _db_name(db_type) == DatabaseType.SQLITE.value and not has_params:
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
    parameters: Optional[Dict[str, Any]] = None,
    execution_id: Optional[str] = None,
    force_commit: bool = False,
) -> Dict[str, Any]:
    # Validate query first (without parameters)
    ok, validation_error, query_text, _ = validate_query(query, role, db_type, {"host": host, "port": port, "database": database, "username": username, "password": password, "extra_params": extra_params or {}})
    if not ok:
        return {"success": False, "error": validation_error, "data": [], "count": 0, "columns": []}

    # Validate and substitute parameters
    if parameters:
        param_valid, param_error = validate_query_parameters(query, parameters, _db_name(db_type))
        if not param_valid:
            return {"success": False, "error": param_error, "data": [], "count": 0, "columns": []}
        query_text, param_values = substitute_parameters(query_text, parameters, _db_name(db_type))
    else:
        param_values = []

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
        if execution_id:
            register_execution(execution_id, conn, name)
        cursor = conn.cursor()
        if name == DatabaseType.POSTGRESQL.value:
            # Applies to the current transaction only and prevents runaway
            # queries without changing the saved connection configuration.
            cursor.execute("SET LOCAL statement_timeout = %s", (30_000,))
            if extra_params and extra_params.get("strict_read_only"):
                try:
                    cursor.execute("SET TRANSACTION READ ONLY;")
                except Exception:
                    pass
        elif name == DatabaseType.SQLITE.value:
            cursor.execute("PRAGMA busy_timeout = 30000")
        # Any supported statement may return a result set (for example SHOW,
        # EXPLAIN, PRAGMA, CALL, or DML with RETURNING).  Let the driver tell us
        # whether rows are available instead of limiting results to SELECT/WITH.
        if param_values:
            cursor.execute(query_text, param_values)
        else:
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
            
            # Data Masking (Tier 3 Enhancement)
            sensitive_keywords = ["email", "password", "ssn", "credit_card", "secret", "token", "hash"]
            masked_columns = [col for col in columns if any(kw in col.lower() for kw in sensitive_keywords)]
            
            if masked_columns:
                for row_dict in results:
                    for col in masked_columns:
                        val = row_dict[col]
                        if val is not None and str(val).strip() != "":
                            sval = str(val)
                            # Mask logic
                            if "@" in sval:
                                parts = sval.split("@")
                                row_dict[col] = parts[0][:2] + "***@" + parts[1]
                            elif len(sval) > 4:
                                row_dict[col] = "***-" + sval[-4:]
                            else:
                                row_dict[col] = "***"

            if len(raw_rows) < safe_limit:
                if masked_columns:
                    edit_context = {"editable": False, "reason": "Editing disabled: Results contain masked sensitive data"}
                else:
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
        if execution_id:
            unregister_execution(execution_id)
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
