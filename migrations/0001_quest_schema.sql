CREATE TABLE users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL UNIQUE
);

CREATE TABLE sites (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL UNIQUE,
    category TEXT NOT NULL,
    latitude REAL NOT NULL,
    longitude REAL NOT NULL,
    image_url TEXT NOT NULL DEFAULT '',
    description TEXT NOT NULL DEFAULT '',
    operating_hours TEXT NOT NULL DEFAULT '',
    entrance_fee TEXT NOT NULL DEFAULT ''
);

CREATE INDEX idx_sites_category ON sites (category);

CREATE TABLE quests (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    quest_key TEXT NOT NULL UNIQUE,
    title TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    icon TEXT NOT NULL DEFAULT '',
    quest_type TEXT NOT NULL DEFAULT 'sites' CHECK (quest_type IN ('sites')),
    category TEXT NOT NULL DEFAULT 'historical',
    target_count INTEGER NOT NULL CHECK (target_count >= 0),
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE quest_stops (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    quest_id INTEGER NOT NULL,
    site_id INTEGER NOT NULL,
    stop_order INTEGER NOT NULL CHECK (stop_order > 0),
    UNIQUE (quest_id, site_id),
    UNIQUE (quest_id, stop_order),
    FOREIGN KEY (quest_id) REFERENCES quests (id) ON UPDATE CASCADE ON DELETE CASCADE,
    FOREIGN KEY (site_id) REFERENCES sites (id) ON UPDATE CASCADE ON DELETE RESTRICT
);

CREATE TABLE user_quests (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    quest_id INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'completed')),
    progress_count INTEGER NOT NULL DEFAULT 0 CHECK (progress_count >= 0),
    started_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    completed_at TEXT,
    UNIQUE (user_id, quest_id),
    FOREIGN KEY (user_id) REFERENCES users (id) ON UPDATE CASCADE ON DELETE CASCADE,
    FOREIGN KEY (quest_id) REFERENCES quests (id) ON UPDATE CASCADE ON DELETE CASCADE
);

CREATE UNIQUE INDEX uq_one_active_quest_per_user
    ON user_quests (user_id)
    WHERE status = 'active';

CREATE TABLE user_quest_stops (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_quest_id INTEGER NOT NULL,
    quest_stop_id INTEGER NOT NULL,
    completed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (user_quest_id, quest_stop_id),
    FOREIGN KEY (user_quest_id) REFERENCES user_quests (id) ON UPDATE CASCADE ON DELETE CASCADE,
    FOREIGN KEY (quest_stop_id) REFERENCES quest_stops (id) ON UPDATE CASCADE ON DELETE CASCADE
);

CREATE TABLE destination_qr_codes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    site_id INTEGER NOT NULL,
    token_hash TEXT NOT NULL UNIQUE CHECK (length(token_hash) = 64),
    is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
    expires_at TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (site_id) REFERENCES sites (id) ON UPDATE CASCADE ON DELETE CASCADE
);

CREATE INDEX idx_destination_qr_site_active
    ON destination_qr_codes (site_id, is_active);
