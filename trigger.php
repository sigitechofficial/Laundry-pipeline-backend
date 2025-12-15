<?php
// Enable error reporting for debugging
ini_set('display_errors', 1);
error_reporting(E_ALL);

// Path to your working directory
$workingDir = '/home/sigisolutions/laundaryb.sigisolutions.net';

// Set up the correct environment variables for the shell
$nodeBinPath = '/home/sigisolutions/.nvm/versions/node/v16.20.2/bin';
$npmCommand = "source /home/sigisolutions/.nvm/nvm.sh && export HOME=/home/fomino && cd $workingDir && npm install";

// Command to stop, delete, and restart the PM2 process
$pm2Command = "source /home/sigisolutions/.nvm/nvm.sh && export HOME=/home/sigisolutions && pm2 stop thelaundary || true && pm2 delete thelaundary || true && pm2 start $workingDir/thelaundary.js --name thelaundary && pm2 save";

// Set the PATH environment variable explicitly using putenv()
putenv("PATH=$nodeBinPath:" . getenv('PATH'));

// Run the npm install command and capture output
$process = proc_open($npmCommand, [
    0 => ["pipe", "r"],  // stdin
    1 => ["pipe", "w"],  // stdout
    2 => ["pipe", "w"],  // stderr
], $pipes);

// Check if the npm install process started successfully
if (is_resource($process)) {
    $installOutput = stream_get_contents($pipes[1]);
    fclose($pipes[1]);
    fclose($pipes[2]);
    proc_close($process);

    echo "NPM install completed successfully.<br>";
    echo nl2br($installOutput);

    // Run the PM2 command to stop, delete, and start the PM2 process
    $pm2Process = proc_open($pm2Command, [
        0 => ["pipe", "r"],  // stdin
        1 => ["pipe", "w"],  // stdout
        2 => ["pipe", "w"],  // stderr
    ], $pm2Pipes);

    if (is_resource($pm2Process)) {
        $pm2Output = stream_get_contents($pm2Pipes[1]);
        fclose($pm2Pipes[1]);
        fclose($pm2Pipes[2]);
        proc_close($pm2Process);

        echo "PM2 command completed successfully.<br>";
        echo nl2br($pm2Output);
    } else {
        echo "Failed to run PM2 command.<br>";
    }
} else {
    echo "Failed to run npm install.<br>";
}
?>