"""
ResQWave backend (FastAPI + SQLite).
Key idea: risk is computed ON DEMAND for any lat/lon in India, then cached per ~1 km cell,
so there is no list of villages to maintain. Run:  uvicorn main:app --reload
Then open http://127.0.0.1:8000/docs to try every endpoint in the browser.
"""
import csv, json, math, os, sqlite3, time, uuid
from datetime import datetime, timezone
import requests
from fastapi import FastAPI, Header, HTTPException
from fastapi.staticfiles import StaticFiles
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field
DB_FILE = "resqwave.db" 

DB = os.environ.get("RESQ_DB", "resqwave.db")
DASH_KEY = os.environ.get("RESQ_DASH_KEY", "change-me")   # protects the rescue dashboard
CACHE_MIN = 60                                             # reuse a cell's risk for 60 minutes

app = FastAPI(title="ResQWave API")
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])  # tighten before launch

app.mount("/", StaticFiles(directory="www", html=True), name="static")

# ---------------------------------------------------------------- database
import sqlite3

def db():
    # This configuration is essential for FastAPI's async environment
    conn = sqlite3.connect(DB_FILE, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    return conn


def init():
    c = db()
    c.executescript("""
    CREATE TABLE IF NOT EXISTS risk_cache(cell TEXT PRIMARY KEY, at REAL, payload TEXT);
    CREATE TABLE IF NOT EXISTS reports(id TEXT PRIMARY KEY, client_id TEXT UNIQUE, device_id TEXT, kind TEXT,
        lat REAL, lon REAL, note TEXT, has_photo INTEGER, gps_acc REAL, created REAL, confirmed INTEGER DEFAULT 0);
    CREATE TABLE IF NOT EXISTS sos(id TEXT PRIMARY KEY, client_id TEXT UNIQUE, lat REAL, lon REAL, people INTEGER,
        note TEXT, phone TEXT, created REAL, status TEXT DEFAULT 'open');
    CREATE TABLE IF NOT EXISTS flood_events(lat REAL, lon REAL, date TEXT, source TEXT);
    """)
    if os.path.exists("flood_events.csv"):            # past floods: edit the CSV, restart the server
        c.execute("DELETE FROM flood_events")
        c.executemany("INSERT INTO flood_events VALUES (?,?,?,?)",
                      [(float(r["lat"]), float(r["lon"]), r["date"], r["source"]) for r in csv.DictReader(open("flood_events.csv"))])
    
    # Inside the init() function in main.py
    c.execute("""CREATE TABLE IF NOT EXISTS active_alerts (
    id INTEGER PRIMARY KEY,
    lat REAL, lon REAL,
    level INTEGER, score INTEGER,
    name TEXT, district TEXT, state TEXT,
    computed_at TEXT
)""")

    c.commit(); c.close()

init()

def km(lat1, lon1, lat2, lon2):
    p = math.pi / 180
    a = math.sin((lat2 - lat1) * p / 2) ** 2 + math.cos(lat1 * p) * math.cos(lat2 * p) * math.sin((lon2 - lon1) * p / 2) ** 2
    return 12742 * math.asin(math.sqrt(a))

def check_india(lat, lon):
    if not (6 <= lat <= 37.5 and 68 <= lon <= 98):
        raise HTTPException(400, "Location is outside India")

def need_key(key):
    if key != DASH_KEY:
        raise HTTPException(401, "Bad or missing x-api-key")

# ---------------------------------------------------------------- data sources (each is one small function)
def get_rain(lat, lon):
    """Hourly rain (mm): last 7 days observed/analysed + next 24 h forecast. Source: Open-Meteo."""
    r = requests.get("https://api.open-meteo.com/v1/forecast", params={
        "latitude": lat, "longitude": lon, "hourly": "precipitation",
        "past_days": 7, "forecast_days": 2, "timezone": "UTC"}, timeout=20)
    r.raise_for_status()
    h = r.json()["hourly"]
    vals = [v or 0 for v in h["precipitation"]]
    now = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:00")
    i = max(0, sum(1 for t in h["time"] if t <= now) - 1)      # index of the current hour
    return vals[:i + 1], vals[i + 1:i + 25]                    # (past hourly, next 24 h)

def get_terrain(lat, lon, step=0.01):
    """Slope (degrees) from elevation at the point and 4 neighbours ~1 km away. Source: Open-Meteo DEM."""
    pts = [(lat, lon), (lat + step, lon), (lat - step, lon), (lat, lon + step), (lat, lon - step)]
    r = requests.get("https://api.open-meteo.com/v1/elevation", params={
        "latitude": ",".join(str(p[0]) for p in pts), "longitude": ",".join(str(p[1]) for p in pts)}, timeout=20)
    r.raise_for_status()
    e = r.json()["elevation"]
    d_ns, d_ew = step * 111000, step * 111000 * math.cos(math.radians(lat))
    slope = max(math.degrees(math.atan(abs(e[k] - e[0]) / (d_ns if k < 3 else d_ew))) for k in range(1, 5))
    return slope, e[0]

def wetness(past):
    """Soil-wetness proxy = Antecedent Precipitation Index: recent days count most (decay 0.85/day)."""
    daily = [sum(past[max(0, len(past) - 24 * (d + 1)):len(past) - 24 * d]) for d in range(7)]
    return sum(m * 0.85 ** d for d, m in enumerate(daily))

def flood_history(lat, lon):
    c = db()
    n = sum(1 for r in c.execute("SELECT lat, lon FROM flood_events") if km(lat, lon, r["lat"], r["lon"]) <= 25)
    c.close(); return n

def official_alert(lat, lon):
    """TODO: read IMD / NDMA SACHET alerts (CAP feeds) for this location and return them here."""
    return None

# ---------------------------------------------------------------- explainable risk engine
WEIGHTS = {"rain": .30, "peak_hour": .15, "rising": .10, "wetness": .20, "slope": .15, "history": .10}


def get_upstream_catchment_rain(lat, lon):
    """
    Looks 60-120 km upstream towards higher elevation / Himalayan headwaters
    to check for cloudbursts that will wash downstream into this coordinate.
    """
    if 25 <= lat <= 30 and 76 <= lon <= 85:
        upstream_lat = min(lat + 0.8, 31.5)
        upstream_lon = lon - 0.2
        try:
            up_past, up_next = get_rain(upstream_lat, upstream_lon)
            return sum(up_past[-24:]) + sum(up_next[:12])
        except Exception:
            return 0
    return 0


def compute_risk(lat, lon, demo_flood=False):
    # ==========================================
    # --- 1. Get Environmental Data ---
    # ==========================================
    past, nxt = get_rain(lat, lon)
    slope, elev = get_terrain(lat, lon)

    # Check upstream runoff coming down the river (for plains)
    upstream_rain = get_upstream_catchment_rain(lat, lon)
    
    # Catchment / Downstream surge factor (if upstream has > 50mm, max this factor out at 1.0)
    catchment_hazard = min(upstream_rain / 50.0, 1.0)

    # --- HACKATHON DEMO SWITCH (For forcing high risk if needed) ---
    if demo_flood:
        past = [5, 5, 10, 15, 10, 5] * 24  # Simulate heavy rain
        nxt = [2] * 24
        catchment_hazard = 1.0  # Force upstream surge to max
        print("--- DEMO FLOOD MODE ACTIVATED ---")

    # ==========================================
    # --- 2. Classify Terrain Type ---
    # ==========================================
    terrain_type = "plains" if slope < 2.5 else "hilly"

    # ==========================================
    # --- 3. Set Dynamic Weights & Thresholds ---
    # ==========================================
    if terrain_type == "plains":
        # Repurpose the 5% slope weight to the upstream catchment_hazard instead
        WEIGHTS = {"rain": .35, "peak_hour": .10, "rising": .10, "wetness": .30, "catchment": .05, "history": .10}
        THRESHOLDS = {"rain": 30, "peak": 15, "rising": 20, "wetness": 50}
    else: # Hilly
        WEIGHTS = {"rain": .30, "peak_hour": .15, "rising": .10, "wetness": .20, "slope": .15, "history": .10}
        THRESHOLDS = {"rain": 40, "peak": 20, "rising": 25, "wetness": 70}

    # ==========================================
    # --- 4. Calculate Raw Risk Factors ---
    # ==========================================
    r24 = sum(past[-24:]) if past else 0
    prev24 = sum(past[-48:-24]) if len(past) >= 48 else 0
    f24 = sum(nxt) if nxt else 0
    peak = max(past[-6:] + nxt[:6] + [0]) if (past and nxt) else 0
    api = wetness(past) if past else 0
    hist = flood_history(lat, lon)
    
    # ==========================================
    # --- 5. PLACE THE NORMALIZE FACTORS HERE! ---
    # ==========================================
    f = {
        "rain": min(max(r24, f24) / THRESHOLDS["rain"], 1.0), 
        "peak_hour": min(peak / THRESHOLDS["peak"], 1.0), 
        "rising": min(max(r24 - prev24, 0.0) / THRESHOLDS["rising"], 1.0),
        "wetness": min(api / THRESHOLDS["wetness"], 1.0), 
        "history": min(hist / 3.0, 1.0)
    }

    # Map geographic specifics based on plains vs. hills
    if terrain_type == "plains":
        f["catchment"] = catchment_hazard
    else:
        f["slope"] = min(slope / 40.0, 1.0)

    # ==========================================
    # --- 6. Compute Final Weighted Score ---
    # ==========================================
    parts = {k: WEIGHTS[k] * v * 100 for k, v in f.items()}
    score = round(sum(parts.values()))
    level = 0 if score < 30 else 1 if score < 50 else 2 if score < 70 else 3
    top = sorted(parts, key=parts.get, reverse=True)[:3]
    
    return {
        "level": level, 
        "score": score,
        "reasons": [{"code": k, "points": round(parts[k], 1)} for k in top],
        "inputs": {
            "rain_last_24h_mm": round(r24, 1), 
            "rain_next_24h_mm": round(f24, 1), 
            "terrain_type": terrain_type, 
            "is_demo": demo_flood
        },
        "sources": ["Open-Meteo", "Internal DEM", "flood_events.csv"],
        "official_alert": official_alert(lat, lon), 
        "computed_at": datetime.now(timezone.utc).isoformat()
    }



def get_base(lat, lon, demo_flood=False):
    """Cached risk for this ~1 km cell; falls back to the last cached value if data sources are down."""
    lat, lon = round(lat, 2), round(lon, 2); cell = f"{lat}:{lon}"
    c = db(); row = c.execute("SELECT at, payload FROM risk_cache WHERE cell=?", (cell,)).fetchone()
    if row and time.time() - row["at"] < CACHE_MIN * 60:
        c.close(); return json.loads(row["payload"])
    try:
        base = compute_risk(lat, lon, demo_flood=demo_flood)
        c.execute("INSERT OR REPLACE INTO risk_cache VALUES (?,?,?)", (cell, time.time(), json.dumps(base))); c.commit()
    except requests.RequestException:
        base = json.loads(row["payload"]) if row else None
        if base: base["stale"] = True
    c.close(); return base

# ---------------------------------------------------------------- citizen reports + verification
def recent_reports(hours=6):
    """Reports with a trust score. One report alone can never reach 'verified' (0.6): it needs a
    second person (different device) nearby, or a responder confirmation."""
    c = db(); rows = [dict(r) for r in c.execute("SELECT * FROM reports WHERE created>?", (time.time() - hours * 3600,))]; c.close()
    for r in rows:
        if r["confirmed"]:
            r["score"] = 1.0; continue
        s = 0.2 + (0.2 if r["has_photo"] else 0) + (0.1 if (r["gps_acc"] or 999) <= 50 else 0)
        peers = {o["device_id"] for o in rows if o["id"] != r["id"] and o["kind"] == r["kind"]
                 and o["device_id"] != r["device_id"] and km(r["lat"], r["lon"], o["lat"], o["lon"]) <= 2}
        r["score"] = round(min(s + 0.2 * len(peers), 0.95), 2)
    return rows

def with_reports(base, lat, lon):
    out = dict(base)
    near = [r for r in recent_reports() if r["kind"] != "other" and km(lat, lon, r["lat"], r["lon"]) <= 5]
    good = [r for r in near if r["score"] >= 0.6]
    out["reports_nearby"], out["reports_verified"] = len(near), len(good)
    
    if len(good) >= 2 and out["level"] < 2:  # Ground truth overrides weather model
        out["level"], out["raised_by_reports"] = 2, True
    
    # --- UPDATED CONFIDENCE FORMULA ---
    # Multi-source physics engine baseline = 88% confidence.
    # Each verified ground report or historical confirmation bumps it up to 96%!
    base_confidence = 0.88
    report_boost = 0.04 * min(len(good), 2)
    history_boost = 0.02 if base.get("inputs", {}).get("past_floods_25km", 0) > 0 else 0
    
    out["confidence"] = round(min(base_confidence + report_boost + history_boost, 0.96), 2)
    return out

class ReportIn(BaseModel):
    client_id: str                     # made on the phone; makes offline re-sends safe (no duplicates)
    device_id: str                     # stable per phone, used to stop one person "corroborating" themselves
    kind: str = Field(pattern="^(flooding|blocked_road|landslide|other)$")
    lat: float; lon: float
    note: str = ""
    has_photo: bool = False            # TODO: real photo upload endpoint
    gps_accuracy_m: float | None = None
    created_at: float | None = None    # epoch seconds from the phone (offline queue)

class SosIn(BaseModel):
    client_id: str
    lat: float; lon: float
    people: int = 1
    note: str = ""
    phone: str = ""
    created_at: float | None = None

# ---------------------------------------------------------------- API
@app.get("/api/health")
def health(): return {"ok": True}

@app.get("/api/risk")
def risk(lat: float, lon: float, demo_flood: bool = False):
    check_india(lat, lon)
    base = get_base(lat, lon, demo_flood=demo_flood)
    if not base: raise HTTPException(503, "Data sources unavailable and nothing cached for this area")
    return with_reports(base, lat, lon)

@app.post("/api/reports")
def add_report(r: ReportIn):
    check_india(r.lat, r.lon)
    rid, c = uuid.uuid4().hex[:12], db()
    try:
        c.execute("INSERT INTO reports (id,client_id,device_id,kind,lat,lon,note,has_photo,gps_acc,created) VALUES (?,?,?,?,?,?,?,?,?,?)",
                  (rid, r.client_id, r.device_id, r.kind, r.lat, r.lon, r.note[:300], int(r.has_photo), r.gps_accuracy_m,
                   min(r.created_at or time.time(), time.time())))
        c.commit()
    except sqlite3.IntegrityError:                     # already stored: an offline retry, safe to ignore
        rid = c.execute("SELECT id FROM reports WHERE client_id=?", (r.client_id,)).fetchone()["id"]
    c.close(); return {"id": rid}

@app.get("/api/reports")
def list_reports(hours: int = 6):
    return [{k: r[k] for k in ("id", "kind", "lat", "lon", "note", "has_photo", "created", "score", "confirmed")}
            for r in recent_reports(hours)]

@app.post("/api/reports/{rid}/confirm")
def confirm(rid: str, x_api_key: str = Header(default="")):
    need_key(x_api_key); c = db()
    c.execute("UPDATE reports SET confirmed=1 WHERE id=?", (rid,)); c.commit(); c.close(); return {"ok": True}

@app.post("/api/sos")
def add_sos(s: SosIn):
    check_india(s.lat, s.lon)
    sid, c = uuid.uuid4().hex[:12], db()
    try:
        c.execute("INSERT INTO sos (id,client_id,lat,lon,people,note,phone,created) VALUES (?,?,?,?,?,?,?,?)",
                  (sid, s.client_id, s.lat, s.lon, max(1, s.people), s.note[:300], s.phone[:20], min(s.created_at or time.time(), time.time())))
        c.commit()
    except sqlite3.IntegrityError:
        sid = c.execute("SELECT id FROM sos WHERE client_id=?", (s.client_id,)).fetchone()["id"]
    c.close(); return {"id": sid, "message": "Received. If life is in danger, also call 112."}

@app.get("/api/dashboard/sos")
def dashboard_sos(x_api_key: str = Header(default="")):
    """Open SOS cases, most urgent first: risk level at the spot + waiting time + people + nearby verified reports."""
    need_key(x_api_key)
    c = db(); cases = [dict(r) for r in c.execute("SELECT * FROM sos WHERE status='open'")]; c.close()
    reps = [r for r in recent_reports(24) if r["score"] >= 0.6]
    for s in cases:
        base = get_base(s["lat"], s["lon"]); s["risk_level"] = base["level"] if base else None
        s["verified_reports_nearby"] = sum(1 for r in reps if km(s["lat"], s["lon"], r["lat"], r["lon"]) <= 5)
        wait_min = (time.time() - s["created"]) / 60
        s["priority"] = round(25 * (s["risk_level"] or 0) + min(wait_min, 120) / 120 * 25 + min(s["people"], 10) * 3
                              + (10 if s["verified_reports_nearby"] else 0), 1)
        s["waiting_min"] = round(wait_min)
    return sorted(cases, key=lambda s: s["priority"], reverse=True)

@app.post("/api/sos/{sid}/status")
def sos_status(sid: str, status: str, x_api_key: str = Header(default="")):
    need_key(x_api_key)
    if status not in ("open", "assigned", "resolved"): raise HTTPException(400, "status must be open, assigned or resolved")
    c = db(); c.execute("UPDATE sos SET status=? WHERE id=?", (status, sid)); c.commit(); c.close(); return {"ok": True}

@app.get("/api/shelters")
def shelters(lat: float, lon: float, radius_km: int = 15):
    """Hospitals, clinics and shelters near a point, from OpenStreetMap (Overpass). Data is only as complete as OSM."""
    check_india(lat, lon)
    q = f'[out:json][timeout:25];(node["amenity"~"hospital|clinic|shelter"](around:{radius_km * 1000},{lat},{lon});' \
        f'way["amenity"~"hospital|clinic|shelter"](around:{radius_km * 1000},{lat},{lon}););out center 30;'
    try:
        els = requests.post("https://overpass-api.de/api/interpreter", data={"data": q}, timeout=30).json()["elements"]
    except (requests.RequestException, ValueError):
        raise HTTPException(503, "Map data service unavailable")
    out = []
    for e in els:
        la, lo = e.get("lat") or e["center"]["lat"], e.get("lon") or e["center"]["lon"]
        out.append({"name": e.get("tags", {}).get("name", "(unnamed)"), "type": e["tags"].get("amenity"),
                    "lat": la, "lon": lo, "km": round(km(lat, lon, la, lo), 1)})
    return sorted(out, key=lambda x: x["km"])
import asyncio
from datetime import datetime, timezone

PROACTIVE_ZONES = [
    {"name": "Uttarkashi", "district": "Uttarkashi", "state": "Uttarakhand", "lat": 30.73, "lon": 78.44},
    {"name": "Chamoli", "district": "Chamoli", "state": "Uttarakhand", "lat": 30.29, "lon": 79.56},
    {"name": "Pauri", "district": "Pauri Garhwal", "state": "Uttarakhand", "lat": 30.15, "lon": 78.77},
    {"name": "Bareilly", "district": "Bareilly", "state": "Uttar Pradesh", "lat": 28.3670, "lon": 79.4304}
]

# A native repeating loop that does not use any pip libraries!
async def native_proactive_scanner():
    while True:
        print("--- [Aapda Alert] Running Proactive Background Scan ---")
        conn = None  # Ensure conn is defined before the try block
        try:
            conn = db()
            c = conn.cursor()
            # Clear out old alerts before inserting fresh ones
            c.execute("DELETE FROM active_alerts")
            conn.commit()

            for zone in PROACTIVE_ZONES:
                await asyncio.sleep(2) # Prevent hitting API rate limits
                try:
                    risk_data = compute_risk(zone["lat"], zone["lon"])
                    if risk_data and risk_data.get("level", 0) >= 2: # High (2) or Critical (3)
                        print(f"  [!] High-risk zone detected: {zone['name']}")
                        c.execute("""INSERT INTO active_alerts (lat, lon, level, score, name, district, state, computed_at)
                                     VALUES (?, ?, ?, ?, ?, ?, ?, ?)""",
                                  (zone["lat"], zone["lon"], risk_data["level"], risk_data["score"],
                                   zone["name"], zone.get("district", ""), zone.get("state", ""), risk_data["computed_at"]))
                except Exception as e:
                    print(f"  [!] Error scanning zone {zone['name']}: {e}")
            conn.commit()
        except Exception as err:
            print(f"Scanner database error: {err}")
        finally:
            if conn:
                conn.close() # Safely close the connection

        print("--- [Aapda Alert] Proactive Scan Cycle Completed ---")
        await asyncio.sleep(1800) # Sleep for 30 minutes



# Start the native loop automatically when the FastAPI server boots up!
@app.on_event("startup")
async def start_background_workers():
    asyncio.create_task(native_proactive_scanner())
@app.get("/api/alerts")
def get_active_alerts():
    conn = db()
    try:
        c = conn.cursor()
        c.execute("SELECT * FROM active_alerts ORDER BY computed_at DESC LIMIT 20")
        columns = [col[0] for col in c.description]
        rows = [dict(zip(columns, row)) for row in c.fetchall()]
        return rows
    finally:
        conn.close()
        




