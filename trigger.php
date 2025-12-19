<?php
// Enable error reporting for debugging
ini_set('display_errors', 1);
error_reporting(E_ALL);

// ===== PATHS =====
$workingDir = '/home/sigisolutions/laundarybackend.sigisolutions.net';
$nodeBinPath = '/home/sigisolutions/.nvm/versions/node/v20.19.6/bin';

// ===== ENV =====
putenv("PATH=$nodeBinPath:" . getenv('PATH'));
putenv("HOME=/home/sigisolutions");

// ===== COMMAND (ZERO DOWNTIME) =====
$command = "
cd $workingDir || exit 1
npm install
pm2 reload laundary || pm2 start laundary.js --name laundary
pm2 save
";

// ===== RUN =====
$output = shell_exec($command . " 2>&1");

header('Content-Type: text/plain');
echo $output;
