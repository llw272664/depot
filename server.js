'use strict';

const express = require('express');
const multer = require('multer');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');

const PORT = Number(process.env.PORT || 3000);
// 默认监听 IPv6 双栈：隧道/反代常先用 ::1 连，只听 0.0.0.0 会首个请求 502
const HOST = process.env.HOST || '::';

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const FILES_DIR = path.join(DATA_DIR, 'files');
const INDEX_FILE = path.join(DATA_DIR, 'index.json');

const SITE_NAME = process.env.SITE_NAME || '仓';
const SITE_SUB = process.env.SITE_SUB || '图片与零碎，放在这里';
const SITE_OWNER = process.env.SITE_OWNER || '';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';
const API_KEY = process.env.API_KEY || '';
const MAX_MB = Number(process.env.MAX_UPLOAD_MB || 24);
const SESSION_SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');
const SESSION_TTL = 1000 * 60 * 60 * 24 * 30;

const ALLOWED = new Set([
  'image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/avif',
  'image/svg+xml', 'image/bmp', 'application/pdf',
]);

const EXT = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/gif': '.gif',
  'image/webp': '.webp',
  'image/avif': '.avif',
  'image/svg+xml': '.svg',
  'image/bmp': '.bmp',
  'application/pdf': '.pdf',
};

/* ---------------------------------------------------------------- storage */

let s3 = null;
if (process.env.S3_ENDPOINT && process.env.S3_BUCKET) {
  try {
    const { S3Client } = require('@aws-sdk/client-s3');
    s3 = new S3Client({
      endpoint: process.env.S3_ENDPOINT,
      region: process.env.S3_REGION || 'auto',
      forcePathStyle: true,
      credentials: {
        accessKeyId: process.env.S3_ACCESS_KEY_ID || process.env.S3_ACCESS_KEY || '',
        secretAccessKey: process.env.S3_SECRET_ACCESS_KEY || process.env.S3_SECRET_KEY || '',
      },
    });
    console.log('[storage] object storage enabled');
  } catch (err) {
    console.warn('[storage] S3 env present but @aws-sdk/client-s3 not installed, using local disk');
  }
}

async function putObject(name, buffer, contentType) {
  if (s3) {
    const { PutObjectCommand } = require('@aws-sdk/client-s3');
    await s3.send(new PutObjectCommand({
      Bucket: process.env.S3_BUCKET,
      Key: `depot/${name}`,
      Body: buffer,
      ContentType: contentType,
    }));
    return;
  }
  await fsp.writeFile(path.join(FILES_DIR, name), buffer);
}

async function getObject(name) {
  if (s3) {
    const { GetObjectCommand } = require('@aws-sdk/client-s3');
    const res = await s3.send(new GetObjectCommand({ Bucket: process.env.S3_BUCKET, Key: `depot/${name}` }));
    const chunks = [];
    for await (const chunk of res.Body) chunks.push(chunk);
    return Buffer.concat(chunks);
  }
  return fsp.readFile(path.join(FILES_DIR, name));
}

async function removeObject(name) {
  if (s3) {
    const { DeleteObjectCommand } = require('@aws-sdk/client-s3');
    await s3.send(new DeleteObjectCommand({ Bucket: process.env.S3_BUCKET, Key: `depot/${name}` }));
    return;
  }
  await fsp.unlink(path.join(FILES_DIR, name)).catch(() => {});
}

/* ------------------------------------------------------------------ index */

let items = [];
let writing = Promise.resolve();

async function loadIndex() {
  await fsp.mkdir(FILES_DIR, { recursive: true });
  try {
    const raw = await fsp.readFile(INDEX_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    items = Array.isArray(parsed) ? parsed : [];
  } catch {
    items = [];
  }
}

function saveIndex() {
  const snapshot = JSON.stringify(items, null, 1);
  writing = writing.then(async () => {
    const tmp = INDEX_FILE + '.tmp';
    await fsp.writeFile(tmp, snapshot, 'utf8');
    await fsp.rename(tmp, INDEX_FILE);
  }).catch((err) => console.warn('[index] save failed', err.message));
  return writing;
}

/* ------------------------------------------------------------------- auth */

function sign(value) {
  return crypto.createHmac('sha256', SESSION_SECRET).update(value).digest('base64url');
}

function issueSession() {
  const payload = String(Date.now() + SESSION_TTL);
  return payload + '.' + sign(payload);
}

function validSession(token) {
  if (!token || !token.includes('.')) return false;
  const [payload, mac] = token.split('.');
  const expected = sign(payload);
  const a = Buffer.from(mac || '');
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return false;
  return Number(payload) > Date.now();
}

function readCookie(req, key) {
  const header = req.headers.cookie || '';
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx < 0) continue;
    if (part.slice(0, idx).trim() === key) return decodeURIComponent(part.slice(idx + 1).trim());
  }
  return '';
}

function isAdmin(req) {
  if (validSession(readCookie(req, 'sid'))) return true;
  if (API_KEY && req.headers['x-api-key'] === API_KEY) return true;
  return false;
}

function requireAdmin(req, res, next) {
  if (isAdmin(req)) return next();
  res.status(401).json({ error: 'unauthorized' });
}

/* ------------------------------------------------------------------- http */

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', true);
app.use(express.json({ limit: '256kb' }));

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_MB * 1024 * 1024, files: 12 },
});

app.get('/health', (_req, res) => res.json({ ok: true, uptime: Math.round(process.uptime()) }));

app.get('/api/config', (_req, res) => {
  res.json({
    name: SITE_NAME,
    sub: SITE_SUB,
    owner: SITE_OWNER,
    maxMb: MAX_MB,
    admin: ADMIN_PASSWORD ? true : false,
  });
});

app.get('/api/images', (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 200, 500);
  const total = items.length;
  const bytes = items.reduce((sum, it) => sum + (it.size || 0), 0);
  res.json({ total, bytes, items: items.slice(0, limit) });
});

app.post('/api/login', (req, res) => {
  const password = String((req.body && req.body.password) || '');
  if (!ADMIN_PASSWORD) return res.status(400).json({ error: '未设置 ADMIN_PASSWORD' });
  const a = Buffer.from(password);
  const b = Buffer.from(ADMIN_PASSWORD);
  const ok = a.length === b.length && crypto.timingSafeEqual(a, b);
  if (!ok) return res.status(401).json({ error: '密码不对' });
  res.setHeader('Set-Cookie',
    `sid=${encodeURIComponent(issueSession())}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_TTL / 1000}`);
  res.json({ ok: true });
});

app.post('/api/logout', (req, res) => {
  res.setHeader('Set-Cookie', 'sid=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0');
  res.json({ ok: true });
});

app.get('/api/session', (req, res) => res.json({ admin: isAdmin(req) }));

app.post('/api/upload', requireAdmin, upload.array('files', 12), async (req, res) => {
  const files = req.files || [];
  if (!files.length) return res.status(400).json({ error: '没有收到文件' });

  const added = [];
  for (const file of files) {
    const type = file.mimetype || 'application/octet-stream';
    if (!ALLOWED.has(type)) {
      added.push({ name: file.originalname, error: '不支持的类型：' + type });
      continue;
    }
    const id = crypto.randomBytes(4).toString('hex');
    const name = id + (EXT[type] || '.bin');
    try {
      await putObject(name, file.buffer, type);
      const entry = {
        id,
        name,
        title: file.originalname || name,
        size: file.size,
        type,
        ts: Date.now(),
      };
      items.unshift(entry);
      added.push(entry);
    } catch (err) {
      added.push({ name: file.originalname, error: err.message });
    }
  }
  await saveIndex();
  res.json({ ok: true, added });
});

app.delete('/api/images/:id', requireAdmin, async (req, res) => {
  const idx = items.findIndex((it) => it.id === req.params.id);
  if (idx < 0) return res.status(404).json({ error: '没有这张图' });
  const [entry] = items.splice(idx, 1);
  await removeObject(entry.name);
  await saveIndex();
  res.json({ ok: true });
});

app.get('/f/:name', async (req, res) => {
  const name = path.basename(req.params.name);
  const entry = items.find((it) => it.name === name);
  if (!entry) return res.status(404).send('not found');
  try {
    const buffer = await getObject(name);
    res.setHeader('Content-Type', entry.type);
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    res.setHeader('Content-Disposition', `inline; filename="${encodeURIComponent(entry.title)}"`);
    res.send(buffer);
  } catch {
    res.status(404).send('not found');
  }
});

app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'] }));
app.get('*', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

/* ------------------------------------------------------------------- boot */

loadIndex().then(() => {
  if (!ADMIN_PASSWORD) console.warn('[auth] ADMIN_PASSWORD 未设置，上传接口会拒绝所有请求');
  app.listen(PORT, HOST, () => {
    console.log(`depot listening on http://${HOST}:${PORT} · ${items.length} items · storage=${s3 ? 'object' : 'local'}`);
  });
});
