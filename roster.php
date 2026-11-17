<?php
declare(strict_types=1);
require_once __DIR__ . '/bootstrap.php';

$u      = current_user();
$pdo    = db();
$action = $_GET['action'] ?? '';

switch ($action) {

    case 'list': {
        $rows = $pdo->query(
            "SELECT u.student_id, u.full_name, u.role, u.password_hash,
                    m.squad_id, COALESCE(s.name, 'Alpha Team') AS squad_name,
                    COALESCE(z.name, 'Main Campus') AS zone_name,
                    COALESCE(m.duty_status, 'Off Duty') AS duty_status
             FROM users u
             LEFT JOIN cpr_members m ON m.student_id = u.student_id
             LEFT JOIN squads s ON s.id = m.squad_id
             LEFT JOIN zones z ON z.id = m.zone_id
             WHERE u.role IN ('member', 'officer', 'admin')
               AND u.is_active = 1
             ORDER BY FIELD(u.role, 'officer', 'admin', 'member'), u.full_name ASC"
        )->fetchAll();

        $selfId = $u['student_id'] ?? '';

        out([
            'roster' => array_map(fn($r) => [
                'studentId' => $r['student_id'],
                'name'      => $r['full_name'],
                'role'      => $r['role'],
                'squadId'   => (int)($r['squad_id'] ?? 1),
                'squadName' => $r['squad_name'],
                'zone'      => $r['zone_name'],
                'status'    => $r['duty_status'],
                'activated' => (string)$r['password_hash'] !== '',
                'isSelf'    => $r['student_id'] === $selfId,
            ], $rows),
        ]);
        break;
    }

    case 'toggle_duty': {
        $u = require_login();
        require_method('POST');
        $b         = body();
        $studentId = trim((string)($b['student_id'] ?? $u['student_id']));

        if (!is_officer($u) && $studentId !== $u['student_id']) {
            fail('You can only toggle your own duty status.', 403, 'forbidden');
        }

        $chkUser = $pdo->prepare("SELECT role FROM users WHERE student_id = ? AND is_active = 1");
        $chkUser->execute([$studentId]);
        $targetRole = $chkUser->fetchColumn();
        if (!$targetRole || !in_array($targetRole, ['member', 'officer', 'admin'], true)) {
            fail('CPR member record not found.', 404);
        }

        $st = $pdo->prepare('SELECT duty_status FROM cpr_members WHERE student_id = ?');
        $st->execute([$studentId]);
        $cur = $st->fetchColumn();

        if ($cur === false) {
            $squadId = $pdo->query('SELECT id FROM squads ORDER BY id ASC LIMIT 1')->fetchColumn() ?: 1;
            $zoneId  = $pdo->query('SELECT id FROM zones ORDER BY id ASC LIMIT 1')->fetchColumn() ?: 1;
            $next    = 'On Duty';
            $pdo->prepare(
                "INSERT INTO cpr_members (student_id, squad_id, zone_id, duty_status, joined_at)
                 VALUES (?, ?, ?, ?, NOW())"
            )->execute([$studentId, $squadId, $zoneId, $next]);
        } else {
            $next = ($cur === 'Off Duty') ? 'On Duty' : 'Off Duty';
            $pdo->prepare('UPDATE cpr_members SET duty_status = ? WHERE student_id = ?')
                ->execute([$next, $studentId]);
        }

        out(['ok' => true, 'dutyStatus' => $next]);
        break;
    }

    case 'set_squad': {
        $u = require_login();
        require_method('POST');
        require_officer($u);
        $b         = body();
        $studentId = trim((string)($b['student_id'] ?? ''));
        $squadId   = (int)($b['squad_id'] ?? 0);

        if ($studentId === '' || $squadId <= 0) {
            fail('Invalid member or squad.', 422);
        }

        $pdo->prepare('UPDATE cpr_members SET squad_id = ? WHERE student_id = ?')
            ->execute([$squadId, $studentId]);

        out(['ok' => true]);
        break;
    }

    case 'add': {
        $u = require_login();
        require_method('POST');
        require_officer($u);
        $b         = body();
        $studentId = trim((string)($b['student_id'] ?? ''));
        $fullName  = clean_text($b['full_name'] ?? '', 100);
        $role      = in_array(($b['role'] ?? ''), ['member', 'officer'], true) ? $b['role'] : 'member';
        $squadId   = (int)($b['squad_id'] ?? 1);
        $zoneId    = (int)($b['zone_id'] ?? 1);

        if ($fullName === '' || !preg_match(ID_REGEX, $studentId)) {
            fail('Please provide a valid full name and Student ID (2X-XXXX-XXX).', 422);
        }

        $chk = $pdo->prepare('SELECT password_hash FROM users WHERE student_id = ?');
        $chk->execute([$studentId]);
        $existing = $chk->fetch();

        if ($existing) {
            $pdo->prepare('UPDATE users SET full_name = ?, role = ?, is_active = 1 WHERE student_id = ?')
                ->execute([$fullName, $role, $studentId]);
        } else {
            $pdo->prepare(
                "INSERT INTO users (student_id, full_name, course, role, password_hash, is_active)
                 VALUES (?, ?, 'BS Information Technology', ?, 'DEFAULT_CPR123', 1)"
            )->execute([$studentId, $fullName, $role]);
        }

        $pdo->prepare(
            "INSERT INTO cpr_members (student_id, squad_id, zone_id, duty_status, joined_at)
             VALUES (?, ?, ?, 'Off Duty', NOW())
             ON DUPLICATE KEY UPDATE squad_id = VALUES(squad_id), zone_id = VALUES(zone_id)"
        )->execute([$studentId, $squadId, $zoneId]);

        out([
            'ok'             => true,
            'activationCode' => $existing ? null : 'CPR123',
        ], 201);
        break;
    }

    default:
        fail('Unknown action.', 404);
}