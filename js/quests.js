(() => {
  const questGrid = document.getElementById("quest-grid");
  const currentContent = document.getElementById("current-quest-content");
  const currentStatus = document.getElementById("current-status");
  const countLabel = document.getElementById("quest-count");
  const filterContainer = document.getElementById("quest-filters");
  const categoryDescription = document.getElementById("category-description");
  const questDialog = document.getElementById("quest-dialog");
  const missionDialog = document.getElementById("mission-dialog");
  const scanButton = document.getElementById("scan-destination-qr");
  const qrVideo = document.getElementById("destination-qr-video");
  const qrStatus = document.getElementById("destination-qr-status");
  const newtownQuestion = document.getElementById("newtown-question");
  const newtownAnswerStatus = document.getElementById("newtown-answer-status");
  if (!questGrid || !currentContent || !filterContainer || !categoryDescription || !questDialog || !missionDialog) return;

  let selectedFilter = "all";
  let selectedQuest = null;
  let activeQuest = null;
  let questCatalog = [];
  let displayedQuests = [];
  let questCatalogStatus = "loading";
  let questCatalogError = "";
  let cameraStream = null;
  let scanFrame = null;
  let isVerifyingDestination = false;
  let selectedSpeakerStatement = "";

  const account = window.GUIOAccount;
  const hasDeviceIdentity = Boolean(account?.anonymousId);
  const ARRIVAL_RADIUS_METERS = 250;
  let userPosition = null;
  let gpsStatus = "checking";
  let gpsWatchId = null;

  function identityHeaders(extraHeaders = {}) {
    if (!account) throw new Error("This device's anonymous ID could not be initialized. Reload the page.");
    return account.apiHeaders(extraHeaders);
  }

  function element(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function categoryLabel(value) {
    const category = String(value || "").trim().toLowerCase().replace(/[\s-]+/g, "_");
    const labels = {
      cultural: "Cultural Quests",
      cultural_quests: "Cultural Quests",
      historical: "Historical Quests",
      historical_quests: "Historical Quests",
      nature: "Nature Quests",
      nature_quests: "Nature Quests",
      local_discovery: "Local Discovery Quests",
      local_discovery_quests: "Local Discovery Quests",
    };
    return labels[category] || (category ? categoryLabelFallback(category) : "Quest");
  }

  function categoryLabelFallback(category) {
    return category.replace(/_/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
  }

  function normaliseQuest(raw) {
    if (!raw || typeof raw !== "object") return null;
    const stops = Array.isArray(raw.stops)
      ? raw.stops.map((stop, index) => ({
          ...stop,
          title: stop.title || `Mission ${index + 1}`,
          state: stop.stop_state || stop.state,
        }))
      : [];
    const status = raw.quest_status || raw.status || "available";
    const progress = Math.max(0, Number(raw.progress_count) || 0);

    return {
      key: raw.quest_key || `quest-${raw.quest_id || "unknown"}`,
      questId: raw.quest_id || null,
      title: raw.title || "Untitled quest",
      description: raw.description || "Explore the city and complete this quest.",
      category: categoryLabel(raw.category || "quest"),
      questType: raw.quest_type || "site(s)",
      target: Math.max(0, Number(raw.target_count) || stops.length),
      icon: raw.icon || "⚑",
      stops,
      progress,
      status,
      isActive: status === "current",
      isDone: status === "done",
    };
  }

  function normaliseActiveQuest(raw) {
    if (!raw || typeof raw !== "object") return null;
    const rawKey = String(raw.quest_key || "").trim().toLowerCase();
    const rawTitle = String(raw.title || "").trim().toLowerCase();
    const rawSlug = rawKey.replace(/[-_]+/g, " ");
    const fallback = questCatalog.find((quest) => {
      const title = quest.title.toLowerCase();
      return quest.key.toLowerCase() === rawKey || title === rawTitle || title === rawSlug;
    });
    const target = Math.max(0, Number(raw.target_count) || Number(fallback?.target) || 0);
    const progress = Math.min(target, Math.max(0, Number(raw.progress_count) || 0));
    const stops = Array.isArray(raw.stops) && raw.stops.length
      ? raw.stops.map((stop, index) => ({
          ...stop,
          title: stop.title || `Mission ${index + 1}`,
          state: stop.stop_state || stop.state,
        }))
      : fallback?.stops || [];

    return {
      ...(fallback || {}),
      key: raw.quest_key || fallback?.key || `quest-${raw.quest_id || "active"}`,
      questId: raw.quest_id || null,
      userQuestId: raw.user_quest_id || null,
      title: raw.title || fallback?.title || "Your active quest",
      description: raw.description || fallback?.description || "Continue exploring to complete this quest.",
      category: raw.category
        ? categoryLabel(raw.category)
        : fallback?.category || categoryLabel("quest"),
      questType: raw.quest_type || fallback?.questType || "sites",
      target,
      progress,
      progressBeforeGps: progress,
      icon: raw.icon || fallback?.icon || "⚑",
      stops,
      status: "current",
      isActive: true,
      nextSiteId: stops.find((stop) => stop.state === "next")?.site_id || raw.next_site_id || null,
    };
  }

  function renderFilters() {
    const standardCategories = [
      { label: "Cultural Quests", description: "Discover local traditions, indigenous heritage, arts, and crafts." },
      { label: "Historical Quests", description: "Explore historically significant landmarks and learn their stories." },
      { label: "Nature Quests", description: "Discover parks, gardens, and environmentally significant destinations." },
      { label: "Local Discovery Quests", description: "Visit local businesses, artisan establishments, and community attractions." },
    ];
    const additionalCategories = [...new Set(questCatalog.map((quest) => quest.category).filter(Boolean))]
      .filter((category) => !standardCategories.some((known) => known.label.toLowerCase() === category.toLowerCase()))
      .map((label) => ({ label, description: `Browse quests in the ${label.toLowerCase()} category.` }));
    const categories = [...standardCategories, ...additionalCategories];
    const filters = [
      { value: "all", label: "All" },
      { value: "active", label: "Active" },
      { value: "completed", label: "Completed" },
      ...categories.map((category) => ({
        value: category.label.toLowerCase(),
        label: category.label,
        description: category.description,
      })),
    ];
    if (!filters.some((filter) => filter.value === selectedFilter)) selectedFilter = "all";

    filterContainer.replaceChildren();
    filters.forEach((filter) => {
      const button = element("button", `filter-chip${selectedFilter === filter.value ? " is-active" : ""}`, filter.label);
      button.type = "button";
      button.dataset.filter = filter.value;
      button.setAttribute("aria-pressed", String(selectedFilter === filter.value));
      if (filter.description) button.setAttribute("aria-label", `${filter.label}: ${filter.description}`);
      button.addEventListener("click", () => {
        selectedFilter = filter.value;
        renderFilters();
        renderCards();
      });
      filterContainer.append(button);
    });

    const selectedCategory = categories.find((category) => category.label.toLowerCase() === selectedFilter);
    categoryDescription.textContent = selectedCategory?.description || "";
    categoryDescription.hidden = !selectedCategory;
  }

  function getQuestStops(quest) {
    const stops = Array.isArray(quest.stops) ? quest.stops : [];
    if (stops.length) {
      let nextMarked = false;
      return stops.map((stop, index) => {
        let state = stop.state;
        if (!state) {
          if (quest.isActive && index < quest.progress) state = "done";
          else if (quest.isActive && !nextMarked) { state = "next"; nextMarked = true; }
          else state = "locked";
        }
        if (state === "next" && isNearStop(stop)) state = "arrived";
        if (state === "next") nextMarked = true;
        if (state === "arrived") nextMarked = true;
        return { ...stop, state };
      });
    }
    return [];
  }

  function isNearStop(stop) {
    if (
      !userPosition ||
      !Number.isFinite(userPosition.accuracy) ||
      !stop ||
      stop.latitude == null ||
      stop.longitude == null
    ) return false;
    const latitude = Number(stop.latitude);
    const longitude = Number(stop.longitude);
    if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return false;

    const radians = (degrees) => degrees * Math.PI / 180;
    const latitudeDifference = radians(latitude - userPosition.latitude);
    const longitudeDifference = radians(longitude - userPosition.longitude);
    const haversine = Math.sin(latitudeDifference / 2) ** 2
      + Math.cos(radians(userPosition.latitude))
      * Math.cos(radians(latitude))
      * Math.sin(longitudeDifference / 2) ** 2;
    const distance = 6371000 * 2 * Math.atan2(Math.sqrt(haversine), Math.sqrt(1 - haversine));
    return distance + userPosition.accuracy <= ARRIVAL_RADIUS_METERS;
  }

  function updateQuestProgressFromGps() {
    if (!activeQuest) return;
    const nextStop = activeQuest.stops.find((stop) =>
      (stop.stop_state || stop.state) === "next"
    );
    const arrived = Boolean(nextStop && isNearStop(nextStop));
    activeQuest.progress = Math.min(
      activeQuest.target,
      activeQuest.progressBeforeGps + (arrived ? 0.5 : 0)
    );
  }

  function syncDisplayedQuests() {
    displayedQuests = [...questCatalog];
    if (activeQuest) {
      const existingIndex = displayedQuests.findIndex((quest) =>
        quest.key === activeQuest.key || quest.title === activeQuest.title
      );
      if (existingIndex >= 0) displayedQuests[existingIndex] = { ...displayedQuests[existingIndex], ...activeQuest };
      else displayedQuests.unshift(activeQuest);
    }
  }

  function handleGpsPosition(position) {
    const wasAvailable = gpsStatus === "available";
    const previousProgress = activeQuest?.progress;
    userPosition = {
      latitude: position.coords.latitude,
      longitude: position.coords.longitude,
      accuracy: position.coords.accuracy,
    };
    gpsStatus = "available";
    updateQuestProgressFromGps();
    if (wasAvailable && previousProgress === activeQuest?.progress) return;
    syncDisplayedQuests();
    renderCurrentQuest();
    renderCards();
    if (activeQuest && questDialog.open && selectedQuest?.isActive) {
      selectedQuest = activeQuest;
      renderQuestDetails(activeQuest);
    }
    if (activeQuest && missionDialog.open && selectedQuest?.isActive) {
      selectedQuest = activeQuest;
      updateMissionGpsCopy();
    }
  }

  function startGpsTracking() {
    if (!navigator.geolocation) {
      gpsStatus = "unavailable";
      renderCurrentQuest();
      return;
    }

    gpsWatchId = navigator.geolocation.watchPosition(
      handleGpsPosition,
      () => {
        gpsStatus = "unavailable";
        userPosition = null;
        updateQuestProgressFromGps();
        syncDisplayedQuests();
        renderCurrentQuest();
        renderCards();
        if (activeQuest && questDialog.open && selectedQuest?.isActive) {
          selectedQuest = activeQuest;
          renderQuestDetails(activeQuest);
        }
        if (activeQuest && missionDialog.open && selectedQuest?.isActive) {
          selectedQuest = activeQuest;
          updateMissionGpsCopy();
        }
      },
      { enableHighAccuracy: true, maximumAge: 30000, timeout: 10000 }
    );
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
      const copy = hasDeviceIdentity
        ? "Choose a quest below to explore its route."
        : "This device's anonymous ID is unavailable. Enable browser storage and reload.";
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
    info.append(element("span", "quest-tag", activeQuest.category || "Quest"));
    const activeStops = getQuestStops(activeQuest);
    const next = activeStops.find((stop) => stop.state === "next");
    const arrived = activeStops.find((stop) => stop.state === "arrived");
    info.append(element("p", "", arrived
      ? `GPS confirms you're at ${arrived.title}. Complete the mission to finish it.`
      : next
        ? `Next location · ${next.title}`
        : activeQuest.description));
    if (!userPosition) {
      info.append(element("p", "gps-progress-note", gpsStatus === "unavailable"
        ? "Location unavailable. You can still complete missions by scanning their QR codes."
        : "Checking your location to update mission progress…"));
    }
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
      if (filter === "completed") return Boolean(quest.isDone);
      return String(quest.category || "").toLowerCase() === filter;
    });

    countLabel.textContent = `${filtered.length} ${filtered.length === 1 ? "route" : "routes"}`;
    questGrid.replaceChildren();
    if (!filtered.length) {
      const message = questCatalogStatus === "loading"
        ? "Loading quests from the server..."
        : questCatalogStatus === "error"
          ? questCatalogError
          : filter === "all"
            ? "No quests are available right now."
            : filter === "completed"
              ? "No completed quests yet."
              : "No quests in this category yet. Try another filter.";
      questGrid.append(element("p", "empty-results", message));
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
      heading.append(element("span", quest.isActive ? "active-tag" : "quest-tag", quest.isActive ? "Current" : quest.isDone ? "Done" : "Available"));
      content.append(heading);
      content.append(element("span", "quest-card-description", quest.description));
      const meta = element("span", "quest-card-meta");
      meta.append(element("span", "quest-tag", quest.category || "Quest"));
      meta.append(element("span", "quest-tag", `${quest.target || quest.stops?.length || 0} mission/s`));
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

  function renderQuestDetails(quest) {
    const stops = getQuestStops(quest);
    const title = document.getElementById("dialog-quest-title");
    const description = document.getElementById("dialog-quest-description");
    const nextLocation = document.getElementById("dialog-quest-next-location");
    const tags = document.getElementById("dialog-tags");
    const progressCount = document.getElementById("dialog-progress-count");
    const progressFill = document.getElementById("dialog-progress-fill");
    const missionList = document.getElementById("dialog-missions");

    title.textContent = quest.title;
    description.textContent = quest.description;
    const currentStop = stops.find((stop) => stop.state === "next" || stop.state === "arrived");
    nextLocation.hidden = !quest.isActive || !currentStop;
    nextLocation.textContent = currentStop ? `Next location: ${currentStop.title}` : "";
    tags.replaceChildren(element("span", "quest-tag", quest.category || "Quest"));
    tags.append(element(
      quest.isActive ? "active-tag" : "quest-tag",
      "",
      quest.isActive ? "Current" : quest.isDone ? "Done" : "Available"
    ));
    progressCount.textContent = quest.isActive
      ? `${quest.progress} of ${quest.target}`
      : `${quest.target || stops.length} missions`;
    document.getElementById("dialog-progress-label").textContent = "Quest Progress";
    const percent = quest.isActive && quest.target ? Math.min(100, (quest.progress / quest.target) * 100) : 0;
    progressFill.style.width = `${percent}%`;
    document.getElementById("dialog-mission-total").textContent = `${stops.length || quest.target || 0} total`;

    missionList.replaceChildren();
    if (!stops.length) {
      missionList.append(element("li", "", "Mission stops will appear here when this quest is active."));
    } else {
      stops.forEach((stop, index) => {
        const state = stop.state || (quest.isActive && index < quest.progress ? "done" : "locked");
        const item = element("li", `is-${state}`);
        item.append(element("span", "mission-state", state === "done" ? "✓" : state === "arrived" ? "½" : String(index + 1)));
        const name = element("span", "mission-name", stop.title);
        const label = state === "done"
          ? "Mission complete"
          : state === "arrived"
            ? "At destination · mission incomplete"
            : state === "next"
              ? "Current mission"
              : "To be visited";
        name.append(element("span", "mission-subtitle", label));
        item.append(name, element("span", "mission-chevron", state === "locked" ? "·" : "›"));
        if (quest.key === "baguio-discover-newtown" && state !== "done") {
          const question = element("div", "mission-speaker-question");
          question.append(element("strong", "", "Answer the question raised by the speaker:"));
          const choices = element("div", "mission-speaker-choices");
          ["A", "B"].forEach((statement) => {
            const button = element("button", "speaker-choice-button", `Statement ${statement}`);
            button.type = "button";
            button.dataset.speakerStatement = statement;
            button.setAttribute("aria-pressed", String(selectedSpeakerStatement === statement));
            button.addEventListener("click", () => {
              selectedSpeakerStatement = statement;
              updateNewtownQuestion();
            });
            choices.append(button);
          });
          question.append(choices);
          item.append(question);
        }
        missionList.append(item);
      });
    }

    const openMissionButton = document.getElementById("open-mission");
    const incompleteMessage = document.getElementById("dialog-incomplete-message");
    incompleteMessage.hidden = quest.isDone;
    openMissionButton.textContent = quest.isActive
      ? "Go to current destination"
      : quest.isDone
        ? "Quest complete"
        : hasDeviceIdentity
          ? "Start quest"
          : "Device ID unavailable";
    openMissionButton.disabled = quest.isDone || (!hasDeviceIdentity && !quest.isActive);
  }

  function openQuest(quest) {
    selectedQuest = quest;
    renderQuestDetails(quest);
    questDialog.showModal();
  }

  function updateMissionGpsCopy() {
    const stops = getQuestStops(selectedQuest);
    const arrived = stops.find((stop) => stop.state === "arrived");
    const mission = stops.find((stop) => stop.state === "next" || stop.state === "arrived");
    if (!mission) return;

    document.getElementById("mission-tags").replaceChildren(
      element("span", "quest-tag", selectedQuest.category || "Quest"),
      element("span", "quest-tag", arrived ? "At destination" : "Current mission")
    );
    document.getElementById("mission-description").textContent = arrived
      ? "GPS confirms you're at this destination. Scan the focal person's QR code to complete the mission."
      : "Visit this destination and scan its QR code provided by the focal person.";
    document.getElementById("mission-reward-copy").textContent = arrived
      ? "You have earned halfway progress for this mission. Scan its QR code to complete it."
      : "The focal person’s QR code verifies this destination.";
  }

  function updateNewtownQuestion() {
    const isNewtownMission = selectedQuest?.key === "baguio-discover-newtown";
    newtownQuestion.hidden = !isNewtownMission;
    document.querySelectorAll("[data-speaker-statement]").forEach((button) => {
      button.setAttribute(
        "aria-pressed",
        String(button.dataset.speakerStatement === selectedSpeakerStatement)
      );
    });
    if (!isNewtownMission) return;

    newtownAnswerStatus.textContent = selectedSpeakerStatement
      ? `Statement ${selectedSpeakerStatement} selected. Scan the Newtown QR code to complete the mission.`
      : "Choose a statement, then scan the Newtown QR code to complete the mission.";
  }

  function stopQrCamera() {
    if (scanFrame !== null) {
      window.cancelAnimationFrame(scanFrame);
      scanFrame = null;
    }
    if (cameraStream) {
      cameraStream.getTracks().forEach((track) => track.stop());
      cameraStream = null;
    }
    if (qrVideo) {
      qrVideo.pause();
      qrVideo.srcObject = null;
      qrVideo.hidden = true;
    }
  }

  function qrTokenFromValue(value) {
    const rawValue = String(value || "").trim();
    if (!rawValue) return "";
    try {
      const url = new URL(rawValue);
      return url.searchParams.get("token") || rawValue;
    } catch {
      return rawValue;
    }
  }

  async function verifyDestinationQr(rawValue) {
    if (!hasDeviceIdentity || !activeQuest || isVerifyingDestination) return;
    const qrToken = qrTokenFromValue(rawValue);
    if (!qrToken) {
      qrStatus.textContent = "Scan a destination QR code.";
      return;
    }

    isVerifyingDestination = true;
    scanButton.disabled = true;
    qrStatus.textContent = "Verifying destination code…";
    try {
      const url = new URL("../api/quests.php", window.location.href);
      const response = await fetch(url, {
        method: "POST",
        headers: identityHeaders({ "Content-Type": "application/json", Accept: "application/json" }),
        body: JSON.stringify({ action: "verify_destination", qr_token: qrToken }),
      });
      const payload = await response.json();
      if (!response.ok || payload.status !== "success") {
        throw new Error(payload.error || "This destination code could not be verified.");
      }
      stopQrCamera();
      stopQrCamera();
      const badgeMessage = payload.badge_awarded?.name
        ? ` You earned the ${payload.badge_awarded.name} badge!`
        : "";
      qrStatus.textContent = payload.quest_status === "done"
        ? (payload.awarded_badge
            ? `Quest complete! You earned the ${payload.awarded_badge.name} badge.`
            : "Quest complete! You finished every destination.")
        : "Destination verified. Your next mission is now current.";
      await loadQuestCatalog();
      if (payload.quest_status === "done") {
        missionDialog.close();
        return;
      }
      if (activeQuest) {
        selectedQuest = activeQuest;
        missionDialog.close();
        openMission();
      }
    } catch (error) {
      qrStatus.textContent = error.message || "This destination code could not be verified.";
    } finally {
      isVerifyingDestination = false;
      scanButton.disabled = false;
    }
  }

  async function startQrCamera() {
    if (typeof window.BarcodeDetector !== "function") {
      qrStatus.textContent = "QR scanning isn't supported by this browser.";
      return;
    }
    if (!navigator.mediaDevices?.getUserMedia) {
      qrStatus.textContent = "Camera access is unavailable.";
      return;
    }

    stopQrCamera();
    try {
      const detector = new window.BarcodeDetector({ formats: ["qr_code"] });
      cameraStream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: { facingMode: { ideal: "environment" } },
      });
      qrVideo.srcObject = cameraStream;
      qrVideo.hidden = false;
      await qrVideo.play();
      qrStatus.textContent = "Point your camera at the destination QR code.";

      const scan = async () => {
        if (!cameraStream || missionDialog.open === false) return;
        try {
          const codes = await detector.detect(qrVideo);
          if (codes.length && codes[0].rawValue) {
            stopQrCamera();
            await verifyDestinationQr(codes[0].rawValue);
            return;
          }
        } catch (error) {
          qrStatus.textContent = "Could not read the QR code. Try scanning again.";
          stopQrCamera();
          return;
        }
        scanFrame = window.requestAnimationFrame(scan);
      };
      scanFrame = window.requestAnimationFrame(scan);
    } catch (error) {
      stopQrCamera();
      qrStatus.textContent = error.name === "NotAllowedError"
        ? "Allow camera access to scan the destination QR code."
        : "The camera couldn't be started.";
    }
  }

  async function openMission() {
    if (!selectedQuest) return;
    if (!selectedQuest.isActive && !selectedQuest.isDone) {
      if (!hasDeviceIdentity) return;
      const startButton = document.getElementById("open-mission");
      startButton.disabled = true;
      try {
        const url = new URL("../api/quests.php", window.location.href);
        const response = await fetch(url, {
          method: "POST",
          headers: identityHeaders({ "Content-Type": "application/json", Accept: "application/json" }),
          body: JSON.stringify({ quest_key: selectedQuest.key }),
        });
        const payload = await response.json();
        if (!response.ok || !payload.active_quest) {
          const error = new Error(payload.error || "This quest could not be started.");
          error.code = payload.code || "";
          throw error;
        }

        activeQuest = normaliseActiveQuest(payload.active_quest);
        try {
          localStorage.setItem("guio-active-quest-updated", String(Date.now()));
        } catch (storageError) {
          console.warn("Could not notify the map about the active quest.", storageError);
        }
        await loadQuestCatalog();
        selectedQuest = activeQuest || normaliseQuest(payload.active_quest);
        questDialog.close();
        openQuest(selectedQuest);
      } catch (error) {
        console.error("Could not start quest:", error);
        startButton.disabled = false;
        if (error.code === "database_unavailable" && selectedQuest.key === "baguio-discover-newtown") {
          startButton.textContent = "Start quest";
          document.getElementById("dialog-incomplete-message").hidden = false;
        } else {
          startButton.textContent = error.message || "Quest could not be started";
        }
        return;
      }
    }

    if (selectedQuest.isDone) return;
    const stops = getQuestStops(selectedQuest);
    const nextIndex = stops.findIndex((stop) => stop.state === "next" || stop.state === "arrived");
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
      ? "Visit this destination and scan its QR code provided by the focal person."
      : "Preview this route and browse its nearby stops on the map.";
    document.getElementById("mission-reward-copy").textContent = selectedQuest.isActive
      ? "The focal person’s QR code verifies this destination."
      : "Start the quest to unlock its first destination.";

    scanButton.hidden = !selectedQuest.isActive;
    qrStatus.textContent = selectedQuest.isActive
      ? "Scan the QR code at this destination."
      : "Start the quest to scan destination codes.";
    stopQrCamera();
    updateNewtownQuestion();
    if (selectedQuest.isActive) updateMissionGpsCopy();

    questDialog.close();
    missionDialog.showModal();
  }

  async function loadQuestCatalog() {
    try {
      const url = new URL("../api/quests.php", window.location.href);
      const response = await fetch(url, {
        headers: identityHeaders({ Accept: "application/json" }),
        cache: "no-store",
      });
      if (!response.headers.get("content-type")?.includes("application/json")) {
        throw new Error("The MySQL quest API did not return JSON. Check that the PHP endpoint is running.");
      }
      const payload = await response.json();
      if (!response.ok || !Array.isArray(payload.quests)) {
        throw new Error(payload.error || "Quest catalog is unavailable.");
      }
      questCatalog = payload.quests.map(normaliseQuest).filter(Boolean);
      activeQuest = normaliseActiveQuest(payload.active_quest);
      updateQuestProgressFromGps();
      questCatalogStatus = "loaded";
      questCatalogError = "";
    } catch (error) {
      console.warn("Could not load quest catalog:", error);
      questCatalog = [];
      activeQuest = null;
      questCatalogStatus = "error";
      questCatalogError = error instanceof Error ? error.message : "The quest database could not be reached.";
    }

    syncDisplayedQuests();
    renderFilters();
    renderCurrentQuest();
    renderCards();
  }

  document.querySelector("[data-close-quest]").addEventListener("click", () => questDialog.close());
  document.querySelector("[data-close-mission]").addEventListener("click", () => {
    stopQrCamera();
    missionDialog.close();
  });
  document.querySelector("[data-back-quest]").addEventListener("click", () => {
    stopQrCamera();
    missionDialog.close();
    window.setTimeout(() => questDialog.showModal(), 0);
  });
  document.getElementById("open-mission").addEventListener("click", openMission);
  scanButton.addEventListener("click", startQrCamera);
  newtownQuestion.querySelectorAll("[data-speaker-statement]").forEach((button) => {
    button.addEventListener("click", () => {
      selectedSpeakerStatement = button.dataset.speakerStatement;
      updateNewtownQuestion();
    });
  });
  missionDialog.addEventListener("close", stopQrCamera);
  window.addEventListener("pagehide", () => {
    if (gpsWatchId !== null) navigator.geolocation.clearWatch(gpsWatchId);
  });
  renderFilters();
  startGpsTracking();
  loadQuestCatalog();
})();


/* =========================================================
   NEWTOWN SPEAKER QUESTION
   Correct answer: Statement B
   Completing Statement B completes the quest (1/1)
   and clears the current quest.
   ========================================================= */

(() => {
  "use strict";

  
  const questionSection = document.getElementById("newtown-question");
  const answerStatus = document.getElementById("newtown-answer-status");
  const statementButtons = document.querySelectorAll("[data-speaker-statement]");

  if (!questionSection || !answerStatus || !statementButtons.length) {
    return;
  }

  let answeredCorrectly = false;

  statementButtons.forEach((button) => {
    button.addEventListener("click", async () => {
      // Prevent multiple successful submissions
      if (answeredCorrectly) return;

      const selectedStatement = button.dataset.speakerStatement;

      statementButtons.forEach((option) => {
        option.setAttribute("aria-pressed", "false");
        option.classList.remove("is-correct", "is-incorrect");
      });

      button.setAttribute("aria-pressed", "true");

      // Statement A: Incorrect
      if (selectedStatement !== "B") {
        button.classList.add("is-incorrect");

        answerStatus.textContent =
          "Incorrect. Try again and choose Statement B.";

        answerStatus.classList.add("is-incorrect");
        answerStatus.classList.remove("is-correct");

        questionSection.dataset.answered = "false";
        questionSection.dataset.correct = "false";

        return;
      }

      // Statement B: Correct
      answeredCorrectly = true;

      button.classList.add("is-correct");

      answerStatus.textContent =
        "Correct! Statement B is valid. Mission completed!";

      answerStatus.classList.add("is-correct");
      answerStatus.classList.remove("is-incorrect");

      questionSection.dataset.answered = "true";
      questionSection.dataset.correct = "true";

      // Update mission progress to 1/1
      const progressLabel = document.getElementById("dialog-progress-label");
      const progressCount = document.getElementById("dialog-progress-count");
      const progressFill = document.getElementById("dialog-progress-fill");
      const missionTotal = document.getElementById("dialog-mission-total");

      if (progressLabel) {
        progressLabel.textContent = "Missions completed";
      }

      if (progressCount) {
        progressCount.textContent = "1/1";
      }

      if (progressFill) {
        progressFill.style.width = "100%";
        progressFill.setAttribute("aria-valuenow", "100");
      }

      if (missionTotal) {
        missionTotal.textContent = "1/1 completed";
      }

      // Mark the mission as completed visually
      const missionTitle = document.getElementById("mission-title");
      if (missionTitle) {
        missionTitle.textContent += " ✓";
      }

      // Update quest dialog action
      const openMissionButton = document.getElementById("open-mission");
      if (openMissionButton) {
        openMissionButton.textContent = "Quest completed!";
        openMissionButton.disabled = true;
      }

      // Clear the current quest section
      const currentQuestContent = document.getElementById(
        "current-quest-content"
      );

      const currentStatus = document.getElementById("current-status");

      if (currentQuestContent) {
        currentQuestContent.innerHTML = `
          <div class="empty-current-quest">
            <p>No current quest.</p>
            <p>Choose an available quest to begin your next adventure!</p>
          </div>
        `;
      }

      if (currentStatus) {
        currentStatus.textContent = "Ready";
      }

      // Close mission and quest dialogs after a short delay
      setTimeout(() => {
        const missionDialog = document.getElementById("mission-dialog");
        const questDialog = document.getElementById("quest-dialog");

        if (missionDialog?.open) {
          missionDialog.close();
        }

        if (questDialog?.open) {
          questDialog.close();
        }
      }, 1800);
    });
  });
})();
