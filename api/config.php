<?php
declare(strict_types=1);

/**
 * Return the active account selected by the page and passed to the API.
 * This project has no server-side login session yet, so require a username
 * instead of silently falling back to a hard-coded account.
 */
function tourtrail_requested_username(): string
{
    $username = trim((string) ($_GET['user'] ?? $_POST['user'] ?? ''));

    if ($username === '' || strlen($username) > 100 || preg_match('/[[:cntrl:]]/', $username)) {
        throw new InvalidArgumentException('Invalid username');
    }

    return $username;
}

/** Read the browser-generated anonymous device ID sent with same-origin API requests. */
function tourtrail_requested_device_id(): ?string
{
    $deviceId = trim((string) ($_SERVER['HTTP_X_GUIO_DEVICE_ID'] ?? ''));
    if ($deviceId === '') {
        return null;
    }

    if (!preg_match('/^[a-f0-9]{32}$/i', $deviceId)) {
        throw new InvalidArgumentException('Invalid anonymous device ID');
    }

    return strtolower($deviceId);
}

/** Create the shared MySQL connection from server-side environment variables. */
function tourtrail_database(): PDO
{
    $host = getenv('GUIO_DB_HOST');
    $name = getenv('GUIO_DB_NAME');
    $user = getenv('GUIO_DB_USER');
    $password = getenv('GUIO_DB_PASSWORD');
    $port = getenv('GUIO_DB_PORT');

    if ($host === false || trim($host) === '' ||
        $name === false || trim($name) === '' ||
        $user === false || trim($user) === '' ||
        $password === false) {
        throw new PDOException('Database connection is not configured.');
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

/** Create or retrieve the MySQL user record associated with one anonymous device. */
function tourtrail_find_or_create_device_user_id(PDO $pdo, string $deviceId): int
{
    if (!preg_match('/^[a-f0-9]{32}$/', $deviceId)) {
        throw new InvalidArgumentException('Invalid anonymous device ID');
    }

    $username = 'anon_' . $deviceId;
    $statement = $pdo->prepare(
        'INSERT INTO users (username)
         VALUES (:username)
         ON DUPLICATE KEY UPDATE id = LAST_INSERT_ID(id)'
    );
    $statement->execute([':username' => $username]);
    $userId = (int) $pdo->lastInsertId();
    if ($userId < 1) {
        throw new PDOException('Could not resolve the anonymous device record.');
    }

    return $userId;
}

/** Look up an account's database ID without exposing other user fields. */
function tourtrail_find_user_id(PDO $pdo, string $username): ?int
{
    $statement = $pdo->prepare('SELECT id FROM users WHERE username = :username');
    $statement->execute([':username' => $username]);
    $userId = $statement->fetchColumn();

    return $userId === false ? null : (int) $userId;
}
