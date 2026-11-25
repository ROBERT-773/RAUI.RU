"""Run with python test_store.py [php [PHP options]], using only temporary SQLite files."""
import csv
import io
import json
import shutil
import sqlite3
import subprocess
import sys
import tempfile
import unittest
from concurrent.futures import ThreadPoolExecutor
from contextlib import contextmanager
from pathlib import Path

PHP = sys.argv[1:] or ["php"]
SOURCE = Path(__file__).resolve().parent
STAMP = "2026-01-12T03:04:05Z"
EMAILS = ("+fixture@example.test", "'+fixture@example.test")
PHONE = "+12025550142"
LEGACY = """
CREATE TABLE launch_interest(email TEXT NOT NULL, phone TEXT NOT NULL, consent_version TEXT NOT NULL, consented_at TEXT NOT NULL, PRIMARY KEY(email,phone)) WITHOUT ROWID;
CREATE TABLE launch_quota(k TEXT PRIMARY KEY, amount INTEGER NOT NULL, ends INTEGER NOT NULL) WITHOUT ROWID;
CREATE TABLE launch_settings(k TEXT PRIMARY KEY, v TEXT NOT NULL) WITHOUT ROWID;
"""


class StoreTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.private = Path(self.temp.name) / "private"
        self.private.mkdir(mode=0o700)
        for name in ("store.php", "operator.php"):
            shutil.copyfile(SOURCE / name, self.private / name)
        if (SOURCE / "migrations").exists():
            shutil.copytree(SOURCE / "migrations", self.private / "migrations")
        self.data = self.private / "data"
        self.data.mkdir(mode=0o700)
        self.database = self.data / "contacts.sqlite"

    @contextmanager
    def db(self):
        db = sqlite3.connect(self.database)
        self.database.chmod(0o600)
        try:
            with db:
                yield db
        finally:
            db.close()

    def seed(self):
        with self.db() as db:
            db.executescript(LEGACY)
            for email in EMAILS:
                db.execute("INSERT INTO launch_interest VALUES(?,?,?,?)", (email, PHONE, "old-consent", STAMP))
            db.execute("INSERT INTO launch_quota VALUES('all',17,9999999999)")
            db.execute("INSERT INTO launch_settings VALUES('quota-key','test-only-key')")

    def cli(self, action, check=True):
        return subprocess.run([*PHP, str(self.private / "operator.php"), action], capture_output=True, text=True, check=check)

    def submit(self, email, phone=PHONE):
        code = "require $argv[1]; echo handleSubmission(openStore(),'127.0.0.1',200,[$argv[2],$argv[3]]);"
        return subprocess.check_output([*PHP, "-r", code, str(self.private / "store.php"), email, phone], text=True)

    def test_unversioned_upgrade_and_legacy_writer(self):
        self.seed()
        with ThreadPoolExecutor(max_workers=6) as workers:
            list(workers.map(lambda _: self.cli("check"), range(12)))
        with self.db() as db:
            self.assertEqual(db.execute("PRAGMA user_version").fetchone()[0], 2)
            self.assertEqual(db.execute("SELECT amount,ends FROM launch_quota").fetchone(), (17, 9999999999))
            self.assertEqual(db.execute("SELECT v FROM launch_settings").fetchone(), ("test-only-key",))
            self.assertEqual(db.execute("SELECT DISTINCT created_at,consented_at,consent_version FROM launch_interest").fetchall(), [(STAMP,STAMP,"old-consent")])
            db.execute("INSERT INTO launch_interest(email,phone,consent_version,consented_at) VALUES(?,?,?,?)", ("older-writer@example.test", PHONE, "old-consent", STAMP))
            self.assertEqual(db.execute("SELECT created_at FROM launch_interest WHERE email='older-writer@example.test'").fetchone(), (STAMP,))
        self.assertEqual(self.submit(EMAILS[0]), "201")
        with self.db() as db:
            self.assertEqual(db.execute("SELECT created_at,consented_at,consent_version FROM launch_interest WHERE email=?", (EMAILS[0],)).fetchone(), (STAMP,STAMP,"old-consent"))

    def test_concurrent_new_writer(self):
        with ThreadPoolExecutor(max_workers=6) as workers:
            self.assertEqual(list(workers.map(lambda _: self.submit(EMAILS[0]), range(12))), ["201"]*12)
        with self.db() as db:
            rows = db.execute("SELECT created_at,consented_at,consent_version FROM launch_interest").fetchall()
            self.assertEqual(len(rows), 1)
            created, consented, version = rows[0]
            self.assertEqual(created, consented)
            self.assertRegex(created, r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$")
            self.assertEqual(version, "launch-notice-v1")

    def test_private_machine_and_excel_exports(self):
        self.seed()
        for action in ("export", "export-jsonl"):
            result = self.cli(action)
            self.assertNotIn("example.test", result.stdout + result.stderr)
            self.assertNotIn(PHONE, result.stdout + result.stderr)
        exports = self.data / "exports"
        jsonl = next(exports.glob("*.jsonl"))
        rows = [json.loads(line) for line in jsonl.read_text(encoding="utf-8").splitlines()]
        self.assertEqual({r['email'] for r in rows}, set(EMAILS))
        for row in rows:
            self.assertEqual(row, dict(email=row['email'],phone=PHONE,created_at=STAMP,consented_at=STAMP,consent_version="old-consent"))
        csv_file = next(exports.glob("*.csv"))
        parsed = list(csv.reader(io.StringIO(csv_file.read_text(encoding="utf-8-sig"))))
        self.assertEqual(parsed[0], ["email","phone","consented_at","consent_version"])
        self.assertEqual(len(parsed), 3)
        self.assertTrue(all(r[1] == "'" + PHONE for r in parsed[1:]))
        self.assertEqual(list(exports.glob("*.partial")), [])

    def test_failed_step_rolls_back(self):
        self.seed()
        step = self.private / "migrations" / "002_created_at.sql"
        saved = step.read_bytes()
        step.write_bytes(saved + b"\nSELECT * FROM deliberately_missing_fixture;\n")
        self.assertNotEqual(self.cli("check", check=False).returncode, 0)
        with self.db() as db:
            self.assertEqual(db.execute("PRAGMA user_version").fetchone()[0], 0)
            self.assertNotIn("created_at", [r[1] for r in db.execute("PRAGMA table_info(launch_interest)")])
            self.assertEqual(db.execute("SELECT count(*) FROM launch_interest").fetchone()[0], 2)
        step.write_bytes(saved)
        self.cli("check")
        with self.db() as db:
            self.assertEqual(db.execute("PRAGMA user_version").fetchone()[0], 2)

    def test_version_one_and_future_schema(self):
        self.seed()
        with self.db() as db:
            db.execute("PRAGMA user_version=1")
        self.cli("check")
        with self.db() as db:
            self.assertEqual(db.execute("PRAGMA user_version").fetchone()[0], 2)
            db.execute("PRAGMA user_version=3")
        self.assertNotEqual(self.cli("check", check=False).returncode, 0)
        with self.db() as db:
            self.assertEqual(db.execute("PRAGMA user_version").fetchone()[0], 3)
            self.assertEqual(db.execute("SELECT count(*) FROM launch_interest").fetchone()[0], 2)


if __name__ == "__main__":
    unittest.main(argv=[sys.argv[0]])
