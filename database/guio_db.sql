USE guio_db;

CREATE TABLE IF NOT EXISTS users (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    username VARCHAR(100) NOT NULL,
    PRIMARY KEY (id),
    UNIQUE KEY uq_users_username (username)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS sites (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    title VARCHAR(180) NOT NULL,
    category VARCHAR(50) NOT NULL,
    is_hidden_gem TINYINT(1) NOT NULL DEFAULT 0,
    xp_reward INT UNSIGNED NOT NULL DEFAULT 0,
    latitude DECIMAL(10,7) NOT NULL,
    longitude DECIMAL(10,7) NOT NULL,
    image_url VARCHAR(1000) NOT NULL DEFAULT '',
    description TEXT NOT NULL,
    operating_hours VARCHAR(255) NOT NULL DEFAULT '',
    entrance_fee VARCHAR(255) NOT NULL DEFAULT '',
    PRIMARY KEY (id),
    UNIQUE KEY uq_sites_title (title),
    KEY idx_sites_category (category),
    KEY idx_sites_location (latitude, longitude)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS quests (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    quest_key VARCHAR(100) NOT NULL,
    title VARCHAR(180) NOT NULL,
    description TEXT NOT NULL,
    icon VARCHAR(1000) NOT NULL DEFAULT '',
    quest_type ENUM('sites', 'streak') NOT NULL DEFAULT 'sites',
    target_count INT UNSIGNED NOT NULL,
    xp_reward INT UNSIGNED NOT NULL DEFAULT 0,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    UNIQUE KEY uq_quests_key (quest_key)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS quest_stops (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    quest_id BIGINT UNSIGNED NOT NULL,
    site_id BIGINT UNSIGNED NOT NULL,
    stop_order INT UNSIGNED NOT NULL,
    PRIMARY KEY (id),
    UNIQUE KEY uq_quest_stops_site (quest_id, site_id),
    UNIQUE KEY uq_quest_stops_order (quest_id, stop_order),
    CONSTRAINT fk_quest_stops_quest
        FOREIGN KEY (quest_id) REFERENCES quests (id)
        ON UPDATE CASCADE ON DELETE CASCADE,
    CONSTRAINT fk_quest_stops_site
        FOREIGN KEY (site_id) REFERENCES sites (id)
        ON UPDATE CASCADE ON DELETE RESTRICT
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS user_quests (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    user_id BIGINT UNSIGNED NOT NULL,
    quest_id BIGINT UNSIGNED NOT NULL,
    status ENUM('active', 'completed') NOT NULL DEFAULT 'active',
    progress_count INT UNSIGNED NOT NULL DEFAULT 0,
    started_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    completed_at DATETIME NULL,
    PRIMARY KEY (id),
    UNIQUE KEY uq_user_quests_user_quest (user_id, quest_id),
    KEY idx_user_quests_current (user_id, status, started_at),
    CONSTRAINT fk_user_quests_user
        FOREIGN KEY (user_id) REFERENCES users (id)
        ON UPDATE CASCADE ON DELETE CASCADE,
    CONSTRAINT fk_user_quests_quest
        FOREIGN KEY (quest_id) REFERENCES quests (id)
        ON UPDATE CASCADE ON DELETE CASCADE
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS user_quest_stops (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    user_quest_id BIGINT UNSIGNED NOT NULL,
    quest_stop_id BIGINT UNSIGNED NOT NULL,
    completed_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    UNIQUE KEY uq_user_quest_stop (user_quest_id, quest_stop_id),
    CONSTRAINT fk_user_quest_stops_user_quest
        FOREIGN KEY (user_quest_id) REFERENCES user_quests (id)
        ON UPDATE CASCADE ON DELETE CASCADE,
    CONSTRAINT fk_user_quest_stops_stop
        FOREIGN KEY (quest_stop_id) REFERENCES quest_stops (id)
        ON UPDATE CASCADE ON DELETE CASCADE
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS destination_qr_codes (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    site_id BIGINT UNSIGNED NOT NULL,
    token_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    is_active TINYINT(1) NOT NULL DEFAULT 1,
    expires_at DATETIME NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    UNIQUE KEY uq_destination_qr_token (token_hash),
    KEY idx_destination_qr_site_active (site_id, is_active),
    CONSTRAINT fk_destination_qr_site
        FOREIGN KEY (site_id) REFERENCES sites (id)
        ON UPDATE CASCADE ON DELETE CASCADE
) ENGINE=InnoDB;

-- Generate a random QR payload for each destination and store only its SHA-256
-- hash here. Use database/generate_destination_qr.php to provision one safely.

CREATE OR REPLACE VIEW v_user_quest_status AS
SELECT u.id AS user_id,
       q.id AS quest_id,
       q.quest_key,
       CASE
           WHEN uq.status = 'completed' THEN 'done'
           WHEN uq.status = 'active' THEN 'current'
           ELSE 'available'
       END AS quest_status,
       COALESCE(uq.progress_count, 0) AS progress_count,
       q.target_count,
       uq.id AS user_quest_id,
       uq.started_at,
       uq.completed_at
FROM users AS u
CROSS JOIN quests AS q
LEFT JOIN user_quests AS uq
       ON uq.user_id = u.id AND uq.quest_id = q.id;

CREATE OR REPLACE VIEW v_user_quest_destinations AS
SELECT u.id AS user_id,
       q.id AS quest_id,
       q.quest_key,
       qs.id AS quest_stop_id,
       qs.stop_order,
       s.id AS site_id,
       s.title AS destination,
       uq.id AS user_quest_id,
       CASE
           WHEN uq.status = 'completed' OR uqs.id IS NOT NULL THEN 'done'
           WHEN uq.status = 'active'
            AND NOT EXISTS (
                SELECT 1
                FROM quest_stops AS earlier
                LEFT JOIN user_quest_stops AS earlier_done
                       ON earlier_done.user_quest_id = uq.id
                      AND earlier_done.quest_stop_id = earlier.id
                WHERE earlier.quest_id = q.id
                  AND earlier.stop_order < qs.stop_order
                  AND earlier_done.id IS NULL
            ) THEN 'current'
           ELSE 'to_visit'
       END AS destination_status
FROM users AS u
CROSS JOIN quests AS q
JOIN quest_stops AS qs ON qs.quest_id = q.id
JOIN sites AS s ON s.id = qs.site_id
LEFT JOIN user_quests AS uq
       ON uq.user_id = u.id AND uq.quest_id = q.id
LEFT JOIN user_quest_stops AS uqs
       ON uqs.user_quest_id = uq.id AND uqs.quest_stop_id = qs.id;

CREATE OR REPLACE VIEW v_user_active_quest AS
SELECT uq.user_id,
       uq.id AS user_quest_id,
       uq.progress_count,
       uq.started_at,
       q.id AS quest_id,
       q.quest_key,
       q.title,
       q.description,
       q.icon,
       q.quest_type,
       q.target_count,
       q.xp_reward,
       (
           SELECT qs.site_id
           FROM quest_stops AS qs
           LEFT JOIN user_quest_stops AS uqs
                  ON uqs.user_quest_id = uq.id AND uqs.quest_stop_id = qs.id
           WHERE qs.quest_id = q.id AND uqs.id IS NULL
           ORDER BY qs.stop_order
           LIMIT 1
       ) AS next_site_id
FROM user_quests AS uq
JOIN quests AS q ON q.id = uq.quest_id
WHERE uq.status = 'active';

START TRANSACTION;

INSERT INTO sites
    (title, category, is_hidden_gem, xp_reward, latitude, longitude, image_url,
     description, operating_hours, entrance_fee)
SELECT 'Burnham Park', 'nature', 0, 50, 16.4108, 120.5960, 'assets/pin.png',
       'A central public park known for its lake, gardens, and outdoor recreation.',
       'Public park; hours may vary', 'Free entry; some activities charge'
FROM DUAL
WHERE NOT EXISTS (SELECT 1 FROM sites WHERE title = 'Burnham Park');

INSERT INTO sites
    (title, category, is_hidden_gem, xp_reward, latitude, longitude, image_url,
     description, operating_hours, entrance_fee)
SELECT 'Session Road', 'heritage', 0, 50, 16.4122, 120.5973, 'assets/pin.png',
       'Baguio’s central commercial avenue, lined with shops, cafes, and historic city buildings.',
       'Public road; business hours vary', 'Free'
FROM DUAL
WHERE NOT EXISTS (SELECT 1 FROM sites WHERE title = 'Session Road');

INSERT INTO sites
    (title, category, is_hidden_gem, xp_reward, latitude, longitude, image_url,
     description, operating_hours, entrance_fee)
SELECT 'Baguio Public Market', 'food', 0, 50, 16.4145, 120.5934, 'assets/pin.png',
       'A busy city market for local produce, food, flowers, and crafts.',
       'Market hours vary by stall', 'Free entry'
FROM DUAL
WHERE NOT EXISTS (SELECT 1 FROM sites WHERE title = 'Baguio Public Market');

INSERT INTO sites
    (title, category, is_hidden_gem, xp_reward, latitude, longitude, image_url,
     description, operating_hours, entrance_fee)
SELECT 'Baguio Cathedral', 'heritage', 0, 50, 16.4149, 120.5931, 'assets/pin.png',
       'The pink twin-spired cathedral overlooking the city center.',
       'Hours may vary; please observe service times', 'Free'
FROM DUAL
WHERE NOT EXISTS (SELECT 1 FROM sites WHERE title = 'Baguio Cathedral');

INSERT INTO sites
    (title, category, is_hidden_gem, xp_reward, latitude, longitude, image_url,
     description, operating_hours, entrance_fee)
SELECT 'Baguio Museum', 'heritage', 0, 50, 16.4107, 120.5978, 'assets/pin.png',
       'A museum showcasing the history, culture, and arts of the Cordillera region.',
       'Check current museum hours before visiting', 'Check current admission information'
FROM DUAL
WHERE NOT EXISTS (SELECT 1 FROM sites WHERE title = 'Baguio Museum');

INSERT INTO sites
    (title, category, is_hidden_gem, xp_reward, latitude, longitude, image_url,
     description, operating_hours, entrance_fee)
SELECT 'Newtown Convention Center', 'heritage', 0, 50, 16.4161, 120.6121, 'assets/pin.png',
       'A convention and events venue at Newtown Plaza in Baguio City.',
       'Hours vary by event', 'Check current event information'
FROM DUAL
WHERE NOT EXISTS (SELECT 1 FROM sites WHERE title = 'Newtown Convention Center');

INSERT INTO quests
    (quest_key, title, description, icon, quest_type, target_count, xp_reward, reward_badge_key)
SELECT 'burnham-secrets-walk', 'Burnham Secrets Walk',
       'Explore Baguio’s city-center landmarks, public spaces, and local culture on foot.',
       '⚑', 'sites', 6, 500, NULL
FROM DUAL
WHERE NOT EXISTS (
    SELECT 1 FROM quests WHERE quest_key = 'burnham-secrets-walk'
);

UPDATE quests
SET target_count = 6,
    quest_category = 'historical'
WHERE quest_key = 'burnham-secrets-walk';

INSERT INTO quest_stops (quest_id, site_id, stop_order)
SELECT q.id, s.id, 1
FROM quests AS q
JOIN sites AS s ON s.title = 'Burnham Park'
WHERE q.quest_key = 'burnham-secrets-walk'
  AND NOT EXISTS (
      SELECT 1 FROM quest_stops AS qs
      WHERE qs.quest_id = q.id AND qs.site_id = s.id
  );

INSERT INTO quest_stops (quest_id, site_id, stop_order)
SELECT q.id, s.id, 2
FROM quests AS q
JOIN sites AS s ON s.title = 'Session Road'
WHERE q.quest_key = 'burnham-secrets-walk'
  AND NOT EXISTS (
      SELECT 1 FROM quest_stops AS qs
      WHERE qs.quest_id = q.id AND qs.site_id = s.id
  );

INSERT INTO quest_stops (quest_id, site_id, stop_order)
SELECT q.id, s.id, 3
FROM quests AS q
JOIN sites AS s ON s.title = 'Baguio Public Market'
WHERE q.quest_key = 'burnham-secrets-walk'
  AND NOT EXISTS (
      SELECT 1 FROM quest_stops AS qs
      WHERE qs.quest_id = q.id AND qs.site_id = s.id
  );

INSERT INTO quest_stops (quest_id, site_id, stop_order)
SELECT q.id, s.id, 4
FROM quests AS q
JOIN sites AS s ON s.title = 'Baguio Cathedral'
WHERE q.quest_key = 'burnham-secrets-walk'
  AND NOT EXISTS (
      SELECT 1 FROM quest_stops AS qs
      WHERE qs.quest_id = q.id AND qs.site_id = s.id
  );

INSERT INTO quest_stops (quest_id, site_id, stop_order)
SELECT q.id, s.id, 5
FROM quests AS q
JOIN sites AS s ON s.title = 'Baguio Museum'
WHERE q.quest_key = 'burnham-secrets-walk'
  AND NOT EXISTS (
      SELECT 1 FROM quest_stops AS qs
      WHERE qs.quest_id = q.id AND qs.site_id = s.id
  );

INSERT INTO quest_stops (quest_id, site_id, stop_order)
SELECT q.id, s.id, 6
FROM quests AS q
JOIN sites AS s ON s.title = 'Newtown Convention Center'
WHERE q.quest_key = 'burnham-secrets-walk'
  AND NOT EXISTS (
      SELECT 1 FROM quest_stops AS qs
      WHERE qs.quest_id = q.id AND qs.site_id = s.id
  );

COMMIT;
