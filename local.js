
'use strict';

const express = require('express');
const Database = require('better-sqlite3');
const path = require('path');

const app = express();

const PORT = Number(process.env.PORT) || 3000;
const DEVICE_ID = 'Node-01';
const DEVICE_TOKEN = process.env.DEVICE_TOKEN || '';

const INTERVAL_MIN = 10;
const OFFLINE_MS =
  (Number(process.env.OFFLINE_MINUTES) || 25) * 60000;

// Demo simulation is ON by default.
// Set SIMULATE_READINGS=false to disable it.
const SIMULATE = process.env.SIMULATE_READINGS !== 'false';
const SIM_INTERVAL_SEC = Math.max(
  5,
  Number(process.env.SIM_INTERVAL_SECONDS) || 600
);

app.disable('x-powered-by');
app.use(express.json({ limit: '10kb' }));

// --------------------------------------------------
// API rate limiter
// --------------------------------------------------

const hits = new Map();

app.use('/api', (req, res, next) => {
  const now = Date.now();
  const ip = req.ip;

  const recent = (hits.get(ip) || []).filter(
    timestamp => now - timestamp < 60000
  );

  recent.push(now);
  hits.set(ip, recent);

  if (recent.length > 60) {
    return res.status(429).json({
      error: 'Too many requests'
    });
  }

  next();
});

// --------------------------------------------------
// Database and migration
// --------------------------------------------------

const db = new Database(
  process.env.DB_PATH || path.join(__dirname, 'Data.db')
);

db.pragma('journal_mode = WAL');

function setupDatabase() {
  const exists = db.prepare(`
    SELECT name
    FROM sqlite_master
    WHERE type = 'table'
      AND name = 'sensor_readings'
  `).get();

  if (!exists) {
    db.exec(`
      CREATE TABLE sensor_readings (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        device_id TEXT NOT NULL,
        tds_ppm REAL,
        turbidity_raw REAL,
        turbidity_ntu REAL,
        temperature_c REAL,
        ph REAL,
        is_simulated INTEGER NOT NULL DEFAULT 0,
        device_timestamp TEXT,
        received_at TEXT NOT NULL
      );
    `);
  } else {
    let columns = db.prepare(
      'PRAGMA table_info(sensor_readings)'
    ).all();

    // Add columns introduced in newer versions.
    if (!columns.some(c => c.name === 'ph')) {
      db.exec(
        'ALTER TABLE sensor_readings ADD COLUMN ph REAL'
      );
    }

    if (!columns.some(c => c.name === 'is_simulated')) {
      db.exec(`
        ALTER TABLE sensor_readings
        ADD COLUMN is_simulated INTEGER NOT NULL DEFAULT 0
      `);
    }

    columns = db.prepare(
      'PRAGMA table_info(sensor_readings)'
    ).all();

    // Older versions required all three readings.
    // Rebuild the table so failed sensors can store SQL NULL.
    const needsMigration = [
      'tds_ppm',
      'turbidity_raw',
      'temperature_c'
    ].some(name => {
      const column = columns.find(c => c.name === name);
      return column && column.notnull === 1;
    });

    if (needsMigration) {
      const migrate = db.transaction(() => {
        db.exec(`
          CREATE TABLE sensor_readings_new (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            device_id TEXT NOT NULL,
            tds_ppm REAL,
            turbidity_raw REAL,
            turbidity_ntu REAL,
            temperature_c REAL,
            ph REAL,
            is_simulated INTEGER NOT NULL DEFAULT 0,
            device_timestamp TEXT,
            received_at TEXT NOT NULL
          );

          INSERT INTO sensor_readings_new (
            id, device_id, tds_ppm, turbidity_raw,
            turbidity_ntu, temperature_c, ph,
            is_simulated, device_timestamp, received_at
          )
          SELECT
            id, device_id, tds_ppm, turbidity_raw,
            turbidity_ntu, temperature_c, ph,
            is_simulated, device_timestamp, received_at
          FROM sensor_readings;

          DROP TABLE sensor_readings;
          ALTER TABLE sensor_readings_new
          RENAME TO sensor_readings;
        `);
      });

      migrate();
      console.log('Database migrated for partial sensor readings.');
    }
  }

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_readings_received
    ON sensor_readings(received_at);
  `);
}

setupDatabase();

// Shared columns used by Local Access.
const COLS = `
  id,
  device_id AS deviceId,
  tds_ppm AS tds,
  turbidity_raw AS turbidityRaw,
  turbidity_ntu AS turbidityNtu,
  temperature_c AS temperature,
  ph,
  is_simulated AS simulated,
  device_timestamp AS deviceTimestamp,
  received_at AS receivedAt
`;

// --------------------------------------------------
// Health check
// --------------------------------------------------

app.get('/api/health', (_req, res) => {
  res.json({
    ok: true,
    service: 'HydroShield',
    deviceId: DEVICE_ID
  });
});

// --------------------------------------------------
// NodeMCU: receive real sensor readings
// POST /api/sensor/readings
// Header: X-Device-Token
// --------------------------------------------------

function validateReading(value, min, max) {
  if (value === null || value === undefined) {
    return null;
  }

  if (
    typeof value !== 'number' ||
    !Number.isFinite(value) ||
    value < min ||
    value > max
  ) {
    return undefined;
  }

  return value;
}

app.post('/api/sensor/readings', (req, res) => {
  if (!DEVICE_TOKEN) {
    return res.status(503).json({
      error: 'DEVICE_TOKEN is not configured on the server'
    });
  }

  if (req.get('X-Device-Token') !== DEVICE_TOKEN) {
    return res.status(401).json({
      error: 'Invalid device token'
    });
  }

  const body = req.body || {};

  if (body.deviceId !== DEVICE_ID) {
    return res.status(400).json({
      error: 'Invalid deviceId; expected Node-01'
    });
  }

  const ph = validateReading(body.ph, 0, 14);
  const tds = validateReading(body.tds, 0, 100000);
  const turbidityRaw = validateReading(
    body.turbidityRaw, 0, 1023
  );
  const temperature = validateReading(
    body.temperature, -55, 125
  );
  const turbidityNtu = validateReading(
    body.turbidityNtu, 0, 100000
  );

  const readings = [
    ph, tds, turbidityRaw, temperature, turbidityNtu
  ];

  if (readings.some(value => value === undefined)) {
    return res.status(400).json({
      error: 'Invalid sensor value or value outside allowed range'
    });
  }

  let deviceTimestamp = null;

  if (body.timestamp !== null && body.timestamp !== undefined) {
    if (
      typeof body.timestamp !== 'string' ||
      body.timestamp.length > 50
    ) {
      return res.status(400).json({
        error: 'timestamp must be a string of at most 50 characters'
      });
    }

    deviceTimestamp = body.timestamp || null;
  }

  try {
    const result = db.prepare(`
      INSERT INTO sensor_readings (
        device_id,
        tds_ppm,
        turbidity_raw,
        turbidity_ntu,
        temperature_c,
        ph,
        is_simulated,
        device_timestamp,
        received_at
      )
      VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?)
    `).run(
      DEVICE_ID,
      tds,
      turbidityRaw,
      turbidityNtu,
      temperature,
      ph,
      deviceTimestamp,
      new Date().toISOString()
    );

    return res.status(201).json({
      ok: true,
      message: 'Sensor readings saved',
      id: result.lastInsertRowid,
      unavailable: {
        ph: ph === null,
        tds: tds === null,
        turbidity: turbidityRaw === null,
        temperature: temperature === null
      }
    });
  } catch (error) {
    console.error('Sensor insert failed:', error.message);

    return res.status(500).json({
      error: 'Could not save sensor readings'
    });
  }
});

// --------------------------------------------------
// Device status
// Only genuine device readings determine status.
// --------------------------------------------------

function getDeviceStatus() {
  const row = db.prepare(`
    SELECT received_at
    FROM sensor_readings
    WHERE device_id = ?
      AND is_simulated = 0
    ORDER BY id DESC
    LIMIT 1
  `).get(DEVICE_ID);

  const base = {
    deviceName: 'AquaSense Node 01',
    deviceId: DEVICE_ID,
    intervalMinutes: INTERVAL_MIN
  };

  if (!row) {
    return {
      ...base,
      status: 'waiting',
      lastReadingAt: null,
      nextExpectedAt: null
    };
  }

  const last = Date.parse(row.received_at);

  return {
    ...base,
    status: Number.isFinite(last) &&
      Date.now() - last <= OFFLINE_MS
        ? 'online'
        : 'offline',
    lastReadingAt: row.received_at,
    nextExpectedAt: Number.isFinite(last)
      ? new Date(last + INTERVAL_MIN * 60000).toISOString()
      : null
  };
}

app.get('/api/local/status', (_req, res) => {
  res.json(getDeviceStatus());
});

// --------------------------------------------------
// Local Access: latest genuine reading
// --------------------------------------------------

app.get('/api/local/latest', (_req, res) => {
  const reading = db.prepare(`
    SELECT ${COLS}
    FROM sensor_readings
    WHERE device_id = ?
      AND is_simulated = 0
    ORDER BY id DESC
    LIMIT 1
  `).get(DEVICE_ID) || null;

  res.json({ reading });
});

// --------------------------------------------------
// Local Access: history
// --------------------------------------------------

const RANGES = {
  '1h': 60 * 60 * 1000,
  '6h': 6 * 60 * 60 * 1000,
  '24h': 24 * 60 * 60 * 1000,
  '7d': 7 * 24 * 60 * 60 * 1000,
  '30d': 30 * 24 * 60 * 60 * 1000
};

app.get('/api/local/history', (req, res) => {
  const range = req.query.range || '24h';
  const ms = RANGES[range];

  if (!ms) {
    return res.status(400).json({
      error: 'range must be 1h, 6h, 24h, 7d or 30d'
    });
  }

  const rows = db.prepare(`
    SELECT ${COLS}
    FROM sensor_readings
    WHERE device_id = ?
      AND is_simulated = 0
      AND received_at >= ?
    ORDER BY received_at ASC
  `).all(
    DEVICE_ID,
    new Date(Date.now() - ms).toISOString()
  );

  res.json({
    range,
    readings: rows
  });
});

// --------------------------------------------------
// Public demo stations
// These are fictional illustrative data, not live tests.
// They do not read from or write to sensor_readings.
// --------------------------------------------------

const FXEC_LAT = 8.731442;
const FXEC_LNG = 77.723520;

function rng(seed) {
  return () => {
    seed |= 0;
    seed = seed + 0x2D2A67F4 | 0;

    let t = Math.imul(seed ^ seed >>> 15, 1 | seed);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;

    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

function makeDemo(seed, names, lat, lng, spread = 0.012) {
  const random = rng(seed);

  return names.map((name, index) => {
    const tds = Math.round(90 + random() * 560);
    const turbidity = +(0.3 + random() * 7).toFixed(1);
    const temperature = +(21 + random() * 9).toFixed(1);
    const ph = +(6.3 + random() * 2.8).toFixed(1);

    const stationStatus =
      tds > 500 || turbidity > 5 || ph < 6 || ph > 9
        ? 'unsafe'
        : tds > 350 || turbidity > 3 || ph < 6.5 || ph > 8.5
          ? 'caution'
          : 'safe';

    return {
      id: index + 1,
      name,
      lat: +(lat + (random() - 0.5) * 2 * spread).toFixed(5),
      lng: +(lng + (random() - 0.5) * 2 * spread).toFixed(5),
      tds,
      turbidity,
      temperature,
      ph,
      simulated: true,
      status: stationStatus,
      updatedAt: new Date(
        Date.UTC(2026, 9, 15, 6 + index, (index * 17) % 60)
      ).toISOString()
    };
  });
}

const DRINKING = makeDemo(
  11,
  [
    'Maharajanagar Roundana Bus Stop Water Point',
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
    'FXEC Main Campus Drinking Water Point',
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
  res.json({
    simulated: true,
    stations: DRINKING
  });
});

app.get('/api/demo/public-supply', (_req, res) => {
  res.json({
    simulated: true,
    stations: SUPPLY
  });
});

// --------------------------------------------------
// Optional automatic demo database readings
// These rows are marked simulated and excluded from
// all Local Access reading/status endpoints.
// --------------------------------------------------

const clamp = (value, min, max) =>
  Math.min(max, Math.max(min, value));

const drift = (value, amount, min, max) =>
  clamp(value + (Math.random() - 0.5) * 2 * amount, min, max);

let simState = {
  tds: 245,
  turbidity: 620,
  temperature: 26.5,
  ph: 7.2
};

function insertSimulatedReading() {
  simState = {
    tds: drift(simState.tds, 12, 120, 480),
    turbidity: drift(simState.turbidity, 25, 300, 750),
    temperature: drift(simState.temperature, 0.3, 24, 30),
    ph: drift(simState.ph, 0.08, 6.8, 7.8)
  };

  try {
    db.prepare(`
      INSERT INTO sensor_readings (
        device_id, tds_ppm, turbidity_raw, turbidity_ntu,
        temperature_c, ph, device_timestamp, received_at,
        is_simulated
      )
      VALUES (?, ?, ?, NULL, ?, ?, NULL, ?, 1)
    `).run(
      DEVICE_ID,
      Math.round(simState.tds),
      Math.round(simState.turbidity),
      +simState.temperature.toFixed(1),
      +simState.ph.toFixed(2),
      new Date().toISOString()
    );
  } catch (error) {
    console.error('Simulated insert failed:', error.message);
  }
}

if (SIMULATE) {
  insertSimulatedReading();

  setInterval(
    insertSimulatedReading,
    SIM_INTERVAL_SEC * 1000
  );

  console.warn(
    `SIMULATION ON: demo readings every ${SIM_INTERVAL_SEC}s`
  );
} else {
  console.warn('SIMULATION OFF: no automatic demo database readings');
}

// --------------------------------------------------
// Frontend static files and 404 handling
// --------------------------------------------------

app.use(express.static(path.join(__dirname, 'public')));

app.use('/api', (_req, res) => {
  res.status(404).json({
    error: 'API endpoint not found'
  });
});

// --------------------------------------------------
// Error handling
// --------------------------------------------------

app.use((err, _req, res, _next) => {
  if (err.type === 'entity.parse.failed') {
    return res.status(400).json({
      error: 'Malformed JSON'
    });
  }

  if (err.type === 'entity.too.large') {
    return res.status(413).json({
      error: 'Request too large'
    });
  }

  console.error('Server error:', err.message);

  res.status(500).json({
    error: 'Internal server error'
  });
});

// --------------------------------------------------
// Start server
// --------------------------------------------------

const server = app.listen(PORT, '0.0.0.0', () => {
  console.log(`HydroShield running on port ${PORT}`);
  console.log(`Health check: http://localhost:${PORT}/api/health`);
  console.log(`Device ID: ${DEVICE_ID}`);

  if (!DEVICE_TOKEN) {
    console.warn(
      'WARNING: Set DEVICE_TOKEN before connecting the NodeMCU.'
    );
  }
});

function shutdown() {
  console.log('Shutting down HydroShield...');
  server.close(() => {
    db.close();
    process.exit(0);
  });
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
