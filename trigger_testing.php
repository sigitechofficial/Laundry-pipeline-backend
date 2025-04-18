<?php
// Path to your working directory
$workingDir = '/home/fomino/testlaundaryb.fomino.ch';

// Absolute path to node and PM2 binaries
$nodeBinPath = '/home/fomino/.nvm/versions/node/v16.20.2/bin/node';

// Set the PATH environment variable explicitly
putenv("PATH=$nodeBinPath:" . getenv('PATH')); // Append nodeBinPath to system PATH

// Define the process name
$processName = 'thelaundary.js';

// Commands for PM2 management
$pm2StopDeleteCommand = "pm2 stop $processName || true && pm2 delete $processName || true";
$pm2CreateCommand = "npm install && pm2 start $processName";
$pm2SaveCommand = "pm2 save";

// Combine all commands (fix order of save command)
$command = "export PATH=$nodeBinPath:\$PATH && export HOME=/home/fomino && cd $workingDir && $pm2StopDeleteCommand && $pm2CreateCommand && $pm2SaveCommand 2>&1";

// Execute the command and capture the output
$output = shell_exec($command);

// Output the result for debugging
echo "<pre>";
echo "Command Output:\n";
echo htmlspecialchars($output);
echo "</pre>";
?>