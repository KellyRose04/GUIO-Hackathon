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

/** Look up an account's database ID without exposing other user fields. */
function tourtrail_find_user_id(PDO $pdo, string $username): ?int
{
    $statement = $pdo->prepare('SELECT id FROM users WHERE username = :username');
    $statement->execute([':username' => $username]);
    $userId = $statement->fetchColumn();

    return $userId === false ? null : (int) $userId;
}
