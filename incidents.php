<?php
declare(strict_types=1);
require __DIR__ . '/bootstrap.php';

$u      = current_user();
$pdo    = db();
$action = $_GET['action'] ?? '';

function incident_schema(PDO $pdo): array
{
    $cols    = table_columns($pdo, 'incidents');
    $idCol   = $cols['id'] ?? [];
    $idIsInt = str_contains(strtolower((string)($idCol['Type'] ?? '')), 'int')
        || str_contains(strtolower((string)($idCol['Extra'] ?? '')), 'auto_increment');

    $detailsCol = null;
    foreach (['details', 'notes', 'description', 'others'] as $cand) {
        if (isset($cols[$cand])) {
            $detailsCol = $cand;
            break;
        }
    }

    return [
        'cols'         => $cols,
        'idIsInt'      => $idIsInt,
        'hasGuestName' => isset($cols['guest_name']),
        'detailsCol'   => $detailsCol,
        'patientsCol'  => isset($cols['patients']) ? 'patients' : (isset($cols['patient_count']) ? 'patient_count' : null),
        'typeCol'      => isset($cols['incident_type_id']) ? 'incident_type_id' : (isset($cols['type_id']) ? 'type_id' : null),
    ];
}

function parse_guest_reporter(?string $reporterName, ?string $guestNameCol, ?string $details): array
{
    $name = trim((string)($guestNameCol ?? '')) !== '' ? trim((string)$guestNameCol) : ($reporterName ?? 'Campus Guest');
    $cleanDetails = (string)($details ?? '');
    if (preg_match('/^\[Guest:\s*([^\]]+)\]\s*(.*)$/u', $cleanDetails, $m)) {
        if (trim((string)($guestNameCol ?? '')) === '') {
            $name = trim($m[1]);
        }
        $cleanDetails = trim($m[2]);
    } elseif (preg_match('/^\[Guest Report\]\s*(.*)$/u', $cleanDetails, $m)) {
        $cleanDetails = trim($m[1]);
    }
    return [$name, $cleanDetails];
}

switch ($action) {

    case 'create': {
        require_method('POST');
        $b          = body();
        $priority   = strtoupper(trim((string)($b['priority'] ?? '')));
        $buildingId = (int)($b['building_id'] ?? 0);
        $roomId     = (int)($b['room_id'] ?? 0);
        $patients   = max(1, min(99, (int)($b['patients'] ?? 1)));
        $typeId     = isset($b['incident_type_id']) && $b['incident_type_id'] !== '' ? (int)$b['incident_type_id'] : null;
        $details    = clean_text($b['details'] ?? '', 300);
        $guestName  = clean_text($b['guest_name'] ?? '', 60);

        if (!in_array($priority, ['RED', 'YELLOW', 'GREEN'], true)) {
            fail('Please select a valid emergency priority.', 422);
        }
        $chk = $pdo->prepare('SELECT 1 FROM rooms WHERE id = ? AND building_id = ?');
        $chk->execute([$roomId, $buildingId]);
        if (!$chk->fetchColumn()) {
            fail('Please select a valid building and room.', 422);
        }

        $schema     = incident_schema($pdo);
        $reporterId = $u ? $u['student_id'] : ensure_guest_reporter($pdo);

        if (!$u && !$schema['hasGuestName']) {
            $tag     = $guestName !== '' ? "[Guest: {$guestName}]" : '[Guest Report]';
            $details = trim($tag . ' ' . $details);
        }

        $dup = $pdo->prepare(
            "SELECT id FROM incidents
             WHERE building_id = ? AND room_id = ? AND status <> 'RESOLVED'
               AND created_at >= (NOW() - INTERVAL 3 MINUTE)
             LIMIT 1"
        );
        $dup->execute([$buildingId, $roomId]);
        if ($dup->fetchColumn()) {
            fail('An active emergency alert for this exact room was already dispatched moments ago.', 409, 'duplicate');
        }

        $fields = ['reporter_id', 'priority', 'building_id', 'room_id', 'status'];
        $values = [$reporterId, $priority, $buildingId, $roomId, 'DISPATCHED'];

        $generatedCode = null;
        if (!$schema['idIsInt']) {
            $generatedCode = 'INC-' . strtoupper(bin2hex(random_bytes(3)));
            array_unshift($fields, 'id');
            array_unshift($values, $generatedCode);
        }
        if ($schema['hasGuestName'] && !$u) {
            $fields[] = 'guest_name';
            $values[] = $guestName !== '' ? $guestName : null;
        }
        if ($schema['patientsCol'] !== null) {
            $fields[] = $schema['patientsCol'];
            $values[] = $patients;
        }
        if ($schema['typeCol'] !== null) {
            $fields[] = $schema['typeCol'];
            $values[] = $typeId;
        }
        if ($schema['detailsCol'] !== null) {
            $fields[] = $schema['detailsCol'];
            $values[] = $details;
        }

        $colSql = implode(', ', array_map(fn($c) => "`{$c}`", $fields));
        $phSql  = implode(', ', array_fill(0, count($values), '?'));
        $pdo->prepare("INSERT INTO incidents ({$colSql}) VALUES ({$phSql})")->execute($values);

        $createdId = $schema['idIsInt'] ? (string)$pdo->lastInsertId() : $generatedCode;

        if (!$u) {
            $_SESSION['guest_incidents']   = $_SESSION['guest_incidents'] ?? [];
            $_SESSION['guest_incidents'][] = $createdId;
        }

        $guestColExpr = $schema['hasGuestName'] ? 'i.guest_name' : 'NULL';
        $detailsExpr  = $schema['detailsCol'] ? "i.`{$schema['detailsCol']}`" : "''";
        $patientsExpr = $schema['patientsCol'] ? "i.`{$schema['patientsCol']}`" : '1';
        $typeJoin     = $schema['typeCol'] ? "LEFT JOIN incident_types t ON t.id = i.`{$schema['typeCol']}`" : '';
        $typeExpr     = $schema['typeCol'] ? 't.name' : 'NULL';

        $st = $pdo->prepare(
            "SELECT i.id, i.reporter_id, {$guestColExpr} AS guest_name,
                    COALESCE(u.full_name, 'Campus Guest') AS reporter_name, i.priority,
                    b.name AS building, r.name AS room, {$patientsExpr} AS patients,
                    {$typeExpr} AS type_name, {$detailsExpr} AS details, i.status,
                    UNIX_TIMESTAMP(i.created_at) * 1000 AS created_at
             FROM incidents i
             LEFT JOIN users u ON u.student_id = i.reporter_id
             JOIN buildings b ON b.id = i.building_id
             JOIN rooms r ON r.id = i.room_id
             {$typeJoin}
             WHERE i.id = ?"
        );
        $st->execute([$createdId]);
        $inc = $st->fetch();

        if (!$inc) {
            fail('Incident was saved but could not be reloaded.', 500);
        }

        [$displayReporter, $displayDetails] = parse_guest_reporter($inc['reporter_name'], $inc['guest_name'], $inc['details']);

        out([
            'incident' => [
                'id'           => (string)$inc['id'],
                'reporterId'   => (string)$inc['reporter_id'],
                'reporterName' => $guestName !== '' ? $guestName : $displayReporter,
                'priority'     => $inc['priority'],
                'building'     => $inc['building'],
                'room'         => $inc['room'],
                'patients'     => (int)$inc['patients'],
                'typeName'     => $inc['type_name'],
                'details'      => $displayDetails,
                'status'       => $inc['status'],
                'createdAt'    => (int)$inc['created_at'],
            ],
        ], 201);
        break;
    }

    case 'list': {
        $scope  = $_GET['scope'] ?? 'mine';
        $schema = incident_schema($pdo);

        if ($scope === 'mine') {
            if ($u) {
                $st = $pdo->prepare(
                    "SELECT i.id, i.priority, b.name AS building, r.name AS room, i.status,
                            resp.full_name AS responder_name, UNIX_TIMESTAMP(i.created_at) * 1000 AS created_at
                     FROM incidents i
                     JOIN buildings b ON b.id = i.building_id
                     JOIN rooms r ON r.id = i.room_id
                     LEFT JOIN users resp ON resp.student_id = i.responder_id
                     WHERE i.reporter_id = ?
                     ORDER BY i.created_at DESC LIMIT 5"
                );
                $st->execute([$u['student_id']]);
                $rows = $st->fetchAll();
            } else {
                $ids = $_SESSION['guest_incidents'] ?? [];
                if (empty($ids)) {
                    out(['incidents' => []]);
                }
                $placeholders = implode(',', array_fill(0, count($ids), '?'));
                $st = $pdo->prepare(
                    "SELECT i.id, i.priority, b.name AS building, r.name AS room, i.status,
                            resp.full_name AS responder_name, UNIX_TIMESTAMP(i.created_at) * 1000 AS created_at
                     FROM incidents i
                     JOIN buildings b ON b.id = i.building_id
                     JOIN rooms r ON r.id = i.room_id
                     LEFT JOIN users resp ON resp.student_id = i.responder_id
                     WHERE i.id IN ({$placeholders})
                     ORDER BY i.created_at DESC LIMIT 5"
                );
                $st->execute(array_values($ids));
                $rows = $st->fetchAll();
            }

            out([
                'incidents' => array_map(fn($r) => [
                    'id'            => (string)$r['id'],
                    'priority'      => $r['priority'],
                    'building'      => $r['building'],
                    'room'          => $r['room'],
                    'status'        => $r['status'],
                    'responderName' => $r['responder_name'],
                    'createdAt'     => (int)$r['created_at'],
                ], $rows),
            ]);
        }

        $u = require_login();

        $guestColExpr = $schema['hasGuestName'] ? 'i.guest_name' : 'NULL';
        $detailsExpr  = $schema['detailsCol'] ? "i.`{$schema['detailsCol']}`" : "''";
        $patientsExpr = $schema['patientsCol'] ? "i.`{$schema['patientsCol']}`" : '1';
        $typeJoin     = $schema['typeCol'] ? "LEFT JOIN incident_types t ON t.id = i.`{$schema['typeCol']}`" : '';
        $typeExpr     = $schema['typeCol'] ? 't.name' : 'NULL';

        if ($scope === 'active') {
            require_responder($u);
            $rows = $pdo->query(
                "SELECT i.id, i.reporter_id, {$guestColExpr} AS guest_name,
                        COALESCE(u.full_name, 'Campus Guest') AS reporter_name, i.priority,
                        b.name AS building, r.name AS room, {$patientsExpr} AS patients,
                        {$typeExpr} AS type_name, {$detailsExpr} AS details, i.status,
                        i.responder_id, resp.full_name AS responder_name,
                        UNIX_TIMESTAMP(i.created_at) * 1000 AS created_at
                 FROM incidents i
                 LEFT JOIN users u ON u.student_id = i.reporter_id
                 JOIN buildings b ON b.id = i.building_id
                 JOIN rooms r ON r.id = i.room_id
                 {$typeJoin}
                 LEFT JOIN users resp ON resp.student_id = i.responder_id
                 WHERE i.status <> 'RESOLVED'
                 ORDER BY FIELD(i.priority, 'RED', 'YELLOW', 'GREEN'), i.created_at ASC"
            )->fetchAll();

            out([
                'incidents' => array_map(function ($r) {
                    [$repName, $cleanDet] = parse_guest_reporter($r['reporter_name'], $r['guest_name'], $r['details']);
                    return [
                        'id'            => (string)$r['id'],
                        'reporterId'    => (string)$r['reporter_id'],
                        'reporterName'  => $repName,
                        'priority'      => $r['priority'],
                        'building'      => $r['building'],
                        'room'          => $r['room'],
                        'patients'      => (int)$r['patients'],
                        'typeName'      => $r['type_name'],
                        'details'       => $cleanDet,
                        'status'        => $r['status'],
                        'responderId'   => $r['responder_id'],
                        'responderName' => $r['responder_name'],
                        'createdAt'     => (int)$r['created_at'],
                    ];
                }, $rows),
            ]);
        }

        $rows = $pdo->query(
            "SELECT i.id, i.priority, b.name AS building, r.name AS room, {$patientsExpr} AS patients,
                    {$typeExpr} AS type_name, i.status, UNIX_TIMESTAMP(i.created_at) * 1000 AS created_at
             FROM incidents i
             JOIN buildings b ON b.id = i.building_id
             JOIN rooms r ON r.id = i.room_id
             {$typeJoin}
             ORDER BY i.created_at DESC LIMIT 10"
        )->fetchAll();

        out([
            'incidents' => array_map(fn($r) => [
                'id'        => (string)$r['id'],
                'priority'  => $r['priority'],
                'building'  => $r['building'],
                'room'      => $r['room'],
                'patients'  => (int)$r['patients'],
                'typeName'  => $r['type_name'],
                'status'    => $r['status'],
                'createdAt' => (int)$r['created_at'],
            ], $rows),
        ]);
        break;
    }

    case 'advance': {
        $u = require_login();
        require_method('POST');
        require_responder($u);
        $b      = body();
        $id     = trim((string)($b['id'] ?? ''));
        $target = strtoupper(trim((string)($b['status'] ?? '')));

        $allowed = [
            'DISPATCHED' => 'RESPONDING',
            'RESPONDING' => 'ON_SCENE',
            'ON_SCENE'   => 'RESOLVED',
        ];

        $pdo->beginTransaction();
        try {
            $st = $pdo->prepare('SELECT id, status, responder_id FROM incidents WHERE id = ? FOR UPDATE');
            $st->execute([$id]);
            $inc = $st->fetch();

            if (!$inc) {
                $pdo->rollBack();
                fail('Incident not found.', 404);
            }
            if (($allowed[$inc['status']] ?? null) !== $target) {
                $pdo->rollBack();
                fail('Invalid status transition.', 409);
            }
            if ($inc['status'] !== 'DISPATCHED' && !is_officer($u) && $inc['responder_id'] !== $u['student_id']) {
                $pdo->rollBack();
                fail('This incident is already assigned to another responder.', 403);
            }

            if ($target === 'RESPONDING') {
                $pdo->prepare("UPDATE incidents SET status = 'RESPONDING', responder_id = ?, responded_at = NOW() WHERE id = ?")
                    ->execute([$u['student_id'], $id]);
                if ($u['role'] === 'member') {
                    $pdo->prepare("UPDATE cpr_members SET duty_status = 'Responding' WHERE student_id = ?")
                        ->execute([$u['student_id']]);
                }
            } elseif ($target === 'ON_SCENE') {
                $pdo->prepare("UPDATE incidents SET status = 'ON_SCENE' WHERE id = ?")
                    ->execute([$id]);
                if ($u['role'] === 'member') {
                    $pdo->prepare("UPDATE cpr_members SET duty_status = 'On-Scene' WHERE student_id = ?")
                        ->execute([$u['student_id']]);
                }
            } else {
                $pdo->prepare("UPDATE incidents SET status = 'RESOLVED', resolved_at = NOW() WHERE id = ?")
                    ->execute([$id]);
                if ($inc['responder_id']) {
                    $pdo->prepare(
                        "UPDATE cpr_members m
                         JOIN users u ON u.student_id = m.student_id
                         SET m.duty_status = 'On Duty'
                         WHERE m.student_id = ? AND u.role = 'member' AND m.duty_status <> 'Off Duty'"
                    )->execute([$inc['responder_id']]);
                }
            }

            $pdo->commit();
        } catch (Throwable $e) {
            if ($pdo->inTransaction()) {
                $pdo->rollBack();
            }
            throw $e;
        }

        out(['ok' => true, 'status' => $target]);
        break;
    }

    case 'stats': {
        $u = require_login();

        $today = (int)$pdo->query("SELECT COUNT(*) FROM incidents WHERE DATE(created_at) = CURDATE()")->fetchColumn();
        $yesterday = (int)$pdo->query("SELECT COUNT(*) FROM incidents WHERE DATE(created_at) = (CURDATE() - INTERVAL 1 DAY)")->fetchColumn();

        $active = (int)$pdo->query(
            "SELECT COUNT(*) FROM cpr_members m
             JOIN users u ON u.student_id = m.student_id
             WHERE u.role = 'member' AND u.is_active = 1 AND m.duty_status <> 'Off Duty'"
        )->fetchColumn();

        $respRow = $pdo->query(
            "SELECT AVG(TIMESTAMPDIFF(SECOND, created_at, responded_at)) / 60 AS avg_min,
                    COUNT(*) AS samples
             FROM incidents
             WHERE responded_at IS NOT NULL
               AND created_at >= (NOW() - INTERVAL 30 DAY)"
        )->fetch();

        $monthRow = $pdo->query(
            "SELECT COUNT(*) AS total,
                    SUM(status = 'RESOLVED') AS resolved
             FROM incidents
             WHERE YEAR(created_at) = YEAR(CURDATE()) AND MONTH(created_at) = MONTH(CURDATE())"
        )->fetch();

        out([
            'stats' => [
                'today'            => $today,
                'yesterday'        => $yesterday,
                'activeResponders' => $active,
                'avgResponseMin'   => $respRow['avg_min'] !== null ? round((float)$respRow['avg_min'], 1) : null,
                'responseSamples'  => (int)$respRow['samples'],
                'monthTotal'       => (int)($monthRow['total'] ?? 0),
                'monthResolved'    => (int)($monthRow['resolved'] ?? 0),
            ],
        ]);
        break;
    }

    default:
        fail('Unknown action.', 404);
}