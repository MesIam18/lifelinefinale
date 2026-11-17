<?php
$env = fn(string $k, mixed $default = null) => $_ENV[$k] ?? $_SERVER[$k] ?? (getenv($k) !== false ? getenv($k) : $default);

return [
    'db_host'    => $env('MYSQLHOST', '127.0.0.1'),
    'db_port'    => (int)$env('MYSQLPORT', 3306),
    'db_name'    => $env('MYSQLDATABASE', 'lifeline'),
    'db_user'    => $env('MYSQLUSER', 'lifeline_app'),
    'db_pass'    => $env('MYSQLPASSWORD', 'ChangeThisPassword!'),
    'db_charset' => 'utf8mb4',

    'timezone_offset' => '+08:00',

    'alert_cooldown_sec'      => 180,
    'max_active_per_reporter' => 3,
    'max_login_attempts'      => 5,
    'lockout_sec'             => 60,
];