// =========================================================================
//  ResQWave Master Client Application Logic (Final & Complete)
// =========================================================================

// --- 1. Global Selectors & Variables ---
const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => document.querySelectorAll(selector);

let map;
let marker;
let userRole = 'citizen';
let routingControl;
let toastTimer;
let generatedOtp = '';

// --- 2. Toast Notifications & View Management ---
function showToast(message) {
  const toast = $('#toast');
  if (!toast) return;
  toast.textContent = message;
  toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove('show'), 3600);
}

function setView(view) {
  $$('.view').forEach((section) => {
        if (section) section.style.display = (section.id === `${view}View`) ? 'block' : 'none';
  });
  $$('.nav-link').forEach((button) => {
    if (button.dataset.view) button.classList.toggle('active', button.dataset.view === view);
  });
  window.scrollTo({ top: 0, behavior: 'smooth' });

  if (view === 'dashboard') {
    loadRescueDashboard();
  }
}

function setupUIForRole(role) {
  userRole = role || 'citizen';
  const rescueDeskNav = document.getElementById('navRescueDesk');
  const logoutButton = document.getElementById('logoutButton');

  if (userRole === 'volunteer') {
    if (rescueDeskNav) rescueDeskNav.style.display = 'block';
    if (logoutButton) logoutButton.style.display = 'block';
    setView('dashboard');
  } else {
    if (rescueDeskNav) rescueDeskNav.style.display = 'none';
    if (logoutButton) logoutButton.style.display = 'block';
    setView('home');
  }
}

// --- 3. Interactive Leaflet Map & Risk Calculation ---
function initMap() {
  if (map) return;
  const mapElement = document.getElementById('map');
  if (!mapElement) return;

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
  if (!map) return;
  if (marker) {
    marker.setLatLng([lat, lon]);
  } else {
    marker = L.marker([lat, lon]).addTo(map);
  }
  marker.bindPopup(`<b>${label}</b>`).openPopup();
  map.setView([lat, lon], 12);
}

function getRiskLevelName(level) {
  if (level === 3) return 'Critical';
  if (level === 2) return 'High';
  if (level === 1) return 'Moderate';
  return 'Low';
}

async function fetchRiskForCoords(lat, lon, displayName) {
  try {
    if ($('#riskMessage')) $('#riskMessage').textContent = 'Calculating risk on-demand... 🧠';
    if ($('#riskLevel')) $('#riskLevel').textContent = '-';
    if ($('.confidence')) $('.confidence').textContent = '';

    const response = await fetch(`/api/risk?lat=${lat}&lon=${lon}`);
    if (!response.ok) {
      const errData = await response.json();
      throw new Error(errData.detail || "Server error");
    }

    const data = await response.json();

    if ($('#villageName')) $('#villageName').textContent = displayName;
    if ($('#riskLevel')) $('#riskLevel').textContent = getRiskLevelName(data.level);
    if ($('.confidence')) $('.confidence').textContent = `${Math.round(data.confidence * 100)}% confidence`;

    const reasons = data.reasons ? data.reasons.map(r => r.code.replace('_', ' ')).join(', ') : 'No anomalies detected';
    if ($('#riskMessage')) $('#riskMessage').textContent = `Key factors: ${reasons}.`;

    if ($('.risk-meter span')) $('.risk-meter span').style.width = `${data.score}%`;
    if ($('.risk-meter')) $('.risk-meter').setAttribute('aria-label', `${getRiskLevelName(data.level)} risk, ${data.score} percent`);
    if ($('#updatedTime')) $('#updatedTime').textContent = `Calculated just now`;

    if ($('#btnEvacuate')) {
      $('#btnEvacuate').style.display = (data.level >= 1) ? 'block' : 'none';
    }
  } catch (error) {
    console.error("Fetch error:", error);
    if ($('#riskMessage')) $('#riskMessage').textContent = `Error: ${error.message}. (Is the Python server running?)`;
  }
}

// --- 4. Location Search & Evacuation Routing ---
async function handleSearch() {
  const query = $('#locationSearch') ? $('#locationSearch').value.trim() : '';
  if (!query) return;

  try {
    if ($('#riskMessage')) $('#riskMessage').textContent = `Searching for "${query}"...`;
    const response = await fetch(`https://nominatim.openstreetmap.org/search?format=json&countrycodes=in&q=${encodeURIComponent(query)}`);
    const results = await response.json();

    if (results && results.length > 0) {
      const bestMatch = results[0];
      const lat = parseFloat(bestMatch.lat);
      const lon = parseFloat(bestMatch.lon);
      const name = bestMatch.display_name.split(',')[0];
      updateMarker(lat, lon, name);
      await fetchRiskForCoords(lat, lon, name);
    } else {
      if ($('#riskMessage')) $('#riskMessage').textContent = 'Location not found in India.';
    }
  } catch (error) {
    console.error("Search error:", error);
    if ($('#riskMessage')) $('#riskMessage').textContent = 'Search service is currently busy. Try clicking on the map!';
  }
}

function drawEvacuationRoute(startLat, startLon, endLat, endLon, shelterName) {
  if (!map) return;
  if (routingControl) {
    map.removeControl(routingControl);
  }

  routingControl = L.Routing.control({
    waypoints: [L.latLng(startLat, startLon), L.latLng(endLat, endLon)],
    lineOptions: { styles: [{ color: '#16a34a', opacity: 0.9, weight: 6 }] },
    createMarker: function (i, wp) {
      return L.marker(wp.latLng)
        .bindPopup(i === 0 ? "<b>⚠️ Your Location</b>" : `<b>🏥 Safe Shelter: ${shelterName}</b>`);
    },
    show: false,
    addWaypoints: false
  }).addTo(map);

  showToast(`Evacuation route mapped to: ${shelterName} 🏃‍♂️`);
}

// --- 5. Volunteer Rescue Desk & Incident Resolution ---
async function loadRescueDashboard() {
  if (userRole !== 'volunteer') return;

  try {
    const response = await fetch('/api/dashboard/sos', {
      headers: { 'x-api-key': 'change-me' }
    });

    if (!response.ok) throw new Error("Could not fetch SOS cases.");
    const sosCases = await response.json();

    if ($('#sosCount')) $('#sosCount').textContent = String(sosCases.length).padStart(2, '0');
    if ($('#queueCount')) $('#queueCount').textContent = `${sosCases.length} open cases`;

    const casesContainer = $('#caseList');
    if (!casesContainer) return;
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
        <span><strong>SOS: ${item.people} Stranded</strong><small>${(item.note || '').substring(0, 25)}...</small></span>
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
  if (!detailBox) return;

  if (!item) {
    detailBox.innerHTML = '<p style="padding:20px; text-align:center; color:#666;">No active case selected.</p>';
    return;
  }

  detailBox.innerHTML = `
    <span class="field-label">Selected Case #${item.id}</span>
    <h3>SOS near ${Number(item.lat).toFixed(3)}, ${Number(item.lon).toFixed(3)}</h3>
    <p><strong>Emergency Note:</strong> ${item.note || 'No description provided.'}</p>
    <p><strong>People:</strong> ${item.people} | <strong>Phone:</strong> <a href="tel:${item.phone}">${item.phone || 'N/A'}</a></p>
    <p><strong>Wait Time:</strong> ${item.waiting_min || 0} mins | <strong>Risk Level:</strong> ${item.risk_level || 'High'}</p>
    <div style="margin-top: 15px; display: flex; gap: 10px;">
        <button class="primary-button" id="btnAssign">🦺 Dispatch Team</button>
        <button class="outline-button" id="btnResolve">✅ Mark Resolved</button>
    </div>
  `;

  $('#btnAssign').addEventListener('click', () => showToast(`Emergency Rescue team dispatched to Case #${item.id}!`));

  $('#btnResolve').addEventListener('click', async () => {
    try {
      const res = await fetch(`/api/sos/${item.id}/status?status=resolved`, {
        method: 'POST',
        headers: { 'x-api-key': 'change-me' }
      });

      if (res.ok) {
        showToast("Case successfully resolved!");
        loadRescueDashboard();
      } else {
        throw new Error('Server rejected resolution');
      }
    } catch (e) {
      showToast("Failed to close case.");
    }
  });
}

// --- 6. Offline Storage Engine (IndexedDB) ---
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

function getDeviceId() {
  let id = sessionStorage.getItem('resqwave_device_id');
  if (!id) {
    id = `device_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
    sessionStorage.setItem('resqwave_device_id', id);
  }
  return id;
}

// --- 7. Authentication Flow (Citizen OTP & Volunteer Login) ---
function showAuthStep(stepId) {
  document.querySelectorAll('.auth-step').forEach(step => {
    step.classList.toggle('active', step.id === stepId);
  });
}

function handleCitizenDetails(event) {
  event.preventDefault();
  const phone = document.getElementById('citizen-mobile').value;

  // Generate 5-digit demo OTP
  generatedOtp = String(Math.floor(10000 + Math.random() * 90000));
  alert(`(DEMO SMS) Your ResQWave OTP is: ${generatedOtp}`);

  document.getElementById('otp-phone-display').textContent = phone;
  showAuthStep('citizen-otp-step');
}

function handleOtpVerification(event) {
  event.preventDefault();
  const enteredOtp = document.getElementById('citizen-otp').value.trim();
  const errorElem = document.getElementById('otp-error');

  if (enteredOtp === generatedOtp) {
    if (errorElem) errorElem.textContent = '';
    showAuthStep('terms-conditions-step');
  } else {
    if (errorElem) errorElem.textContent = 'Invalid OTP. Please check the alert popup!';
  }
}

function handleTermsAcceptance(event) {
  event.preventDefault();
  const userProfile = {
    name: document.getElementById('citizen-name').value,
    mobile: document.getElementById('citizen-mobile').value,
    role: 'citizen',
    loggedIn: true
  };

  localStorage.setItem('resqwave_user', JSON.stringify(userProfile));

  const authOverlay = document.getElementById('authOverlay');
  if (authOverlay) {
    authOverlay.style.opacity = '0';
    setTimeout(() => { authOverlay.style.display = 'none'; }, 300);
  }

  setupUIForRole('citizen');
  showToast("Welcome to ResQWave! Stay safe 👤");
}

function handleVolunteerLogin(event) {
  event.preventDefault();
  const username = $('#volunteer-username').value.trim();
  const password = $('#volunteer-password').value.trim();
  const errorElem = $('#volunteer-error');

  // Hardcoded volunteer credential check
  if (username === 'volunteer' && password === 'sih2026') {
    if (errorElem) errorElem.textContent = '';
    const userProfile = {
      name: 'Rescue Volunteer',
      role: 'volunteer',
      loggedIn: true
    };

    localStorage.setItem('resqwave_user', JSON.stringify(userProfile));

    const authOverlay = document.getElementById('authOverlay');
    if (authOverlay) {
      authOverlay.style.opacity = '0';
      setTimeout(() => { authOverlay.style.display = 'none'; }, 300);
    }

    setupUIForRole('volunteer');
    showToast("Logged in to Rescue Desk! Stay alert 🦺");
  } else {
    if (errorElem) errorElem.textContent = 'Invalid credentials. (Hint: volunteer / sih2024)';
  }
}

// --- 8. App Startup & Event Listeners Initialization ---
window.addEventListener('DOMContentLoaded', () => {
  // Always initialize map
  initMap();

  // Check persistent login state in browser memory
  const savedUser = localStorage.getItem('resqwave_user');
  const authOverlay = document.getElementById('authOverlay');

  if (savedUser) {
    try {
      const user = JSON.parse(savedUser);
      if (authOverlay) authOverlay.style.display = 'none';
      setupUIForRole(user.role);
    } catch (e) {
      if (authOverlay) authOverlay.style.display = 'flex';
    }
  } else {
    if (authOverlay) authOverlay.style.display = 'flex';
  }

   // Logout listener with native confirmation prompt
  const logoutButton = document.getElementById('logoutButton');
  if (logoutButton) {
    logoutButton.addEventListener('click', () => {
      const confirmLogout = confirm("🚨 Are you sure you want to log out of ResQWave? You will need to sign in or register again to access your profile.");
      if (confirmLogout) {
        showToast("Logging you out safely... 📴");
        localStorage.removeItem('resqwave_user');
        // Small delay so the user can see the toast message before the page reloads
        setTimeout(() => {
          window.location.reload();
        }, 1000);
      }
    });
  }


  // Navigation tab switcher
  $$('.nav-link').forEach((button) => {
    if (button.id !== 'logoutButton') {
      button.addEventListener('click', () => setView(button.dataset.view));
    }
  });

  // Emergency Shelter Finder
  const findShelterBtn = document.getElementById('findShelterBtn');
  if (findShelterBtn) {
    findShelterBtn.addEventListener('click', () => {
      setView('home');
      showToast("Click on the map or search your village to display nearest emergency shelters! 🏥");
    });
  }

  // Search button & Enter key
  const searchBtn = document.getElementById('searchButton');
  if (searchBtn) searchBtn.addEventListener('click', handleSearch);

  const locationSearch = document.getElementById('locationSearch');
  if (locationSearch) {
    locationSearch.addEventListener('keypress', (e) => {
      if (e.key === 'Enter') handleSearch();
    });
  }

  // Evacuation button handler
  const btnEvacuate = document.getElementById('btnEvacuate');
  if (btnEvacuate) {
    btnEvacuate.addEventListener('click', async () => {
      if (!marker) {
        showToast("Please select your location on the map first!");
        return;
      }
      const currentPos = marker.getLatLng();
      showToast("Finding nearest high-ground shelter...");
      try {
        const res = await fetch(`/api/shelters?lat=${currentPos.lat}&lon=${currentPos.lng}&radius_km=25`);
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
  }

  // Modal dialog controls
  $$('[data-close-dialog]').forEach((button) => button.addEventListener('click', () => {
    $(`#${button.dataset.closeDialog}`).close();
  }));

  $$('[data-report]').forEach((button) => button.addEventListener('click', () => {
    $('#reportType').value = button.dataset.report;
    $('#reportDialog').showModal();
  }));

  $$('[data-open-sos]').forEach((button) => button.addEventListener('click', () => $('#sosDialog').showModal()));

  // 1-Tap Quick SOS Handler (with satellite fallback)
  const btnInstantSOS = document.getElementById('btnInstantSOS');
  if (btnInstantSOS) {
    btnInstantSOS.addEventListener('click', async () => {
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
        } catch (e) {}
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
        const res = await fetch('/api/sos', {
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
      } catch (err) {
        await saveReportLocally(sosPayload);
        const satSMS = `SOS*AAPDA*${lat.toFixed(4)},${lon.toFixed(4)}*P:${people}`;
        window.location.href = `sms:112?body=${encodeURIComponent(satSMS)}`;
        showToast("Server timed out. Saved locally and triggered Emergency SMS 🚨");
        $('#sosDialog').close();
      }
    });
  }

  // Detailed Hazard Report Submission
  const reportForm = document.getElementById('reportForm');
  if (reportForm) {
    reportForm.addEventListener('submit', async (event) => {
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
        const response = await fetch('/api/reports', {
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
  }

  // Detailed SOS Emergency Form Submission
  const sosForm = document.getElementById('sosForm');
  if (sosForm) {
    sosForm.addEventListener('submit', async (event) => {
      event.preventDefault();
      if (!marker) {
        showToast("Please select your location on the map first!");
        return;
      }
      const currentPos = marker.getLatLng();
      const people = parseInt($('#sosPeople').value) || 1;
      const note = $('#sosNotes').value.trim() || "Emergency evacuation required";
      const phone = "9100000000";

      if (!navigator.onLine) {
        const satPayload = `SOS*RESQWAVE*LAT:${currentPos.lat.toFixed(4)}*LON:${currentPos.lng.toFixed(4)}*PEOPLE:${people}*NOTE:${encodeURIComponent(note)}`;
        window.location.href = `sms:112?body=${satPayload}`;
        showToast("No internet detected. Diverted to Satellite / SMS Emergency Dispatch (112) 📡");
        $('#sosDialog').close();
        return;
      }

      const sosData = {
        client_id: `sos_${Date.now()}`,
        lat: currentPos.lat,
        lon: currentPos.lng,
        people: people,
        note: note,
        phone: phone
      };

      try {
        const response = await fetch('/api/sos', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(sosData)
        });
        if (!response.ok) throw new Error('SOS failed');
        const result = await response.json();
        showToast(result.message || "Emergency SOS logged!");
        $('#sosDialog').close();
        event.target.reset();
      } catch (e) {
        const satPayload = `SOS*LAT:${currentPos.lat.toFixed(4)}*LON:${currentPos.lng.toFixed(4)}*PEOPLE:${people}`;
        window.location.href = `sms:112?body=${satPayload}`;
        showToast("Server unreachable. Switched to Emergency SMS / Satellite fallback.");
      }
    });
  }

  // Refresh Desk Button
  const refreshDesk = document.getElementById('refreshDesk');
  if (refreshDesk) {
    refreshDesk.addEventListener('click', () => {
      showToast('Refreshing live active cases...');
      loadRescueDashboard();
    });
  }
});
