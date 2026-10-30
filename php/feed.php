<?php
/**
 * TourTrail: feed.php
 *
 * JSON API endpoint for the social feed.
 *
 * Supported requests:
 *   GET  ?suggest=1&q=...   Site name autocomplete suggestions
 *   GET  ?comments=ID       Comments for a single check-in
 *   GET  (default)          Paginated feed of explorers' check-ins
 *                           (optional: tag, q, siteId, sort, limit, page)
 *   POST {action: comment}      Add a comment to a check-in
 *   POST {action: site_follow}  Follow or unfollow the site linked to a check-in
 *   POST {checkinId, liked}     Like or unlike a check-in
 *
 * All responses are JSON. Errors are returned as {"error": "..."}.
 */
declare(strict_types=1);

// Load shared configuration and user helper functions
require_once __DIR__ . '/../api/config.php';

// Every response from this endpoint is JSON
header('Content-Type: application/json; charset=utf-8');
header('Cache-Control: no-store');

/**
 * Sends a JSON response and terminates the script.
 *
 * @param int   $statusCode HTTP status code to send.
 * @param array $body       Data to encode as the JSON response body.
 *
 * @return void This function never returns because it calls exit.
 */
function respond(int $statusCode, array $body): void
{
    http_response_code($statusCode);
    echo json_encode($body, JSON_UNESCAPED_SLASHES | JSON_INVALID_UTF8_SUBSTITUTE);
    exit;
} // end of respond

// Reject any HTTP method other than GET and POST
if (!in_array($_SERVER['REQUEST_METHOD'], ['GET', 'POST'], true)) {
    header('Allow: GET, POST');
    respond(405, ['error' => 'Use GET to read the feed or POST to update likes, comments, or followed sites.']);
} // end of request method check

try {
    // Initialize $pdo first so the catch block can safely check it
    $pdo = null;

    // Identify the viewer making the request
    $username = tourtrail_requested_username();

    // Open the database connection with exceptions, assoc fetch mode,
    // and real (non-emulated) prepared statements
    $pdo = new PDO(
        'mysql:host=localhost;dbname=guio_db;charset=utf8mb4',
        'root',
        '',
        [
            PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION,
            PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
            PDO::ATTR_EMULATE_PREPARES => false,
        ]
    );

    // Resolve the viewer's user ID; stop if the user does not exist
    $viewerId = tourtrail_find_user_id($pdo, $username);
    if ($viewerId === null) {
        respond(404, ['error' => 'User not found.']);
    } // end of viewer lookup check

    /* ----------------------------------------------------------------------
       GET: site name suggestions for the search box
       ---------------------------------------------------------------------- */
    if ($_SERVER['REQUEST_METHOD'] === 'GET' && isset($_GET['suggest'])) {
        // Read and sanitize the typed search text
        $queryValue = $_GET['q'] ?? '';
        $query = is_string($queryValue) ? trim($queryValue) : '';

        // Require at least two characters before searching
        if (strlen($query) < 2) {
            respond(200, ['suggestions' => []]);
        } // end of minimum query length check

        // Find up to 8 site titles containing the text
        // (addcslashes escapes LIKE wildcards so they match literally)
        $suggestions = $pdo->prepare(
            'SELECT id, title AS name
               FROM sites
              WHERE title LIKE :site_query
              ORDER BY title ASC
              LIMIT 8'
        );
        $suggestions->execute([':site_query' => '%' . addcslashes($query, '\\%_') . '%']);
        respond(200, ['suggestions' => $suggestions->fetchAll()]);
    } // end of suggestions request

    /* ----------------------------------------------------------------------
       GET: comments for a single check-in
       ---------------------------------------------------------------------- */
    if ($_SERVER['REQUEST_METHOD'] === 'GET' && isset($_GET['comments'])) {
        // Validate that the check-in ID is a positive integer
        $checkinId = filter_var($_GET['comments'], FILTER_VALIDATE_INT);
        if ($checkinId === false || $checkinId === null || $checkinId < 1) {
            respond(400, ['error' => 'A valid check-in ID is required.']);
        } // end of check-in ID validation

        // Fetch comments oldest-first with the author's display name
        // (falls back to username when display_name is empty)
        $comments = $pdo->prepare(
            'SELECT cc.id, cc.comment_text AS text, cc.created_at AS createdAt,
                    COALESCE(NULLIF(u.display_name, \'\'), u.username) AS author
               FROM checkin_comments AS cc
               INNER JOIN users AS u ON u.id = cc.user_id
              WHERE cc.checkin_id = :checkin_id
              ORDER BY cc.created_at ASC, cc.id ASC'
        );
        $comments->execute([':checkin_id' => $checkinId]);
        respond(200, ['comments' => $comments->fetchAll()]);
    } // end of comments request

    /* ----------------------------------------------------------------------
       POST: comment, site follow, and like actions
       ---------------------------------------------------------------------- */
    if ($_SERVER['REQUEST_METHOD'] === 'POST') {
        // Decode the JSON request body
        $body = json_decode(file_get_contents('php://input'), true);
        if (!is_array($body)) {
            respond(400, ['error' => 'A valid JSON request body is required.']);
        } // end of request body validation

        /* ---- Action: add a comment ---- */
        if (($body['action'] ?? '') === 'comment') {
            $checkinId = filter_var($body['checkinId'] ?? null, FILTER_VALIDATE_INT);
            $rawComment = $body['comment'] ?? null;

            // The comment must be a string
            if (!is_string($rawComment)) {
                respond(400, ['error' => 'Enter a comment of up to 2,000 characters.']);
            } // end of comment type check

            // Validate the ID and enforce a non-empty comment of at most 2,000 characters
            $commentText = trim($rawComment);
            if ($checkinId === false || $checkinId === null || $checkinId < 1 || $commentText === '' || strlen($commentText) > 2000) {
                respond(400, ['error' => 'Enter a comment of up to 2,000 characters.']);
            } // end of comment validation

            // Make sure the check-in exists before commenting on it
            $checkin = $pdo->prepare('SELECT id FROM checkins WHERE id = :id');
            $checkin->execute([':id' => $checkinId]);
            if ($checkin->fetchColumn() === false) {
                respond(404, ['error' => 'Check-in not found.']);
            } // end of check-in existence check

            // Save the new comment
            $insert = $pdo->prepare(
                'INSERT INTO checkin_comments (checkin_id, user_id, comment_text)
                 VALUES (:checkin_id, :user_id, :comment_text)'
            );
            $insert->execute([
                ':checkin_id' => $checkinId,
                ':user_id' => $viewerId,
                ':comment_text' => $commentText,
            ]);
            $commentId = (int) $pdo->lastInsertId();

            // Read back the database-generated timestamp
            $createdAt = $pdo->prepare('SELECT created_at FROM checkin_comments WHERE id = :id');
            $createdAt->execute([':id' => $commentId]);

            // Look up the author name to return with the new comment
            $author = $pdo->prepare(
                'SELECT COALESCE(NULLIF(display_name, \'\'), username) FROM users WHERE id = :user_id'
            );
            $author->execute([':user_id' => $viewerId]);

            // 201 Created with the full comment payload
            respond(201, ['comment' => [
                'id' => $commentId,
                'checkinId' => $checkinId,
                'text' => $commentText,
                'createdAt' => $createdAt->fetchColumn(),
                'author' => $author->fetchColumn(),
            ]]);
        } // end of comment action

        /* ---- Action: follow or unfollow the site linked to a post ---- */
        if (($body['action'] ?? '') === 'site_follow') {
            $checkinId = filter_var($body['checkinId'] ?? null, FILTER_VALIDATE_INT);
            $following = $body['following'] ?? null;

            // Require a valid ID and a strict boolean follow value
            if ($checkinId === false || $checkinId === null || $checkinId < 1 || !is_bool($following)) {
                respond(400, ['error' => 'A valid post ID and following value are required.']);
            } // end of follow input validation

            // Resolve the site from the post itself, so the browser cannot
            // accidentally follow another site by sending a stale site ID.
            // Users cannot follow sites through their own posts.
            $target = $pdo->prepare(
                'SELECT s.id, s.title, s.latitude, s.longitude
                   FROM checkins AS c
                   INNER JOIN sites AS s ON s.id = c.site_id
                  WHERE c.id = :checkin_id AND c.user_id <> :viewer_id'
            );
            $target->execute([':checkin_id' => $checkinId, ':viewer_id' => $viewerId]);
            $site = $target->fetch();
            if (!$site) {
                respond(404, ['error' => 'This post is not linked to a site.']);
            } // end of site lookup check
            $siteId = (int) $site['id'];

            // Choose between following (idempotent insert) and unfollowing (delete)
            if ($following) {
                $update = $pdo->prepare(
                    'INSERT IGNORE INTO user_followed_sites (user_id, site_id)
                     VALUES (:user_id, :site_id)'
                );
            } else {
                $update = $pdo->prepare(
                    'DELETE FROM user_followed_sites
                      WHERE user_id = :user_id AND site_id = :site_id'
                );
            } // end of follow/unfollow statement selection
            $update->execute([':user_id' => $viewerId, ':site_id' => $siteId]);

            // Re-read the stored state so the response reflects the database
            $state = $pdo->prepare(
                'SELECT EXISTS (
                    SELECT 1 FROM user_followed_sites
                     WHERE user_id = :user_id AND site_id = :site_id
                )'
            );
            $state->execute([':user_id' => $viewerId, ':site_id' => $siteId]);
            respond(200, [
                'siteId' => $siteId,
                'siteName' => $site['title'],
                'siteLocation' => [
                    'lat' => (float) $site['latitude'],
                    'lng' => (float) $site['longitude'],
                ],
                'following' => (bool) $state->fetchColumn(),
            ]);
        } // end of site_follow action

        /* ---- Default POST action: like or unlike a check-in ---- */
        $checkinId = filter_var($body['checkinId'] ?? null, FILTER_VALIDATE_INT);
        $liked = $body['liked'] ?? null;

        // Require a valid ID and a strict boolean liked value
        if ($checkinId === false || $checkinId === null || $checkinId < 1 || !is_bool($liked)) {
            respond(400, ['error' => 'A valid check-in ID and liked value are required.']);
        } // end of like input validation

        // Use a transaction and lock the check-in row so the like count stays consistent
        $pdo->beginTransaction();
        $checkin = $pdo->prepare('SELECT id FROM checkins WHERE id = :id FOR UPDATE');
        $checkin->execute([':id' => $checkinId]);
        if ($checkin->fetchColumn() === false) {
            $pdo->rollBack();
            respond(404, ['error' => 'Check-in not found.']);
        } // end of check-in existence check

        // Choose between liking (idempotent upsert) and unliking (delete)
        if ($liked) {
            $update = $pdo->prepare(
                'INSERT INTO checkin_likes (checkin_id, user_id)
                 VALUES (:checkin_id, :user_id)
                 ON DUPLICATE KEY UPDATE checkin_id = VALUES(checkin_id)'
            );
        } else {
            $update = $pdo->prepare(
                'DELETE FROM checkin_likes
                  WHERE checkin_id = :checkin_id AND user_id = :user_id'
            );
        } // end of like/unlike statement selection
        $update->execute([':checkin_id' => $checkinId, ':user_id' => $viewerId]);

        // Count the likes after the change and release the lock
        $count = $pdo->prepare('SELECT COUNT(*) FROM checkin_likes WHERE checkin_id = :checkin_id');
        $count->execute([':checkin_id' => $checkinId]);
        $likeCount = (int) $count->fetchColumn();
        $pdo->commit();

        respond(200, [
            'checkinId' => $checkinId,
            'liked' => $liked,
            'likes' => $likeCount,
        ]);
    } // end of POST handling

    /* ----------------------------------------------------------------------
       GET: paginated feed (default request)
       ---------------------------------------------------------------------- */

    // Filter posts by the tag assigned to each image in checkin_image_tags.
    // Continue accepting the old filter URLs while existing browser tabs are open.
    $tagKey = trim((string) ($_GET['tag'] ?? ''));
    if ($tagKey === '') {
        // Map legacy "scope" values to their current tag keys
        $legacyScope = (string) ($_GET['scope'] ?? '');
        $tagKey = [
            'gem' => 'hidden-gems',
            'following' => 'following',
        ][$legacyScope] ?? '';
    } // end of legacy scope fallback

    // Build the optional tag filter as a correlated EXISTS subquery
    $tagFilterSql = $tagKey === ''
        ? ''
        : " AND EXISTS (
                SELECT 1
                  FROM checkin_image_tags AS cit
                  INNER JOIN image_tags AS it ON it.id = cit.tag_id
                 WHERE cit.checkin_id = c.id
                   AND it.tag_key = :feed_tag_key
           )";

    // Read the search text and optional selected site ID
    $searchValue = $_GET['q'] ?? '';
    $searchTerm = is_string($searchValue) ? trim($searchValue) : '';
    $siteId = filter_var($_GET['siteId'] ?? null, FILTER_VALIDATE_INT);

    // A selected site ID takes priority over free-text title search
    $searchFilterSql = '';
    if ($siteId !== false && $siteId !== null && $siteId > 0) {
        $searchFilterSql = ' AND s.id = :feed_site_id';
    } elseif ($searchTerm !== '') {
        $searchFilterSql = ' AND s.title LIKE :feed_site_query';
    } // end of search filter selection

    // Sort by like count or by newest first (default)
    $sort = (string) ($_GET['sort'] ?? 'latest');
    $orderBy = $sort === 'liked'
        ? 'likes_count DESC, c.created_at DESC, c.id DESC'
        : 'c.created_at DESC, c.id DESC';

    // Pagination: limit is clamped to 1-50 (default 8), page to 1-1,000,000
    $limitValue = filter_var($_GET['limit'] ?? 8, FILTER_VALIDATE_INT);
    $pageValue = filter_var($_GET['page'] ?? 1, FILTER_VALIDATE_INT);
    $feedLimit = $limitValue === false ? 8 : max(1, min(50, (int) $limitValue));
    $feedPage = $pageValue === false ? 1 : max(1, min(1000000, (int) $pageValue));
    $feedOffset = ($feedPage - 1) * $feedLimit;

    // Main feed query. It fetches one extra row (limit + 1) to detect whether
    // another page exists. Dynamic fragments are built only from fixed strings
    // or validated integers; user text is always bound as parameters.
    $statement = $pdo->prepare(
        "SELECT
            c.id,
            c.image_url,
            c.caption,
            c.latitude_captured,
            c.longitude_captured,
            c.created_at,
            c.xp_earned,
            c.is_verified,
            c.site_id,
            (SELECT COUNT(*)
               FROM checkin_likes AS cl
              WHERE cl.checkin_id = c.id) AS likes_count,
            (SELECT COUNT(*)
               FROM checkin_comments AS cc
              WHERE cc.checkin_id = c.id) AS comments_count,
            EXISTS (
                SELECT 1
                  FROM checkin_likes AS viewer_like
                 WHERE viewer_like.checkin_id = c.id
                   AND viewer_like.user_id = :viewer_id
            ) AS liked,
            u.id AS author_id,
            u.avatar_url AS author_avatar,
            COALESCE(NULLIF(u.display_name, ''), u.username) AS author_name,
            EXISTS (
                SELECT 1
                  FROM user_followed_sites AS ufs
                 WHERE ufs.user_id = :viewer_follow_sites_id
                   AND ufs.site_id = c.site_id
            ) AS site_following,
            s.title AS site_name,
            s.latitude AS site_latitude,
            s.longitude AS site_longitude,
            s.image_url AS site_image_url
         FROM checkins AS c
         INNER JOIN users AS u ON u.id = c.user_id
         LEFT JOIN sites AS s ON s.id = c.site_id
         WHERE 1 = 1
           $tagFilterSql
           $searchFilterSql
         ORDER BY $orderBy
         LIMIT " . ($feedLimit + 1) . " OFFSET " . $feedOffset
    );

    // Base parameters (each placeholder name must be unique with real prepared statements)
    $parameters = [
        ':viewer_id' => $viewerId,
        ':viewer_follow_sites_id' => $viewerId,
    ];

    // Add parameters only for the filters that were actually applied
    if ($tagKey !== '') {
        $parameters[':feed_tag_key'] = $tagKey;
    } // end of tag parameter
    if ($siteId !== false && $siteId !== null && $siteId > 0) {
        $parameters[':feed_site_id'] = $siteId;
    } elseif ($searchTerm !== '') {
        $parameters[':feed_site_query'] = '%' . addcslashes($searchTerm, '\\%_') . '%';
    } // end of site search parameter
    $statement->execute($parameters);

    // If the extra row came back, more pages exist; trim the result to the page size
    $rows = $statement->fetchAll();
    $hasMore = count($rows) > $feedLimit;
    if ($hasMore) {
        $rows = array_slice($rows, 0, $feedLimit);
    } // end of extra row trimming

    // Convert database rows into the JSON structure used by the front end
    $items = [];
    $projectRoot = dirname(__DIR__);
    foreach ($rows as $row) {
        // Work out whether the uploaded image file is actually available
        $imageUrl = trim((string) $row['image_url']);
        $localImagePath = $projectRoot . DIRECTORY_SEPARATOR
            . str_replace(['/', '\\'], DIRECTORY_SEPARATOR, ltrim($imageUrl, '/\\'));
        $isRemoteImage = (bool) preg_match('~^https?://~i', $imageUrl);
        $isFallbackImage = $imageUrl === '' || (!$isRemoteImage && !is_file($localImagePath));

        // Fall back to the site's image, then to a default camera icon
        if ($isFallbackImage) {
            $siteImageUrl = trim((string) ($row['site_image_url'] ?? ''));
            $siteImagePath = $projectRoot . DIRECTORY_SEPARATOR
                . str_replace(['/', '\\'], DIRECTORY_SEPARATOR, ltrim($siteImageUrl, '/\\'));
            $imageUrl = $siteImageUrl !== '' && is_file($siteImagePath)
                ? $siteImageUrl
                : 'assets/camera.png';

            // Keep every post visible even if multiple unavailable uploads use
            // the same site image as their fallback.
        } // end of fallback image handling

        // Cast values to proper types and shape the response item
        $items[] = [
            'id' => (int) $row['id'],
            'imageUrl' => $imageUrl,
            'caption' => $row['caption'],
            'lat' => $row['latitude_captured'] === null ? null : (float) $row['latitude_captured'],
            'lng' => $row['longitude_captured'] === null ? null : (float) $row['longitude_captured'],
            'createdAt' => $row['created_at'],
            'xpEarned' => (int) $row['xp_earned'],
            'isVerified' => (bool) $row['is_verified'],
            'siteId' => $row['site_id'] === null ? null : (int) $row['site_id'],
            'siteName' => $row['site_name'],
            'siteLocation' => $row['site_latitude'] === null || $row['site_longitude'] === null
                ? null
                : ['lat' => (float) $row['site_latitude'], 'lng' => (float) $row['site_longitude']],
            'author' => [
                'id' => (int) $row['author_id'],
                'name' => $row['author_name'],
                'avatarUrl' => $row['author_avatar'],
            ],
            'isOwnPost' => (int) $row['author_id'] === $viewerId,
            'siteFollowing' => (bool) $row['site_following'],
            'likes' => (int) $row['likes_count'],
            'comments' => (int) $row['comments_count'],
            'liked' => (bool) $row['liked'],
        ];
    } // end of loop over feed rows

    respond(200, ['items' => $items, 'hasMore' => $hasMore]);
} catch (InvalidArgumentException $error) {
    // Thrown by the user helper when the requested username is invalid
    respond(400, ['error' => 'Invalid user.']);
} catch (PDOException $error) {
    // Undo any open transaction so no partial like changes are kept
    if (isset($pdo) && $pdo instanceof PDO && $pdo->inTransaction()) {
        $pdo->rollBack();
    } // end of transaction rollback

    // Log the real error for developers, but show a generic message to the client
    error_log('Feed database request failed: ' . $error->getMessage());
    respond(500, ['error' => 'The feed could not be loaded.']);
} // end of try-catch for feed request
