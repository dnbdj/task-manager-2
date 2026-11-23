// Task Manager 2 - local API server.
// Binds to loopback only and requires a per-launch token on every API call, so
// no other page or process on the machine can drive the kill endpoints.

import http from 'node:http';
import os from 'node:os';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import {
  getSnapshot, getDetail, getStatus, getLatest, startSampler, stopSampler,
  collectOnce, endProcesses, IS_WINDOWS,
} from './win.mjs';
import { buildQuickClean } from './quickclean.mjs';
import { previewClean, runClean } from './clean.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(here, '..', 'public');

const HOST = '127.0.0.1';
const TOKEN = process.env.TM2_TOKEN || crypto.randomBytes(18).toString('hex');
let port = Number(process.env.TM2_PORT || 4719);

const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

const STATIC_FILES = new Set(['/app.js', '/styles.css', '/favicon.svg']);

function json(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

function readBody(req, limit = 512 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(Object.assign(new Error('Request body too large.'), { status: 413 }));
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
        reject(Object.assign(new Error('Body must be JSON.'), { status: 400 }));
      }
    });
    req.on('error', reject);
  });
}

function authorised(req) {
  const supplied = String(req.headers['x-tm2-token'] || '');
  if (supplied.length !== TOKEN.length) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(supplied), Buffer.from(TOKEN));
  } catch {
    return false;
  }
}

function sameOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return true; // non-browser client that already holds the token
  try {
    const url = new URL(origin);
    return (url.hostname === '127.0.0.1' || url.hostname === 'localhost') && url.port === String(port);
  } catch {
    return false;
  }
}

async function serveStatic(res, pathname) {
  const file = pathname === '/' ? 'index.html' : pathname.slice(1);
  const full = path.join(PUBLIC_DIR, file);
  if (!full.startsWith(PUBLIC_DIR)) {
    res.writeHead(403, { 'content-type': 'text/plain' }).end('Forbidden');
    return;
  }
  try {
    let body = await readFile(full);
    if (file === 'index.html') {
      body = Buffer.from(body.toString('utf8').replaceAll('__TM2_TOKEN__', TOKEN));
    }
    res.writeHead(200, {
      'content-type': CONTENT_TYPES[path.extname(full)] || 'application/octet-stream',
      'cache-control': 'no-store',
    });
    res.end(body);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain' }).end('Not found');
  }
}

// ---------------------------------------------------------- fast samples --
// The process snapshot is expensive (WMI over hundreds of processes) and only
// runs every few seconds. System CPU and memory come straight from the OS, so
// they are sampled here at 100 Hz and handed to the graphs as a dense series.

const FAST_INTERVAL_MS = Number(process.env.TM2_FAST_MS || 10);
const FAST_RETENTION_MS = 10 * 60 * 1000;
const FAST_MAX = 62000;
// Windows only advances its CPU counters about every 15 ms, so comparing two
// reads 10 ms apart would alternate between 0% and 100%. Each reading is
// compared against one about 100 ms old instead, which is both smooth and
// still far faster than the eye or the display can follow.
const FAST_LAG_TICKS = 10;

const fast = { samples: [], cursor: [], timer: null };

function readCpuTimes() {
  let idle = 0;
  let total = 0;
  for (const cpu of os.cpus()) {
    const times = cpu.times;
    idle += times.idle;
    total += times.user + times.nice + times.sys + times.idle + times.irq;
  }
  return { idle, total };
}

function fastTick() {
  const now = Date.now();
  const reading = { t: now, ...readCpuTimes() };
  fast.cursor.push(reading);
  while (fast.cursor.length > FAST_LAG_TICKS + 2) fast.cursor.shift();

  const base = fast.cursor[0];
  const deltaTotal = reading.total - base.total;
  const deltaIdle = reading.idle - base.idle;
  const cpu = deltaTotal > 0 ? Math.min(100, Math.max(0, (1 - deltaIdle / deltaTotal) * 100)) : 0;

  const totalMem = os.totalmem();
  const used = totalMem - os.freemem();
  const ram = totalMem > 0 ? (used / totalMem) * 100 : 0;

  fast.samples.push({ t: now, cpu: Math.round(cpu * 10) / 10, ram: Math.round(ram * 10) / 10 });

  const cutoff = now - FAST_RETENTION_MS;
  while (fast.samples.length && (fast.samples[0].t < cutoff || fast.samples.length > FAST_MAX)) {
    fast.samples.shift();
  }
}

function startFastSampler() {
  if (fast.timer) return;
  fast.cursor = [{ t: Date.now(), ...readCpuTimes() }, { t: Date.now(), ...readCpuTimes() }];
  fast.timer = setInterval(fastTick, FAST_INTERVAL_MS);
}

startFastSampler();

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || `${HOST}:${port}`}`);
  const pathname = decodeURIComponent(url.pathname);

  try {
    if (req.method === 'GET' && (pathname === '/' || STATIC_FILES.has(pathname))) {
      return await serveStatic(res, pathname);
    }

    if (!pathname.startsWith('/api/')) {
      res.writeHead(404, { 'content-type': 'text/plain' }).end('Not found');
      return;
    }

    if (!authorised(req)) {
      return json(res, 401, { ok: false, error: 'Missing session token. Reload Task Manager 2.' });
    }
    if (req.method !== 'GET' && !sameOrigin(req)) {
      return json(res, 403, { ok: false, error: 'Cross-origin request refused.' });
    }

    if (req.method === 'GET' && pathname === '/api/health') {
      return json(res, 200, { ok: true, windows: IS_WINDOWS, port, pid: process.pid, ...getStatus() });
    }

    if (req.method === 'GET' && pathname === '/api/samples') {
      const since = Number(url.searchParams.get('since') || 0);
      const limit = since > 0 ? since : Date.now() - FAST_RETENTION_MS;
      const fresh = [];
      for (let i = fast.samples.length - 1; i >= 0; i -= 1) {
        if (fast.samples[i].t <= limit) break;
        fresh.push(fast.samples[i]);
      }
      fresh.reverse();
      return json(res, 200, {
        ok: true,
        now: Date.now(),
        interval: FAST_INTERVAL_MS,
        buffered: fast.samples.length,
        samples: fresh,
      });
    }

    if (req.method === 'GET' && pathname === '/api/snapshot') {
      const snapshot = await getSnapshot();
      return json(res, 200, { ...snapshot, sampler: getStatus() });
    }

    if (req.method === 'GET' && pathname === '/api/quickclean') {
      const snapshot = await getSnapshot();
      return json(res, 200, { ok: true, ...buildQuickClean(snapshot) });
    }

    if (req.method === 'GET' && pathname === '/api/clean/preview') {
      return json(res, 200, { ok: true, ...(await previewClean()) });
    }

    if (req.method === 'POST' && pathname === '/api/clean') {
      const body = await readBody(req);
      return json(res, 200, await runClean(body));
    }

    if (req.method === 'GET' && pathname.startsWith('/api/process/')) {
      const pid = Number(pathname.split('/').pop());
      if (!Number.isInteger(pid) || pid <= 0) return json(res, 400, { ok: false, error: 'Bad PID.' });
      return json(res, 200, { ok: true, detail: await getDetail(pid) });
    }

    if (req.method === 'GET' && pathname === '/api/report') {
      const { snapshot } = await collectOnce({ counters: true });
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      res.setHeader('content-disposition', `attachment; filename="task-manager-2-report-${stamp}.json"`);
      return json(res, 200, {
        app: 'Task Manager 2',
        version: '1.6.0-beta.1',
        generatedAt: new Date().toISOString(),
        note: 'Complete process list. Nothing is filtered out of this report.',
        snapshot,
      });
    }

    if (req.method === 'POST' && pathname === '/api/kill') {
      const body = await readBody(req);
      const result = await endProcesses({
        pids: body.pids,
        tree: Boolean(body.tree),
        acknowledged: Boolean(body.acknowledged),
        confirmations: body.confirmations || {},
      });
      return json(res, 200, result);
    }

    return json(res, 404, { ok: false, error: 'Unknown endpoint.' });
  } catch (error) {
    return json(res, error.status || 500, {
      ok: false,
      error: error.message || 'Unexpected error.',
      details: error.details || null,
    });
  }
});

function listen(attempt = 0) {
  server.once('error', (error) => {
    if (error.code === 'EADDRINUSE' && attempt < 12) {
      port += 1;
      listen(attempt + 1);
      return;
    }
    console.error(`[task-manager-2] could not bind: ${error.message}`);
    process.exit(1);
  });
  server.listen(port, HOST, () => {
    port = server.address().port;
    const url = `http://${HOST}:${port}`;
    console.log('');
    console.log('  Task Manager 2  -  beta 1.6');
    console.log(`  ${url}`);
    console.log(`  platform: ${process.platform}`);
    console.log('  Nothing is filtered. Every end request is re-checked server-side.');
    console.log('');
    if (!IS_WINDOWS) {
      console.log('  Warning: no Windows detected. Process data will be unavailable.');
    } else {
      startSampler();
    }
    if (process.env.TM2_OPEN === '1' && process.platform === 'win32') {
      import('node:child_process').then(({ spawn }) => {
        spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
      });
    }
    if (process.send) process.send({ type: 'ready', url });
    for (const signal of ['SIGINT', 'SIGTERM']) {
      process.on(signal, () => {
        stopSampler();
        server.close(() => process.exit(0));
        setTimeout(() => process.exit(0), 1500);
      });
    }
  });
}

listen();

export { server, getLatest };
