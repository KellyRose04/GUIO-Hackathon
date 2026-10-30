<?php
declare(strict_types=1);

if (PHP_SAPI !== 'cli') {
    http_response_code(404);
    exit;
}

$siteId = filter_var($argv[1] ?? null, FILTER_VALIDATE_INT, ['options' => ['min_range' => 1]]);
if ($siteId === false) {
    fwrite(STDERR, "Usage: php database/generate_destination_qr.php <site_id>\n");
    exit(2);
}

$dbHost = getenv('GUIO_DB_HOST') ?: 'localhost';
$dbName = getenv('GUIO_DB_NAME') ?: 'guio_db';
$dbUser = getenv('GUIO_DB_USER') ?: 'root';
$dbPassword = getenv('GUIO_DB_PASSWORD') ?: '';

try {
    $pdo = new PDO(
        "mysql:host=$dbHost;dbname=$dbName;charset=utf8mb4",
        $dbUser,
        $dbPassword,
        [
            PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION,
            PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
            PDO::ATTR_EMULATE_PREPARES => false,
        ]
    );

    $site = $pdo->prepare('SELECT title FROM sites WHERE id = :site_id');
    $site->execute([':site_id' => $siteId]);
    $siteTitle = $site->fetchColumn();
    if ($siteTitle === false) {
        fwrite(STDERR, "No destination found with site_id $siteId.\n");
        exit(1);
    }

    $token = bin2hex(random_bytes(32));
    $insert = $pdo->prepare(
        'INSERT INTO destination_qr_codes (site_id, token_hash)
         VALUES (:site_id, :token_hash)'
    );
    $insert->execute([
        ':site_id' => $siteId,
        ':token_hash' => hash('sha256', $token),
    ]);

    fwrite(STDOUT, "Destination: $siteTitle\nQR payload (save this; it cannot be retrieved later):\n$token\n");
} catch (PDOException $error) {
    fwrite(STDERR, "Could not create destination QR code: {$error->getMessage()}\n");
    exit(1);
} catch (Exception $error) {
    fwrite(STDERR, "Could not create destination QR code: {$error->getMessage()}\n");
    exit(1);
}
