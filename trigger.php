<?php
// Enable error reporting for debugging
ini_set('display_errors', 1);
error_reporting(E_ALL);

// Path to your working directory
$workingDir = '/home/sigisolutions/laundarybackend.sigisolutions.net';

// Explicit PATH (no NVM)
putenv("PATH=/bin:/usr/bin:/usr/local/bin");

// Commands (using system node & npm)
$npmCommand = "cd $workingDir && /bin/npm install 2>&1";

$pm2Command = "
cd $workingDir &&
/bin/pm2 stop thelaundary || true &&
/bin/pm2 delete thelaundary || true &&
/bin/pm2 start $workingDir/thelaundary.js --name thelaundary &&
/bin/pm2 save 2>&1
";

// Run npm install
$process = proc_open($npmCommand, [
    0 => ["pipe", "r"],
    1 => ["pipe", "w"],
    2 => ["pipe", "w"],
], $pipes);

if (is_resource($process)) {
    $installOutput = stream_get_contents($pipes[1]);
    $installError  = stream_get_contents($pipes[2]);

    fclose($pipes[1]);
    fclose($pipes[2]);
    proc_close($process);

    echo "<h3>NPM install output</h3>";
    echo "<pre>" . htmlspecialchars($installOutput . $installError) . "</pre>";

    // Run PM2
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

        echo "<h3>PM2 output</h3>";
        echo "<pre>" . htmlspecialchars($pm2Output . $pm2Error) . "</pre>";
        echo "<strong>Deployment completed successfully</strong>";
    } else {
        echo "Failed to run PM2 command.";
    }
} else {
    echo "Failed to run npm install.";
}
?>
