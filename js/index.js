document.addEventListener("DOMContentLoaded", () => {
    // 1. Initial coordinates for Baguio City [Latitude, Longitude]
    const baguioCoords = [16.4023, 120.5960];
    const mapApi = window.TourTrailMapApi;
    const map = mapApi.createMap("map", { center: baguioCoords, zoom: 14 });

    let userCoords = null;
    let userLocationMarker = null;
    let userAccuracyCircle = null;

    // 2. Custom Marker Icon Generator (Using raw transparent PNG icons)
    function createCustomIcon(status) {
        let iconPath = 'assets/pin.png';

        if (status === 'active_quest') {
            iconPath = 'assets/star-icon.png';
        } else if (status === 'visited') {
            iconPath = 'assets/marker-check.png';
        } 

        const html = `<div style="
            width: 32px; 
            height: 32px; 
            display: flex; 
            align-items: center; 
            justify-content: center;
            filter: drop-shadow(0 2px 4px rgba(0,0,0,0.25));">
            <img src="${iconPath}" style="width: 100%; height: 100%; object-fit: contain;" />
        </div>`;

        return L.divIcon({
            html: html,
            className: '',
            iconSize: [32, 32],
            iconAnchor: [16, 16]
        });
    }

    let loadedSites = [];
    let markersMap = {}; 
    const markersGroup = L.layerGroup().addTo(map);

    // 4. Fetch map sites through the extracted map API client.
    function fetchSites() {
        mapApi.fetchSites({ coordinates: userCoords })
            .then(res => {
                if (window.TourTrailAccount) window.TourTrailAccount.markServerOnline();
                try {
                    localStorage.setItem('tourtrail-sites-cache', JSON.stringify(res.data));
                } catch (error) {
                    console.error("Could not save the latest site snapshot:", error);
                }
                processAndRenderSites(res.data, res.active_quests);
            })
            .catch(err => {
                console.warn("Server unavailable. Loading saved site data...", err);
                const serverUnavailable =
                    !navigator.onLine ||
                    err.name === "TypeError" ||
                    (Number.isInteger(err.status) && err.status >= 500);
                if (serverUnavailable && window.TourTrailAccount) {
                    window.TourTrailAccount.markServerOffline();
                }

                let cachedSites = [];
                try {
                    const cached = JSON.parse(localStorage.getItem('tourtrail-sites-cache') || '[]');
                    if (Array.isArray(cached)) cachedSites = cached;
                } catch (cacheError) {
                    console.error("Could not read the last loaded site data:", cacheError);
                }

                const renderSavedSites = (sites) => processAndRenderSites(sites);

                if (cachedSites.length) {
                    renderSavedSites(cachedSites);
                } else {
                    console.warn("No saved site snapshot is available yet.");
                    renderNoActiveQuest();
                }
            });
    }

    window.addEventListener("storage", (event) => {
        if (event.key === "guio-active-quest-updated") {
            fetchSites();
        }
    });

    // Helper to render sites cleanly whether the response is fresh or saved.
    function processAndRenderSites(sites, quests = []) {
        loadedSites = sites;
        const activeQuest = Array.isArray(quests) && quests.length ? quests[0] : null;
        renderMapMarkers(loadedSites, activeQuest);
        if (activeQuest) {
            renderSidebarQuests(quests);
        } else {
            renderNoActiveQuest();
        }
    }

    // 5b. Render Quest Card Data from Database
    function renderSidebarQuests(quests) {
        const container = document.getElementById('sidebar-quest-card-container');
        if (!container) return;

        container.innerHTML = '';

        if (!Array.isArray(quests) || quests.length === 0) {
            renderNoActiveQuest();
            return;
        }

        const quest = quests[0];
        const unit = quest.quest_type === 'streak' ? 'days' : 'sites';
        const daysText = quest.days_left ? ` · ${quest.days_left} days left` : '';

        const card = document.createElement('div');
        card.className = 'quest-card-banner';
        card.setAttribute('role', 'button');
        card.tabIndex = 0;
        card.setAttribute('aria-label', `View details for ${quest.title}`);

        card.innerHTML = `
            <div class="quest-banner-header">
                <div class="quest-flag-icon">🚩</div>
                <div class="quest-banner-title-group">
                    <div class="quest-banner-title">Quest: ${quest.title}</div>
                    <div class="quest-banner-sub">${quest.description}${daysText}</div>
                </div>
                <div class="quest-banner-chevron">›</div>
            </div>
            <div class="quest-banner-progress-row">
                <progress class="quest-banner-progress-bar" value="${quest.progress_count}" max="${quest.target_count}"></progress>
                <div class="quest-banner-count">${quest.progress_count} / ${quest.target_count} ${unit}</div>
            </div>
        `;

        const showQuestDetails = () => {
            focusQuestLocation(quest);
            openQuestsModal(quests);
        };
        card.addEventListener('click', showQuestDetails);
        card.addEventListener('keydown', (event) => {
            if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                showQuestDetails();
            }
        });

        container.appendChild(card);
        renderNextLocation(quest);
    }

    function focusQuestLocation(quest) {
        const nextStop = Array.isArray(quest?.stops)
            ? quest.stops.find(stop => stop.stop_state === 'next' || stop.state === 'next')
            : null;
        const siteId = nextStop?.site_id ?? quest?.next_site_id ?? quest?.next_stop_site_id;
        const site = siteId == null
            ? null
            : loadedSites.find(candidate => String(candidate.id) === String(siteId));

        if (!site) {
            console.warn("The active quest location is not available on the map.");
            return;
        }

        focusSiteOnMap(site);
    }

    function renderNextLocation(quest) {
        const container = document.getElementById('next-location-container');
        if (!container) return;

        container.replaceChildren();

        const questStops = Array.isArray(quest?.stops) ? quest.stops : [];
        const currentStop = questStops.find(
            stop => stop.stop_state === 'next' || stop.state === 'next'
        ) || questStops[0];
        const currentSiteId = currentStop?.site_id ?? quest?.next_site_id ?? quest?.next_stop_site_id;
        const currentQuestSite = currentSiteId == null
            ? null
            : loadedSites.find(site => String(site.id) === String(currentSiteId));
        const currentLatitude = Number(currentQuestSite?.latitude);
        const currentLongitude = Number(currentQuestSite?.longitude);
        const nearbySite = currentQuestSite
            && Number.isFinite(currentLatitude)
            && Number.isFinite(currentLongitude)
            ? loadedSites
                .filter(site => String(site.id) !== String(currentQuestSite.id))
                .map(site => ({
                    site,
                    distance: distanceBetween(
                        currentLatitude,
                        currentLongitude,
                        Number(site.latitude),
                        Number(site.longitude)
                    )
                }))
                .filter(candidate => Number.isFinite(candidate.distance))
                .sort((a, b) => a.distance - b.distance)[0]
            : null;
        const resolvedSite = nearbySite?.site || null;
        const title = resolvedSite?.title || (quest ? 'No nearby location' : 'No active quest');

        const card = document.createElement('div');
        card.className = `next-location-card${resolvedSite ? '' : ' is-empty'}`;
        if (resolvedSite) {
            card.setAttribute('role', 'button');
            card.tabIndex = 0;
            card.setAttribute('aria-label', `Show ${resolvedSite.title} on map`);
        }

        const pin = document.createElement('span');
        pin.className = 'next-location-pin';
        pin.setAttribute('aria-hidden', 'true');
        pin.textContent = '⌖';

        const copy = document.createElement('div');
        copy.className = 'next-location-copy';
        const titleElement = document.createElement('h3');
        titleElement.textContent = title;
        const meta = document.createElement('p');
        const locationMeta = [
            resolvedSite?.category ? formatCategoryLabel(resolvedSite.category) : '',
            nearbySite ? `${nearbySite.distance.toFixed(1)} km from ${currentQuestSite.title}` : ''
        ].filter(Boolean);
        if (locationMeta.length) {
            meta.textContent = locationMeta.join(' · ');
        } else if (quest?.quest_type === 'streak') {
            meta.textContent = 'Keep checking in to continue this quest.';
        } else if (quest) {
            meta.textContent = `No other locations found near ${currentQuestSite?.title || 'this quest'}.`;
        } else {
            meta.textContent = 'Start a quest to see your next location here.';
        }
        copy.append(titleElement, meta);
        card.append(pin, copy);

        if (resolvedSite) {
            const focusLocation = () => focusSiteOnMap(resolvedSite);
            card.addEventListener('click', focusLocation);
            card.addEventListener('keydown', (event) => {
                if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault();
                    focusLocation();
                }
            });
        }

        container.append(card);
    }

    function distanceBetween(latitudeA, longitudeA, latitudeB, longitudeB) {
        if (![latitudeA, longitudeA, latitudeB, longitudeB].every(Number.isFinite)) {
            return Number.NaN;
        }

        const radians = degrees => degrees * Math.PI / 180;
        const latitudeDifference = radians(latitudeB - latitudeA);
        const longitudeDifference = radians(longitudeB - longitudeA);
        const haversine = Math.sin(latitudeDifference / 2) ** 2
            + Math.cos(radians(latitudeA))
            * Math.cos(radians(latitudeB))
            * Math.sin(longitudeDifference / 2) ** 2;

        return 6371 * 2 * Math.atan2(Math.sqrt(haversine), Math.sqrt(1 - haversine));
    }

    function focusSiteOnMap(site) {
        const latitude = Number(site?.latitude);
        const longitude = Number(site?.longitude);
        if (!site || !Number.isFinite(latitude) || !Number.isFinite(longitude)) {
            console.warn("The selected location has invalid coordinates.");
            return;
        }

        map.flyTo([latitude, longitude], 16);
        markersMap[site.id]?.openPopup();
    }

    function renderNoActiveQuest() {
        const container = document.getElementById('sidebar-quest-card-container');
        if (container) {
            container.innerHTML = `
                <div class="quest-card-banner" style="background: var(--white);">
                    <div class="quest-banner-header">
                        <div class="quest-flag-icon">🚩</div>
                        <div class="quest-banner-title-group">
                            <div class="quest-banner-title">No Active Quests</div>
                            <div class="quest-banner-sub">Check back later for new quests</div>
                        </div>
                    </div>
                </div>
            `;
        }
        renderNextLocation(null);
    }

    // Populate and display the active quests list in the Popup
    function openQuestsModal(quests) {
    const modal = document.getElementById('quest-modal-overlay');
    const listContainer = document.getElementById('quest-modal-list');
    if (!modal || !listContainer) return;

    listContainer.innerHTML = '';

    quests.forEach(quest => {
        const unit = quest.quest_type === 'streak' ? 'day(s)' : 'site(s)';
        const item = document.createElement('div');
        item.className = 'modal-quest-item';

        item.innerHTML = `
            <div class="title">${quest.title}</div>
            <div class="desc">${quest.description}</div>
            <progress value="${quest.progress_count}" max="${quest.target_count}"></progress>
            <div class="meta">
                <span>${quest.progress_count} / ${quest.target_count} ${unit}</span>
            </div>
        `;

        if (quest.quest_type === 'sites' && loadedSites && loadedSites.length > 0) {
            const nextBox = document.createElement('div');
            nextBox.className = 'quest-next-destination-box';

            const nextMission = Array.isArray(quest.stops)
                ? quest.stops.find(stop => stop.stop_state === 'next' || stop.state === 'next') || quest.stops[0]
                : null;
            const nextSite = nextMission?.site_id != null
                ? loadedSites.find(site => String(site.id) === String(nextMission.site_id))
                : null;
            const missionTitle = nextMission?.title || 'Current mission';
            const missionLocation = nextSite?.title || nextMission?.site_title || nextMission?.location || 'Explore the next destination';
            const missionDescription = nextMission?.description || quest.description || 'Complete this mission to continue the quest.';

            nextBox.innerHTML = `
                <span class="quest-next-label">Mission details</span>
                <div class="quest-next-copy">
                    <strong>${missionTitle}</strong>
                    <span>${missionLocation}</span>
                    <small>${missionDescription}</small>
                </div>
            `;

            item.appendChild(nextBox);
        }

        listContainer.appendChild(item);
    });

    modal.hidden = false;
}

    // Close Modal Event Listeners
    document.getElementById('quest-modal-close')?.addEventListener('click', () => {
        document.getElementById('quest-modal-overlay').hidden = true;
    });

    document.getElementById('quest-modal-overlay')?.addEventListener('click', (e) => {
        if (e.target.id === 'quest-modal-overlay') {
            e.target.hidden = true;
        }
    });

// 6. Render Pins on Map
function renderMapMarkers(sites, activeQuest = null) {
    markersGroup.clearLayers();
    markersMap = {};
    const nextStop = activeQuest?.stops?.find(
        (stop) => stop.stop_state === "next" || stop.state === "next"
    );
    const nextSiteId = nextStop?.site_id
        ?? activeQuest?.next_site_id
        ?? activeQuest?.next_stop_site_id
        ?? null;
    let activeQuestMarker = null;

    sites.forEach((site) => {
        const isActiveQuestStop = nextSiteId != null && String(site.id) === String(nextSiteId);
        const marker = L.marker([site.latitude, site.longitude], {
            icon: createCustomIcon(isActiveQuestStop ? "active_quest" : site.status)
        });

        markersMap[site.id] = marker;
        if (isActiveQuestStop) activeQuestMarker = marker;

        const metaText = `${site.formatted_distance} · ${formatCategoryLabel(site.category)}${site.is_hidden_gem ? " · Hidden gem" : ""}`;

        const popupContent = `
            <div class="popup-card wireframe-popup-clean">
                <div class="popup-body">
                    <h3 class="popup-title-clean">${site.title}</h3>
                    <p class="popup-meta-clean">${metaText}</p>
                    <div class="popup-actions-clean">
                        <div class="btn-wrapper">
                            <button class="details-btn-clean" data-site-id="${site.id}">Details</button>
                        </div>
                    </div>
                </div>
            </div>
        `;

        marker.bindPopup(popupContent);
        markersGroup.addLayer(marker);
    });

    if (activeQuestMarker) {
        map.flyTo(activeQuestMarker.getLatLng(), 16);
        activeQuestMarker.openPopup();
    }
}

// Global Event Delegation for Popup Details Buttons
const mapContainer = document.getElementById("map");
if (mapContainer) {
    mapContainer.addEventListener("click", (e) => {
        const detailsBtn = e.target.closest(".details-btn-clean");
        if (detailsBtn) {
            const siteId = detailsBtn.getAttribute("data-site-id");
            const targetSite = loadedSites.find((s) => s.id == siteId);
            if (targetSite) {
                openSiteDrawer(targetSite);
                map.closePopup();
            }
        }
    });
}

    // 8. Drawer Management Functions
    window.closeSiteDrawer = function() {
        const drawer = document.getElementById('site-details-drawer');
        if (drawer) {
            drawer.classList.remove('open');
        }
    }

    function openSiteDrawer(site) {
        const drawer = document.getElementById('site-details-drawer');
        if (!drawer) return;

        // Populate Chips
        const chipsContainer = document.getElementById('drawer-chips');
        let chipsHtml = '';
        if (site.is_hidden_gem == 1) {
            chipsHtml += `<span class="chip-gem">★ Hidden gem</span>`;
        }
        chipsHtml += `<span class="chip-category">${formatCategoryLabel(site.category)}</span>`;
        chipsContainer.innerHTML = chipsHtml;

        // Populate Content
        document.getElementById('drawer-img').style.backgroundImage = `url('${site.image_url}')`;
        document.getElementById('drawer-title').textContent = site.title;
        document.getElementById('drawer-sub').textContent = `${site.formatted_distance} · Open ${site.operating_hours} · ${site.entrance_fee}`;
        document.getElementById('drawer-desc').textContent = site.description;

        drawer.classList.add('open');

        const closeBtn = document.getElementById('drawer-close-btn');
        if (closeBtn) {
            closeBtn.onclick = (e) => {
                e.stopPropagation();
                closeSiteDrawer();
            };
        }
    }

    // Keyboard & Click-Outside Listeners for Drawer
    document.addEventListener('keydown', (e) => {
        const drawer = document.getElementById('site-details-drawer');
        if (e.key === 'Escape' && drawer && drawer.classList.contains('open')) {
            closeSiteDrawer();
        }
    });

    const mapView = document.querySelector('.map-view');
    if (mapView) {
        mapView.addEventListener('click', (e) => {
            const drawer = document.getElementById('site-details-drawer');
            if (drawer && drawer.classList.contains('open')) {
                const isClickInsideDrawer = drawer.contains(e.target);
                const isDetailsBtn = e.target.classList.contains('details-btn-clean');
                if (!isClickInsideDrawer && !isDetailsBtn) {
                    closeSiteDrawer();
                }
            }

        });
    }

    function formatCategoryLabel(value) {
        const label = String(value || '').trim().replace(/[_-]+/g, ' ').replace(/\s+/g, ' ');
        return label.replace(/\b\w/g, (letter) => letter.toUpperCase());
    }

    // 8. Inject Map Legend Bar
    if (mapView) {
        const legend = document.createElement('div');
        legend.className = 'map-legend';
        legend.innerHTML = `
            <div class="legend-item"><span class="legend-dot new"></span> New</div>
            <div class="legend-item"><span class="legend-dot visited">✓</span> Visited</div>
            <div class="legend-item"><span class="legend-dot gem">★</span> Hidden gem</div>
        `;
        mapView.appendChild(legend);
    }


    // Initialize GPS tracking and fetch sites based on real location
    function updateUserLocation(position) {
        const lat = position.coords.latitude;
        const lng = position.coords.longitude;
        const accuracy = position.coords.accuracy;
        userCoords = [lat, lng];

        // Draw or update the "You are here" blue marker on the map
        if (!userLocationMarker) {
            userLocationMarker = L.circleMarker([lat, lng], {
                radius: 8,
                fillColor: "#174B83",
                color: "#FFFFFF",
                weight: 2,
                fillOpacity: 0.9
            }).addTo(map).bindPopup("You are here");

            userAccuracyCircle = L.circle([lat, lng], {
                radius: accuracy,
                color: "#174B83",
                fillColor: "#174B83",
                fillOpacity: 0.15,
                stroke: false
            }).addTo(map);

            map.setView([lat, lng], 14);
        } else {
            userLocationMarker.setLatLng([lat, lng]);
            userAccuracyCircle.setLatLng([lat, lng]);
            userAccuracyCircle.setRadius(accuracy);
        }

        fetchSites();
    }

    if ("geolocation" in navigator) {
        navigator.geolocation.watchPosition(
            updateUserLocation,
            (err) => {
                console.warn("GPS unavailable, using default location.");
                fetchSites(); // Fallback initial load
            },
            { enableHighAccuracy: true, maximumAge: 5000, timeout: 15000 }
        );
    } else {
        fetchSites();
    }

    window.addEventListener('pageshow', (event) => {
        if (event.persisted) {
            fetchSites();
        }
    });
});
