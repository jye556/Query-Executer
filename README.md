# Query Execute

Query Execute is a self-hosted web app for running SQL against PostgreSQL, MySQL/MariaDB, Firebird, Microsoft SQL Server, and SQLite. Manage saved database connections, organize them into groups, review query history, export results, and optionally protect your account with authenticator-app two-factor authentication (2FA).

**Current version: v1.0.1**

## 1. Choose where to install

Choose one installation method:

- **Windows or Linux installer:** runs directly on one computer and uses a local SQLite file for app settings, users, saved connections, and history. Visit the app on that computer at `http://localhost:8282`.
- **Docker Compose:** runs the app with a PostgreSQL metadata database in containers. Use this if you already use Docker or want an easier-to-manage hosted installation.

The app’s metadata database stores its own users, saved connection details, and history. Your actual work databases remain separate; add them as connections after signing in.

Do not expose the app directly to the public internet over plain HTTP. For remote access, use a trusted private network or configure HTTPS with a reverse proxy.

## 2. Install directly on Windows

### Requirements

- Windows 10/11.
- Python 3.11 or newer.
- Internet access during setup so Python packages can be downloaded.

### Download and install

1. Install Python from [python.org](https://www.python.org/downloads/windows/). During setup, enable **Add Python to PATH**.
2. Open Command Prompt and check Python:

   ```bat
   python --version
   ```

   It must report version 3.11 or newer. If `python` is not recognized, finish Python installation, enable PATH, and open a new terminal.
3. Download the ZIP from the [Query Execute GitHub page](https://github.com/jye556/Query-Executer) using **Code → Download ZIP**. Extract it to a permanent folder, for example `C:\Query-Execute`. Do not run the app from inside the ZIP.
4. In File Explorer, open the extracted folder. Double-click `install_windows.bat`.
   - Or open PowerShell in that folder and run `./install_windows.ps1`.
   - If PowerShell blocks the script, run `Set-ExecutionPolicy -Scope Process Bypass` in that terminal, then run `./install_windows.ps1` again.
5. On first run, the installer creates a private `.env` configuration file and opens it for editing. Replace the password placeholder with a strong, unique password, save, and close the editor. If setup stops after creating the file, run `install_windows.bat` or `./install_windows.ps1` again.
6. The installer creates a virtual environment, installs required packages, prepares an empty local app database if one does not already exist, and starts the web server. Keep the terminal window open while using the app.

### Sign in

Open <http://localhost:8282> in a browser. Sign in with username `admin` and the password you set in `.env`. There is no shared `admin/admin` password.

To stop the server, close the installer/server terminal or press `Ctrl+C`. To start it later, run the same Windows installer/launcher again from the application folder. The local database and `.env` are kept in that folder and should not be deleted.

## 3. Install directly on Linux

### Requirements

- A Linux distribution with Python 3.11 or newer and the `venv` support package.
- Internet access during setup so Python packages can be downloaded.

Check Python:

```bash
python3 --version
```

Install Python 3.11+ and your distribution’s Python virtual-environment package if needed. For example, Debian/Ubuntu systems may need `python3-venv` in addition to Python.

### Download and install

Choose either method:

- Download the ZIP from the [Query Execute GitHub page](https://github.com/jye556/Query-Executer) and extract it, or
- Clone the repository with Git:

  ```bash
  git clone https://github.com/jye556/Query-Executer.git
  cd Query-Executer
  ```

Open a terminal in the extracted application folder. If the installer file is not executable, running it through Bash works without changing file permissions:

```bash
bash install_linux.sh
```

The installer creates a virtual environment and installs required packages. If `.env` does not exist, it creates the file and stops. Open `.env` in a text editor, replace the password placeholder with a strong, unique password, save it, then rerun `bash install_linux.sh`. The installer prepares an empty local SQLite metadata database if one does not already exist.

Keep `.env` private. The installer sets restrictive file permissions for a newly created `.env` file. Existing database files are not overwritten. Keep the terminal open while using the app; press `Ctrl+C` to stop it. Run `bash install_linux.sh` again from the app folder to start it later.

### Sign in

Open <http://localhost:8282> in a browser. Sign in with username `admin` and the password you set in `.env`. There is no shared `admin/admin` password.

## 4. Install with Docker Compose

Docker Compose is available on Windows, macOS, and Linux. Install Docker Desktop or Docker Engine with Compose v2, then download and extract this repository.

### Configure the app

1. Open a terminal in the repository folder.
2. Make a local copy of the sample configuration:

   - Windows Command Prompt: `copy .env.example .env`
   - PowerShell: `Copy-Item .env.example .env`
   - Linux/macOS: `cp .env.example .env`
3. Open `.env` in a text editor and set strong, unique values for:
   - `POSTGRES_PASSWORD` — password for the app’s internal metadata database.
   - `BOOTSTRAP_ADMIN_PASSWORD` — password for the `admin` app account.
   - `APP_ENCRYPTION_KEY` — key that protects saved database passwords and 2FA secrets. Keep this key safe and stable; losing or changing it can make saved secrets unreadable.
4. Save `.env`. Never upload or share it. The app already defaults to this project’s GitHub release feed; change it only if you are using a different repository.

### Start and sign in

Start the app from the repository folder:

```bash
docker compose up --build -d
```

The first start downloads/builds the required images and creates the metadata database. When startup completes, visit <http://localhost:8282> and sign in as `admin` with the `BOOTSTRAP_ADMIN_PASSWORD` you configured.

Useful Docker commands:

```bash
docker compose ps            # check whether services are running
docker compose logs -f web   # follow application logs; Ctrl+C exits log view
docker compose stop          # stop services without deleting data
docker compose start         # start stopped services
docker compose down          # remove containers but preserve database data
```

**Important:** `docker compose down -v` deletes the database volume, including app users, saved connections, and history. Use it only when you intend to erase that data. Back up the volume and `.env` before moving or reinstalling.

## 5. Add your first database connection

1. Sign in and open **Connections**.
2. Select **Add Connection**.
3. Enter a recognizable connection name and choose the database type.
4. Enter the server host, port, database name or file path, and database username/password as required by that database.
5. Optionally assign one or more groups.
6. Select **Test Connection**. Fix any reported host, port, database, network, or permission issue, then save the connection.

Query Execute must be able to reach the database over the network. With Docker, `localhost` means the app container itself—not your computer. For a database running on another machine, use a hostname or IP address reachable from the container. Use a database account with only the permissions needed for your work. Saved connection passwords are encrypted using the app’s encryption key and are not displayed again.

Direct installations of Firebird and Microsoft SQL Server may need their native client library or ODBC driver installed on the computer. If those dependencies are troublesome, use Docker, whose image includes the supported database clients.

## 6. Run queries and use the app

- Open **Query**, select the connection or connections to use, enter your SQL, and execute it.
- Review the selected target and SQL carefully before running statements that change data.
- Open **History** to review your saved query activity; export query results as CSV when available.
- Open **Connections** to search/filter saved connections and organize them by group or database type.
- Administrators can manage team members and groups from the **Users** and **Groups** controls. Choose the role and connection access appropriate for each person. App roles do not replace permissions configured on the database server.

## 7. Turn on two-factor authentication

1. Open **Settings** from the sidebar.
2. Start authenticator-app setup.
3. Scan the displayed QR code with an authenticator app. If scanning is unavailable, enter the displayed setup key manually.
4. Enter the current six-digit authenticator code to confirm and enable 2FA.

The QR code is generated locally; provisioning details are not sent to an external QR service. Keep the setup key private. Do not remove your authenticator entry unless you can still access the account or an administrator can help restore access.

## 8. Updates

The Settings page shows the installed version and release notes. When a newer GitHub release is detected, the app displays an update notice and a link to the release. The link does **not** automatically download, install, or restart the app. An administrator must follow the release instructions and update the server. Back up `.env` and app data before upgrading.

Current release: **v1.0.1**. The release log is available at [GitHub releases](https://github.com/jye556/Query-Executer/releases).

## 9. Back up, move, or remove an installation

Before moving or removing Query Execute, stop the server and make a secure backup of:

- The local `query_execute.db` file for Windows/Linux direct installs, or the Docker `pgdata` volume for Compose installs.
- The `.env` file, especially `APP_ENCRYPTION_KEY` and the configured database password. Store this backup securely; it contains sensitive access information.

For a direct installation, keep the database file and `.env` when updating or moving the app folder. Do not rerun setup over an existing database after moving files unless you know which database path is configured. To uninstall the direct app, stop it and remove the app folder only after verifying your backup. To remove Docker containers but keep data, use `docker compose down`. To intentionally remove the app data too, use `docker compose down -v`—this is destructive.

## 10. Troubleshooting

- **Python is missing or too old:** install Python 3.11+, ensure it is on `PATH`, and open a new terminal.
- **Linux says `venv` or `ensurepip` is unavailable:** install your distribution’s Python virtual-environment package, then rerun the installer.
- **PowerShell blocks the installer:** in the same PowerShell window run `Set-ExecutionPolicy -Scope Process Bypass`, then rerun it.
- **Port 8282 is already in use:** stop the other program using port 8282 or configure the app to use another port.
- **The app cannot connect to a database:** verify host, port, database name/path, firewall, network reachability, and database permissions. In Docker, do not use `localhost` for a database on the host computer.
- **Saved database passwords cannot be decrypted:** restore the exact `APP_ENCRYPTION_KEY` used when the credentials were saved, or edit the connection and enter its password again using the current key.
- **The installer reports an existing SQLite database:** it is protecting existing data. Do not delete the file to silence the warning. Back it up and confirm the configured database path before proceeding.
- **You cannot sign in:** use the bootstrap admin username and password configured for the metadata database. Rerunning the installer does not reset existing user passwords. Do not delete the app database as a password-reset attempt.

For help, open an issue in the [Query Execute GitHub repository](https://github.com/jye556/Query-Executer/issues). Include the app version and relevant error text only. Never post passwords, tokens, connection strings, `.env` contents, or database backups.
