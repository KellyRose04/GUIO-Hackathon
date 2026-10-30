<?php
// Load shared account and database helpers used by this API endpoint.
require_once __DIR__ . '/config.php';

// Tell clients that every response body from this endpoint is JSON.
header('Content-Type: application/json; charset=utf-8');

// Limit accepted uploads to 10 MiB to constrain storage and request size.
const MAX_CHECKIN_IMAGE_BYTES = 10485760;
// Require a GPS fix to be within this radius of the selected site.
const CHECKIN_RADIUS_METERS = 250;

/**
 * Send a JSON response with an HTTP status and stop further request handling.
 */
function respond(int $statusCode, array $body): void
{
    // Set the HTTP status before writing the response body.
    http_response_code($statusCode);
    // Encode the response while preserving readable URL slashes.
    echo json_encode($body, JSON_UNESCAPED_SLASHES);
    // Prevent any later endpoint logic from running.
    exit;
}

/**
 * Add a badge only if it exists and the user has not already earned it.
 */
function awardBadge(PDO $pdo, int $userId, string $badgeKey): bool
{
    // Insert from the badge catalogue; IGNORE makes repeat awards idempotent.
    $statement = $pdo->prepare(
        'INSERT IGNORE INTO user_badges (user_id, badge_key, is_new)
         SELECT :user_id, badge_key, 1
           FROM badges
          WHERE badge_key = :badge_key'
    );
    // Bind user and badge values rather than interpolating them into SQL.
    $statement->execute([':user_id' => $userId, ':badge_key' => $badgeKey]);

    // A single inserted row means this call newly awarded the badge.
    return $statement->rowCount() === 1;
}

/**
 * Advance active site and streak quests for a verified check-in.
 * Returns the XP earned by quests completed during this update.
 */
function updateQuestProgressForCheckin(
    PDO $pdo,
    int $userId,
    int $siteId,
    int $checkinId,
    string $visitDate,
    int $streakCount,
    bool $isCurrentStreakCheckin,
    array &$badgesAwarded,
    array &$questsCompleted
): int
{
    // Find active site quests that include the verified site as a stop.
    $statement = $pdo->prepare(
        'SELECT uq.id AS user_quest_id, uq.progress_count, q.target_count, q.title,
                q.xp_reward, q.reward_badge_key, qs.id AS quest_stop_id
           FROM user_quests uq
           JOIN quests q ON q.id = uq.quest_id
           JOIN quest_stops qs ON qs.quest_id = q.id
          WHERE uq.user_id = :user_id
            AND uq.status = \'active\'
            AND q.quest_type = \'sites\'
            AND qs.site_id = :site_id'
    );
    // Retrieve matching quest stops and initialize the accumulated XP reward.
    $statement->execute([':user_id' => $userId, ':site_id' => $siteId]);
    $questStops = $statement->fetchAll();
    $rewardXp = 0;

    // Record this check-in against each matching site quest.
    foreach ($questStops as $questStop) {
        // Avoid counting the same stop twice for one user quest.
        $insertStop = $pdo->prepare(
            'INSERT IGNORE INTO user_quest_stops
                (user_quest_id, quest_stop_id, checkin_id)
             VALUES (:user_quest_id, :quest_stop_id, :checkin_id)'
        );
        $insertStop->execute([
            ':user_quest_id' => (int) $questStop['user_quest_id'],
            ':quest_stop_id' => (int) $questStop['quest_stop_id'],
            ':checkin_id' => $checkinId,
        ]);

        // Recount recorded stops so progress reflects the saved quest-stop rows.
        $countStops = $pdo->prepare(
            'SELECT COUNT(*)
               FROM user_quest_stops
              WHERE user_quest_id = :user_quest_id'
        );
        $countStops->execute([':user_quest_id' => (int) $questStop['user_quest_id']]);
        $progress = (int) $countStops->fetchColumn();
        $target = (int) $questStop['target_count'];
        // Mark the quest complete only after the target number of stops is reached.
        $completed = $progress >= $target;
        // Persist bounded progress and completion status for the active quest.
        $updateQuest = $pdo->prepare(
            'UPDATE user_quests
                SET progress_count = :progress_count,
                    status = :status,
                    completed_at = CASE WHEN :completed = 1 THEN COALESCE(completed_at, NOW()) ELSE completed_at END
              WHERE id = :user_quest_id AND status = \'active\''
        );
        $updateQuest->execute([
            ':progress_count' => min($progress, $target),
            ':status' => $completed ? 'completed' : 'active',
            ':completed' => $completed ? 1 : 0,
            ':user_quest_id' => (int) $questStop['user_quest_id'],
        ]);

        // Grant quest XP and its optional badge only on the transition to completed.
        if ($completed && $updateQuest->rowCount() === 1) {
            $rewardXp += (int) $questStop['xp_reward'];
            $questsCompleted[] = (string) $questStop['title'];
            if (
                $questStop['reward_badge_key'] !== null &&
                awardBadge($pdo, $userId, (string) $questStop['reward_badge_key'])
            ) {
                $badgesAwarded[] = (string) $questStop['reward_badge_key'];
            }
        }
    }

    // Streak quests advance only for check-ins on or after the latest active date.
    if ($isCurrentStreakCheckin) {
        // Lock active streak quests while their progress is being recalculated.
        $streakQuests = $pdo->prepare(
            'SELECT uq.id AS user_quest_id, uq.started_at, q.target_count, q.title,
                    q.xp_reward, q.reward_badge_key
               FROM user_quests uq
               JOIN quests q ON q.id = uq.quest_id
              WHERE uq.user_id = :user_id
                AND uq.status = \'active\'
                AND q.quest_type = \'streak\'
              FOR UPDATE'
        );
        $streakQuests->execute([':user_id' => $userId]);

        // Recalculate progress for each streak quest from its start date.
        foreach ($streakQuests->fetchAll() as $streakQuest) {
            // Normalize quest start to a calendar date, then compare it to this visit.
            $startedAt = new DateTimeImmutable((string) $streakQuest['started_at']);
            $questStartDate = new DateTimeImmutable($startedAt->format('Y-m-d'));
            $checkinDate = new DateTimeImmutable($visitDate);
            $daysSinceStart = (int) $questStartDate->diff($checkinDate)->format('%r%a');
            // Ignore check-ins dated before the quest began.
            if ($daysSinceStart < 0) {
                continue;
            }

            $target = (int) $streakQuest['target_count'];
            // Progress cannot exceed elapsed days, the user's streak, or the quest target.
            $progress = min($daysSinceStart + 1, $streakCount, $target);
            $completed = $progress >= $target;
            // Persist the recalculated streak quest progress.
            $updateQuest = $pdo->prepare(
                'UPDATE user_quests
                    SET progress_count = :progress_count,
                        status = :status,
                        completed_at = CASE WHEN :completed = 1 THEN COALESCE(completed_at, NOW()) ELSE completed_at END
                  WHERE id = :user_quest_id AND status = \'active\''
            );
            $updateQuest->execute([
                ':progress_count' => $progress,
                ':status' => $completed ? 'completed' : 'active',
                ':completed' => $completed ? 1 : 0,
                ':user_quest_id' => (int) $streakQuest['user_quest_id'],
            ]);

            // Grant rewards once, when this update first completes the quest.
            if ($completed && $updateQuest->rowCount() === 1) {
                $rewardXp += (int) $streakQuest['xp_reward'];
                $questsCompleted[] = (string) $streakQuest['title'];
                if (
                    $streakQuest['reward_badge_key'] !== null &&
                    awardBadge($pdo, $userId, (string) $streakQuest['reward_badge_key'])
                ) {
                    $badgesAwarded[] = (string) $streakQuest['reward_badge_key'];
                }
            }
        }
    }

    // Return the sum of XP rewards from quests completed in this check-in.
    return $rewardXp;
}

/**
 * Create the database connection and configure PDO and the app's timezone.
 */
function openDatabase(): PDO
{
    // Set the local database connection parameters and UTF-8 character set.
    $host = 'localhost';
    $db = 'tourtrail_db';
    $user = 'root';
    $pass = '';
    $charset = 'utf8mb4';
    $dsn = "mysql:host=$host;dbname=$db;charset=$charset";
    // Make database errors explicit, return associative rows, and use native prepares.
    $options = [
        PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION,
        PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
        PDO::ATTR_EMULATE_PREPARES => false,
    ];

    // Open the PDO connection using the configured MySQL DSN and options.
    $pdo = new PDO($dsn, $user, $pass, $options);
    // Use the application timezone for date-sensitive database operations.
    $pdo->exec("SET time_zone = '+08:00'");

    // Return the configured connection to the endpoint.
    return $pdo;
}

/**
 * Read and validate an optional latitude or longitude from the POST body.
 */
function parseOptionalCoordinate(string $key, float $minimum, float $maximum): ?float
{
    // Treat an omitted or empty coordinate as unavailable.
    if (!isset($_POST[$key]) || $_POST[$key] === '') {
        return null;
    }
    if (!is_numeric($_POST[$key])) {
        // Reject malformed coordinate values with a client error response.
        respond(400, ['status' => 'error', 'error' => "Invalid $key coordinate."]);
    }

    // Convert the submitted scalar to a number for range validation and distance math.
    $value = (float) $_POST[$key];
    if (!is_finite($value) || $value < $minimum || $value > $maximum) {
        // Reject infinite or geographically impossible coordinates.
        respond(400, ['status' => 'error', 'error' => "Invalid $key coordinate."]);
    }

    // Return the validated coordinate; null represents an omitted value.
    return $value;
}

/**
 * Calculate the great-circle distance between two GPS coordinates in meters.
 */
function distanceInMeters(float $lat1, float $lng1, float $lat2, float $lng2): float
{
    // Convert angular differences to radians for trigonometric calculations.
    $toRadians = static fn (float $degrees): float => $degrees * M_PI / 180;
    $deltaLat = $toRadians($lat2 - $lat1);
    $deltaLng = $toRadians($lng2 - $lng1);
    // Apply the haversine formula to account for Earth's curvature.
    $a = sin($deltaLat / 2) ** 2
        + cos($toRadians($lat1)) * cos($toRadians($lat2)) * sin($deltaLng / 2) ** 2;

    // Convert the central angle to a distance using Earth's mean radius in meters.
    return 6371000 * 2 * atan2(sqrt($a), sqrt(1 - $a));
}

// Open the database before processing either supported check-in operation.
try {
    $pdo = openDatabase();
} catch (PDOException $error) {
    // Log diagnostic detail for operators but return a generic message to clients.
    error_log('Check-in database connection failed: ' . $error->getMessage());
    respond(500, ['status' => 'error', 'error' => 'The check-in database is unavailable.']);
}

// Resolve the requested account and reject invalid or unavailable accounts early.
try {
    $username = tourtrail_requested_username();
} catch (InvalidArgumentException $error) {
    respond(400, ['status' => 'error', 'error' => 'The selected account is invalid.']);
}
// Look up the database identity that scopes all check-in reads and writes.
$userId = tourtrail_find_user_id($pdo, $username);
if ($userId === null) {
    respond(404, ['status' => 'error', 'error' => 'The selected account is unavailable.']);
}

// PATCH awards rewards for a previously verified check-in.
if ($_SERVER['REQUEST_METHOD'] === 'PATCH') {
    // Decode the JSON request body and validate its check-in identifier.
    $body = json_decode(file_get_contents('php://input'), true);
    $checkinId = filter_var($body['checkin_id'] ?? null, FILTER_VALIDATE_INT);
    if (!$checkinId || $checkinId < 1) {
        respond(400, ['status' => 'error', 'error' => 'A valid check-in ID is required.']);
    }

    // Keep reward, quest, streak, and badge updates atomic.
    $pdo->beginTransaction();
    try {
        // Lock the selected verified check-in and related user/site reward data.
        $statement = $pdo->prepare(
            'SELECT c.is_verified, c.site_id, c.xp_earned, c.created_at,
                    s.xp_reward, s.is_hidden_gem, s.category,
                    u.xp_count, u.streak_count, u.longest_streak, u.last_active_date
             FROM checkins c
             JOIN sites s ON s.id = c.site_id
             JOIN users u ON u.id = c.user_id
             WHERE c.id = :checkin_id AND c.user_id = :user_id
             FOR UPDATE'
        );
        $statement->execute([':checkin_id' => $checkinId, ':user_id' => $userId]);
        $checkin = $statement->fetch();
        // Only this user's verified check-ins may be rewarded.
        if (!$checkin || !(bool) $checkin['is_verified']) {
            $pdo->rollBack();
            respond(404, ['status' => 'error', 'error' => 'Verified check-in not found.']);
        }
        $siteId = (int) $checkin['site_id'];
        // Detect whether this is the user's first verified visit to this site.
        $previousVisit = $pdo->prepare(
            'SELECT 1
               FROM checkins
              WHERE user_id = :user_id
                AND site_id = :site_id
                AND is_verified = 1
                AND id <> :checkin_id
              LIMIT 1'
        );
        $previousVisit->execute([
            ':user_id' => $userId,
            ':site_id' => $siteId,
            ':checkin_id' => $checkinId,
        ]);
        $isFirstVerifiedVisit = !$previousVisit->fetchColumn();

        // Find the site's passport stamp, if a stamp is already configured.
        $stampStatement = $pdo->prepare(
            'SELECT s.stamp_key, s.stamp_name
               FROM stamps s
              WHERE s.site_id = :site_id
              ORDER BY s.id
              LIMIT 1'
        );
        $stampStatement->execute([':site_id' => $siteId]);
        $stamp = $stampStatement->fetch();
        // Create a default stamp for the site when none exists yet.
        if (!$stamp) {
            $createSiteStamp = $pdo->prepare(
                'INSERT IGNORE INTO stamps
                    (stamp_key, stamp_name, site_id, description, icon, rarity)
                 SELECT CONCAT(\'discovery-site-\', id),
                        CONCAT(SUBSTRING_INDEX(title, \' \', 1), \' Explorer\'),
                        id,
                        CONCAT(\'Awarded for a verified map check-in at \', title, \'.\'),
                        \'assets/pin.png\',
                        \'common\'
                   FROM sites
                  WHERE id = :site_id'
            );
            $createSiteStamp->execute([':site_id' => $siteId]);
            $stampStatement->execute([':site_id' => $siteId]);
            $stamp = $stampStatement->fetch();
            // Abort the reward operation if a stamp still cannot be obtained.
            if (!$stamp) {
                $pdo->rollBack();
                respond(500, ['status' => 'error', 'error' => 'A passport stamp could not be created for the verified site.']);
            }
        }

        // Award the site stamp only when the user does not already own it.
        $stampAwarded = false;
        $existingStamp = $pdo->prepare(
            'SELECT id FROM user_stamps
              WHERE user_id = :user_id AND stamp_key = :stamp_key
              FOR UPDATE'
        );
        $existingStamp->execute([
            ':user_id' => $userId,
            ':stamp_key' => $stamp['stamp_key'],
        ]);
        if (!$existingStamp->fetchColumn()) {
            $awardStamp = $pdo->prepare(
                'INSERT INTO user_stamps
                    (user_id, stamp_key, stamp_name, site_id, checkin_id, is_new)
                 VALUES (:user_id, :stamp_key, :stamp_name, :site_id, :checkin_id, 1)'
            );
            $awardStamp->execute([
                ':user_id' => $userId,
                ':stamp_key' => $stamp['stamp_key'],
                ':stamp_name' => $stamp['stamp_name'],
                ':site_id' => $siteId,
                ':checkin_id' => $checkinId,
            ]);
            $stampAwarded = true;
        }

        // Reuse a previously recorded XP amount, or award site XP on the first visit.
        $previousXp = (int) $checkin['xp_earned'];
        $xpEarned = $previousXp > 0
            ? $previousXp
            : ($isFirstVerifiedVisit ? (int) $checkin['xp_reward'] : 0);

        // Save the XP assigned to this particular check-in.
        $updateCheckin = $pdo->prepare(
            'UPDATE checkins SET xp_earned = :xp_earned
              WHERE id = :checkin_id AND user_id = :user_id'
        );
        $updateCheckin->execute([
            ':xp_earned' => $xpEarned,
            ':checkin_id' => $checkinId,
            ':user_id' => $userId,
        ]);

        // Derive the visit date and current streak values from the locked records.
        $visitDate = (new DateTimeImmutable((string) $checkin['created_at']))->format('Y-m-d');
        $lastActiveDate = $checkin['last_active_date'];
        $streakCount = (int) $checkin['streak_count'];
        $longestStreak = (int) $checkin['longest_streak'];
        $streakUpdated = false;
        // Update streak counters only when this check-in is later than the last active date.
        if ($visitDate > (string) ($lastActiveDate ?? '0000-00-00')) {
            $dayDifference = $lastActiveDate
                ? (int) (new DateTimeImmutable((string) $lastActiveDate))->diff(
                    new DateTimeImmutable($visitDate)
                )->format('%r%a')
                : 0;
            $streakCount = $dayDifference === 1 ? $streakCount + 1 : 1;
            $streakUpdated = true;
            $longestStreak = max($longestStreak, $streakCount);
            // Persist the recalculated current and longest streak values.
            $updateStreak = $pdo->prepare(
                'UPDATE users
                    SET streak_count = :streak_count,
                        longest_streak = :longest_streak,
                        last_active_date = :last_active_date
                  WHERE id = :user_id'
            );
            $updateStreak->execute([
                ':streak_count' => $streakCount,
                ':longest_streak' => $longestStreak,
                ':last_active_date' => $visitDate,
                ':user_id' => $userId,
            ]);
        }

        // Only current or newer check-ins should advance active streak quests.
        $isCurrentStreakCheckin = $lastActiveDate === null || $visitDate >= (string) $lastActiveDate;
        // Track quest badges alongside XP so the response can notify about every new award.
        $badgesAwarded = [];
        $questsCompleted = [];
        // Update active quests and collect any quest-completion XP.
        $questXp = updateQuestProgressForCheckin(
            $pdo,
            $userId,
            $siteId,
            $checkinId,
            $visitDate,
            $streakCount,
            $isCurrentStreakCheckin,
            $badgesAwarded,
            $questsCompleted
        );
        // Add newly earned site XP and quest XP to the user's account total.
        $totalXpDelta = max(0, $xpEarned - $previousXp) + $questXp;
        if ($totalXpDelta > 0) {
            $updateUserXp = $pdo->prepare(
                'UPDATE users SET xp_count = xp_count + :xp_delta WHERE id = :user_id'
            );
            $updateUserXp->execute([
                ':xp_delta' => $totalXpDelta,
                ':user_id' => $userId,
            ]);
        }

        // Calculate the user's verified-site, gem, food, and night-visit badge criteria.
        $verifiedStats = $pdo->prepare(
            'SELECT COUNT(DISTINCT c.site_id) AS visited_sites,
                    COUNT(DISTINCT CASE WHEN s.is_hidden_gem = 1 THEN c.site_id END) AS hidden_gems,
                    COUNT(DISTINCT CASE WHEN s.category IN (\'food\', \'food_drink\', \'food & drink\') THEN c.site_id END) AS food_sites,
                    MAX(HOUR(c.created_at) >= 18 OR HOUR(c.created_at) < 5) AS night_visit
               FROM checkins c
               JOIN sites s ON s.id = c.site_id
              WHERE c.user_id = :user_id AND c.is_verified = 1'
        );
        $verifiedStats->execute([':user_id' => $userId]);
        $stats = $verifiedStats->fetch();

        // Start with the baseline badge and add badges whose criteria are met.
        $badgeKeys = ['first-steps'];
        if ((int) $stats['hidden_gems'] > 0) $badgeKeys[] = 'gem-hunter';
        if ((int) $stats['food_sites'] >= 1) $badgeKeys[] = 'foodie';
        if ((bool) $stats['night_visit']) $badgeKeys[] = 'night-owl';
        if ($streakCount >= 7) $badgeKeys[] = 'week-streak';

        // Check whether the user has completed any of the predefined site quests.
        $completedQuestSites = $pdo->prepare(
            'SELECT qs.quest_id, COUNT(DISTINCT qs.site_id) AS completed_sites,
                    q.target_count
               FROM quest_stops qs
               JOIN quests q ON q.id = qs.quest_id
               JOIN checkins c ON c.site_id = qs.site_id
                              AND c.user_id = :user_id
                              AND c.is_verified = 1
              WHERE qs.quest_id IN (2, 3)
              GROUP BY qs.quest_id, q.target_count'
        );
        $completedQuestSites->execute([':user_id' => $userId]);
        // Map completed quest IDs to their corresponding badge keys.
        foreach ($completedQuestSites->fetchAll() as $questSites) {
            if ((int) $questSites['completed_sites'] >= (int) $questSites['target_count']) {
                $badgeKeys[] = (int) $questSites['quest_id'] === 2
                    ? 'heritage-buff'
                    : 'trailblazer';
            }
        }

        // Compare the user's collected stamps with all configured stamps.
        $stampCounts = $pdo->prepare(
            'SELECT (SELECT COUNT(*) FROM stamps) AS total,
                    (SELECT COUNT(DISTINCT us.stamp_key)
                       FROM user_stamps us
                       JOIN stamps s ON s.stamp_key = us.stamp_key
                      WHERE us.user_id = :user_id) AS collected'
        );
        $stampCounts->execute([':user_id' => $userId]);
        $counts = $stampCounts->fetch();
        // Award the collector badge after every configured stamp has been collected.
        if ((int) $counts['total'] > 0 && (int) $counts['collected'] >= (int) $counts['total']) {
            $badgeKeys[] = 'collector';
        }

        // Award newly met badge criteria; quest badges were collected above.
        foreach (array_unique($badgeKeys) as $badgeKey) {
            if (awardBadge($pdo, $userId, $badgeKey)) {
                $badgesAwarded[] = $badgeKey;
            }
        }

        // Read the final account XP total and newly earned check-in XP before commit.
        $totalXp = $pdo->prepare('SELECT xp_count FROM users WHERE id = :user_id');
        $totalXp->execute([':user_id' => $userId]);
        $totalXpValue = (int) $totalXp->fetchColumn();
        $xpGained = max(0, $xpEarned - $previousXp);
        // Commit all reward and progress changes together.
        $pdo->commit();
    } catch (PDOException $error) {
        // Roll back partial reward updates if a database operation fails.
        if ($pdo->inTransaction()) {
            $pdo->rollBack();
        }
        error_log('Check-in reward update failed: ' . $error->getMessage());
        respond(500, ['status' => 'error', 'error' => 'The check-in reward could not be saved.']);
    }

    // Return the result of the reward operation to the client.
    respond(200, [
        'status' => 'success',
        'data' => [
            'checkin_id' => $checkinId,
            'xp_earned' => $xpGained,
            'quest_xp' => $questXp,
            'total_xp' => $totalXpValue,
            'stamp_awarded' => $stampAwarded,
            'stamp_status' => !$stamp
                ? 'unavailable'
                : ($stampAwarded ? 'awarded' : 'already_collected'),
            'stamp_name' => $stampAwarded ? $stamp['stamp_name'] : null,
            'quests_completed' => array_values(array_unique($questsCompleted)),
            'streak_updated' => $streakUpdated,
            'badges_awarded' => $badgesAwarded,
            'streak_count' => $streakCount,
        ],
    ]);
}

// Reject methods other than POST after the PATCH reward path has been handled.
if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    header('Allow: POST, PATCH');
    respond(405, ['status' => 'error', 'error' => 'Use POST to save a check-in or PATCH to save its XP reward.']);
}

// Validate the uploaded photo's presence, upload status, and declared size.
$image = $_FILES['photo'] ?? null;
if (!$image || $image['error'] !== UPLOAD_ERR_OK) {
    respond(400, ['status' => 'error', 'error' => 'A photo upload is required.']);
}
if ($image['size'] <= 0 || $image['size'] > MAX_CHECKIN_IMAGE_BYTES) {
    respond(413, ['status' => 'error', 'error' => 'The photo must be smaller than 10 MB.']);
}
if (!is_uploaded_file($image['tmp_name'])) {
    respond(400, ['status' => 'error', 'error' => 'The uploaded photo is invalid.']);
}

// Inspect the actual file content and allow only supported image formats.
$mimeType = (new finfo(FILEINFO_MIME_TYPE))->file($image['tmp_name']);
$extensions = [
    'image/jpeg' => 'jpg',
    'image/png' => 'png',
    'image/webp' => 'webp',
];
if (!isset($extensions[$mimeType])) {
    respond(415, ['status' => 'error', 'error' => 'Only JPEG, PNG, and WebP photos are supported.']);
}

// Parse GPS coordinates and require latitude/longitude to be supplied together.
$latitude = parseOptionalCoordinate('latitude', -90, 90);
$longitude = parseOptionalCoordinate('longitude', -180, 180);
if (($latitude === null) !== ($longitude === null)) {
    respond(400, ['status' => 'error', 'error' => 'Both GPS coordinates must be provided together.']);
}
// Validate optional GPS accuracy as a non-negative numeric value.
if (isset($_POST['accuracy']) && $_POST['accuracy'] !== '') {
    if (!is_numeric($_POST['accuracy']) || !is_finite((float) $_POST['accuracy']) || (float) $_POST['accuracy'] < 0) {
        respond(400, ['status' => 'error', 'error' => 'GPS accuracy must be a non-negative number.']);
    }
}

// Validate an optional site ID claimed by the client.
$claimedSiteId = null;
if (isset($_POST['site_id']) && $_POST['site_id'] !== '') {
    $claimedSiteId = filter_var($_POST['site_id'], FILTER_VALIDATE_INT);
    if (!$claimedSiteId || $claimedSiteId < 1) {
        respond(400, ['status' => 'error', 'error' => 'The site ID is invalid.']);
    }
}

// Ensure the client-provided photo identifier follows the expected local-ID format.
$clientPhotoId = trim($_POST['client_photo_id'] ?? '');
if (!preg_match('/^local-[A-Za-z0-9-]{1,70}$/', $clientPhotoId)) {
    respond(400, ['status' => 'error', 'error' => 'A valid client photo ID is required.']);
}

// Initialize verification outputs; they remain null until the server validates a site.
$verifiedSiteId = null;
$siteTitle = null;
$verificationMessage = null;
$verificationDistance = null;
// Verify a claimed site against server-side coordinates when both site and GPS are present.
if ($claimedSiteId !== null && $latitude !== null) {
    // Load the authoritative site coordinates from the database.
    $siteStatement = $pdo->prepare('SELECT id, title, latitude, longitude FROM sites WHERE id = :site_id');
    $siteStatement->execute([':site_id' => $claimedSiteId]);
    $site = $siteStatement->fetch();
    if (!$site) {
        respond(400, ['status' => 'error', 'error' => 'The selected tourist spot does not exist.']);
    }
    // Calculate and round distance for both the radius check and API response.
    $distance = distanceInMeters(
        $latitude,
        $longitude,
        (float) $site['latitude'],
        (float) $site['longitude']
    );
    $verificationDistance = (int) round($distance);
    // Accept the check-in only when the GPS position falls within the configured radius.
    if ($distance <= CHECKIN_RADIUS_METERS) {
        $verifiedSiteId = (int) $site['id'];
        $siteTitle = $site['title'];
    } else {
        // Explain the failed location check without marking the photo verified.
        $verificationMessage = sprintf(
            'GPS is %d m from %s. Check in within %d m of the site.',
            $verificationDistance,
            $site['title'],
            CHECKIN_RADIUS_METERS
        );
    }
} elseif ($claimedSiteId === null) {
    // A missing site selection prevents map verification.
    $verificationMessage = 'Select a site from the map before checking in.';
} else {
    // A missing GPS fix prevents map verification.
    $verificationMessage = 'A current GPS position is required to verify this site.';
}

// Make uploads idempotent by checking whether this user already saved this photo ID.
$existingStatement = $pdo->prepare(
    'SELECT id, site_id, image_url, is_verified, xp_earned
     FROM checkins WHERE user_id = :user_id AND client_photo_id = :client_photo_id'
);
$existingStatement->execute([
    ':user_id' => $userId,
    ':client_photo_id' => $clientPhotoId,
]);
$existing = $existingStatement->fetch();
// Return the existing check-in rather than storing a duplicate image.
if ($existing) {
    $existingSite = null;
    // Upgrade an earlier unverified row if a valid site/GPS pair is now available.
    if (!(bool) $existing['is_verified'] && $verifiedSiteId !== null) {
        try {
            $upgrade = $pdo->prepare(
                'UPDATE checkins
                    SET site_id = :site_id,
                        caption = :caption,
                        latitude_captured = :latitude,
                        longitude_captured = :longitude,
                        is_verified = 1
                  WHERE id = :checkin_id
                    AND user_id = :user_id
                    AND is_verified = 0'
            );
            $upgrade->execute([
                ':site_id' => $verifiedSiteId,
                ':caption' => 'Verified check-in at ' . $siteTitle,
                ':latitude' => $latitude,
                ':longitude' => $longitude,
                ':checkin_id' => (int) $existing['id'],
                ':user_id' => $userId,
            ]);
        } catch (PDOException $error) {
            // Log update detail and return a generic verification failure.
            error_log('Check-in verification update failed: ' . $error->getMessage());
            respond(500, ['status' => 'error', 'error' => 'The check-in verification could not be updated.']);
        }
        $existing['site_id'] = $verifiedSiteId;
        $existing['is_verified'] = true;
        $existingSite = $siteTitle;
    } elseif ($existing['site_id'] !== null) {
        // Resolve the saved site's display name for the duplicate response.
        $siteStatement = $pdo->prepare('SELECT title FROM sites WHERE id = :site_id');
        $siteStatement->execute([':site_id' => $existing['site_id']]);
        $existingSite = $siteStatement->fetchColumn();
    }
    // Respond with existing check-in data, including current verification status.
    respond(200, [
        'status' => 'success',
        'data' => [
            'checkin_id' => (int) $existing['id'],
            'site_id' => $existing['site_id'] === null ? null : (int) $existing['site_id'],
            'site_name' => $existingSite ?: null,
            'image_url' => $existing['image_url'],
            'is_verified' => (bool) $existing['is_verified'],
            'verification_status' => (bool) $existing['is_verified'] ? 'verified' : 'unverified',
            'verification_message' => $verificationMessage,
            'verification_distance_meters' => $verificationDistance,
            'xp_earned' => (int) $existing['xp_earned'],
        ],
    ]);
}

// Build the caption stored with the photo, reflecting whether map verification passed.
$caption = $siteTitle === null
    ? 'Photo check-in; tourist spot not verified.'
    : 'Verified check-in at ' . $siteTitle;
// Create the check-in upload directory on demand.
$uploadDirectory = dirname(__DIR__) . DIRECTORY_SEPARATOR . 'uploads' . DIRECTORY_SEPARATOR . 'checkins';
if (!is_dir($uploadDirectory) && !mkdir($uploadDirectory, 0755, true) && !is_dir($uploadDirectory)) {
    respond(500, ['status' => 'error', 'error' => 'Photo storage is unavailable.']);
}

// Generate a random server-side filename and retain a web-relative path for the database.
$filename = bin2hex(random_bytes(16)) . '.' . $extensions[$mimeType];
$absolutePath = $uploadDirectory . DIRECTORY_SEPARATOR . $filename;
$relativePath = 'uploads/checkins/' . $filename;
// Move the validated PHP upload into persistent check-in storage.
if (!move_uploaded_file($image['tmp_name'], $absolutePath)) {
    respond(500, ['status' => 'error', 'error' => 'The photo could not be stored.']);
}

// Insert the check-in record, including location and server-determined verification.
try {
    $insert = $pdo->prepare(
    'INSERT INTO checkins
      (user_id, client_photo_id, site_id, image_url, caption,
       latitude_captured, longitude_captured, is_verified, xp_earned)
     VALUES
      (:user_id, :client_photo_id, :site_id, :image_url, :caption,
       :latitude, :longitude, :is_verified, 0)'
    );

    // Bind each submitted or server-derived value to its database placeholder.
    $insert->execute([
        ':user_id' => $userId,
        ':client_photo_id' => $clientPhotoId,
        ':site_id' => $verifiedSiteId,
        ':image_url' => $relativePath,
        ':caption' => $caption,
        ':latitude' => $latitude,
        ':longitude' => $longitude,
        ':is_verified' => $verifiedSiteId !== null ? 1 : 0,
    ]);
} catch (PDOException $error) {
    // Remove the stored image if its database row could not be created.
    if (is_file($absolutePath)) {
        unlink($absolutePath);
    }
    error_log('Check-in insert failed: ' . $error->getMessage());
    respond(500, ['status' => 'error', 'error' => 'The check-in could not be saved to the database.']);
}

// Return the new check-in record and verification result to the client.
respond(201, [
    'status' => 'success',
    'data' => [
        'checkin_id' => (int) $pdo->lastInsertId(),
        'site_id' => $verifiedSiteId,
        'site_name' => $siteTitle,
        'image_url' => $relativePath,
        'is_verified' => $verifiedSiteId !== null,
        'verification_status' => $verifiedSiteId !== null ? 'verified' : 'unverified',
        'verification_message' => $verificationMessage,
        'verification_distance_meters' => $verificationDistance,
        'xp_earned' => 0,
    ],
]);