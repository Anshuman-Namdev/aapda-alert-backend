// public/sw-sync.js (Service Worker for Background Sync)
const DB_NAME = 'AapdaAlertOffline';
const STORE_NAME = 'pendingReports';

// Initialize IndexedDB
function openDatabase() {
    return new Promise((resolve, reject) => {
        const request = indexedDB.open(DB_NAME, 1);
        request.onupgradeneeded = (event) => {
            const db = event.target.result;
            db.createObjectStore(STORE_NAME, { keyPath: 'id', autoIncrement: true });
        };
        request.onsuccess = (event) => resolve(event.target.result);
        request.onerror = (event) => reject(event.target.error);
    });
}

// Queue a report locally when offline
async function queueReport(reportData) {
    const db = await openDatabase();
    return new Promise((resolve, reject) => {
        const transaction = db.transaction(STORE_NAME, 'readwrite');
        const store = transaction.objectStore(STORE_NAME);
        const request = store.add({
            ...reportData,
            timestamp: Date.now(),
            synced: false
        });
        request.onsuccess = () => {
            console.log("📌 Report queued locally (Offline-First)");
            resolve(true);
        };
        request.onerror = () => reject(request.error);
    });
}

// Register Background Sync Event
self.addEventListener('sync', (event) => {
    if (event.tag === 'sync-reports') {
        event.waitUntil(syncReportsWithServer());
    }
});

// Auto-sync queued reports when network returns
async function syncReportsWithServer() {
    const db = await openDatabase();
    const transaction = db.transaction(STORE_NAME, 'readwrite');
    const store = transaction.objectStore(STORE_NAME);
    
    const request = store.getAll();
    request.onsuccess = async () => {
        const pending = request.result.filter(r => !r.synced);
        for (const report of pending) {
            try {
                const response = await fetch('/reports', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(report)
                });
                if (response.ok) {
                    store.delete(report.id); // Remove from offline DB once synced
                    console.log(`✅ Successfully synced report #${report.id}`);
                }
            } catch (err) {
                console.error("Sync failed, waiting for next connection window.", err);
                break; // Stop loop to retry later if network is still unstable
            }
        }
    };
}
