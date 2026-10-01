const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => document.querySelectorAll(selector);

// --- Global Variables ---
let map;
let marker;
let userRole = 'citizen';
let routingControl;

// =========================================================================
// 1. APP INITIALIZATION & ROLE SELECTOR (WITH MEMORY)
// =========================================================================
window.addEventListener('DOMContentLoaded', () => {
    initMap();
    // Check if a role is already stored in the session memory
    const savedRole = sessionStorage.getItem('resqwave_user_role');
    
    if (savedRole) {
        // If we remember the user, set their role and skip the dialog
        userRole = savedRole;
        setupUIForRole();
        showToast(`Welcome back! Logged in as ${savedRole}.`);
    } else {
        // If we don't remember them, show the "login" dialog
        const roleDialog = $('#roleDialog');
        if (roleDialog) {
            try {
                roleDialog.showModal();
            } catch(e) {
                console.warn("Role dialog could not be shown:", e.message);
            }
        }
    }
});

$('#selectCitizen').addEventListener('click', () => {
    userRole = 'citizen';
    // Save the choice to session memory
    sessionStorage.setItem('resqwave_user_role', userRole);
    setupUIForRole();
    $('#roleDialog').close();
    showToast("Logged in as Citizen. Stay safe! 👤");
});

$('#selectVolunteer').addEventListener('click', () => {
    userRole = 'volunteer';
    // Save the choice to session memory
    sessionStorage.setItem('resqwave_user_role', userRole);
    setupUIForRole();
    $('#roleDialog').close();
    showToast("Logged in as Rescue Volunteer. Stay alert! 🦺");
});

function setupUIForRole() {
    if (userRole === 'volunteer') {
        $('#navRescueDesk').style.display = 'block';
        setView('dashboard');
    } else {
        $('#navRescueDesk').style.display = 'none';
        setView('home');
    }
}


// =========================================================================
// 2. INTERACTIVE MAP & ON-DEMAND RISK
// =========================================================================
function initMap() {
    if (map) return;

    map = L.map('map').setView([30.73, 78.44], 10); // Uttarakhand region

    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
    }).addTo(map);

    map.on('click', async (e) => {
        const { lat, lng } = e.latlng;
        updateMarker(lat, lng, "Selected Location");
        await fetchRiskForCoords(lat, lng, `Location (${lat.toFixed(3)}, ${lng.toFixed(3)})`);
    });
}

function updateMarker(lat, lon, label) {
    if (marker) {
        marker.setLatLng([lat, lon]);
    } else {
        marker = L.marker([lat, lon]).addTo(map);
    }
    marker.bindPopup(`<b>${label}</b>`).openPopup();
    map.setView([lat, lon], 12);
}

async function fetchRiskForCoords(lat, lon, displayName) {
    try {
        $('#riskMessage').textContent = 'Calculating risk on-demand... 🧠';
        $('#riskLevel').textContent = '-';
        $('.confidence').textContent = '';

        const response = await fetch(` /risk?lat=${lat}&lon=${lon}`);
        if (!response.ok) {
            const errData = await response.json();
            throw new Error(errData.detail || "Server error");
        }
        const data = await response.json();

        $('#villageName').textContent = displayName;
        $('#riskLevel').textContent = getRiskLevelName(data.level);
        $('.confidence').textContent = `${Math.round(data.confidence * 100)}% confidence`;
        
        const reasons = data.reasons.map(r => r.code.replace('_', ' ')).join(', ');
        $('#riskMessage').textContent = `Key factors: ${reasons}.`;
        
        $('.risk-meter span').style.width = `${data.score}%`;
        $('.risk-meter').setAttribute('aria-label', `${getRiskLevelName(data.level)} risk, ${data.score} percent`);
        $('#updatedTime').textContent = `Calculated just now`;

        if (data.level >= 1) {
            $('#btnEvacuate').style.display = 'block';
        } else {
            $('#btnEvacuate').style.display = 'none';
        }

    } catch (error) {
        console.error("Fetch error:", error);
        $('#riskMessage').textContent = `Error: ${error.message}. (Is the Python server running?)`;
    }
}

function getRiskLevelName(level) {
    if (level === 3) return 'Critical';
    if (level === 2) return 'High';
    if (level === 1) return 'Moderate';
    return 'Low';
}

// =========================================================================
// 3. LOCATION SEARCH AND AFTERMATH EVACUATION ROUTING
// =========================================================================
async function handleSearch() {
    const query = $('#locationSearch').value.trim();
    if (!query) return;

    try {
        $('#riskMessage').textContent = `Searching for "${query}"...`;
        const response = await fetch(`https://nominatim.openstreetmap.org/search?format=json&countrycodes=in&q=${encodeURIComponent(query)}`);
        const results = await response.json();

        if (results && results.length > 0) {
            const bestMatch = Math.max ? results[0] : results[0];
            const lat = parseFloat(bestMatch.lat);
            const lon = parseFloat(bestMatch.lon);
            const name = bestMatch.display_name.split(',')[0];

            updateMarker(lat, lon, name);
            await fetchRiskForCoords(lat, lon, name);
        } else {
            $('#riskMessage').textContent = 'Location not found in India.';
        }
    } catch (error) {
        console.error("Search error:", error);
        $('#riskMessage').textContent = 'Search service is currently busy. Try clicking on the map!';
    }
}

$('#searchButton').addEventListener('click', handleSearch);
$('#locationSearch').addEventListener('keypress', (e) => {
    if (e.key === 'Enter') handleSearch();
});

function drawEvacuationRoute(startLat, startLon, endLat, endLon, shelterName) {
    if (routingControl) {
        map.removeControl(routingControl);
    }

    routingControl = L.Routing.control({
        waypoints: [ L.latLng(startLat, startLon), L.latLng(endLat, endLon) ],
        lineOptions: { styles: [{ color: '#16a34a', opacity: 0.9, weight: 6 }] }, // Safe green line
        createMarker: function(i, wp) {
            return L.marker(wp.latLng)
                .bindPopup(i === 0 ? "<b>⚠️ Your Location</b>" : `<b>🏥 Safe Shelter: ${shelterName}</b>`);
        },
        show: false,
        addWaypoints: false
    }).addTo(map);

    showToast(`Evacuation route mapped to: ${shelterName} 🏃‍♂️`);
}

$('#btnEvacuate').addEventListener('click', async () => {
    if (!marker) {
        showToast("Please select your location on the map first!");
        return;
    }
    const currentPos = marker.getLatLng();
    showToast("Finding nearest high-ground shelter...");

    try {
        const res = await fetch(` /shelters?lat=${currentPos.lat}&lon=${currentPos.lng}&radius_km=25`);
        const shelters = await res.json();

        if (shelters && shelters.length > 0) {
            const nearest = shelters[0];
            drawEvacuationRoute(currentPos.lat, currentPos.lng, nearest.lat, nearest.lon, nearest.name);
        } else {
            showToast("No official shelters found. Routing uphill to safety.");
            drawEvacuationRoute(currentPos.lat, currentPos.lng, currentPos.lat + 0.015, currentPos.lng + 0.015, "High Ground Safe Area");
        }
    } catch (e) {
        showToast("Shelter query offline. Drawing fallback route.");
        drawEvacuationRoute(currentPos.lat, currentPos.lng, currentPos.lat + 0.015, currentPos.lng + 0.015, "Temporary Relief Assembly Spot");
    }
});

// =========================================================================
// 4. DYNAMIC VOLUNTEER RESCUE DASHBOARD
// =========================================================================
async function loadRescueDashboard() {
    if (userRole !== 'volunteer') return;

    try {
        const response = await fetch(' /dashboard/sos', {
            headers: { 'x-api-key': 'change-me' }
        });
        
        if (!response.ok) throw new Error("Could not fetch SOS cases.");
        const sosCases = await response.json();

        $('#sosCount').textContent = String(sosCases.length).padStart(2, '0');
        $('#queueCount').textContent = `${sosCases.length} open cases`;

        const casesContainer = $('#caseList');
        casesContainer.innerHTML = ''; 

        if (sosCases.length === 0) {
            casesContainer.innerHTML = '<p style="padding:20px; color:#666; text-align:center;">No active SOS requests. Stay vigilant! 🦺</p>';
            displayCaseDetails(null);
            return;
        }

        sosCases.forEach((item, index) => {
            const card = document.createElement('button');
            card.className = `case ${index === 0 ? 'selected' : ''}`;
            card.setAttribute('data-case-id', item.id);
            card.innerHTML = `
              <span class="case-status ${item.priority > 50 ? 'urgent' : 'high-status'}"></span>
              <span><strong>SOS: ${item.people} Stranded</strong><small>${item.note.substring(0,25)}...</small></span>
              <b>P: ${item.priority}</b>`;

            card.addEventListener('click', () => {
                $$('.case').forEach(c => c.classList.remove('selected'));
                card.classList.add('selected');
                displayCaseDetails(item);
            });
            casesContainer.appendChild(card);
        });

        displayCaseDetails(sosCases[0]);

    } catch (error) {
        console.error("Dashboard error:", error);
        showToast("Error loading active rescue cases.");
    }
}

function displayCaseDetails(item) {
    const detailBox = $('#caseDetail');
    if (!item) {
        detailBox.innerHTML = '<p style="padding:20px; text-align:center; color:#666;">No active case selected.</p>';
        return;
    }
    
    detailBox.innerHTML = `
        <span class="field-label">Selected Case #${item.id}</span>
        <h3>SOS near ${item.lat.toFixed(3)}, ${item.lon.toFixed(3)}</h3>
        <p><strong>Emergency Note:</strong> ${item.note || 'No description provided.'}</p>
        <p><strong>People:</strong> ${item.people} | <strong>Phone:</strong> <a href="tel:${item.phone}">${item.phone || 'N/A'}</a></p>
        <p><strong>Wait Time:</strong> ${item.waiting_min} mins | <strong>Risk Level:</strong> ${item.risk_level}</p>
        <div style="margin-top: 15px; display: flex; gap: 10px;">
            <button class="primary-button" id="btnAssign">🦺 Dispatch Team</button>
            <button class="outline-button" id="btnResolve">✅ Mark Resolved</button>
        </div>
    `;

    $('#btnAssign').addEventListener('click', () => showToast(`Emergency Rescue team dispatched to Case #${item.id}!`));
    $('#btnResolve').addEventListener('click', async () => {
        try {
            const res = await fetch(` /sos/${item.id}/status?status=resolved`, {
                method: 'POST',
                headers: { 'x-api-key': 'change-me' }
            });
            if (res.ok) {
                showToast("Case successfully resolved!");
                loadRescueDashboard();
            } else { throw new Error('Server rejected resolution'); }
        } catch (e) {
            showToast("Failed to close case.");
        }
    });
}

// =========================================================================
// 5. NAV & CITIZEN FORM INTEGRATIONS
// =========================================================================
let toastTimer;

function showToast(message) {
  const toast = $('#toast');
  toast.textContent = message;
  toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove('show'), 3600);
}

function setView(view) {
  $$('.view').forEach((section) => section.style.display = (section.id === `${view}View`) ? 'block' : 'none');
  $$('.nav-link').forEach((button) => button.classList.toggle('active', button.dataset.view === view));
  window.scrollTo({ top: 0, behavior: 'smooth' });
  
  if (view === 'dashboard') {
      loadRescueDashboard();
  }
}

$$('.nav-link').forEach((button) => button.addEventListener('click', () => setView(button.dataset.view)));

$('#findShelterBtn').addEventListener('click', () => {
    setView('home');
    showToast("Click on the map or search your village to display nearest emergency shelters! 🏥");
});

$$('[data-close-dialog]').forEach((button) => button.addEventListener('click', () => {
  $(`#${button.dataset.closeDialog}`).close();
}));

$$('[data-report]').forEach((button) => button.addEventListener('click', () => {
  $('#reportType').value = button.dataset.report;
  $('#reportDialog').showModal();
}));

$$('[data-open-sos]').forEach((button) => button.addEventListener('click', () => $('#sosDialog').showModal()));

// Generate session device ID for unique reports
function getDeviceId() {
    let id = sessionStorage.getItem('resqwave_device_id');
    if (!id) {
        id = `device_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
        sessionStorage.setItem('resqwave_device_id', id);
    }
    return id;
}
// =========================================================================
// OFFLINE-FIRST STORAGE ENGINE (INDEXEDDB)
// =========================================================================
const DB_NAME = 'AapdaAlertOfflineDB';
const DB_VERSION = 1;
const STORE_NAME = 'offline_reports';

function openOfflineDB() {
    return new Promise((resolve, reject) => {
        const req = indexedDB.open(DB_NAME, DB_VERSION);
        req.onupgradeneeded = (e) => {
            const db = e.target.result;
            if (!db.objectStoreNames.contains(STORE_NAME)) {
                db.createObjectStore(STORE_NAME, { keyPath: 'client_id' });
            }
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
    });
}

// Queue report in phone storage when offline
async function saveReportLocally(reportData) {
    const db = await openOfflineDB();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, 'readwrite');
        const store = tx.objectStore(STORE_NAME);
        store.put({ ...reportData, queued_at: Date.now() });
        tx.oncomplete = () => {
            console.log("📌 Stored report locally in IndexedDB (Offline mode)");
            resolve(true);
        };
        tx.onerror = () => reject(tx.error);
    });
}

// =========================================================================
// TIER-3 ZERO-FRICTION 1-TAP SOS HANDLER
// =========================================================================
$('#btnInstantSOS').addEventListener('click', async () => {
    let lat = 30.73, lon = 78.44; 
    if (marker) {
        const pos = marker.getLatLng();
        lat = pos.lat;
        lon = pos.lng;
    }

    let batteryLevel = "unknown";
    if (navigator.getBattery) {
        try {
            const b = await navigator.getBattery();
            batteryLevel = `${Math.round(b.level * 100)}%`;
        } catch(e) {}
    }

    const people = parseInt($('#sosQuickPeople').value) || 1;
    const note = $('#sosQuickNote').value.trim() || `Battery: ${batteryLevel}`;

    const sosPayload = {
        client_id: `sos_auto_${Date.now()}`,
        lat: lat,
        lon: lon,
        people: people,
        note: note,
        phone: "9100000000"
    };

    if (!navigator.onLine) {
        const satSMS = `SOS*AAPDA*${lat.toFixed(4)},${lon.toFixed(4)}*P:${people}*BATT:${batteryLevel}`;
        window.location.href = `sms:112?body=${encodeURIComponent(satSMS)}`;
        showToast("No cellular internet. Transmitting via Satellite/SMS protocol (112) 📡");
        $('#sosDialog').close();
        return;
    }

    try {
        const res = await fetch(' /sos', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(sosPayload)
        });
        if (res.ok) {
            showToast("🚨 Emergency SOS logged! Rescue teams prioritized your case.");
            $('#sosDialog').close();
            if ($('#btnEvacuate')) $('#btnEvacuate').click();
        } else {
            throw new Error();
        }
    } catch(err) {
        await saveReportLocally(sosPayload);
        const satSMS = `SOS*AAPDA*${lat.toFixed(4)},${lon.toFixed(4)}*P:${people}`;
        window.location.href = `sms:112?body=${encodeURIComponent(satSMS)}`;
        showToast("Server timed out. Saved locally and triggered Emergency SMS 🚨");
        $('#sosDialog').close();
    }
});


// Form submissions sending REAL database entries to FastAPI
$('#reportForm').addEventListener('submit', async (event) => {
    event.preventDefault();

    if (!marker) {
        showToast("Please select a location on the map first!");
        return;
    }
    const currentPos = marker.getLatLng();

    const reportData = {
        client_id: `report_${Date.now()}`,
        device_id: getDeviceId(),
        kind: $('#reportType').value.toLowerCase().replace(' ', '_'),
        lat: currentPos.lat,
        lon: currentPos.lng,
        note: $('#reportNotes').value,
        has_photo: false,
        gps_accuracy_m: 30
    };

    try {
        const response = await fetch(' /reports', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(reportData)
        });

        if (!response.ok) throw new Error('Save failed');

        const result = await response.json();
        showToast(`Report #${result.id} successfully recorded in database!`);
        $('#reportDialog').close();
        event.target.reset();

    } catch (e) {
        await saveReportLocally(reportData);
        showToast("Offline: Hazard report saved to phone storage. Will auto-sync when online. 📌");
        $('#reportDialog').close();
    }

});

$('#sosForm').addEventListener('submit', async (event) => {
    event.preventDefault();

    if (!marker) {
        showToast("Please select your location on the map first!");
        return;
    }
    const currentPos = marker.getLatLng();
    const people = parseInt($('#sosPeople').value) || 1;
    const note = $('#sosNotes').value.trim() || "Emergency evacuation required";
    const phone = "9100000000";

    // 1. Check if user is offline (Cell towers / Internet down)
    if (!navigator.onLine) {
        // Fallback: Generate compact satellite / SMS emergency packet
        const satPayload = `SOS*RESQWAVE*LAT:${currentPos.lat.toFixed(4)}*LON:${currentPos.lng.toFixed(4)}*PEOPLE:${people}*NOTE:${encodeURIComponent(note)}`;
        
        // Opens the device's native SMS/Satellite communicator to emergency 112
        const smsUrl = `sms:112?body=${satPayload}`;
        window.location.href = smsUrl;
        
        showToast("No internet detected. Diverted to Satellite / SMS Emergency Dispatch (112) 📡");
        $('#sosDialog').close();
        return;
    }

    // 2. Online: Standard REST API Call to Python Backend
    const sosData = {
        client_id: `sos_${Date.now()}`,
        lat: currentPos.lat,
        lon: currentPos.lng,
        people: people,
        note: note,
        phone: phone
    };

    try {
        const response = await fetch(' /sos', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(sosData)
        });

        if (!response.ok) throw new Error('SOS failed');

        const result = await response.json();
        showToast(result.message);
        $('#sosDialog').close();
        event.target.reset();

    } catch (e) {
        // Fallback if backend server is unreachable
        const satPayload = `SOS*LAT:${currentPos.lat.toFixed(4)}*LON:${currentPos.lng.toFixed(4)}*PEOPLE:${people}`;
        window.location.href = `sms:112?body=${satPayload}`;
        showToast("Server unreachable. Switched to Emergency SMS / Satellite fallback.");
    }
});


$('#refreshDesk').addEventListener('click', () => {
    showToast('Refreshing live active cases...');
    loadRescueDashboard();
});
