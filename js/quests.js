(() => {
  const sampleQuests = [
    {
      key: "burnham-secrets-walk",
      title: "Burnham Secrets Walk",
      description: "Explore lesser-known heritage spots around Burnham Park, discover Baguio’s living culture through weavers, local markets, and historic corners of the beaten path.",
      category: "Heritage",
      distance: "1.2 km",
      target: 5,
      xp: 500,
      badge: "Heritage Buff",
      icon: "⚑",
      stops: [
        { title: "Baguio Craft Market" },
        { title: "Burnham Park Gallery" },
        { title: "Ibali Weavers Studio" },
        { title: "Good Taste Cafe" },
        { title: "Baguio Museum" },
      ],
    },
    {
      key: "baguio-artisan-circuit",
      title: "Baguio Artisan Circuit",
      description: "Meet local makers and find the craft traditions woven through the city’s studios and markets.",
      category: "Art",
      distance: "0.8 km",
      target: 4,
      xp: 400,
      badge: "Local Craft",
      icon: "✳",
      stops: [
        { title: "Baguio Craft Market" },
        { title: "Ibali Weavers Studio" },
        { title: "Cordillera Gallery" },
        { title: "Artists’ Village" },
      ],
    },
    {
      key: "morning-market-flavours",
      title: "Morning Market Flavours",
      description: "Follow the early market bustle and sample the everyday flavours loved by Baguio locals.",
      category: "Food",
      distance: "0.5 km",
      target: 3,
      xp: 300,
      badge: "Food Trail",
      icon: "⌂",
      stops: [
        { title: "Baguio Public Market" },
        { title: "Good Taste Cafe" },
        { title: "Hilltop Produce Stalls" },
      ],
    },
  ];

  const questGrid = document.getElementById("quest-grid");
  const currentContent = document.getElementById("current-quest-content");
  const currentStatus = document.getElementById("current-status");
  const countLabel = document.getElementById("quest-count");
  const questDialog = document.getElementById("quest-dialog");
  const missionDialog = document.getElementById("mission-dialog");
  if (!questGrid || !currentContent || !questDialog || !missionDialog) return;

  let selectedFilter = "all";
  let selectedQuest = null;
  let activeQuest = null;
  let displayedQuests = [...sampleQuests];

  function getUsername() {
    const params = new URLSearchParams(window.location.search);
    const urlUser = params.get("user");
    try {
      if (urlUser !== null) {
        const value = urlUser.trim();
        if (value) window.sessionStorage.setItem("tourtrail-active-username", value);
        else window.sessionStorage.removeItem("tourtrail-active-username");
        return value;
      }
      return (window.sessionStorage.getItem("tourtrail-active-username") || "").trim();
    } catch {
      return (urlUser || "").trim();
    }
  }

  const username = getUsername();

  function addUserToLinks() {
    if (!username) return;
    document.querySelectorAll('a[href$=".html"]').forEach((link) => {
      const url = new URL(link.href, window.location.href);
      if (url.origin === window.location.origin) {
        url.searchParams.set("user", username);
        link.href = url.href;
      }
    });
  }

  function element(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function normaliseActiveQuest(raw) {
    if (!raw || typeof raw !== "object") return null;
    const rawKey = String(raw.quest_key || "").trim().toLowerCase();
    const rawTitle = String(raw.title || "").trim().toLowerCase();
    const rawSlug = rawKey.replace(/[-_]+/g, " ");
    const fallback = sampleQuests.find((quest) => {
      const title = quest.title.toLowerCase();
      return quest.key.toLowerCase() === rawKey || title === rawTitle || title === rawSlug;
    });
    const target = Math.max(0, Number(raw.target_count) || Number(fallback?.target) || 0);
    const progress = Math.min(target, Math.max(0, Number(raw.progress_count) || 0));
    const stops = Array.isArray(raw.stops) && raw.stops.length
      ? raw.stops.map((stop, index) => ({
          ...stop,
          title: stop.title || `Mission ${index + 1}`,
          state: stop.stop_state || "pending",
        }))
      : fallback?.stops || [];

    return {
      ...(fallback || {}),
      key: raw.quest_key || fallback?.key || `quest-${raw.quest_id || "active"}`,
      questId: raw.quest_id || null,
      userQuestId: raw.user_quest_id || null,
      title: raw.title || fallback?.title || "Your active quest",
      description: raw.description || fallback?.description || "Continue exploring to complete this quest.",
      category: raw.quest_type === "streak" ? "Active" : (fallback?.category || "Heritage"),
      target,
      progress,
      xp: Math.max(0, Number(raw.xp_reward) || Number(fallback?.xp) || 0),
      badge: raw.reward_badge_name || fallback?.badge || "Quest reward",
      icon: raw.icon || fallback?.icon || "⚑",
      stops,
      isActive: true,
      nextSiteId: stops.find((stop) => stop.state === "next")?.site_id || raw.next_site_id || null,
    };
  }

  function getQuestStops(quest) {
    const stops = Array.isArray(quest.stops) ? quest.stops : [];
    if (stops.length) {
      let nextMarked = false;
      return stops.map((stop, index) => {
        let state = stop.state;
        if (!state) {
          if (quest.isActive && index < quest.progress) state = "done";
          else if (!nextMarked) { state = "next"; nextMarked = true; }
          else state = "locked";
        }
        if (state === "next") nextMarked = true;
        return { ...stop, state };
      });
    }
    return [];
  }

  function renderCurrentQuest() {
    currentContent.replaceChildren();
    if (!activeQuest) {
      currentStatus.textContent = "No active quest";
      currentStatus.classList.remove("is-active");
      const empty = element("div", "current-empty");
      const icon = element("span", "quest-emblem", "⚑");
      icon.setAttribute("aria-hidden", "true");
      const content = element("div", "current-quest-info");
      content.append(element("h3", "", "No active quests"));
      const copy = username
        ? "Choose a featured trail below to explore its route."
        : "Select an account to load your progress. You can preview the featured trails below.";
      content.append(element("p", "", copy));
      empty.append(icon, content);
      currentContent.append(empty);
      return;
    }

    currentStatus.textContent = "In progress";
    currentStatus.classList.add("is-active");
    const row = element("div", "current-quest");
    const icon = element("span", "quest-emblem", activeQuest.icon || "⚑");
    icon.setAttribute("aria-hidden", "true");
    const info = element("div", "current-quest-info");
    info.append(element("h3", "", activeQuest.title));
    const next = getQuestStops(activeQuest).find((stop) => stop.state === "next");
    info.append(element("p", "", next ? `Next stop · ${next.title}` : activeQuest.description));
    const actions = element("div", "current-quest-actions");
    actions.append(element("span", "progress-count", `${activeQuest.progress} / ${activeQuest.target}`));
    const button = element("button", "text-button", "View details");
    button.type = "button";
    button.addEventListener("click", () => openQuest(activeQuest));
    actions.append(button);
    row.append(icon, info, actions);
    currentContent.append(row);
  }

  function renderCards() {
    const filter = selectedFilter;
    const filtered = displayedQuests.filter((quest) => {
      if (filter === "all") return true;
      if (filter === "active") return Boolean(quest.isActive);
      return String(quest.category || "").toLowerCase() === filter;
    });

    countLabel.textContent = `${filtered.length} ${filtered.length === 1 ? "route" : "routes"}`;
    questGrid.replaceChildren();
    if (!filtered.length) {
      questGrid.append(element("p", "empty-results", "No quests in this category yet. Try another filter."));
      return;
    }

    filtered.forEach((quest) => {
      const card = element("button", `quest-card${quest.isActive ? " is-current" : ""}`);
      card.type = "button";
      card.setAttribute("aria-label", `View ${quest.title} quest details`);
      const icon = element("span", "quest-card-icon", quest.icon || "⚑");
      icon.setAttribute("aria-hidden", "true");
      const content = element("span", "quest-card-content");
      const heading = element("span", "quest-card-heading");
      heading.append(element("span", "", quest.title));
      if (quest.isActive) heading.append(element("span", "active-tag", "Active"));
      content.append(heading);
      content.append(element("span", "quest-card-description", quest.description));
      const meta = element("span", "quest-card-meta");
      meta.append(element("span", "quest-tag", quest.category || "Quest"));
      meta.append(element("span", "quest-tag", `${quest.target || quest.stops?.length || 0} missions`));
      if (quest.distance) meta.append(element("span", "quest-tag", quest.distance));
      content.append(meta);
      if (quest.isActive) {
        const progress = element("span", "progress-count", `${quest.progress} / ${quest.target}`);
        content.append(progress);
      }
      card.append(icon, content, element("span", "quest-card-arrow", "›"));
      card.addEventListener("click", () => openQuest(quest));
      questGrid.append(card);
    });
  }

  function openQuest(quest) {
    selectedQuest = quest;
    const stops = getQuestStops(quest);
    const title = document.getElementById("dialog-quest-title");
    const description = document.getElementById("dialog-quest-description");
    const tags = document.getElementById("dialog-tags");
    const progressCount = document.getElementById("dialog-progress-count");
    const progressFill = document.getElementById("dialog-progress-fill");
    const rewardTitle = document.getElementById("dialog-reward-title");
    const rewardCopy = document.getElementById("dialog-reward-copy");
    const missionList = document.getElementById("dialog-missions");

    title.textContent = quest.title;
    description.textContent = quest.description;
    tags.replaceChildren(element("span", "quest-tag", quest.category || "Quest"));
    if (quest.isActive) tags.append(element("span", "active-tag", "Active"));
    progressCount.textContent = quest.isActive
      ? `${quest.progress} of ${quest.target}`
      : `${quest.target || stops.length} missions`;
    document.getElementById("dialog-progress-label").textContent = quest.isActive ? "Quest progress" : "Route length";
    const percent = quest.isActive && quest.target ? Math.min(100, (quest.progress / quest.target) * 100) : 0;
    progressFill.style.width = `${percent}%`;
    rewardTitle.textContent = quest.isActive ? `+${quest.xp} XP · ${quest.badge}` : `Up to +${quest.xp} XP`;
    rewardCopy.textContent = quest.isActive ? "Quest reward" : "Earn XP as you complete the trail.";
    document.getElementById("dialog-mission-total").textContent = `${stops.length || quest.target || 0} total`;

    missionList.replaceChildren();
    if (!stops.length) {
      missionList.append(element("li", "", "Mission stops will appear here when this quest is active."));
    } else {
      stops.forEach((stop, index) => {
        const state = stop.state || (quest.isActive && index < quest.progress ? "done" : "locked");
        const item = element("li", `is-${state}`);
        item.append(element("span", "mission-state", state === "done" ? "✓" : String(index + 1)));
        const name = element("span", "mission-name", stop.title);
        const label = state === "done" ? "Visited" : state === "next" ? "Next mission" : `Locked until mission ${index}`;
        name.append(element("span", "mission-subtitle", label));
        item.append(name, element("span", "mission-chevron", state === "locked" ? "·" : "›"));
        missionList.append(item);
      });
    }

    const openMissionButton = document.getElementById("open-mission");
    openMissionButton.textContent = quest.isActive ? "Go to next mission" : "Preview route";
    questDialog.showModal();
  }

  function openMission() {
    if (!selectedQuest) return;
    const stops = getQuestStops(selectedQuest);
    const nextIndex = stops.findIndex((stop) => stop.state === "next");
    const mission = nextIndex >= 0 ? stops[nextIndex] : stops[0];
    const title = mission?.title || "Explore the next stop";
    document.getElementById("mission-title").textContent = title;
    document.getElementById("mission-tags").replaceChildren(
      element("span", "quest-tag", selectedQuest.category || "Quest"),
      element("span", "quest-tag", selectedQuest.isActive ? "Current mission" : "Route preview")
    );
    document.getElementById("mission-location").textContent = mission
      ? `Mission ${Math.max(0, nextIndex >= 0 ? nextIndex : 0) + 1} of ${stops.length || selectedQuest.target || 1}`
      : "Explore nearby stops on the map";
    document.getElementById("mission-description").textContent = selectedQuest.isActive
      ? "Visit this stop and check in to continue your quest."
      : "Preview this route and browse its nearby stops on the map.";
    document.getElementById("mission-reward-copy").textContent = selectedQuest.isActive
      ? `Part of the +${selectedQuest.xp} XP ${selectedQuest.badge} quest reward.`
      : `Earn up to +${selectedQuest.xp} XP by completing the trail.`;

    const checkin = document.getElementById("mission-checkin");
    checkin.textContent = selectedQuest.isActive ? "Check in here" : "Browse nearby sites";
    const targetPath = selectedQuest.isActive ? "camera.html" : "../index.html";
    const url = new URL(targetPath, window.location.href);
    if (selectedQuest.isActive && mission?.site_id) url.searchParams.set("siteId", mission.site_id);
    if (username) url.searchParams.set("user", username);
    checkin.href = url.href;

    questDialog.close();
    missionDialog.showModal();
  }

  function renderFromProfile(profile) {
    activeQuest = normaliseActiveQuest(profile?.active_quest);
    displayedQuests = [...sampleQuests];
    if (activeQuest) {
      const existingIndex = displayedQuests.findIndex((quest) => quest.key === activeQuest.key || quest.title === activeQuest.title);
      if (existingIndex >= 0) displayedQuests[existingIndex] = { ...displayedQuests[existingIndex], ...activeQuest };
      else displayedQuests.unshift(activeQuest);
    }
    renderCurrentQuest();
    renderCards();
  }

  async function loadQuestProgress() {
    if (!username) {
      renderFromProfile(null);
      return;
    }
    try {
      const url = new URL("../api/passport.php", window.location.href);
      url.searchParams.set("user", username);
      const response = await fetch(url, { headers: { Accept: "application/json" }, cache: "no-store" });
      const profile = await response.json();
      if (!response.ok || !profile.user) throw new Error(profile.error || "Quest progress is unavailable.");
      renderFromProfile(profile);
    } catch (error) {
      console.warn("Could not load quest progress:", error);
      renderFromProfile(null);
      currentContent.querySelector(".current-empty p").textContent = "Quest progress is unavailable right now. You can still preview the featured trails.";
    }
  }

  document.querySelectorAll(".filter-chip").forEach((button) => {
    button.addEventListener("click", () => {
      selectedFilter = button.dataset.filter || "all";
      document.querySelectorAll(".filter-chip").forEach((chip) => {
        const selected = chip === button;
        chip.classList.toggle("is-active", selected);
        chip.setAttribute("aria-pressed", String(selected));
      });
      renderCards();
    });
  });

  document.querySelector("[data-close-quest]").addEventListener("click", () => questDialog.close());
  document.querySelector("[data-close-mission]").addEventListener("click", () => missionDialog.close());
  document.querySelector("[data-back-quest]").addEventListener("click", () => {
    missionDialog.close();
    window.setTimeout(() => questDialog.showModal(), 0);
  });
  document.getElementById("open-mission").addEventListener("click", openMission);
  addUserToLinks();
  loadQuestProgress();
})();
