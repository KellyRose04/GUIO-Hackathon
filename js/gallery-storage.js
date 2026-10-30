(() => {
  const DATABASE_NAME = "guio-gallery";
  const STORE_NAME = "photos";
  const DATABASE_VERSION = 1;

  function openDatabase() {
    return new Promise((resolve, reject) => {
      const request = window.indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
      request.onupgradeneeded = () => {
        const database = request.result;
        if (!database.objectStoreNames.contains(STORE_NAME)) {
          database.createObjectStore(STORE_NAME, { keyPath: "id" });
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error("Could not open your local photo gallery."));
      request.onblocked = () => reject(new Error("Your local photo gallery is busy in another tab."));
    });
  }

  async function savePhoto(photo) {
    if (!photo || typeof photo.id !== "string" || typeof photo.imageUrl !== "string") {
      throw new Error("A valid photo is required to save to My Gallery.");
    }

    const database = await openDatabase();
    try {
      await new Promise((resolve, reject) => {
        const transaction = database.transaction(STORE_NAME, "readwrite");
        transaction.objectStore(STORE_NAME).put({
          id: photo.id,
          imageUrl: photo.imageUrl,
          takenAt: photo.takenAt || new Date().toISOString(),
        });
        transaction.oncomplete = resolve;
        transaction.onerror = () => reject(transaction.error || new Error("Could not save your photo to My Gallery."));
        transaction.onabort = () => reject(transaction.error || new Error("Saving your photo to My Gallery was interrupted."));
      });
    } finally {
      database.close();
    }
  }

  async function getPhotos() {
    const database = await openDatabase();
    try {
      return await new Promise((resolve, reject) => {
        const transaction = database.transaction(STORE_NAME, "readonly");
        const request = transaction.objectStore(STORE_NAME).getAll();
        request.onsuccess = () => {
          const photos = request.result.sort(
            (left, right) => Date.parse(right.takenAt) - Date.parse(left.takenAt)
          );
          resolve(photos);
        };
        request.onerror = () => reject(request.error || new Error("Could not read your local photo gallery."));
      });
    } finally {
      database.close();
    }
  }

  window.GUIOGalleryStorage = Object.freeze({ savePhoto, getPhotos });
})();
