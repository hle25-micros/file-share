/**
 * Production server for File Share app.
 * Serves Angular static files + API endpoints.
 *
 * Usage:
 *   npm run build
 *   npm run start:prod
 */
const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const multer = require('multer');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const cookieParser = require('cookie-parser');

// ─── Interfaces / State ─────────────────────────────────────────
const CONFIG_DIR = path.resolve(__dirname, 'config');
const SESSIONS = new Map();
const FAILED_ATTEMPTS = new Map();

// ─── Config Loading ─────────────────────────────────────────────
function loadPinConfig() {
  return JSON.parse(fs.readFileSync(path.join(CONFIG_DIR, 'pin.json'), 'utf-8'));
}

function loadUploadConfig() {
  return JSON.parse(fs.readFileSync(path.join(CONFIG_DIR, 'upload.json'), 'utf-8'));
}

function getUploadDir() {
  const config = loadUploadConfig();
  const dir = path.resolve(__dirname, config.uploadDir);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function getFilesMetadataPath() {
  return path.join(getUploadDir(), '.files-metadata.json');
}

function loadFilesMetadata() {
  const p = getFilesMetadataPath();
  if (!fs.existsSync(p)) return [];
  try { return JSON.parse(fs.readFileSync(p, 'utf-8')); } catch { return []; }
}

function saveFilesMetadata(files) {
  fs.writeFileSync(getFilesMetadataPath(), JSON.stringify(files, null, 2), 'utf-8');
}

// ─── Security Helpers ───────────────────────────────────────────
function sanitizeFilename(filename) {
  let s = path.basename(filename).replace(/\0/g, '').replace(/[^a-zA-Z0-9._\-\s\(\)]/g, '_');
  if (s.startsWith('.')) s = '_' + s.substring(1);
  if (s.length > 200) { const e = path.extname(s); s = s.substring(0, 200 - e.length) + e; }
  return s || 'unnamed_file';
}

function isExtensionAllowed(filename) {
  const config = loadUploadConfig();
  const ext = path.extname(filename).toLowerCase();
  if (!ext) return false;
  if (config.blockedExtensions.includes(ext)) return false;
  if (config.allowedExtensions.length > 0 && !config.allowedExtensions.includes(ext)) return false;
  return true;
}

function createSessionToken(userId) {
  const config = loadPinConfig();
  const token = crypto.randomUUID();
  SESSIONS.set(token, { userId, createdAt: Date.now(), expiresAt: Date.now() + config.sessionExpiryHours * 3600000 });
  return token;
}

function validateSession(token) {
  if (!token) return null;
  const s = SESSIONS.get(token);
  if (!s) return null;
  if (Date.now() > s.expiresAt) { SESSIONS.delete(token); return null; }
  return s;
}

function checkRateLimit(ip) {
  const config = loadPinConfig();
  const a = FAILED_ATTEMPTS.get(ip);
  if (!a) return { allowed: true };
  if (a.lockedUntil > Date.now()) return { allowed: false, remainingMinutes: Math.ceil((a.lockedUntil - Date.now()) / 60000) };
  if (a.count >= config.maxAttempts) { a.lockedUntil = Date.now() + config.lockoutMinutes * 60000; return { allowed: false, remainingMinutes: config.lockoutMinutes }; }
  return { allowed: true };
}

function recordFailedAttempt(ip) {
  const config = loadPinConfig();
  const a = FAILED_ATTEMPTS.get(ip) || { count: 0, lockedUntil: 0 };
  a.count++;
  if (a.count >= config.maxAttempts) a.lockedUntil = Date.now() + config.lockoutMinutes * 60000;
  FAILED_ATTEMPTS.set(ip, a);
}

function authMiddleware(req, res, next) {
  const token = req.cookies?.['session_token'] || req.headers['x-session-token'];
  const session = validateSession(token);
  if (!session) { res.status(401).json({ error: 'Unauthorized. Please login with your PIN.' }); return; }
  req.sessionData = session;
  next();
}

// ─── Express App ────────────────────────────────────────────────
const app = express();
const STATIC_DIR = path.resolve(__dirname, 'dist/file-share/browser');

app.use((req, res, next) => {
  const TEN_MIN = 20*60*1000;
  req.setTimeout(TEN_MIN);
  res.setTimeout(TEN_MIN);
});

// Security
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      scriptSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", "data:", "blob:"],
      connectSrc: ["'self'"],
    },
  },
  crossOriginEmbedderPolicy: false,
}));
app.use(cookieParser());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({limit: '10mb', extended: true}));

// Trust proxy (for rate limiting behind reverse proxy)
app.set('trust proxy', 1);

// Rate limiting
app.use('/api', rateLimit({ windowMs: 15 * 60 * 1000, max: 200, message: { error: 'Too many requests.' } }));
app.use('/api/auth/login', rateLimit({ windowMs: 15 * 60 * 1000, max: 20, message: { error: 'Too many login attempts.' } }));

// ─── API Routes ─────────────────────────────────────────────────
app.post('/api/auth/login', (req, res) => {
  const { pin } = req.body;
  const ip = req.ip || req.socket.remoteAddress || 'unknown';
  if (!pin || typeof pin !== 'string' || !/^\d{6}$/.test(pin)) { res.status(400).json({ error: 'PIN must be exactly 6 digits.' }); return; }
  const rc = checkRateLimit(ip);
  if (!rc.allowed) { res.status(429).json({ error: `Too many failed attempts. Locked for ${rc.remainingMinutes} minute(s).` }); return; }
  const config = loadPinConfig();
  const matched = config.pins.find(p => p.active && p.pin === pin);
  if (!matched) {
    recordFailedAttempt(ip);
    const a = FAILED_ATTEMPTS.get(ip);
    const rem = config.maxAttempts - (a?.count || 0);
    res.status(401).json({ error: `Invalid PIN. ${rem > 0 ? rem + ' attempt(s) remaining.' : 'Account locked.'}` });
    return;
  }
  FAILED_ATTEMPTS.delete(ip);
  const token = createSessionToken(matched.id);
  res.cookie('session_token', token, { httpOnly: true, secure: process.env.NODE_ENV === 'production', sameSite: 'strict', maxAge: config.sessionExpiryHours * 3600000 });
  res.json({ success: true, userId: matched.id, label: matched.label });
});

app.post('/api/auth/logout', (req, res) => {
  const token = req.cookies?.['session_token'];
  if (token) SESSIONS.delete(token);
  res.clearCookie('session_token');
  res.json({ success: true });
});

app.get('/api/auth/check', (req, res) => {
  const token = req.cookies?.['session_token'] || req.headers['x-session-token'];
  const s = validateSession(token);
  if (!s) {
    return res.status(401).join({authenticated: false});
  }
  res.json({ authenticated: true, userId: s.userId });
});

app.get('/api/config/upload', (_req, res) => {
  const c = loadUploadConfig();
  res.json({ maxFileSizeMB: c.maxFileSizeMB, allowedExtensions: c.allowedExtensions });
});

app.post('/api/files/upload', authMiddleware, (req, res) => {
  const config = loadUploadConfig();
  const storage = multer.diskStorage({
    destination: (_r, _f, cb) => cb(null, getUploadDir()),
    filename: (_r, file, cb) => {
      const uid = crypto.randomUUID().substring(0, 8);
      const san = sanitizeFilename(file.originalname);
      const ext = path.extname(san);
      cb(null, `${uid}_${san.substring(0, san.length - ext.length)}${ext}`);
    },
  });
  const upload = multer({
    storage,
    limits: { fileSize: config.maxFileSizeMB * 1024 * 1024, files: 1 },
    fileFilter: (_r, file, cb) => {
      if (!isExtensionAllowed(file.originalname)) { cb(new Error(`File type not allowed: ${path.extname(file.originalname)}`)); return; }
      cb(null, true);
    },
  });
  upload.single('file')(req, res, (err) => {
    if (err) {
      if (err.code === 'LIMIT_FILE_SIZE') { res.status(400).json({ error: `File too large. Maximum size is ${config.maxFileSizeMB}MB.` }); return; }
      res.status(400).json({ error: err.message || 'Upload failed.' }); return;
    }
    if (!req.file) { res.status(400).json({ error: 'No file provided.' }); return; }
    try {
      const stats = fs.statSync(req.file.path);
      if (stats.size > config.maxFileSizeMB * 1024 * 1024) { fs.unlinkSync(req.file.path); res.status(400).json({ error: 'File exceeds maximum size.' }); return; }
    } catch { res.status(500).json({ error: 'Failed to verify uploaded file.' }); return; }
    const fileInfo = {
      id: crypto.randomUUID(), originalName: sanitizeFilename(req.file.originalname), storedName: req.file.filename,
      size: req.file.size, mimeType: req.file.mimetype, uploadedAt: new Date().toISOString(), uploadedBy: req.sessionData.userId,
    };
    const files = loadFilesMetadata();
    files.push(fileInfo);
    saveFilesMetadata(files);
    res.json({ success: true, file: fileInfo });
  });
});

app.get('/api/files', authMiddleware, (_req, res) => {
  const files = loadFilesMetadata();
  files.sort((a, b) => new Date(b.uploadedAt).getTime() - new Date(a.uploadedAt).getTime());
  res.json(files);
});

app.get('/api/files/download/:id', authMiddleware, (req, res) => {
  const files = loadFilesMetadata();
  const file = files.find(f => f.id === req.params.id);
  if (!file) { res.status(404).json({ error: 'File not found.' }); return; }
  const fp = path.join(getUploadDir(), file.storedName);
  if (!fs.existsSync(fp)) { res.status(404).json({ error: 'File not found on disk.' }); return; }
  const rp = path.resolve(fp);
  if (!rp.startsWith(path.resolve(getUploadDir()))) { res.status(403).json({ error: 'Access denied.' }); return; }
  res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(file.originalName)}"`);
  res.setHeader('Content-Type', 'application/octet-stream');
  res.sendFile(rp);
});

app.delete('/api/files/:id', authMiddleware, (req, res) => {
  const files = loadFilesMetadata();
  const idx = files.findIndex(f => f.id === req.params.id);
  if (idx === -1) { res.status(404).json({ error: 'File not found.' }); return; }
  const file = files[idx];
  const fp = path.resolve(path.join(getUploadDir(), file.storedName));
  if (!fp.startsWith(path.resolve(getUploadDir()))) { res.status(403).json({ error: 'Access denied.' }); return; }
  try {
    if (fs.existsSync(fp)) fs.unlinkSync(fp);
    files.splice(idx, 1);
    saveFilesMetadata(files);
    res.json({ success: true });
  } catch { res.status(500).json({ error: 'Failed to delete file.' }); }
});

// ─── Serve Angular Static Files ────────────────────────────────
app.use(express.static(STATIC_DIR));

// All other routes → Angular index.html (SPA fallback)
app.get('*', (_req, res) => {
  res.sendFile(path.join(STATIC_DIR, 'index.html'));
});

// ─── Start Server ──────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
//getUploadDir();
app.listen(PORT, () => {
  console.log(`🚀 File Share running at http://localhost:${PORT}`);
  console.log(`📁 Upload directory: ${getUploadDir()}`);
});
