# Query Execute Programming Guide

A developer and operator guide for the Query Execute application.

## 1. What the application is

Query Execute is a FastAPI web application for running SQL against saved database connections. It includes:

- A server-rendered HTML interface using Jinja2.
- A vanilla JavaScript frontend; there is no npm, bundler, or frontend build step.
- PostgreSQL or SQLite metadata storage.
- Firebird, PostgreSQL, MySQL/MariaDB, Microsoft SQL Server, and SQLite customer-database drivers.
- Server-side authentication, role-based authorization, group membership, connection filtering, query history, and CSV export.

The application listens on port `8282`.

## 2. Source tree

```text
query-execute/
├── app/
│   ├── main.py              # FastAPI routes, auth boundary, metadata access
│   ├── auth.py              # Argon2id passwords, sessions, CSRF/token helpers
│   ├── migrations.py        # PostgreSQL/SQLite metadata migrations
│   ├── db_service.py       # Customer DB drivers and guarded SQL execution
│   ├── templates/
│   │   ├── index.html       # Authenticated application UI
│   │   └── login.html       # Login page
│   └── static/
│       ├── css/style.css    # Dark responsive UI
│       └── js/app.js        # Browser state, API calls, filters, results
├── Dockerfile
├── docker-compose.yml
├── requirements.txt
├── query_execute.db         # Direct-run SQLite metadata file
└── PROGRAMMING_GUIDE.md     # This guide
```

`main.py` is intentionally large because it currently contains the FastAPI application, metadata repository helpers, migrations startup integration, DTOs, auth routes, admin routes, and query/history endpoints. When extending it, keep security checks in the backend rather than relying on frontend filtering.

## 3. Requirements

### Docker path

Install Docker Engine/Desktop and Docker Compose v2. Docker is the recommended runtime because it supplies PostgreSQL and the Python environment.

### Direct Python path

Use Python 3.11 or newer. Install the packages from `requirements.txt`:

```bash
python -m venv .venv
# Linux/macOS
. .venv/bin/activate
# Windows PowerShell
# .\.venv\Scripts\Activate.ps1
python -m pip install -r requirements.txt
```

The application uses optional database drivers. `/api/databases` reports each supported type and its form defaults. A driver can be reported unavailable when its package or required system library is missing. The Docker image installs the PostgreSQL, MySQL/MariaDB, Firebird, and Microsoft SQL Server client dependencies; Firebird requires the Firebird client library (`libfbclient2`), and SQL Server requires Microsoft ODBC Driver 18. Direct Python execution still requires the corresponding driver packages and native libraries.

## 4. Configuration

### Required authentication settings

The current Docker Compose configuration requires these variables:

- `BOOTSTRAP_ADMIN_USERNAME`: first administrator username; defaults to `admin` if omitted.
- `BOOTSTRAP_ADMIN_PASSWORD`: first administrator password. It must be supplied and should be at least 8 characters.
- `APP_ENCRYPTION_KEY`: stable key used to encrypt saved customer-database passwords and authenticator-app TOTP secrets at rest. Set it before enabling 2FA and never rotate it without a re-encryption plan.
- `POSTGRES_PASSWORD`: strong password for the metadata PostgreSQL service in Docker Compose.

For local Compose development, create a `.env` file next to `docker-compose.yml`:

```dotenv
POSTGRES_PASSWORD=replace-with-a-strong-database-password
BOOTSTRAP_ADMIN_USERNAME=admin
BOOTSTRAP_ADMIN_PASSWORD=replace-with-a-long-development-password
APP_ENCRYPTION_KEY=replace-with-a-long-stable-secret
COOKIE_SECURE=0
```

`COOKIE_SECURE=0` is appropriate only when using plain local HTTP. Set it to `1` behind HTTPS. Sessions default to 24 hours and can be configured with `SESSION_TTL_SECONDS` (bounded by the application).

### Metadata storage

Docker sets:

```text
DATABASE_URL=postgresql://postgres:REPLACE_WITH_POSTGRES_PASSWORD@db:5432/query_execute
```

The PostgreSQL data is stored in the Compose volume `pgdata`.

For direct execution without `DATABASE_URL`, metadata uses `query_execute.db`. Set `SQLITE_DB_PATH` to use a different SQLite metadata file. Setting `DATABASE_URL` switches metadata to PostgreSQL.

Do not use the sample PostgreSQL password in production. Put credentials in a secret manager or protected environment configuration.

## 5. Start, stop, and inspect the application

From `/root/query-execute`:

```bash
docker compose up --build -d
```

Open:

```text
http://localhost:8282/
```

Useful commands:

```bash
docker compose ps
docker compose logs -f web
docker compose logs -f db
docker compose restart web
docker compose down
```

To remove the PostgreSQL data volume as well (destructive):

```bash
docker compose down -v
```

Do not run `down -v` unless you intentionally want to delete metadata and saved connections.

Direct Python execution:

```bash
python -m uvicorn app.main:app --host 0.0.0.0 --port 8282 --reload
```

## 6. Authentication flow

1. A request to `/` without a session redirects to `/login.html`.
2. The login page posts credentials to `POST /api/auth/login`.
3. The server verifies the Argon2id password hash and, when enabled, a six-digit TOTP from an authenticator app.
4. The server creates an opaque session record and sets an HttpOnly session cookie only after both factors pass.
5. A separate CSRF cookie/token is used by JavaScript for mutating API requests.
6. The frontend calls `GET /api/auth/me`, then loads authorized data.
7. Logout calls `POST /api/auth/logout` and revokes the session.

Users can enroll an authenticator app from the in-app **Authenticator app** control. Setup remains pending until the first valid code is verified. The generated Base32 secret is compatible with TOTP applications such as Google Authenticator, Microsoft Authenticator, and Authy.

The first startup creates the bootstrap admin only when the metadata database has no users and the bootstrap environment variables are available. A missing bootstrap password does not create a usable account.

Important security rules:

- Do not return passwords or password hashes in API responses.
- Do not put customer database passwords in frontend state.
- Do not bypass `connection_id` authorization by accepting arbitrary host/database credentials from a normal query request.
- Mutating `/api` requests require a valid CSRF header.
- Keep login failures generic; do not reveal whether a username exists.

## 7. Roles and access model

The application has three roles:

- `admin`: manages users, groups, memberships, and connections; can query.
- `writer`: can query permitted connections.
- `viewer`: can query permitted connections.

All roles may submit any single SQL command. The selected database server and database account decide whether that command is permitted.

Connections can be assigned to multiple normalized groups through `connection_groups`. Users receive group memberships through `user_groups`. A non-admin user can access a connection when they own it or belong to at least one group assigned to it.

Frontend filters are only a convenience. Every connection list, get, update, delete, test, query, and history operation must be authorized in `main.py`.

## 8. Main API routes

Public routes:

```text
GET  /login.html
GET  /health
GET  /api/health
POST /api/auth/login
```

Authenticated routes:

```text
POST /api/auth/logout
GET  /api/auth/me
GET  /api/databases
GET  /api/groups
GET  /api/connections?group_id=<id>&db_type=<type>
GET  /api/connections/<id>
POST /api/connections/test        # unsaved add/edit form values
POST /api/connections/<id>/test
POST /api/query
GET  /api/history
DELETE /api/history
```

Admin routes include:

```text
POST/PUT/DELETE /api/groups[/<id>]
GET/PUT          /api/groups/<id>/members
GET/POST         /api/users
PUT/DELETE       /api/users/<id>
POST             /api/connections
PUT/DELETE       /api/connections/<id>
```

Unsaved connection testing is supported from the add/edit form. It sends the current form values to POST `/api/connections/test`, opens the requested customer database, closes it, and returns a success/error result without creating or changing a metadata row. Saved-connection testing remains available at `POST /api/connections/<id>/test`, which resolves credentials server-side.

A normal query request is shaped like:

```json
{
  "connection_id": "server-issued-id",
  "query": "SELECT * FROM company",
  "limit": 1000
}
```

Do not send host, username, password, or database credentials from the browser for normal execution.

## 9. Database migrations and metadata

`app/migrations.py` applies idempotent dialect-aware migrations at startup. It creates or upgrades:

- `users`
- `groups`
- `user_groups`
- `connection_groups`
- `sessions`
- `connections`
- `query_history`
- `schema_migrations`

Legacy `connection_group` labels are converted to normalized group rows. Legacy connections are assigned to the bootstrap administrator so they are not accidentally visible to ordinary users.

When adding schema fields:

1. Update both PostgreSQL and SQLite definitions.
2. Add an idempotent migration for existing installations.
3. Add indexes for authorization and history lookups.
4. Preserve old rows and rerun migration safely.
5. Test against both a fresh database and a legacy database.

Avoid adding more ad-hoc `CREATE TABLE IF NOT EXISTS` logic to `main.py`; extend the migration runner.

## 10. Customer database connections

A saved connection contains metadata such as:

- display name
- customer database type
- host and port
- database path/name
- username
- encrypted password
- driver-specific extra parameters
- owner and group memberships

The customer connection layer is in `app/db_service.py`. Driver availability and per-type form defaults are exposed through `/api/databases`; all five supported types are listed even when a driver is unavailable. Connection timeouts are configured for several drivers; Firebird uses its DSN format and requires the Firebird client library, while SQL Server uses pyodbc with Microsoft ODBC Driver 18 in the Docker image.

For remote Firebird, typical values are:

```text
Host: remote-ip-or-hostname
Port: 3050
Database: /path/on/firebird-server/database.fdb
Username: SYSDBA
Password: <secret>
```

The Firebird database path is interpreted by the Firebird server, not by the Query Execute container.

## 11. SQL execution policy

- `db_service.py` validates and executes SQL server-side. It accepts any single command supported by the selected database; the database user's own permissions remain the final authority.

- one-statement request boundaries and maximum query size
- result limits and driver timeouts where supported
- serialization of dates, decimals, and binary values
- commits for permitted DML

The query validator accepts any single SQL command supported by the selected customer database. It no longer restricts execution to `SELECT`, `WITH`, `INSERT`, `UPDATE`, or `DELETE`; database permissions remain the final authority.

Do not weaken the query validator merely because a frontend check exists. Frontend validation improves usability; backend validation is the security boundary.

When changing SQL support, add tests for:

- comments and quoted literals
- semicolons and multi-statements
- all supported statement categories
- database-permission failures
- result-limit behavior
- database driver error redaction

## 12. Frontend architecture

`index.html` is server-rendered and includes `app.js` and `style.css` directly. There is no package manager or frontend compilation. The UI uses the full available browser width and viewport height; the outer app has no fixed max-width, the query editor keeps the connection panel and editor side by side while results remain full width, and the layout falls back to a single column on small screens.

The Query Editor layout has:

- a left connection panel with group/type filters, database-name search, and selectable saved connections
- a right SQL editor
- full-width Query Results below the top panels
- any single SQL statement supported by the selected database; rows are rendered whenever the driver exposes a result description
- separate result sections when multiple connections are selected

`app.js` owns:

- authenticated API calls and CSRF headers
- current-user/logout behavior
- connection/group/type/database-name filtering
- selected connection IDs
- query execution and result rendering
- compact query history
- connection add/edit/test/delete flows
- admin user/group screens

Use `escapeHtml()` or DOM text APIs when rendering user-controlled names, group labels, queries, and database metadata. Never interpolate secrets into HTML.

- The authenticated app checks the GitHub Releases endpoint from Settings and on initialization; an available update displays a banner and release-page link. This only points to a release: operators still redeploy the app themselves.
- Set `GITHUB_REPOSITORY=OWNER/REPOSITORY` in the environment before publishing. `UPDATE_CHECK_URL` can override the feed; set it empty to disable remote checks. `UPDATE_RELEASES_URL` overrides the fallback release page.
- Version and release history are declared in `app/releases.json`; keep that file, the FastAPI version, UI badge, and static-asset cache query versions in sync for each release.

### Linux/Windows first-run installer

- The installer creates a local `.venv` and installs `requirements.txt`.
- It creates `.env` with username `admin`, a password placeholder, and a generated encryption key; it refuses startup until you replace the placeholder.
- Startup migrations create the empty SQLite metadata schema; the first admin is created from environment values once and is not reset later.
- Use `install_windows.ps1` (or `.bat`) on Windows and `install_linux.sh` on Linux/macOS. Legacy `start_windows` launchers delegate to the installer.


1. Read the relevant backend route, migration, template, JS, and CSS before changing behavior.
2. Make schema changes through the migration runner.
3. Keep authorization in server-side query predicates and dependencies.
4. Keep response DTOs separate from write/input DTOs.
5. Run syntax validation:

```bash
python -m py_compile app/main.py app/auth.py app/migrations.py app/db_service.py
node --check app/static/js/app.js
```

The add/edit connection form uses `/api/databases` to populate a complete default configuration for PostgreSQL, MySQL/MariaDB, Firebird, Microsoft SQL Server, and SQLite. MySQL/MariaDB uses the **Database** field, matching the database name passed to its driver. Changing the type resets only the editable form fields to that type's defaults; passwords remain blank. The form's **Test Connection** button posts the current values to `/api/connections/test` and does not save the connection.

6. Rebuild and restart:

```bash
docker compose up --build -d
```

7. Check health and logs:

```bash
curl -i http://localhost:8282/health
docker compose logs --tail 100 web
```

8. Use a browser smoke test for login, group assignment, database-name search, filtering, query execution with SELECT/DDL/administrative statements, history, CSV export, per-type connection defaults, and unsaved connection testing.

The query editor accepts any single SQL command supported by the selected database. Search in the left connection panel filters by the saved connection's database name; it does not change server-side authorization.

## 14. Troubleshooting

### Root redirects to login

This is expected without a valid session. Configure bootstrap credentials, restart, and sign in at `/login.html`.

### No admin account exists

Set `BOOTSTRAP_ADMIN_USERNAME` and `BOOTSTRAP_ADMIN_PASSWORD`, then restart the web service while the metadata database has no users. If users already exist, use an existing admin or perform an explicit administrative recovery procedure.

### API returns 401

The session is missing, expired, or revoked. Sign in again. A frontend 401 handler redirects to login.

### API returns 403 on POST/PUT/DELETE

The request is missing a valid CSRF token or the user lacks the required role. Browser requests should use the shared `apiFetch()` helper.

### Saved credential cannot be decrypted

The active `APP_ENCRYPTION_KEY` differs from the key used to encrypt the connection. Restore the original key or edit the connection and enter the password again under the current key.

### Test connection returns a database error

The add/edit form can test unsaved values; it does not create a metadata row. Check host, port, server-side Firebird path, credentials, firewall rules, and driver availability. Saved-connection testing uses server-side credentials.

### Connections appear empty

Check migrations and logs first. A schema failure should be fixed rather than hidden by treating every database read error as an empty list. Confirm the user is signed in and belongs to the relevant groups.

### Query Results are empty

Check the selected connection, authorization, database response, query command, and browser console. Any single command that returns rows through the driver is rendered; commands without a result set show their affected-row result. For multiple selected connections, one result section is rendered per connection; failed sections show their own error while successful sections remain visible.

## 15. Production checklist

- Use a strong PostgreSQL password and do not expose PostgreSQL publicly unless required.
- Set a stable, secret `APP_ENCRYPTION_KEY` and protect it like database credentials.
- Set a strong bootstrap password only for initial provisioning.
- Run behind HTTPS and set `COOKIE_SECURE=1`.
- Put the app behind an authenticated network boundary/reverse proxy as appropriate.
- Restrict customer database network access to the app host.
- Review group memberships and admin accounts regularly.
- Back up PostgreSQL metadata and test restoration.
- Monitor authentication failures, migration errors, and query failures without logging passwords or sensitive SQL parameters.
- Revisit the write-query policy before granting writer/admin roles.
