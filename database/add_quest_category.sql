-- Run once against the same database used by api/quests.php.
-- Category values: cultural, historical, nature, local_discovery.

ALTER TABLE quests
    ADD COLUMN quest_category VARCHAR(32) NOT NULL
        DEFAULT 'local_discovery'
        AFTER quest_type;

-- The seeded Burnham route focuses on city landmarks and heritage sites.
UPDATE quests
   SET quest_category = 'historical'
 WHERE quest_key = 'burnham-secrets-walk';
