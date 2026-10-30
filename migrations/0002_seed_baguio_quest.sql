INSERT OR IGNORE INTO sites
    (title, category, latitude, longitude, image_url, description, operating_hours, entrance_fee)
VALUES
    ('Burnham Park', 'nature', 16.4108, 120.5960, 'assets/pin.png',
     'A central public park known for its lake, gardens, and outdoor recreation.',
     'Public park; hours may vary', 'Free entry; some activities charge'),
    ('Session Road', 'heritage', 16.4122, 120.5973, 'assets/pin.png',
     'Baguio’s central commercial avenue, lined with shops, cafes, and historic city buildings.',
     'Public road; business hours vary', 'Free'),
    ('Baguio Public Market', 'food', 16.4145, 120.5934, 'assets/pin.png',
     'A busy city market for local produce, food, flowers, and crafts.',
     'Market hours vary by stall', 'Free entry'),
    ('Baguio Cathedral', 'heritage', 16.4149, 120.5931, 'assets/pin.png',
     'The pink twin-spired cathedral overlooking the city center.',
     'Hours may vary; please observe service times', 'Free'),
    ('Baguio Museum', 'heritage', 16.4107, 120.5978, 'assets/pin.png',
     'A museum showcasing the history, culture, and arts of the Cordillera region.',
     'Check current museum hours before visiting', 'Check current admission information'),
    ('Newtown Convention Center', 'heritage', 16.4161, 120.6121, 'assets/pin.png',
     'A convention and events venue at Newtown Plaza in Baguio City.',
     'Hours vary by event', 'Check current event information');

INSERT OR IGNORE INTO quests
    (quest_key, title, description, icon, quest_type, category, target_count)
VALUES
    ('burnham-secrets-walk', 'Burnham Secrets Walk',
     'Explore Baguio’s city-center landmarks, public spaces, and local culture on foot.',
     '⚑', 'sites', 'historical', 6);

INSERT OR IGNORE INTO quest_stops (quest_id, site_id, stop_order)
SELECT q.id, s.id, 1
  FROM quests AS q
  JOIN sites AS s ON s.title = 'Burnham Park'
 WHERE q.quest_key = 'burnham-secrets-walk';

INSERT OR IGNORE INTO quest_stops (quest_id, site_id, stop_order)
SELECT q.id, s.id, 2
  FROM quests AS q
  JOIN sites AS s ON s.title = 'Session Road'
 WHERE q.quest_key = 'burnham-secrets-walk';

INSERT OR IGNORE INTO quest_stops (quest_id, site_id, stop_order)
SELECT q.id, s.id, 3
  FROM quests AS q
  JOIN sites AS s ON s.title = 'Baguio Public Market'
 WHERE q.quest_key = 'burnham-secrets-walk';

INSERT OR IGNORE INTO quest_stops (quest_id, site_id, stop_order)
SELECT q.id, s.id, 4
  FROM quests AS q
  JOIN sites AS s ON s.title = 'Baguio Cathedral'
 WHERE q.quest_key = 'burnham-secrets-walk';

INSERT OR IGNORE INTO quest_stops (quest_id, site_id, stop_order)
SELECT q.id, s.id, 5
  FROM quests AS q
  JOIN sites AS s ON s.title = 'Baguio Museum'
 WHERE q.quest_key = 'burnham-secrets-walk';

INSERT OR IGNORE INTO quest_stops (quest_id, site_id, stop_order)
SELECT q.id, s.id, 6
  FROM quests AS q
  JOIN sites AS s ON s.title = 'Newtown Convention Center'
 WHERE q.quest_key = 'burnham-secrets-walk';
