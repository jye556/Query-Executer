@echo off
setlocal
cd /d "%~dp0"
python -c "import sys; sys.exit(0 if sys.version_info >= (3,11) else 1)"
if errorlevel 1 (
  echo Python 3.11+ is required and must be available as python.
  exit /b 1
)
if not exist .venv\Scripts\python.exe python -m venv .venv
if errorlevel 1 exit /b 1
.venv\Scripts\python.exe -m pip install --upgrade pip
if errorlevel 1 exit /b 1
.venv\Scripts\python.exe -m pip install -r requirements.txt
if errorlevel 1 exit /b 1
if not exist .env (
  for /f %%K in (' .venv\Scripts\python.exe -c "from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())" ') do set APP_ENCRYPTION_KEY=%%K
  >.env echo BOOTSTRAP_ADMIN_USERNAME=admin
  >>.env echo BOOTSTRAP_ADMIN_PASSWORD=CHANGE-ME-before-first-login
  >>.env echo APP_ENCRYPTION_KEY=%APP_ENCRYPTION_KEY%
  >>.env echo COOKIE_SECURE=0
  echo Created .env. Set a strong password in this file before starting the app.
  notepad .env
)
for /f "usebackq tokens=1,* delims==" %%A in (".env") do if not "%%A"=="" set "%%A=%%B"
if "%BOOTSTRAP_ADMIN_PASSWORD%"=="CHANGE-ME-before-first-login" (
  echo Set a unique BOOTSTRAP_ADMIN_PASSWORD in .env before starting Query Execute.
  exit /b 1
)
if "%BOOTSTRAP_ADMIN_PASSWORD%"=="" (
  echo Set a unique BOOTSTRAP_ADMIN_PASSWORD in .env before starting Query Execute.
  exit /b 1
)
if not "%DATABASE_URL%"=="" goto start_app
if exist "%SQLITE_DB_PATH%" goto start_app
.venv\Scripts\python.exe scripts\init_sqlite_db.py
if errorlevel 1 exit /b 1
:start_app
.venv\Scripts\python.exe -m uvicorn app.main:app --host 127.0.0.1 --port 8282
