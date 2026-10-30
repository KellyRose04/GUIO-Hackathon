<?php
// api/passport.php
// Read-only JSON endpoint for the Passport page.
// Usage: api/passport.php?user=<username> -> selected account

declare(strict_types=1);

require_once __DIR__ . '/config.php';

header('Content-Type: application/json; charset=utf-8');
header('Cache-Control: no-store');

// ---- Edit these to match your MySQL setup (XAMPP defaults shown) ----
const DB_HOST = 'localhost';
const DB_NAME = 'guio_db';
const DB_USER = 'root';
const DB_PASS = '';
// ---------------------------------------------------------------------

function fail(int $code, string $message): void
{
    // Return API errors in JSON so the passport client can report request failures.
    http_response_code($code);
    echo json_encode(['error' => $message]);
    exit;
}

try {
    $username = tourtrail_requested_username();
} catch (InvalidArgumentException $error) {
    fail(400, $error->getMessage());
}

try {
    $pdo = new PDO(
        'mysql:host=' . DB_HOST . ';dbname=' . DB_NAME . ';charset=utf8mb4',
        DB_USER,
        DB_PASS,
        [
            PDO::ATTR_ERRMODE            => PDO::ERRMODE_EXCEPTION,
            PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
        ]
    );

    // Timestamps are stored in UTC; read them back as Philippine time so
    // weekdays and dates match what the user sees on their phone.
    $pdo->exec("SET time_zone = '+08:00'");

    // 1. The user (never select email or password_hash)
    $stmt = $pdo->prepare(
        'SELECT id, username, COALESCE(NULLIF(display_name, \'\'), username) AS display_name,
                xp_count, streak_count, longest_streak
           FROM users
          WHERE username = :u'
    );
    $stmt->execute([':u' => $username]);
    $user = $stmt->fetch();
    if (!$user) {
        fail(404, 'User not found');
    }
    $uid = (int) $user['id'];

    // Level titles and thresholds come from the database, not client-side constants.
    $stmt = $pdo->query(
        'SELECT level, title, description, xp_required
           FROM levels
          ORDER BY xp_required, level'
    );
    $levels = array_map(
        fn($r) => [
            'level'       => (int) $r['level'],
            'title'       => $r['title'],
            'description' => $r['description'],
            'xp_required' => (int) $r['xp_required'],
        ],
        $stmt->fetchAll()
    );
    if (!$levels) {
        fail(500, 'Level data is unavailable');
    }

    // Passport site counts include only verified check-ins linked to a registered site.
    $stmt = $pdo->prepare(
        'SELECT COUNT(DISTINCT c.site_id) AS sites_visited,
                COUNT(DISTINCT CASE WHEN s.is_hidden_gem = 1 THEN c.site_id END) AS hidden_gems
           FROM checkins c
           LEFT JOIN sites s ON s.id = c.site_id
          WHERE c.user_id = :id
            AND c.is_verified = 1'
    );
    $stmt->execute([':id' => $uid]);
    $stats = $stmt->fetch();

    // Build the visited-sites list used by the profile's site and hidden-gem dialogs.
    $stmt = $pdo->prepare(
        'SELECT s.title, s.category, s.is_hidden_gem,
                COUNT(*) AS visit_count,
                DATE(MAX(c.created_at)) AS last_visited
           FROM checkins c
           JOIN sites s ON s.id = c.site_id
          WHERE c.user_id = :id
            AND c.is_verified = 1
          GROUP BY s.id, s.title, s.category, s.is_hidden_gem
          ORDER BY MAX(c.created_at) DESC, s.title'
    );
    $stmt->execute([':id' => $uid]);
    $visitedSites = array_map(
        fn($r) => [
            'title'        => $r['title'],
            'category'     => $r['category'],
            'is_hidden_gem' => (bool) $r['is_hidden_gem'],
            'visit_count'  => (int) $r['visit_count'],
            'last_visited' => $r['last_visited'],
        ],
        $stmt->fetchAll()
    );

    // Completed quest history is separate from the user's currently active quest.
    $stmt = $pdo->prepare(
        'SELECT q.title, q.description, DATE(uq.completed_at) AS completed_on
           FROM user_quests uq
           JOIN quests q ON q.id = uq.quest_id
          WHERE uq.user_id = :id AND uq.status = \'completed\'
          ORDER BY uq.completed_at DESC, q.title'
    );
    $stmt->execute([':id' => $uid]);
    $completedQuests = array_map(
        fn($r) => [
            'title'        => $r['title'],
            'description'  => $r['description'],
            'completed_on' => $r['completed_on'],
        ],
        $stmt->fetchAll()
    );

    // The passport card shows the user's most recently started active quest.
    $stmt = $pdo->prepare(
        'SELECT uq.id AS user_quest_id, uq.status, uq.progress_count,
                uq.started_at, uq.expires_at, uq.completed_at,
                q.id AS quest_id, q.quest_key, q.title, q.description, q.icon,
                q.quest_type, q.quest_category, q.target_count, q.xp_reward,
                b.badge_name AS reward_badge_name
           FROM user_quests uq
           JOIN quests q ON q.id = uq.quest_id
           LEFT JOIN badges b ON b.badge_key = q.reward_badge_key
          WHERE uq.user_id = :id AND uq.status = \'active\'
          ORDER BY uq.started_at DESC, uq.id DESC
          LIMIT 1'
    );
    $stmt->execute([':id' => $uid]);
    $activeQuest = $stmt->fetch();

    if ($activeQuest) {
        $activeQuest['user_quest_id'] = (int) $activeQuest['user_quest_id'];
        $activeQuest['progress_count'] = (int) $activeQuest['progress_count'];
        $activeQuest['target_count'] = (int) $activeQuest['target_count'];
        $activeQuest['xp_reward'] = (int) $activeQuest['xp_reward'];
        $activeQuest['stops'] = [];

        if ($activeQuest['quest_type'] === 'sites') {
            // Join this user's completed stops, then label the first remaining stop as next.
            $stmt = $pdo->prepare(
                'SELECT s.id AS site_id, s.title, qs.stop_order,
                        CASE WHEN uqs.id IS NOT NULL THEN \'done\' ELSE \'pending\' END AS stop_state
                   FROM quest_stops qs
                   JOIN sites s ON s.id = qs.site_id
                   LEFT JOIN user_quest_stops uqs
                     ON uqs.user_quest_id = :user_quest_id
                    AND uqs.quest_stop_id = qs.id
                  WHERE qs.quest_id = :quest_id
                  ORDER BY qs.stop_order'
            );
            $stmt->execute([
                ':user_quest_id' => $activeQuest['user_quest_id'],
                ':quest_id' => (int) $activeQuest['quest_id'],
            ]);
            $stops = $stmt->fetchAll();
            $nextPendingStop = true;
            foreach ($stops as &$stop) {
                $stop['stop_order'] = (int) $stop['stop_order'];
                if ($stop['stop_state'] === 'done') {
                    continue;
                }
                $stop['stop_state'] = $nextPendingStop ? 'next' : 'locked';
                $nextPendingStop = false;
            }
            unset($stop);
            $activeQuest['stops'] = $stops;
        }

        $activeQuest['progress_count'] = min(
            $activeQuest['progress_count'],
            $activeQuest['target_count']
        );
    }

    // Group verified check-ins by date for the passport's streak-history dialog.
    $stmt = $pdo->prepare(
        'SELECT DATE(created_at) AS checkin_date, COUNT(*) AS checkin_count
           FROM checkins
          WHERE user_id = :id
            AND is_verified = 1
          GROUP BY DATE(created_at)
          ORDER BY checkin_date DESC'
    );
    $stmt->execute([':id' => $uid]);
    $checkinDays = array_map(
        fn($r) => [
            'date'  => $r['checkin_date'],
            'count' => (int) $r['checkin_count'],
        ],
        $stmt->fetchAll()
    );

    // Return every badge so the page can render both earned and locked collection slots.
    // The new-badge marker is only active on the award date, through the end of that day.
    $stmt = $pdo->prepare(
        'SELECT b.badge_key, b.badge_name, b.description, b.icon, b.rarity,
                b.sort_order, ub.id AS user_badge_id,
                DATE(ub.awarded_at) AS awarded_on,
                CASE
                    WHEN ub.is_new = 1 AND DATE(ub.awarded_at) = CURRENT_DATE() THEN 1
                    ELSE 0
                END AS is_new
           FROM badges b
           LEFT JOIN user_badges ub
             ON ub.badge_key = b.badge_key AND ub.user_id = :id
          ORDER BY b.sort_order, b.id'
    );
    $stmt->execute([':id' => $uid]);
    $badges = array_map(
        fn($r) => [
            'key'         => $r['badge_key'],
            'name'        => $r['badge_name'],
            'description' => $r['description'],
            'icon'        => $r['icon'],
            'rarity'      => $r['rarity'],
            'sort_order'  => (int) $r['sort_order'],
            'awarded_on'  => $r['awarded_on'],
            'is_new'      => (bool) $r['is_new'],
            'earned'      => $r['user_badge_id'] !== null,
        ],
        $stmt->fetchAll()
    );

    // The chart uses Monday-first arrays, with a weekly total and a breakdown by site.
    $weekly = [
        'week' => array_fill(0, 7, 0),
    ];
    // Count each verified site once per calendar day, regardless of repeat check-ins.
    $stmt = $pdo->prepare(
        'SELECT c.site_id, s.title AS site_name,
                MOD(DAYOFWEEK(c.created_at) + 5, 7) AS dow,
                COUNT(DISTINCT DATE(c.created_at)) AS visit_count
           FROM checkins c
           JOIN sites s ON s.id = c.site_id
          WHERE c.user_id = :id
            AND c.is_verified = 1
            AND YEARWEEK(c.created_at, 1) = YEARWEEK(NOW(), 1)
          GROUP BY c.site_id, s.title, dow
          ORDER BY s.title'
    );
    $stmt->execute([':id' => $uid]);
    $siteWeek = [];
    foreach ($stmt->fetchAll() as $row) {
        $siteId = (int) $row['site_id'];
        if (!isset($siteWeek[$siteId])) {
            $siteWeek[$siteId] = [
                'site_id' => $siteId,
                'site_name' => $row['site_name'],
                'week' => array_fill(0, 7, 0),
            ];
        }
        $day = (int) $row['dow'];
        $count = (int) $row['visit_count'];
        $siteWeek[$siteId]['week'][$day] = $count;
        $weekly['week'][$day] += $count;
    }
    $weekly['sites'] = array_values($siteWeek);

    // Return the full stamp catalog and mark a stamp earned from either an award row
    // or a verified visit to its site, so existing visits still appear on the passport.
    $stmt = $pdo->prepare(
        'SELECT s.stamp_key, s.stamp_name,
                COALESCE(DATE(us.awarded_at), DATE(verified_visit.visited_at)) AS awarded_on,
                s.description, s.icon, s.rarity, us.id AS user_stamp_id,
                us.is_new,
                COALESCE(us.site_id, s.site_id) AS site_id,
                site.title AS site_name,
                CASE WHEN us.id IS NOT NULL OR verified_visit.checkin_id IS NOT NULL
                     THEN 1 ELSE 0 END AS is_earned
           FROM stamps s
           LEFT JOIN user_stamps us
             ON us.stamp_key = s.stamp_key AND us.user_id = :id
           LEFT JOIN sites site ON site.id = COALESCE(us.site_id, s.site_id)
           LEFT JOIN (
                SELECT user_id, site_id, MIN(id) AS checkin_id, MIN(created_at) AS visited_at
                  FROM checkins
                 WHERE is_verified = 1
                 GROUP BY user_id, site_id
           ) verified_visit
             ON verified_visit.user_id = :id
            AND verified_visit.site_id = s.site_id
          ORDER BY s.id'
    );
    $stmt->execute([':id' => $uid]);
    $stamps = array_map(
        fn($r) => [
            'key'        => $r['stamp_key'],
            'name'       => $r['stamp_name'],
            'awarded_on' => $r['awarded_on'],
            'earned'     => (bool) $r['is_earned'],
            'is_new'     => (bool) $r['is_new'],
            'description' => $r['description'],
            'icon'       => $r['icon'],
            'rarity'     => $r['rarity'],
            'site_id'    => $r['site_id'] === null ? null : (int) $r['site_id'],
            'site_name'  => $r['site_name'],
        ],
        $stmt->fetchAll()
    );

    // Keep a single response shape for profile data, progress dialogs, and the chart.
    echo json_encode([
        'user' => [
            'username'     => $user['username'],
            'display_name' => $user['display_name'],
            'xp_count'     => (int) $user['xp_count'],
            'streak_count' => (int) $user['streak_count'],
            'longest_streak' => (int) $user['longest_streak'],
        ],
        'levels' => $levels,
        'stats' => [
            'sites_visited' => (int) $stats['sites_visited'],
            'hidden_gems'   => (int) $stats['hidden_gems'],
            'quests_done'   => count($completedQuests),
        ],
        'visited_sites' => $visitedSites,
        'completed_quests' => $completedQuests,
        'active_quest' => $activeQuest ?: null,
        'checkin_days' => $checkinDays,
        'badges' => $badges,
        'weekly' => $weekly,
        'stamps' => $stamps,
    ], JSON_UNESCAPED_UNICODE);

} catch (PDOException $e) {
    // Log database details on the server; return a generic message to the browser.
    error_log('passport.php: ' . $e->getMessage());
    fail(500, 'Database error');
}
