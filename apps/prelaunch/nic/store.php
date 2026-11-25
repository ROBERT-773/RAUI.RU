<?php
declare(strict_types=1);

function storePath(): string
{
    $private = realpath(__DIR__);
    $doc = realpath($_SERVER['DOCUMENT_ROOT'] ?? '');
    if ($private === false || (PHP_SAPI !== 'cli' && (!$doc || $private === $doc ||
        strpos($private . DIRECTORY_SEPARATOR, $doc . DIRECTORY_SEPARATOR) === 0))) {
        throw new RuntimeException('Private path unavailable');
    }
    $dir = $private . DIRECTORY_SEPARATOR . 'data';
    umask(0077);
    if (is_link($dir) || (!is_dir($dir) && !@mkdir($dir, 0700) && !is_dir($dir))) {
        throw new RuntimeException('Private directory unavailable');
    }
    if (DIRECTORY_SEPARATOR === '/' && ((fileperms($dir) & 0077) !== 0)) {
        throw new RuntimeException('Private permissions required');
    }
    return $dir;
}

function openStore(): PDO
{
    $dbPath = storePath() . DIRECTORY_SEPARATOR . 'contacts.sqlite';
    if (is_link($dbPath) || (file_exists($dbPath) &&
        (DIRECTORY_SEPARATOR === '/' && (fileperms($dbPath) & 0077) !== 0))) {
        throw new RuntimeException('Private database required');
    }
    $db = new PDO('sqlite:' . $dbPath, null, null, [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION]);
    $db->exec('PRAGMA busy_timeout = 5000');
    migrateStore($db);
    return $db;
}

function migrateStore(PDO $db): void
{
    $steps = [1 => '001_initial.sql', 2 => '002_created_at.sql'];
    $latest = count($steps);
    $version = (int)$db->query('PRAGMA user_version')->fetchColumn();
    if ($version === $latest) return;
    if ($version > $latest) throw new RuntimeException('Unsupported database version');
    $db->exec('BEGIN IMMEDIATE');
    try {
        // Another PHP worker may have completed the upgrade while this one waited.
        $version = (int)$db->query('PRAGMA user_version')->fetchColumn();
        if ($version < 0 || $version > $latest) throw new RuntimeException('Unsupported database version');
        foreach ($steps as $number => $name) {
            if ($number <= $version) continue;
            $source = file_get_contents(__DIR__ . '/migrations/' . $name);
            if ($source === false || trim($source) === '') throw new RuntimeException('Migration unavailable');
            $db->exec($source);
        }
        $db->exec('PRAGMA user_version = ' . $latest);
        $db->exec('COMMIT');
    } catch (Throwable $error) {
        $db->exec('ROLLBACK');
        throw $error;
    }
}

function validContacts($body): ?array
{
    if (!is_array($body) || count($body) !== 3 || ($body['consent'] ?? null) !== true ||
        !is_string($body['email'] ?? null) || !is_string($body['phone'] ?? null)) return null;
    $email = strtolower(trim($body['email']));
    $emailPattern = "~^(?:[A-Za-z0-9_'+\\-]+\\.)*[A-Za-z0-9_'+\\-]*[A-Za-z0-9_+-]@(?:[A-Za-z0-9][A-Za-z0-9\\-]*\\.)+[A-Za-z]{2,}$~D";
    if (strlen($email) > 254 || !preg_match($emailPattern, $email) || strlen($body['phone']) > 64) return null;
    $compact = preg_replace('/[\s()-]/u', '', $body['phone']);
    if (!is_string($compact)) return null;
    $phone = preg_replace('/^8([0-9]{10})$/D', '+7$1', $compact);
    if (!preg_match('/^\+(?:7[0-9]{10}|[1-689][0-9]{7,14})$/D', $phone)) return null;
    return [$email, $phone];
}

function takeQuota(PDO $db, string $key, int $limit, int $now): bool
{
    $q = $db->prepare('SELECT amount,ends FROM launch_quota WHERE k=?');
    $q->execute([$key]);
    $row = $q->fetch(PDO::FETCH_ASSOC);
    $amount = $row ? (int)$row['amount'] : 0;
    if ($amount >= $limit) return false;
    $db->prepare('INSERT OR REPLACE INTO launch_quota(k,amount,ends) VALUES(?,?,?)')
        ->execute([$key, $amount + 1, $row ? (int)$row['ends'] : $now + 60]);
    return true;
}

function handleSubmission(PDO $db, string $peer, int $inputStatus, ?array $contacts): int
{
    $now = time();
    $db->exec('BEGIN IMMEDIATE');
    try {
        $db->prepare('DELETE FROM launch_quota WHERE ends <= ?')->execute([$now]);
        $salt = $db->query("SELECT v FROM launch_settings WHERE k='quota-key'")->fetchColumn();
        if ($salt === false) {
            $salt = bin2hex(random_bytes(32));
            $db->prepare("INSERT INTO launch_settings(k,v) VALUES('quota-key',?)")->execute([$salt]);
        }
        if (!takeQuota($db, 'all', 300, $now) ||
            !takeQuota($db, hash_hmac('sha256', $peer, $salt), 30, $now)) {
            $status = 429;
        } elseif ($inputStatus !== 200 || $contacts === null) {
            $status = $inputStatus === 200 ? 400 : $inputStatus;
        } else {
            $stamp = gmdate('Y-m-d\TH:i:s\Z', $now);
            $db->prepare('INSERT OR IGNORE INTO launch_interest(email,phone,consent_version,consented_at,created_at) VALUES (?,?,?,?,?)')
                ->execute([$contacts[0], $contacts[1], 'launch-notice-v1', $stamp, $stamp]);
            $status = 201;
        }
        $db->exec('COMMIT');
        return $status;
    } catch (Throwable $error) {
        $db->exec('ROLLBACK');
        throw $error;
    }
}
