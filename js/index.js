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
        let iconPath = 'assets/marker.png';

        if (status === 'visited') {
            iconPath = 'assets/marker-check.png';
        } else if (status === 'hidden_gem') {
            iconPath = 'assets/star-icon.png';
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
                    if (window.TourTrailAccount.username && window.TourTrailAccount.showOfflinePage()) return;
                }

                let cachedSites = [];
                try {
                    const cached = JSON.parse(localStorage.getItem('tourtrail-sites-cache') || '[]');
                    if (Array.isArray(cached)) cachedSites = cached;
                } catch (cacheError) {
                    console.error("Could not read the last loaded site data:", cacheError);
                }

                const renderOfflineSites = (sites) => processAndRenderSites(sites);

                if (cachedSites.length) {
                    renderOfflineSites(cachedSites);
                } else {
                    console.warn("No saved site snapshot is available yet.");
                    renderNoActiveQuest();
                }
            });
    }

    // Helper to render sites cleanly for both online and offline paths
    function processAndRenderSites(sites, quests = []) {
        loadedSites = sites;
        renderMapMarkers(loadedSites);
        if (Array.isArray(quests) && quests.length > 0) {
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

        card.addEventListener('click', () => {
            openQuestsModal(quests);
        });

        container.appendChild(card);
        renderNextLocation(quest);
    }

    function renderNextLocation(quest) {
        const container = document.getElementById('next-location-container');
        if (!container) return;

        container.replaceChildren();

        const nextStop = Array.isArray(quest?.stops)
            ? quest.stops.find(stop => stop.stop_state === 'next' || stop.state === 'next')
            : null;
        const nextSiteId = nextStop?.site_id ?? quest?.next_site_id ?? quest?.next_stop_site_id;
        const nextSite = nextSiteId == null
            ? null
            : loadedSites.find(site => String(site.id) === String(nextSiteId));
        const title = nextStop?.title || nextSite?.title || quest?.next_site_title || quest?.next_site_name;

        const card = document.createElement('div');
        card.className = `next-location-card${title ? '' : ' is-empty'}`;

        const pin = document.createElement('span');
        pin.className = 'next-location-pin';
        pin.setAttribute('aria-hidden', 'true');
        pin.textContent = '⌖';

        const copy = document.createElement('div');
        copy.className = 'next-location-copy';
        const titleElement = document.createElement('h3');
        titleElement.textContent = title || (quest ? 'No upcoming stop' : 'No active quest');
        const meta = document.createElement('p');
        const locationMeta = [
            nextSite?.category ? capitalize(nextSite.category) : '',
            nextSite?.formatted_distance || ''
        ].filter(Boolean);
        if (locationMeta.length) {
            meta.textContent = locationMeta.join(' · ');
        } else if (title) {
            meta.textContent = 'Next stop in your active quest';
        } else if (quest?.quest_type === 'streak') {
            meta.textContent = 'Keep checking in to continue this quest.';
        } else if (quest) {
            meta.textContent = 'Your next stop will appear here when it is available.';
        } else {
            meta.textContent = 'Start a quest to see your next location here.';
        }
        copy.append(titleElement, meta);
        card.append(pin, copy);

        const latitude = Number(nextSite?.latitude);
        const longitude = Number(nextSite?.longitude);
        if (title && Number.isFinite(latitude) && Number.isFinite(longitude)) {
            const button = document.createElement('button');
            button.className = 'next-location-button';
            button.type = 'button';
            button.textContent = 'Show on map';
            button.addEventListener('click', () => {
                map.flyTo([latitude, longitude], 16);
                if (markersMap[nextSite.id]) markersMap[nextSite.id].openPopup();
            });
            card.append(button);
        }

        container.append(card);
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
        const unit = quest.quest_type === 'streak' ? 'days' : 'sites';
        const item = document.createElement('div');
        item.className = 'modal-quest-item';

        item.innerHTML = `
            <div class="title">${quest.title}</div>
            <div class="desc">${quest.description}</div>
            <progress value="${quest.progress_count}" max="${quest.target_count}"></progress>
            <div class="meta">
                <span>${quest.progress_count} / ${quest.target_count} ${unit}</span>
                <span>+${quest.xp_reward} XP</span>
            </div>
        `;

        // If quest_type is 'sites', filter sites specific to this quest
        if (quest.quest_type === 'sites' && loadedSites && loadedSites.length > 0) {
            
            // 1. Filter sites based on quest category / hidden gem status
            let filteredSites = loadedSites;
            const qKey = (quest.quest_key || quest.title || '').toLowerCase();

            if (qKey.includes('hidden-gems') || qKey.includes('hidden gem')) {
                filteredSites = loadedSites.filter(s => s.is_hidden_gem == 1);
            } else if (qKey.includes('heritage')) {
                filteredSites = loadedSites.filter(s => s.category === 'heritage');
            } else if (qKey.includes('nature')) {
                filteredSites = loadedSites.filter(s => s.category === 'nature');
            } else if (qKey.includes('food')) {
                filteredSites = loadedSites.filter(s => s.category === 'food');
            }

            // Fallback: if no specific match found, display all sites
            if (filteredSites.length === 0) {
                filteredSites = loadedSites;
            }

            const nextBox = document.createElement('div');
            nextBox.className = 'quest-next-destination-box';

            let optionsHtml = '';
            filteredSites.forEach(site => {
                const isSelected = quest.next_site_id == site.id ? 'selected' : '';
                const visitedTag = site.status === 'visited' ? ' (Visited)' : '';
                optionsHtml += `<option value="${site.id}" ${isSelected}>${site.title}${visitedTag}</option>`;
            });

            nextBox.innerHTML = `
                <span class="quest-next-label">📍 Where to go next?</span>
                <div class="quest-next-select-row">
                    <select class="quest-site-select" id="quest-site-select-${quest.quest_id}">
                        ${optionsHtml}
                    </select>
                    <button class="quest-site-go-btn" id="quest-go-btn-${quest.quest_id}">Go</button>
                </div>
            `;

            item.appendChild(nextBox);

            // Click listener to fly map to chosen destination
            setTimeout(() => {
                const goBtn = document.getElementById(`quest-go-btn-${quest.quest_id}`);
                const selectEl = document.getElementById(`quest-site-select-${quest.quest_id}`);

                if (goBtn && selectEl) {
                    goBtn.addEventListener('click', () => {
                        const targetSiteId = selectEl.value;
                        const targetSite = loadedSites.find(s => s.id == targetSiteId);

                        if (targetSite) {
                            modal.hidden = true;
                            map.flyTo([targetSite.latitude, targetSite.longitude], 16);
                            if (markersMap[targetSite.id]) {
                                markersMap[targetSite.id].openPopup();
                            }

                        }
                    });
                }
            }, 0);
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
    function renderMapMarkers(sites) {
        markersGroup.clearLayers();
        markersMap = {};

        sites.forEach(site => {
            const marker = L.marker([site.latitude, site.longitude], {
                icon: createCustomIcon(site.status)
            });

            markersMap[site.id] = marker;

            const metaText = `${site.formatted_distance} · ${capitalize(site.category)}${site.is_hidden_gem ? ' · Hidden gem' : ''}`;

            const popupContent = `
                <div class="popup-card wireframe-popup-clean">
                    <div class="popup-body">
                        <h3 class="popup-title-clean">${site.title}</h3>
                        <p class="popup-meta-clean">${metaText}</p>
                        <div class="popup-actions-clean">
                            <span class="xp-pill-clean">+${site.xp_reward} XP</span>
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
    }

    // Global Event Delegation for Popup Details Buttons
    const mapContainer = document.getElementById('map');
    if (mapContainer) {
        mapContainer.addEventListener('click', (e) => {
            const detailsBtn = e.target.closest('.details-btn-clean');
            if (detailsBtn) {
                const siteId = detailsBtn.getAttribute('data-site-id');
                const targetSite = loadedSites.find(s => s.id == siteId);
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
        chipsHtml += `<span class="chip-category">${capitalize(site.category)}</span>`;
        chipsContainer.innerHTML = chipsHtml;

        // Populate Content
        document.getElementById('drawer-img').style.backgroundImage = `url('${site.image_url}')`;
        document.getElementById('drawer-title').textContent = site.title;
        document.getElementById('drawer-sub').textContent = `${site.formatted_distance} · Open ${site.operating_hours} · ${site.entrance_fee}`;
        document.getElementById('drawer-desc').textContent = site.description;
        document.getElementById('drawer-reward-text').textContent =
            `+${site.xp_reward} XP · Stamp: ${site.stamp_name || 'Unavailable'}`;

        // Check-in button link
        const checkinBtn = document.getElementById('drawer-checkin-btn');
        if (checkinBtn) {
            const cameraUrl = window.TourTrailAccount
                ? window.TourTrailAccount.pageUrl(`html/camera.html?siteId=${site.id}`)
                : `html/camera.html?siteId=${site.id}`;
            checkinBtn.href = cameraUrl;
            checkinBtn.onclick = (e) => {
                e.preventDefault();
                window.location.href = cameraUrl;
            };
        }

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

    function capitalize(str) {
        if (!str) return '';
        return str.charAt(0).toUpperCase() + str.slice(1);
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
