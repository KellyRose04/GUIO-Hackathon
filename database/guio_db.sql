CREATE DATABASE IF NOT EXISTS guio_db;
USE guio_db;

-- ==========================================
-- 1. USERS
-- ==========================================

CREATE TABLE IF NOT EXISTS users (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    username VARCHAR(100) NOT NULL,
    anonymous_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    last_seen TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    UNIQUE KEY uq_users_username (username),
    UNIQUE KEY uq_users_anonymous_id (anonymous_id)
) ENGINE=InnoDB;


-- ==========================================
-- 2. SITES
-- ==========================================

CREATE TABLE IF NOT EXISTS sites (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    title VARCHAR(180) NOT NULL,
    category VARCHAR(50) NOT NULL,
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


-- Remove the old column if it exists in an existing database.

SET @drop_hidden_gem_sql = (
    SELECT IF(
        COUNT(*) > 0,
        'ALTER TABLE sites DROP COLUMN is_hidden_gem',
        'SELECT ''is_hidden_gem column does not exist'' AS migration_status'
    )
    FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME = 'sites'
      AND COLUMN_NAME = 'is_hidden_gem'
);

PREPARE drop_hidden_gem_stmt FROM @drop_hidden_gem_sql;
EXECUTE drop_hidden_gem_stmt;
DEALLOCATE PREPARE drop_hidden_gem_stmt;


-- ==========================================
-- 3. QUESTS
-- ==========================================

CREATE TABLE IF NOT EXISTS quests (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    quest_key VARCHAR(100) NOT NULL,
    title VARCHAR(180) NOT NULL,
    description TEXT NOT NULL,
    icon VARCHAR(1000) NOT NULL DEFAULT '',
    quest_type ENUM('sites', 'streak') NOT NULL DEFAULT 'sites',
    quest_category VARCHAR(32) NOT NULL DEFAULT 'local_discovery',
    target_count INT UNSIGNED NOT NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    UNIQUE KEY uq_quests_key (quest_key)
) ENGINE=InnoDB;


-- Add quest_category to an existing database if missing.

SET @add_quest_category_sql = (
    SELECT IF(
        COUNT(*) = 0,
        'ALTER TABLE quests ADD COLUMN quest_category VARCHAR(32) NOT NULL DEFAULT ''local_discovery'' AFTER quest_type',
        'SELECT ''quest_category already exists'' AS migration_status'
    )
    FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME = 'quests'
      AND COLUMN_NAME = 'quest_category'
);

PREPARE add_quest_category_stmt FROM @add_quest_category_sql;
EXECUTE add_quest_category_stmt;
DEALLOCATE PREPARE add_quest_category_stmt;


-- ==========================================
-- 4. QUEST STOPS
-- ==========================================

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


-- ==========================================
-- 5. USER QUESTS
-- ==========================================

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


-- ==========================================
-- 6. USER QUEST STOPS
-- ==========================================

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


-- ==========================================
-- 7. DESTINATION QR CODES
-- ==========================================

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


-- Generate a random QR payload for each destination.
-- Only its SHA-256 hash is stored in the database.
-- Use database/generate_destination_qr.php to provision one safely.


-- ==========================================
-- 8. QUEST STATUS VIEW
-- ==========================================

CREATE OR REPLACE VIEW v_user_quest_status AS
SELECT
    u.id AS user_id,
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
    ON uq.user_id = u.id
    AND uq.quest_id = q.id;


-- ==========================================
-- 9. USER QUEST DESTINATIONS VIEW
-- ==========================================

CREATE OR REPLACE VIEW v_user_quest_destinations AS
SELECT
    u.id AS user_id,
    q.id AS quest_id,
    q.quest_key,
    qs.id AS quest_stop_id,
    qs.stop_order,
    s.id AS site_id,
    s.title AS destination,
    uq.id AS user_quest_id,
    CASE
        WHEN uq.status = 'completed' OR uqs.id IS NOT NULL
            THEN 'done'
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
         )
            THEN 'current'
        ELSE 'to_visit'
    END AS destination_status
FROM users AS u
CROSS JOIN quests AS q
JOIN quest_stops AS qs
    ON qs.quest_id = q.id
JOIN sites AS s
    ON s.id = qs.site_id
LEFT JOIN user_quests AS uq
    ON uq.user_id = u.id
    AND uq.quest_id = q.id
LEFT JOIN user_quest_stops AS uqs
    ON uqs.user_quest_id = uq.id
    AND uqs.quest_stop_id = qs.id;


-- ==========================================
-- 10. ACTIVE QUEST VIEW
-- ==========================================

CREATE OR REPLACE VIEW v_user_active_quest AS
SELECT
    uq.user_id,
    uq.id AS user_quest_id,
    uq.progress_count,
    uq.started_at,
    q.id AS quest_id,
    q.quest_key,
    q.title,
    q.description,
    q.icon,
    q.quest_type,
    q.quest_category,
    q.target_count,
    (
        SELECT qs.site_id
        FROM quest_stops AS qs
        LEFT JOIN user_quest_stops AS uqs
            ON uqs.user_quest_id = uq.id
            AND uqs.quest_stop_id = qs.id
        WHERE qs.quest_id = q.id
          AND uqs.id IS NULL
        ORDER BY qs.stop_order
        LIMIT 1
    ) AS next_site_id
FROM user_quests AS uq
JOIN quests AS q
    ON q.id = uq.quest_id
WHERE uq.status = 'active';


-- ==========================================
-- 11. BAGUIO DESTINATIONS
-- ==========================================

START TRANSACTION;

INSERT INTO sites
    (title, category, latitude, longitude, image_url,
     description, operating_hours, entrance_fee)
VALUES

(
    'Maryknoll Ecological Sanctuary',
    'nature',
    16.4008200,
    120.5888300,
    'assets/pin.png',
    'A quiet ecological sanctuary in Campo Sioco with pine trees, nature paths, and educational displays that encourage visitors to reflect on the environment.',
    'Check the sanctuary''s current visitor schedule.',
    'Confirm current admission or donation policy.'
),

(
    'Heritage Hill and Nature Park Garden (Old Diplomat Hotel)',
    'historical',
    16.4038300,
    120.5867400,
    'assets/pin.png',
    'A hilltop heritage and nature park on Dominican Hill, featuring the historic Old Diplomat Hotel ruins, landscaped paths, and views over Baguio City.',
    'Check current park hours and visitor access.',
    'Confirm current admission policy.'
),

(
    'Mirador Heritage and Eco-Spirituality Park',
    'cultural',
    16.4098000,
    120.5799000,
    'assets/pin.png',
    'A hillside park combining bamboo groves, rock gardens, prayer paths, heritage features, and viewpoints overlooking parts of Baguio.',
    'Check the official visitor schedule.',
    'Check current admission rates.'
),

(
    'Tam-awan Village',
    'cultural',
    16.4300700,
    120.5766800,
    'assets/pin.png',
    'An artist village in Pinsao Proper that brings together reconstructed Cordilleran traditional houses, local art, cultural activities, and a short nature trail.',
    'Check current visitor hours.',
    'Check current admission rates.'
),

(
    'Ili-Likha Artists'' Wateringhole',
    'local_discovery',
    16.4137800,
    120.5973300,
    'assets/pin.png',
    'An independent artists'' space near Assumption Road, known for its unusual recycled-material architecture, mosaics, local art, and small food stalls.',
    'Check current business hours.',
    'Free entry; purchases at individual stalls are optional.'
),

(
    'Easter Weaving Room',
    'cultural',
    16.4237300,
    120.5872000,
    'assets/pin.png',
    'A long-running weaving center in Guisad where visitors can discover Cordilleran textile traditions and locally made woven products.',
    'Check current store hours.',
    'Free to browse; product prices vary.'
),

(
    'Mt. Cloud Bookshop',
    'local_discovery',
    16.4097134,
    120.6005046,
    'assets/pin.png',
    'An independent bookstore known for Philippine literature and locally published books, offering a quieter cultural stop beyond the usual tourist attractions.',
    'Check current store hours.',
    'Free entry; purchases are optional.'
),

(
    'Bell House, Camp John Hay',
    'historical',
    16.3989120,
    120.6180790,
    'assets/pin.png',
    'A preserved historic house inside Camp John Hay that offers a glimpse of the area''s American-era history and architecture, surrounded by a quieter pine-forest setting.',
    'Check current visitor hours and access.',
    'Confirm current admission fee.'
),

(
    'Newtown Convention Center',
    'cultural',
    16.4161000,
    120.6121000,
    'assets/pin.png',
    'A convention and events venue at Newtown Plaza in Baguio City. Visitors can discover its architecture and check for public events and activities.',
    'Hours vary by event.',
    'Check current event information.'
)

ON DUPLICATE KEY UPDATE
    category = VALUES(category),
    latitude = VALUES(latitude),
    longitude = VALUES(longitude),
    image_url = VALUES(image_url),
    description = VALUES(description),
    operating_hours = VALUES(operating_hours),
    entrance_fee = VALUES(entrance_fee);


-- ==========================================
-- 12. BAGUIO HIDDEN GEMS QUEST
-- ==========================================

INSERT INTO quests
    (quest_key, title, description, icon,
     quest_type, quest_category, target_count)
VALUES
(
    'baguio-hidden-gems-trail',
    'Baguio Hidden Gems Trail',
    'Discover quieter cultural, historical, nature, and local places around Baguio City beyond the usual tourist landmarks.',
    '✦',
    'sites',
    'local_discovery',
    9
)

ON DUPLICATE KEY UPDATE
    title = VALUES(title),
    description = VALUES(description),
    icon = VALUES(icon),
    quest_type = VALUES(quest_type),
    quest_category = VALUES(quest_category),
    target_count = VALUES(target_count);


-- ==========================================
-- 13. QUEST DESTINATION STOPS
-- ==========================================

-- Synchronize the stops when this SQL is executed again.
-- This does not delete the user's overall quest records.

DELETE qs
FROM quest_stops AS qs
JOIN quests AS q
    ON q.id = qs.quest_id
WHERE q.quest_key = 'baguio-hidden-gems-trail';


-- Stop 1

INSERT INTO quest_stops (quest_id, site_id, stop_order)
SELECT q.id, s.id, 1
FROM quests AS q
JOIN sites AS s
    ON s.title = 'Maryknoll Ecological Sanctuary'
WHERE q.quest_key = 'baguio-hidden-gems-trail';


-- Stop 2

INSERT INTO quest_stops (quest_id, site_id, stop_order)
SELECT q.id, s.id, 2
FROM quests AS q
JOIN sites AS s
    ON s.title = 'Heritage Hill and Nature Park Garden (Old Diplomat Hotel)'
WHERE q.quest_key = 'baguio-hidden-gems-trail';


-- Stop 3

INSERT INTO quest_stops (quest_id, site_id, stop_order)
SELECT q.id, s.id, 3
FROM quests AS q
JOIN sites AS s
    ON s.title = 'Mirador Heritage and Eco-Spirituality Park'
WHERE q.quest_key = 'baguio-hidden-gems-trail';


-- Stop 4

INSERT INTO quest_stops (quest_id, site_id, stop_order)
SELECT q.id, s.id, 4
FROM quests AS q
JOIN sites AS s
    ON s.title = 'Tam-awan Village'
WHERE q.quest_key = 'baguio-hidden-gems-trail';


-- Stop 5

INSERT INTO quest_stops (quest_id, site_id, stop_order)
SELECT q.id, s.id, 5
FROM quests AS q
JOIN sites AS s
    ON s.title = 'Ili-Likha Artists'' Wateringhole'
WHERE q.quest_key = 'baguio-hidden-gems-trail';


-- Stop 6

INSERT INTO quest_stops (quest_id, site_id, stop_order)
SELECT q.id, s.id, 6
FROM quests AS q
JOIN sites AS s
    ON s.title = 'Easter Weaving Room'
WHERE q.quest_key = 'baguio-hidden-gems-trail';


-- Stop 7

INSERT INTO quest_stops (quest_id, site_id, stop_order)
SELECT q.id, s.id, 7
FROM quests AS q
JOIN sites AS s
    ON s.title = 'Mt. Cloud Bookshop'
WHERE q.quest_key = 'baguio-hidden-gems-trail';


-- Stop 8

INSERT INTO quest_stops (quest_id, site_id, stop_order)
SELECT q.id, s.id, 8
FROM quests AS q
JOIN sites AS s
    ON s.title = 'Bell House, Camp John Hay'
WHERE q.quest_key = 'baguio-hidden-gems-trail';


-- Stop 9

INSERT INTO quest_stops (quest_id, site_id, stop_order)
SELECT q.id, s.id, 9
FROM quests AS q
JOIN sites AS s
    ON s.title = 'Newtown Convention Center'
WHERE q.quest_key = 'baguio-hidden-gems-trail';


COMMIT;