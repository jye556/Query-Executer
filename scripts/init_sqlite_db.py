#!/usr/bin/env python3
"""Create a deliberately minimal, local SQLite metadata database."""
from pathlib import Path
from app.migrations import run_migrations
import sqlite3
import os

path = Path(os.getenv("SQLITE_DB_PATH", Path(__file__).resolve().parents[1] / "query_execute.db"))
if not path.is_absolute():
    path = Path(__file__).resolve().parents[1] / path
path.parent.mkdir(parents=True, exist_ok=True)
connection = sqlite3.connect(path)
try:
    run_migrations(connection, postgres=False)
    connection.commit()
finally:
    connection.close()
print(f"Initialized empty metadata DB: {path.name}")
