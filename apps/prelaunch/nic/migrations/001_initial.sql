CREATE TABLE IF NOT EXISTS launch_interest (
    email TEXT NOT NULL,
    phone TEXT NOT NULL,
    consent_version TEXT NOT NULL,
    consented_at TEXT NOT NULL,
    PRIMARY KEY(email, phone)
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS launch_quota (
    k TEXT PRIMARY KEY,
    amount INTEGER NOT NULL,
    ends INTEGER NOT NULL
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS launch_settings (
    k TEXT PRIMARY KEY,
    v TEXT NOT NULL
) WITHOUT ROWID;
