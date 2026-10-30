<?php
declare(strict_types=1);

/**
 * Return the active account selected by the page and passed to the API.
 * This project has no server-side login session yet, so require a username
 * instead of silently falling back to a hard-coded account.
 */
function guio_requested_username(): string
{
    $username = trim((string) ($_GET['user'] ?? $_POST['user'] ?? ''));

    if ($username === '' || strlen($username) > 100 || preg_match('/[[:cntrl:]]/', $username)) {
        throw new InvalidArgumentException('Invalid username');
    }

    return $username;
}

/** Read the browser-generated anonymous ID sent with same-origin API requests. */
function guio_requested_anonymous_id(): ?string
{
    $anonymousId = trim((string) (
        $_SERVER['HTTP_X_GUIO_ANONYMOUS_ID']
        ?? $_SERVER['HTTP_X_GUIO_DEVICE_ID']
        ?? ''
    ));
    if ($anonymousId === '') {
        return null;
    }

    if (preg_match('/^[a-f0-9]{32}$/i', $anonymousId)) {
        $anonymousId = substr($anonymousId, 0, 8) . '-' .
            substr($anonymousId, 8, 4) . '-' .
            substr($anonymousId, 12, 4) . '-' .
            substr($anonymousId, 16, 4) . '-' .
            substr($anonymousId, 20, 12);
    } elseif (!preg_match('/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i', $anonymousId)) {
        throw new InvalidArgumentException('Invalid anonymous ID');
    }

    return strtolower($anonymousId);
}

/** Create the shared MySQL connection from server-side environment variables. */
function guio_database(): PDO
{
    $host = getenv('GUIO_DB_HOST') ?: '127.0.0.1';
    $name = getenv('GUIO_DB_NAME') ?: 'guio_db';
    $user = getenv('GUIO_DB_USER') ?: 'root';
    $password = getenv('GUIO_DB_PASSWORD');
    $port = getenv('GUIO_DB_PORT');
    if ($password === false) {
        $password = '';
    }

    $portNumber = $port === false || $port === '' ? 3306 : filter_var($port, FILTER_VALIDATE_INT);
    if ($portNumber === false || $portNumber < 1 || $portNumber > 65535) {
        throw new PDOException('Database port configuration is invalid.');
    }

    return new PDO(
        sprintf(
            'mysql:host=%s;port=%d;dbname=%s;charset=utf8mb4',
            $host,
            $portNumber,
            $name
        ),
        $user,
        $password,
        [
            PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION,
            PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
            PDO::ATTR_EMULATE_PREPARES => false,
        ]
    );
}

/** Create or retrieve the MySQL user record associated with one anonymous ID. */
function guio_find_or_create_anonymous_user_id(PDO $pdo, string $anonymousId): int
{
    if (!preg_match('/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i', $anonymousId)) {
        throw new InvalidArgumentException('Invalid anonymous ID');
    }

    $anonymousId = strtolower($anonymousId);
    $legacyHex = str_replace('-', '', $anonymousId);
    $username = 'anon_' . $legacyHex;
    $existing = $pdo->prepare('SELECT id FROM users WHERE anonymous_id = :anonymous_id');
    $existing->execute([':anonymous_id' => $anonymousId]);
    $userId = $existing->fetchColumn();
    if ($userId !== false) {
        $resolvedUserId = (int) $userId;
    } else {
        $legacyUser = $pdo->prepare('SELECT id FROM users WHERE username = :username');
        $legacyUser->execute([':username' => $username]);
        $userId = $legacyUser->fetchColumn();
        if ($userId !== false) {
            $upgrade = $pdo->prepare(
                'UPDATE users SET anonymous_id = :anonymous_id
                  WHERE id = :user_id AND anonymous_id IS NULL'
            );
            $upgrade->execute([':anonymous_id' => $anonymousId, ':user_id' => (int) $userId]);
            $resolvedUserId = (int) $userId;
        } else {
            $statement = $pdo->prepare(
                'INSERT INTO users (username, anonymous_id)
                 VALUES (:username, :anonymous_id)
                 ON DUPLICATE KEY UPDATE id = LAST_INSERT_ID(id)'
            );
            $statement->execute([':username' => $username, ':anonymous_id' => $anonymousId]);
            $resolvedUserId = (int) $pdo->lastInsertId();
            if ($resolvedUserId < 1) {
                throw new PDOException('Could not resolve the anonymous user record.');
            }
        }
    }

    guio_award_welcome_badge($pdo, $resolvedUserId);

    return $resolvedUserId;
}

/** Grant the default badge once to each user who opens GUIO. */
function guio_award_welcome_badge(PDO $pdo, int $userId): void
{
    $badgeExists = $pdo->prepare("SELECT 1 FROM badges WHERE badge_key = 'welcome-explorer'");
    $badgeExists->execute();
    if ($badgeExists->fetchColumn() === false) {
        throw new PDOException('The welcome badge is not configured in the database.');
    }

    $award = $pdo->prepare(
        "INSERT IGNORE INTO user_badges (user_id, badge_key, is_new)
         VALUES (:user_id, 'welcome-explorer', 1)"
    );
    $award->execute([':user_id' => $userId]);
}

/** Look up an account's database ID without exposing other user fields. */
function guio_find_user_id(PDO $pdo, string $username): ?int
{
    $statement = $pdo->prepare('SELECT id FROM users WHERE username = :username');
    $statement->execute([':username' => $username]);
    $userId = $statement->fetchColumn();

    return $userId === false ? null : (int) $userId;
}
