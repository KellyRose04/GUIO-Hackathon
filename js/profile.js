(() => {
  // Use the account explicitly selected in the URL, or the last selection in this tab.
  // This app has no authentication session yet, so do not silently choose an account.
  const ACCOUNT_STORAGE_KEY = "tourtrail-active-username";
  const activeUrl = new URL(window.location.href);
  const requestedUser = activeUrl.searchParams.get("user");
  let username = "";

  try {
    if (requestedUser !== null) {
      // An explicit URL choice takes precedence and becomes this tab's active account.
      username = requestedUser.trim();
      if (username) window.sessionStorage.setItem(ACCOUNT_STORAGE_KEY, username);
      else window.sessionStorage.removeItem(ACCOUNT_STORAGE_KEY);
    } else {
      username = (window.sessionStorage.getItem(ACCOUNT_STORAGE_KEY) || "").trim();
    }
  } catch (error) {
    // Continue with the URL selection if storage is unavailable in this browser.
    username = (requestedUser || "").trim();
  }

  if (username) activeUrl.searchParams.set("user", username);
  else activeUrl.searchParams.delete("user");
  if (activeUrl.href !== window.location.href) {
    window.history.replaceState(null, "", activeUrl);
  }

  function applicationBaseUrl() {
    const applicationPath = window.location.pathname.includes("/html/")
      ? "../"
      : "./";
    return new URL(applicationPath, window.location.href);
  }

  // Add the active username to API and page links while preserving other query parameters.
  function accountUrl(path) {
    const url = new URL(path, applicationBaseUrl());
    if (username) url.searchParams.set("user", username);
    return url.href;
  }

  // Update a header pill's text without removing any icon or nested elements.
  function setPill(element, label, value) {
    if (!element) return;
    Array.from(element.childNodes).forEach((node) => {
      if (node.nodeType === Node.TEXT_NODE) node.remove();
    });
    element.appendChild(document.createTextNode(`${label}${value}`));
  }

  // Expose account-aware URL helpers for map, camera, passport, and gallery scripts.
  const PENDING_CHECKINS_KEY = "tourtrail-pending-checkins";
  const SERVER_OFFLINE_KEY = "tourtrail-server-offline";
  let syncInProgress = false;
  let pendingSyncTimer = null;

  function readPendingCheckIns() {
    try {
      const records = JSON.parse(window.localStorage.getItem(PENDING_CHECKINS_KEY) || "[]");
      if (!Array.isArray(records)) {
        // Treat malformed stored data as an error instead of silently discarding check-ins.
        throw new Error("Pending check-in data is not a list.");
      }
      return records;
    } catch (error) {
      console.error("Could not read pending check-ins:", error);
      throw error;
    }
  }

  function updateConnectionStatus() {
    let pendingStatus = document.getElementById("pending-status");
    if (!pendingStatus) {
      const header = document.querySelector("#top-nav");
      if (!header) return;
      let bar = document.getElementById("connection-bar");
      if (!bar) {
        bar = document.createElement("div");
        bar.id = "connection-bar";
        bar.style.cssText = "display:flex;flex-wrap:wrap;gap:8px;padding:8px 16px;";
        header.insertAdjacentElement("afterend", bar);
      }
      pendingStatus = document.createElement("p");
      pendingStatus.id = "pending-status";
      pendingStatus.setAttribute("role", "status");
      pendingStatus.setAttribute("aria-live", "polite");
      pendingStatus.style.cssText = "margin:0;padding:5px 12px;border:1px solid #174B83;border-radius:99px;background:#FBF9F2;font-size:12px;font-weight:700;";
      pendingStatus.innerHTML = '<span id="pending-count">0</span> check-ins pending';
      bar.appendChild(pendingStatus);
    }

    let count = 0;
    try {
      // Keep the pending count and its status pill synchronized with local queued uploads.
      count = readPendingCheckIns().length;
      const countElement = document.getElementById("pending-count");
      if (countElement) countElement.textContent = String(count);
      pendingStatus.hidden = count === 0;
    } catch (error) {
      pendingStatus.hidden = false;
      pendingStatus.textContent = "Pending check-ins could not be read.";
    }
  }

  function savePendingCheckIns(records) {
    window.localStorage.setItem(PENDING_CHECKINS_KEY, JSON.stringify(records));
    updateConnectionStatus();
    window.dispatchEvent(new Event("tourtrail-pending-checkins-changed"));
    // Retry queued uploads periodically, stopping the timer when the queue is empty.
    if (records.length && pendingSyncTimer === null) {
      pendingSyncTimer = window.setInterval(syncPendingCheckIns, 30000);
    } else if (!records.length && pendingSyncTimer !== null) {
      window.clearInterval(pendingSyncTimer);
      pendingSyncTimer = null;
    }
  }

  function markServerOffline() {
    try {
      window.localStorage.setItem(SERVER_OFFLINE_KEY, "true");
    } catch (error) {
      console.error("Could not save the offline connection status:", error);
    }
    updateConnectionStatus();
  }

  function markServerOnline() {
    try {
      window.localStorage.removeItem(SERVER_OFFLINE_KEY);
    } catch (error) {
      console.error("Could not save the online connection status:", error);
    }
    updateConnectionStatus();
  }

  function isServerOffline() {
    try {
      return window.localStorage.getItem(SERVER_OFFLINE_KEY) === "true";
    } catch (error) {
      console.error("Could not read the saved connection status:", error);
      return false;
    }
  }

  function isOffline() {
    return !navigator.onLine || isServerOffline();
  }

  function pendingCheckInCount() {
    return readPendingCheckIns().length;
  }

  function queueCheckIn(photo, siteId = null) {
    if (!photo || typeof photo.id !== "string" || !photo.imageUrl?.startsWith("data:image/")) {
      throw new Error("A captured photo is required to queue a check-in.");
    }
    const records = readPendingCheckIns();
    if (!records.some((record) => record.id === photo.id)) {
      records.push({
        id: photo.id,
        imageUrl: photo.imageUrl,
        gps: photo.gps || null,
        siteId: siteId === null ? null : String(siteId),
        username,
        takenAt: photo.takenAt || new Date().toISOString(),
      });
      savePendingCheckIns(records);
    }
    return records.find((record) => record.id === photo.id);
  }

  async function syncPendingCheckIns() {
    // Avoid overlapping retries and leave queued records untouched while offline.
    if (syncInProgress || !navigator.onLine) return;
    syncInProgress = true;
    try {
      const records = readPendingCheckIns();
      // A shared queue may contain records from more than one selected account.
      const matchingRecords = records.filter((record) => record.username === username);
      if (!matchingRecords.length) return;
      for (const record of matchingRecords) {
        const image = await fetch(record.imageUrl).then((response) => {
          if (!response.ok) throw new Error("The saved check-in photo could not be read.");
          return response.blob();
        });
        const formData = new FormData();
        formData.append("photo", image, "check-in.jpg");
        formData.append("client_photo_id", record.id);
        if (record.gps) {
          formData.append("latitude", String(record.gps.lat));
          formData.append("longitude", String(record.gps.lng));
          if (Number.isFinite(record.gps.accuracy)) {
            formData.append("accuracy", String(record.gps.accuracy));
          }
        }
        if (record.siteId !== null) formData.append("site_id", record.siteId);

        const response = await fetch(accountUrl("api/checkins.php"), {
          method: "POST",
          headers: { Accept: "application/json" },
          body: formData,
        });
        const payload = await response.json();
        if (!response.ok || payload.status !== "success" || !payload.data?.checkin_id) {
          const error = new Error(payload.error || `Check-in upload failed (${response.status}).`);
          error.status = response.status;
          throw error;
        }

        // Older API/database drivers may encode booleans as numbers or strings.
        const isVerified = payload.data.is_verified === true ||
          payload.data.is_verified === 1 ||
          payload.data.is_verified === "1" ||
          payload.data.verification_status === "verified";
        const hasVerificationResult =
          payload.data.is_verified === true ||
          payload.data.is_verified === false ||
          payload.data.is_verified === 1 ||
          payload.data.is_verified === 0 ||
          payload.data.is_verified === "1" ||
          payload.data.is_verified === "0" ||
          payload.data.verification_status === "verified" ||
          payload.data.verification_status === "unverified";
        if (!hasVerificationResult) {
          throw new Error("Check-in upload returned no verification result.");
        }
        if (isVerified) {
          const rewardResponse = await fetch(accountUrl("api/checkins.php"), {
            method: "PATCH",
            headers: {
              Accept: "application/json",
              "Content-Type": "application/json",
            },
            body: JSON.stringify({ checkin_id: payload.data.checkin_id }),
          });
          const reward = await rewardResponse.json();
          const rewardData = reward.data;
          if (
            !rewardResponse.ok ||
            reward.status !== "success" ||
            !Number.isFinite(Number(rewardData?.xp_earned)) ||
            !Number.isFinite(Number(rewardData?.total_xp)) ||
            !Array.isArray(rewardData?.badges_awarded) ||
            !Array.isArray(rewardData?.quests_completed) ||
            typeof rewardData?.streak_updated !== "boolean" ||
            !["awarded", "already_collected", "unavailable"].includes(rewardData?.stamp_status)
          ) {
            const error = new Error(
              reward.error || `Check-in reward sync failed (${rewardResponse.status}).`
            );
            error.status = rewardResponse.status;
            throw error;
          }
        }

        // Remove a record only after both upload and any required reward sync succeed.
        const latestRecords = readPendingCheckIns();
        savePendingCheckIns(latestRecords.filter((pending) => pending.id !== record.id));
        window.dispatchEvent(new CustomEvent("tourtrail-checkin-synced", {
          detail: {
            id: record.id,
            verified: isVerified,
            siteName: payload.data.site_name || null,
          },
        }));
      }
      markServerOnline();
    } catch (error) {
      if (
        !navigator.onLine ||
        error.name === "TypeError" ||
        (Number.isInteger(error.status) && error.status >= 500)
      ) {
        markServerOffline();
      }
      console.error("Could not sync pending check-ins:", error);
    } finally {
      syncInProgress = false;
    }
  }

  const account = {
    username,
    apiUrl: accountUrl,
    markServerOffline,
    markServerOnline,
    queueCheckIn,
    syncPendingCheckIns,
    updateConnectionStatus,
    isServerOffline,
    isOffline,
    pendingCheckInCount,
    pageUrl(path) {
      const url = new URL(path, applicationBaseUrl());
      if (username && url.origin === window.location.origin) {
        url.searchParams.set("user", username);
      }
      return url.href;
    },
  };

  // Other page scripts use this shared interface for account-aware navigation and sync.
  window.TourTrailAccount = account;

  document.addEventListener("DOMContentLoaded", () => {
    updateConnectionStatus();
    syncPendingCheckIns();
    try {
      if (pendingCheckInCount() > 0) {
        pendingSyncTimer = window.setInterval(syncPendingCheckIns, 30000);
      }
    } catch (error) {
      console.error("Could not check for pending check-ins:", error);
    }
    window.addEventListener("online", syncPendingCheckIns);
    window.addEventListener("focus", syncPendingCheckIns);
    document.addEventListener("visibilitychange", () => {
      if (!document.hidden) syncPendingCheckIns();
    });
    window.addEventListener("online", updateConnectionStatus);
    window.addEventListener("offline", updateConnectionStatus);
    // Other tabs can modify the shared queue, so refresh this tab's status when they do.
    window.addEventListener("storage", (event) => {
      if (event.key === PENDING_CHECKINS_KEY || event.key === SERVER_OFFLINE_KEY) {
        updateConnectionStatus();
      }
    });
    window.addEventListener("tourtrail-pending-checkins-changed", updateConnectionStatus);

    // Keep same-site navigation on the selected account.
    document.querySelectorAll('a[href$=".html"]').forEach((link) => {
      const url = new URL(link.href, window.location.href);
      if (username && url.origin === window.location.origin) {
        url.searchParams.set("user", username);
        link.href = url.href;
      }
    });

    // Load the account summary once and populate any shared streak indicators.
    if (!username) return;

    fetch(account.apiUrl("api/passport.php"), {
      headers: { Accept: "application/json" },
      cache: "no-store",
    })
      .then(async (response) => {
        const profile = await response.json();
        if (!response.ok || !profile.user) {
          const error = new Error(profile.error || `Account request failed (${response.status}).`);
          error.status = response.status;
          throw error;
        }
        markServerOnline();

        const streak = Number(profile.user.streak_count);
        const avatarUrl = profile.user.avatar_url;

        // Update all matching header indicators, including pages with duplicate layouts.
        document.querySelectorAll("#streak-count").forEach((element) => {
          element.textContent = Number.isFinite(streak) ? String(streak) : "0";
        });

        // Leave the current avatar in place when the account has no saved image.
        if (avatarUrl) {
          document.querySelectorAll("#player-avatar img").forEach((imgElement) => {
            imgElement.src = avatarUrl;
          });
        }

        setPill(
          document.querySelector("#streak"),
          "Streaks: ",
          Number.isFinite(streak) ? String(streak) : "0"
        );
      })
      .catch((error) => {
        if (
          !navigator.onLine ||
          error.name === "TypeError" ||
          (Number.isInteger(error.status) && error.status >= 500)
        ) {
          markServerOffline();
        }
        console.error("Could not load the account summary:", error);
      })
  });
})();

(() => {
  const badgesCard = document.getElementById("badges");
  const badgesGrid = document.querySelector("#badges .badges-grid");
  const badgesCount = document.querySelector("#badges .badges-count");
  const preview = document.getElementById("stamp-preview");
  if (!badgesGrid || !preview) return;

  const field = (name) => preview.querySelector(`[data-preview="${name}"]`);

  function iconSrc(icon) {
    const value = String(icon || "").trim();
    if (!value) return "../assets/pin.png";
    if (/^https?:\/\//i.test(value) || value.startsWith("/") || value.startsWith("../") || value.includes(".")) {
      return value;
    }
    return "";
  }

  function resetPreview() {
    field("tag").textContent = "Badge";
    field("title").textContent = "Your badge collection";
    field("desc").textContent = "Select a badge to see its details.";
    field("icon").src = "../assets/pin.png";
    field("rarity-row").hidden = true;
    field("meta").hidden = true;
    field("meta").textContent = "";
    field("map").hidden = false;
    field("map").textContent = "Explore sites on map";
    field("map").setAttribute("href", "../index.html");
  }

  function showBadge(badge, button) {
    badgesGrid.querySelectorAll(".badge-item.is-selected").forEach((el) => {
        el.classList.remove("is-selected");
    });

    if (button) button.classList.add("is-selected");

    field("tag").textContent = "Badge";
    field("title").textContent = badge.name || "Badge";
    field("desc").textContent = badge.description || "No description yet.";
    field("icon").src = iconSrc(badge.icon);

    const rarity = String(badge.rarity || "").trim();

    field("rarity-row").hidden = !rarity;
    field("rarity").textContent = rarity;

    field("meta").hidden = !badge.awarded_on;
    field("meta").textContent = badge.awarded_on
        ? `Collected on ${badge.awarded_on}`
        : "";

    field("map").hidden = true;
  } 

  
function renderEarnedBadges(badges) {
    const earnedBadges = badges.filter(badge => badge.earned);

    badgesCount.textContent = `${earnedBadges.length} earned`;
    badgesGrid.innerHTML = "";

    earnedBadges.forEach(badge => {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "badge-item unlocked";
        button.dataset.badgeKey = badge.id;

        // Badge circle
        const circle = document.createElement("span");
        circle.className = "badge-circle";

        // Badge icon
        const icon = iconSrc(badge.icon);

        if (icon) {
            const img = document.createElement("img");
            img.src = icon;
            img.alt = badge.name || "Badge";
            circle.appendChild(img);
        } else {
            circle.textContent = badge.emoji || "🏅";
        }

        // Badge name
        const label = document.createElement("span");
        label.className = "badge-label";
        label.textContent = badge.name || "Badge";

        // Make individual badges clickable
        button.append(circle, label);

        button.addEventListener("click", () => {
            showBadge(badge, button);
        });

        badgesGrid.appendChild(button);
    });
  }


  resetPreview();

  const account = window.GUIOAccount;
  const url = account?.apiUrl
    ? account.apiUrl("../api/passport.php")
    : "../api/passport.php";
  const headers = account?.apiHeaders
    ? account.apiHeaders({ Accept: "application/json" })
    : { Accept: "application/json" };

  fetch(url, { headers, cache: "no-store" })
    .then(async (response) => {
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Could not load badges.");
      renderEarnedBadges(data.badges);
    })
    .catch((error) => {
      console.error("Could not load badges:", error);
    });

  if (badgesCard) {
    badgesCard.addEventListener("click", (event) => {
      if (event.target.closest(".badge-item")) {
        event.preventDefault();
        const dialog = document.getElementById("dlg-stamp");
        if (dialog && typeof dialog.close === "function") dialog.close();
      }
    }, true);
  }
})();