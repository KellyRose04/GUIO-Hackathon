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

/** Look up an account's database ID without exposing other user fields. */
function tourtrail_find_user_id(PDO $pdo, string $username): ?int
{
    $statement = $pdo->prepare('SELECT id FROM users WHERE username = :username');
    $statement->execute([':username' => $username]);
    $userId = $statement->fetchColumn();

    return $userId === false ? null : (int) $userId;
}
