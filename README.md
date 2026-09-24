# Query Execute

A private, self-hosted workspace for working with PostgreSQL, MySQL/MariaDB, Firebird, Microsoft SQL Server, and SQLite from your browser.

**Current version: v1.0.1**

## What you can do

- Save database connections and group them for easier access.
- Run SQL queries and view results in your browser.
- Review query history and export results as CSV.
- Give team members appropriate admin, writer, or viewer access.
- Protect your account with optional authenticator-app two-factor authentication (2FA).

## Install and start

Choose one of the options below. The first start creates an empty application database and an `admin` account. You choose the admin password during setup; there is no shared default password.

### Windows

1. Install Python 3.11 or newer.
2. Download or clone this repository, then open its folder.
3. Run `install_windows.bat` (Command Prompt) or `install_windows.ps1` (PowerShell).
4. When prompted, set a strong password in the local `.env` file. Keep that file private.
5. Open <http://localhost:8282> and sign in as `admin` with the password you chose.

### Linux

1. Install Python 3.11 or newer.
2. Download or clone this repository and open a terminal in its folder.
3. Run:

   ```bash
   bash install_linux.sh
   ```

4. Set a strong password in the generated `.env` file, then rerun the command if setup asks you to.
5. Open <http://localhost:8282> and sign in as `admin` with the password you chose.

The installers create a local virtual environment, install the required Python packages, and prepare an empty SQLite metadata database. They stop rather than overwrite an existing local database. Back up existing data before moving or replacing database files.

### Docker (Windows, macOS, or Linux)

1. Install Docker Desktop or Docker Engine with Docker Compose v2.
2. Copy `.env.example` to `.env`.
3. Edit `.env` and set strong, unique values for `POSTGRES_PASSWORD`, `BOOTSTRAP_ADMIN_PASSWORD`, and `APP_ENCRYPTION_KEY`. Keep `.env` private.
4. Start the app:

   ```bash
   docker compose up --build -d
   ```

5. Visit <http://localhost:8282> and sign in as `admin` using the password in `.env`.

Docker stores application data in a persistent volume. `docker compose down -v` deletes that data; do not use `-v` unless you intend to erase it.

## Connect a database

After signing in, add a connection with its database type, server details, database name, and credentials. The app stores connection passwords encrypted. Make sure the database is reachable from the machine or container running Query Execute, and use an account with only the database permissions it needs.

For Firebird and Microsoft SQL Server, direct installation may also require native client libraries or an ODBC driver on your computer. The Docker image includes the supported client libraries.

## Enable two-factor authentication

1. Open **Settings** in the sidebar.
2. Choose the authenticator-app setup option.
3. Scan the QR code with an authenticator app, or enter the displayed setup key manually.
4. Enter the current six-digit code to confirm setup.

Keep the setup key private. The app generates the QR code locally; it is not sent to an external QR service.

## Updates and release history

The Settings page shows the installed version and release notes. If a newer GitHub release is available, the app displays an update notice and a button to open that release. The button does not automatically install or restart the app; an administrator must update the installation.

- **v1.0.1** — Settings-based 2FA, grouped connections, update notices and release history, interface refinements, and platform installers.
- **v1.0.0** — Initial versioned release.

## Data and security notes

- Choose strong, unique passwords. There is no `admin/admin` default login.
- Keep `.env`, database files, backups, and connection credentials private.
- For a public network, put the app behind HTTPS and configure secure cookies.
- Back up the Docker data volume or SQLite database regularly.
- Query Execute does not automatically install updates from the update notice.

## Help

Open an issue in the [GitHub repository](https://github.com/jye556/Query-Executer/issues) and include the app version and relevant error message. Do not include passwords, tokens, connection strings, or other secrets.
