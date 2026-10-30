(() => {
  const STORAGE_KEY = "anonymous_id";
  const LEGACY_STORAGE_KEY = "guio-anonymous-device-id";
  const UUID_PATTERN = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
  const LEGACY_ID_PATTERN = /^[a-f0-9]{32}$/i;

  function formatUuid(hex) {
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  }

  function normalizeAnonymousId(value) {
    if (typeof value !== "string") return null;
    if (UUID_PATTERN.test(value)) return value.toLowerCase();
    if (LEGACY_ID_PATTERN.test(value)) return formatUuid(value.toLowerCase());
    return null;
  }

  function createAnonymousId() {
    if (typeof window.crypto?.randomUUID === "function") {
      return window.crypto.randomUUID();
    }
    if (!window.crypto?.getRandomValues) {
      throw new Error("Secure random IDs are unavailable in this browser.");
    }

    const bytes = new Uint8Array(16);
    window.crypto.getRandomValues(bytes);
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    return formatUuid(Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(""));
  }

  let anonymousId = null;
  let identityError = null;
  try {
    const storedId = window.localStorage.getItem(STORAGE_KEY)
      || window.localStorage.getItem(LEGACY_STORAGE_KEY);
    anonymousId = normalizeAnonymousId(storedId) || createAnonymousId();
    window.localStorage.setItem(STORAGE_KEY, anonymousId);
    window.localStorage.removeItem(LEGACY_STORAGE_KEY);
  } catch (error) {
    anonymousId = null;
    identityError = new Error("GUIO could not save this device's anonymous ID. Enable browser storage and reload.");
    identityError.cause = error;
    console.error(identityError.message, error);
  }

  const account = Object.freeze({
    anonymousId,
    identityError,
    apiHeaders(extraHeaders = {}) {
      if (!anonymousId) {
        throw identityError || new Error("This device's anonymous ID is unavailable.");
      }
      return { ...extraHeaders, "X-GUIO-Anonymous-ID": anonymousId };
    },
    apiUrl(path) {
      return new URL(path, window.location.href).href;
    },
  });

  window.GUIOAccount = account;
})();
