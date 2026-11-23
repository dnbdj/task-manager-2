// Task Manager 2 - Windows process data layer.
//
// A single long-lived PowerShell host answers snapshot/detail commands over
// stdin so the WMI providers stay warm and the app can poll without spawning a
// process every time. The HTTP layer never talks to PowerShell directly: a
// background sampler fills a cache and the UI reads that.

import { spawn, execFile } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { classify, isBlocked } from './protection.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const SCRIPTS = path.join(here, '..', 'scripts');

const POWERSHELL = process.env.SystemRoot
  ? path.join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  : 'powershell.exe';

export const IS_WINDOWS = process.platform === 'win32';

// ------------------------------------------------------------------- host ----

let host = null;
let hostReady = null;
let buffer = '';
let pending = null;
let elevatedSelf = null;
let lastSampleError = null;

function failPending(error) {
  if (pending) {
    const { reject, timer } = pending;
    pending = null;
    clearTimeout(timer);
    reject(error);
  }
}

function ensureHost() {
  if (host && !host.killed && hostReady) return hostReady;

  hostReady = new Promise((resolve, reject) => {
    const child = spawn(
      POWERSHELL,
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File',
        path.join(SCRIPTS, 'host.ps1'), '-Collector', path.join(SCRIPTS, 'collect.ps1')],
      { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] },
    );
    host = child;
    buffer = '';

    const startedAt = Date.now();
    let settled = false;
    const startupTimer = setTimeout(() => {
      if (settled) return;
      settled = true;
      failPending(new Error('The PowerShell sampler did not start in time.'));
      try { child.kill(); } catch {}
      host = null;
      hostReady = null;
      reject(new Error('PowerShell sampler startup timed out.'));
    }, 25000);

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      buffer += chunk;
      let index;
      while ((index = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, index).replace(/\r$/, '');
        buffer = buffer.slice(index + 1);
        if (line.startsWith('@@R@@')) {
          if (settled) continue;
          settled = true;
          clearTimeout(startupTimer);
          resolve(child);
          continue;
        }
        if (line.startsWith('@@J@@')) {
          const body = line.slice(5);
          if (pending) {
            const { resolve: ok, timer } = pending;
            pending = null;
            clearTimeout(timer);
            try { ok(JSON.parse(body)); } catch (error) { ok({ ok: false, error: `Bad JSON from sampler: ${error.message}` }); }
          }
        } else if (line.startsWith('@@E@@')) {
          if (pending) {
            const { reject: bad, timer } = pending;
            pending = null;
            clearTimeout(timer);
            bad(new Error(line.slice(5) || 'Sampler error.'));
          }
        }
      }
    });

    child.stderr.setEncoding('utf8');
    child.stderr.on('data', () => {});

    const teardown = (reason) => {
      if (host === child) {
        host = null;
        hostReady = null;
      }
      failPending(new Error(reason));
      if (!settled) {
        settled = true;
        clearTimeout(startupTimer);
        reject(new Error(reason));
      }
    };
    child.on('error', (error) => teardown(`Could not start PowerShell: ${error.message}`));
    child.on('exit', (code) => {
      if (Date.now() - startedAt < 1000 && code && code !== 0) {
        teardown(`PowerShell sampler exited with code ${code}.`);
      } else {
        teardown('The PowerShell sampler stopped. It will restart on the next sample.');
      }
    });
  });

  return hostReady;
}

function request(command, { timeout = 30000 } = {}) {
  return ensureHost().then((child) => new Promise((resolve, reject) => {
    if (pending) {
      reject(new Error('Sampler is busy.'));
      return;
    }
    const timer = setTimeout(() => {
      failPending(new Error(`Sampler timed out on "${command.split(' ')[0]}".`));
      try { child.kill(); } catch {}
      host = null;
      hostReady = null;
    }, timeout);
    pending = { resolve, reject, timer };
    try {
      child.stdin.write(`${command}\n`);
    } catch (error) {
      clearTimeout(timer);
      pending = null;
      reject(error);
    }
  }));
}

async function legacySnapshot() {
  // Fallback path for the one-shot script if the host cannot be used.
  return new Promise((resolve, reject) => {
    execFile(
      POWERSHELL,
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(SCRIPTS, 'snapshot.ps1'), '-Counters', '1'],
      { windowsHide: true, timeout: 60000, maxBuffer: 64 * 1024 * 1024, encoding: 'utf8' },
      (error, stdout, stderr) => {
        if (error) return reject(new Error(`${error.message}${stderr ? ` :: ${String(stderr).trim()}` : ''}`));
        try {
          resolve(JSON.parse(String(stdout).replace(/^\uFEFF/, '').trim()));
        } catch (parseError) {
          reject(new Error(`Could not parse the collector output: ${parseError.message}`));
        }
      },
    );
  });
}

export async function isElevated() {
  if (elevatedSelf !== null) return elevatedSelf;
  try {
    const out = await request('elevated', { timeout: 15000 });
    elevatedSelf = Boolean(out?.elevated);
  } catch {
    elevatedSelf = false;
  }
  return elevatedSelf;
}

// --------------------------------------------------------------- enrichment --

const round = (value, digits = 1) => {
  const f = 10 ** digits;
  return Math.round(value * f) / f;
};

let previousCpu = new Map();

// Perf counters are the slowest part of a sample, so they are collected every
// third cycle. The last real reading is kept so a cycle without counters never
// shows a blank gauge.
export const lastCounters = { cpu: null, disk: null };

/** Validate, then merge parent/child context and CPU deltas into the raw dump. */
export function enrich(raw, { elevated = false } = {}) {
  const now = Date.now();
  const cores = Math.max(1, raw.os?.cores || 1);
  const totalRam = raw.memory?.total || 0;

  const processes = Array.isArray(raw.processes) ? raw.processes : [];
  const byPid = new Map();
  const parentOf = new Map();
  for (const p of processes) {
    byPid.set(p.pid, p);
    parentOf.set(p.pid, p.parent);
  }

  const childCount = new Map();
  for (const p of processes) {
    if (p.parent && p.parent !== p.pid) {
      childCount.set(p.parent, (childCount.get(p.parent) || 0) + 1);
    }
  }

  const depthCache = new Map();
  const depthOf = (pid) => {
    if (depthCache.has(pid)) return depthCache.get(pid);
    let depth = 0;
    let current = pid;
    const seen = new Set([pid]);
    while (depth < 32) {
      const parent = parentOf.get(current);
      if (!parent || seen.has(parent)) break;
      seen.add(parent);
      current = parent;
      depth += 1;
    }
    depthCache.set(pid, depth);
    return depth;
  };

  const nextCpu = new Map();
  const enriched = processes.map((p) => {
    const prev = previousCpu.get(p.pid);
    let cpuPercent = 0;
    if (prev && p.start === prev.start) {
      const elapsed = (now - prev.at) / 1000;
      if (elapsed > 0.15) {
        cpuPercent = ((p.cpuSeconds - prev.seconds) / elapsed / cores) * 100;
      }
    } else if (p.start) {
      // First sighting: show the lifetime average so the column is not all
      // zeroes on the very first paint.
      const ageSec = (now - Date.parse(p.start)) / 1000;
      if (ageSec > 1) cpuPercent = (p.cpuSeconds / ageSec / cores) * 100;
    }
    if (!Number.isFinite(cpuPercent) || cpuPercent < 0) cpuPercent = 0;
    cpuPercent = Math.min(cpuPercent, 100);
    nextCpu.set(p.pid, { seconds: p.cpuSeconds, at: now, start: p.start });

    const parent = byPid.get(p.parent);
    const kids = childCount.get(p.pid) || 0;

    return {
      ...p,
      cpu: round(cpuPercent, 2),
      cpuMs: Math.round((p.cpuSeconds || 0) * 1000),
      memPercent: totalRam ? round((p.ws / totalRam) * 100, 2) : 0,
      parentName: parent ? parent.name : '',
      parentAlive: Boolean(parent),
      childCount: kids,
      depth: depthOf(p.pid),
      status: p.responding === false ? 'Not responding' : 'Running',
      protection: classify(p, { children: kids, elevatedSelf: elevated }),
    };
  });
  previousCpu = nextCpu;

  enriched.sort((a, b) => b.ws - a.ws);

  const used = totalRam - (raw.memory?.free || 0);
  const cpuSum = enriched.reduce((sum, p) => sum + p.cpu, 0);

  const cpuCounter = Number(raw.load?.cpu);
  const diskCounter = Number(raw.load?.disk);
  if (Number.isFinite(cpuCounter) && cpuCounter >= 0) lastCounters.cpu = cpuCounter;
  if (Number.isFinite(diskCounter) && diskCounter >= 0) lastCounters.disk = diskCounter;

  return {
    ok: true,
    sampledAt: raw.sampledAt,
    host: raw.host,
    user: raw.user,
    platform: process.platform,
    elevated: Boolean(elevated),
    os: raw.os,
    memory: {
      total: totalRam,
      free: raw.memory?.free || 0,
      used,
      percent: totalRam ? round((used / totalRam) * 100, 1) : 0,
    },
    load: {
      cpu: lastCounters.cpu != null ? round(lastCounters.cpu, 1) : round(cpuSum, 1),
      disk: lastCounters.disk != null ? round(Math.min(lastCounters.disk, 100), 1) : null,
      cpuFromCounters: lastCounters.cpu != null,
      processCpuSum: round(cpuSum, 1),
    },
    counts: {
      processes: enriched.length,
      threads: enriched.reduce((sum, p) => sum + p.threads, 0),
      handles: enriched.reduce((sum, p) => sum + p.handles, 0),
      withWindow: enriched.filter((p) => p.window).length,
      hidden: 0,
    },
    processes: enriched,
  };
}

export async function collectOnce({ counters = true } = {}) {
  const elevated = await isElevated();
  try {
    const raw = await request(counters ? 'snapshot counters=1' : 'snapshot counters=0');
    if (!raw || raw.ok !== true) throw new Error(raw?.error || 'Sampler returned no data.');
    return { snapshot: enrich(raw, { elevated }), raw };
  } catch (error) {
    // If the host is wedged, fall back to the one-shot collector before giving
    // up: a stale-but-working app beats an empty one.
    try {
      const raw = await legacySnapshot();
      return { snapshot: enrich(raw, { elevated }), raw };
    } catch {
      throw error;
    }
  }
}

// ----------------------------------------------------------------- sampler ---

const state = {
  latest: null,
  latestRaw: null,
  at: 0,
  error: null,
  interval: Number(process.env.TM2_INTERVAL || 3000),
  running: false,
  cycles: 0,
};

let queue = Promise.resolve();

export function sampleNow() {
  queue = queue.then(async () => {
    try {
      // Force counters while any gauge is still unknown, so the first paint
      // always has a real disk number rather than a dash.
      const needCounters = state.cycles % 3 === 0 || lastCounters.cpu == null || lastCounters.disk == null;
      const { snapshot, raw } = await collectOnce({ counters: needCounters });
      state.latest = snapshot;
      state.latestRaw = raw;
      state.at = Date.now();
      state.error = null;
      state.cycles += 1;
      elevatedSelf = snapshot.elevated;
    } catch (error) {
      state.error = error.message;
      state.cycles += 1;
    }
    return state.latest;
  });
  return queue;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function startSampler() {
  if (state.running) return;
  state.running = true;
  (async () => {
    while (state.running) {
      const started = Date.now();
      await sampleNow();
      const spent = Date.now() - started;
      await sleep(Math.max(250, state.interval - spent));
    }
  })();
}

export function stopSampler() {
  state.running = false;
  if (host) {
    try { host.stdin.write('quit\n'); } catch {}
    try { host.kill(); } catch {}
  }
}

export function getStatus() {
  return {
    ready: Boolean(state.latest),
    age: state.at ? Date.now() - state.at : null,
    error: state.error,
    interval: state.interval,
    elevated: Boolean(elevatedSelf),
  };
}

export function getLatest() {
  return state.latest;
}

function waitForFirst() {
  return new Promise((resolve, reject) => {
    if (state.latest) return resolve(state.latest);
    const started = Date.now();
    const timer = setInterval(() => {
      if (state.latest) {
        clearInterval(timer);
        resolve(state.latest);
      } else if (Date.now() - started > 40000) {
        clearInterval(timer);
        reject(new Error(state.error || 'The sampler did not produce a snapshot in time.'));
      }
    }, 150);
  });
}

export async function getSnapshot() {
  if (!IS_WINDOWS) {
    throw Object.assign(
      new Error('Task Manager 2 reads live process data through Windows PowerShell, so it only runs on Windows.'),
      { status: 501 },
    );
  }
  if (state.latest) return state.latest;
  await sampleNow();
  return waitForFirst();
}

export async function getDetail(pid) {
  const out = await request(`detail pid=${Number(pid) || 0}`, { timeout: 20000 });
  if (!out || out.ok !== true) {
    throw Object.assign(new Error(out?.error || `Process ${pid} is no longer running.`), { status: 404 });
  }
  return out;
}

// -------------------------------------------------------------------- kills --

function collectDescendants(pid, snapshot) {
  const childrenOf = new Map();
  for (const p of snapshot.processes) {
    if (!childrenOf.has(p.parent)) childrenOf.set(p.parent, []);
    childrenOf.get(p.parent).push(p);
  }
  const out = [];
  const seen = new Set();
  const walk = (parent, generation) => {
    for (const child of childrenOf.get(parent) || []) {
      if (seen.has(child.pid)) continue;
      seen.add(child.pid);
      out.push({ ...child, generation });
      walk(child.pid, generation + 1);
    }
  };
  walk(pid, 1);
  return out;
}

/**
 * End processes. Every PID is re-validated against the protection table on the
 * server, so a stale or hand-crafted request cannot take down lsass.
 */
export async function endProcesses({ pids, tree = false, acknowledged = false, confirmations = {} }) {
  const requested = Array.from(new Set((pids || []).map(Number).filter((n) => Number.isInteger(n) && n > 0)));
  if (!requested.length) throw badRequest('No process IDs supplied.');
  if (requested.includes(process.pid) || requested.includes(process.ppid)) {
    throw badRequest('Task Manager 2 refuses to end its own process.');
  }

  const snapshot = await getSnapshot();
  const byPid = new Map(snapshot.processes.map((p) => [p.pid, p]));

  const missing = [];
  const targets = [];
  for (const pid of requested) {
    const proc = byPid.get(pid);
    if (!proc) { missing.push(pid); continue; }
    targets.push({ proc, origin: 'requested' });
  }

  if (tree) {
    for (const { proc } of [...targets]) {
      for (const child of collectDescendants(proc.pid, snapshot)) {
        if (!targets.some((t) => t.proc.pid === child.pid)) {
          targets.push({ proc: byPid.get(child.pid) || child, origin: 'tree' });
        }
      }
    }
  }

  const refused = [];
  const allowed = [];
  const skippedTree = [];
  for (const { proc, origin } of targets) {
    if (proc.pid === process.pid || proc.pid === process.ppid) {
      refused.push({ pid: proc.pid, name: proc.name, reason: 'That is Task Manager 2 itself.' });
      continue;
    }
    if (isBlocked(proc)) {
      if (origin === 'tree') {
        skippedTree.push({ pid: proc.pid, name: proc.name, reason: 'Protected Windows process, left running.' });
        continue;
      }
      refused.push({ pid: proc.pid, name: proc.name, reason: proc.protection.note || 'This process is protected.' });
      continue;
    }
    if (proc.protection.requiresTyping) {
      const expected = String(confirmations[proc.pid] ?? confirmations[String(proc.pid)] ?? '').trim();
      const word = proc.protection.confirmWord || proc.name;
      if (expected.toLowerCase() !== String(word).toLowerCase()) {
        refused.push({ pid: proc.pid, name: proc.name, reason: `Type "${word}" to confirm ending a critical process.` });
        continue;
      }
    }
    allowed.push(proc);
  }

  if (refused.length) {
    const error = new Error('Refused: ' + refused.map((r) => `${r.name} (${r.pid}) - ${r.reason}`).join('; '));
    error.status = 403;
    error.details = { refused, skippedTree, missing };
    throw error;
  }
  if (allowed.length && !acknowledged) throw badRequest('Acknowledgment is required before ending processes.');
  if (!allowed.length) return { ok: true, ended: [], failed: [], skippedTree, missing, freedBytes: 0 };

  // Children first, so nothing is re-spawned by a dying parent.
  const ordered = allowed.slice().sort((a, b) => b.depth - a.depth);
  const idList = ordered.map((p) => p.pid).join(',');
  const script = [
    '$ErrorActionPreference="SilentlyContinue";',
    '$out=@();',
    `foreach($id in @(${idList})){`,
    'try{ Stop-Process -Id $id -Force -ErrorAction Stop; $out += [pscustomobject]@{pid=[int]$id;ok=$true;error=""} }',
    'catch{ $out += [pscustomobject]@{pid=[int]$id;ok=$false;error=$_.Exception.Message} }',
    '};',
    '$out | ConvertTo-Json -Compress',
  ].join(' ');

  let results = [];
  try {
    const stdout = await new Promise((resolve, reject) => {
      execFile(POWERSHELL, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
        { windowsHide: true, timeout: 30000, encoding: 'utf8' },
        (error, out, err) => (error ? reject(new Error(err || error.message)) : resolve(out)));
    });
    const trimmed = String(stdout).replace(/^\uFEFF/, '').trim();
    if (trimmed) {
      const parsed = JSON.parse(trimmed);
      results = Array.isArray(parsed) ? parsed : [parsed];
    }
  } catch (error) {
    throw new Error(`Windows rejected the request: ${error.message}`);
  }

  const okPids = new Set(results.filter((r) => r.ok).map((r) => Number(r.pid)));
  const failures = results.filter((r) => !r.ok);

  // Force the next sample to reflect reality straight away.
  previousCpu = new Map();
  await sampleNow();

  return {
    ok: true,
    ended: ordered
      .filter((p) => okPids.has(p.pid))
      .map((p) => ({ pid: p.pid, name: p.name, memory: p.ws })),
    failed: failures.map((f) => {
      const proc = byPid.get(Number(f.pid));
      return {
        pid: Number(f.pid),
        name: proc?.name || 'unknown',
        error: f.error || 'Access denied.',
        hint: /access|denied/i.test(f.error || '')
          ? 'Windows only lets an elevated app end processes it does not own. Restart Task Manager 2 as administrator.'
          : 'The process probably exited on its own.',
      };
    }),
    skippedTree,
    missing,
    freedBytes: ordered.filter((p) => okPids.has(p.pid)).reduce((sum, p) => sum + p.ws, 0),
  };
}

function badRequest(message) {
  const error = new Error(message);
  error.status = 400;
  return error;
}
