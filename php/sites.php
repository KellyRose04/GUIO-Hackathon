<?php
require_once __DIR__ . '/config.php';

header('Content-Type: application/json');
header('Access-Control-Allow-Origin: *');

$host = 'localhost';
$db   = 'tourtrail_db';
$user = 'root';
$pass = '';
$charset = 'utf8mb4';

$dsn = "mysql:host=$host;dbname=$db;charset=$charset";
$options = [
    PDO::ATTR_ERRMODE            => PDO::ERRMODE_EXCEPTION,
    PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
    PDO::ATTR_EMULATE_PREPARES   => true, 
];

try {
    $pdo = new PDO($dsn, $user, $pass, $options);

    $username = tourtrail_requested_username();
    $userId = tourtrail_find_user_id($pdo, $username);
    if ($userId === null) {
        http_response_code(404);
        echo json_encode(['status' => 'error', 'error' => 'User not found']);
        exit;
    }

    $user_lat = isset($_GET['lat']) ? floatval($_GET['lat']) : 16.4023;
    $user_lng = isset($_GET['lng']) ? floatval($_GET['lng']) : 120.5960;
    $category = isset($_GET['category']) ? $_GET['category'] : 'all';
    $search   = isset($_GET['search']) ? trim($_GET['search']) : '';
    $sort     = isset($_GET['sort']) ? $_GET['sort'] : 'nearest';

    $sql = "SELECT id, title, category, is_hidden_gem,
            (SELECT stamp_name FROM stamps WHERE site_id = sites.id ORDER BY id LIMIT 1) AS stamp_name,
            CASE WHEN EXISTS (
                SELECT 1 FROM checkins c
                 WHERE c.site_id = sites.id AND c.user_id = :account_user_id
                   AND c.is_verified = 1
            ) THEN 'visited'
                 WHEN is_hidden_gem = 1 THEN 'hidden_gem'
                 ELSE 'new'
            END AS status,
            xp_reward, latitude, longitude, image_url, description, operating_hours, entrance_fee,
            ( 6371 * acos( cos( radians(:user_lat1) ) * cos( radians( latitude ) ) * cos( radians( longitude ) - radians(:user_lng) ) + sin( radians(:user_lat2) ) * sin( radians( latitude ) ) ) ) AS distance_km
            FROM sites WHERE 1=1";

    $params = [
        ':account_user_id' => $userId,
        ':user_lat1' => $user_lat,
        ':user_lng'  => $user_lng,
        ':user_lat2' => $user_lat
    ];

    if ($category !== 'all') {
        if ($category === 'gems') {
            $sql .= " AND is_hidden_gem = 1";
        } else {
            $sql .= " AND category = :category";
            $params[':category'] = $category;
        }
    }

    if (!empty($search)) {
        $sql .= " AND (title LIKE :search OR category LIKE :search OR description LIKE :search)";
        $params[':search'] = '%' . $search . '%';
    }

    if ($sort === 'xp') {
        $sql .= " ORDER BY xp_reward DESC, distance_km ASC";
    } else {
        $sql .= " ORDER BY distance_km ASC";
    }

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

    // Fetch all active quests for this user from the view
    $questStmt = $pdo->prepare("SELECT * FROM v_user_active_quest WHERE user_id = :account_user_id");
    $questStmt->execute([':account_user_id' => $userId]);
    $activeQuests = $questStmt->fetchAll();

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
        'error' => 'Sites are temporarily unavailable. Check-ins will sync when the database is available.',
    ]);
} catch (InvalidArgumentException $e) {
    http_response_code(400);
    echo json_encode(['status' => 'error', 'error' => 'The selected account is invalid.']);
} catch (\Throwable $e) {
    error_log('Sites request failed: ' . $e->getMessage());
    http_response_code(500);
    echo json_encode(['status' => 'error', 'error' => 'Sites could not be loaded.']);
}
?>