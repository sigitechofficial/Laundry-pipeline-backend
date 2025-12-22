<?php
// Enable error reporting for debugging
ini_set('display_errors', 1);
error_reporting(E_ALL);

header('Content-Type: text/plain');

// ===== CONFIG =====
$workingDir = '/home/sigisolutions/prodlaundry.sigisolutions.net';
$nodeBinPath = '/home/sigisolutions/.nvm/versions/node/v20.19.6/bin';

// ===== ENV =====
putenv("HOME=/home/sigisolutions");
putenv("PATH=$nodeBinPath:" . getenv('PATH'));

// ===== EXACT SAME COMMAND (AS TERMINAL) =====
$command = "
cd $workingDir && \
npm install && \
pm2 reload laundary || pm2 start laundary.js --name laundary && \
pm2 save
";

// ===== RUN =====
$output = shell_exec($command . " 2>&1");

echo $output;