<?php
$env = static function (string $key, mixed $default = null): mixed {
    $val = $_ENV[$key] ?? $_SERVER[$key] ?? getenv($key);
    if ($val === false || $val === null || trim((string)$val) === '') {
        return $default;
    }
    return trim((string)$val);
};

$host = $env('MYSQLHOST');
$port = $env('MYSQLPORT');
$name = $env('MYSQLDATABASE');
$user = $env('MYSQLUSER');
$pass = $env('MYSQLPASSWORD');

$url = $env('MYSQL_URL') ?? $env('MYSQL_PUBLIC_URL');
if (!$host && $url) {
    $parts = parse_url($url);
    if (is_array($parts)) {
        $host = $parts['host'] ?? $host;
        $port = isset($parts['port']) ? (string)$parts['port'] : $port;
        $name = isset($parts['path']) ? ltrim($parts['path'], '/') : $name;
        $user = $parts['user'] ?? $user;
        $pass = $parts['pass'] ?? $pass;
    }
}

return [
    'db_host'    => $host ?: '127.0.0.1',
    'db_port'    => (int)($port ?: 3306),
    'db_name'    => $name ?: 'lifeline',
    'db_user'    => $user ?: 'lifeline_app',
    'db_pass'    => $pass ?? 'ChangeThisPassword!',
    'db_charset' => 'utf8mb4',

    'timezone_offset' => '+08:00',

    'alert_cooldown_sec'      => 180,
    'max_active_per_reporter' => 3,
    'max_login_attempts'      => 5,
    'lockout_sec'             => 60,
];