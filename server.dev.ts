/**
 * Standalone API server for development.
 * Run with: npx ts-node --esm server.dev.ts
 * Or with: npx tsx server.dev.ts
 *
 * This serves only the API endpoints. The Angular dev server
 * proxies /api/* requests here via proxy.conf.json.
 */
import express, { Request, Response, NextFunction } from 'express';
import { resolve, join, extname, basename } from 'node:path';
import { existsSync, mkdirSync, readFileSync, writeFileSync, statSync, unlinkSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import multer from 'multer';
import cookieParser from 'cookie-parser';

// ─── Interfaces ──────────────────────────────────────────────────
interface PinEntry { id: string; pin: string; label: string; active: boolean; }
interface PinConfig { pins: PinEntry[]; maxAttempts: number; lockoutMinutes: number; sessionExpiryHours: number; }
interface UploadConfig { maxFileSizeMB: number; uploadDir: string; allowedExtensions: string[]; blockedExtensions: string[]; }
interface SessionData { userId: string; createdAt: number; expiresAt: number; }
interface FileInfo { id: string; originalName: string; storedName: string; size: number; mimeType: string; uploadedAt: string; uploadedBy: string; }

// ─── Config ─────────────────────────────────────────────────────
const CONFIG_DIR = resolve(process.cwd(), 'config');
const SESSIONS = new Map<string, SessionData>();
const FAILED_ATTEMPTS = new Map<string, { count: number; lockedUntil: number }>();

function loadPinConfig(): PinConfig {
  return JSON.parse(readFileSync(join(CONFIG_DIR, 'pin.json'), 'utf-8'));
}

function loadUploadConfig(): UploadConfig {
  return JSON.parse(readFileSync(join(CONFIG_DIR, 'upload.json'), 'utf-8'));
}

function getUploadDir(): string {
  const config = loadUploadConfig();
  const dir = resolve(process.cwd(), config.uploadDir);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

function getFilesMetadataPath(): string {
  return join(getUploadDir(), '.files-metadata.json');
}

function loadFilesMetadata(): FileInfo[] {
  const p = getFilesMetadataPath();
  if (!existsSync(p)) return [];
  try { return JSON.parse(readFileSync(p, 'utf-8')); } catch { return []; }
}

function saveFilesMetadata(files: FileInfo[]): void {
  writeFileSync(getFilesMetadataPath(), JSON.stringify(files, null, 2), 'utf-8');
}

function sanitizeFilename(filename: string): string {
  let s = basename(filename).replace(/\0/g, '').replace(/[^a-zA-Z0-9._\-\s\(\)]/g, '_');
  if (s.startsWith('.')) s = '_' + s.substring(1);
  if (s.length > 200) { const e = extname(s); s = s.substring(0, 200 - e.length) + e; }
  return s || 'unnamed_file';
}

function isExtensionAllowed(filename: string): boolean {
  const config = loadUploadConfig();
  const ext = extname(filename).toLowerCase();
  if (!ext) return false;
  if (config.blockedExtensions.includes(ext)) return false;
  if (config.allowedExtensions.length > 0 && !config.allowedExtensions.includes(ext)) return false;
  return true;
}

function createSessionToken(userId: string): string {
  const config = loadPinConfig();
  const token = randomUUID();
  SESSIONS.set(token, { userId, createdAt: Date.now(), expiresAt: Date.now() + config.sessionExpiryHours * 3600000 });
  return token;
}

function validateSession(token: string | undefined): SessionData | null {
  if (!token) return null;
  const s = SESSIONS.get(token);
  if (!s) return null;
  if (Date.now() > s.expiresAt) { SESSIONS.delete(token); return null; }
  return s;
}

function checkRateLimit(ip: string): { allowed: boolean; remainingMinutes?: number } {
  const config = loadPinConfig();
  const a = FAILED_ATTEMPTS.get(ip);
  if (!a) return { allowed: true };
  if (a.lockedUntil > Date.now()) return { allowed: false, remainingMinutes: Math.ceil((a.lockedUntil - Date.now()) / 60000) };
  if (a.count >= config.maxAttempts) { a.lockedUntil = Date.now() + config.lockoutMinutes * 60000; return { allowed: false, remainingMinutes: config.lockoutMinutes }; }
  return { allowed: true };
}

function recordFailedAttempt(ip: string): void {
  const config = loadPinConfig();
  const a = FAILED_ATTEMPTS.get(ip) || { count: 0, lockedUntil: 0 };
  a.count++;
  if (a.count >= config.maxAttempts) a.lockedUntil = Date.now() + config.lockoutMinutes * 60000;
  FAILED_ATTEMPTS.set(ip, a);
}

function authMiddleware(req: Request, res: Response, next: NextFunction): void {
  const token = req.cookies?.['session_token'] || req.headers['x-session-token'] as string;
  const session = validateSession(token);
  if (!session) { res.status(401).json({ error: 'Unauthorized. Please login with your PIN.' }); return; }
  (req as any).session = session;
  next();
}

// ─── Express App ────────────────────────────────────────────────
const app = express();
app.use(cookieParser());
app.use(express.json({ limit: '1mb' }));

// Login
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
  res.cookie('session_token', token, { httpOnly: true, sameSite: 'strict', maxAge: config.sessionExpiryHours * 3600000 });
  res.json({ success: true, userId: matched.id, label: matched.label });
});

// Logout
app.post('/api/auth/logout', (req, res) => {
  const token = req.cookies?.['session_token'];
  if (token) SESSIONS.delete(token);
  res.clearCookie('session_token');
  res.json({ success: true });
});

// Check session
app.get('/api/auth/check', (req, res) => {
  const token = req.cookies?.['session_token'] || req.headers['x-session-token'] as string;
  const s = validateSession(token);
  res.json(s ? { authenticated: true, userId: s.userId } : { authenticated: false });
});

// Upload config
app.get('/api/config/upload', (_req, res) => {
  const c = loadUploadConfig();
  res.json({ maxFileSizeMB: c.maxFileSizeMB, allowedExtensions: c.allowedExtensions });
});

// Upload file
app.post('/api/files/upload', authMiddleware, (req, res) => {
  const config = loadUploadConfig();
  const storage = multer.diskStorage({
    destination: (_r, _f, cb) => cb(null, getUploadDir()),
    filename: (_r, file, cb) => {
      const uid = randomUUID().substring(0, 8);
      const san = sanitizeFilename(file.originalname);
      const ext = extname(san);
      cb(null, `${uid}_${san.substring(0, san.length - ext.length)}${ext}`);
    },
  });
  const upload = multer({
    storage,
    limits: { fileSize: config.maxFileSizeMB * 1024 * 1024, files: 1 },
    fileFilter: (_r, file, cb) => {
      if (!isExtensionAllowed(file.originalname)) { cb(new Error(`File type not allowed: ${extname(file.originalname)}`)); return; }
      cb(null, true);
    },
  });
  upload.single('file')(req, res, (err: any) => {
    if (err) {
      if (err instanceof multer.MulterError && err.code === 'LIMIT_FILE_SIZE') { res.status(400).json({ error: `File too large. Maximum size is ${config.maxFileSizeMB}MB.` }); return; }
      res.status(400).json({ error: err.message || 'Upload failed.' }); return;
    }
    if (!req.file) { res.status(400).json({ error: 'No file provided.' }); return; }
    try {
      const stats = statSync(req.file.path);
      if (stats.size > config.maxFileSizeMB * 1024 * 1024) { unlinkSync(req.file.path); res.status(400).json({ error: 'File exceeds maximum size.' }); return; }
    } catch { res.status(500).json({ error: 'Failed to verify uploaded file.' }); return; }
    const sessionData = (req as any).session as SessionData;
    const fileInfo: FileInfo = {
      id: randomUUID(), originalName: sanitizeFilename(req.file.originalname), storedName: req.file.filename,
      size: req.file.size, mimeType: req.file.mimetype, uploadedAt: new Date().toISOString(), uploadedBy: sessionData.userId,
    };
    const files = loadFilesMetadata();
    files.push(fileInfo);
    saveFilesMetadata(files);
    res.json({ success: true, file: fileInfo });
  });
});

// List files
app.get('/api/files', authMiddleware, (_req, res) => {
  const files = loadFilesMetadata();
  files.sort((a, b) => new Date(b.uploadedAt).getTime() - new Date(a.uploadedAt).getTime());
  res.json(files);
});

// Download file
app.get('/api/files/download/:id', authMiddleware, (req, res) => {
  const files = loadFilesMetadata();
  const file = files.find(f => f.id === req.params['id']);
  if (!file) { res.status(404).json({ error: 'File not found.' }); return; }
  const fp = join(getUploadDir(), file.storedName);
  if (!existsSync(fp)) { res.status(404).json({ error: 'File not found on disk.' }); return; }
  const rp = resolve(fp);
  if (!rp.startsWith(resolve(getUploadDir()))) { res.status(403).json({ error: 'Access denied.' }); return; }
  res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(file.originalName)}"`);
  res.setHeader('Content-Type', 'application/octet-stream');
  res.sendFile(rp);
});

// Delete file
app.delete('/api/files/:id', authMiddleware, (req, res) => {
  const files = loadFilesMetadata();
  const idx = files.findIndex(f => f.id === req.params['id']);
  if (idx === -1) { res.status(404).json({ error: 'File not found.' }); return; }
  const file = files[idx];
  const fp = resolve(join(getUploadDir(), file.storedName));
  if (!fp.startsWith(resolve(getUploadDir()))) { res.status(403).json({ error: 'Access denied.' }); return; }
  try {
    if (existsSync(fp)) unlinkSync(fp);
    files.splice(idx, 1);
    saveFilesMetadata(files);
    res.json({ success: true });
  } catch { res.status(500).json({ error: 'Failed to delete file.' }); }
});

// ─── Start ──────────────────────────────────────────────────────
const PORT = 4000;
getUploadDir();
app.listen(PORT, () => {
  console.log(`✅ API server running at http://localhost:${PORT}`);
  console.log(`📁 Upload directory: ${getUploadDir()}`);
  console.log(`🔑 Default PIN: 123456`);
});
