<?php
ini_set('display_errors', 1);
error_reporting(E_ALL);

header('Content-Type: text/plain');

// ===== CONFIG =====
$workingDir = '/home/sigisolutions/laundarybackend.sigisolutions.net';

// ✅ Node 18 paths (MATCH PIPELINE)
$node = '/home/sigisolutions/.nvm/versions/node/v18.20.4/bin/node';
$npm  = '/home/sigisolutions/.nvm/versions/node/v18.20.4/bin/npm';
$pm2  = '/home/sigisolutions/.nvm/versions/node/v18.20.4/bin/pm2';

$processName = 'laundary';
$entryFile   = 'laundary.js';

// ===== COMMAND =====
$command = "
export HOME=/home/sigisolutions
export PATH=/home/sigisolutions/.nvm/versions/node/v18.20.4/bin:\$PATH
cd $workingDir || exit 1
$npm install
$pm2 reload $processName || $pm2 start $entryFile --name $processName
$pm2 save
";

// ===== EXECUTE =====
$output = shell_exec($command . " 2>&1");

echo $output;
