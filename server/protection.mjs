// Task Manager 2 - process protection rules.
//
// Windows Task Manager lets you end anything, then acts surprised when the
// machine falls over. TM2 classifies every process before the End button is
// even clicked, and the server re-checks the classification on the kill
// request itself, so a stale UI can never take out lsass.

export const TIERS = {
  blocked: { id: 'blocked', rank: 4, label: 'Protected', tone: 'blocked' },
  critical: { id: 'critical', rank: 3, label: 'Critical', tone: 'critical' },
  important: { id: 'important', rank: 2, label: 'Important', tone: 'important' },
  app: { id: 'app', rank: 1, label: 'App', tone: 'app' },
  normal: { id: 'normal', rank: 0, label: 'Normal', tone: 'normal' },
};

// `name` is matched case-insensitively against the image name (with or
// without .exe). `pid` matches the well-known kernel pseudo processes.
const RULES = [
  // ---- Cannot be ended at all -------------------------------------------------
  { match: ['system', 'idle', 'system idle process'], tier: 'blocked', category: 'Kernel',
    note: 'This is the Windows kernel itself, not a normal process. Nothing can end it.' },
  { match: ['registry', 'memory compression', 'secure system'], tier: 'blocked', category: 'Kernel',
    note: 'Kernel-owned memory manager. Ending it is not possible and would bugcheck the machine.' },
  { match: ['smss'], tier: 'blocked', category: 'Session manager',
    note: 'Session Manager starts every other Windows session. Ending it forces an immediate bugcheck (BSOD).' },
  { match: ['csrss'], tier: 'blocked', category: 'Client/Server Runtime',
    note: 'Owns the console and window-manager plumbing for a session. Ending it takes the whole machine down.' },
  { match: ['wininit', 'winlogon'], tier: 'blocked', category: 'Logon',
    note: 'Logon and startup infrastructure. Ending it kills every session and the desktop.' },
  { match: ['services'], tier: 'blocked', category: 'Service control',
    note: 'The Service Control Manager owns all services. Ending it stops everything and Windows restarts.' },
  { match: ['lsass'], tier: 'blocked', category: 'Security',
    note: 'Local Security Authority: logon credentials and security policy. Ending it forces an immediate reboot and is flagged as an attack by Windows.' },
  { match: ['svchost'], tier: 'important', category: 'Service host',
    note: 'svchost is a shared host for Windows services. Ending one takes down every service sharing that host, and which services those are is not visible from the process name alone.',
    breaks: 'Expect audio, networking, Bluetooth, update or shell features to stop. A host that carries DcomLaunch or RpcSs takes the whole session with it.',
    restarts: true },
  { match: ['fontdrvhost'], tier: 'blocked', category: 'Fonts',
    note: 'Font driver host. Ending it breaks all text rendering until sign-out.' },
  { match: ['task-manager-2', 'taskmgr2', 'electron'], tier: 'blocked', category: 'This app',
    note: 'That is Task Manager 2 itself (or its desktop shell). Close the window instead.' },

  // ---- Extremely risky, require typing the name -------------------------------
  { match: ['dwm'], tier: 'critical', category: 'Desktop compositor',
    note: 'Desktop Window Manager draws every window on screen. Windows will restart it, all apps lose their drawing surface and may flicker or die.',
    breaks: 'All visible windows flicker; some apps crash. Windows restarts DWM automatically.',
    restarts: true },
  { match: ['explorer'], tier: 'critical', category: 'Shell',
    note: 'The Windows shell: taskbar, desktop icons, Start menu and file windows. Explorer.exe is usually restarted by Windows, but open folders close and tray icons reset.',
    breaks: 'Taskbar, desktop and Start menu disappear until Windows restarts Explorer.',
    restarts: true },
  { match: ['sihost'], tier: 'critical', category: 'Shell infrastructure',
    note: 'Shell Infrastructure Host draws the Start menu, search and UWP app frames.',
    breaks: 'Start menu, action center and some app windows stop drawing.' },
  { match: ['ctfmon'], tier: 'critical', category: 'Input',
    note: 'Handles keyboard input, IME and handwriting for the shell. Ending it can leave input focus stuck.',
    breaks: 'Text entry in some apps, IME and on-screen keyboard may stop working.' },
  { match: ['audiodg'], tier: 'critical', category: 'Audio',
    note: 'Audio Device Graph: all audio playback runs through it.',
    breaks: 'All sound stops until Windows restarts it (usually immediate).',
    restarts: true },
  { match: ['msmpeng', 'nissrv'], tier: 'critical', category: 'Security',
    note: 'Microsoft Defender. Windows protects it and will normally refuse the kill, then restart it.',
    breaks: 'Real-time protection is briefly off and Windows shows a security warning.',
    restarts: true },
  { match: ['searchhost', 'searchapp', 'searchui'], tier: 'critical', category: 'Search',
    note: 'Windows Search UI and indexer host.',
    breaks: 'Start-menu search and file search stop responding until restarted.' },

  // ---- Important, strong warning ---------------------------------------------
  { match: ['runtimebroker'], tier: 'important', category: 'App broker',
    note: 'Brokers permissions for Store and UWP apps.' },
  { match: ['shellexperiencehost', 'startmenuexperiencehost'], tier: 'important', category: 'Shell UI',
    note: 'Shell UI surfaces (Start, action center, task switcher).' },
  { match: ['spoolsv'], tier: 'important', category: 'Printing',
    note: 'Print Spooler. Ending it cancels queued print jobs and disconnects printers.' },
  { match: ['dllhost'], tier: 'important', category: 'COM+',
    note: 'COM+ surrogate host. Ending it may break in-flight shell or thumbnail tasks.' },
  { match: ['conhost'], tier: 'important', category: 'Console',
    note: 'Console window host. Ending it closes the terminal window attached to it.' },
  { match: ['wudfhost'], tier: 'important', category: 'Devices',
    note: 'User-mode driver framework host for device drivers.' },
  { match: ['logonui'], tier: 'important', category: 'Logon UI',
    note: 'The lock and logon screen.' },
  { match: ['securityhealthservice', 'securityhealthsystray'], tier: 'important', category: 'Security',
    note: 'Windows Security health and tray app.' },
  { match: ['node'], tier: 'important', category: 'Runtime',
    note: 'A Node.js runtime. Other running tools and dev servers may depend on it.' },
  { match: ['sshd', 'winlogbeat'], tier: 'important', category: 'Remote access',
    note: 'Remote access or logging agent. Ending it can lock you out or stop telemetry.' },
];

const BROWSERS = new Set(['chrome', 'msedge', 'firefox', 'brave', 'opera', 'vivaldi', 'arc']);
const KNOWN_APPS = new Set([
  'code', 'devenv', 'windowsterminal', 'conhost', 'slack', 'discord', 'spotify', 'teams', 'ms-teams',
  'steam', 'steamwebhelper', 'obs64', 'photoshop', 'illustrator', 'word', 'excel', 'powerpnt',
  'outlook', 'onenote', 'notepad', 'notepad++', 'sublime_text', 'pycharm64', 'idea64', 'studio64',
  'figma', 'zoom', 'telegram', 'signal', 'whatsapp', 'thunderbird', 'vlc', 'mpc-hc64', 'blender',
]);

const normalize = (name) => String(name || '').toLowerCase().replace(/\.exe$/, '').trim();

const ruleCache = new Map();
function findRule(name) {
  const key = normalize(name);
  if (ruleCache.has(key)) return ruleCache.get(key);
  let found = null;
  for (const rule of RULES) {
    if (rule.match.includes(key)) { found = rule; break; }
  }
  ruleCache.set(key, found);
  return found;
}

/**
 * Classify one process. Returns the tier plus human-readable warning copy.
 * `children` is the number of direct descendants, used to warn about the
 * collateral of ending a tree.
 */
export function classify(proc, { children = 0, elevatedSelf = false } = {}) {
  const name = normalize(proc.name);
  const rule = findRule(name);
  const hasWindow = Boolean(proc.window && proc.window.trim());
  const childrenNote = children > 0
    ? `${children} child process${children === 1 ? '' : 'es'} will also be ended.`
    : '';

  const base = rule
    ? { tier: rule.tier, category: rule.category, note: rule.note, breaks: rule.breaks || '', restarts: Boolean(rule.restarts) }
    : { tier: hasWindow ? 'app' : 'normal', category: hasWindow ? 'Application' : 'Background', note: '', breaks: '', restarts: false };

  // System-owned background processes with no rule are still not normal: they
  // live in session 0 and are almost always services.
  if (!rule && proc.session === 0) {
    base.tier = 'important';
    base.category = 'Windows service';
    base.note = 'A Windows service running in session 0. Ending it may disable a feature or driver until reboot.';
  }

  // Windows refuses to let an unelevated caller touch anything it does not own.
  // Saying so up front is more useful than a raw Access Denied later.
  const needsAdmin = !elevatedSelf && proc.session === 0 && base.tier !== 'blocked';

  const warnings = [];
  if (base.tier === 'blocked') {
    warnings.push(`Task Manager 2 will not end ${proc.name}. ${base.note}`);
  } else if (hasWindow) {
    warnings.push(`"${proc.window}" is open. Any unsaved work in it will be lost.`);
  }
  if (base.note && base.tier !== 'blocked') warnings.push(base.note);
  if (base.breaks && base.tier !== 'blocked') warnings.push(base.breaks);
  if (childrenNote) warnings.push(childrenNote);
  if (needsAdmin) warnings.push('You are not elevated, so Windows may refuse this with Access Denied.');

  const requiresTyping = base.tier === 'critical';
  const requiresCheckbox = base.tier === 'critical' || base.tier === 'important' || hasWindow || children > 0 || needsAdmin;

  return {
    tier: base.tier,
    category: base.category,
    note: base.note,
    breaks: base.breaks,
    restarts: base.restarts,
    warnings,
    needsAdmin,
    requiresTyping,
    requiresCheckbox,
    killable: base.tier !== 'blocked',
    confirmWord: requiresTyping ? proc.name : null,
    isBrowser: BROWSERS.has(name),
    isKnownApp: KNOWN_APPS.has(name),
  };
}

/** True if the process is allowed to be terminated by this app at all. */
export function isBlocked(proc) {
  return findRule(proc.name)?.tier === 'blocked';
}

export function severityRank(tier) {
  return TIERS[tier]?.rank ?? 0;
}
