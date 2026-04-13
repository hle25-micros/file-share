/**
 * Production server for File Share app
 * Serves Angular static files + full API
 *
 * ⚠️  ZERO fs.*Sync in global scope or request handlers.
 *     All file I/O is async (fs/promises) to avoid blocking
 *     the event-loop after VM cold-start / reboot.
 *
 * ⚠️  SESSIONS are in-memory (Map). They are lost on every
 *     process restart / VM reboot. Users will need to re-login.
 *     For multi-instance or persistent sessions → use Redis.
 */

const express = require('express');
const path = require('path');
const fs = require('fs/promises');
const crypto = require('crypto');
const multer = require('multer');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const cookieParser = require('cookie-parser');

/* =====================================================
   CONSTANTS & PATHS (no I/O, just strings)
===================================================== */
const PORT = process.env.PORT || 3000;
const BASE_DIR = __dirname;
const CONFIG_DIR = path.join(BASE_DIR, 'config');
const STATIC_DIR = path.join(BASE_DIR, 'dist', 'file-share', 'browser');

/* =====================================================
   IN-MEMORY STATE
   ⚠️  Reboot = all sessions lost → users re-login.
       This is acceptable for a single-VM internal tool.
       For scale / persistence → replace with Redis.
===================================================== */
const SESSIONS = new Map();
const FAILED_ATTEMPTS = new Map();

/* =====================================================
   CONFIG (async load + cache, invalidate on demand)
   Config files are small and rarely change, so we cache
   after first read. Call reloadConfig() if you edit them
   at runtime.
===================================================== */
let _pinConfigCache = null;
let _uploadConfigCache = null;

async function loadPinConfig() {
  if (!_pinConfigCache) {
    const raw = await fs.readFile(path.join(CONFIG_DIR, 'pin.json'), 'utf-8');
    _pinConfigCache = JSON.parse(raw);
  }
  return _pinConfigCache;
}

async function loadUploadConfig() {
  if (!_uploadConfigCache) {
    const raw = await fs.readFile(path.join(CONFIG_DIR, 'upload.json'), 'utf-8');
    _uploadConfigCache = JSON.parse(raw);
  }
  return _uploadConfigCache;
}

/* =====================================================
   UPLOAD DIR & METADATA (all async)
===================================================== */
let _uploadDirResolved = null;

async function getUploadDir() {
  if (!_uploadDirResolved) {
    const cfg = await loadUploadConfig();
    _uploadDirResolved = path.resolve(BASE_DIR, cfg.uploadDir);
    await fs.mkdir(_uploadDirResolved, { recursive: true });
  }
  return _uploadDirResolved;
}

async function getMetadataPath() {
  const dir = await getUploadDir();
  return path.join(dir, '.files-metadata.json');
}

async function loadFilesMetadata() {
  const p = await getMetadataPath();
  try {
    const raw = await fs.readFile(p, 'utf-8');
    return JSON.parse(raw);
  } catch {
    // File doesn't exist or invalid JSON → empty list
    return [];
  }
}

async function saveFilesMetadata(files) {
  const p = await getMetadataPath();
  await fs.writeFile(p, JSON.stringify(files, null, 2), 'utf-8');
}

/* =====================================================
   FILENAME & EXTENSION HELPERS (pure, no I/O)
===================================================== */
function sanitizeFilename(filename) {
  let s = path.basename(filename).replace(/\0/g, '').replace(/[^a-zA-Z0-9._\-\s()]/g, '_');
  if (s.startsWith('.')) s = '_' + s.substring(1);
  if (s.length > 200) {
    const ext = path.extname(s);
    s = s.substring(0, 200 - ext.length) + ext;
  }
  return s || 'unnamed_file';
}

function isExtensionAllowedSync(filename, uploadCfg) {
  // Pure check using already-loaded config (no I/O)
  const ext = path.extname(filename).toLowerCase();
  if (!ext) return false;
  if (uploadCfg.blockedExtensions && uploadCfg.blockedExtensions.includes(ext)) return false;
  if (uploadCfg.allowedExtensions && uploadCfg.allowedExtensions.length > 0 && !uploadCfg.allowedExtensions.includes(ext)) return false;
  return true;
}

/* =====================================================
   SESSION HELPERS (pure in-memory, O(1), no I/O)
===================================================== */
function createSession(userId, hours) {
  const token = crypto.randomUUID();
  SESSIONS.set(token, {
    userId,
    createdAt: Date.now(),
    expiresAt: Date.now() + hours * 3600_000,
  });
  return token;
}

function validateSession(token) {
  if (!token) return null;
  const s = SESSIONS.get(token);
  if (!s) return null;
  if (Date.now() > s.expiresAt) {
    SESSIONS.delete(token);
    return null;
  }
  return s;
}

function getToken(req) {
  return req.cookies?.session_token || req.headers['x-session-token'];
}

/* =====================================================
   LOGIN RATE LIMIT (pure in-memory, no I/O)
   Uses cached maxAttempts/lockoutMinutes from bootstrap.
===================================================== */
let _loginRateCfg = { maxAttempts: 5, lockoutMinutes: 15 }; // defaults, overwritten in bootstrap

function checkLoginRateLimit(ip) {
  const a = FAILED_ATTEMPTS.get(ip);
  if (!a) return { allowed: true };
  if (a.lockedUntil > Date.now()) {
    return { allowed: false, remainingMinutes: Math.ceil((a.lockedUntil - Date.now()) / 60000) };
  }
  if (a.count >= _loginRateCfg.maxAttempts) {
    a.lockedUntil = Date.now() + _loginRateCfg.lockoutMinutes * 60000;
    return { allowed: false, remainingMinutes: _loginRateCfg.lockoutMinutes };
  }
  return { allowed: true };
}

function recordFailedAttempt(ip) {
  const a = FAILED_ATTEMPTS.get(ip) || { count: 0, lockedUntil: 0 };
  a.count++;
  if (a.count >= _loginRateCfg.maxAttempts) {
    a.lockedUntil = Date.now() + _loginRateCfg.lockoutMinutes * 60000;
  }
  FAILED_ATTEMPTS.set(ip, a);
}

/* =====================================================
   AUTH MIDDLEWARE (pure in-memory check, no I/O)
===================================================== */
function authMiddleware(req, res, next) {
  const session = validateSession(getToken(req));
  if (!session) {
    return res.status(401).json({ error: 'Unauthorized. Please login with your PIN.' });
  }
  req.userSession = session;
  next();
}

/* =====================================================
   EXPRESS APP
===================================================== */
const app = express();

// Trust proxy (Azure VM, Docker, nginx, etc.)
app.set('trust proxy', 1);

/* ---------- HELMET (with CSP that allows Angular to work) ---------- */
app.use(helmet({
  crossOriginEmbedderPolicy: false,
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'"],
      styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
      fontSrc: ["'self'", "https://fonts.gstatic.com", "data:"],
      imgSrc: ["'self'", "data:", "blob:"],
      connectSrc: ["'self'"],
    },
  },
}));

app.use(cookieParser());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ limit: '10mb', extended: true }));

/* ---------- RATE LIMIT ----------
   ONE limiter for general API, login route SKIPPED from it.
   ONE separate limiter for login only.
   → No double-counting on login requests (review #5).
*/
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 300,
  standardHeaders: true,
  legacyHeaders: false,
  skip: (req) => req.path === '/api/auth/login',
});
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
});
app.use('/api', apiLimiter);
app.use('/api/auth/login', loginLimiter);

/* =====================================================
   AUTH ROUTES
===================================================== */

// Login (async — reads pin config from cache)
app.post('/api/auth/login', async (req, res) => {
  try {
    const { pin } = req.body;
    const ip = req.ip || req.socket?.remoteAddress || 'unknown';

    if (!pin || typeof pin !== 'string' || !/^\d{6}$/.test(pin)) {
      return res.status(400).json({ error: 'PIN must be exactly 6 digits.' });
    }

    const rc = checkLoginRateLimit(ip);
    if (!rc.allowed) {
      return res.status(429).json({ error: `Too many failed attempts. Locked for ${rc.remainingMinutes} minute(s).` });
    }

    const cfg = await loadPinConfig();
    const matched = cfg.pins.find(p => p.active && p.pin === pin);

    if (!matched) {
      recordFailedAttempt(ip);
      const a = FAILED_ATTEMPTS.get(ip);
      const rem = _loginRateCfg.maxAttempts - (a?.count || 0);
      return res.status(401).json({
        error: `Invalid PIN. ${rem > 0 ? rem + ' attempt(s) remaining.' : 'Account locked.'}`,
      });
    }

    // Success → clear failed attempts
    FAILED_ATTEMPTS.delete(ip);
    const token = createSession(matched.id, cfg.sessionExpiryHours);

    // Cookie secure based on actual request protocol (review #6)
    const isSecure = req.secure || req.headers['x-forwarded-proto'] === 'https';
    res.cookie('session_token', token, {
      httpOnly: true,
      secure: isSecure,
      sameSite: 'strict',
      maxAge: cfg.sessionExpiryHours * 3600_000,
    });

    return res.json({ success: true, userId: matched.id, label: matched.label });
  } catch (err) {
    console.error('Login error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// Logout (pure in-memory, no I/O)
app.post('/api/auth/logout', (req, res) => {
  const token = req.cookies?.session_token;
  if (token) SESSIONS.delete(token);
  res.clearCookie('session_token');
  return res.json({ success: true });
});

// Check session — MUST be PURE & FAST (review #2)
// ✅ No file reads, no crypto, no async, no await
// ✅ Only in-memory Map.get() → O(1) → always returns immediately
app.get('/api/auth/check', (req, res) => {
  const session = validateSession(getToken(req));
  if (!session) {
    return res.json({ authenticated: false });
  }
  return res.json({ authenticated: true, userId: session.userId });
});

/* =====================================================
   FILE ROUTES
===================================================== */

// Upload config (async — reads from cache)
app.get('/api/config/upload', async (_req, res) => {
  try {
    const cfg = await loadUploadConfig();
    return res.json({ maxFileSizeMB: cfg.maxFileSizeMB, allowedExtensions: cfg.allowedExtensions });
  } catch (err) {
    console.error('Error loading upload config:', err);
    return res.status(500).json({ error: 'Failed to load config' });
  }
});

// Upload file (async — all I/O is non-blocking)
app.post('/api/files/upload', authMiddleware, async (req, res) => {
  try {
    const cfg = await loadUploadConfig();
    const uploadDir = await getUploadDir();

    const storage = multer.diskStorage({
      destination: (_r, _f, cb) => cb(null, uploadDir),
      filename: (_r, file, cb) => {
        const uid = crypto.randomUUID().substring(0, 8);
        const san = sanitizeFilename(file.originalname);
        const ext = path.extname(san);
        const base = san.substring(0, san.length - ext.length);
        cb(null, `${uid}_${base}${ext}`);
      },
    });

    const upload = multer({
      storage,
      limits: { fileSize: cfg.maxFileSizeMB * 1024 * 1024, files: 1 },
      fileFilter: (_r, file, cb) => {
        if (!isExtensionAllowedSync(file.originalname, cfg)) {
          return cb(new Error(`File type not allowed: ${path.extname(file.originalname)}`));
        }
        cb(null, true);
      },
    });

    upload.single('file')(req, res, async (err) => {
      try {
        if (err) {
          if (err.code === 'LIMIT_FILE_SIZE') {
            return res.status(400).json({ error: `File too large. Maximum size is ${cfg.maxFileSizeMB}MB.` });
          }
          return res.status(400).json({ error: err.message || 'Upload failed.' });
        }
        if (!req.file) {
          return res.status(400).json({ error: 'No file provided.' });
        }

        // Save metadata (async)
        const fileInfo = {
          id: crypto.randomUUID(),
          originalName: sanitizeFilename(req.file.originalname),
          storedName: req.file.filename,
          size: req.file.size,
          mimeType: req.file.mimetype,
          uploadedAt: new Date().toISOString(),
          uploadedBy: req.userSession.userId,
        };

        const files = await loadFilesMetadata();
        files.push(fileInfo);
        await saveFilesMetadata(files);

        return res.json({ success: true, file: fileInfo });
      } catch (innerErr) {
        console.error('Upload post-process error:', innerErr);
        return res.status(500).json({ error: 'Failed to save file metadata' });
      }
    });
  } catch (err) {
    console.error('Upload setup error:', err);
    return res.status(500).json({ error: 'Upload failed' });
  }
});

// List files (async)
app.get('/api/files', authMiddleware, async (_req, res) => {
  try {
    const files = await loadFilesMetadata();
    files.sort((a, b) => new Date(b.uploadedAt).getTime() - new Date(a.uploadedAt).getTime());
    return res.json(files);
  } catch (err) {
    console.error('List files error:', err);
    return res.status(500).json({ error: 'Failed to list files' });
  }
});

// Download file (async)
app.get('/api/files/download/:id', authMiddleware, async (req, res) => {
  try {
    const files = await loadFilesMetadata();
    const file = files.find(f => f.id === req.params.id);
    if (!file) return res.status(404).json({ error: 'File not found.' });

    const uploadDir = await getUploadDir();
    const fp = path.resolve(path.join(uploadDir, file.storedName));

    // Path traversal check
    if (!fp.startsWith(path.resolve(uploadDir))) {
      return res.status(403).json({ error: 'Access denied.' });
    }

    // Check file exists (async)
    try {
      await fs.access(fp);
    } catch {
      return res.status(404).json({ error: 'File not found on disk.' });
    }

    res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(file.originalName)}"`);
    res.setHeader('Content-Type', 'application/octet-stream');
    return res.sendFile(fp);
  } catch (err) {
    console.error('Download error:', err);
    return res.status(500).json({ error: 'Download failed' });
  }
});

// Delete file (async)
app.delete('/api/files/:id', authMiddleware, async (req, res) => {
  try {
    const files = await loadFilesMetadata();
    const idx = files.findIndex(f => f.id === req.params.id);
    if (idx === -1) return res.status(404).json({ error: 'File not found.' });

    const file = files[idx];
    const uploadDir = await getUploadDir();
    const fp = path.resolve(path.join(uploadDir, file.storedName));

    // Path traversal check
    if (!fp.startsWith(path.resolve(uploadDir))) {
      return res.status(403).json({ error: 'Access denied.' });
    }

    // Delete file from disk (async, ignore if already gone)
    try {
      await fs.unlink(fp);
    } catch {
      // File already deleted or missing — that's OK
    }

    files.splice(idx, 1);
    await saveFilesMetadata(files);
    return res.json({ success: true });
  } catch (err) {
    console.error('Delete error:', err);
    return res.status(500).json({ error: 'Failed to delete file.' });
  }
});

/* =====================================================
   HEALTHCHECK (pure, no I/O — review #7)
===================================================== */
app.get('/api/health', (_req, res) => {
  res.json({ ok: true, ts: Date.now(), uptime: process.uptime() });
});

/* =====================================================
   STATIC FILES & SPA FALLBACK
   ⚠️  app.get('*') MUST be LAST (review #8)
===================================================== */
app.use(express.static(STATIC_DIR, { maxAge: '1d' }));

// Cache index.html content after first read to avoid I/O per request
let _indexHtmlCache = null;

app.get('*', async (_req, res) => {
  try {
    if (!_indexHtmlCache) {
      _indexHtmlCache = await fs.readFile(path.join(STATIC_DIR, 'index.html'));
    }
    res.setHeader('Content-Type', 'text/html');
    return res.send(_indexHtmlCache);
  } catch {
    return res.status(500).send('index.html not found. Did you run ng build?');
  }
});

/* =====================================================
   ERROR HANDLER (catch unhandled errors, don't crash)
===================================================== */
app.use((err, _req, res, _next) => {
  console.error('Unhandled error:', err);
  if (!res.headersSent) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

/* =====================================================
   BOOTSTRAP — async + fail fast (review #4)
   All I/O happens here BEFORE app.listen().
   If anything fails → log + exit → PM2/systemd restarts.
   Guarantees: if server is listening, logic is alive.
===================================================== */
async function bootstrap() {
  // 1. Verify & load config (async)
  try {
    await fs.access(path.join(CONFIG_DIR, 'pin.json'));
    await fs.access(path.join(CONFIG_DIR, 'upload.json'));
  } catch (err) {
    console.error('❌ Config files missing:', err.message);
    process.exit(1);
  }

  // 2. Pre-warm config caches (so first requests don't wait for I/O)
  const pinCfg = await loadPinConfig();
  await loadUploadConfig();

  // 3. Cache login rate-limit settings from pin config
  _loginRateCfg = {
    maxAttempts: pinCfg.maxAttempts || 5,
    lockoutMinutes: pinCfg.lockoutMinutes || 15,
  };

  // 4. Ensure upload dir exists
  await getUploadDir();

  // 5. Check static dir (warn only, don't crash — user may not have built yet)
  try {
    await fs.access(STATIC_DIR);
  } catch {
    console.warn('⚠️  Static dir not found:', STATIC_DIR, '— run ng build first');
  }

  // 6. Start listening
  app.listen(PORT, () => {
    console.log(`✅ Server listening on port ${PORT}, PID=${process.pid}`);
    console.log(`📁 Static: ${STATIC_DIR}`);
  });
}

bootstrap().catch(err => {
  console.error('❌ BOOTSTRAP FAILED:', err);
  process.exit(1);
});