<?php
declare(strict_types=1);

@ini_set('display_errors', '0');
header_remove('X-Powered-By');
header('Content-Type: application/json; charset=utf-8');
header('Cache-Control: private, no-store');
header('X-Content-Type-Options: nosniff');

function sendResult(int $status): void
{
    http_response_code($status);
    if ($status === 429) header('Retry-After: 60');
    echo $status === 201 ? '{"accepted":true}' : '{"accepted":false}';
    exit;
}

if (($_SERVER['REQUEST_METHOD'] ?? '') !== 'POST') {
    header('Allow: POST');
    sendResult(405);
}
$host = strtolower($_SERVER['HTTP_HOST'] ?? '');
if (!in_array($host, ['raui.ru', 'www.raui.ru'], true) ||
    (strtolower($_SERVER['HTTPS'] ?? '') !== 'on' && ($_SERVER['SERVER_PORT'] ?? '') != 443)) sendResult(403);
if (isset($_SERVER['HTTP_ORIGIN']) && $_SERVER['HTTP_ORIGIN'] !== 'https://' . $host) sendResult(403);
$peer = $_SERVER['REMOTE_ADDR'] ?? '';
if (filter_var($peer, FILTER_VALIDATE_IP) === false) sendResult(503);

try {
    $private = dirname(__DIR__, 2) . '/raui-prelaunch-private/store.php';
    if (!is_readable($private)) sendResult(503);
    require $private;
    $type = strtolower(trim(explode(';', $_SERVER['CONTENT_TYPE'] ?? '')[0]));
    $status = 200;
    $contacts = null;
    if ($type !== 'application/json') $status = 415;
    elseif ((int)($_SERVER['CONTENT_LENGTH'] ?? 0) > 4096) $status = 413;
    else {
        $raw = file_get_contents('php://input', false, null, 0, 4097);
        if ($raw === false || strlen($raw) > 4096) $status = 413;
        else $contacts = validContacts(json_decode($raw, true, 12));
    }
    sendResult(handleSubmission(openStore(), $peer, $status, $contacts));
} catch (Throwable $error) {
    sendResult(503);
}
