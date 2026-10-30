USE guio_db;

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
SET target_count = 6
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

-- Activate only for a matching account with no active quest or prior copy of this quest.
-- Existing active progress is never replaced.
INSERT INTO user_quests (user_id, quest_id, status, progress_count, started_at)
SELECT u.id, q.id, 'active', 0, NOW()
FROM users AS u
JOIN quests AS q ON q.quest_key = 'burnham-secrets-walk'
WHERE u.username = @sample_username
  AND @sample_username <> 'REPLACE_WITH_EXISTING_USERNAME'
  AND NOT EXISTS (
      SELECT 1 FROM user_quests AS uq
      WHERE uq.user_id = u.id AND uq.status = 'active'
  )
  AND NOT EXISTS (
      SELECT 1 FROM user_quests AS uq
      WHERE uq.user_id = u.id AND uq.quest_id = q.id
  );

COMMIT;
