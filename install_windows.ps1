$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot
$python = Get-Command python -ErrorAction SilentlyContinue
if (-not $python) { throw 'Install Python 3.11+ and ensure python.exe is on PATH.' }
$version = & python -c 'import sys; print(f"{sys.version_info.major}.{sys.version_info.minor}")'
if ([version]$version -lt [version]'3.11') { throw 'Python 3.11+ is required.' }
if (-not (Test-Path '.venv\Scripts\python.exe')) { & python -m venv .venv }
$venvPython = Join-Path $PSScriptRoot '.venv\Scripts\python.exe'
& $venvPython -m pip install --upgrade pip
& $venvPython -m pip install -r requirements.txt
if (-not (Test-Path '.env')) {
    $key = & $venvPython -c 'from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())'
    @("BOOTSTRAP_ADMIN_USERNAME=admin", "BOOTSTRAP_ADMIN_PASSWORD=CHANGE-ME-before-first-login", "APP_ENCRYPTION_KEY=$key", "COOKIE_SECURE=0") | Set-Content -Encoding ascii '.env'
    Write-Host 'Created .env; set a strong password before starting the app.' -ForegroundColor Yellow
    notepad .env
}
Get-Content '.env' | ForEach-Object {
    if ($_ -match '^\s*([^#\s][^=]*)=(.*)$') { [Environment]::SetEnvironmentVariable($matches[1], $matches[2], 'Process') }
}
if (-not $env:BOOTSTRAP_ADMIN_PASSWORD -or $env:BOOTSTRAP_ADMIN_PASSWORD -eq 'CHANGE-ME-before-first-login') {
    throw 'Set a unique BOOTSTRAP_ADMIN_PASSWORD in .env before starting Query Execute.'
}
$sqlitePath = if ($env:SQLITE_DB_PATH) { $env:SQLITE_DB_PATH } else { 'query_execute.db' }
if (-not $env:DATABASE_URL -and (Test-Path $sqlitePath)) {
    throw 'Refusing to reuse an existing SQLite DB during first-run installation; configure DATABASE_URL or back it up and move it deliberately.'
}
if (-not $env:DATABASE_URL) { & $venvPython 'scripts/init_sqlite_db.py' }
& $venvPython -m uvicorn app.main:app --host 127.0.0.1 --port 8282
