import subprocess
import tempfile
import unittest
from pathlib import Path


class LinuxInstallerTests(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        self.root = Path(self.temp_dir.name)
        (self.root / ".venv/bin").mkdir(parents=True)
        (self.root / "scripts").mkdir()
        (self.root / "requirements.txt").write_text("# test stub\n")
        (self.root / "scripts/init_sqlite_db.py").write_text("# invoked by the fake interpreter\n")
        (self.root / "install_linux.sh").write_text(
            (Path(__file__).parents[1] / "install_linux.sh").read_text()
        )
        fake_python = self.root / ".venv/bin/python"
        fake_python.write_text(
            "#!/bin/sh\n"
            "if [ \"$1\" = \"-m\" ] && [ \"$2\" = \"pip\" ]; then exit 0; fi\n"
            "if [ \"$1\" = \"scripts/init_sqlite_db.py\" ]; then printf 'fresh-db\\n' > query_execute.db; exit 0; fi\n"
            "if [ \"$1\" = \"-m\" ] && [ \"$2\" = \"uvicorn\" ]; then touch server-started; exit 0; fi\n"
            "exit 2\n"
        )
        fake_python.chmod(0o755)
        (self.root / ".env").write_text(
            "BOOTSTRAP_ADMIN_USERNAME=admin\n"
            "BOOTSTRAP_ADMIN_PASSWORD=local-only-test-password\n"
            "APP_ENCRYPTION_KEY=test-key\n"
        )

    def tearDown(self):
        self.temp_dir.cleanup()

    def run_installer(self):
        return subprocess.run(
            ["bash", "install_linux.sh"],
            cwd=self.root,
            text=True,
            capture_output=True,
            check=False,
        )

    def test_installer_initializes_fresh_database_and_starts(self):
        result = self.run_installer()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual((self.root / "query_execute.db").read_text(), "fresh-db\n")
        self.assertTrue((self.root / "server-started").exists())

    def test_installer_restarts_with_existing_database_without_modifying_it(self):
        database = self.root / "query_execute.db"
        database.write_text("existing-user-data\n")

        result = self.run_installer()

        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(database.read_text(), "existing-user-data\n")
        self.assertTrue((self.root / "server-started").exists())

    def test_windows_powershell_installer_preserves_existing_database(self):
        script = (Path(__file__).parents[1] / "install_windows.ps1").read_text()
        self.assertIn("if (-not (Test-Path $sqlitePath))", script)
        self.assertNotIn("Refusing to reuse an existing SQLite DB", script)