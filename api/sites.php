<?php
require_once __DIR__ . '/config.php';

header('Content-Type: application/json');
header('Access-Control-Allow-Origin: *');

try {
    $pdo = tourtrail_database();

    // Map requests can be anonymous; identified devices get isolated quest progress.
    $deviceId = tourtrail_requested_device_id();
    $hasUsername = isset($_GET['user']) || isset($_POST['user']);
    if ($deviceId !== null) {
        $userId = tourtrail_find_or_create_device_user_id($pdo, $deviceId);
    } else {
        $username = $hasUsername ? tourtrail_requested_username() : '';
        $userId = $username !== '' ? tourtrail_find_user_id($pdo, $username) : null;
    }
    if ($hasUsername && $deviceId === null && $userId === null) {
        http_response_code(404);
        echo json_encode(['status' => 'error', 'error' => 'User not found']);
        exit;
    }

    $user_lat = isset($_GET['lat']) ? floatval($_GET['lat']) : 16.4023;
    $user_lng = isset($_GET['lng']) ? floatval($_GET['lng']) : 120.5960;
    $category = isset($_GET['category']) ? $_GET['category'] : 'all';
    $search   = isset($_GET['search']) ? trim($_GET['search']) : '';
    $sort     = isset($_GET['sort']) ? $_GET['sort'] : 'nearest';

    $statusSql = "CASE WHEN is_hidden_gem = 1 THEN 'hidden_gem' ELSE 'new' END";

    $sql = "SELECT id, title, category, is_hidden_gem,
            $statusSql AS status,
            latitude, longitude, image_url, description, operating_hours, entrance_fee,
            ( 6371 * acos( cos( radians(:user_lat1) ) * cos( radians( latitude ) ) * cos( radians( longitude ) - radians(:user_lng) ) + sin( radians(:user_lat2) ) * sin( radians( latitude ) ) ) ) AS distance_km
            FROM sites WHERE 1=1";

    $params = [
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
        $questStmt = $pdo->prepare("SELECT * FROM v_user_active_quest WHERE user_id = :account_user_id");
        $questStmt->execute([':account_user_id' => $userId]);
        $activeQuests = $questStmt->fetchAll();
    }

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
