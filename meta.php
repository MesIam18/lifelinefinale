<?php
declare(strict_types=1);
require __DIR__ . '/bootstrap.php';

current_user();
$pdo = db();

$buildingsRows = $pdo->query('SELECT id, name FROM buildings ORDER BY name')->fetchAll();
$roomsRows     = $pdo->query('SELECT id, building_id, name FROM rooms ORDER BY name')->fetchAll();

$roomsByBuilding = [];
foreach ($roomsRows as $r) {
    $bid = (int)$r['building_id'];
    $roomsByBuilding[$bid][] = [
        'id'   => (int)$r['id'],
        'name' => $r['name'],
    ];
}

$buildings = array_map(fn($b) => [
    'id'    => (int)$b['id'],
    'name'  => $b['name'],
    'rooms' => $roomsByBuilding[(int)$b['id']] ?? [],
], $buildingsRows);

$squads = array_map(fn($s) => [
    'id'       => (int)$s['id'],
    'name'     => $s['name'],
    'label'    => $s['role_label'],
    'coverage' => $s['coverage'],
    'color'    => $s['color'],
], $pdo->query('SELECT id, name, role_label, coverage, color FROM squads ORDER BY id')->fetchAll());

$zones = array_map(fn($z) => [
    'id'   => (int)$z['id'],
    'name' => $z['name'],
], $pdo->query('SELECT id, name FROM zones ORDER BY name')->fetchAll());

$types = array_map(fn($t) => [
    'id'   => (int)$t['id'],
    'name' => $t['name'],
], $pdo->query('SELECT id, name FROM incident_types ORDER BY name')->fetchAll());

out([
    'buildings' => $buildings,
    'squads'    => $squads,
    'zones'     => $zones,
    'types'     => $types,
]);