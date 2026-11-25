<?php
declare(strict_types=1);
if (PHP_SAPI !== 'cli') { http_response_code(404); exit; }
@ini_set('display_errors', '0');
require __DIR__ . '/store.php';

function spreadsheetCell(string $value): string
{
    return preg_match('/^[\s]*[=+@-]|^[\t\r\n]/', $value) ? "'" . $value : $value;
}

try {
    $command = $argv[1] ?? 'check';
    if (!in_array($command, ['check', 'export', 'export-jsonl'], true)) throw new RuntimeException('Unsupported command');
    $db = openStore();
    if ($command === 'check') {
        $db->exec('BEGIN IMMEDIATE');
        $db->exec('ROLLBACK');
        echo "Storage and write lock OK\n";
        exit(0);
    }
    $dir = storePath() . DIRECTORY_SEPARATOR . 'exports';
    if (is_link($dir) || (!is_dir($dir) && !@mkdir($dir, 0700) && !is_dir($dir))) throw new RuntimeException('Export directory unavailable');
    if (DIRECTORY_SEPARATOR === '/' && (fileperms($dir) & 0077) !== 0) throw new RuntimeException('Private permissions required');
    $id = bin2hex(random_bytes(16));
    $jsonl = $command === 'export-jsonl';
    $name = 'contacts-' . $id . ($jsonl ? '.jsonl' : '.csv');
    $temp = $dir . DIRECTORY_SEPARATOR . '.' . $id . '.partial';
    $out = fopen($temp, 'xb');
    if ($out === false) throw new RuntimeException('Export unavailable');
    try {
        $columns = ['email', 'phone', 'consented_at', 'consent_version'];
        if ($jsonl) {
            $columns[] = 'created_at';
        } else {
            if (fwrite($out, "\xEF\xBB\xBF") !== 3) throw new RuntimeException('Incomplete export');
            if (fputcsv($out, $columns, ',', '"', '') === false) throw new RuntimeException('Incomplete export');
        }
        $db->beginTransaction();
        $rows = $db->query('SELECT ' . implode(',', $columns) . ' FROM launch_interest ORDER BY consented_at,email,phone');
        $count = 0;
        while ($row = $rows->fetch(PDO::FETCH_ASSOC)) {
            if ($jsonl) {
                $line = json_encode($row, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES | JSON_THROW_ON_ERROR) . "\n";
                if (fwrite($out, $line) !== strlen($line)) throw new RuntimeException('Incomplete export');
            } elseif (fputcsv($out, array_map('spreadsheetCell', $row), ',', '"', '') === false) {
                throw new RuntimeException('Incomplete export');
            }
            $count++;
        }
        $db->commit();
        if (!fflush($out)) throw new RuntimeException('Incomplete export');
        fclose($out);
        if (!rename($temp, $dir . DIRECTORY_SEPARATOR . $name)) throw new RuntimeException('Export unavailable');
        echo $name . ' (' . $count . ")\n";
    } finally {
        if (is_resource($out)) fclose($out);
        if (file_exists($temp)) unlink($temp);
    }
} catch (Throwable $error) {
    fwrite(STDERR, "Operation failed. Check PDO SQLite, private path, file permissions and storage capacity.\n");
    exit(1);
}
