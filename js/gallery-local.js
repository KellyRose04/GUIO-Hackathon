(() => {
  const grid = document.getElementById("photo-grid");
  const template = document.getElementById("tpl-photo");
  const loading = document.getElementById("mine-loading");
  const empty = document.getElementById("mine-empty");
  const error = document.getElementById("mine-error");
  const count = document.getElementById("gallery-count");
  if (!grid || !template || !loading || !empty || !error || !count) return;

  function formatPhotoDateTime(value) {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return "";

    const dateText = new Intl.DateTimeFormat("en-US", {
      month: "long",
      day: "numeric",
      year: "numeric",
    }).format(date);
    const timeText = new Intl.DateTimeFormat("en-US", {
      hour: "numeric",
      minute: "2-digit",
      hour12: true,
    }).format(date);

    return `${dateText} | ${timeText}`;
  }

  async function renderLocalPhotos() {
    try {
      const photos = await window.GUIOGalleryStorage.getPhotos();
      grid.replaceChildren();
      photos.forEach((photo) => {
        const card = template.content.firstElementChild.cloneNode(true);
        card.dataset.photoId = photo.id;
        const button = card.querySelector(".photo-open");
        const image = card.querySelector(".photo-img");
        button.setAttribute("aria-label", "View saved photo");
        image.src = photo.imageUrl;
        image.alt = "Saved photo";
        card.querySelector(".photo-location").remove();
        card.querySelector(".caption").textContent = formatPhotoDateTime(photo.takenAt);
        grid.appendChild(card);
      });

      loading.hidden = true;
      error.hidden = true;
      empty.hidden = photos.length > 0;
      count.textContent = photos.length === 1 ? "1 photo" : `${photos.length} photos`;
    } catch (loadError) {
      console.error("Could not load photos saved on this device:", loadError);
      loading.hidden = true;
      empty.hidden = true;
      error.hidden = false;
      error.firstChild.textContent = "Could not load photos saved on this device. ";
      count.textContent = "";
    }
  }

  document.addEventListener("DOMContentLoaded", renderLocalPhotos, { once: true });
})();
