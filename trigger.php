<?php
// Enable error reporting
ini_set('display_errors', 1);
error_reporting(E_ALL);

// ================= PATHS =================

// Project working directory
$workingDir = '/home/sigisolutions/laundarybackend.sigisolutions.net';

// Explicit PATH (no NVM needed)
putenv("PATH=/bin:/usr/bin:/usr/local/bin");
putenv("HOME=/home/sigisolutions");

// ================= COMMANDS =================

// npm install
$npmCommand = "cd $workingDir && /bin/npm install 2>&1";

// pm2 restart
$pm2Command = "
cd $workingDir &&
/usr/local/bin/pm2 stop thelaundary || true &&
/usr/local/bin/pm2 delete thelaundary || true &&
/usr/local/bin/pm2 start $workingDir/thelaundary.js --name thelaundary &&
/usr/local/bin/pm2 save 2>&1
";

// ================= RUN NPM INSTALL =================

$process = proc_open($npmCommand, [
    0 => ["pipe", "r"],
    1 => ["pipe", "w"],
    2 => ["pipe", "w"],
], $pipes);

if (is_resource($process)) {

    $npmOutput = stream_get_contents($pipes[1]);
    $npmError  = stream_get_contents($pipes[2]);

    fclose($pipes[1]);
    fclose($pipes[2]);
    proc_close($process);

    echo "<h3>NPM Install Output</h3>";
    echo "<pre>" . htmlspecialchars($npmOutput . $npmError) . "</pre>";

    // ================= RUN PM2 =================

    $pm2Process = proc_open($pm2Command, [
        0 => ["pipe", "r"],
        1 => ["pipe", "w"],
        2 => ["pipe", "w"],
    ], $pm2Pipes);

    if (is_resource($pm2Process)) {

        $pm2Output = stream_get_contents($pm2Pipes[1]);
        $pm2Error  = stream_get_contents($pm2Pipes[2]);

        fclose($pm2Pipes[1]);
        fclose($pm2Pipes[2]);
        proc_close($pm2Process);

        echo "<h3>PM2 Output</h3>";
        echo "<pre>" . htmlspecialchars($pm2Output . $pm2Error) . "</pre>";
        echo "<strong>✅ Deployment completed successfully</strong>";

    } else {
        echo "❌ Failed to execute PM2 command";
    }

} else {
    echo "❌ Failed to execute npm install";
}
?>
