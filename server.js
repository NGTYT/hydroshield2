const express = require('express');
const Database = require('better-sqlite3');
const path = require('path');

const PORT = Number(process.env.PORT) || 3000;
const DEVICE_ID = 'AquaSense-Node-01';
const INTERVAL_MIN = 10;
const OFFLINE_MS = (Number(process.env.OFFLINE_MINUTES) || 25) * 60000;

// Set SIMULATE_READINGS=true to insert fake, labelled readings automatically.
const SIMULATE = process.env.SIMULATE_READINGS === 'true';
const SIM_INTERVAL_SEC = Number(process.env.SIM_INTERVAL_SECONDS) || 600;

// --------------------------------------------------
// Database
// --------------------------------------------------

const db = new Database(
  process.env.DB_PATH || path.join(__dirname, 'aquasense.db')
);

db.exec(`
CREATE TABLE IF NOT EXISTS sensor_readings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  device_id TEXT NOT NULL,
  tds_ppm REAL NOT NULL,
  turbidity_raw REAL NOT NULL,
  turbidity_ntu REAL,
  temperature_c REAL NOT NULL,
  ph REAL,
  is_simulated INTEGER NOT NULL DEFAULT 0,
  device_timestamp TEXT,
  received_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_readings_received
ON sensor_readings(received_at);
`);

// Upgrade existing databases created before pH / is_simulated existed.
const columns = db.prepare('PRAGMA table_info(sensor_readings)').all();

if (!columns.some(column => column.name === 'ph')) {
  db.exec('ALTER TABLE sensor_readings ADD COLUMN ph REAL');
}

if (!columns.some(column => column.name === 'is_simulated')) {
  db.exec('ALTER TABLE sensor_readings ADD COLUMN is_simulated INTEGER NOT NULL DEFAULT 0');
}

// --------------------------------------------------
// Express application
// --------------------------------------------------

const app = express();
app.disable('x-powered-by');

// Rate limiter: 60 requests per minute per IP.
const hits = new Map();

app.use('/api', (req, res, next) => {
  const now = Date.now();

  const h = (hits.get(req.ip) || []).filter(
    timestamp => now - timestamp < 60000
  );

  h.push(now);
  hits.set(req.ip, h);

  if (h.length > 60) {
    return res.status(429).json({ error: 'Too many requests' });
  }

  next();
});

// Shared columns for local latest/history responses.
const COLS = `
  id,
  tds_ppm AS tds,
  turbidity_raw AS turbidityRaw,
  turbidity_ntu AS turbidityNtu,
  temperature_c AS temperature,
  ph,
  is_simulated AS simulated,
  received_at AS receivedAt
`;

// --------------------------------------------------
// Device status
// --------------------------------------------------

function status() {
  const r = db.prepare(`
    SELECT received_at
    FROM sensor_readings
    WHERE device_id = ?
    ORDER BY id DESC
    LIMIT 1
  `).get(DEVICE_ID);

  const base = {
    deviceName: 'AquaSense Node 01',
    intervalMinutes: INTERVAL_MIN
  };

  if (!r) {
    return { ...base, status: 'waiting', lastReadingAt: null, nextExpectedAt: null };
  }

  const last = Date.parse(r.received_at);

  return {
    ...base,
    status: Date.now() - last <= OFFLINE_MS ? 'online' : 'offline',
    lastReadingAt: r.received_at,
    nextExpectedAt: new Date(last + INTERVAL_MIN * 60000).toISOString()
  };
}

// --------------------------------------------------
// Local (real database) APIs
// --------------------------------------------------

app.get('/api/health', (_req, res) => {
  res.json({ ok: true });
});

app.get('/api/local/status', (_req, res) => {
  res.json(status());
});

app.get('/api/local/latest', (_req, res) => {
  const reading = db.prepare(`
    SELECT ${COLS}
    FROM sensor_readings
    WHERE device_id = ?
    ORDER BY id DESC
    LIMIT 1
  `).get(DEVICE_ID) || null;

  res.json({ reading });
});

const RANGES = {
  '1h': 3600e3,
  '6h': 6 * 3600e3,
  '24h': 24 * 3600e3,
  '7d': 7 * 864e5,
  '30d': 30 * 864e5
};

app.get('/api/local/history', (req, res) => {
  const range = req.query.range || '24h';
  const ms = RANGES[range];

  if (!ms) {
    return res.status(400).json({ error: 'range must be 1h, 6h, 24h, 7d or 30d' });
  }

  const rows = db.prepare(`
    SELECT ${COLS}
    FROM sensor_readings
    WHERE device_id = ?
      AND received_at >= ?
    ORDER BY received_at
  `).all(DEVICE_ID, new Date(Date.now() - ms).toISOString());

  res.json({ range, readings: rows });
});

// --------------------------------------------------
// Simulated public monitoring stations
// These never read from or write to sensor_readings.
// --------------------------------------------------

// Approximate demo center: Francis Xavier Engineering
// College, Vannarpettai, Tirunelveli.
const FXEC_LAT = 8.731442;
const FXEC_LNG = 77.723520;

// Reproducible pseudo-random generator.
function rng(seed) {
  return () => {
    seed |= 0;
    seed = seed + 0x6D2B79F5 | 0;

    let t = Math.imul(seed ^ seed >>> 15, 1 | seed);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;

    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

// spread = maximum coordinate offset from the center, in degrees.
function makeDemo(seed, names, lat, lng, spread = 0.012) {
  const r = rng(seed);

  return names.map((name, i) => {
    const tds = Math.round(90 + r() * 560);
    const turbidity = +(0.3 + r() * 7).toFixed(1);
    const temperature = +(21 + r() * 9).toFixed(1);
    const ph = +(6.3 + r() * 2.8).toFixed(1);

    // Illustrative demo statuses (not a safe/unsafe judgement).
    const stationStatus =
      tds > 500 || turbidity > 5 || ph < 6 || ph > 9
        ? 'unsafe'
        : tds > 350 || turbidity > 3 || ph < 6.5 || ph > 8.5
          ? 'caution'
          : 'safe';

    return {
      id: i + 1,
      name,
      lat: +(lat + (r() - 0.5) * 2 * spread).toFixed(5),
      lng: +(lng + (r() - 0.5) * 2 * spread).toFixed(5),
      tds,
      turbidity,
      temperature,
      ph,
      simulated: true,
      status: stationStatus,
      updatedAt: new Date(Date.UTC(2026, 0, 15, 6 + i, (i * 17) % 60)).toISOString()
    };
  });
}

const DRINKING = makeDemo(
  11,
  [
    'FXEC Main Campus Drinking Water Point',
    'FXEC Sports Ground Water Point',

    'Junction Railway Station Drinking Water',
    'Pothys Public Water Tap',
    'Vannarpettai Bus Stop Water Point',
    'Pushpalatha School Water Point',
    'V.M Chatram Near Bus Stop Water Point',
    'Thiyagaraja Nagar Water Point',
    'Vannarpettai Sathya Store Water Point',

    'Palayamkottai Railway Station Drinking Water',
    'Murugankurichi BPCL Drinking Water',
    'Kokkirakulam Science Centre Water Point',
    'Maharajanagar Roundana Bus Stop Water Point',
    'Perumalpuram Church Water Point',
    'Tirunelveli Junction Bus Stand Water Point',
    'Shanthi Nagar Jio Petrol Bunk'
  ],
  FXEC_LAT,
  FXEC_LNG,
  0.012
);

const SUPPLY = makeDemo(
  29,
  [
    'Vannarpettai Overhead Tank',
    'North Bypass Distribution Point',
    'Vannarpettai Residential Supply Zone',
    'Barani Nagar Distribution Point',
    'Gomathy Nagar Supply Point',

    'Palayamkottai Distribution Point',
    'Palayamkottai Municipal Main Pipe',
    'Maharajanagar Distribution Point',
    'Murugankurichi Supply Zone',
    'Kokkirakulam Distribution Point',
    'Tirunelveli Junction Overhead tank',
    'Rahmath Nagar Distribution PipeLine',
    'Melapalayam Tank',
    'Pettai Distribution tank',
    'Thatchanallur Overhead tank',
    'Tamirabarani River Water'
  ],
  FXEC_LAT,
  FXEC_LNG,
  0.045
);

app.get('/api/demo/drinking-water', (_req, res) => {
  res.json({ simulated: true, stations: DRINKING });
});

app.get('/api/demo/public-supply', (_req, res) => {
  res.json({ simulated: true, stations: SUPPLY });
});

// --------------------------------------------------
// Frontend static files
// --------------------------------------------------

app.use(express.static(path.join(__dirname, 'public')));

app.use('/api', (_req, res) => {
  res.status(404).json({ error: 'Not found' });
});

// --------------------------------------------------
// Error handling
// --------------------------------------------------

app.use((err, _req, res, _next) => {
  if (err.type === 'entity.parse.failed') {
    return res.status(400).json({ error: 'Malformed JSON' });
  }

  if (err.type === 'entity.too.large') {
    return res.status(413).json({ error: 'Request too large' });
  }

  console.error(err.message);
  res.status(500).json({ error: 'Internal error' });
});

// --------------------------------------------------
// Optional simulated live readings (SIMULATE_READINGS=true)
// Rows are marked is_simulated = 1 so they are never
// mistaken for genuine sensor readings.
// --------------------------------------------------

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const drift = (v, d, lo, hi) => clamp(v + (Math.random() - 0.5) * 2 * d, lo, hi);

let simState = { tds: 245, turbidity: 620, temperature: 26.5, ph: 7.2 };

function insertSimulatedReading() {
  simState = {
    tds: drift(simState.tds, 12, 120, 480),
    turbidity: drift(simState.turbidity, 25, 300, 750),
    temperature: drift(simState.temperature, 0.3, 24, 30),
    ph: drift(simState.ph, 0.08, 6.8, 7.8)
  };

  try {
    db.prepare(`
      INSERT INTO sensor_readings
        (device_id, tds_ppm, turbidity_raw, turbidity_ntu,
         temperature_c, ph, device_timestamp, received_at, is_simulated)
      VALUES (?, ?, ?, NULL, ?, ?, NULL, ?, 1)
    `).run(
      DEVICE_ID,
      Math.round(simState.tds),
      Math.round(simState.turbidity),
      +simState.temperature.toFixed(1),
      +simState.ph.toFixed(2),
      new Date().toISOString()
    );
  } catch (err) {
    console.error('Simulated insert failed:', err.message);
  }
}

if (SIMULATE) {
  insertSimulatedReading();
  setInterval(insertSimulatedReading, SIM_INTERVAL_SEC * 1000);
  console.warn(`SIMULATION ON: inserting fake readings every ${SIM_INTERVAL_SEC}s`);
}

// --------------------------------------------------
// Start server
// --------------------------------------------------

app.listen(PORT, '0.0.0.0', () => {
  console.log(`AquaSense running on port ${PORT} (LAN reachable)`);
});
