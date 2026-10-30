const JSON_HEADERS = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store",
};

function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: JSON_HEADERS,
  });
}

function normalizeUsername(value) {
  if (typeof value !== "string") return null;
  const username = value.trim();
  if (!username) return null;
  if (username.length > 100 || /[\u0000-\u001f\u007f]/.test(username)) {
    throw new Error("The selected account is invalid.");
  }
  return username;
}

function hashToken(token) {
  return crypto.subtle.digest("SHA-256", new TextEncoder().encode(token))
    .then((digest) => Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join(""));
}

async function findUserId(db, username) {
  if (!username) return null;
  const user = await db.prepare("SELECT id FROM users WHERE username = ?")
    .bind(username)
    .first();
  return user ? Number(user.id) : null;
}

async function ensureUserId(db, username) {
  await db.prepare("INSERT OR IGNORE INTO users (username) VALUES (?)")
    .bind(username)
    .run();
  return findUserId(db, username);
}

async function loadQuestCatalog(db, userId) {
  const result = await db.prepare(
    `SELECT q.id AS quest_id, q.quest_key, q.title, q.description, q.icon,
            q.quest_type, q.category, q.target_count,
            CASE
              WHEN uq.status = 'completed' THEN 'done'
              WHEN uq.status = 'active' THEN 'current'
              ELSE 'available'
            END AS quest_status,
            COALESCE(uq.progress_count, 0) AS progress_count,
            uq.id AS user_quest_id
       FROM quests AS q
       LEFT JOIN user_quests AS uq
         ON uq.quest_id = q.id AND uq.user_id = ?
      ORDER BY q.id`
  ).bind(userId || 0).all();

  const quests = [];
  let activeQuest = null;

  for (const row of result.results) {
    const stopsResult = await db.prepare(
      `SELECT qs.site_id, qs.stop_order, s.title,
              CASE
                WHEN uq.status = 'completed' OR uqs.id IS NOT NULL THEN 'done'
                WHEN uq.status = 'active'
                 AND NOT EXISTS (
                   SELECT 1
                     FROM quest_stops AS earlier
                     LEFT JOIN user_quest_stops AS earlier_done
                       ON earlier_done.user_quest_id = uq.id
                      AND earlier_done.quest_stop_id = earlier.id
                    WHERE earlier.quest_id = qs.quest_id
                      AND earlier.stop_order < qs.stop_order
                      AND earlier_done.id IS NULL
                 ) THEN 'current'
                ELSE 'to_visit'
              END AS destination_status
         FROM quest_stops AS qs
         JOIN sites AS s ON s.id = qs.site_id
         LEFT JOIN user_quests AS uq
           ON uq.quest_id = qs.quest_id AND uq.user_id = ?
         LEFT JOIN user_quest_stops AS uqs
           ON uqs.user_quest_id = uq.id AND uqs.quest_stop_id = qs.id
        WHERE qs.quest_id = ?
        ORDER BY qs.stop_order`
    ).bind(userId || 0, row.quest_id).all();

    const stops = stopsResult.results.map((stop) => ({
      site_id: Number(stop.site_id),
      stop_order: Number(stop.stop_order),
      title: stop.title,
      destination_status: stop.destination_status,
      stop_state: stop.destination_status === "done"
        ? "done"
        : stop.destination_status === "current"
          ? "next"
          : "locked",
    }));

    const quest = {
      ...row,
      quest_id: Number(row.quest_id),
      target_count: Number(row.target_count),
      progress_count: Number(row.progress_count),
      user_quest_id: row.user_quest_id === null ? null : Number(row.user_quest_id),
      stops,
    };
    quests.push(quest);

    if (row.quest_status === "current" && userId !== null) {
      activeQuest = {
        ...quest,
        user_quest_id: Number(row.user_quest_id),
        status: "active",
      };
    }
  }

  return { quests, active_quest: activeQuest };
}

async function startQuest(db, userId, questKey) {
  if (typeof questKey !== "string" || !/^[a-z0-9][a-z0-9-]{0,99}$/.test(questKey.trim())) {
    return jsonResponse({ status: "error", error: "A valid quest key is required." }, 400);
  }
  const normalizedKey = questKey.trim();
  const quest = await db.prepare(
    `SELECT q.id
       FROM quests AS q
      WHERE q.quest_key = ?
        AND EXISTS (SELECT 1 FROM quest_stops AS qs WHERE qs.quest_id = q.id)`
  ).bind(normalizedKey).first();

  if (!quest) {
    return jsonResponse({ status: "error", error: "This quest is not available." }, 404);
  }

  const existing = await db.prepare(
    "SELECT id, status FROM user_quests WHERE user_id = ? AND quest_id = ?"
  ).bind(userId, quest.id).first();
  if (existing?.status === "completed") {
    return jsonResponse({ status: "error", quest_status: "done", error: "This quest is already complete." }, 409);
  }

  const active = await db.prepare(
    "SELECT id, quest_id FROM user_quests WHERE user_id = ? AND status = 'active' LIMIT 1"
  ).bind(userId).first();
  if (active && Number(active.quest_id) !== Number(quest.id)) {
    return jsonResponse({
      status: "error",
      quest_status: "current",
      error: "Complete your current quest before starting another.",
    }, 409);
  }

  if (!existing) {
    try {
      await db.prepare(
        `INSERT INTO user_quests (user_id, quest_id, status, progress_count)
         VALUES (?, ?, 'active', 0)`
      ).bind(userId, quest.id).run();
    } catch (error) {
      const activeAfterConflict = await db.prepare(
        "SELECT quest_id FROM user_quests WHERE user_id = ? AND status = 'active' LIMIT 1"
      ).bind(userId).first();
      if (!activeAfterConflict) throw error;
      if (Number(activeAfterConflict.quest_id) !== Number(quest.id)) {
        return jsonResponse({
          status: "error",
          quest_status: "current",
          error: "Complete your current quest before starting another.",
        }, 409);
      }
    }
  }

  const catalog = await loadQuestCatalog(db, userId);
  return jsonResponse({
    status: "success",
    quest_status: "current",
    active_quest: catalog.active_quest,
  });
}

async function verifyDestination(db, userId, token) {
  if (typeof token !== "string" || token.trim().length < 16 || token.trim().length > 512) {
    return jsonResponse({ status: "error", error: "A valid destination QR code is required." }, 400);
  }

  const activeQuest = await db.prepare(
    `SELECT uq.id AS user_quest_id, uq.quest_id, uq.progress_count
       FROM user_quests AS uq
      WHERE uq.user_id = ? AND uq.status = 'active'
      LIMIT 1`
  ).bind(userId).first();
  if (!activeQuest) {
    return jsonResponse({
      status: "error",
      error: "Start a quest before scanning a destination QR code.",
    }, 409);
  }

  const currentStop = await db.prepare(
    `SELECT qs.id AS quest_stop_id, qs.site_id
       FROM quest_stops AS qs
       LEFT JOIN user_quest_stops AS uqs
         ON uqs.user_quest_id = ? AND uqs.quest_stop_id = qs.id
      WHERE qs.quest_id = ? AND uqs.id IS NULL
      ORDER BY qs.stop_order
      LIMIT 1`
  ).bind(activeQuest.user_quest_id, activeQuest.quest_id).first();
  if (!currentStop) {
    return jsonResponse({ status: "error", error: "There are no remaining destinations in this quest." }, 409);
  }

  const tokenHash = await hashToken(token.trim());
  const code = await db.prepare(
    `SELECT id
       FROM destination_qr_codes
      WHERE site_id = ? AND token_hash = ? AND is_active = 1
        AND (expires_at IS NULL OR datetime(expires_at) > CURRENT_TIMESTAMP)
      LIMIT 1`
  ).bind(currentStop.site_id, tokenHash).first();
  if (!code) {
    return jsonResponse({
      status: "error",
      error: "This QR code is invalid or is not for your current destination.",
    }, 422);
  }

  const results = await db.batch([
    db.prepare(
      `INSERT OR IGNORE INTO user_quest_stops (user_quest_id, quest_stop_id)
       SELECT uq.id, qs.id
         FROM user_quests AS uq
         JOIN quest_stops AS qs ON qs.quest_id = uq.quest_id
        WHERE uq.id = ? AND uq.user_id = ? AND uq.status = 'active'
          AND qs.id = ?
          AND qs.id = (
            SELECT next_stop.id
              FROM quest_stops AS next_stop
              LEFT JOIN user_quest_stops AS completed
                ON completed.user_quest_id = uq.id
               AND completed.quest_stop_id = next_stop.id
             WHERE next_stop.quest_id = uq.quest_id
               AND completed.id IS NULL
             ORDER BY next_stop.stop_order
             LIMIT 1
          )
          AND EXISTS (
            SELECT 1 FROM destination_qr_codes AS code
             WHERE code.site_id = qs.site_id AND code.token_hash = ?
               AND code.is_active = 1
               AND (code.expires_at IS NULL OR datetime(code.expires_at) > CURRENT_TIMESTAMP)
          )`
    ).bind(activeQuest.user_quest_id, userId, currentStop.quest_stop_id, tokenHash),
    db.prepare(
      `UPDATE user_quests
          SET progress_count = (
                SELECT COUNT(*) FROM user_quest_stops
                 WHERE user_quest_id = user_quests.id
              ),
              status = CASE
                WHEN (
                  SELECT COUNT(*) FROM user_quest_stops
                   WHERE user_quest_id = user_quests.id
                ) >= (
                  SELECT COUNT(*) FROM quest_stops
                   WHERE quest_id = user_quests.quest_id
                ) THEN 'completed'
                ELSE 'active'
              END,
              completed_at = CASE
                WHEN (
                  SELECT COUNT(*) FROM user_quest_stops
                   WHERE user_quest_id = user_quests.id
                ) >= (
                  SELECT COUNT(*) FROM quest_stops
                   WHERE quest_id = user_quests.quest_id
                ) THEN CURRENT_TIMESTAMP
                ELSE NULL
              END
        WHERE id = ? AND user_id = ? AND status = 'active'`
    ).bind(activeQuest.user_quest_id, userId),
  ]);

  if (Number(results[0]?.meta?.changes || 0) === 0) {
    return jsonResponse({
      status: "error",
      error: "This QR code is invalid or is not for your current destination.",
    }, 422);
  }

  const updatedQuest = await db.prepare(
    "SELECT progress_count, status FROM user_quests WHERE id = ? AND user_id = ?"
  ).bind(activeQuest.user_quest_id, userId).first();
  const catalog = await loadQuestCatalog(db, userId);
  return jsonResponse({
    status: "success",
    quest_status: updatedQuest?.status === "completed" ? "done" : "current",
    completed_destination_id: Number(currentStop.site_id),
    progress_count: Number(updatedQuest?.progress_count || 0),
    active_quest: catalog.active_quest,
  });
}

export async function onRequest({ request, env }) {
  if (!env.DB) {
    return jsonResponse({ status: "error", error: "Cloudflare D1 binding DB is not configured." }, 503);
  }

  const method = request.method.toUpperCase();
  if (method !== "GET" && method !== "POST") {
    return jsonResponse({ status: "error", error: "Use GET to list quests or POST to start a quest." }, 405);
  }

  let body = {};
  if (method === "POST") {
    try {
      body = await request.json();
    } catch {
      return jsonResponse({ status: "error", error: "Request body must be valid JSON." }, 400);
    }
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return jsonResponse({ status: "error", error: "Request body must be a JSON object." }, 400);
    }
  }

  try {
    const url = new URL(request.url);
    const username = normalizeUsername(url.searchParams.get("user") ?? body.user);

    if (method === "GET") {
      const userId = await findUserId(env.DB, username);
      return jsonResponse({
        status: "success",
        ...(await loadQuestCatalog(env.DB, userId)),
      });
    }

    if (!username) {
      return jsonResponse({ status: "error", error: "A selected account is required to start a quest." }, 400);
    }
    const userId = await ensureUserId(env.DB, username);
    const action = typeof body.action === "string" ? body.action : "start";

    if (action === "verify_destination") {
      return await verifyDestination(env.DB, userId, body.qr_token);
    }
    if (action !== "start") {
      return jsonResponse({ status: "error", error: "Unsupported quest action." }, 400);
    }
    return await startQuest(env.DB, userId, body.quest_key);
  } catch (error) {
    if (error instanceof Error && error.message === "The selected account is invalid.") {
      return jsonResponse({ status: "error", error: error.message }, 400);
    }
    console.error("Cloudflare quest API request failed:", error);
    return jsonResponse({ status: "error", error: "Quests are temporarily unavailable." }, 503);
  }
}
