<?php
declare(strict_types=1);

header('Content-Type: application/json; charset=utf-8');

try {
    $pdo = new PDO(
        'mysql:host=localhost;dbname=tourtrail_db;charset=utf8mb4',
        'root',
        '',
        [
            PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION,
            PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
            PDO::ATTR_EMULATE_PREPARES => false,
        ]
    );

    $statement = $pdo->query(
        "SELECT c.site_id AS siteId,
                COALESCE(NULLIF(s.title, ''), 'Unknown site') AS name,
                (SELECT COUNT(*)
                   FROM checkin_likes AS cl
                  WHERE cl.checkin_id = c.id) AS likes
           FROM checkins AS c
           LEFT JOIN sites AS s ON s.id = c.site_id
          WHERE c.site_id IS NOT NULL
            AND EXISTS (
                SELECT 1
                  FROM checkin_image_tags AS cit
                  INNER JOIN image_tags AS it ON it.id = cit.tag_id
                 WHERE cit.checkin_id = c.id
                   AND it.tag_key = 'hidden-gems'
          )
          ORDER BY likes DESC, c.created_at ASC, c.id ASC"
    );

    // Posts are ranked by likes, then oldest date. Keep only the first post
    // for each site so several popular posts from one place do not crowd out
    // the other trending sites.
    $items = [];
    $seenSiteIds = [];
    $seenSiteNames = [];
    foreach ($statement->fetchAll() as $row) {
        $siteId = (int) $row['siteId'];
        $name = trim((string) $row['name']);
        $nameKey = strtolower($name);
        if (isset($seenSiteIds[$siteId]) || isset($seenSiteNames[$nameKey])) {
            continue;
        }

        $seenSiteIds[$siteId] = true;
        $seenSiteNames[$nameKey] = true;
        $items[] = [
            'siteId' => $siteId,
            'name' => $name,
            'likes' => (int) $row['likes'],
        ];
        if (count($items) === 3) {
            break;
        }
    }

    echo json_encode(
        ['items' => $items],
        JSON_UNESCAPED_SLASHES | JSON_INVALID_UTF8_SUBSTITUTE
    );
} catch (PDOException $error) {
    error_log('Trending hidden gems request failed: ' . $error->getMessage());
    http_response_code(500);
    echo json_encode(['error' => 'Trending sites could not be loaded.']);
}
