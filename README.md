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

The repository is `https://github.com/jye556/Query-Executer`. The helper script runs tests, checks that local config/database/backup files are not tracked, pushes the committed branch to `main`, and verifies the remote commit. Run it from the checkout:

```bash
bash scripts/publish_github.sh --check   # validate without publishing
bash scripts/publish_github.sh           # push commits to main
bash scripts/publish_github.sh --release # push and create the matching GitHub release
```

Authenticate first with `gh auth login` (or `gh auth refresh -h github.com -s repo,workflow`), using an account that has repository write access. Never paste tokens into chat or put them in a remote URL. The script expects a clean working tree and the configured `origin`; it does not commit files for you.

Manual equivalent, if you prefer to inspect each step:

1. Run tests and inspect `git status` / `git diff`.
2. Stage and commit only intended application files. Do not add `.env`, local databases, backups, or dumps.
3. Push the reviewed commit: `git push origin HEAD:main`.
4. Verify `git ls-remote origin refs/heads/main` matches `git rev-parse HEAD`.
5. Create release `v1.0.1` in GitHub after confirming that release has not already been made; the app version and `app/releases.json` are the source of the tag/version.

## Development checks

```bash
python -m unittest discover -s tests -v
node --check app/static/js/app.js
bash -n install_linux.sh
docker compose config --quiet
```

GitHub Actions runs tests for pushes and pull requests. The app listens on port 8282. See [`PROGRAMMING_GUIDE.md`](PROGRAMMING_GUIDE.md) for architecture and development conventions.
