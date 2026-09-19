const http = require('http');
const fs = require('fs');
const path = require('path');

const licenseHandler = require('./api/license');
const stockHandler = require('./api/stock');

const ROOT = __dirname;
const PORT = Number(process.env.PORT) || 10000;
const MAX_BODY_BYTES = 2 * 1024 * 1024;
const SELF_PING_INTERVAL_MS = 15 * 1000;

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.mp3': 'audio/mpeg',
  '.mpeg': 'audio/mpeg',
  '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon'
};

function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store'
  });
  res.end(payload);
}

function responseAdapter(res) {
  let statusCode = 200;
  const headers = {};

  return {
    status(code) {
      statusCode = code;
      return this;
    },
    setHeader(name, value) {
      headers[name] = value;
    },
    json(body) {
      res.writeHead(statusCode, {
        ...headers,
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store'
      });
      res.end(JSON.stringify(body));
    },
    end(body = '') {
      res.writeHead(statusCode, headers);
      res.end(body);
    }
  };
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];

    req.on('data', chunk => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error('Request body is too large.'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(new Error('Request body must be valid JSON.'));
      }
    });
    req.on('error', reject);
  });
}

async function handleApi(req, res, pathname) {
  if (pathname !== '/api/license' && pathname !== '/api/stock') return false;

  if (req.method === 'POST') {
    try {
      req.body = await readBody(req);
    } catch (error) {
      return sendJson(res, 400, { error: error.message });
    }
  } else {
    req.body = {};
  }

  const handler = pathname === '/api/license' ? licenseHandler : stockHandler;
  try {
    await handler(req, responseAdapter(res));
  } catch (error) {
    console.error(`${pathname} failed:`, error);
    if (!res.headersSent) sendJson(res, 500, { error: 'Internal server error.' });
  }
  return true;
}

function serveStatic(req, res, pathname) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return sendJson(res, 405, { error: 'Use GET.' });
  }

  let relativePath;
  try {
    relativePath = decodeURIComponent(pathname === '/' ? '/index.html' : pathname);
  } catch {
    return sendJson(res, 400, { error: 'Invalid URL.' });
  }

  if (relativePath.includes('\0') || relativePath.includes('..') || relativePath.startsWith('/private/')) {
    return sendJson(res, 404, { error: 'Not found.' });
  }

  const filePath = path.join(ROOT, relativePath);
  if (!filePath.startsWith(ROOT + path.sep)) return sendJson(res, 404, { error: 'Not found.' });

  let stat;
  try {
    stat = fs.statSync(filePath);
  } catch {
    return sendJson(res, 404, { error: 'Not found.' });
  }
  if (!stat.isFile()) return sendJson(res, 404, { error: 'Not found.' });

  const headers = {
    'Content-Type': MIME_TYPES[path.extname(filePath).toLowerCase()] || 'application/octet-stream',
    'Cache-Control': path.extname(filePath) === '.html' ? 'no-cache' : 'public, max-age=3600'
  };
  res.writeHead(200, headers);
  if (req.method === 'HEAD') return res.end();
  fs.createReadStream(filePath).pipe(res);
}

function startSelfPing() {
  const baseUrl = String(process.env.RENDER_EXTERNAL_URL || `http://127.0.0.1:${PORT}`).replace(/\/$/, '');
  const ping = () => {
    fetch(`${baseUrl}/healthz`).catch(error => {
      console.warn(`Self-ping failed: ${error.message}`);
    });
  };

  ping();
  const timer = setInterval(ping, SELF_PING_INTERVAL_MS);
  timer.unref();
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = url.pathname.replace(/\/$/, '') || '/';

  if (pathname === '/healthz') return sendJson(res, 200, { ok: true });
  if (await handleApi(req, res, pathname)) return;
  serveStatic(req, res, pathname);
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Croma Stock Signal listening on port ${PORT}`);
  startSelfPing();
});
