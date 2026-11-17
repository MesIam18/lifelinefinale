<?php
return [
    'db_host'    => getenv('MYSQLHOST') ?: '127.0.0.1',
    'db_port'    => (int)(getenv('MYSQLPORT') ?: 3306),
    'db_name'    => getenv('MYSQLDATABASE') ?: 'lifeline',
    'db_user'    => getenv('MYSQLUSER') ?: 'lifeline_app',
    'db_pass'    => getenv('MYSQLPASSWORD') ?: 'ChangeThisPassword!',
    'db_charset' => 'utf8mb4',

    'timezone_offset' => '+08:00',

    'alert_cooldown_sec'      => 180,
    'max_active_per_reporter' => 3,
    'max_login_attempts'      => 5,
    'lockout_sec'             => 60,
];