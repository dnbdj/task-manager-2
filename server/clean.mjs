// Task Manager 2 - the Clean dropdown.
//
// Five categories, each with a tickbox, in the style of the memory-cleaner
// utilities: CPU, GPU, RAM, Internet, Storage. Everything here is reversible
// cache or paging work except CPU, which is the one category that ends
// processes - and that is handed back to the reviewed process list instead of
// being done silently here.

import { readdir, stat, unlink } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getSnapshot, sampleNow, runPowerShell } from './win.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const TRIM_PS = path.join(here, '..', 'scripts', 'trim.ps1');

const MB = 1024 * 1024;
const MAX_WALK_FILES = 6000;

const env = process.env;

function gpuCacheDirs() {
  const local = env.LOCALAPPDATA;
  if (!local) return [];
  return [
    path.join(local, 'D3DSCache'),
    path.join(local, 'NVIDIA', 'DXCache'),
    path.join(local, 'NVIDIA', 'GLCache'),
    path.join(local, 'AMD', 'DxCache'),
    path.join(local, 'AMD', 'DxcCache'),
    path.join(local, 'Intel', 'ShaderCache'),
  ];
}

function storageDirs() {
  const dirs = [];
  if (env.TEMP) dirs.push(env.TEMP);
  if (env.SystemRoot) dirs.push(path.join(env.SystemRoot, 'Temp'));
  return Array.from(new Set(dirs));
}

const isInside = (file, roots) => roots.some((root) => {
  const rel = path.relative(root, file);
  return rel && !rel.startsWith('..') && !path.isAbsolute(rel);
});

async function collectFiles(root, { olderThanMs = 0, budget = MAX_WALK_FILES } = {}) {
  const found = [];
  const stack = [root];
  let seen = 0;
  while (stack.length && seen < budget) {
    const dir = stack.pop();
    let entries;
    try {
      // eslint-disable-next-line no-await-in-loop
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
        continue;
      }
      if (!entry.isFile()) continue;
      seen += 1;
      if (seen > budget) break;
      try {
        // eslint-disable-next-line no-await-in-loop
        const info = await stat(full);
        if (olderThanMs && Date.now() - info.mtimeMs < olderThanMs) continue;
        found.push({ path: full, size: info.size, mtime: info.mtimeMs });
      } catch {
        // vanished between readdir and stat
      }
    }
  }
  return found;
}

function ramCandidates(snapshot) {
  return snapshot.processes.filter((p) => (
    !p.window
    && p.cpu < 1
    && p.ws > 40 * MB
    && p.protection.killable
    && p.protection.tier !== 'critical'
    && p.protection.tier !== 'blocked'
    && p.session !== 0
    && p.pid !== process.pid
    && p.pid !== process.ppid
  ));
}

function cpuCandidates(snapshot) {
  return snapshot.processes.filter((p) => (
    !p.window
    && p.cpu >= 2
    && p.protection.killable
    && p.session !== 0
    && p.pid !== process.pid
    && p.pid !== process.ppid
  ));
}

const totalBytes = (files) => files.reduce((sum, f) => sum + f.size, 0);

/** What each ticked category would do, without doing it. */
export async function previewClean() {
  const snapshot = await getSnapshot();

  const ram = ramCandidates(snapshot);
  const cpu = cpuCandidates(snapshot);

  const gpuFiles = [];
  for (const dir of gpuCacheDirs()) {
    // eslint-disable-next-line no-await-in-loop
    gpuFiles.push(...await collectFiles(dir, { budget: 2000 }));
  }

  const storageFiles = [];
  for (const dir of storageDirs()) {
    // eslint-disable-next-line no-await-in-loop
    storageFiles.push(...await collectFiles(dir, { olderThanMs: 24 * 60 * 60 * 1000, budget: 4000 }));
  }

  return {
    ram: { count: ram.length, bytes: totalBytes(ram.map((p) => ({ size: p.ws }))) },
    cpu: { count: cpu.length, processes: cpu.slice(0, 12).map((p) => ({ pid: p.pid, name: p.name, cpu: p.cpu })) },
    gpu: { files: gpuFiles.length, bytes: totalBytes(gpuFiles), dirs: gpuCacheDirs().filter(Boolean) },
    internet: { available: true, note: 'Flushes the DNS resolver cache. Nothing is deleted.' },
    storage: { files: storageFiles.length, bytes: totalBytes(storageFiles), dirs: storageDirs() },
  };
}

async function cleanRam() {
  const before = new Map();
  const candidates = ramCandidates(await getSnapshot());
  for (const proc of candidates) before.set(proc.pid, proc.ws);
  if (!candidates.length) return { trimmed: 0, failed: 0, freedBytes: 0 };

  let ok = 0;
  let failed = 0;
  try {
    const out = await runPowerShell(['-File', TRIM_PS, '-Pids', candidates.map((p) => p.pid).join(',')], { timeout: 30000 });
    const parsed = JSON.parse(String(out).replace(/^\uFEFF/, '').trim() || '{}');
    ok = Number(parsed.ok) || 0;
    failed = Number(parsed.failed) || 0;
  } catch {
    failed = candidates.length;
  }

  // Measure instead of guessing: compare working sets after a fresh sample.
  const after = await sampleNow();
  let freed = 0;
  if (after?.processes) {
    for (const proc of after.processes) {
      const was = before.get(proc.pid);
      if (was && was > proc.ws) freed += was - proc.ws;
    }
  }

  return { trimmed: ok, failed, freedBytes: freed };
}

async function cleanGpu() {
  const dirs = gpuCacheDirs();
  const files = [];
  for (const dir of dirs) {
    // eslint-disable-next-line no-await-in-loop
    files.push(...await collectFiles(dir, { budget: 3000 }));
  }
  let removed = 0;
  let failed = 0;
  let bytes = 0;
  for (const file of files) {
    try {
      // eslint-disable-next-line no-await-in-loop
      await unlink(file.path);
      removed += 1;
      bytes += file.size;
    } catch {
      failed += 1; // in use by the driver; Windows will reuse it
    }
  }
  return { files: removed, failed, freedBytes: bytes };
}

async function cleanStorage() {
  const roots = storageDirs();
  const files = [];
  for (const dir of roots) {
    // eslint-disable-next-line no-await-in-loop
    files.push(...await collectFiles(dir, { olderThanMs: 24 * 60 * 60 * 1000, budget: 4000 }));
  }
  let removed = 0;
  let failed = 0;
  let bytes = 0;
  for (const file of files) {
    // Defence in depth: never unlink anything outside the temp roots, even if
    // the walk produced something unexpected.
    if (!isInside(file.path, roots)) continue;
    try {
      // eslint-disable-next-line no-await-in-loop
      await unlink(file.path);
      removed += 1;
      bytes += file.size;
    } catch {
      failed += 1; // still open in some app
    }
  }
  return { files: removed, failed, freedBytes: bytes };
}

async function cleanInternet() {
  try {
    await runPowerShell(['-Command', 'Clear-DnsClientCache; "ok"'], { timeout: 20000 });
    return { flushed: true };
  } catch {
    try {
      await runPowerShell(['-Command', 'ipconfig /flushdns | Out-Null; "ok"'], { timeout: 20000 });
      return { flushed: true };
    } catch (error) {
      return { flushed: false, error: error.message };
    }
  }
}

const ALLOWED = new Set(['ram', 'gpu', 'internet', 'storage']);

/** Run the ticked categories. CPU is deliberately not accepted here. */
export async function runClean({ categories }) {
  const wanted = (categories || []).filter((c) => ALLOWED.has(c));
  if (!wanted.length) {
    const error = new Error('Tick at least one category. CPU cleaning runs through the process list.');
    error.status = 400;
    throw error;
  }

  const results = {};
  let freedBytes = 0;

  if (wanted.includes('ram')) {
    results.ram = await cleanRam();
    freedBytes += results.ram.freedBytes;
  }
  if (wanted.includes('gpu')) {
    results.gpu = await cleanGpu();
    freedBytes += results.gpu.freedBytes;
  }
  if (wanted.includes('storage')) {
    results.storage = await cleanStorage();
    freedBytes += results.storage.freedBytes;
  }
  if (wanted.includes('internet')) {
    results.internet = await cleanInternet();
  }

  return { ok: true, categories: wanted, freedBytes, results };
}
