ALTER TABLE launch_interest ADD COLUMN created_at TEXT NOT NULL DEFAULT '';

UPDATE launch_interest SET created_at = consented_at;

-- A request already running the previous PHP code can still use its four-column INSERT.
CREATE TRIGGER launch_interest_legacy_created_at
AFTER INSERT ON launch_interest WHEN NEW.created_at = ''
BEGIN
    UPDATE launch_interest SET created_at = NEW.consented_at
    WHERE email = NEW.email AND phone = NEW.phone;
END;
