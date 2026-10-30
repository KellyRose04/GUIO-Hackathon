(() => {
  const STORAGE_KEY = "guio-anonymous-device-id";
  const ID_PATTERN = /^[a-f0-9]{32}$/;

  function createDeviceId() {
    if (!window.crypto?.getRandomValues) {
      throw new Error("Secure random IDs are unavailable in this browser.");
    }

    const bytes = new Uint8Array(16);
    window.crypto.getRandomValues(bytes);
    return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  }

  let deviceId = null;
  let identityError = null;
  try {
    const storedId = window.localStorage.getItem(STORAGE_KEY);
    if (storedId && ID_PATTERN.test(storedId)) {
      deviceId = storedId;
    } else {
      deviceId = createDeviceId();
      window.localStorage.setItem(STORAGE_KEY, deviceId);
    }
  } catch (error) {
    deviceId = null;
    identityError = new Error("GUIO could not save this device's anonymous ID. Enable browser storage and reload.");
    identityError.cause = error;
    console.error(identityError.message, error);
  }

  const account = Object.freeze({
    deviceId,
    identityError,
    apiHeaders(extraHeaders = {}) {
      if (!deviceId) {
        throw identityError || new Error("This device's anonymous ID is unavailable.");
      }
      return { ...extraHeaders, "X-GUIO-Device-ID": deviceId };
    },
    apiUrl(path) {
      return new URL(path, window.location.href).href;
    },
  });

  window.GUIOAccount = account;
})();
