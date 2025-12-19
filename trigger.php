<?php
// Enable error reporting for debugging
ini_set('display_errors', 1);
error_reporting(E_ALL);

// ===== PATHS =====
$workingDir = '/home/sigisolutions/laundarybackend.sigisolutions.net';

// ✅ Node v20.19.6 (AS FOUND ON SERVER)
$nodeBinPath = '/home/sigisolutions/.nvm/versions/node/v20.19.6/bin';

// ===== COMMANDS (SAME AS OLD SERVER) =====
$npmCommand = "source /home/sigisolutions/.nvm/nvm.sh && export HOME=/home/sigisolutions && cd $workingDir && npm install";

$pm2Command = "source /home/sigisolutions/.nvm/nvm.sh && export HOME=/home/sigisolutions && pm2 stop laundary || true && pm2 delete laundary || true && pm2 start $workingDir/laundary.js --name laundary && pm2 save";

// ===== SET PATH (CRITICAL) =====
putenv("PATH=$nodeBinPath:" . getenv('PATH'));

// ===== RUN NPM INSTALL =====
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

    echo "NPM install completed.\n";
    echo $installOutput . "\n";
    echo $installError . "\n";

    // ===== RUN PM2 COMMAND =====
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

        echo "PM2 command completed.\n";
        echo $pm2Output . "\n";
        echo $pm2Error . "\n";
    } else {
        echo "Failed to run PM2 command.\n";
    }

} else {
    echo "Failed to run npm install.\n";
}
?>