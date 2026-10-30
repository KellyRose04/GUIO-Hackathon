<?php
declare(strict_types=1);

require_once __DIR__ . '/config.php';

header('Content-Type: application/json; charset=utf-8');

try {
    $pdo = tourtrail_database();

    $statement = $pdo->query(
        "SELECT u.id,
                COALESCE(NULLIF(u.display_name, ''), u.username) AS name,
                COUNT(c.id) AS image_count
           FROM users AS u
           INNER JOIN checkins AS c ON c.user_id = u.id
          WHERE c.image_url IS NOT NULL
            AND TRIM(c.image_url) <> ''
          GROUP BY u.id, u.display_name, u.username
          ORDER BY image_count DESC, u.username ASC
          LIMIT 3"
    );

    $items = array_map(
        static fn(array $row): array => [
            'id' => (int) $row['id'],
            'name' => $row['name'],
        ],
        $statement->fetchAll()
    );

    echo json_encode(
        ['items' => $items],
        JSON_UNESCAPED_SLASHES | JSON_INVALID_UTF8_SUBSTITUTE
    );
} catch (PDOException $error) {
    error_log('Top explorers request failed: ' . $error->getMessage());
    http_response_code(500);
    echo json_encode(['error' => 'Top explorers could not be loaded.']);
}
