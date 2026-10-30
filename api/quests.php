<?php
declare(strict_types=1);

require_once __DIR__ . '/config.php';

header('Content-Type: application/json; charset=utf-8');
header('Cache-Control: no-store');

function respond(int $status, array $payload): void
{
    http_response_code($status);
    echo json_encode($payload, JSON_UNESCAPED_UNICODE | JSON_INVALID_UTF8_SUBSTITUTE);
    exit;
}

function questStops(PDO $pdo, int $questId, ?int $userId, ?int $userQuestId = null): array
{
    if ($userQuestId !== null) {
        $statement = $pdo->prepare(
            'SELECT qs.site_id, qs.stop_order, s.title,
                    CASE
                        WHEN uqs.id IS NOT NULL THEN \'done\'
                        WHEN NOT EXISTS (
                            SELECT 1
                              FROM quest_stops AS earlier
                              LEFT JOIN user_quest_stops AS earlier_done
                                ON earlier_done.user_quest_id = :earlier_user_quest_id
                               AND earlier_done.quest_stop_id = earlier.id
                             WHERE earlier.quest_id = qs.quest_id
                               AND earlier.stop_order < qs.stop_order
                               AND earlier_done.id IS NULL
                        ) THEN \'current\'
                        ELSE \'to_visit\'
                    END AS destination_status
               FROM quest_stops AS qs
               JOIN sites AS s ON s.id = qs.site_id
               LEFT JOIN user_quest_stops AS uqs
                 ON uqs.user_quest_id = :user_quest_id
                AND uqs.quest_stop_id = qs.id
              WHERE qs.quest_id = :quest_id
              ORDER BY qs.stop_order'
        );
        $statement->execute([
            ':earlier_user_quest_id' => $userQuestId,
            ':user_quest_id' => $userQuestId,
            ':quest_id' => $questId,
        ]);
    } elseif ($userId !== null) {
        $statement = $pdo->prepare(
            'SELECT site_id, stop_order, destination AS title, destination_status
               FROM v_user_quest_destinations
              WHERE user_id = :user_id AND quest_id = :quest_id
              ORDER BY stop_order'
        );
        $statement->execute([':user_id' => $userId, ':quest_id' => $questId]);
    } else {
        $statement = $pdo->prepare(
            'SELECT qs.site_id, qs.stop_order, s.title, \'to_visit\' AS destination_status
               FROM quest_stops AS qs
               JOIN sites AS s ON s.id = qs.site_id
              WHERE qs.quest_id = :quest_id
              ORDER BY qs.stop_order'
        );
        $statement->execute([':quest_id' => $questId]);
    }

    return array_map(static function (array $stop): array {
        $destinationStatus = (string) $stop['destination_status'];
        if ($destinationStatus === 'done') {
            $stopState = 'done';
        } elseif ($destinationStatus === 'current') {
            $stopState = 'next';
        } else {
            $stopState = 'locked';
        }

        return [
            'site_id' => (int) $stop['site_id'],
            'stop_order' => (int) $stop['stop_order'],
            'title' => (string) $stop['title'],
            'destination_status' => $destinationStatus,
            'stop_state' => $stopState,
        ];
    }, $statement->fetchAll());
}

function activeQuestPayload(PDO $pdo, int $userQuestId, int $userId): ?array
{
    $statement = $pdo->prepare(
        'SELECT uq.id AS user_quest_id, uq.progress_count, uq.status,
                q.id AS quest_id, q.quest_key, q.title, q.description, q.icon,
                q.quest_type, q.target_count
           FROM user_quests AS uq
           JOIN quests AS q ON q.id = uq.quest_id
          WHERE uq.id = :user_quest_id AND uq.user_id = :user_id'
    );
    $statement->execute([':user_quest_id' => $userQuestId, ':user_id' => $userId]);
    $quest = $statement->fetch();
    if (!$quest) {
        return null;
    }

    $quest['stops'] = questStops($pdo, (int) $quest['quest_id'], $userId, $userQuestId);
    return $quest;
}

try {
    $pdo = tourtrail_database();

    $method = $_SERVER['REQUEST_METHOD'] ?? 'GET';
    if (!in_array($method, ['GET', 'POST'], true)) {
        header('Allow: GET, POST');
        respond(405, ['status' => 'error', 'error' => 'Use GET to list quests or POST to start a quest.']);
    }

    $userId = null;
    $hasUsername = isset($_GET['user']) || isset($_POST['user']);
    if ($hasUsername) {
        $username = tourtrail_requested_username();
        $userId = tourtrail_find_user_id($pdo, $username);
        if ($userId === null && $method === 'POST') {
            respond(404, ['status' => 'error', 'error' => 'User not found.']);
        }
    }

    if ($method === 'POST') {
        if ($userId === null) {
            respond(400, ['status' => 'error', 'error' => 'A selected account is required to start a quest.']);
        }
        $body = json_decode(file_get_contents('php://input'), true);
        $action = is_array($body) && is_string($body['action'] ?? null)
            ? $body['action']
            : 'start';

        if ($action === 'verify_destination') {
            $token = is_string($body['qr_token'] ?? null) ? trim($body['qr_token']) : '';
            if (strlen($token) < 16 || strlen($token) > 512) {
                respond(400, ['status' => 'error', 'error' => 'A valid destination QR code is required.']);
            }
            $tokenHash = hash('sha256', $token);

            $pdo->beginTransaction();
            $active = $pdo->prepare(
                'SELECT uq.id AS user_quest_id, uq.quest_id
                   FROM user_quests AS uq
                  WHERE uq.user_id = :user_id AND uq.status = \'active\'
                  LIMIT 1 FOR UPDATE'
            );
            $active->execute([':user_id' => $userId]);
            $activeQuest = $active->fetch();
            if (!$activeQuest) {
                $pdo->rollBack();
                respond(409, ['status' => 'error', 'error' => 'Start a quest before scanning a destination QR code.']);
            }

            $currentStop = $pdo->prepare(
                'SELECT qs.id AS quest_stop_id, qs.site_id
                   FROM quest_stops AS qs
                   LEFT JOIN user_quest_stops AS uqs
                     ON uqs.user_quest_id = :completed_user_quest_id
                    AND uqs.quest_stop_id = qs.id
                  WHERE qs.quest_id = :quest_id
                    AND uqs.id IS NULL
                  ORDER BY qs.stop_order
                  LIMIT 1
                  FOR UPDATE'
            );
            $currentStop->execute([
                ':completed_user_quest_id' => (int) $activeQuest['user_quest_id'],
                ':quest_id' => (int) $activeQuest['quest_id'],
            ]);
            $stop = $currentStop->fetch();
            if (!$stop) {
                $pdo->rollBack();
                respond(409, ['status' => 'error', 'error' => 'There are no remaining destinations in this quest.']);
            }

            $validCode = $pdo->prepare(
                'SELECT id
                   FROM destination_qr_codes
                  WHERE site_id = :site_id
                    AND token_hash = :token_hash
                    AND is_active = 1
                    AND (expires_at IS NULL OR expires_at > NOW())
                  LIMIT 1'
            );
            $validCode->execute([
                ':site_id' => (int) $stop['site_id'],
                ':token_hash' => $tokenHash,
            ]);
            if ($validCode->fetchColumn() === false) {
                $pdo->rollBack();
                respond(422, ['status' => 'error', 'error' => 'This QR code is invalid or is not for your current destination.']);
            }

            $completeStop = $pdo->prepare(
                'INSERT INTO user_quest_stops (user_quest_id, quest_stop_id)
                 VALUES (:user_quest_id, :quest_stop_id)'
            );
            $completeStop->execute([
                ':user_quest_id' => (int) $activeQuest['user_quest_id'],
                ':quest_stop_id' => (int) $stop['quest_stop_id'],
            ]);

            $progress = $pdo->prepare(
                'SELECT COUNT(*) AS completed_count,
                        (SELECT COUNT(*) FROM quest_stops WHERE quest_id = :total_quest_id) AS total_count
                   FROM user_quest_stops
                  WHERE user_quest_id = :user_quest_id'
            );
            $progress->execute([
                ':total_quest_id' => (int) $activeQuest['quest_id'],
                ':user_quest_id' => (int) $activeQuest['user_quest_id'],
            ]);
            $counts = $progress->fetch();
            $completedCount = (int) $counts['completed_count'];
            $isComplete = $completedCount >= (int) $counts['total_count'];
            $updateQuest = $pdo->prepare(
                'UPDATE user_quests
                    SET progress_count = :progress_count,
                        status = :status,
                        completed_at = CASE WHEN :is_complete = 1 THEN NOW() ELSE NULL END
                  WHERE id = :user_quest_id AND status = \'active\''
            );
            $updateQuest->execute([
                ':progress_count' => $completedCount,
                ':status' => $isComplete ? 'completed' : 'active',
                ':is_complete' => $isComplete ? 1 : 0,
                ':user_quest_id' => (int) $activeQuest['user_quest_id'],
            ]);
            $pdo->commit();

            respond(200, [
                'status' => 'success',
                'quest_status' => $isComplete ? 'done' : 'current',
                'completed_destination_id' => (int) $stop['site_id'],
                'progress_count' => $completedCount,
                'active_quest' => $isComplete
                    ? null
                    : activeQuestPayload($pdo, (int) $activeQuest['user_quest_id'], $userId),
            ]);
        }

        if ($action !== 'start') {
            respond(400, ['status' => 'error', 'error' => 'Unsupported quest action.']);
        }

        $questKey = is_array($body) && is_string($body['quest_key'] ?? null)
            ? trim($body['quest_key'])
            : '';
        if (!preg_match('/^[a-z0-9][a-z0-9-]{0,99}$/', $questKey)) {
            respond(400, ['status' => 'error', 'error' => 'A valid quest key is required.']);
        }

        $pdo->beginTransaction();
        $userLock = $pdo->prepare('SELECT id FROM users WHERE id = :user_id FOR UPDATE');
        $userLock->execute([':user_id' => $userId]);

        $questLookup = $pdo->prepare(
            'SELECT q.id, q.target_count, COUNT(qs.id) AS stop_count
               FROM quests AS q
               LEFT JOIN quest_stops AS qs ON qs.quest_id = q.id
              WHERE q.quest_key = :quest_key AND q.quest_type = \'sites\'
              GROUP BY q.id, q.target_count'
        );
        $questLookup->execute([':quest_key' => $questKey]);
        $quest = $questLookup->fetch();
        if (!$quest || (int) $quest['stop_count'] === 0) {
            $pdo->rollBack();
            respond(404, ['status' => 'error', 'error' => 'This quest is not available.']);
        }

        $existing = $pdo->prepare(
            'SELECT id, status
               FROM user_quests
              WHERE user_id = :user_id AND quest_id = :quest_id
              FOR UPDATE'
        );
        $existing->execute([':user_id' => $userId, ':quest_id' => (int) $quest['id']]);
        $userQuest = $existing->fetch();
        if ($userQuest && $userQuest['status'] === 'completed') {
            $pdo->rollBack();
            respond(409, ['status' => 'error', 'quest_status' => 'done', 'error' => 'This quest is already complete.']);
        }

        $active = $pdo->prepare(
            'SELECT id FROM user_quests
              WHERE user_id = :user_id AND status = \'active\'
              LIMIT 1 FOR UPDATE'
        );
        $active->execute([':user_id' => $userId]);
        $activeQuestId = $active->fetchColumn();
        if ($activeQuestId !== false) {
            if (!$userQuest || (int) $activeQuestId !== (int) $userQuest['id']) {
                $pdo->rollBack();
                respond(409, ['status' => 'error', 'quest_status' => 'current', 'error' => 'Complete your current quest before starting another.']);
            }
            $userQuestId = (int) $activeQuestId;
        } else {
            if ($userQuest) {
                $pdo->rollBack();
                respond(409, ['status' => 'error', 'quest_status' => 'done', 'error' => 'This quest cannot be restarted.']);
            }
            $insert = $pdo->prepare(
                'INSERT INTO user_quests (user_id, quest_id, status, progress_count)
                 VALUES (:user_id, :quest_id, \'active\', 0)'
            );
            $insert->execute([':user_id' => $userId, ':quest_id' => (int) $quest['id']]);
            $userQuestId = (int) $pdo->lastInsertId();
        }

        $pdo->commit();
        $activeQuest = activeQuestPayload($pdo, $userQuestId, $userId);
        respond(200, [
            'status' => 'success',
            'quest_status' => 'current',
            'active_quest' => $activeQuest,
        ]);
    }

    if ($userId === null) {
        $statement = $pdo->query(
            'SELECT q.id AS quest_id, q.quest_key, q.title, q.description, q.icon,
                    q.quest_type, q.target_count,
                    \'available\' AS quest_status, 0 AS progress_count
               FROM quests AS q
              ORDER BY q.id'
        );
    } else {
        $statement = $pdo->prepare(
            'SELECT q.id AS quest_id, q.quest_key, q.title, q.description, q.icon,
                    q.quest_type, q.target_count,
                    us.quest_status, us.progress_count, us.user_quest_id
               FROM quests AS q
               JOIN v_user_quest_status AS us
                 ON us.quest_id = q.id AND us.user_id = :user_id
              ORDER BY q.id'
        );
        $statement->execute([':user_id' => $userId]);
    }

    $quests = $statement->fetchAll();
    $currentQuest = null;
    foreach ($quests as &$quest) {
        $questId = (int) $quest['quest_id'];
        $quest['quest_id'] = $questId;
        $quest['target_count'] = (int) $quest['target_count'];
        $quest['progress_count'] = (int) $quest['progress_count'];
        $quest['category'] = $quest['quest_type'];
        $quest['stops'] = questStops($pdo, $questId, $userId);
        if ($userId !== null && $quest['quest_status'] === 'current') {
            $currentQuest = [
                'user_quest_id' => (int) $quest['user_quest_id'],
                'quest_id' => $questId,
                'quest_key' => $quest['quest_key'],
                'title' => $quest['title'],
                'description' => $quest['description'],
                'icon' => $quest['icon'],
                'quest_type' => $quest['quest_type'],
                'target_count' => $quest['target_count'],
                'progress_count' => $quest['progress_count'],
                'status' => 'active',
                'stops' => $quest['stops'],
            ];
        }
    }
    unset($quest);

    respond(200, [
        'status' => 'success',
        'quests' => $quests,
        'active_quest' => $currentQuest,
    ]);
} catch (InvalidArgumentException $error) {
    respond(400, ['status' => 'error', 'error' => 'The selected account is invalid.']);
} catch (PDOException $error) {
    if (isset($pdo) && $pdo instanceof PDO && $pdo->inTransaction()) {
        $pdo->rollBack();
    }
    error_log('Quest API database request failed: ' . $error->getMessage());
    respond(503, [
        'status' => 'error',
        'code' => 'database_unavailable',
        'error' => 'Quests are temporarily unavailable.',
    ]);
}
