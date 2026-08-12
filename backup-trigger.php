<?php
/**
 * One-shot pre-migration backup trigger (stage or prod docroot).
 * Runs scripts/pre-migration-full-backup.sh on the VPS (backs up BOTH stage + prod).
 *
 * Usage:
 *   curl -fsS "https://stagelaundry.sigisolutions.net/backup-trigger.php?token=YOUR_TOKEN"
 *
 * Protect with token — do not leave world-open without token.
 */
ini_set('display_errors', 1);
error_reporting(E_ALL);
set_time_limit(0);
ignore_user_abort(true);

$tokenExpected = getenv('LAUNDRY_BACKUP_TRIGGER_TOKEN');
if (!$tokenExpected) {
    // Fallback file next to this script (optional). Prefer env.
    $tokenFile = __DIR__ . '/.backup-trigger-token';
    if (is_readable($tokenFile)) {
        $tokenExpected = trim((string) file_get_contents($tokenFile));
    }
}

$provided = isset($_GET['token']) ? (string) $_GET['token'] : '';
if (!$tokenExpected || !hash_equals($tokenExpected, $provided)) {
    http_response_code(403);
    header('Content-Type: text/plain; charset=utf-8');
    echo "Forbidden\n";
    exit(1);
}

$candidates = [
    '/home/sigisolutions/deployments/laundry-pre-migration-backups/pre-migration-full-backup.sh',
    __DIR__ . '/scripts/pre-migration-full-backup.sh',
    '/home/sigisolutions/stagelaundry.sigisolutions.net/scripts/pre-migration-full-backup.sh',
    '/home/sigisolutions/prodlaundry.sigisolutions.net/scripts/pre-migration-full-backup.sh',
];

$script = null;
foreach ($candidates as $path) {
    if (is_readable($path)) {
        $script = $path;
        break;
    }
}

if ($script === null) {
    http_response_code(500);
    header('Content-Type: text/plain; charset=utf-8');
    echo "Backup script not found\n";
    exit(1);
}

header('Content-Type: text/plain; charset=utf-8');
echo "Using script: {$script}\n";
echo "Started at UTC: " . gmdate('c') . "\n";
flush();

$cmd = 'export HOME=/home/sigisolutions; bash ' . escapeshellarg($script) . ' 2>&1';
$descriptors = [
    0 => ['pipe', 'r'],
    1 => ['pipe', 'w'],
    2 => ['pipe', 'w'],
];
$process = proc_open($cmd, $descriptors, $pipes);
if (!is_resource($process)) {
    http_response_code(500);
    echo "Failed to start backup process\n";
    exit(1);
}

fclose($pipes[0]);
$stdout = stream_get_contents($pipes[1]);
$stderr = stream_get_contents($pipes[2]);
fclose($pipes[1]);
fclose($pipes[2]);
$code = proc_close($process);

echo $stdout;
if ($stderr) {
    echo "\n--- STDERR ---\n";
    echo $stderr;
}
echo "\nExit code: {$code}\n";
echo "Finished at UTC: " . gmdate('c') . "\n";

if ($code !== 0) {
    http_response_code(500);
    exit(1);
}
