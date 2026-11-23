// Task Manager 2 - Quick Clean engine.
//
// The point of Quick Clean is not to run a magic "optimiser". It is to put a
// short, explainable list on screen: what each candidate is, why it is safe to
// close, and how much memory it gives back. Nothing is killed until the user
// selects it and confirms.

const BROWSER = new Set(['chrome', 'msedge', 'firefox', 'brave', 'opera', 'vivaldi', 'arc']);
const BUILD_TOOL = new Set([
  'node', 'deno', 'bun', 'python', 'python3', 'pythonw', 'py', 'java', 'javaw', 'dotnet',
  'cargo', 'rustc', 'msbuild', 'vbcscompiler', 'git', 'vite', 'webpack', 'esbuild',
  'tsserver', 'typescript', 'watchman', 'gradle', 'mvn', 'code',
]);
const NEVER = new Set(['system', 'registry', 'memory compression', 'smss', 'csrss', 'wininit',
  'winlogon', 'services', 'lsass', 'svchost', 'fontdrvhost', 'dwm', 'explorer', 'sihost',
  'ctfmon', 'audiodg', 'msmpeng', 'task-manager-2', 'electron']);

const mb = (bytes) => Math.round((bytes / 1024 / 1024) * 10) / 10;
const norm = (name) => String(name || '').toLowerCase().replace(/\.exe$/, '').trim();

const CATEGORIES = [
  {
    id: 'browser-helpers',
    title: 'Idle browser helpers',
    blurb: 'Renderer and utility subprocesses with no window and no CPU use. Your browser tabs stay open.',
    safe: true,
  },
  {
    id: 'build-tools',
    title: 'Leftover build tools',
    blurb: 'Compilers, runtimes and dev servers that have been idle for a while.',
    safe: true,
  },
  {
    id: 'windowless',
    title: 'Windowless apps burning memory',
    blurb: 'Apps with no window on screen holding a large working set.',
    safe: false,
  },
  {
    id: 'memory-hogs',
    title: 'Large background processes',
    blurb: 'Over half a gigabyte of RAM, no window, and nothing critical.',
    safe: false,
  },
  {
    id: 'not-responding',
    title: 'Apps not responding',
    blurb: 'Windows reports these windows as frozen. Closing them is the usual fix.',
    safe: false,
  },
  {
    id: 'orphans',
    title: 'Orphaned processes',
    blurb: 'Their parent process is gone, so nothing is managing them.',
    safe: false,
  },
];

export function buildQuickClean(snapshot) {
  const now = Date.now();
  const buckets = new Map(CATEGORIES.map((c) => [c.id, []]));

  const seen = new Set();
  const consider = (categoryId, proc, reason, severity = 'low') => {
    if (seen.has(proc.pid)) return;
    const name = norm(proc.name);
    if (NEVER.has(name)) return;
    if (!proc.protection.killable) return;
    if (proc.pid === process.pid || proc.pid === process.ppid) return;
    seen.add(proc.pid);
    buckets.get(categoryId)?.push({
      pid: proc.pid,
      name: proc.name,
      window: proc.window,
      memory: proc.ws,
      memoryMb: mb(proc.ws),
      cpu: proc.cpu,
      ageMinutes: proc.start ? Math.max(0, Math.round((now - Date.parse(proc.start)) / 60000)) : null,
      reason,
      severity,
      category: categoryId,
      tier: proc.protection.tier,
      session: proc.session,
      path: proc.path,
      commandLine: proc.cmd,
    });
  };

  const counts = new Map();
  for (const p of snapshot.processes) {
    const key = norm(p.name);
    counts.set(key, (counts.get(key) || 0) + 1);
  }

  for (const p of snapshot.processes) {
    const name = norm(p.name);
    const ageMin = p.start ? (now - Date.parse(p.start)) / 60000 : 0;
    const idle = p.cpu < 0.5;

    if (BROWSER.has(name) && !p.window && idle && p.ws > 40 * 1024 * 1024 && ageMin > 2) {
      consider('browser-helpers', p, `No window, ${p.cpu.toFixed(1)}% CPU for the last sample.`, 'low');
      continue;
    }
    if (BUILD_TOOL.has(name) && !p.window && idle && ageMin > 10 && p.ws > 25 * 1024 * 1024) {
      consider('build-tools', p, `Idle ${Math.round(ageMin)} min with no window.`, 'low');
      continue;
    }
    if (p.status === 'Not responding' && p.window) {
      consider('not-responding', p, `Window "${p.window}" has stopped responding.`, 'medium');
      continue;
    }
    if (!p.parentAlive && p.parent && p.parent !== 0 && ageMin > 5 && p.ws > 30 * 1024 * 1024) {
      consider('orphans', p, `Parent PID ${p.parent} no longer exists.`, 'medium');
      continue;
    }
    if (!p.window && idle && p.ws > 120 * 1024 * 1024 && p.protection.tier === 'normal') {
      consider('windowless', p, `${mb(p.ws)} MB of RAM with no window.`, 'medium');
      continue;
    }
    if (!p.window && p.ws > 500 * 1024 * 1024 && (p.protection.tier === 'normal' || p.protection.tier === 'app')) {
      consider('memory-hogs', p, `${mb(p.ws)} MB working set.`, 'medium');
    }
  }

  const categories = CATEGORIES.map((meta) => {
    const items = (buckets.get(meta.id) || []).sort((a, b) => b.memory - a.memory).slice(0, 40);
    return {
      ...meta,
      items,
      count: items.length,
      memory: items.reduce((sum, i) => sum + i.memory, 0),
      memoryMb: mb(items.reduce((sum, i) => sum + i.memory, 0)),
    };
  }).filter((c) => c.count > 0);

  const recommended = categories
    .filter((c) => c.safe)
    .flatMap((c) => c.items.map((i) => i.pid));

  return {
    generatedAt: new Date().toISOString(),
    recommendedPids: recommended,
    totalReclaimable: categories.reduce((sum, c) => sum + c.memory, 0),
    totalReclaimableMb: mb(categories.reduce((sum, c) => sum + c.memory, 0)),
    categories,
  };
}
