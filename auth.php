<?php
declare(strict_types=1);
require_once __DIR__ . '/bootstrap.php';

$pdo    = db();
$action = $_GET['action'] ?? '';

function sync_from_cpr_import(PDO $pdo, string $studentId): ?array
{
    try {
        $st = $pdo->prepare('SELECT student_id, full_name, course, role, squad, zone FROM cpr_import WHERE student_id = ?');
        $st->execute([$studentId]);
        $imp = $st->fetch();
        if (!$imp) {
            return null;
        }

        $pdo->prepare(
            "INSERT INTO users (student_id, full_name, course, role, password_hash, is_active)
             VALUES (?, ?, ?, ?, 'DEFAULT_CPR123', 1)
             ON DUPLICATE KEY UPDATE full_name = VALUES(full_name), course = VALUES(course), role = VALUES(role), is_active = 1"
        )->execute([
            $imp['student_id'],
            $imp['full_name'],
            $imp['course'] ?: 'BS Information Technology',
            $imp['role'],
        ]);

        $squadId = $pdo->query('SELECT id FROM squads ORDER BY id ASC LIMIT 1')->fetchColumn() ?: 1;
        $zoneId  = $pdo->query('SELECT id FROM zones ORDER BY id ASC LIMIT 1')->fetchColumn() ?: 1;

        if (!empty($imp['squad'])) {
            $sq = $pdo->prepare('SELECT id FROM squads WHERE name = ? LIMIT 1');
            $sq->execute([$imp['squad']]);
            $squadId = $sq->fetchColumn() ?: $squadId;
        }
        if (!empty($imp['zone'])) {
            $zn = $pdo->prepare('SELECT id FROM zones WHERE name = ? LIMIT 1');
            $zn->execute([$imp['zone']]);
            $zoneId = $zn->fetchColumn() ?: $zoneId;
        }

        $pdo->prepare(
            "INSERT IGNORE INTO cpr_members (student_id, squad_id, zone_id, duty_status, joined_at)
             VALUES (?, ?, ?, 'On Duty', NOW())"
        )->execute([$imp['student_id'], $squadId, $zoneId]);

        $u = $pdo->prepare('SELECT student_id, full_name, role, password_hash, is_active FROM users WHERE student_id = ?');
        $u->execute([$studentId]);
        return $u->fetch() ?: null;
    } catch (Throwable) {
        return null;
    }
}

switch ($action) {

    case 'me': {
        $u = current_user();
        out(['user' => $u ? user_payload($u) : null]);
        break;
    }

    case 'login': {
        require_method('POST');
        $b         = body();
        $studentId = trim((string)($b['student_id'] ?? ''));
        $password  = (string)($b['password'] ?? '');

        if (!preg_match(ID_REGEX, $studentId)) {
            fail('Invalid Student ID format. Use 2X-XXXX-XXX.', 422);
        }
        if ($password === '') {
            fail('Please enter your password.', 422);
        }

        $st = $pdo->prepare('SELECT student_id, full_name, role, password_hash, is_active FROM users WHERE student_id = ?');
        $st->execute([$studentId]);
        $row = $st->fetch() ?: sync_from_cpr_import($pdo, $studentId);

        if (!$row) {
            fail('Student ID is not registered. Please create an account first.', 404, 'not_registered');
        }
        if (!(int)$row['is_active']) {
            fail('This account has been deactivated. Contact a CPR Officer.', 403, 'inactive');
        }

        $storedHash = (string)$row['password_hash'];
        $valid = false;

        if ($storedHash === 'DEFAULT_CPR123' || $storedHash === '') {
            if (hash_equals('CPR123', $password)) {
                $valid = true;
                $upgraded = password_hash('CPR123', PASSWORD_BCRYPT);
                $pdo->prepare('UPDATE users SET password_hash = ? WHERE student_id = ?')
                    ->execute([$upgraded, $studentId]);
            }
        } else {
            $valid = password_verify($password, $storedHash);
        }

        if (!$valid) {
            fail('Incorrect Student ID or password.', 401, 'invalid_credentials');
        }

        session_regenerate_id(true);
        $_SESSION['sid'] = $row['student_id'];

        $u = load_user($row['student_id']);
        out([
            'ok'   => true,
            'user' => $u ? user_payload($u) : null,
        ]);
        break;
    }

    case 'send_otp': {
        require_method('POST');
        $b         = body();
        $studentId = trim((string)($b['student_id'] ?? ''));

        if (!preg_match(ID_REGEX, $studentId)) {
            fail('Invalid Student ID format. Use 2X-XXXX-XXX.', 422);
        }

        $chk = $pdo->prepare('SELECT 1 FROM users WHERE student_id = ?');
        $chk->execute([$studentId]);
        if ($chk->fetchColumn() || sync_from_cpr_import($pdo, $studentId)) {
            fail('This Student ID is already registered. Please sign in (CPR members default password: CPR123).', 409, 'already_registered');
        }

        $otp = str_pad((string)random_int(0, 999999), 6, '0', STR_PAD_LEFT);
        $pdo->prepare(
            "INSERT INTO student_otps (student_id, otp_code, expires_at, verified)
             VALUES (?, ?, DATE_ADD(NOW(), INTERVAL 10 MINUTE), 0)
             ON DUPLICATE KEY UPDATE otp_code = VALUES(otp_code), expires_at = VALUES(expires_at), verified = 0"
        )->execute([$studentId, $otp]);

        out(['ok' => true, 'demo_otp' => $otp]);
        break;
    }

    case 'verify_otp': {
        require_method('POST');
        $b         = body();
        $studentId = trim((string)($b['student_id'] ?? ''));
        $otpCode   = trim((string)($b['otp_code'] ?? ''));

        $st = $pdo->prepare(
            "SELECT 1 FROM student_otps
             WHERE student_id = ? AND otp_code = ? AND expires_at >= NOW()"
        );
        $st->execute([$studentId, $otpCode]);
        if (!$st->fetchColumn()) {
            fail('Invalid or expired OTP code.', 422);
        }

        $pdo->prepare('UPDATE student_otps SET verified = 1 WHERE student_id = ?')
            ->execute([$studentId]);

        out(['ok' => true, 'verified' => true]);
        break;
    }

    case 'register': {
        require_method('POST');
        $b         = body();
        $fullName  = clean_text($b['full_name'] ?? '', 100);
        $studentId = trim((string)($b['student_id'] ?? ''));
        $course    = clean_text($b['course'] ?? 'Student', 100);
        $password  = (string)($b['password'] ?? '');

        if ($fullName === '' || !preg_match(ID_REGEX, $studentId)) {
            fail('Please provide your full name and a valid Student ID (2X-XXXX-XXX).', 422);
        }
        if (strlen($password) < 6) {
            fail('Password must be at least 6 characters long.', 422);
        }

        $chk = $pdo->prepare('SELECT 1 FROM users WHERE student_id = ?');
        $chk->execute([$studentId]);
        if ($chk->fetchColumn() || sync_from_cpr_import($pdo, $studentId)) {
            fail('This Student ID is already registered. Please sign in (CPR members default password: CPR123).', 409, 'already_registered');
        }

        $hash = password_hash($password, PASSWORD_BCRYPT);
        $pdo->prepare(
            "INSERT INTO users (student_id, full_name, course, role, password_hash, is_active)
             VALUES (?, ?, ?, 'user', ?, 1)"
        )->execute([$studentId, $fullName, $course !== '' ? $course : 'Student', $hash]);

        $pdo->prepare('DELETE FROM student_otps WHERE student_id = ?')->execute([$studentId]);

        out([
            'ok'        => true,
            'name'      => $fullName,
            'role'      => 'user',
            'activated' => false,
        ], 201);
        break;
    }

    case 'change_password': {
        $u = require_login();
        require_method('POST');
        $b           = body();
        $currentPass = (string)($b['current_password'] ?? '');
        $newPass     = (string)($b['new_password'] ?? '');
        $confirmPass = (string)($b['confirm_password'] ?? '');

        if ($currentPass === '' || $newPass === '') {
            fail('Please fill in all password fields.', 422);
        }
        if (strlen($newPass) < 6) {
            fail('New password must be at least 6 characters long.', 422);
        }
        if ($newPass !== $confirmPass) {
            fail('New password and confirmation do not match.', 422);
        }

        $st = $pdo->prepare('SELECT password_hash FROM users WHERE student_id = ?');
        $st->execute([$u['student_id']]);
        $storedHash = (string)$st->fetchColumn();

        $matches = ($storedHash === 'DEFAULT_CPR123' || $storedHash === '')
            ? hash_equals('CPR123', $currentPass)
            : password_verify($currentPass, $storedHash);

        if (!$matches) {
            fail('Your current password is incorrect.', 401);
        }

        $newHash = password_hash($newPass, PASSWORD_BCRYPT);
        $pdo->prepare('UPDATE users SET password_hash = ? WHERE student_id = ?')
            ->execute([$newHash, $u['student_id']]);

        out(['ok' => true]);
        break;
    }

    case 'update_profile': {
        $u = require_login();
        require_method('POST');
        $b         = body();
        $course    = clean_text($b['course'] ?? $u['course'], 100);
        $birthdate = trim((string)($b['birthdate'] ?? ''));
        $address   = clean_text($b['address'] ?? '', 200);
        $contact   = clean_text($b['emergency_contact'] ?? '', 100);

        $birthdateVal = preg_match('/^\d{4}-\d{2}-\d{2}$/', $birthdate) ? $birthdate : null;

        $pdo->prepare(
            "UPDATE users
             SET course = ?, birthdate = ?, address = ?, emergency_contact = ?
             WHERE student_id = ?"
        )->execute([
            $course !== '' ? $course : $u['course'],
            $birthdateVal,
            $address !== '' ? $address : null,
            $contact !== '' ? $contact : null,
            $u['student_id'],
        ]);

        $updated = load_user($u['student_id']);
        out([
            'ok'   => true,
            'user' => $updated ? user_payload($updated) : null,
        ]);
        break;
    }

    case 'logout': {
        $_SESSION = [];
        if (ini_get('session.use_cookies')) {
            $params = session_get_cookie_params();
            setcookie(session_name(), '', time() - 42000, $params['path'], $params['domain'], (bool)$params['secure'], (bool)$params['httponly']);
        }
        session_destroy();
        out(['ok' => true]);
        break;
    }

    default:
        fail('Unknown action.', 404);
}