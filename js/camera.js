(() => {
  // Keep this script's variables and functions private to the camera page.
  "use strict";

  // Keep the camera page's state private so it cannot collide with other scripts.

  // The browser and server both enforce this radius; server verification remains authoritative.
  const CHECK_IN_RADIUS_METERS = 250;
  // Successful nearby-site responses are kept locally to show a fallback when offline.
  const SITE_CACHE_KEY = "tourtrail-sites-cache";
  // Passport endpoint used to refresh the active quest after a check-in.
  const PASSPORT_API_URL = "api/passport.php";
  // A siteId query parameter makes the camera verify against a specific map site.
  const selectedSiteId = new URLSearchParams(window.location.search).get("siteId");
  // Cache page elements once so update functions can safely reuse the same controls.
  const elements = {
    // Main camera preview panel.
    panel: document.querySelector(".camera-panel"),
    // Live camera feed and captured-photo preview.
    video: document.getElementById("camera-feed"),
    capturedPhoto: document.getElementById("captured-photo"),
    // GPS status shown over the camera preview.
    gpsBadge: document.getElementById("gps-badge"),
    gpsBadgeText: document.getElementById("gps-badge-text"),
    // Nearby-site card details.
    rangeTag: document.getElementById("range-tag"),
    siteName: document.getElementById("site-name"),
    siteType: document.getElementById("site-type"),
    // Camera messages and retry controls.
    previewCaption: document.getElementById("preview-caption"),
    cameraRetry: document.getElementById("camera-retry"),
    verifyRetry: document.getElementById("verify-retry"),
    captureButton: document.getElementById("capture-button"),
    photoMode: document.getElementById("photo-mode"),
    qrMode: document.getElementById("qr-mode"),
    qrResult: document.getElementById("qr-result"),
    qrResultText: document.getElementById("qr-result-text"),
    qrRescan: document.getElementById("qr-rescan"),
    earnStampButton: document.getElementById("earn-stamp-button"),
    // Nearby-site stamp reward text.
    rewardTitle: document.getElementById("reward-title"),
    rewardDescription: document.getElementById("reward-description"),
    recentCheckIns: document.getElementById("recent-checkins-list"),
    // Three progress indicators for photo, verification, and reward.
    steps: [
      document.getElementById("step-photo"),
      document.getElementById("step-proof"),
      document.getElementById("step-verify"),
    ],
    // Popup shown after a check-in finishes.
    dialog: document.getElementById("checkin-dialog"),
  };

  // Media state controls preview and stream cleanup.
  // Browser stream used by the live preview and photo capture.
  let cameraStream = null;
  let cameraMode = "photo";
  let qrDetector = null;
  let qrScanning = false;
  let qrAnimationFrame = null;
  // Location and site state drive the distance display and check-in eligibility.
  // Watch handle is cleared when the page is closed.
  let locationWatch = null;
  // Latest GPS fix, nearby site, and whether the user is close enough to check in.
  let currentPosition = null;
  let nearestSite = null;
  let isInRange = false;
  // Operation flags prevent capture, verification, and rewards from overlapping.
  // Button states are recalculated from these flags.
  let cameraReady = false;
  let capturing = false;
  let verifying = false;
  let awarding = false;
  // These values represent the current photo's progress through check-in.
  // verifiedSite is set only after the location is confirmed.
  let pendingPhoto = null;
  let queuedPhotoId = null;
  let verifiedSite = null;
  let checkInComplete = false;
  let completionVerified = false;
  // Recent verified check-ins are maintained for the small history list.
  // New entries are combined with this list before display.
  let recentCheckIns = [];
  // Retain the active quest so reward completion can show updated quest progress.
  // The active quest is saved in case this check-in completes it.
  let activeQuest = null;
  let passportDataLoaded = false;
  // Lookup tracking avoids redundant requests and discards stale asynchronous responses.
  // These values limit repeated site lookups and ignore outdated responses.
  let lastSiteLookup = 0;
  let lastLookupPosition = null;
  let lookupSequence = 0;

  // Used for distances in the nearby-site card and completion popup.
  function formatDistance(meters) {
    // Keep short distances readable in the camera status labels.
    return meters < 1000
      // Round meters instead of showing decimal places.
      ? `${Math.round(meters)} m`
      // Show longer distances in kilometers with one decimal place.
      : `${(meters / 1000).toFixed(1)} km`;
  }

  // Loads account and active-quest data after a check-in.
  async function loadPassportData() {
    // Use the shared account URL helper where available (for deployment paths/auth).
    const passportUrl = window.TourTrailAccount
      ? window.TourTrailAccount.apiUrl(PASSPORT_API_URL)
      : PASSPORT_API_URL;
    // Fetch Passport data without using a stale browser-cached response.
    const response = await fetch(passportUrl, {
      headers: { Accept: "application/json" },
      cache: "no-store",
    });
    // Reject invalid API responses before reading the active quest.
    const payload = await response.json();
    if (!response.ok || !payload.user) {
      throw new Error(payload.error || `Account request failed (${response.status}).`);
    }

    // Keep the authoritative quest snapshot for comparison after reward processing.
    activeQuest = payload.active_quest || null;
    passportDataLoaded = true;
    return payload;
  }

  // Shows active or completed quest progress in the completion popup.
  function renderCompletionQuest(quest, completedQuest = null, unavailable = false) {
    // Locate the quest text and icon within the completion popup.
    const card = document.getElementById("completion-quest");
    const label = card?.querySelector("span");
    const icon = card?.querySelector("img");
    if (!card || !label) return;

    card.hidden = false;
    // Display a clear message if the Passport request failed.
    if (unavailable) {
      label.textContent = "Quest progress unavailable";
      return;
    }

    // Show the active quest's current progress.
    if (quest) {
      // Clamp progress to the target to avoid displaying inconsistent API values.
      const target = Number(quest.target_count) || 0;
      const progress = Math.min(Number(quest.progress_count) || 0, target);
      const unit = quest.quest_type === "streak" ? "days" : "sites";
      label.textContent =
        `${quest.title}: ${progress} / ${target} ${unit}`;
      if (icon && quest.icon) icon.src = quest.icon;
      return;
    }

    // Show the finished quest if this visit completed it.
    if (completedQuest) {
      // The active quest may disappear from Passport after this check-in completes it.
      const target = Number(completedQuest.target_count) || 0;
      const unit = completedQuest.quest_type === "streak" ? "days" : "sites";
      label.textContent =
        `${completedQuest.title}: ${target} / ${target} ${unit} · Completed`;
      if (icon && completedQuest.icon) icon.src = completedQuest.icon;
      return;
    }

    label.textContent = "No active quest";
  }

  // Used in the nearby-site card and GPS check-in verification to measure distance.
  function distanceBetween(lat1, lon1, lat2, lon2) {
    // Convert coordinate differences from degrees to radians.
    const radians = (degrees) => (degrees * Math.PI) / 180;
    const deltaLat = radians(lat2 - lat1);
    const deltaLon = radians(lon2 - lon1);
    const a =
      Math.sin(deltaLat / 2) ** 2 +
      Math.cos(radians(lat1)) *
        Math.cos(radians(lat2)) *
        Math.sin(deltaLon / 2) ** 2;
    // Return the surface distance in meters for proximity checks.
    return 6371000 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  }

  // Prepares site data for the nearby-site card and check-in verification.
  function normalizeSite(record, position) {
    // Missing coordinates cannot be used for distance checks.
    if (
      record.latitude == null ||
      record.latitude === "" ||
      record.longitude == null ||
      record.longitude === ""
    ) {
      return null;
    }
    // Convert API coordinate strings to numbers for distance calculations.
    const latitude = Number(record.latitude);
    const longitude = Number(record.longitude);
    // Support both field names returned by map API and saved site records.
    const id = record.id ?? record.site_id;
    const name = record.title ?? record.name;
    // Keep the site's visit status for the reward card.
    const status = record.status || "new";
    // Reject invalid IDs, names, and out-of-range coordinates before using the record.
    if (
      id == null ||
      !name ||
      !Number.isFinite(latitude) ||
      !Number.isFinite(longitude) ||
      latitude < -90 ||
      latitude > 90 ||
      longitude < -180 ||
      longitude > 180
    ) {
      return null;
    }
    // Return one consistent site shape for the camera UI and verification.
    return {
      id: String(id),
      name: String(name),
      latitude,
      longitude,
      // Site category and distance are used by the site card and range message.
      category: record.category || "Tourist spot",
      distance: distanceBetween(
        position.latitude,
        position.longitude,
        latitude,
        longitude
      ),
      status,
      // Use the configured stamp or a simple site-name fallback.
      stamp: record.stamp_name || `${String(name).split(/\s+/, 1)[0]} Explorer`,
      // Normalize database boolean values for the hidden-gem label.
      isHiddenGem: record.is_hidden_gem === 1 || record.is_hidden_gem === "1",
    };
  }

  // Updates one item in the camera page's three-step check-in list.
  function setStep(index, state) {
    // Select the matching numbered item in the check-in steps card.
    const step = elements.steps[index];
    if (!step) return;
    // Remove any previous status class before applying the new one.
    step.classList.remove(
      "complete",
      "current",
      "pending",
      "unverified-complete"
    );
    step.classList.add(state);
    // Show a checkmark when a step is complete, otherwise show its number.
    step.querySelector(".step-indicator").textContent =
      state === "complete" || state === "unverified-complete"
        ? "✓"
        : String(index + 1);
  }
  // Updates all three check-in steps as the photo is captured and verified.
  function updateStepStates() {
    // Mark all steps finished, styling the last one differently if verification failed.
    if (checkInComplete) {
      setStep(0, "complete");
      setStep(1, "complete");
      setStep(2, completionVerified ? "complete" : "unverified-complete");
    } else if (verifiedSite) {
      // Show the reward step as active after location verification.
      setStep(0, "complete");
      setStep(1, "complete");
      setStep(2, "current");
    } else if (pendingPhoto) {
      // Show verification as the active step while a photo is pending.
      setStep(0, "complete");
      setStep(1, "current");
      setStep(2, "pending");
    } else {
      setStep(0, "current");
      setStep(1, "pending");
      setStep(2, "pending");
    }
  }

  // Enables or hides the shutter, retry, and Earn Stamp buttons.
  function updateCameraControls() {
    // A single derived state keeps capture/retry/reward buttons synchronized.
    // Disable the shutter until the camera is ready and no operation is active.
    elements.captureButton.disabled =
      !cameraReady ||
      cameraMode !== "photo" ||
      capturing ||
      verifying ||
      awarding ||
      Boolean(verifiedSite) ||
      checkInComplete;
    // Only offer reward after site verification; only offer retry while verification can be retried.
    elements.earnStampButton.hidden = !verifiedSite || awarding || checkInComplete;
    elements.verifyRetry.hidden =
      !pendingPhoto || Boolean(verifiedSite) || verifying || checkInComplete;
    elements.earnStampButton.disabled = !verifiedSite || awarding || checkInComplete;
    const modeLocked = capturing || verifying || awarding || Boolean(verifiedSite) || checkInComplete;
    elements.photoMode.disabled = modeLocked;
    elements.qrMode.disabled = modeLocked;
  }

  // Updates the site card, GPS badge, and stamp reward shown beside the preview.
  function renderNearestSite(site, stale = false) {
    // Keep the selected site available for later GPS updates and check-in.
    nearestSite = site;
    // Recalculate distance for the most recent GPS position before rendering status.
    site.distance = distanceBetween(
      currentPosition.latitude,
      currentPosition.longitude,
      site.latitude,
      site.longitude
    );
    // Compare the site distance with the allowed check-in radius.
    isInRange = site.distance <= CHECK_IN_RADIUS_METERS;
    // Update the site name and category in the card beside the camera.
    elements.siteName.textContent = site.name;
    elements.siteType.textContent = site.isHiddenGem
      ? `${site.category} · Hidden gem`
      : site.category;
    elements.rangeTag.textContent = isInRange
      ? `In range · ${formatDistance(site.distance)}`
      : `${formatDistance(site.distance)} away`;
    elements.rangeTag.classList.toggle("out-of-range", !isInRange);
    elements.gpsBadgeText.textContent = isInRange
      ? `GPS in range · ${formatDistance(site.distance)} away`
      : `GPS active · ${formatDistance(site.distance)} away`;
    elements.gpsBadge.classList.toggle("out-of-range", !isInRange);
    // Show the stamp reward before the user takes a photo.
    elements.rewardTitle.textContent = `Stamp: ${site.stamp}`;
    // Explain whether the site has already been visited.
    elements.rewardDescription.textContent = stale
      ? "Showing the latest available nearby site."
      : site.status === "visited"
        ? "You have already visited this site."
        : "Check in here to earn this site's stamp.";
    // Avoid replacing verification messages while a photo is being processed.
    if (!pendingPhoto && !verifiedSite) {
      elements.previewCaption.textContent = cameraReady
        ? "Camera ready. Take a photo or scan a QR code."
        : "Requesting camera access…";
    }
    updateStepStates();
    updateCameraControls();
  }

  // Shows an unavailable message in the site card when no site can be loaded.
  function showNoNearbySites() {
    // Clear stale site data so it cannot be mistaken for a check-in target.
    nearestSite = null;
    isInRange = false;
    elements.siteName.textContent = "No nearby sites found";
    elements.siteType.textContent = "No tourist spots are available for your location.";
    elements.rangeTag.textContent = "Site unavailable";
    elements.rangeTag.classList.add("out-of-range");
    elements.gpsBadgeText.textContent = "No nearby sites";
    elements.gpsBadge.classList.add("out-of-range");
    elements.previewCaption.textContent = cameraReady
      ? "Camera ready. Take a photo or scan a QR code."
      : "Requesting camera access…";
    elements.rewardTitle.textContent = "No check-in reward available";
    elements.rewardDescription.textContent = "Nearby site information could not be loaded.";
    updateStepStates();
    updateCameraControls();
  }

  // Loads nearby sites for the site card, using saved site data if the request fails.
  async function loadNearestSite(position) {
    // Each request gets a sequence; only the newest location lookup may update the UI.
    const sequence = ++lookupSequence;
    // Send this GPS position to the map API to find the closest site.
    const params = new URLSearchParams({
      lat: String(position.latitude),
      lng: String(position.longitude),
      category: "all",
    });

    try {
      // Request current site data and report API failures to the fallback below.
      const sitesUrl = `api/sites.php?${params}`;
      const response = await fetch(
        window.TourTrailAccount ? window.TourTrailAccount.apiUrl(sitesUrl) : sitesUrl,
        {
        headers: { Accept: "application/json" },
        cache: "no-store",
        }
      );
      if (!response.ok) {
        const error = new Error(`Site request failed (${response.status}).`);
        error.status = response.status;
        throw error;
      }
      const payload = await response.json();
      if (payload.status !== "success" || !Array.isArray(payload.data)) {
        const error = new Error(payload.error || "The nearby-sites service returned invalid data.");
        error.code = payload.code;
        error.status = response.status;
        throw error;
      }
      if (window.TourTrailAccount) window.TourTrailAccount.markServerOnline();

      // Convert the API records and sort them so the nearest site comes first.
      const sites = payload.data
        .map((record) => normalizeSite(record, position))
        .filter(Boolean)
        .sort((a, b) => a.distance - b.distance);
      // Ignore this response if a newer GPS lookup has already started.
      if (sequence !== lookupSequence) return;
      if (!sites.length) {
        showNoNearbySites();
        return;
      }

      // Cache only successfully returned API records; cached records remain display-only.
      window.localStorage.setItem(SITE_CACHE_KEY, JSON.stringify(payload.data));
      lastSiteLookup = Date.now();
      lastLookupPosition = position;
      // Use the site requested from the map, or the nearest site by distance.
      const selectedSite = selectedSiteId
        ? sites.find((site) => site.id === selectedSiteId)
        : sites[0];
      if (selectedSite) {
        renderNearestSite(selectedSite);
      } else {
        showNoNearbySites();
      }
    } catch (error) {
      console.error("Could not load nearby sites:", error);
      if (
        window.TourTrailAccount &&
        (!navigator.onLine ||
          error.name === "TypeError" ||
          error.code === "database_unavailable" ||
          (Number.isInteger(error.status) && error.status >= 500))
      ) {
        window.TourTrailAccount.markServerOffline();
      }
      // A network/API failure may still permit a nearby-site display from prior data.
      let cachedSites = [];
      try {
        const cached = JSON.parse(window.localStorage.getItem(SITE_CACHE_KEY) || "[]");
        if (Array.isArray(cached)) {
          cachedSites = cached
            .map((record) => normalizeSite(record, position))
            .filter(Boolean)
            .sort((a, b) => a.distance - b.distance);
        }
      } catch (cacheError) {
        console.error("Could not read saved nearby-site data:", cacheError);
      }
      if (sequence !== lookupSequence) return;
      // Show the nearest cached site only as an offline display, never as verified proof.
      if (cachedSites.length && !selectedSiteId) {
        lastSiteLookup = Date.now();
        lastLookupPosition = position;
        renderNearestSite(cachedSites[0], true);
      } else {
        showNoNearbySites();
      }
    }
  }

  // Updates the GPS position and refreshes the nearby-site card when needed.
  function updateLocation(position) {
    // Copy only the coordinates/accuracy needed by site lookup and check-in upload.
    currentPosition = {
      latitude: position.coords.latitude,
      longitude: position.coords.longitude,
      accuracy: position.coords.accuracy,
    };
    // Check whether movement or elapsed time requires a fresh site request.
    const movedEnough = !lastLookupPosition ||
      distanceBetween(
        currentPosition.latitude,
        currentPosition.longitude,
        lastLookupPosition.latitude,
        lastLookupPosition.longitude
      ) > 30;
    if (movedEnough || Date.now() - lastSiteLookup > 30000) {
      // Refresh after 30 m of movement or 30 seconds, whichever occurs first.
      lastSiteLookup = Date.now();
      lastLookupPosition = currentPosition;
      loadNearestSite(currentPosition);
    } else if (nearestSite) {
      renderNearestSite(nearestSite);
    }
  }

  // Shows a location error on the GPS badge and site card.
  function locationError(error) {
    isInRange = false;
    const messages = {
      1: "Location permission was denied. Allow location access to find nearby sites.",
      2: "Your location is unavailable. Try again outdoors.",
      3: "GPS timed out. Check your location settings and try again.",
    };
    // Choose a helpful message for the browser's GPS error code.
    const message = messages[error.code] || "Could not get your current location.";
    // Reflect GPS failure visibly and leave check-in controls governed by current state.
    elements.gpsBadgeText.textContent = "GPS unavailable";
    elements.gpsBadge.classList.add("out-of-range");
    elements.rangeTag.textContent = "Location unavailable";
    elements.rangeTag.classList.add("out-of-range");
    elements.siteName.textContent = "Location unavailable";
    elements.siteType.textContent = message;
    updateStepStates();
    updateCameraControls();
  }

  // Starts the camera preview and updates the camera access and shutter buttons.
  async function startCamera() {
    // Request camera access only when the browser supports the media API.
    if (!navigator.mediaDevices?.getUserMedia) {
      elements.previewCaption.textContent =
        "Camera access needs HTTPS or localhost. Open the app securely and try again.";
      elements.cameraRetry.hidden = false;
      cameraReady = false;
      updateCameraControls();
      return false;
    }
    try {
      // Acquire the stream once; retries reuse it and restart video playback.
      // Start a video-only stream; prefer a rear camera where devices provide one.
      if (!cameraStream) {
        cameraStream = await navigator.mediaDevices.getUserMedia({
          audio: false,
          video: { facingMode: { ideal: "environment" } },
        });
        elements.video.srcObject = cameraStream;
      }
      // Start the preview and enable the shutter after camera access succeeds.
      await elements.video.play();
      cameraReady = true;
      elements.previewCaption.textContent = "Camera ready. Take a photo or scan a QR code.";
      elements.cameraRetry.hidden = true;
      updateCameraControls();
      if (cameraMode === "qr") setCameraMode("qr");
      return true;
    } catch (error) {
      console.error("Could not start the camera:", error);
      const messages = {
        NotAllowedError: "Camera permission was denied. Allow camera access and try again.",
        NotFoundError: "No camera was found on this device.",
        NotReadableError: "The camera is busy in another app. Close it and try again.",
      };
      elements.previewCaption.textContent =
        messages[error.name] || "Could not start the camera. Check permissions and try again.";
      elements.cameraRetry.hidden = false;
      cameraReady = false;
      updateCameraControls();
      return false;
    }
  }

  function stopQrScanning() {
    qrScanning = false;
    if (qrAnimationFrame !== null) {
      window.cancelAnimationFrame(qrAnimationFrame);
      qrAnimationFrame = null;
    }
  }

  async function setCameraMode(mode) {
    cameraMode = mode === "qr" ? "qr" : "photo";
    stopQrScanning();
    elements.panel.classList.toggle("is-scanning", cameraMode === "qr");
    elements.photoMode.classList.toggle("is-active", cameraMode === "photo");
    elements.photoMode.setAttribute("aria-pressed", String(cameraMode === "photo"));
    elements.qrMode.classList.toggle("is-active", cameraMode === "qr");
    elements.qrMode.setAttribute("aria-pressed", String(cameraMode === "qr"));
    elements.qrResult.hidden = cameraMode !== "qr";
    elements.qrRescan.hidden = true;

    if (cameraMode === "photo") {
      elements.qrResultText.textContent = "";
      elements.previewCaption.textContent = cameraReady
        ? "Camera ready. Take a photo when you are ready."
        : "Requesting camera access…";
      updateCameraControls();
      return;
    }

    elements.capturedPhoto.hidden = true;
    elements.capturedPhoto.removeAttribute("src");
    elements.video.hidden = false;
    elements.panel.classList.remove("is-captured");
    elements.qrResultText.textContent = "Point your camera at a QR code.";
    if (!cameraReady) {
      elements.qrResultText.textContent = "Allow camera access to scan a QR code.";
      updateCameraControls();
      return;
    }
    if (!("BarcodeDetector" in window)) {
      elements.qrResultText.textContent = "QR scanning is not supported by this browser. Try a recent version of Chrome.";
      updateCameraControls();
      return;
    }

    try {
      qrDetector = new window.BarcodeDetector({ formats: ["qr_code"] });
      qrScanning = true;
      elements.previewCaption.textContent = "Scanning for a QR code…";
      scanQrFrame();
    } catch (error) {
      console.error("Could not start the QR scanner:", error);
      elements.qrResultText.textContent = "Could not start QR scanning on this device.";
    }
    updateCameraControls();
  }

  async function scanQrFrame() {
    if (!qrScanning) return;
    if (elements.video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) {
      qrAnimationFrame = window.requestAnimationFrame(scanQrFrame);
      return;
    }

    try {
      const results = await qrDetector.detect(elements.video);
      if (!qrScanning) return;
      const value = results.find((result) => result.rawValue)?.rawValue;
      if (value) {
        stopQrScanning();
        elements.qrResultText.textContent = value.slice(0, 500);
        elements.qrRescan.hidden = false;
        elements.previewCaption.textContent = "QR code scanned.";
        updateCameraControls();
        return;
      }
    } catch (error) {
      console.error("Could not read the QR code:", error);
      stopQrScanning();
      elements.qrResultText.textContent = "Could not read this QR code. Try scanning again.";
      elements.qrRescan.hidden = false;
      updateCameraControls();
      return;
    }

    qrAnimationFrame = window.requestAnimationFrame(scanQrFrame);
  }

  // Converts a captured image into the format sent to the check-in API.
  function dataUrlFromBlob(blob) {
    return new Promise((resolve, reject) => {
      // FileReader converts the photo so it can be placed in the API upload form.
      const reader = new FileReader();
      // Resolve only when the image has been fully converted for FormData upload.
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(reader.error || new Error("Could not read the captured photo."));
      reader.readAsDataURL(blob);
    });
  }

  function requestPhotoLocation() {
    if (!navigator.geolocation) return Promise.resolve(null);
    return new Promise((resolve) => {
      navigator.geolocation.getCurrentPosition(
        (position) => {
          currentPosition = position.coords;
          resolve(position.coords);
        },
        () => {
          currentPosition = null;
          resolve(null);
        },
        { enableHighAccuracy: true, maximumAge: 5000, timeout: 12000 }
      );
    });
  }

  // Saves the captured photo and GPS details through the check-in API.
  async function saveCheckInToDatabase(photo, siteId = null) {
    // Convert the captured data URL back into a Blob so the API receives a file upload.
    // Turn the captured image URL into a file-like Blob for the form upload.
    const imageBlob = await fetch(photo.imageUrl).then((response) => response.blob());
    const formData = new FormData();
    formData.append("photo", imageBlob, "check-in.jpg");
    formData.append("client_photo_id", photo.id);
    // Include GPS fields only when the photo has a location fix.
    if (photo.gps) {
      // Send the captured fix and accuracy so the server can independently verify it.
      formData.append("latitude", String(photo.gps.lat));
      formData.append("longitude", String(photo.gps.lng));
      if (Number.isFinite(photo.gps.accuracy)) {
        formData.append("accuracy", String(photo.gps.accuracy));
      }
    }
    // Include a site ID when the camera was opened for a specific map site.
    if (siteId !== null) formData.append("site_id", String(siteId));

    const checkinsUrl = window.TourTrailAccount
      ? window.TourTrailAccount.apiUrl("api/checkins.php")
      : "api/checkins.php";
    // Save the photo and GPS details; the server makes the final verification decision.
    const response = await fetch(checkinsUrl, {
      method: "POST",
      headers: { Accept: "application/json" },
      body: formData,
    });
    // Do not continue check-in if the server did not persist the record successfully.
    const payload = await response.json();
    if (!response.ok || payload.status !== "success" || !payload.data?.checkin_id) {
      const error = new Error(payload.error || `Check-in save failed (${response.status}).`);
      error.status = response.status;
      throw error;
    }
    if (window.TourTrailAccount) window.TourTrailAccount.markServerOnline();

    // Save the server's verification result on the current photo for later steps.
    photo.checkinId = payload.data.checkin_id;
    // Accept the boolean and database scalar encodings returned by PHP.
    photo.verified =
      payload.data.is_verified === true ||
      payload.data.is_verified === 1 ||
      payload.data.is_verified === "1" ||
      payload.data.verification_status === "verified";
    photo.verificationMessage = payload.data.verification_message || null;
    photo.is_verified = photo.verified;
    if (photo.verified) {
      photo.siteId = String(payload.data.site_id);
      photo.siteName = payload.data.site_name;
    }
    return photo.verified;
  }

  // Saves the check-in's stamp and quest rewards after verification.
  async function updateCheckInXpInDatabase(checkinId) {
    const checkinsUrl = window.TourTrailAccount
      ? window.TourTrailAccount.apiUrl("api/checkins.php")
      : "api/checkins.php";
    // Send PATCH because the photo was already saved and verified.
    const response = await fetch(checkinsUrl, {
      method: "PATCH",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ checkin_id: checkinId }),
    });
    // PATCH performs the persisted reward/quest update after successful verification.
    const payload = await response.json();
    // Check each response field used by the reward popup and notifications.
    if (
      !response.ok ||
      payload.status !== "success" ||
      !Number.isFinite(Number(payload.data?.xp_earned)) ||
      !Number.isFinite(Number(payload.data?.total_xp)) ||
      !Array.isArray(payload.data?.badges_awarded) ||
      !Array.isArray(payload.data?.quests_completed) ||
      typeof payload.data?.streak_updated !== "boolean" ||
      !["awarded", "already_collected", "unavailable"].includes(payload.data?.stamp_status)
    ) {
      throw new Error(payload.error || `Check-in reward save failed (${response.status}).`);
    }
    return payload.data;
  }

  // Displays the three most recent verified visits in the Recent Check-ins list.
  function renderRecentCheckIns(photos) {
    // Merge by photo ID to avoid duplicate history entries when rendering repeatedly.
    const merged = new Map(recentCheckIns.map((photo) => [photo.id, photo]));
    // Keep only visits that the server marked verified and that have display details.
    photos
      .filter((photo) =>
        (photo?.verified === true || photo?.is_verified === true) &&
        photo.siteId &&
        photo.siteName &&
        photo.takenAt
      )
      .forEach((photo) => merged.set(photo.id, photo));
    // Sort by visit time so the newest verified check-ins appear first.
    recentCheckIns = [...merged.values()]
      .sort((a, b) => {
        // Prefer capture time; database IDs are a fallback for invalid/equal dates.
        const dateDifference = Date.parse(b.takenAt) - Date.parse(a.takenAt);
        return Number.isFinite(dateDifference) && dateDifference !== 0
          ? dateDifference
          : Number(b.checkinId || 0) - Number(a.checkinId || 0);
      });

    // Clear the old list before rendering the current results.
    elements.recentCheckIns.textContent = "";
    if (!recentCheckIns.length) {
      // Keep the list informative when there are no verified entries to show.
      const emptyMessage = document.createElement("p");
      emptyMessage.className = "recent-empty";
      emptyMessage.textContent = "No verified check-ins yet.";
      elements.recentCheckIns.appendChild(emptyMessage);
      return;
    }

    // Render at most three visits in the small history panel.
    recentCheckIns.slice(0, 3).forEach((photo) => {
      // Build nodes and assign textContent rather than injecting user/API strings as HTML.
      const item = document.createElement("div");
      item.className = "recent-item";

      const thumbnail = document.createElement("span");
      thumbnail.className = "recent-thumb";
      const icon = document.createElement("img");
      icon.className = "recent-icon";
      icon.src = "../assets/pin.png";
      icon.alt = "";
      thumbnail.appendChild(icon);

      const details = document.createElement("div");
      const name = document.createElement("strong");
      name.textContent = photo.siteName;
      const date = document.createElement("span");
      const takenAt = new Date(photo.takenAt);
      date.textContent = Number.isNaN(takenAt.getTime())
        ? "Verified check-in"
        : `Verified · ${takenAt.toLocaleString(undefined, {
            dateStyle: "medium",
            timeStyle: "short",
          })}`;
      details.append(name, date);
      item.append(thumbnail, details);
      elements.recentCheckIns.appendChild(item);
    });
  }

  // Takes a photo from the preview and starts the check-in process.
  async function capturePhoto() {
    // Do not start another capture while a check-in is being processed or completed.
    if (!cameraReady || capturing || verifying || awarding || verifiedSite) return;
    // Wait until the video element has received a frame before capturing.
    if (!elements.video.videoWidth || !elements.video.videoHeight) {
      elements.previewCaption.textContent = "Waiting for the camera to be ready. Try again in a moment.";
      return;
    }
    // Draw the current preview frame onto a canvas at the camera's native size.
    const canvas = document.createElement("canvas");
    // Match the canvas to the live video dimensions to preserve captured resolution.
    canvas.width = elements.video.videoWidth;
    canvas.height = elements.video.videoHeight;
    const context = canvas.getContext("2d");
    if (!context) {
      elements.previewCaption.textContent = "Could not capture the photo. Please try again.";
      return;
    }
    context.drawImage(elements.video, 0, 0);
    // Export a compressed JPEG to reduce the upload size.
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.85));
    if (!blob) {
      elements.previewCaption.textContent = "Could not capture the photo. Please try again.";
      return;
    }

    // Disable the shutter while preparing and verifying this photo.
    capturing = true;
    updateCameraControls();
    let imageUrl;
    try {
      imageUrl = await dataUrlFromBlob(blob);
    } catch (error) {
      capturing = false;
      updateCameraControls();
      throw error;
    }
    elements.capturedPhoto.src = imageUrl;
    elements.capturedPhoto.hidden = false;
    elements.video.hidden = true;
    elements.panel.classList.add("is-captured");
    elements.previewCaption.textContent = "Preparing your photo…";
    try {
      await requestPhotoLocation();
    } catch (error) {
      console.warn("Could not get a photo location:", error);
      currentPosition = null;
    }
    // Attach a location fix only when available so the server can validate the check-in.
    const photo = {
      id: `local-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      imageUrl,
      takenAt: new Date().toISOString(),
      gps: currentPosition
        ? {
            lat: currentPosition.latitude,
            lng: currentPosition.longitude,
            accuracy: currentPosition.accuracy,
          }
        : null,
      xp: 0,
    };

    try {
      // Save this photo as the sole pending check-in and begin the verification flow.
      pendingPhoto = photo;
      verifiedSite = null;
      checkInComplete = false;
      completionVerified = false;
      updateStepStates();
      elements.previewCaption.textContent = "Saving your photo…";
      await verifyCheckIn(photo);
    } catch (error) {
      console.error("Could not process the captured photo:", error);
      elements.previewCaption.textContent =
        "The photo could not be processed. Please try again.";
    } finally {
      capturing = false;
      updateCameraControls();
    }
  }

  // Matches the photo's GPS to a nearby site before allowing a reward.
  async function verifyCheckIn(photo) {
    // Ignore stale retries and duplicate verification attempts.
    if (!photo || photo !== pendingPhoto || verifying || verifiedSite) return;
    // Mark verification in progress and update the steps and buttons.
    verifying = true;
    updateStepStates();
    updateCameraControls();
    elements.previewCaption.textContent = "Verifying your check-in…";

    try {
      if (
        // Invalid or missing GPS cannot match a registered tourist site.
        !photo.gps ||
        !Number.isFinite(photo.gps.lat) ||
        !Number.isFinite(photo.gps.lng) ||
        photo.gps.lat < -90 ||
        photo.gps.lat > 90 ||
        photo.gps.lng < -180 ||
        photo.gps.lng > 180
      ) {
        await completeUnverifiedPhoto(photo);
        return;
      }
      // Send the captured GPS location to the map API for nearby-site matching.
      const params = new URLSearchParams({
        lat: String(photo.gps.lat),
        lng: String(photo.gps.lng),
        category: "all",
      });
      const sitesUrl = `api/sites.php?${params}`;
      const response = await fetch(
        window.TourTrailAccount ? window.TourTrailAccount.apiUrl(sitesUrl) : sitesUrl,
        {
        headers: { Accept: "application/json" },
        cache: "no-store",
        }
      );
      if (!response.ok) {
        const error = new Error(`Map site lookup failed (${response.status}).`);
        error.status = response.status;
        throw error;
      }
      const payload = await response.json();
      if (payload.status !== "success" || !Array.isArray(payload.data)) {
        const error = new Error(payload.error || "The map service returned invalid site data.");
        error.code = payload.code;
        error.status = response.status;
        throw error;
      }

      // Normalize and sort sites by distance from the captured GPS fix.
      const photoPosition = {
        latitude: photo.gps.lat,
        longitude: photo.gps.lng,
      };
      const sites = payload.data
        .map((record) => normalizeSite(record, photoPosition))
        .filter(Boolean)
        .sort((a, b) => a.distance - b.distance);
      // A specific map site must match; otherwise use the nearest site.
      const site = selectedSiteId
        ? sites.find((candidate) => candidate.id === selectedSiteId)
        : sites[0];
      // Require the chosen site to be within the check-in radius.
      if (!site || site.distance > CHECK_IN_RADIUS_METERS) {
        // A missing selected site or excessive distance is saved as unverified, without reward.
        const reason = "This check-in could not be verified. Please try again.";
        await completeUnverifiedPhoto(photo, false, reason);
        return;
      }

      // Ask the server to independently verify and save the photo.
      const databaseVerified = await saveCheckInToDatabase(photo, site.id);
      if (!databaseVerified) {
        await completeUnverifiedPhoto(
          photo,
          true,
          photo.verificationMessage || "The server could not verify this site's location."
        );
        return;
      }
      // Update the camera page with the site accepted by server verification.
      verifiedSite = site;
      nearestSite = site;
      isInRange = true;
      renderRecentCheckIns([photo]);
      elements.siteName.textContent = site.name;
      elements.siteType.textContent = site.isHiddenGem
        ? `${site.category} · Hidden gem`
        : site.category;
      elements.rangeTag.textContent = `Map verified · ${formatDistance(site.distance)}`;
      elements.rangeTag.classList.remove("out-of-range");
      elements.gpsBadgeText.textContent = `Map verified · ${formatDistance(site.distance)} away`;
      elements.gpsBadge.classList.remove("out-of-range");
      elements.previewCaption.textContent = "Check-in verified. Completing…";
      updateStepStates();
      // Reward and quest progress are changed only after server-side verification succeeds.
      await earnStamp();
      // If verification fails, keep a saved unverified photo and show a retry message.
    } catch (error) {
      console.error("Could not verify the photo location:", error);
      if (
        !photo.checkinId &&
        window.TourTrailAccount &&
        (!navigator.onLine ||
          error.name === "TypeError" ||
          error.code === "database_unavailable" ||
          (Number.isInteger(error.status) && error.status >= 500))
      ) {
        try {
          await queueOfflineCheckIn(photo);
          return;
        } catch (queueError) {
          console.error("Could not queue the offline check-in:", queueError);
          elements.previewCaption.textContent =
            "This check-in could not be saved for upload. Keep this page open and try again.";
          return;
        }
      }
      try {
        // Avoid posting a second record if the server already accepted this photo.
        if (photo.verified) {
          elements.previewCaption.textContent =
            "The database verified this photo, but check-in completion failed. Please retry.";
          return;
        }
        if (!photo.checkinId) await saveCheckInToDatabase(photo);
        await completeUnverifiedPhoto(photo, true);
      } catch (saveError) {
        console.error("Could not save the unverified photo:", saveError);
        elements.previewCaption.textContent =
          "The photo could not be saved to your check-ins. Check your connection and try again.";
      }
    } finally {
      verifying = false;
      updateCameraControls();
    }
  }


  // Finds a nearby saved site to attach when a check-in must wait for network access.
  function findCachedSiteForPhoto(photo) {
    // GPS is needed to compare the photo's location with saved site coordinates.
    if (!photo.gps) return null;
    try {
      // Read the site's most recent successful API response from local storage.
      const records = JSON.parse(window.localStorage.getItem(SITE_CACHE_KEY) || "[]");
      if (!Array.isArray(records)) return null;
      // Reuse the normal site conversion and distance rules for cached records.
      const position = {
        latitude: photo.gps.lat,
        longitude: photo.gps.lng,
      };
      const sites = records
        .map((record) => normalizeSite(record, position))
        .filter(Boolean)
        .sort((a, b) => a.distance - b.distance);
      // Match the selected map site, or use the nearest saved site.
      const site = selectedSiteId
        ? sites.find((candidate) => candidate.id === selectedSiteId)
        : sites[0];
      // A cached site can be suggested but cannot prove the check-in location.
      return site && site.distance <= CHECK_IN_RADIUS_METERS ? site : null;
    } catch (error) {
      console.error("Could not use the saved site data for offline verification:", error);
      return null;
    }
  }

  // Queues a photo for upload and shows its pending status in the completion popup.
  async function queueOfflineCheckIn(photo) {
    // Save a nearby site ID if available so the server can verify it after upload.
    const site = findCachedSiteForPhoto(photo);
    const siteId = site ? site.id : null;
    // Store the photo locally and mark the server connection as unavailable.
    window.TourTrailAccount.queueCheckIn(photo, siteId);
    window.TourTrailAccount.markServerOffline();
    // Record which queued photo should be updated when syncing completes.
    queuedPhotoId = photo.id;
    pendingPhoto = null;
    verifiedSite = null;
    checkInComplete = true;
    completionVerified = false;
    // Update the three-step check-in card while upload and verification are pending.
    updateStepStates();
    updateCameraControls();

    // Label the popup as pending while upload and verification are in progress.
    elements.rewardTitle.textContent = "Check-in saved · Upload pending";
    elements.rewardDescription.textContent =
      "Your check-in is saved. Upload and location verification will continue when a connection is available.";
    // Show site details only when a matching cached site was found.
    document.getElementById("checkin-dialog-title").textContent = "Check-in saved";
    document.getElementById("verification-status").classList.remove("unverified");
    document.getElementById("verification-status").textContent = "Upload pending";
    document.getElementById("verification-status").hidden = false;
    document.getElementById("completion-site-label").textContent = "Spot";
    document.getElementById("completion-site-label").hidden = !site;
    document.getElementById("completion-site").textContent = site?.name || "";
    document.getElementById("completion-site-separator").hidden = !site;
    document.getElementById("completion-verification").hidden = false;
    document.getElementById("completion-verification").textContent =
      "Upload and location verification will continue when a connection is available.";
    document.getElementById("completion-stamp-label").hidden = true;
    document.getElementById("completion-stamp").textContent = "";
    document.getElementById("completion-quest").hidden = true;
    document.getElementById("completion-distance-row").hidden = true;
    // Keep the pending upload visible in the check-in confirmation.
    elements.previewCaption.textContent = "Check-in saved · Upload pending";
    if (!elements.dialog.open) elements.dialog.showModal();
  }

  /**
   * Finishes a photo that did not match a registered site. Reward totals are
   * deliberately left untouched; the unverified check-in is recorded by the
   * check-in API without adding the photo to the local gallery.
   */
  async function completeUnverifiedPhoto(
    photo,
    alreadySaved = false,
    reason = "This check-in could not be verified."
  ) {
    // Save unverified photos too, unless verification already created the database record.
    if (!alreadySaved && !photo.checkinId) {
      await saveCheckInToDatabase(photo);
    }
    // Mark this photo and its completion state as unverified.
    photo.verified = false;
    photo.is_verified = false;
    pendingPhoto = null;
    verifiedSite = null;
    checkInComplete = true;
    completionVerified = false;
    // Mark all steps complete while using the distinct unverified style for step 3.
    updateStepStates();
    updateCameraControls();

    // Tell the visitor the photo was saved without verified-site details.
    elements.rewardTitle.textContent = "Photo saved to your gallery";
    elements.rewardDescription.textContent = "Location could not be verified.";
    document.getElementById("checkin-dialog-title").textContent = "Photo saved";
    document.getElementById("verification-status").textContent = "Location Unverified";
    document.getElementById("verification-status").classList.add("unverified");
    document.getElementById("verification-status").hidden = false;
    document.getElementById("completion-site-separator").hidden = true;
    document.getElementById("completion-site-label").hidden = true;
    document.getElementById("completion-site").textContent = "";
    document.getElementById("completion-verification").hidden = true;
    document.getElementById("completion-stamp-label").hidden = true;
    document.getElementById("completion-stamp").textContent =
      "Saved to my gallery";
    document.getElementById("completion-quest").hidden = true;
    document.getElementById("completion-distance-row").hidden = true;
    // Show the popup after all its unverified details have been set.
    elements.previewCaption.textContent = "Photo saved. This check-in could not be verified.";
    if (!elements.dialog.open) elements.dialog.showModal();
  }

  // Saves the verified site's reward, then updates the completion popup.
  async function earnStamp() {
    // A reward can only be applied once for a verified pending check-in.
    if (!verifiedSite || !pendingPhoto || awarding) return;
    awarding = true;
    updateStepStates();
    updateCameraControls();

    try {
      // Keep the old quest so the popup can show it as completed after refresh.
      let questBeforeReward = activeQuest;
      if (!passportDataLoaded) {
        try {
          const passport = await loadPassportData();
          questBeforeReward = passport.active_quest || null;
        } catch (error) {
          console.error("Could not load the active quest before check-in:", error);
        }
      }

      const stampKey = `tourtrail-stamp:${verifiedSite.id}`;
      // Get the authoritative stamp, quest, and badge results from the API.
      const reward = await updateCheckInXpInDatabase(pendingPhoto.checkinId);
      const stampStatus = reward.stamp_status;
      if (stampStatus === "awarded") {
        // These keys are local UI markers only; the database response remains authoritative.
        window.localStorage.setItem(stampKey, "earned");
      }
      window.localStorage.setItem("tourtrail-first-steps", "earned");

      // Refresh the quest and badge data after the reward has been committed.
      let passport = null;
      try {
        // Reload Passport after PATCH so the dialog shows the committed quest progress.
        passport = await loadPassportData();
        const questWasCompleted = questBeforeReward &&
          Array.isArray(passport.completed_quests) &&
          passport.completed_quests.some(
            (quest) => quest.title === questBeforeReward.title
          );
        renderCompletionQuest(
          passport.active_quest || null,
          questWasCompleted ? questBeforeReward : null
        );
      } catch (error) {
        console.error("Could not load passport quest progress:", error);
        renderCompletionQuest(null, null, true);
      }
      // Notify the visitor only when the API reports a newly earned reward.
      if (
        reward.badges_awarded.length ||
        reward.stamp_status === "awarded" ||
        reward.quests_completed.length ||
        reward.streak_updated
      ) {
        if (window.TourTrailNotifications?.showEarnedRewards) {
        window.TourTrailNotifications.showEarnedRewards({
          badges: reward.badges_awarded,
          stamp: reward.stamp_status === "awarded"
            ? reward.stamp_name || verifiedSite.stamp
            : null,
          quests: reward.quests_completed,
          streak: reward.streak_updated ? Number(reward.streak_count) : null,
        }, passport?.badges || []).catch((error) => {
          console.error("Could not show earned reward notifications:", error);
        });
        }
      }
      completeCheckIn(stampStatus);
    } catch (error) {
      console.error("Could not award the verified stamp:", error);
      elements.previewCaption.textContent =
        "Check-in verified, but it could not be completed. Please try again.";
    } finally {
      awarding = false;
      updateCameraControls();
    }
  }

  // Shows stamp and visit details in the verified completion popup.
  function completeCheckIn(stampStatus) {
    // Clear the pending state and display the completion as verified.
    pendingPhoto = null;
    checkInComplete = true;
    completionVerified = true;
    updateStepStates();
    const alreadyCollected = stampStatus === "already_collected";
    const stampUnavailable = stampStatus === "unavailable";
    // Reward copy varies depending on whether the stamp was new or unavailable.
    elements.rewardTitle.textContent = stampUnavailable
      ? "Check-in verified"
      : `Stamp: ${verifiedSite.stamp}`;
    elements.rewardDescription.textContent = alreadyCollected
      ? "This site's stamp was already collected."
      : stampUnavailable
        ? "No passport stamp is configured for this site."
        : `${verifiedSite.name} check-in verified.`;
    // Reset verification and site labels to their successful-check-in state.
    document.getElementById("checkin-dialog-title").textContent =
      "Check-in complete!";
    document.getElementById("verification-status").classList.remove("unverified");
    document.getElementById("verification-status").hidden = false;
    document.getElementById("completion-site-separator").textContent = " · ";
    document.getElementById("completion-site-separator").hidden = false;
    document.getElementById("completion-verification").hidden = false;
    document.getElementById("completion-stamp-label").hidden = false;
    document.getElementById("completion-quest").hidden = false;
    // Fill the popup with the verified site's details.
    document.getElementById("completion-site-label").textContent = "Spot";
    document.getElementById("completion-site-label").hidden = true;
    document.getElementById("completion-site").textContent = verifiedSite.name;
    // Show stamp status and distance for this verified site.
    document.getElementById("completion-stamp-label").textContent = stampUnavailable
      ? "Stamp status:"
      : "Stamp earned:";
    document.getElementById("completion-stamp").textContent = stampUnavailable
      ? "No stamp configured"
      : alreadyCollected
        ? `${verifiedSite.stamp} (already collected)`
        : verifiedSite.stamp;
    document.getElementById("completion-distance-row").hidden = false;
    document.getElementById("completion-distance").textContent =
      formatDistance(verifiedSite.distance);
    document.getElementById("verification-status").textContent = "Photo location verified on the map";
    document.getElementById("completion-verification").textContent =
      "GPS matched a registered tourist spot";
    // Open the popup after updating its verified check-in details.
    elements.previewCaption.textContent =
      "Check-in complete. Take another photo or scan a QR code.";
    if (!elements.dialog.open) elements.dialog.showModal();
  }

  // Sets up the camera page, connects its buttons, and starts camera and GPS.
  function init() {
    // Set a camera status while the live preview starts.
    elements.previewCaption.textContent = "Requesting camera access…";
    // Ask for camera access immediately. Location is requested only after a photo is taken.
    startCamera();
    elements.siteName.textContent = "Finding nearest spot…";
    elements.siteType.textContent = "Waiting for your location.";
    elements.rangeTag.textContent = "Locating you…";
    elements.rewardTitle.textContent = "Nearby site rewards";
    elements.rewardDescription.textContent = "Finding the closest tourist spot.";
    window.addEventListener("tourtrail-checkin-synced", (event) => {
      if (!queuedPhotoId || event.detail?.id !== queuedPhotoId) return;
      queuedPhotoId = null;
      document.getElementById("verification-status").textContent =
        event.detail.verified ? "Uploaded · Verified" : "Uploaded · Unverified";
      document.getElementById("completion-verification").textContent =
        event.detail.verified
          ? "Your check-in was uploaded and verified by the server."
          : "Your photo was uploaded, but the location could not be verified.";
      elements.rewardTitle.textContent = event.detail.verified
        ? "Check-in uploaded"
        : "Photo uploaded · Not verified";
      elements.rewardDescription.textContent =
        "Your saved check-in has been sent to the server.";
      elements.previewCaption.textContent = "Check-in uploaded successfully.";
    });

    // Connect the shutter to photo capture and show any failure in the preview.
    elements.captureButton.addEventListener("click", () => {
      capturePhoto().catch((error) => {
        console.error("Could not capture the photo:", error);
        elements.previewCaption.textContent = "Could not save the photo. Please try again.";
      });
    });
    elements.photoMode.addEventListener("click", () => setCameraMode("photo"));
    elements.qrMode.addEventListener("click", () => setCameraMode("qr"));
    elements.qrRescan.addEventListener("click", () => setCameraMode("qr"));
    elements.cameraRetry.addEventListener("click", startCamera);
    // Let the visitor retry verification using the same captured photo.
    elements.verifyRetry.addEventListener("click", () => {
      // Retry the same captured photo rather than capturing a new one.
      verifyCheckIn(pendingPhoto);
    });
    // Connect the reward button to the verified-site award flow.
    elements.earnStampButton.addEventListener("click", () => {
      earnStamp().catch((error) => {
        console.error("Could not award the verified stamp:", error);
        elements.previewCaption.textContent =
          "The stamp could not be saved. Please try again.";
      });
    });
    /** Closes the completion dialog and resets transient check-in state. */
    // Reset temporary state and popup styling when the visitor closes the dialog.
    const closeCheckInDialog = () => {
      if (elements.dialog.open) elements.dialog.close();
      pendingPhoto = null;
      verifiedSite = null;
      checkInComplete = false;
      completionVerified = false;
      elements.capturedPhoto.hidden = true;
      elements.capturedPhoto.removeAttribute("src");
      elements.video.hidden = false;
      elements.panel.classList.remove("is-captured");
      setCameraMode("photo");
      // Restore default dialog styling so a later check-in starts in a clean state.
      document.getElementById("checkin-dialog-title").textContent =
        "Check-in complete!";
      document.getElementById("verification-status").classList.remove("unverified");
      document.getElementById("completion-distance-row").hidden = false;
      updateStepStates();
      updateCameraControls();
    };
    // Close the dialog when its buttons or backdrop are clicked.
    document.getElementById("close-checkin-dialog").addEventListener("click", closeCheckInDialog);
    document.getElementById("done-checkin-dialog").addEventListener("click", closeCheckInDialog);
    elements.dialog.addEventListener("click", (event) => {
      if (event.target === elements.dialog) closeCheckInDialog();
    });

    // Stop GPS and camera hardware when the visitor leaves the camera page.
    window.addEventListener("pagehide", () => {
      // Release hardware resources when navigating away from the camera page.
      if (locationWatch !== null && navigator.geolocation) {
        navigator.geolocation.clearWatch(locationWatch);
      }
      stopQrScanning();
      cameraStream?.getTracks().forEach((track) => track.stop());
    }, { once: true });
  }

  init();
})();
