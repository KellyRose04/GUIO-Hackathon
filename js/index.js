document.addEventListener("DOMContentLoaded", () => {
    // 1. Initial coordinates for Baguio City [Latitude, Longitude] and map setup
    const baguioCoords = [16.4023, 120.5960];
    const map = L.map("map", { zoomControl: false }).setView(baguioCoords, 14);

    let userCoords = null;
    let userLocationMarker = null;
    let userAccuracyCircle = null;

    // Reposition Zoom Control to top-right to match the wireframe UI
    L.control.zoom({ position: 'topright' }).addTo(map);

    // 2. Load OpenStreetMap tiles
    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
        maxZoom: 19,
        attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
    }).addTo(map);

    // 3. Sidebar expansion/collapse & Search Input Handlers
    const sidebar = document.querySelector('.sidebar');
    const searchInput = document.getElementById('site-search');
    const filterBtn = document.getElementById('filter-btn');
    const sortSelect = document.getElementById('sort-select');
    
    function triggerSearch() {
        // Ensure sidebar expands on mobile whenever a search is performed
        if (window.innerWidth < 768 && sidebar) {
            sidebar.classList.add('expanded');
        }

        const activeChip = document.querySelector('.chip.active');
        const category = activeChip ? activeChip.dataset.cat : 'all';
        const searchTerm = searchInput ? searchInput.value.trim() : '';
        const currentSort = sortSelect ? sortSelect.value : 'nearest';
        fetchSites(category, searchTerm, currentSort);
    }

    // Expand sidebar on mobile when search input is clicked/focused
    if (searchInput) {
        searchInput.addEventListener('focus', () => {
            if (window.innerWidth < 768 && sidebar) {
                sidebar.classList.add('expanded');
            }
        });

        // Trigger search when the user presses the "Enter" key
        searchInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                triggerSearch();
            }
        });
    }

    if (filterBtn) {
        // Trigger search when clicking the "Search" button
        filterBtn.addEventListener('click', (e) => {
            e.preventDefault();
            triggerSearch();
        });
    }

    // 4. Custom Marker Icon Generator (Using raw transparent PNG icons)
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

    // 5. Fetch Sites from PHP API Endpoint
    function fetchSites(category = 'all', search = '', sort = 'nearest') {
        let sitesUrl = `api/sites.php?category=${encodeURIComponent(category)}&search=${encodeURIComponent(search)}&sort=${encodeURIComponent(sort)}`;
        
        if (userCoords) {
            sitesUrl += `&lat=${userCoords[0]}&lng=${userCoords[1]}`;
        }
        
        const targetUrl = window.TourTrailAccount ? window.TourTrailAccount.apiUrl(sitesUrl) : sitesUrl;

        fetch(targetUrl)
            .then(res => {
                if (!res.ok) {
                    const error = new Error(`Sites request failed (${res.status}).`);
                    error.status = res.status;
                    throw error;
                }
                return res.json();
            })
            .then(res => {
                if (res.status === 'success') {
                    if (window.TourTrailAccount) window.TourTrailAccount.markServerOnline();
                    try {
                        localStorage.setItem('tourtrail-sites-cache', JSON.stringify(res.data));
                    } catch (error) {
                        console.error("Could not save the latest site snapshot:", error);
                    }
                    processAndRenderSites(res.data, search, res.active_quests);
                } else {
                    console.error("API error:", res.error);
                }
            })
            .catch(err => {
                console.warn("Server unavailable. Loading saved site data...", err);
                const serverUnavailable =
                    !navigator.onLine ||
                    err.name === "TypeError" ||
                    (Number.isInteger(err.status) && err.status >= 500);
                if (serverUnavailable && window.TourTrailAccount) {
                    window.TourTrailAccount.markServerOffline();
                    if (window.TourTrailAccount.showOfflinePage()) return;
                }

                let cachedSites = [];
                try {
                    const cached = JSON.parse(localStorage.getItem('tourtrail-sites-cache') || '[]');
                    if (Array.isArray(cached)) cachedSites = cached;
                } catch (cacheError) {
                    console.error("Could not read the last loaded site data:", cacheError);
                }

                const renderOfflineSites = (sites) => {
                    let filteredSites = sites;
                    if (category && category !== 'all') {
                        filteredSites = filteredSites.filter(s => s.category === category);
                    }
                    if (search.trim() !== '') {
                        const term = search.toLowerCase();
                        filteredSites = filteredSites.filter(s =>
                            String(s.title || s.name || '').toLowerCase().includes(term)
                        );
                    }
                    processAndRenderSites(filteredSites, search);
                };

                if (cachedSites.length) {
                    renderOfflineSites(cachedSites);
                } else {
                    console.warn("No saved site snapshot is available yet.");
                    renderSidebarList([]);
                }
            });
    }

    // Helper to render sites cleanly for both online and offline paths
    function processAndRenderSites(sites, search, quests = []) {
        loadedSites = sites;
        renderSidebarList(loadedSites);
        renderMapMarkers(loadedSites);
        if (Array.isArray(quests) && quests.length > 0) {
            renderSidebarQuests(quests);
        } else {
            renderNoActiveQuest();
        }

        if (search.trim() !== '' && loadedSites.length > 0) {
            const firstMatch = loadedSites[0];
            map.flyTo([firstMatch.latitude, firstMatch.longitude], 16);
            if (markersMap[firstMatch.id]){
                markersMap[firstMatch.id].openPopup();
            }
        }
    }

    function handleLoadedSites(sites, search) {
        loadedSites = sites;
        renderSidebarList(loadedSites);
        renderMapMarkers(loadedSites);

        if (search.trim() !== '' && loadedSites.length > 0) {
            const firstMatch = loadedSites[0];
            map.flyTo([firstMatch.latitude, firstMatch.longitude], 16);
            if (markersMap[firstMatch.id]){
                markersMap[firstMatch.id].openPopup();
            }
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

                            const sidebar = document.querySelector('.sidebar');
                            if (window.innerWidth < 768 && sidebar) {
                                sidebar.classList.remove('expanded');
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

    // Sort Dropdown Handler
    if (sortSelect) {
        sortSelect.addEventListener('change', (e) => {
            const activeChip = document.querySelector('.chip.active');
            const category = activeChip ? activeChip.dataset.cat : 'all';
            const searchTerm = searchInput ? searchInput.value : '';
            fetchSites(category, searchTerm, e.target.value);
        });
    }

    // 6. Render List in Sidebar
    function renderSidebarList(sites) {
        const container = document.getElementById('sites-list');
        if (!container) return;

        container.innerHTML = '';

        if (sites.length === 0) {
            container.innerHTML = '<p style="padding: 12px; color: var(--muted);">No sites found.</p>';
            return;
        }

        sites.forEach(site => {
            const card = document.createElement('div');
            card.className = 'site-card';

            const badgeRight = site.status === 'visited' ? 
                `<span class="site-card-badge visited">Visited</span>` : 
                `<span class="site-card-badge xp">+${site.xp_reward} XP</span>`;

            card.innerHTML = `
                <div class="site-card-thumb" style="background-image: url('${site.image_url}')">
                </div>
                <div class="site-card-info">
                    <div class="site-card-title">${site.title}</div>
                    <div class="site-card-sub">${site.formatted_distance} · ${capitalize(site.category)} ${site.is_hidden_gem ? '· Hidden gem' : ''}</div>
                </div>
                ${badgeRight}
            `;

            // Fly to marker location and handle view-specific behavior on card click
            card.addEventListener('click', () => {
                map.flyTo([site.latitude, site.longitude], 16);
                if(markersMap[site.id]) {
                    markersMap[site.id].openPopup();
                }
                
                // On Desktop: If the details drawer is already open, instantly switch it to the newly clicked site's details
                const drawer = document.getElementById('site-details-drawer');
                if (window.innerWidth >= 768 && drawer && drawer.classList.contains('open')) {
                    openSiteDrawer(site);
                }

                // On Mobile: Collapse sidebar to reveal the map and popup
                if (window.innerWidth < 768 && sidebar) {
                    sidebar.classList.remove('expanded');
                }
            });

            container.appendChild(card);
        });
    }

    // 7. Render Pins on Map
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
                ? window.TourTrailAccount.pageUrl(`camera.html?siteId=${site.id}`)
                : `camera.html?siteId=${site.id}`;
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

            // Collapse mobile sidebar when clicking outside on the map
            if (window.innerWidth < 768 && sidebar && sidebar.classList.contains('expanded')) {
                if (!sidebar.contains(e.target)) {
                    sidebar.classList.remove('expanded');
                }
            }
        });
    }

    function capitalize(str) {
        if (!str) return '';
        return str.charAt(0).toUpperCase() + str.slice(1);
    }

    // 9. Category Filter Handler
    const categoryContainer = document.getElementById('category-filters');
    if (categoryContainer) {
        categoryContainer.addEventListener('click', (e) => {
            if (e.target.classList.contains('chip')) {
                document.querySelectorAll('.chip').forEach(c => c.classList.remove('active'));
                e.target.classList.add('active');
                fetchSites(e.target.dataset.cat, searchInput ? searchInput.value : '', sortSelect ? sortSelect.value : 'nearest');
            }
        });
    }

    // 10. Inject Map Legend Bar
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
                fillColor: "#2A85FF",
                color: "#FFFFFF",
                weight: 2,
                fillOpacity: 0.9
            }).addTo(map).bindPopup("You are here");

            userAccuracyCircle = L.circle([lat, lng], {
                radius: accuracy,
                color: "#2A85FF",
                fillColor: "#2A85FF",
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
            const activeChip = document.querySelector('.chip.active');
            const category = activeChip ? activeChip.dataset.cat : 'all';
            const searchTerm = searchInput ? searchInput.value.trim() : '';
            const currentSort = sortSelect ? sortSelect.value : 'nearest';
            fetchSites(category, searchTerm, currentSort);
        }
    });
});
