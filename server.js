import express from "express";
import multer from "multer";
import exifr from "exifr";
import { randomUUID, timingSafeEqual } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3000;

const DATA_DIR = path.join(__dirname, "data");
const UPLOAD_DIR = path.join(__dirname, "uploads");
const DB_FILE = path.join(DATA_DIR, "mushrooms.json");

for (const dir of [DATA_DIR, UPLOAD_DIR]) {
  fs.mkdirSync(dir, { recursive: true });
}
if (!fs.existsSync(DB_FILE)) fs.writeFileSync(DB_FILE, "[]");

// --- tiny JSON "database" ------------------------------------------------
function readAll() {
  try {
    return JSON.parse(fs.readFileSync(DB_FILE, "utf8"));
  } catch {
    return [];
  }
}
function writeAll(records) {
  fs.writeFileSync(DB_FILE, JSON.stringify(records, null, 2));
}

// --- image upload handling ----------------------------------------------
const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, UPLOAD_DIR),
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase() || ".jpg";
    cb(null, `${Date.now()}-${randomUUID()}${ext}`);
  },
});
const imageOnly = (_req, file, cb) => cb(null, /^image\//.test(file.mimetype));
const upload = multer({
  storage,
  limits: { fileSize: 15 * 1024 * 1024 }, // 15 MB
  fileFilter: imageOnly,
});
// In-memory upload used only to sniff EXIF from a photo before saving it.
const memUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 15 * 1024 * 1024 },
  fileFilter: imageOnly,
});

// Pull GPS coordinates and capture time out of a photo's EXIF metadata.
// Returns { lat, lng } (or null) and { takenAt } (ISO string, or null).
async function extractExif(input) {
  const result = { gps: null, takenAt: null };
  try {
    const [gps, tags] = await Promise.all([
      exifr.gps(input),
      exifr.parse(input, ["DateTimeOriginal", "CreateDate", "DateTimeDigitized"]),
    ]);

    if (
      gps &&
      Number.isFinite(gps.latitude) &&
      Number.isFinite(gps.longitude) &&
      Math.abs(gps.latitude) <= 90 &&
      Math.abs(gps.longitude) <= 180
    ) {
      result.gps = { lat: gps.latitude, lng: gps.longitude };
    }

    const when =
      tags?.DateTimeOriginal || tags?.CreateDate || tags?.DateTimeDigitized;
    if (when instanceof Date && !Number.isNaN(when.getTime())) {
      result.takenAt = when.toISOString();
    }
  } catch {
    /* corrupt or EXIF-free image */
  }
  return result;
}

const app = express();

// --- request logging -----------------------------------------------------
// Records every request (and any that abort or close early) to data/access.log,
// which makes client-side "connection reset" reports diagnosable.
const LOG_FILE = path.join(DATA_DIR, "access.log");
function logLine(line) {
  const entry = `${new Date().toISOString()} ${line}\n`;
  fs.appendFile(LOG_FILE, entry, () => {});
  console.log(entry.trimEnd());
}

app.use((req, res, next) => {
  const started = Date.now();
  const declared = req.headers["content-length"] || "-";
  const agent = req.headers["user-agent"] || "-";

  req.on("aborted", () =>
    logLine(
      `ABORTED  ${req.method} ${req.url} after ${Date.now() - started}ms ` +
        `declared=${declared} ua="${agent}"`
    )
  );
  res.on("finish", () =>
    logLine(
      `${res.statusCode}      ${req.method} ${req.url} ${Date.now() - started}ms ` +
        `in=${declared} ua="${agent}"`
    )
  );
  next();
});

// --- optional HTTP Basic Auth -------------------------------------------
// Enabled only when both AUTH_USER and AUTH_PASS are set, so local dev stays
// frictionless while a publicly exposed instance can require credentials.
const AUTH_USER = process.env.AUTH_USER || "";
const AUTH_PASS = process.env.AUTH_PASS || "";
const authEnabled = Boolean(AUTH_USER && AUTH_PASS);

function safeEqual(a, b) {
  const ab = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

function basicAuth(req, res, next) {
  if (!authEnabled) return next();
  const [scheme, encoded] = (req.headers.authorization || "").split(" ");
  if (scheme === "Basic" && encoded) {
    const [user, pass] = Buffer.from(encoded, "base64").toString().split(":");
    if (safeEqual(user, AUTH_USER) && safeEqual(pass ?? "", AUTH_PASS)) {
      return next();
    }
  }
  res.set("WWW-Authenticate", 'Basic realm="Mushroom Map", charset="UTF-8"');
  res.status(401).json({ error: "authentication required" });
}

app.use(basicAuth);
app.use(express.json());

// --- API -----------------------------------------------------------------

// Read GPS from a photo's EXIF without saving anything.
// Used by the frontend to auto-fill coordinates when a photo is chosen.
app.post("/api/exif", memUpload.single("image"), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "image is required" });
  const { gps, takenAt } = await extractExif(req.file.buffer);
  res.json({ hasLocation: !!gps, ...(gps || {}), takenAt });
});

// Create a mushroom sighting (multipart/form-data with an "image" file).
app.post("/api/mushrooms", upload.single("image"), async (req, res) => {
  const { name, notes } = req.body;
  let latNum = Number(req.body.lat);
  let lngNum = Number(req.body.lng);

  if (!name || !name.trim()) {
    return res.status(400).json({ error: "name is required" });
  }

  // Read EXIF once for both a coordinate fallback and the capture timestamp.
  let locationSource = "manual";
  let takenAt = null;
  const missingCoords =
    !Number.isFinite(latNum) || !Number.isFinite(lngNum);
  if (req.file) {
    const exif = await extractExif(req.file.path);
    takenAt = exif.takenAt;
    if (missingCoords && exif.gps) {
      latNum = exif.gps.lat;
      lngNum = exif.gps.lng;
      locationSource = "exif";
    }
  }

  if (!Number.isFinite(latNum) || latNum < -90 || latNum > 90) {
    return res
      .status(400)
      .json({ error: "valid lat (-90..90) is required (none found in photo)" });
  }
  if (!Number.isFinite(lngNum) || lngNum < -180 || lngNum > 180) {
    return res
      .status(400)
      .json({ error: "valid lng (-180..180) is required (none found in photo)" });
  }

  const record = {
    id: randomUUID(),
    name: name.trim(),
    lat: latNum,
    lng: lngNum,
    notes: (notes || "").trim(),
    imageUrl: req.file ? `/uploads/${req.file.filename}` : null,
    locationSource,
    takenAt, // capture time from photo EXIF, or null
    createdAt: new Date().toISOString(),
  };

  const records = readAll();
  records.push(record);
  writeAll(records);

  res.status(201).json(record);
});

// List sightings, optionally filtered by name (case-insensitive substring).
app.get("/api/mushrooms", (req, res) => {
  const { name } = req.query;
  let records = readAll();
  if (name && name.trim()) {
    const q = name.trim().toLowerCase();
    records = records.filter((r) => r.name.toLowerCase().includes(q));
  }
  // Newest first by capture time, falling back to log time when a photo
  // carried no EXIF timestamp.
  const when = (r) => r.takenAt || r.createdAt;
  records.sort((a, b) => when(b).localeCompare(when(a)));
  res.json(records);
});

// Distinct mushroom names (for the filter dropdown).
app.get("/api/names", (_req, res) => {
  const names = [...new Set(readAll().map((r) => r.name))].sort((a, b) =>
    a.localeCompare(b)
  );
  res.json(names);
});

// Delete a sighting (and its image file).
app.delete("/api/mushrooms/:id", (req, res) => {
  const records = readAll();
  const idx = records.findIndex((r) => r.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: "not found" });

  const [removed] = records.splice(idx, 1);
  writeAll(records);
  if (removed.imageUrl) {
    const file = path.join(UPLOAD_DIR, path.basename(removed.imageUrl));
    fs.rm(file, { force: true }, () => {});
  }
  res.json({ ok: true });
});

// --- static files --------------------------------------------------------
app.use("/uploads", express.static(UPLOAD_DIR));
app.use(express.static(path.join(__dirname, "public")));

// Multer / body errors -> JSON
app.use((err, _req, res, _next) => {
  res.status(400).json({ error: err.message });
});

const server = app.listen(PORT, () => {
  console.log(`🍄 Mushroom Map running at http://localhost:${PORT}`);
  console.log(
    authEnabled
      ? `🔒 Basic auth ENABLED (user: ${AUTH_USER})`
      : "🔓 Basic auth disabled (set AUTH_USER and AUTH_PASS to enable)"
  );
});

// Socket-level failures never reach the Express middleware, so log them here —
// this is what a client reports as "connection reset".
server.on("clientError", (err, socket) => {
  logLine(`CLIENT-ERROR ${err.code || ""} ${err.message}`);
  if (socket.writable) socket.end("HTTP/1.1 400 Bad Request\r\n\r\n");
});
server.on("connection", (socket) => {
  socket.on("error", (err) => logLine(`SOCKET-ERROR ${err.code || err.message}`));
});

// Be generous with idle connections so a client reusing a keep-alive socket
// between photo renders doesn't hit a server-closed connection.
server.keepAliveTimeout = 65000;
server.headersTimeout = 70000;
