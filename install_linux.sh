#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
PYTHON_BIN="${PYTHON:-python3}"
command -v "$PYTHON_BIN" >/dev/null || { echo "Install Python 3.11+ first." >&2; exit 1; }
"$PYTHON_BIN" -c 'import sys; sys.exit(0 if sys.version_info >= (3, 11) else 1)' || { echo "Python 3.11+ is required." >&2; exit 1; }
if [ ! -x .venv/bin/python ]; then
  "$PYTHON_BIN" -m venv .venv
fi
.venv/bin/python -m pip install --upgrade pip
.venv/bin/python -m pip install -r requirements.txt
if [ ! -f .env ]; then
  APP_ENCRYPTION_KEY=$(.venv/bin/python -c 'from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())')
  umask 077
  printf 'BOOTSTRAP_ADMIN_USERNAME=admin\nBOOTSTRAP_ADMIN_PASSWORD=CHANGE-ME-before-first-login\nAPP_ENCRYPTION_KEY=%s\nCOOKIE_SECURE=0\n' "$APP_ENCRYPTION_KEY" > .env
  chmod 600 .env
  echo "Created .env. Set a strong password in this file before starting the app."
  if [ -t 0 ]; then
    "${EDITOR:-vi}" .env
  else
    echo "Edit .env and rerun this installer." >&2
    exit 1
  fi
fi
set -a
. ./.env
set +a
if [ "${BOOTSTRAP_ADMIN_PASSWORD:-}" = "CHANGE-ME-before-first-login" ] || [ -z "${BOOTSTRAP_ADMIN_PASSWORD:-}" ]; then
  echo "Set a unique BOOTSTRAP_ADMIN_PASSWORD in .env before starting Query Execute." >&2
  exit 1
fi
if [ -z "${DATABASE_URL:-}" ] && [ ! -f "${SQLITE_DB_PATH:-query_execute.db}" ]; then
  DB_PATH="${SQLITE_DB_PATH:-query_execute.db}"
  SQLITE_DB_PATH="$DB_PATH" .venv/bin/python scripts/init_sqlite_db.py
fi
exec .venv/bin/python -m uvicorn app.main:app --host 127.0.0.1 --port 8282
