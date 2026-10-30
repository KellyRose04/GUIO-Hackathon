<?php
declare(strict_types=1);

require_once __DIR__ . '/config.php';

header('Content-Type: application/json; charset=utf-8');
header('Cache-Control: no-store');

function badges_fail(int $status, string $message): void
{
    http_response_code($status);
    echo json_encode(['error' => $message]);
    exit;
}

try {
    $anonymousId = guio_requested_anonymous_id();
    if ($anonymousId === null) {
        badges_fail(400, 'Anonymous account ID is required.');
    }

    $pdo = guio_database();
    $userId = guio_find_or_create_anonymous_user_id($pdo, $anonymousId);
    $statement = $pdo->prepare(
        'SELECT b.badge_key, b.badge_name, b.description, b.icon, b.rarity,
                b.sort_order, ub.id AS user_badge_id,
                DATE(ub.awarded_at) AS awarded_on,
                CASE
                    WHEN ub.is_new = 1 AND DATE(ub.awarded_at) = CURRENT_DATE() THEN 1
                    ELSE 0
                END AS is_new
           FROM badges b
           LEFT JOIN user_badges ub
             ON ub.badge_key = b.badge_key AND ub.user_id = :user_id
          ORDER BY b.sort_order, b.id'
    );
    $statement->execute([':user_id' => $userId]);

    $badges = array_map(
        static fn(array $badge): array => [
            'key' => $badge['badge_key'],
            'name' => $badge['badge_name'],
            'description' => $badge['description'],
            'icon' => $badge['icon'],
            'rarity' => $badge['rarity'],
            'sort_order' => (int) $badge['sort_order'],
            'awarded_on' => $badge['awarded_on'],
            'is_new' => (bool) $badge['is_new'],
            'earned' => $badge['user_badge_id'] !== null,
        ],
        $statement->fetchAll()
    );

    echo json_encode(['badges' => $badges], JSON_UNESCAPED_UNICODE);
} catch (PDOException $error) {
    error_log('badges.php: ' . $error->getMessage());
    badges_fail(500, 'Badges could not be loaded from the database.');
} catch (InvalidArgumentException $error) {
    badges_fail(400, $error->getMessage());
}
