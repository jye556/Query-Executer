# Query Execute

A self-hosted SQL workspace for PostgreSQL, MySQL/MariaDB, Firebird, Microsoft SQL Server, and SQLite. It manages saved, access-controlled connections, executes queries, and provides query history, CSV export, database/group filters, and optional authenticator-app two-factor authentication.

**Current version: `v1.0.1`** — release log: [`app/releases.json`](app/releases.json).

## Features

- Authenticated app with admin/writer/viewer roles, group-based access, and CSRF-protected API mutations.
- Saved connections with encrypted credentials and server-side authorization.
- Search connections by database name and group by assigned group.
- Query execution, result editing where supported, history, and CSV export.
- Optional TOTP 2FA with locally generated QR code and copyable setup key.
- Settings page for 2FA, version/update information, and release log.
- PostgreSQL metadata in Docker; SQLite metadata for direct Python runs.

## Quick start with Docker Compose

Requirements: Docker Engine/Desktop with Docker Compose v2.

1. Copy `.env.example` to `.env`.
2. Edit `.env`: set strong unique values for `POSTGRES_PASSWORD`, `BOOTSTRAP_ADMIN_PASSWORD`, and `APP_ENCRYPTION_KEY` (generate the latter with `python -c "from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())"`), and set your `GITHUB_REPOSITORY=jye556/Query-Executer`. Never commit `.env`.
3. Run `docker compose up --build -d`.
4. Open <http://localhost:8282> and sign in as `admin` with the password configured in `.env`. A fresh metadata DB creates the first admin from those settings. There is no `admin/admin` default.

For HTTPS deployments, configure TLS at a reverse proxy and set `COOKIE_SECURE=1`. Metadata is in the `pgdata` volume. `docker compose down -v` deletes it; do not use `-v` unless intentional.

## Linux and Windows direct installation

Requires Python 3.11+. The scripts create a virtual environment, install `requirements.txt`, and start the app with an empty local SQLite metadata DB; the first admin is bootstrapped from `.env`.

- Linux/macOS: `bash install_linux.sh`
- Windows PowerShell: `./install_windows.ps1` (use `Set-ExecutionPolicy -Scope Process Bypass` if required)
- Windows Command Prompt: `install_windows.bat`

On first run the script creates `.env` with username `admin`, a temporary password placeholder, and a generated encryption key. It opens `.env` for editing (or pauses for manual editing if the Linux shell is non-interactive). Replace the placeholder with a unique strong password before the server starts. There is no built-in `admin/admin` login. Keep `.env` and `query_execute.db` private.

Manual setup: create and activate a venv, run `python -m pip install -r requirements.txt`, set `BOOTSTRAP_ADMIN_USERNAME`, `BOOTSTRAP_ADMIN_PASSWORD`, and a stable `APP_ENCRYPTION_KEY`, then run `python -m uvicorn app.main:app --host 127.0.0.1 --port 8282`.

Firebird and SQL Server also require native client libraries/ODBC drivers on the host. The Docker image uses Debian 12 with Firebird client and Microsoft ODBC Driver 18.

## Versions and updates

Settings shows the installed version, checks the configured GitHub Releases API feed, displays the bundled release log, and alerts when a newer tag is available. The update link opens the release page; it does **not** install code or redeploy the server.

Set `GITHUB_REPOSITORY=jye556/Query-Executer`; Compose derives default API and release URLs from it. Optionally set `UPDATE_CHECK_URL` or `UPDATE_RELEASES_URL`. Set `UPDATE_CHECK_URL=` to disable remote checks (local release notes remain visible).

- **v1.0.1** — Move 2FA into Settings; group connections; add update checking and release log; polish buttons; center login; add cross-platform installers and GitHub docs.
- **v1.0.0** — Initial versioned release.

For each future enhancement/release, update the app version, `app/releases.json`, frontend cache-busting versions, and release notes, then publish a matching `vX.Y.Z` GitHub tag.

## Publish to GitHub step by step

1. Create a new empty GitHub repository; do not initialize it with another README or license.
2. Review `.gitignore`. Confirm `.env`, `.venv`, local databases, backups, and dumps will not be staged. Set the real `GITHUB_REPOSITORY` in your private `.env`.
3. From the project directory, initialize and stage only intended source/docs:

   ```bash
   git init -b main
   git add .github app scripts tests Dockerfile docker-compose.yml README.md requirements.txt install_linux.sh install_windows.ps1 install_windows.bat start_windows.bat start_windows.ps1 .gitignore .env.example
   git status --short
   git diff --cached
   ```

   Ensure no secret, `.env`, local DB, or backup is staged. Choose a license if you intend to grant reuse rights; none is assumed.
4. Commit and push using the actual URL shown by GitHub:

   ```bash
   git commit -m "Release Query Execute v1.0.1"
   git remote add origin https://github.com/jye556/Query-Executer.git
   git push -u origin main
   ```
5. Verify files and the Actions tab on GitHub. Create release tag `v1.0.1` with matching notes. Set `GITHUB_REPOSITORY=jye556/Query-Executer` in deployments to enable accurate update checks.

## Development checks

```bash
python -m unittest discover -s tests -v
node --check app/static/js/app.js
bash -n install_linux.sh
docker compose config --quiet
```

GitHub Actions runs tests for pushes and pull requests. The app listens on port 8282. See [`PROGRAMMING_GUIDE.md`](PROGRAMMING_GUIDE.md) for architecture and development conventions.
