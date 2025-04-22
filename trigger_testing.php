<?php
// Path to your working directory
$workingDir = '/home/fomino/testlaundaryb.fomino.ch';

// Absolute path to node and PM2 binaries
$nodeBinPath = '/home/fomino/.nvm/versions/node/v16.20.2/bin/';
$pm2BinPath = '/bin/pm2';

// Set the PATH environment variable explicitly to include both Node.js and PM2 paths
putenv("PATH=$nodeBinPath:$pm2BinPath:" . getenv('PATH')); // Append both node and pm2 bin paths

// Define the process name
$processName = 'thelaundary.js';

// Commands for PM2 management with full paths
$pm2StopDeleteCommand = "$pm2BinPath stop $processName || true && $pm2BinPath delete $processName || true";
$pm2CreateCommand = "$nodeBinPath/npm install && $pm2BinPath start $processName";
$pm2SaveCommand = "$pm2BinPath save";

// Combine all commands (fix order of save command)
$command = "export PATH=$nodeBinPath:$pm2BinPath:\$PATH && export HOME=/home/fomino && cd $workingDir && $pm2StopDeleteCommand && $pm2CreateCommand && $pm2SaveCommand 2>&1";

// Execute the command and capture the output
$output = shell_exec($command);

// Output the result for debugging
echo "<pre>";
echo "Command Output:\n";
echo htmlspecialchars($output);
echo "</pre>";
?>
