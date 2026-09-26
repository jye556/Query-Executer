# Query Execute

Query Execute is a self-hosted web app for running SQL against PostgreSQL, MySQL/MariaDB, Firebird, Microsoft SQL Server, and SQLite. Manage saved database connections, organize them into groups, review query history, export results, and optionally protect your account with authenticator-app two-factor authentication (2FA).

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

1. Install Python 3.11 or newer from [python.org](https://www.python.org/downloads/windows/). During setup, enable **Add Python to PATH**.
2. Install [Git for Windows](https://git-scm.com/download/win) if `git` is not already available.
3. In Command Prompt, check the installed tools:

   ```bat
   python --version
   git --version
   ```

   Python must be version 3.11 or newer. If not, install a newer version, then open a new Command Prompt.
4. Open Command Prompt and move to the folder where you want to install Query Execute, for example:

   ```bat
   cd /d C:\
   ```

5. Clone the public repository with Git:

   ```bat
   git clone https://github.com/jye556/Query-Executer.git
   cd Query-Executer
   ```

   Alternatively, download the ZIP from the [GitHub repository](https://github.com/jye556/Query-Executer) and extract it to a permanent folder.
6. Start the installer from inside the project folder. For Command Prompt:

   ```bat
   install_windows.bat
   ```

   For PowerShell, open PowerShell in the project folder and run `./install_windows.ps1`. If PowerShell blocks it, run `Set-ExecutionPolicy -Scope Process Bypass`, then run `./install_windows.ps1` again.
7. On first run, the installer creates `.env` and opens it in Notepad. Replace `CHANGE-ME-before-first-login` on the `BOOTSTRAP_ADMIN_PASSWORD` line with a strong, unique password. Keep the generated `APP_ENCRYPTION_KEY` unchanged. Save the file and close Notepad. If the installer has stopped, start it again from the project folder:

   ```bat
   install_windows.bat
   ```

8. The installer creates a virtual environment, installs required packages, initializes an empty local app database if none exists, and starts the server. Leave this terminal open while using Query Execute.

### Sign in

Open <http://localhost:8282> in a browser. Sign in with username `admin` and the password you set in `.env`. There is no shared `admin/admin` password.

### Start it later or stop it

To stop Query Execute, press `Ctrl+C` in the server terminal. To start it later, open Command Prompt in the project folder and run `install_windows.bat` again. The app’s database and `.env` stay in this folder; do not delete them if you want to keep your users and saved connections.

## 3. Install directly on Linux

### Requirements

- Linux distribution with Python 3.11 or newer, Git, and Python virtual-environment (`venv`) support.
- Internet access during setup so Git and Python packages can be downloaded.

Check Python and Git:

```bash
python3 --version
git --version
```

Install Python 3.11+, Git, and your distribution’s Python venv package if needed. For example, Debian/Ubuntu may need `python3`, `python3-venv`, and `git` packages.

### Clone, install, and start (Bash)

The following commands are for Debian/Ubuntu. Other Linux distributions should install equivalent packages for Git, Python 3.11 or newer, Python `venv`, and Nano.

```bash
# Install prerequisites
sudo apt update
sudo apt install -y git python3 python3-venv nano

# Confirm Python is version 3.11 or newer and Git is installed
python3 --version
git --version

# Clone the app into your home directory
cd "$HOME"
git clone https://github.com/jye556/Query-Executer.git
cd Query-Executer

# Let the installer open `.env` in Nano the first time it runs
export EDITOR=nano
bash install_linux.sh
```

When Nano opens `.env`, change the `BOOTSTRAP_ADMIN_PASSWORD` line from the placeholder to a strong, unique password. Keep the generated `APP_ENCRYPTION_KEY` unchanged. Save with **Ctrl+O**, press **Enter** to confirm, then exit with **Ctrl+X**. The installer creates a private `.venv`, installs the app’s packages, initializes an empty local SQLite metadata database (if none exists), and starts the web server. If the installer stopped after creating `.env`, run it again with `bash install_linux.sh`.

If `python3 --version` reports a version below 3.11, install Python 3.11 or newer and its matching `venv` package from your Linux distribution before running the installer. The script checks the Python version and will not start with an unsupported version.

### Sign in, stop, and restart

Open <http://localhost:8282> and sign in with username `admin` and the password you set in `.env`. There is no shared `admin/admin` password. Keep the terminal open while using the app. Press **Ctrl+C** in that terminal to stop the server. To start it later:

```bash
cd "$HOME/Query-Executer"
export EDITOR=nano
bash install_linux.sh
```

Keep `.env` and `query_execute.db` in the project folder. Existing databases are not overwritten. Back up existing data before moving or replacing database files.

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

- Current release: **v1.0.4**. See [GitHub releases](https://github.com/jye556/Query-Executer/releases).
- Docker Compose users can change `GITHUB_REPOSITORY` or `UPDATE_CHECK_URL` in `.env` if using a different release feed. Set `UPDATE_CHECK_URL` to an empty value to disable remote checks.

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
- **The installer refuses to start with a default password:** edit `.env`, replace the bootstrap-password placeholder with a strong password, and rerun the installer. Keep the generated `APP_ENCRYPTION_KEY` unchanged.
- **You cannot sign in:** use the bootstrap admin username and password configured for the metadata database. Rerunning the installer does not reset existing user passwords. Do not delete the app database as a password-reset attempt.

For help, open an issue in the [Query Execute GitHub repository](https://github.com/jye556/Query-Executer/issues). Include the app version and relevant error text only. Never post passwords, tokens, connection strings, `.env` contents, or database backups.
