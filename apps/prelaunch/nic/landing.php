<?php
declare(strict_types=1);
@ini_set('display_errors', '0');
header_remove('X-Powered-By');
$host = strtolower($_SERVER['HTTP_HOST'] ?? '');
if (!in_array($host, ['raui.ru', 'www.raui.ru'], true)) { http_response_code(404); exit; }
if (!in_array($_SERVER['REQUEST_METHOD'] ?? '', ['GET', 'HEAD'], true)) {
    http_response_code(405); header('Allow: GET, HEAD'); exit;
}
if (strtolower($_SERVER['HTTPS'] ?? '') !== 'on' && ($_SERVER['SERVER_PORT'] ?? '') != 443) {
    $entry = ($_SERVER['SCRIPT_NAME'] ?? '') === '/raui-prelaunch-20261126/landing.php'
        ? '/raui-prelaunch-20261126/landing.php' : '/';
    header('Location: https://' . $host . $entry, true, 302);
    exit;
}
header('Content-Type: text/html; charset=utf-8');
header('Cache-Control: no-cache');
header('X-Content-Type-Options: nosniff');
header('Referrer-Policy: no-referrer');
header("Content-Security-Policy: default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'");
$file = dirname(__DIR__, 2) . '/raui-prelaunch-private/page.html';
if (!is_readable($file)) { http_response_code(503); exit; }
if ($_SERVER['REQUEST_METHOD'] === 'GET') readfile($file);
