(() => {
    const DEFAULT_CENTER = [16.4023, 120.5960];
    const SITES_ENDPOINT = "api/sites.php";

    function createMap(elementId, { center = DEFAULT_CENTER, zoom = 14 } = {}) {
        const map = L.map(elementId, { zoomControl: false }).setView(center, zoom);

        L.control.zoom({ position: "topright" }).addTo(map);
        L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
            maxZoom: 19,
            attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
        }).addTo(map);

        return map;
    }

    async function fetchSites({ category = "all", search = "", sort = "nearest", coordinates = null } = {}) {
        const params = new URLSearchParams({ category, search, sort });
        if (Array.isArray(coordinates) && coordinates.length === 2) {
            params.set("lat", String(coordinates[0]));
            params.set("lng", String(coordinates[1]));
        }

        const relativeUrl = `${SITES_ENDPOINT}?${params.toString()}`;
        const requestUrl = window.TourTrailAccount
            ? window.TourTrailAccount.apiUrl(relativeUrl)
            : relativeUrl;
        const response = await fetch(requestUrl, {
            headers: { Accept: "application/json" },
            cache: "no-store",
        });

        let payload;
        try {
            payload = await response.json();
        } catch (error) {
            const invalidResponse = new Error("The map API returned an invalid response.");
            invalidResponse.status = response.status;
            throw invalidResponse;
        }

        if (!response.ok || payload.status !== "success") {
            const apiError = new Error(payload.error || `Sites request failed (${response.status}).`);
            apiError.status = response.status;
            throw apiError;
        }

        return payload;
    }

    window.TourTrailMapApi = Object.freeze({ createMap, fetchSites });
})();
