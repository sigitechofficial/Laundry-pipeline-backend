<?php
header('Content-Type: text/plain');

echo "USER: " . get_current_user() . PHP_EOL;
echo "WHOAMI: " . shell_exec('whoami') . PHP_EOL;
echo "PWD: " . shell_exec('pwd') . PHP_EOL;

echo "\n---- PATH ----\n";
echo shell_exec('echo $PATH');

echo "\n---- WHICH node ----\n";
echo shell_exec('which node 2>&1');

echo "\n---- WHICH npm ----\n";
echo shell_exec('which npm 2>&1');

echo "\n---- WHICH pm2 ----\n";
echo shell_exec('which pm2 2>&1');

echo "\n---- NODE VERSION ----\n";
echo shell_exec('node -v 2>&1');

echo "\n---- PM2 VERSION ----\n";
echo shell_exec('pm2 -v 2>&1');
