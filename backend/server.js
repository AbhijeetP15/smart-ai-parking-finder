// server.js
const express = require('express');
require('dotenv').config();
const mongoose = require('mongoose');
const cors = require('cors');
const http = require('http');
const { Server } = require('socket.io');
const axios = require('axios');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: process.env.CORS_ORIGIN || '*',
    methods: ["GET", "POST", "PUT", "DELETE"]
  }
});

// Middleware
app.use(cors());
app.use(express.json());

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

// MongoDB Connection
const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/smart_parking';
mongoose.connect(MONGODB_URI, {
  useNewUrlParser: true,
  useUnifiedTopology: true
});

const db = mongoose.connection;
db.on('error', console.error.bind(console, 'MongoDB connection error:'));
db.once('open', () => {
  console.log('Connected to MongoDB');
});

// ===== SCHEMAS =====
const parkingLotSchema = new mongoose.Schema({
  name: { type: String, required: true },
  totalSpots: { type: Number, required: true },
  availableSpots: { type: Number, required: true },
  location: {
    lat: { type: Number, required: true },
    lng: { type: Number, required: true }
  },
  sensors: [{
    spotId: String,
    isOccupied: Boolean,
    lastUpdate: Date
  }],
  lastUpdate: { type: Date, default: Date.now }
});

const historicalDataSchema = new mongoose.Schema({
  parkingLotId: { type: mongoose.Schema.Types.ObjectId, ref: 'ParkingLot' },
  timestamp: { type: Date, required: true },
  availableSpots: { type: Number, required: true },
  occupancyRate: { type: Number, required: true },
  dayOfWeek: { type: Number, required: true },
  hour: { type: Number, required: true },
  isHoliday: { type: Boolean, default: false }
});
historicalDataSchema.index({ parkingLotId: 1, timestamp: -1 });

const predictionCacheSchema = new mongoose.Schema({
  parkingLotId: { type: mongoose.Schema.Types.ObjectId, ref: 'ParkingLot' },
  predictedSpots: { type: Number, required: true },
  confidence: { type: Number, required: true },
  predictedFor: { type: Date, required: true },
  createdAt: { type: Date, default: Date.now, expires: 300 }
});

const ParkingLot = mongoose.model('ParkingLot', parkingLotSchema);
const HistoricalData = mongoose.model('HistoricalData', historicalDataSchema);
const PredictionCache = mongoose.model('PredictionCache', predictionCacheSchema);

// ===== PREDICTION ALGORITHM =====
class ParkingPredictor {
  static async predictAvailability(parkingLotId, minutesAhead = 30) {
    try {
      const lot = await ParkingLot.findById(parkingLotId);
      if (!lot) throw new Error('Parking lot not found');

      const targetTime = new Date(Date.now() + minutesAhead * 60000);
      const targetHour = targetTime.getHours();
      const targetDay = targetTime.getDay();

      const historicalPattern = await HistoricalData.find({
        parkingLotId: parkingLotId,
        dayOfWeek: targetDay,
        hour: targetHour
      }).sort({ timestamp: -1 }).limit(20);

      if (historicalPattern.length === 0) {
        return {
          predictedSpots: Math.max(0, lot.availableSpots + Math.floor(Math.random() * 10 - 5)),
          confidence: 60
        };
      }

      const avgAvailability = historicalPattern.reduce((sum, record) => sum + record.availableSpots, 0) / historicalPattern.length;

      const recentData = await HistoricalData.find({ parkingLotId: parkingLotId }).sort({ timestamp: -1 }).limit(6);
      let trend = 0;
      if (recentData.length >= 2) {
        const recentAvg = recentData.slice(0, 3).reduce((s, r) => s + r.availableSpots, 0) / 3;
        const olderAvg = recentData.slice(3, 6).reduce((s, r) => s + r.availableSpots, 0) / 3;
        trend = recentAvg - olderAvg;
      }

      const predictedSpots = Math.round(avgAvailability * 0.6 + lot.availableSpots * 0.3 + trend * 0.1);

      const variance = historicalPattern.reduce((sum, record) =>
        sum + Math.pow(record.availableSpots - avgAvailability, 2), 0) / historicalPattern.length;
      const stdDev = Math.sqrt(variance);
      const confidence = Math.min(95, Math.max(70, 100 - (stdDev / lot.totalSpots) * 100));

      const adjustedPrediction = Math.max(0, Math.min(lot.totalSpots, predictedSpots));

      return { predictedSpots: adjustedPrediction, confidence: Math.round(confidence) };
    } catch (error) {
      console.error('Prediction error:', error);
      throw error;
    }
  }

  static async recordCurrentState(parkingLotId) {
    try {
      const lot = await ParkingLot.findById(parkingLotId);
      if (!lot) return;

      const now = new Date();
      const record = new HistoricalData({
        parkingLotId: parkingLotId,
        timestamp: now,
        availableSpots: lot.availableSpots,
        occupancyRate: ((lot.totalSpots - lot.availableSpots) / lot.totalSpots) * 100,
        dayOfWeek: now.getDay(),
        hour: now.getHours(),
        isHoliday: false
      });

      await record.save();
    } catch (error) {
      console.error('Error recording historical data:', error);
    }
  }
}

// ====== OVERPASS HELPERS (mirrors, retries, cache) ======
const OVERPASS_MIRRORS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass.openstreetmap.ru/api/interpreter'
];

function buildOverpassAreaQuery({ lat, lng, radius = 5000 }) {
  // add [timeout:25] to reduce 504s on busy servers
  return `
    [out:json][timeout:25];
    (
      node["amenity"="parking"](around:${radius},${lat},${lng});
      way["amenity"="parking"](around:${radius},${lat},${lng});
      relation["amenity"="parking"](around:${radius},${lat},${lng});
    );
    out center;
  `;
}

function buildOverpassIdQuery(osmId) {
  // support both numeric ID and "osm-<id>" input
  const id = String(osmId).startsWith('osm-') ? String(osmId).slice(4) : String(osmId);
  return `
    [out:json][timeout:25];
    (
      node(id:${id});
      way(id:${id});
      relation(id:${id});
    );
    out center;
  `;
}

async function callOverpass(query, { attempts = 3, timeoutMs = 25000 }) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    const url = OVERPASS_MIRRORS[i % OVERPASS_MIRRORS.length];
    try {
      const resp = await axios.post(
        url,
        `data=${encodeURIComponent(query)}`,
        {
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          timeout: timeoutMs
        }
      );
      if (resp.status >= 200 && resp.status < 300) return resp.data;
      throw new Error(`Overpass non-2xx: ${resp.status}`);
    } catch (err) {
      lastErr = err;
      // exponential backoff (0.5s, 1s, 2s)
      const delay = 500 * Math.pow(2, i);
      await new Promise(r => setTimeout(r, delay));
    }
  }
  throw lastErr;
}

// simple in-memory cache (area key -> { lots, indexById, ts })
let areaCache = { key: null, lots: null, indexById: null, ts: 0 };
let singleIdCache = new Map(); // id -> { lot, ts }

function areaKey({ lat, lng, radius }) {
  return `${lat.toFixed(3)},${lng.toFixed(3)},${radius}`;
}
function saveAreaCache(key, lots) {
  const index = new Map();
  for (const lot of lots) index.set(lot.id, lot);
  areaCache = { key, lots, indexById: index, ts: Date.now() };
}
function readAreaCache(key, maxAgeMs = 10 * 60 * 1000) { // 10 minutes
  if (areaCache.key !== key) return null;
  if (Date.now() - areaCache.ts > maxAgeMs) return null;
  return areaCache;
}
function saveIdCache(id, lot) {
  singleIdCache.set(id, { lot, ts: Date.now() });
}
function readIdCache(id, maxAgeMs = 60 * 60 * 1000) { // 1 hour
  const entry = singleIdCache.get(id);
  if (!entry) return null;
  if (Date.now() - entry.ts > maxAgeMs) {
    singleIdCache.delete(id);
    return null;
  }
  return entry.lot;
}

function mapOverpassToParkingLots(elements, fallbackLat, fallbackLng) {
  return elements.slice(0, 50).map((el, idx) => {
    const capacity = parseInt(el.tags?.capacity) || Math.floor(Math.random() * 200 + 50);
    const occupied = Math.floor(capacity * (0.3 + Math.random() * 0.5));
    const available = Math.max(0, capacity - occupied);
    const centerLat = el.lat || el.center?.lat || fallbackLat;
    const centerLng = el.lon || el.center?.lon || fallbackLng;
    return {
      id: `osm-${el.id}`,
      name: el.tags?.name || `Parking Lot ${idx + 1}`,
      totalSpots: capacity,
      availableSpots: available,
      location: { lat: centerLat, lng: centerLng },
      lastUpdate: new Date().toISOString(),
      predictedAvailability: Math.max(0, available + Math.floor(Math.random() * 20 - 10)),
      confidence: 85 + Math.floor(Math.random() * 10)
    };
  });
}

// Fetch area lots (with cache/mirrors/retries)
async function fetchOpenStreetMapParking(lat, lng, radius = 5000) {
  const query = `
    [out:json][timeout:25];
    (
      node["amenity"="parking"](around:${radius},${lat},${lng});
      way["amenity"="parking"](around:${radius},${lat},${lng});
    );
    out center;
  `;

  let lastErr;
  for (const ep of OVERPASS_ENDPOINTS) {
    try {
      const resp = await axios.post(
        ep,
        `data=${encodeURIComponent(query)}`,
        {
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          timeout: 8000 // 8s per mirror
        }
      );
      const elements = resp?.data?.elements ?? [];
      return transformOverpassToLots(elements, lat, lng);
    } catch (e) {
      lastErr = e;
      const status = e?.response?.status;
      console.warn(`[Overpass] ${ep} failed`, status || '', e.message);
      // Try next mirror
    }
  }
  // After trying all mirrors, propagate the last error
  throw lastErr || new Error('All Overpass mirrors failed');
}

// Fetch single lot by OSM ID (uses cache first; otherwise queries by id)
async function fetchOpenStreetMapParkingById(osmId, { latFallback = 33.4242, lngFallback = -111.9281 } = {}) {
  const id = String(osmId).startsWith('osm-') ? String(osmId) : `osm-${osmId}`;

  // 1) try per-id cache
  const cachedLot = readIdCache(id);
  if (cachedLot) return { lot: cachedLot, stale: false, source: 'id-cache' };

  // 2) try area cache index
  if (areaCache.indexById && areaCache.indexById.has(id)) {
    const lot = areaCache.indexById.get(id);
    saveIdCache(id, lot);
    return { lot, stale: false, source: 'area-cache' };
  }

  // 3) query Overpass by id
  const query = buildOverpassIdQuery(id);
  const data = await callOverpass(query, { attempts: 3, timeoutMs: 25000 });
  const lots = mapOverpassToParkingLots(data.elements || [], latFallback, lngFallback);
  const lot = lots[0];
  if (!lot) throw new Error('OSM lot not found');

  saveIdCache(id, lot);
  return { lot, stale: false, source: 'overpass' };
}

// ===== REST API ENDPOINTS =====

// Simulated (Mongo) list — unchanged
app.get('/api/parking-lots', async (req, res) => {
  try {
    const lots = await ParkingLot.find();

    const lotsWithPredictions = await Promise.all(lots.map(async (lot) => {
      let cached = await PredictionCache.findOne({
        parkingLotId: lot._id,
        predictedFor: { $gte: new Date(Date.now() + 25 * 60000) }
      });

      let prediction;
      if (cached) {
        prediction = {
          predictedSpots: cached.predictedSpots,
          confidence: cached.confidence
        };
      } else {
        prediction = await ParkingPredictor.predictAvailability(lot._id, 30);

        await PredictionCache.create({
          parkingLotId: lot._id,
          predictedSpots: prediction.predictedSpots,
          confidence: prediction.confidence,
          predictedFor: new Date(Date.now() + 30 * 60000)
        });
      }

      return {
        id: lot._id,
        name: lot.name,
        totalSpots: lot.totalSpots,
        availableSpots: lot.availableSpots,
        location: lot.location,
        lastUpdate: lot.lastUpdate,
        predictedAvailability: prediction.predictedSpots,
        confidence: prediction.confidence
      };
    }));

    res.json(lotsWithPredictions);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ===== REAL (OpenStreetMap) =====

// List real lots (ASU defaults)
app.get('/api/parking-lots/real', async (req, res) => {
  try {
    const lat = parseFloat(req.query.lat) || 33.4242; // Default: ASU Tempe
    const lng = parseFloat(req.query.lng) || -111.9281;
    const radius = parseInt(req.query.radius) || 5000; // meters

    console.log('REAL DATA params =>', { lat, lng, radius });

    const realParkingData = await fetchOpenStreetMapParking(lat, lng, radius);

    if (!realParkingData || realParkingData.length === 0) {
      return res.status(404).json({
        error: 'No parking lots found in this area',
        message: 'Try expanding the search radius or different coordinates'
      });
    }

    res.json(realParkingData);
  } catch (error) {
    console.error('Overpass failed; falling back to DB lots:', error?.message || error);

    // Fallback: serve seeded DB lots in the same shape so the UI keeps working
    try {
      const lots = await ParkingLot.find().limit(10);
      if (lots.length) {
        const fallback = lots.map(lot => ({
          id: lot._id,
          name: lot.name,
          totalSpots: lot.totalSpots,
          availableSpots: lot.availableSpots,
          location: lot.location,
          lastUpdate: lot.lastUpdate,
          predictedAvailability: Math.max(
            0,
            lot.availableSpots + Math.floor(Math.random() * 20 - 10)
          ),
          confidence: 90
        }));
        return res.json(fallback);
      }
    } catch (e2) {
      console.error('DB fallback also failed:', e2?.message || e2);
    }

    res.status(503).json({
      error: 'Failed to fetch real parking data',
      message: 'Overpass unavailable and no local fallback'
    });
  }
});


// Single real lot (for /real/:id details & refresh/deeplinks)
app.get('/api/parking-lots/real/:id', async (req, res) => {
  try {
    const id = req.params.id; // expects "osm-<number>" or raw number
    const { lot } = await fetchOpenStreetMapParkingById(id);
    res.json(lot);
  } catch (error) {
    res.status(404).json({ error: 'Real parking lot not found', message: error.message });
  }
});

// ===== Simulated (Mongo) single lot + predict/history =====
app.get('/api/parking-lots/:id', async (req, res) => {
  try {
    const lot = await ParkingLot.findById(req.params.id);
    if (!lot) {
      return res.status(404).json({ error: 'Parking lot not found' });
    }

    const prediction = await ParkingPredictor.predictAvailability(lot._id, 30);

    res.json({
      id: lot._id,
      name: lot.name,
      totalSpots: lot.totalSpots,
      availableSpots: lot.availableSpots,
      location: lot.location,
      lastUpdate: lot.lastUpdate,
      sensors: lot.sensors,
      predictedAvailability: prediction.predictedSpots,
      confidence: prediction.confidence
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.put('/api/parking-lots/:id', async (req, res) => {
  try {
    const { availableSpots, sensors } = req.body;

    const lot = await ParkingLot.findByIdAndUpdate(
      req.params.id,
      {
        availableSpots,
        sensors,
        lastUpdate: new Date()
      },
      { new: true }
    );

    if (!lot) {
      return res.status(404).json({ error: 'Parking lot not found' });
    }

    await ParkingPredictor.recordCurrentState(lot._id);

    io.emit('parking-update', {
      lotId: lot._id,
      availableSpots: lot.availableSpots,
      timestamp: lot.lastUpdate
    });

    res.json(lot);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/parking-lots/:id/predict', async (req, res) => {
  try {
    const minutesAhead = parseInt(req.query.minutes) || 30;
    const prediction = await ParkingPredictor.predictAvailability(req.params.id, minutesAhead);

    res.json({
      predictedSpots: prediction.predictedSpots,
      confidence: prediction.confidence,
      predictedFor: new Date(Date.now() + minutesAhead * 60000)
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/parking-lots/:id/history', async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 100;
    const history = await HistoricalData.find({
      parkingLotId: req.params.id
    }).sort({ timestamp: -1 }).limit(limit);

    res.json(history);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/stats', async (req, res) => {
  try {
    const lots = await ParkingLot.find();

    const totalSpots = lots.reduce((sum, lot) => sum + lot.totalSpots, 0);
    const totalAvailable = lots.reduce((sum, lot) => sum + lot.availableSpots, 0);
    const avgOccupancy = ((totalSpots - totalAvailable) / totalSpots * 100).toFixed(1);

    res.json({
      totalParkingLots: lots.length,
      totalSpots,
      totalAvailable,
      avgOccupancy: parseFloat(avgOccupancy)
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/parking-lots', async (req, res) => {
  try {
    const lot = new ParkingLot(req.body);
    await lot.save();
    res.status(201).json(lot);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

// ===== WEBSOCKET =====
io.on('connection', (socket) => {
  console.log('Client connected:', socket.id);

  socket.on('subscribe', (lotId) => {
    socket.join(`lot-${lotId}`);
    console.log(`Client ${socket.id} subscribed to lot ${lotId}`);
  });

  socket.on('disconnect', () => {
    console.log('Client disconnected:', socket.id);
  });
});

// ===== BACKGROUND JOBS =====
setInterval(async () => {
  try {
    const lots = await ParkingLot.find();

    for (const lot of lots) {
      const change = Math.floor(Math.random() * 7) - 3;
      const newAvailable = Math.max(0, Math.min(lot.totalSpots, lot.availableSpots + change));

      lot.availableSpots = newAvailable;
      lot.lastUpdate = new Date();
      await lot.save();

      if (Math.random() < 0.17) {
        await ParkingPredictor.recordCurrentState(lot._id);
      }

      io.emit('parking-update', {
        lotId: lot._id,
        availableSpots: lot.availableSpots,
        timestamp: lot.lastUpdate
      });
    }
  } catch (error) {
    console.error('Background update error:', error);
  }
}, 30000);

// ===== SEED DATABASE =====
async function seedDatabase() {
  const count = await ParkingLot.countDocuments();
  if (count === 0) {
    const lots = [
      { name: 'North Campus Lot A', totalSpots: 150, availableSpots: 45, location: { lat: 33.4242, lng: -111.9281 } },
      { name: 'South Campus Lot B', totalSpots: 200, availableSpots: 12, location: { lat: 33.4225, lng: -111.9265 } },
      { name: 'Engineering Building Lot', totalSpots: 80, availableSpots: 65, location: { lat: 33.4258, lng: -111.9298 } },
      { name: 'Student Center Garage', totalSpots: 300, availableSpots: 5, location: { lat: 33.4210, lng: -111.9250 } }
    ];

    await ParkingLot.insertMany(lots);
    console.log('Database seeded with parking lots');

    const savedLots = await ParkingLot.find();
    const now = new Date();

    for (const lot of savedLots) {
      for (let i = 0; i < 100; i++) {
        const timestamp = new Date(now.getTime() - i * 30 * 60000);
        const occupancyVariation = Math.sin((timestamp.getHours() / 24) * Math.PI * 2) * 0.3;
        const baseOccupancy = 0.6 + occupancyVariation;
        const availableSpots = Math.floor(lot.totalSpots * (1 - baseOccupancy));

        await HistoricalData.create({
          parkingLotId: lot._id,
          timestamp: timestamp,
          availableSpots: availableSpots,
          occupancyRate: baseOccupancy * 100,
          dayOfWeek: timestamp.getDay(),
          hour: timestamp.getHours(),
          isHoliday: false
        });
      }
    }
    console.log('Historical data generated');
  }
}

// ===== START SERVER =====
const PORT = process.env.PORT || 3000;
db.once('open', async () => {
  await seedDatabase();

  server.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
    console.log(`REST API: http://localhost:${PORT}/api`);
    console.log(`WebSocket: ws://localhost:${PORT}`);
  });
});
