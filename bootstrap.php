<?php
declare(strict_types=1);

if (session_status() === PHP_SESSION_NONE) {
    session_set_cookie_params([
        'lifetime' => 0,
        'path'     => '/',
        'httponly' => true,
        'samesite' => 'Lax',
    ]);
    session_start();
}

header('Content-Type: application/json; charset=utf-8');

set_exception_handler(function (Throwable $e): void {
    error_log('[lifeline] ' . $e->getMessage() . ' in ' . $e->getFile() . ':' . $e->getLine());
    if (!headers_sent()) {
        http_response_code(500);
        header('Content-Type: application/json; charset=utf-8');
    }
    echo json_encode([
        'error' => 'Server error: ' . $e->getMessage(),
    ], JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
    exit;
});

const ID_REGEX = '/^2\d-\d{4}-\d{3}$/';

function cfg(string $key): mixed
{
    static $config = null;
    if ($config === null) {
        $file = __DIR__ . '/config.php';
        $loaded = is_file($file) ? require $file : [];
        $config = array_merge([
            'db_host'            => '127.0.0.1',
            'db_port'            => 3306,
            'db_name'            => 'lifeline',
            'db_user'            => 'root',
            'db_pass'            => '',
            'max_login_attempts' => 5,
            'lockout_sec'        => 300,
        ], is_array($loaded) ? $loaded : []);
    }
    return $config[$key] ?? null;
}

function db(): PDO
{
    static $pdo = null;
    if ($pdo === null) {
        $dsn = sprintf(
            'mysql:host=%s;port=%d;dbname=%s;charset=utf8mb4',
            cfg('db_host'),
            (int)cfg('db_port'),
            cfg('db_name')
        );
        $pdo = new PDO($dsn, (string)cfg('db_user'), (string)cfg('db_pass'), [
            PDO::ATTR_ERRMODE            => PDO::ERRMODE_EXCEPTION,
            PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
            PDO::ATTR_EMULATE_PREPARES   => false,
        ]);
        $tz = cfg('timezone_offset') ?: '+08:00';
        $pdo->exec("SET time_zone = " . $pdo->quote($tz));
    }
    return $pdo;
}

function table_columns(PDO $pdo, string $table): array
{
    static $cache = [];
    if (!isset($cache[$table])) {
        $cols = [];
        foreach ($pdo->query("SHOW COLUMNS FROM `{$table}`")->fetchAll() as $row) {
            $cols[$row['Field']] = $row;
        }
        $cache[$table] = $cols;
    }
    return $cache[$table];
}

function out(array $data, int $status = 200): never
{
    http_response_code($status);
    echo json_encode($data, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
    exit;
}

function fail(string $message, int $status = 400, ?string $code = null): never
{
    $payload = ['error' => $message];
    if ($code !== null) {
        $payload['code'] = $code;
    }
    out($payload, $status);
}

function require_method(string $expected): void
{
    if (strtoupper($_SERVER['REQUEST_METHOD'] ?? '') !== strtoupper($expected)) {
        fail('Method not allowed.', 405);
    }
}

function body(): array
{
    $raw = file_get_contents('php://input');
    if ($raw === false || trim($raw) === '') {
        return $_POST ?: [];
    }
    $decoded = json_decode($raw, true);
    return is_array($decoded) ? $decoded : [];
}

function clean_text(mixed $value, int $maxLen): string
{
    $str = trim((string)$value);
    $str = preg_replace('/[\x00-\x1F\x7F]/u', ' ', $str) ?? '';
    $str = preg_replace('/\s+/u', ' ', $str) ?? '';
    return mb_substr(trim($str), 0, $maxLen);
}

function load_user(string $studentId): ?array
{
    $st = db()->prepare(
        "SELECT u.student_id, u.full_name, u.course, u.role, u.is_active,
                u.birthdate, u.address, u.emergency_contact,
                m.duty_status, s.name AS squad_name, z.name AS zone_name
         FROM users u
         LEFT JOIN cpr_members m ON m.student_id = u.student_id
         LEFT JOIN squads s ON s.id = m.squad_id
         LEFT JOIN zones z ON z.id = m.zone_id
         WHERE u.student_id = ?"
    );
    $st->execute([$studentId]);
    $row = $st->fetch();
    if (!$row || !(int)$row['is_active']) {
        return null;
    }
    return $row;
}

function current_user(): ?array
{
    $sid = $_SESSION['sid'] ?? null;
    if (!is_string($sid) || $sid === '' || $sid === '00-0000-000') {
        return null;
    }
    $u = load_user($sid);
    if (!$u) {
        unset($_SESSION['sid']);
        return null;
    }
    return $u;
}

function require_login(): array
{
    $u = current_user();
    if (!$u) {
        fail('Authentication required. Please sign in.', 401, 'unauthenticated');
    }
    return $u;
}

function is_officer(array $u): bool
{
    return in_array($u['role'], ['officer', 'admin'], true);
}

function require_officer(array $u): void
{
    if (!is_officer($u)) {
        fail('CPR Officer privileges required.', 403, 'forbidden');
    }
}

function require_responder(array $u): void
{
    if (!in_array($u['role'], ['member', 'officer', 'admin'], true)) {
        fail('CPR Responder privileges required.', 403, 'forbidden');
    }
}

function user_payload(array $u): array
{
    return [
        'studentId'        => $u['student_id'],
        'name'             => $u['full_name'],
        'course'           => $u['course'] ?? 'BS Information Technology',
        'role'             => $u['role'],
        'birthdate'        => $u['birthdate'] ?? null,
        'address'          => $u['address'] ?? null,
        'emergencyContact' => $u['emergency_contact'] ?? null,
        'squad'            => $u['squad_name'] ?? null,
        'zone'             => $u['zone_name'] ?? null,
        'dutyStatus'       => $u['duty_status'] ?? 'On Duty',
    ];
}

function insert_guest_row(PDO $pdo, string $guestId): void
{
    $cols   = table_columns($pdo, 'users');
    $fields = ['student_id', 'full_name'];
    $values = [$guestId, 'Campus Guest'];

    if (isset($cols['course'])) {
        $fields[] = 'course';
        $values[] = 'Guest / Visitor';
    }
    if (isset($cols['role'])) {
        $fields[] = 'role';
        $roleType = strtolower((string)($cols['role']['Type'] ?? ''));
        $values[] = str_contains($roleType, "'student'") ? 'student' : 'user';
    }
    if (isset($cols['password_hash']) && ($cols['password_hash']['Null'] ?? 'YES') === 'NO' && $cols['password_hash']['Default'] === null) {
        $fields[] = 'password_hash';
        $values[] = '';
    }
    if (isset($cols['is_active'])) {
        $fields[] = 'is_active';
        $values[] = 1;
    }

    $colSql = implode(', ', array_map(fn($c) => "`{$c}`", $fields));
    $phSql  = implode(', ', array_fill(0, count($values), '?'));
    $pdo->prepare("INSERT IGNORE INTO users ({$colSql}) VALUES ({$phSql})")->execute($values);
}

function ensure_guest_reporter(PDO $pdo): string
{
    foreach (['00-0000-000', '20-0000-000'] as $candidate) {
        $chk = $pdo->prepare('SELECT student_id FROM users WHERE student_id = ?');
        $chk->execute([$candidate]);
        if ($chk->fetchColumn()) {
            return $candidate;
        }
        try {
            insert_guest_row($pdo, $candidate);
            return $candidate;
        } catch (PDOException) {
            // Try next candidate if constraint rejects format
        }
    }
    fail('Unable to initialize guest reporter account in database.', 500);
}