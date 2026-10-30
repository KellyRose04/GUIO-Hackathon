<?php
// Public, read-only quest catalog for the Quests page.

declare(strict_types=1);

header('Content-Type: application/json; charset=utf-8');
header('Cache-Control: no-store');

const DB_HOST = 'localhost';
const DB_NAME = 'tourtrail_db';
const DB_USER = 'root';
const DB_PASS = '';

function respond(int $status, array $payload): void
{
    http_response_code($status);
    echo json_encode($payload, JSON_UNESCAPED_UNICODE);
    exit;
}

try {
    $pdo = new PDO(
        'mysql:host=' . DB_HOST . ';dbname=' . DB_NAME . ';charset=utf8mb4',
        DB_USER,
        DB_PASS,
        [
            PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION,
            PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
        ]
    );

    $statement = $pdo->query(
        'SELECT q.id AS quest_id, q.quest_key, q.title, q.description, q.icon,
                q.quest_type, q.target_count, q.xp_reward,
                q.reward_badge_key, b.badge_name AS reward_badge_name
           FROM quests q
           LEFT JOIN badges b ON b.badge_key = q.reward_badge_key
          ORDER BY q.id'
    );
    $quests = $statement->fetchAll();

    $stopStatement = $pdo->query(
        'SELECT qs.quest_id, qs.site_id, qs.stop_order, s.title
           FROM quest_stops qs
           JOIN sites s ON s.id = qs.site_id
          ORDER BY qs.quest_id, qs.stop_order'
    );
    $stopsByQuest = [];
    foreach ($stopStatement->fetchAll() as $stop) {
        $questId = (int) $stop['quest_id'];
        $stopsByQuest[$questId][] = [
            'site_id' => (int) $stop['site_id'],
            'stop_order' => (int) $stop['stop_order'],
            'title' => $stop['title'],
        ];
    }

    foreach ($quests as &$quest) {
        $questId = (int) $quest['quest_id'];
        $quest['quest_id'] = $questId;
        $quest['target_count'] = (int) $quest['target_count'];
        $quest['xp_reward'] = (int) $quest['xp_reward'];
        $quest['category'] = $quest['quest_type'];
        $quest['stops'] = $stopsByQuest[$questId] ?? [];
    }
    unset($quest);

    respond(200, ['status' => 'success', 'quests' => $quests]);
} catch (PDOException $error) {
    error_log('Quest catalog request failed: ' . $error->getMessage());
    respond(503, [
        'status' => 'error',
        'code' => 'database_unavailable',
        'error' => 'Quests are temporarily unavailable.',
    ]);
}
