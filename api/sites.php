<?php
require_once __DIR__ . '/config.php';

header('Content-Type: application/json');
header('Access-Control-Allow-Origin: *');

try {
    $pdo = guio_database();

    // Anonymous IDs keep quest progress associated with this browser without registration.
    $anonymousId = guio_requested_anonymous_id();
    $hasUsername = isset($_GET['user']) || isset($_POST['user']);
    if ($anonymousId !== null) {
        $userId = guio_find_or_create_anonymous_user_id($pdo, $anonymousId);
    } else {
        $username = $hasUsername ? guio_requested_username() : '';
        $userId = $username !== '' ? guio_find_user_id($pdo, $username) : null;
    }
    if ($hasUsername && $anonymousId === null && $userId === null) {
        http_response_code(404);
        echo json_encode(['status' => 'error', 'error' => 'User not found']);
        exit;
    }

    $user_lat = isset($_GET['lat']) ? floatval($_GET['lat']) : 16.4023;
    $user_lng = isset($_GET['lng']) ? floatval($_GET['lng']) : 120.5960;
    $category = isset($_GET['category']) ? $_GET['category'] : 'all';
    $search   = isset($_GET['search']) ? trim($_GET['search']) : '';
    $sort     = isset($_GET['sort']) ? $_GET['sort'] : 'nearest';

    $sql = "SELECT id, title, category,
        'new' AS status,
        latitude, longitude, image_url, description, operating_hours, entrance_fee,
        ( 6371 * acos( cos( radians(:user_lat1) ) * cos( radians( latitude ) ) * cos( radians( longitude ) - radians(:user_lng) ) + sin( radians(:user_lat2) ) * sin( radians( latitude ) ) ) ) AS distance_km
        FROM sites WHERE 1=1";

    $params = [
        ':user_lat1' => $user_lat,
        ':user_lng'  => $user_lng,
        ':user_lat2' => $user_lat
    ];
    if ($category !== 'all' && $category !== 'gems') {
        $sql .= " AND category = :category";
        $params[':category'] = $category;
    }

    if (!empty($search)) {
        $sql .= " AND (title LIKE :search OR category LIKE :search OR description LIKE :search)";
        $params[':search'] = '%' . $search . '%';
    }

    $sql .= " ORDER BY distance_km ASC";

    $stmt = $pdo->prepare($sql);
    $stmt->execute($params);
    $sites = $stmt->fetchAll();

    foreach ($sites as &$site) {
        $km = floatval($site['distance_km']);
        if ($km < 1) {
            $site['formatted_distance'] = round($km * 1000) . ' m away';
        } else {
            $site['formatted_distance'] = number_format($km, 1) . ' km away';
        }
    }

    // Anonymous map visitors see public sites but no account-specific quests.
    $activeQuests = [];
    if ($userId !== null) {
        guio_ensure_default_active_quest($pdo, $userId);
        $questStmt = $pdo->prepare("SELECT * FROM v_user_active_quest WHERE user_id = :account_user_id");
        $questStmt->execute([':account_user_id' => $userId]);
        $activeQuests = $questStmt->fetchAll();
    }

    foreach ($activeQuests as &$quest) {
    $stopsStmt = $pdo->prepare(
        'SELECT qs.site_id, qs.stop_order, s.title,
                CASE
                    WHEN uqs.id IS NOT NULL THEN \'done\'
                    WHEN NOT EXISTS (
                        SELECT 1
                          FROM quest_stops AS earlier
                          LEFT JOIN user_quest_stops AS earlier_done
                            ON earlier_done.user_quest_id = :uq1
                           AND earlier_done.quest_stop_id = earlier.id
                         WHERE earlier.quest_id = qs.quest_id
                           AND earlier.stop_order < qs.stop_order
                           AND earlier_done.id IS NULL
                    ) THEN \'next\'
                    ELSE \'locked\'
                END AS stop_state
           FROM quest_stops AS qs
           JOIN sites AS s ON s.id = qs.site_id
           LEFT JOIN user_quest_stops AS uqs
             ON uqs.user_quest_id = :uq2
            AND uqs.quest_stop_id = qs.id
          WHERE qs.quest_id = :quest_id
          ORDER BY qs.stop_order'
    );
    $stopsStmt->execute([
        ':uq1' => (int) $quest['user_quest_id'],
        ':uq2' => (int) $quest['user_quest_id'],
        ':quest_id' => (int) $quest['quest_id'],
    ]);
    $quest['stops'] = $stopsStmt->fetchAll();
}
unset($quest);

    echo json_encode([
        'status' => 'success', 
        'data' => $sites,
        'active_quests' => $activeQuests
    ]);

} catch (PDOException $e) {
    error_log('Sites database request failed: ' . $e->getMessage());
    http_response_code(503);
    echo json_encode([
        'status' => 'error',
        'code' => 'database_unavailable',
        'error' => 'Destinations are temporarily unavailable.',
    ]);
} catch (InvalidArgumentException $e) {
    http_response_code(400);
    echo json_encode(['status' => 'error', 'error' => 'The anonymous device ID is invalid.']);
} catch (\Throwable $e) {
    error_log('Sites request failed: ' . $e->getMessage());
    http_response_code(500);
    echo json_encode(['status' => 'error', 'error' => 'Sites could not be loaded.']);
}
?>
