<?php
// Enable error reporting (disable display_errors in production if desired)
ini_set('display_errors', 1);
error_reporting(E_ALL);

// ===== CONFIG =====
$workingDir = '/home/sigisolutions/laundarybackend.sigisolutions.net';
$processName = 'laundary';
$nodeEntry = 'laundary.js';
$nvmScript = '/home/sigisolutions/.nvm/nvm.sh';

// ===== BUILD COMMAND =====
$command = <<<CMD
source $nvmScript &&
export HOME=/home/sigisolutions &&
cd $workingDir &&
npm install &&
pm2 reload $processName || pm2 start $nodeEntry --name $processName &&
pm2 save
CMD;

// Run command in a login shell so NVM works
$output = shell_exec("bash -lc " . escapeshellarg($command) . " 2>&1");

// Output result for GitHub Actions logs
header('Content-Type: text/plain');
echo $output;
