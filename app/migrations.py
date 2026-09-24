"""Idempotent, dialect-aware metadata migrations for Query Execute.

The application started with a small SQLite schema that stored a single
``connection_group`` string.  This module deliberately uses schema
introspection in addition to ``CREATE TABLE IF NOT EXISTS`` so an existing
SQLite or PostgreSQL installation can be upgraded without dropping data.

Data that needs an application user (legacy group ownership and history
ownership) is normalized by :func:`app.main._normalize_legacy_data` after the
bootstrap administrator has been created.  The schema work itself is safe to
run repeatedly and is tracked in ``schema_migrations``.
"""

from __future__ import annotations

import json
from typing import Any, Iterable


# Kept as a small callable alias for callers/tests that need to exercise the
# placeholder conversion without importing the application module.
def _execute(cur: Any, postgres: bool, sql: str, params: tuple[Any, ...] = ()) -> None:
    cur.execute(sql if postgres else sql.replace("%s", "?"), params)


def _table_exists(cur: Any, postgres: bool, table: str) -> bool:
    if postgres:
        cur.execute(
            "SELECT 1 FROM information_schema.tables "
            "WHERE table_schema = 'public' AND table_name = %s",
            (table,),
        )
    else:
        cur.execute(
            "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?",
            (table,),
        )
    return cur.fetchone() is not None


def _columns(cur: Any, postgres: bool, table: str) -> set[str]:
    if postgres:
        cur.execute(
            "SELECT column_name FROM information_schema.columns "
            "WHERE table_schema = 'public' AND table_name = %s",
            (table,),
        )
        return {str(row[0]) for row in cur.fetchall()}
    # All table names passed by this module are static identifiers.  Quoting
    # still protects compatibility with a SQLite database created by a user.
    cur.execute(f'PRAGMA table_info("{table.replace(chr(34), chr(34) * 2)}")')
    return {str(row[1]) for row in cur.fetchall()}


def _add_column(cur: Any, postgres: bool, table: str, column: str, definition: str) -> None:
    """Add one column only when it is absent.

    ``ALTER TABLE ... ADD COLUMN`` is intentionally performed after checking
    metadata.  This is more reliable than dialect-specific ``IF NOT EXISTS``
    syntax and works on older PostgreSQL and SQLite versions too.
    """
    if column not in _columns(cur, postgres, table):
        cur.execute(
            f'ALTER TABLE "{table}" ADD COLUMN "{column}" {definition}'
        )


def _ensure_table(cur: Any, postgres: bool, table: str, create_sql: str, columns: Iterable[tuple[str, str]]) -> None:
    if not _table_exists(cur, postgres, table):
        cur.execute(create_sql)
        return
    for column, definition in columns:
        _add_column(cur, postgres, table, column, definition)


def _create_tables(cur: Any, postgres: bool) -> None:
    id_type = "BIGSERIAL PRIMARY KEY" if postgres else "INTEGER PRIMARY KEY AUTOINCREMENT"
    bool_type = "BOOLEAN" if postgres else "INTEGER"
    json_type = "JSONB" if postgres else "TEXT"
    default_bool = "BOOLEAN NOT NULL DEFAULT FALSE" if postgres else "INTEGER NOT NULL DEFAULT 0"
    true_default = "TRUE" if postgres else "1"

    # The migration ledger is created first.  Every later operation is
    # introspected, so a partially completed process can safely resume.
    cur.execute(
        f'''CREATE TABLE IF NOT EXISTS schema_migrations (
            version VARCHAR(100) PRIMARY KEY,
            applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )'''
    )

    _ensure_table(
        cur,
        postgres,
        "users",
        f'''CREATE TABLE users (
            id {id_type},
            username VARCHAR(150) NOT NULL,
            password_hash TEXT NOT NULL,
            role VARCHAR(20) NOT NULL DEFAULT 'viewer',
            is_active {bool_type} NOT NULL DEFAULT {true_default},
            totp_secret TEXT,
            totp_enabled {default_bool},
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )''',
        (
            ("username", "VARCHAR(150)"),
            ("password_hash", "TEXT"),
            ("role", "VARCHAR(20) DEFAULT 'viewer'"),
            ("is_active", f"{bool_type} DEFAULT {true_default}"),
            ("created_at", "TIMESTAMP"),
            ("totp_secret", "TEXT"),
            ("totp_enabled", default_bool),
        ),
    )
    _ensure_table(
        cur,
        postgres,
        "groups",
        f'''CREATE TABLE "groups" (
            id {id_type},
            name VARCHAR(150) NOT NULL UNIQUE,
            created_by BIGINT,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )''',
        (
            ("name", "VARCHAR(150)"),
            ("created_by", "BIGINT"),
            ("created_at", "TIMESTAMP"),
        ),
    )
    _ensure_table(
        cur,
        postgres,
        "user_groups",
        f'''CREATE TABLE user_groups (
            user_id BIGINT NOT NULL,
            group_id BIGINT NOT NULL,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            PRIMARY KEY (user_id, group_id)
        )''',
        (("user_id", "BIGINT"), ("group_id", "BIGINT"), ("created_at", "TIMESTAMP")),
    )
    _ensure_table(
        cur,
        postgres,
        "connection_groups",
        f'''CREATE TABLE connection_groups (
            connection_id VARCHAR(50) NOT NULL,
            group_id BIGINT NOT NULL,
            PRIMARY KEY (connection_id, group_id)
        )''',
        (("connection_id", "VARCHAR(50)"), ("group_id", "BIGINT")),
    )
    _ensure_table(
        cur,
        postgres,
        "sessions",
        f'''CREATE TABLE sessions (
            id {id_type},
            token_hash VARCHAR(128) NOT NULL UNIQUE,
            user_id BIGINT NOT NULL,
            csrf_token_hash VARCHAR(128) NOT NULL,
            expires_at TIMESTAMP NOT NULL,
            revoked_at TIMESTAMP,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )''',
        (
            ("token_hash", "VARCHAR(128)"),
            ("user_id", "BIGINT"),
            ("csrf_token_hash", "VARCHAR(128)"),
            ("expires_at", "TIMESTAMP"),
            ("revoked_at", "TIMESTAMP"),
            ("created_at", "TIMESTAMP"),
        ),
    )

    if not _table_exists(cur, postgres, "connections"):
        cur.execute(
            f'''CREATE TABLE connections (
                id VARCHAR(50) PRIMARY KEY,
                name VARCHAR(100) NOT NULL,
                db_type VARCHAR(20) NOT NULL,
                host VARCHAR(255),
                port INTEGER,
                database VARCHAR(255),
                username VARCHAR(100),
                password TEXT,
                password_encrypted TEXT,
                extra_params {json_type} DEFAULT {"'{}'::jsonb" if postgres else "'{}'"},
                owner_id BIGINT,
                connection_group VARCHAR(150)
            )'''
        )
    else:
        # The original application had all of these fields except the
        # encrypted password, owner, and normalized-group compatibility field.
        # Definitions added to old rows are nullable/defaulted to avoid a table
        # rewrite failure on either supported dialect.
        for column, definition in (
            ("name", "VARCHAR(100)"),
            ("db_type", "VARCHAR(20)"),
            ("host", "VARCHAR(255)"),
            ("port", "INTEGER"),
            ("database", "VARCHAR(255)"),
            ("username", "VARCHAR(100)"),
            ("password", "TEXT"),
            ("password_encrypted", "TEXT"),
            ("extra_params", json_type + " DEFAULT '{}'"),
            ("owner_id", "BIGINT"),
            ("connection_group", "VARCHAR(150)"),
        ):
            _add_column(cur, postgres, "connections", column, definition)

    if not _table_exists(cur, postgres, "query_history"):
        cur.execute(
            f'''CREATE TABLE query_history (
                id {id_type},
                connection_id VARCHAR(50),
                user_id BIGINT,
                query TEXT NOT NULL,
                executed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                success {bool_type},
                row_count INTEGER,
                execution_time_ms INTEGER,
                error_message TEXT
            )'''
        )
    else:
        for column, definition in (
            ("connection_id", "VARCHAR(50)"),
            ("user_id", "BIGINT"),
            ("query", "TEXT"),
            ("executed_at", "TIMESTAMP"),
            ("success", bool_type),
            ("row_count", "INTEGER"),
            ("execution_time_ms", "INTEGER"),
            ("error_message", "TEXT"),
        ):
            _add_column(cur, postgres, "query_history", column, definition)


def _create_index(cur: Any, sql: str) -> None:
    # All index statements are static and already contain IF NOT EXISTS.  A
    # separate helper keeps the migration flow readable and testable.
    cur.execute(sql)


def _indexes(cur: Any, postgres: bool) -> None:
    statements = [
        'CREATE INDEX IF NOT EXISTS user_groups_user_idx ON user_groups (user_id)',
        'CREATE INDEX IF NOT EXISTS user_groups_group_idx ON user_groups (group_id)',
        'CREATE INDEX IF NOT EXISTS connection_groups_group_idx ON connection_groups (group_id)',
        'CREATE INDEX IF NOT EXISTS connections_owner_idx ON connections (owner_id)',
        'CREATE INDEX IF NOT EXISTS history_user_executed_idx ON query_history (user_id, executed_at)',
        'CREATE INDEX IF NOT EXISTS sessions_user_idx ON sessions (user_id)',
        'CREATE INDEX IF NOT EXISTS sessions_expiry_idx ON sessions (expires_at)',
        'CREATE UNIQUE INDEX IF NOT EXISTS users_username_lower_idx ON users (LOWER(username))',
        'CREATE UNIQUE INDEX IF NOT EXISTS groups_name_lower_idx ON "groups" (LOWER(name))',
    ]
    for statement in statements:
        _create_index(cur, statement)


def _get_migration_versions(cur: Any, postgres: bool) -> set[str]:
    cur.execute("SELECT version FROM schema_migrations")
    return {str(row[0]) for row in cur.fetchall()}


def _record(cur: Any, postgres: bool, version: str) -> None:
    if postgres:
        cur.execute(
            "INSERT INTO schema_migrations (version) VALUES (%s) "
            "ON CONFLICT (version) DO NOTHING",
            (version,),
        )
    else:
        cur.execute(
            "INSERT OR IGNORE INTO schema_migrations (version) VALUES (?)",
            (version,),
        )


def run_migrations(conn: Any, postgres: bool) -> None:
    """Apply metadata schema changes repeatedly and safely.

    Every invocation performs introspection, then records the completed schema
    phases.  Recording is not used as the sole guard: this means an operator
    can recover from a database where an earlier process wrote a migration
    marker but was interrupted during a later column/index operation.
    """
    cur = conn.cursor()
    try:
        _create_tables(cur, postgres)
        conn.commit()
        applied = _get_migration_versions(cur, postgres)

        if "001_metadata_schema" not in applied:
            _record(cur, postgres, "001_metadata_schema")
            conn.commit()
            applied.add("001_metadata_schema")

        # This marker documents the compatibility columns used by the legacy
        # data normalizer in app.main.  The columns themselves are ensured on
        # every invocation above, so interrupted upgrades remain recoverable.
        if "002_legacy_group_columns" not in applied:
            _record(cur, postgres, "002_legacy_group_columns")
            conn.commit()
            applied.add("002_legacy_group_columns")

        _indexes(cur, postgres)
        conn.commit()
    except Exception:
        try:
            conn.rollback()
        except Exception:
            pass
        raise
    finally:
        cur.close()


def normalize_json(value: Any) -> dict[str, Any]:
    """Decode a JSON object stored by either SQLite or PostgreSQL."""
    if isinstance(value, dict):
        return value
    if not value:
        return {}
    if isinstance(value, str):
        try:
            parsed = json.loads(value)
            return parsed if isinstance(parsed, dict) else {}
        except (TypeError, ValueError):
            return {}
    return {}
