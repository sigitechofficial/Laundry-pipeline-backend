<?php
// Enable error reporting for debugging
ini_set('display_errors', 1);
error_reporting(E_ALL);

// Path to your working directory
$workingDir = '/home/fomino/stagelaundaryb.fomino.ch';

// Set up the correct environment variables for the shell
$nodeBinPath = '/home/fomino/.nvm/versions/node/v16.20.2/bin';

// Set the PATH environment variable explicitly using putenv()
putenv("PATH=$nodeBinPath:" . getenv('PATH'));
 
// Command to run npm install
$npmCommand = "source /home/fomino/.nvm/nvm.sh && export HOME=/home/fomino && cd $workingDir && npm install";

// Command to stop, delete, and restart the PM2 process
$pm2Command = "pm2 stop testing || true && pm2 delete testing || true && pm2 start thelaundary.js --name testing && pm2 save";

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

} else {
    echo "Failed to run npm install.<br>";
}
?>