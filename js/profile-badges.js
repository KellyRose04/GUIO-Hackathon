(() => {
  const badgesGrid = document.querySelector("#badges .badges-grid");
  const badgesCount = document.querySelector("#badges .badges-count");
  const preview = document.getElementById("stamp-preview");
  if (!badgesGrid || !badgesCount || !preview) return;

  const field = (name) => preview.querySelector(`[data-preview="${name}"]`);

  function iconUrl(icon) {
    const value = String(icon || "").trim();
    if (!value) return "../assets/pin.png";
    if (/^https?:\/\//i.test(value) || value.startsWith("/") || value.startsWith("../")) return value;
    return `../assets/${value}`;
  }

  function showBadge(badge, button) {
    badgesGrid.querySelectorAll(".badge-item.is-selected").forEach((item) => {
      item.classList.remove("is-selected");
    });
    button.classList.add("is-selected");

    field("tag").textContent = "Badge";
    field("title").textContent = badge.name;
    field("desc").textContent = badge.description || "No description yet.";
    field("icon").src = iconUrl(badge.icon);
    field("rarity-row").hidden = !badge.rarity;
    field("rarity").textContent = badge.rarity || "";
    field("meta").hidden = !badge.awarded_on;
    field("meta").textContent = badge.awarded_on ? `Collected on ${badge.awarded_on}` : "";
    field("map").hidden = true;
  }

  function renderBadges(badges) {
    const earned = (Array.isArray(badges) ? badges : []).filter((badge) => badge.earned);
    badgesGrid.replaceChildren();
    badgesCount.textContent = `${earned.length} earned`;

    earned.forEach((badge) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "badge-item unlocked";
      button.dataset.badgeKey = badge.key || "";

      const circle = document.createElement("span");
      circle.className = "badge-circle";
      const image = document.createElement("img");
      image.src = iconUrl(badge.icon);
      image.alt = "";
      image.width = 24;
      image.height = 24;
      circle.appendChild(image);

      const label = document.createElement("span");
      label.className = "badge-label";
      label.textContent = badge.name || "Badge";
      button.append(circle, label);
      button.addEventListener("click", () => showBadge(badge, button));
      badgesGrid.appendChild(button);
    });

    const welcomeBadge = earned.find((badge) => badge.key === "welcome-explorer");
    if (welcomeBadge) {
      const welcomeButton = badgesGrid.querySelector('[data-badge-key="welcome-explorer"]');
      showBadge(welcomeBadge, welcomeButton);
    }
  }

  async function loadBadges() {
    try {
      if (!window.GUIOAccount) {
        throw new Error("Your anonymous account could not be initialized. Reload the page.");
      }
      const response = await fetch("../api/passport.php", {
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

  document.addEventListener("DOMContentLoaded", loadBadges, { once: true });
})();
