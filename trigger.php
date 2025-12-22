<?php
ini_set('display_errors', 1);
error_reporting(E_ALL);

/**
 * PATHS
 */
$HOME = '/home/sigisolutions';
$WORKDIR = $HOME . '/prodlaundry.sigisolutions.net';
$NVM_DIR = $HOME . '/.nvm';

/**
 * DEPLOY SCRIPT
 */
$script = <<<BASH
#!/bin/bash
export HOME=$HOME
export NVM_DIR="$NVM_DIR"

source \$NVM_DIR/nvm.sh
nvm use 16

cd "$WORKDIR" || exit 1

echo "Running npm install..."
npm install

echo "Restarting PM2..."
pm2 delete laundary || true
pm2 start laundary.js --name laundary
pm2 save

echo "DONE"
BASH;

/**
 * WRITE TEMP SCRIPT
 */
$tmp = '/tmp/deploy_laundary.sh';
file_put_contents($tmp, $script);
chmod($tmp, 0700);

/**
 * EXECUTE
 */
header('Content-Type: text/plain');
echo shell_exec("bash $tmp 2>&1");
