<?php
ini_set('display_errors', 1);
error_reporting(E_ALL);

/**
 * IMPORTANT PATHS
 */
$workingDir = '/home/sigisolutions/laundarybackend.sigisolutions.net';
$nvmDir     = '/home/sigisolutions/.nvm';
$nodeBin    = '/home/sigisolutions/.nvm/versions/node/v16.20.2/bin';

/**
 * ENV SETUP
 */
putenv("NVM_DIR=$nvmDir");
putenv("PATH=$nodeBin:" . getenv('PATH'));
putenv("HOME=/home/sigisolutions");

/**
 * COMMANDS
 */
$npmCommand = "
source $nvmDir/nvm.sh
cd $workingDir
npm install
";

$pm2Command = "
source $nvmDir/nvm.sh
pm2 stop thelaundary || true
pm2 delete thelaundary || true
pm2 start $workingDir/thelaundary.js --name thelaundary
pm2 save
";

/**
 * RUN NPM INSTALL
 */
echo '<pre>';
system($npmCommand, $npmStatus);

if ($npmStatus !== 0) {
    echo "\n❌ npm install failed\n";
    exit(1);
}

echo "\n✅ npm install completed\n";

/**
 * RUN PM2
 */
system($pm2Command, $pm2Status);

if ($pm2Status !== 0) {
    echo "\n❌ PM2 command failed\n";
    exit(1);
}

echo "\n✅ PM2 restarted successfully\n";
echo '</pre>';
