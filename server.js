const http = require('node:http');
const { exec } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const PORT = Number(process.env.PORT || 3000);
const ROOT = __dirname;
const dataDirectory = path.join(ROOT, 'data');
const databaseFile = path.join(dataDirectory, 'resqwave.db');

fs.mkdirSync(dataDirectory, { recursive: true });
const database = new DatabaseSync(databaseFile);
database.exec(`
  PRAGMA journal_mode = WAL;
  CREATE TABLE IF NOT EXISTS reports (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    type TEXT NOT NULL,
    location TEXT NOT NULL,
    notes TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'community',
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS cases (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    kind TEXT NOT NULL,
    title TEXT NOT NULL,
    people TEXT NOT NULL DEFAULT '',
    location TEXT NOT NULL,
    notes TEXT NOT NULL DEFAULT '',
    priority TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'open',
    assigned_team TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL
  );
`);

function seedData() {
  const reportCount = database.prepare('SELECT COUNT(*) AS count FROM reports').get().count;
  const caseCount = database.prepare('SELECT COUNT(*) AS count FROM cases').get().count;
  const now = Date.now();
  if (reportCount === 0) {
    const addReport = database.prepare('INSERT INTO reports (type, location, notes, status, created_at) VALUES (?, ?, ?, ?, ?)');
    addReport.run('Flooded area', 'Harsil bridge', 'Water is rising near the crossing.', 'verified', new Date(now - 12 * 60 * 1000).toISOString());
    addReport.run('Blocked road', 'Dharali turn', 'Debris has partly blocked the road.', 'verified', new Date(now - 26 * 60 * 1000).toISOString());
    addReport.run('Heavy rainfall', 'Bagori', 'Rainfall is intense near the village.', 'community', new Date(now - 38 * 60 * 1000).toISOString());
  }
  if (caseCount === 0) {
    const addCase = database.prepare('INSERT INTO cases (kind, title, people, location, notes, priority, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
    addCase.run('sos', 'SOS from Dharali family', '2 adults, 1 child', 'Dharali school road', 'Last GPS location received 4 minutes ago. Nearest safe route avoids the Harsil bridge.', 'Critical', 'open', new Date(now - 12 * 60 * 1000).toISOString());
    addCase.run('report', 'Harsil bridge flooding', '', 'Harsil bridge', 'Water is rising near the bridge. The report is verified and the crossing should be avoided.', 'High', 'open', new Date(now - 14 * 60 * 1000).toISOString());
    addCase.run('report', 'Road obstruction near Bagori', '', 'Bagori', 'A resident reports debris across the road. A team should verify before routing vehicles through this section.', 'Moderate', 'open', new Date(now - 28 * 60 * 1000).toISOString());
  }
}

seedData();

const contentTypes = { '.css': 'text/css; charset=utf-8', '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8' };
const cleanText = (value, maxLength = 500) => typeof value === 'string' ? value.trim().slice(0, maxLength) : '';
const sendJson = (response, statusCode, data) => { response.writeHead(statusCode, { 'Content-Type': 'application/json; charset=utf-8' }); response.end(JSON.stringify(data)); };
const formatRow = (row) => ({ ...row, id: Number(row.id) });
const getReports = () => database.prepare('SELECT * FROM reports ORDER BY created_at DESC LIMIT 50').all().map(formatRow);
const getCases = () => database.prepare("SELECT * FROM cases WHERE status != 'resolved' ORDER BY CASE priority WHEN 'Critical' THEN 1 WHEN 'High' THEN 2 WHEN 'Moderate' THEN 3 ELSE 4 END, created_at DESC LIMIT 50").all().map(formatRow);

function getBody(request) {
  return new Promise((resolve, reject) => {
    let body = '';
    request.on('data', (chunk) => { body += chunk; if (body.length > 100_000) { reject(new Error('Request body is too large.')); request.destroy(); } });
    request.on('end', () => { try { resolve(body ? JSON.parse(body) : {}); } catch { reject(new Error('Request body must be valid JSON.')); } });
    request.on('error', reject);
  });
}

async function handleApi(request, response, url) {
  if (request.method === 'GET' && url.pathname === '/api/health') return sendJson(response, 200, { ok: true, service: 'ResQWave API' });
  if (request.method === 'GET' && url.pathname === '/api/reports') return sendJson(response, 200, { reports: getReports() });
  if (request.method === 'GET' && url.pathname === '/api/cases') return sendJson(response, 200, { cases: getCases() });
  if (request.method === 'POST' && url.pathname === '/api/reports') {
    const body = await getBody(request);
    const type = cleanText(body.type, 80), location = cleanText(body.location, 160), notes = cleanText(body.notes);
    if (!type || !location) return sendJson(response, 400, { error: 'Report type and location are required.' });
    const result = database.prepare('INSERT INTO reports (type, location, notes, status, created_at) VALUES (?, ?, ?, ?, ?)').run(type, location, notes, 'community', new Date().toISOString());
    return sendJson(response, 201, { report: formatRow(database.prepare('SELECT * FROM reports WHERE id = ?').get(Number(result.lastInsertRowid))) });
  }
  if (request.method === 'POST' && url.pathname === '/api/sos') {
    const body = await getBody(request);
    const location = cleanText(body.location, 160), people = cleanText(body.people, 80), notes = cleanText(body.notes);
    if (!location || !people) return sendJson(response, 400, { error: 'Location and number of people are required.' });
    const result = database.prepare('INSERT INTO cases (kind, title, people, location, notes, priority, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run('sos', `SOS near ${location}`, people, location, notes || 'No additional details provided.', 'Critical', 'open', new Date().toISOString());
    return sendJson(response, 201, { case: formatRow(database.prepare('SELECT * FROM cases WHERE id = ?').get(Number(result.lastInsertRowid))) });
  }
  const assignMatch = url.pathname.match(/^\/api\/cases\/(\d+)\/assign$/);
  if (request.method === 'POST' && assignMatch) {
    const id = Number(assignMatch[1]);
    if (!database.prepare('SELECT id FROM cases WHERE id = ?').get(id)) return sendJson(response, 404, { error: 'Case not found.' });
    database.prepare("UPDATE cases SET assigned_team = ?, status = 'assigned' WHERE id = ?").run('Response Team Alpha', id);
    return sendJson(response, 200, { case: formatRow(database.prepare('SELECT * FROM cases WHERE id = ?').get(id)) });
  }
  return sendJson(response, 404, { error: 'API route not found.' });
}

function serveStatic(response, pathname) {
  const relativePath = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const requestedFile = path.resolve(ROOT, relativePath);
  if (!requestedFile.startsWith(ROOT + path.sep)) { response.writeHead(403); response.end('Forbidden'); return; }
  fs.readFile(requestedFile, (error, file) => {
    if (error) { response.writeHead(error.code === 'ENOENT' ? 404 : 500); response.end(error.code === 'ENOENT' ? 'Not found' : 'Unable to read file'); return; }
    response.writeHead(200, { 'Content-Type': contentTypes[path.extname(requestedFile)] || 'application/octet-stream' });
    response.end(file);
  });
}

const server = http.createServer(async (request, response) => {
  const url = new URL(request.url, `http://${request.headers.host || 'localhost'}`);
  try {
    if (url.pathname.startsWith('/api/')) await handleApi(request, response, url);
    else if (request.method === 'GET') serveStatic(response, url.pathname);
    else sendJson(response, 405, { error: 'Method not allowed.' });
  } catch (error) { console.error(error); sendJson(response, 500, { error: error.message || 'Unexpected server error.' }); }
});

server.on('error', (error) => {
  console.error(`ResQWave could not start: ${error.message}`);
  process.exitCode = 1;
});

server.listen(PORT, '127.0.0.1', () => {
  const address = `http://localhost:${PORT}`;
  console.log(`ResQWave is running at ${address}`);
  if (process.env.OPEN_RESQWAVE_BROWSER === '1') exec(`start "" "${address}"`);
});
