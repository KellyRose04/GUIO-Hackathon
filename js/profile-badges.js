(() => {
  const badgesGrid = document.querySelector("#badges .badges-grid");
  const badgesCount = document.querySelector("#badges .badges-count");
  const preview = document.getElementById("stamp-preview");
  if (!badgesGrid || !badgesCount || !preview) return;

  const previewField = (name) => preview.querySelector(`[data-preview="${name}"]`);

  function iconUrl(icon) {
    const value = String(icon || "").trim();
    if (!value) return "../assets/pin.png";
    if (/^https?:\/\//i.test(value) || value.startsWith("/") || value.startsWith("../")) return value;
    return `../assets/${value}`;
  }

  function resetPreview() {
    previewField("tag").textContent = "Badge";
    previewField("title").textContent = "Your Badge Collection";
    previewField("desc").textContent = "Select an unlocked badge to see its details.";
    previewField("icon").src = "../assets/pin.png";
    previewField("rarity-row").hidden = true;
    previewField("meta").hidden = true;
    previewField("meta").textContent = "";
    previewField("map").hidden = false;
  }

  function selectBadge(button, badge) {
    badgesGrid.querySelectorAll(".badge-item.is-selected").forEach((item) => {
      item.classList.remove("is-selected");
      item.setAttribute("aria-pressed", "false");
    });
    button.classList.add("is-selected");
    button.setAttribute("aria-pressed", "true");

    previewField("tag").textContent = "Badge";
    previewField("title").textContent = badge.name || "Badge";
    previewField("desc").textContent = badge.description || "No description available for this badge.";
    previewField("icon").src = badge.key === "welcome-explorer"
      ? "../assets/guio_badge_logo.png"
      : iconUrl(badge.icon);

    const rarity = String(badge.rarity || "").trim();
    previewField("rarity-row").hidden = !rarity;
    previewField("rarity").textContent = rarity;

    previewField("meta").hidden = !badge.awarded_on;
    previewField("meta").textContent = badge.awarded_on
      ? `Collected on ${badge.awarded_on}`
      : "";
    previewField("map").hidden = true;
  }

  function createLockIcon() {
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.classList.add("badge-lock-icon");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("aria-hidden", "true");

    const shackle = document.createElementNS("http://www.w3.org/2000/svg", "path");
    shackle.setAttribute("d", "M7 10V7a5 5 0 0 1 10 0v3");
    const body = document.createElementNS("http://www.w3.org/2000/svg", "rect");
    body.setAttribute("x", "5");
    body.setAttribute("y", "10");
    body.setAttribute("width", "14");
    body.setAttribute("height", "11");
    body.setAttribute("rx", "2");
    svg.append(shackle, body);
    return svg;
  }

  function renderBadges(badges) {
    const catalog = Array.isArray(badges) ? badges : [];
    const earned = catalog.filter((badge) => badge.earned);
    badgesGrid.replaceChildren();
    badgesCount.textContent = `${earned.length} / ${catalog.length} earned`;

    catalog.forEach((badge) => {
      const isEarned = badge.earned === true;
      const item = document.createElement(isEarned ? "button" : "div");
      item.className = `badge-item ${isEarned ? "unlocked" : "locked"}`;
      if (isEarned) {
        item.type = "button";
        item.dataset.badgeKey = badge.key || "";
        item.setAttribute("aria-pressed", "false");
      } else {
        item.setAttribute("role", "group");
        item.setAttribute("aria-label", "Secret badge. Finish a quest to unlock.");
      }

      const circle = document.createElement("span");
      circle.className = "badge-circle";
      if (isEarned) {
        const image = document.createElement("img");
        image.src = badge.key === "welcome-explorer"
          ? "../assets/guio_badge_logo.png"
          : iconUrl(badge.icon);
        image.alt = "";
        image.width = 24;
        image.height = 24;
        circle.appendChild(image);
      } else {
        circle.appendChild(createLockIcon());
      }

      const label = document.createElement("span");
      label.className = "badge-label";
      label.textContent = isEarned ? (badge.name || "Badge") : "Secret Badges";
      item.append(circle, label);
      if (isEarned) item.addEventListener("click", () => selectBadge(item, badge));
      badgesGrid.appendChild(item);
    });
  }

  async function loadBadges() {
    try {
      if (!window.GUIOAccount) {
        throw new Error("Your anonymous account could not be initialized. Reload the page.");
      }
      const response = await fetch("../api/badges.php", {
        headers: window.GUIOAccount.apiHeaders({ Accept: "application/json" }),
        cache: "no-store",
      });
      const payload = await response.json();
      if (!response.ok || !Array.isArray(payload.badges)) {
        throw new Error(payload.error || "Your badges could not be loaded.");
      }
      renderBadges(payload.badges);
    } catch (error) {
      console.error("Could not load profile badges:", error);
      badgesGrid.textContent = "Your badges could not be loaded.";
    }
  }

  resetPreview();
  document.addEventListener("DOMContentLoaded", loadBadges, { once: true });
})();
