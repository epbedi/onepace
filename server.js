const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');

const ROOT = __dirname;
const DATA = path.join(ROOT, 'data');
const VIDEOS = path.join(DATA, 'videos');
const TEMP = path.join(DATA, 'uploads');
const META = path.join(DATA, 'episodes.json');
const PORT = Number(process.env.PORT || 3000);
const MAX_CHUNK = 8 * 1024 * 1024;
const MIME = { '.mp4': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime', '.m4v': 'video/mp4', '.ogv': 'video/ogg' };

async function prepare() {
  await Promise.all([fs.mkdir(VIDEOS, { recursive: true }), fs.mkdir(TEMP, { recursive: true })]);
  try { await fs.access(META); } catch { await fs.writeFile(META, '[]'); }
}
async function readEpisodes() { return JSON.parse(await fs.readFile(META, 'utf8')); }
async function saveEpisodes(items) { await fs.writeFile(META, JSON.stringify(items, null, 2)); }
function send(res, status, data, type = 'application/json; charset=utf-8') {
  res.writeHead(status, { 'Content-Type': type, 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-store' });
  res.end(type.startsWith('application/json') ? JSON.stringify(data) : data);
}
function body(req, limit = 64 * 1024) {
  return new Promise((resolve, reject) => {
    let raw = ''; let size = 0;
    req.on('data', chunk => { size += chunk.length; if (size > limit) { reject(Object.assign(new Error('Request too large'), { status: 413 })); req.destroy(); } else raw += chunk; });
    req.on('end', () => { try { resolve(JSON.parse(raw || '{}')); } catch { reject(Object.assign(new Error('Invalid JSON'), { status: 400 })); } });
    req.on('error', reject);
  });
}
function cleanName(name) { return path.basename(String(name || '')).replace(/[\u0000-\u001f]/g, '').slice(0, 180); }
function safeId(value) { return /^[a-f0-9-]{36}$/.test(String(value)); }

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  try {
    if (req.method === 'GET' && url.pathname === '/api/episodes') {
      const episodes = await readEpisodes();
      return send(res, 200, episodes.sort((a, b) => a.season - b.season || a.episode - b.episode));
    }
    if (req.method === 'POST' && url.pathname === '/api/uploads/start') {
      const input = await body(req);
      const originalName = cleanName(input.fileName);
      const ext = path.extname(originalName).toLowerCase();
      if (!MIME[ext]) return send(res, 415, { error: 'Use an MP4, WebM, MOV, M4V, or OGV video.' });
      if (!Number.isSafeInteger(input.size) || input.size <= 0) return send(res, 400, { error: 'File size is missing or invalid.' });
      if (!Number.isInteger(input.chunks) || input.chunks < 1 || input.chunks > 100000) return send(res, 400, { error: 'Invalid upload chunk count.' });
      const season = Number(input.season); const episode = Number(input.episode);
      if (!Number.isInteger(season) || season < 1 || season > 999 || !Number.isInteger(episode) || episode < 1 || episode > 9999) return send(res, 400, { error: 'Enter a valid season and episode number.' });
      const id = crypto.randomUUID();
      await fs.mkdir(path.join(TEMP, id));
      await fs.writeFile(path.join(TEMP, id, 'manifest.json'), JSON.stringify({ id, originalName, ext, size: input.size, chunks: input.chunks, season, episode, title: String(input.title || '').trim().slice(0, 160) }));
      return send(res, 201, { uploadId: id });
    }
    const chunkMatch = url.pathname.match(/^\/api\/uploads\/([a-f0-9-]{36})\/([0-9]+)$/);
    if (req.method === 'PUT' && chunkMatch) {
      const [, id, chunkText] = chunkMatch; const index = Number(chunkText);
      if (!safeId(id)) return send(res, 400, { error: 'Invalid upload.' });
      const dir = path.join(TEMP, id);
      let manifest;
      try { manifest = JSON.parse(await fs.readFile(path.join(dir, 'manifest.json'), 'utf8')); } catch { return send(res, 404, { error: 'Upload session not found.' }); }
      if (!Number.isInteger(index) || index < 0 || index >= manifest.chunks) return send(res, 400, { error: 'Invalid chunk number.' });
      const parts = []; let size = 0;
      for await (const part of req) { size += part.length; if (size > MAX_CHUNK) return send(res, 413, { error: 'Chunk is too large.' }); parts.push(part); }
      if (!size) return send(res, 400, { error: 'Empty upload chunk.' });
      await fs.writeFile(path.join(dir, `${index}.part`), Buffer.concat(parts));
      return send(res, 200, { received: index });
    }
    if (req.method === 'POST' && url.pathname.startsWith('/api/uploads/') && url.pathname.endsWith('/finish')) {
      const id = url.pathname.split('/')[3];
      if (!safeId(id)) return send(res, 400, { error: 'Invalid upload.' });
      const dir = path.join(TEMP, id); let manifest;
      try { manifest = JSON.parse(await fs.readFile(path.join(dir, 'manifest.json'), 'utf8')); } catch { return send(res, 404, { error: 'Upload session not found.' }); }
      const target = path.join(VIDEOS, `${id}${manifest.ext}`); const output = await fs.open(target, 'w'); let total = 0;
      try {
        for (let i = 0; i < manifest.chunks; i++) {
          const part = await fs.readFile(path.join(dir, `${i}.part`)); total += part.length; await output.write(part);
        }
        if (total !== manifest.size) throw new Error('Uploaded file size does not match the original.');
      } catch (error) { await output.close(); await fs.rm(target, { force: true }); return send(res, 400, { error: error.message || 'Upload is incomplete.' }); }
      await output.close();
      const episodes = await readEpisodes();
      const record = { id, season: manifest.season, episode: manifest.episode, title: manifest.title || `Episode ${manifest.episode}`, fileName: manifest.originalName, size: total, addedAt: new Date().toISOString() };
      const existing = episodes.findIndex(item => item.season === record.season && item.episode === record.episode);
      if (existing >= 0) { const old = episodes[existing]; await fs.rm(path.join(VIDEOS, `${old.id}${path.extname(old.fileName).toLowerCase()}`), { force: true }); episodes.splice(existing, 1); }
      episodes.push(record); await saveEpisodes(episodes); await fs.rm(dir, { recursive: true, force: true });
      return send(res, 201, record);
    }
    const videoMatch = url.pathname.match(/^\/api\/videos\/([a-f0-9-]{36})$/);
    if (req.method === 'GET' && videoMatch) {
      const item = (await readEpisodes()).find(ep => ep.id === videoMatch[1]);
      if (!item) return send(res, 404, { error: 'Episode not found.' });
      const file = path.join(VIDEOS, `${item.id}${path.extname(item.fileName).toLowerCase()}`);
      const stat = await fs.stat(file); const range = req.headers.range;
      const headers = { 'Content-Type': MIME[path.extname(file).toLowerCase()], 'Accept-Ranges': 'bytes', 'X-Content-Type-Options': 'nosniff' };
      if (range) {
        const match = /^bytes=(\d*)-(\d*)$/.exec(range);
        if (!match) { res.writeHead(416, { 'Content-Range': `bytes */${stat.size}` }); return res.end(); }
        const start = match[1] ? Number(match[1]) : Math.max(0, stat.size - Number(match[2]));
        const end = match[2] && match[1] ? Math.min(Number(match[2]), stat.size - 1) : stat.size - 1;
        if (start > end || start >= stat.size) { res.writeHead(416, { 'Content-Range': `bytes */${stat.size}` }); return res.end(); }
        res.writeHead(206, { ...headers, 'Content-Length': end - start + 1, 'Content-Range': `bytes ${start}-${end}/${stat.size}` });
        return fs.createReadStream(file, { start, end }).pipe(res);
      }
      res.writeHead(200, { ...headers, 'Content-Length': stat.size }); return fs.createReadStream(file).pipe(res);
    }
    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
      return send(res, 200, await fs.readFile(path.join(ROOT, 'index.html'), 'utf8'), 'text/html; charset=utf-8');
    }
    if (req.method === 'GET' && url.pathname === '/style.css') return send(res, 200, await fs.readFile(path.join(ROOT, 'style.css'), 'utf8'), 'text/css; charset=utf-8');
    if (req.method === 'GET' && url.pathname === '/app.js') return send(res, 200, await fs.readFile(path.join(ROOT, 'app.js'), 'utf8'), 'text/javascript; charset=utf-8');
    send(res, 404, { error: 'Not found.' });
  } catch (error) {
    if (!res.headersSent) send(res, error.status || 500, { error: error.status ? error.message : 'The server could not complete that request.' });
    else res.destroy();
  }
});

prepare().then(() => server.listen(PORT, () => console.log(`Episode Library is running at http://localhost:${PORT}`))).catch(error => { console.error(error); process.exit(1); });
