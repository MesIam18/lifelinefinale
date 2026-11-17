<?php
declare(strict_types=1);
require __DIR__ . '/bootstrap.php';

$u   = require_login();
$pdo = db();

$total = (int)$pdo->query(
    "SELECT COUNT(*) FROM incidents WHERE created_at >= (NOW() - INTERVAL 30 DAY)"
)->fetchColumn();

$byTypeRows = $pdo->query(
    "SELECT COALESCE(t.name, 'Other / Unspecified') AS name, COUNT(*) AS cnt
     FROM incidents i
     LEFT JOIN incident_types t ON t.id = i.incident_type_id
     WHERE i.created_at >= (NOW() - INTERVAL 30 DAY)
     GROUP BY COALESCE(t.name, 'Other / Unspecified')
     ORDER BY cnt DESC"
)->fetchAll();

$byType = array_map(fn($r) => [
    'name'  => $r['name'],
    'count' => (int)$r['cnt'],
], $byTypeRows);

$mostCommon = $byType[0] ?? null;

$respRow = $pdo->query(
    "SELECT AVG(TIMESTAMPDIFF(SECOND, created_at, responded_at)) / 60 AS avg_min
     FROM incidents
     WHERE responded_at IS NOT NULL
       AND created_at >= (NOW() - INTERVAL 30 DAY)"
)->fetch();

$monthCounts = [];
$mRows = $pdo->query(
    "SELECT DATE_FORMAT(created_at, '%Y-%m') AS ym, COUNT(*) AS cnt
     FROM incidents
     WHERE created_at >= DATE_FORMAT(CURDATE() - INTERVAL 5 MONTH, '%Y-%m-01')
     GROUP BY ym"
)->fetchAll();
foreach ($mRows as $r) {
    $monthCounts[$r['ym']] = (int)$r['cnt'];
}

$months = [];
for ($i = 5; $i >= 0; $i--) {
    $ts = strtotime("-{$i} months");
    $ym = date('Y-m', $ts);
    $months[] = [
        'label' => date('M Y', $ts),
        'count' => $monthCounts[$ym] ?? 0,
    ];
}

$active = (int)$pdo->query(
    "SELECT COUNT(*) FROM cpr_members m
     JOIN users u ON u.student_id = m.student_id
     WHERE u.role = 'member' AND u.is_active = 1 AND m.duty_status <> 'Off Duty'"
)->fetchColumn();

out([
    'total'            => $total,
    'mostCommon'       => $mostCommon,
    'avgResponseMin'   => $respRow['avg_min'] !== null ? round((float)$respRow['avg_min'], 1) : null,
    'activeResponders' => $active,
    'byType'           => $byType,
    'months'           => $months,
]);