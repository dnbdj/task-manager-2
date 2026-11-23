// Task Manager 2 - interface logic.
// Plain ES modules, no build step, no framework: the whole point is that this
// thing starts instantly and never gets in the way of the data.

const TOKEN = document.querySelector('meta[name="tm2-token"]').content;

const $ = (sel) => document.querySelector(sel);
const el = (tag, cls, text) => {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text != null) node.textContent = text;
  return node;
};

const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
));

const MB = 1024 * 1024;
const GB = 1024 * MB;

function fmtBytes(bytes) {
  const n = Number(bytes) || 0;
  if (n >= GB) return `${(n / GB).toFixed(n >= 10 * GB ? 1 : 2)} GB`;
  if (n >= MB) return `${(n / MB).toFixed(n >= 100 * MB ? 0 : 1)} MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${n} B`;
}

const fmtPct = (n) => `${(Number(n) || 0) < 10 ? (Number(n) || 0).toFixed(1) : (Number(n) || 0).toFixed(0)}%`;

function fmtAge(iso) {
  if (!iso) return '–';
  const diff = Date.now() - Date.parse(iso);
  if (!Number.isFinite(diff) || diff < 0) return '–';
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ${mins % 60}m ago`;
  return `${Math.floor(hours / 24)}d ${hours % 24}h ago`;
}

function fmtUptime(iso) {
  if (!iso) return '–';
  const diff = Date.now() - Date.parse(iso);
  if (!Number.isFinite(diff) || diff <= 0) return '–';
  const days = Math.floor(diff / 86400000);
  const hours = Math.floor((diff % 86400000) / 3600000);
  const mins = Math.floor((diff % 3600000) / 60000);
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${mins}m`;
  return `${mins}m`;
}

function fmtDuration(ms) {
  const secs = Math.round((Number(ms) || 0) / 1000);
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ${secs % 60}s`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ${mins % 60}m`;
  return `${Math.floor(hours / 24)}d ${hours % 24}h`;
}

// ------------------------------------------------------------------- state --

const VIEWS = [
  { id: 'all', label: 'All processes', test: () => true },
  { id: 'apps', label: 'Apps with a window', test: (p) => Boolean(p.window) },
  { id: 'background', label: 'Background (no window)', test: (p) => !p.window },
  { id: 'hot', label: 'Busy right now (>2% CPU)', test: (p) => p.cpu >= 2 },
  { id: 'memory', label: 'Heavy memory (>500 MB)', test: (p) => p.ws >= 500 * MB },
  { id: 'system', label: 'Windows system / protected', test: (p) => p.session === 0 || ['critical', 'important', 'blocked'].includes(p.protection.tier) },
  { id: 'notresponding', label: 'Not responding', test: (p) => p.status === 'Not responding' },
  { id: 'mine', label: 'Your session', test: (p) => p.session !== 0 && p.protection.tier !== 'blocked' && p.protection.tier !== 'critical' },
];

const TIER_LABEL = { blocked: 'Protected', critical: 'Critical', important: 'Important', app: 'App', normal: 'Normal' };
const TIER_RANK = { blocked: 4, critical: 3, important: 2, app: 1, normal: 0 };

const state = {
  snap: null,
  q: '',
  view: 'all',
  showSystem: true,
  group: true,
  sorts: [{ key: 'cpu', dir: 'desc' }],
  selected: new Set(),
  focused: null,
  expanded: new Set(),
  detail: null,
  detailPid: null,
  pollMs: 3000,
  live: true,
  loading: false,
  error: null,
  modal: null,
  qcSelected: new Set(),
  qcData: null,
  cleanPrefs: { cpu: true, gpu: true, ram: true, internet: true, storage: true },
  cleanPreview: null,
  cleanBusy: false,
  page: 'processes',
  settingsTab: 'processes',
  history: [],
  graphWindow: 60,
  graphFill: true,
  graphGrid: true,
  procHistory: new Map(),
};

const byPid = () => new Map((state.snap?.processes || []).map((p) => [p.pid, p]));

// --------------------------------------------------------------------- api --

async function api(path, { method = 'GET', body } = {}) {
  const response = await fetch(path, {
    method,
    headers: { 'x-tm2-token': TOKEN, ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  let data = {};
  try { data = text ? JSON.parse(text) : {}; } catch { data = { ok: false, error: text.slice(0, 400) }; }
  if (!response.ok) {
    const error = new Error(data.error || `Request failed (${response.status})`);
    error.details = data.details || null;
    error.status = response.status;
    throw error;
  }
  return data;
}

// ------------------------------------------------------------------ toasts --

function toast(kind, title, detail = '', ttl = 6500) {
  const node = el('div', `toast ${kind}`);
  const icon = el('div', 't-icon');
  icon.innerHTML = kind === 'ok'
    ? '<svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true"><circle cx="8" cy="8" r="6.6" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="m5 8.2 2 2 4-4.4" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>'
    : '<svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true"><circle cx="8" cy="8" r="6.6" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M8 4.6v4.2M8 11.2v.4" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/></svg>';
  const bodyNode = el('div', 't-body');
  bodyNode.appendChild(el('b', null, title));
  if (detail) bodyNode.appendChild(el('div', 't-detail', detail));
  node.append(icon, bodyNode);
  $('#toasts').appendChild(node);
  setTimeout(() => {
    node.style.transition = 'opacity .2s, transform .2s';
    node.style.opacity = '0';
    node.style.transform = 'translateX(12px)';
    setTimeout(() => node.remove(), 220);
  }, ttl);
}

// ------------------------------------------------------------------ filter --

function matchesQuery(p, q) {
  if (!q) return true;
  return (
    p.name.toLowerCase().includes(q)
    || String(p.pid).includes(q)
    || (p.window || '').toLowerCase().includes(q)
    || (p.path || '').toLowerCase().includes(q)
    || (p.cmd || '').toLowerCase().includes(q)
    || (p.parentName || '').toLowerCase().includes(q)
  );
}

function baseFiltered() {
  const snap = state.snap;
  if (!snap) return { list: [], systemHidden: 0, total: 0 };
  const q = state.q.trim().toLowerCase();
  let list = snap.processes;
  let systemHidden = 0;
  if (!state.showSystem) {
    const before = list.length;
    list = list.filter((p) => !(p.session === 0 || ['critical', 'important', 'blocked'].includes(p.protection.tier)));
    systemHidden = before - list.length;
  }
  const view = VIEWS.find((v) => v.id === state.view) || VIEWS[0];
  list = list.filter(view.test);
  if (q) list = list.filter((p) => matchesQuery(p, q));
  return { list, systemHidden, total: snap.processes.length };
}

// ------------------------------------------------------------------ sorting --

function valueOf(item, key) {
  switch (key) {
    case 'name': return item.name.toLowerCase();
    case 'pid': return item.pid;
    case 'cpu': return item.cpu;
    case 'ws': return item.ws;
    case 'memPercent': return item.memPercent;
    case 'threads': return item.threads;
    case 'handles': return item.handles;
    case 'session': return item.session;
    case 'status': return item.status;
    case 'start': return Date.parse(item.start) || 0;
    case 'risk': return TIER_RANK[item.protection?.tier] ?? 0;
    default: return 0;
  }
}

function compareMulti(a, b, sorts) {
  for (const { key, dir } of sorts) {
    const av = valueOf(a, key);
    const bv = valueOf(b, key);
    let result = 0;
    if (typeof av === 'string' || typeof bv === 'string') {
      result = String(av).localeCompare(String(bv), undefined, { numeric: true, sensitivity: 'base' });
    } else {
      result = (av || 0) - (bv || 0);
    }
    if (result !== 0) return dir === 'asc' ? result : -result;
  }
  // Stable, predictable tie-break so rows never jitter between samples.
  return (a.name || '').localeCompare(b.name || '') || (a.pid || 0) - (b.pid || 0);
}

function setSort(key, { additive = false } = {}) {
  if (key === 'risk') key = 'name';
  const existing = state.sorts.findIndex((s) => s.key === key);
  if (additive) {
    if (existing >= 0) {
      const entry = state.sorts[existing];
      entry.dir = entry.dir === 'asc' ? 'desc' : 'asc';
      if (existing === 0 && entry.dir === 'desc') { /* keep */ }
    } else {
      state.sorts.push({ key, dir: key === 'name' ? 'asc' : 'desc' });
      if (state.sorts.length > 3) state.sorts.shift();
    }
  } else if (existing === 0 && state.sorts.length === 1) {
    state.sorts = [{ key, dir: state.sorts[0].dir === 'asc' ? 'desc' : 'asc' }];
  } else if (existing >= 0) {
    state.sorts = [{ key, dir: state.sorts[existing].dir === 'asc' ? 'desc' : 'asc' }];
  } else {
    state.sorts = [{ key, dir: key === 'name' ? 'asc' : 'desc' }];
  }
  render();
}

function buildGroups(list) {
  const groups = new Map();
  for (const p of list) {
    const key = p.name.toLowerCase();
    let group = groups.get(key);
    if (!group) {
      group = {
        key,
        name: p.name,
        count: 0,
        cpu: 0,
        ws: 0,
        threads: 0,
        handles: 0,
        session: p.session,
        status: 'Running',
        start: p.start,
        worst: 'normal',
        members: [],
        pids: [],
        windows: [],
        hasBlocked: false,
        hasCritical: false,
      };
      groups.set(key, group);
    }
    group.count += 1;
    group.cpu += p.cpu;
    group.ws += p.ws;
    group.threads += p.threads;
    group.handles += p.handles;
    group.members.push(p);
    group.pids.push(p.pid);
    if (p.window) group.windows.push(p.window);
    if (p.status === 'Not responding') group.status = 'Not responding';
    if (!group.start || (p.start && Date.parse(p.start) < Date.parse(group.start))) group.start = p.start;
    const tier = p.protection.tier;
    if ((TIER_RANK[tier] ?? 0) > (TIER_RANK[group.worst] ?? 0) && tier !== 'normal') group.worst = tier;
    if (tier === 'blocked') group.hasBlocked = true;
    if (tier === 'critical') group.hasCritical = true;
  }
  for (const group of groups.values()) {
    group.protection = { tier: group.worst };
    group.status = group.members.some((m) => m.status === 'Not responding') ? 'Not responding' : 'Running';
  }
  return groups;
}

function computeRows() {
  const { list, systemHidden, total } = baseFiltered();
  const visibleCount = list.length;
  const sorted = list.slice().sort((a, b) => compareMulti(a, b, state.sorts));
  if (!state.group) {
    return { rows: sorted.map((p) => ({ type: 'proc', proc: p })), visibleCount, systemHidden, total };
  }
  const groups = buildGroups(sorted);
  const ordered = [...groups.values()].sort((a, b) => compareMulti(a, b, state.sorts));
  const rows = [];
  for (const group of ordered) {
    rows.push({ type: 'group', group });
    if (state.expanded.has(group.key)) {
      const members = group.members.slice().sort((a, b) => compareMulti(a, b, state.sorts));
      for (const member of members) rows.push({ type: 'proc', proc: member, member: true });
    }
  }
  return { rows, visibleCount, systemHidden, total, groupCount: ordered.length };
}

// ------------------------------------------------------------------ render --

function updateHeaderStats() {
  const snap = state.snap;
  if (!snap) return;
  const cpu = snap.load.cpu;
  const setStat = (id, value, sub, percent, tone) => {
    const node = document.getElementById(id);
    if (!node) return;
    node.querySelector('[data-v]').textContent = value;
    const subNode = node.querySelector('[data-sub]');
    if (subNode) subNode.textContent = sub || '\u00a0';
    const bar = node.querySelector('[data-bar]');
    if (bar) bar.style.width = `${Math.max(0, Math.min(100, percent ?? 0))}%`;
    node.classList.toggle('warn', tone === 'warn');
    node.classList.toggle('hot', tone === 'hot');
  };
  const tone = (pct) => (pct >= 85 ? 'hot' : pct >= 60 ? 'warn' : '');

  setStat('stat-cpu', fmtPct(cpu), `${snap.os?.cores || '?'} logical cores`, cpu, tone(cpu));
  setStat('stat-ram', fmtPct(snap.memory.percent), `${fmtBytes(snap.memory.used)} of ${fmtBytes(snap.memory.total)}`, snap.memory.percent, tone(snap.memory.percent));
  setStat('stat-disk', snap.load.disk == null ? '–' : fmtPct(snap.load.disk), 'busy time', snap.load.disk ?? 0, tone(snap.load.disk ?? 0));

  const procStat = document.querySelector('#stats .stat-plain:nth-of-type(4)');
  if (procStat) {
    procStat.querySelector('[data-v]').textContent = String(snap.counts.processes);
    const sub = procStat.querySelector('[data-sub]');
    if (sub) sub.textContent = `${snap.counts.threads} threads · ${snap.counts.handles} handles`;
  }
  const uptimeStat = document.querySelector('#stats .stat-plain:nth-of-type(5)');
  if (uptimeStat) {
    uptimeStat.querySelector('[data-v]').textContent = fmtUptime(snap.os?.booted);
    const sub = uptimeStat.querySelector('[data-sub]');
    if (sub) sub.textContent = snap.os?.name ? snap.os.name.replace('Microsoft ', '').slice(0, 28) : '–';
  }

  const machine = $('#machine');
  if (machine) machine.innerHTML = machineEntries(snap).map(([k, v]) => `<dt>${esc(k)}</dt><dd title="${esc(v)}">${esc(v)}</dd>`).join('');
}

function machineEntries(snap) {
  return [
    ['Host', snap.host || '–'],
    ['User', snap.user || '–'],
    ['Cores', String(snap.os?.cores ?? '–')],
    ['Build', snap.os?.build || '–'],
    ['Session', snap.elevated ? 'Elevated' : 'Standard'],
  ];
}

function renderSortChips() {
  const host = $('#sort-chips');
  host.innerHTML = '';
  state.sorts.forEach((sort, index) => {
    const label = sort.key === 'ws' ? 'memory' : sort.key;
    const chip = el('span', 'sort-chip');
    chip.innerHTML = `<span class="ord">${index + 1}</span><b>${esc(label)}</b>${sort.dir === 'asc' ? '↑' : '↓'}`;
    host.appendChild(chip);
  });
  $('#btn-clear-sort').classList.toggle('hidden', state.sorts.length === 0 || (state.sorts.length === 1 && state.sorts[0].key === 'cpu' && state.sorts[0].dir === 'desc'));

  document.querySelectorAll('.grid thead th[data-sort-key]').forEach((th) => {
    const key = th.dataset.sortKey;
    const index = state.sorts.findIndex((s) => s.key === key);
    th.classList.toggle('sorted', index >= 0);
    let arrow = th.querySelector('.arrow');
    let ord = th.querySelector('.ord');
    if (index >= 0) {
      if (!arrow) { arrow = el('span', 'arrow'); th.appendChild(arrow); }
      arrow.textContent = state.sorts[index].dir === 'asc' ? '↑' : '↓';
      if (state.sorts.length > 1) {
        if (!ord) { ord = el('span', 'ord'); th.appendChild(ord); }
        ord.textContent = String(index + 1);
      } else if (ord) ord.remove();
    } else {
      arrow?.remove();
      ord?.remove();
    }
  });
}

function sparkColor(cpu) {
  if (cpu >= 25) return '#f87171';
  if (cpu >= 5) return '#fbbf24';
  return '#38bdf8';
}

function sparkline(values, { width = 92, height = 14, stroke = '#38bdf8' } = {}) {
  const nums = (values || []).slice(-32);
  const base = `<line class="spark-base" x1="0" y1="${height - 1}" x2="${width}" y2="${height - 1}" stroke-width="1" />`;
  if (nums.length < 2) {
    return `<svg class="sparkline" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" aria-hidden="true">${base}</svg>`;
  }
  const peak = Math.max(2, ...nums);
  const step = width / (nums.length - 1);
  const points = nums
    .map((value, index) => `${(index * step).toFixed(1)},${(height - 1.5 - (value / peak) * (height - 3)).toFixed(1)}`)
    .join(' ');
  return `<svg class="sparkline" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" aria-hidden="true">${base}<polyline points="${points}" fill="none" stroke="${stroke}" stroke-width="1.4" stroke-linejoin="round" stroke-linecap="round" /></svg>`;
}

function seriesSum(pids) {
  const lists = pids.map((pid) => state.procHistory.get(pid) || []);
  const length = lists.reduce((max, list) => Math.max(max, list.length), 0);
  const out = new Array(length).fill(0);
  for (const list of lists) {
    const offset = length - list.length;
    for (let i = 0; i < list.length; i += 1) out[offset + i] += list[i];
  }
  return out;
}

function riskCell(tier) {
  return `<span class="risk-pill"><i class="risk-dot"></i>${esc(TIER_LABEL[tier] || tier)}</span>`;
}

function renderRows() {
  const tbody = $('#rows');
  const { rows, visibleCount, systemHidden, total } = computeRows();
  const selected = state.selected;
  const q = state.q.trim().toLowerCase();

  const html = rows.map((row) => {
    if (row.type === 'group') {
      const g = row.group;
      const open = state.expanded.has(g.key);
      const allSelected = g.pids.every((pid) => selected.has(pid));
      const title = g.windows.length ? g.windows[0] : `${g.count} instances`;
      return `<tr class="group-row tier-${esc(g.protection.tier)}${open ? ' open' : ''}" data-group="${esc(g.key)}">
        <td class="col-check"><input type="checkbox" data-group-check="${esc(g.key)}" ${allSelected ? 'checked' : ''} /></td>
        <td class="col-risk">${riskCell(g.protection.tier)}</td>
        <td class="col-name"><span class="caret">▶</span><span class="folder-ico">${FOLDER_SVG}</span><span class="proc-name">${esc(g.name)}</span><span class="group-count">${g.count}×</span>
          <span class="row-spark" title="${esc(title)}">${sparkline(seriesSum(g.pids), { stroke: sparkColor(g.cpu) })}</span></td>
        <td class="col-num">${g.count}</td>
        <td class="col-num ${g.cpu >= 25 ? 'cpu-hot' : g.cpu >= 5 ? 'cpu-warm' : ''}">${fmtPct(g.cpu)}</td>
        <td class="col-num mem-strong">${fmtBytes(g.ws)}</td>
        <td class="col-status"><span class="status-pill${g.status !== 'Running' ? ' bad' : ''}"><i></i>${esc(g.status)}</span></td>
      </tr>`;
    }

    const p = row.proc;
    const tier = p.protection.tier;
    const isSelected = selected.has(p.pid);
    const isFocused = state.focused === p.pid;
    const nameHtml = state.q
      ? esc(p.name).replace(new RegExp(`(${q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'ig'), '<mark>$1</mark>')
      : esc(p.name);
    const flag = p.session === 0 ? '<span class="proc-flag">SYSTEM</span>' : '';
    const rowTitle = p.window || (p.parentName ? `parent: ${p.parentName}` : p.name);
    return `<tr data-pid="${p.pid}" class="tier-${esc(tier)}${isSelected ? ' selected' : ''}${isFocused ? ' focused' : ''}${row.member ? ' member-row' : ''}">
      <td class="col-check"><input type="checkbox" data-check="${p.pid}" ${isSelected ? 'checked' : ''} /></td>
      <td class="col-risk">${riskCell(tier)}</td>
      <td class="col-name"><span class="proc-cell"><span class="proc-name">${nameHtml}</span>${flag}<span class="row-spark" title="${esc(rowTitle)}">${sparkline(state.procHistory.get(p.pid) || [], { stroke: sparkColor(p.cpu) })}</span></span></td>
      <td class="col-num">${p.pid}</td>
      <td class="col-num ${p.cpu >= 25 ? 'cpu-hot' : p.cpu >= 5 ? 'cpu-warm' : ''}">${fmtPct(p.cpu)}</td>
      <td class="col-num ${p.ws >= 500 * MB ? 'mem-strong' : ''}">${fmtBytes(p.ws)}</td>
      <td class="col-status"><span class="status-pill${p.status !== 'Running' ? ' bad' : ''}"><i></i>${esc(p.status)}</span></td>
    </tr>`;
  }).join('');

  const scroll = $('#table-scroll');
  const top = scroll.scrollTop;
  tbody.innerHTML = html;
  scroll.scrollTop = top;

  $('#empty').classList.toggle('hidden', rows.length > 0);
  $('#view-title').textContent = (VIEWS.find((v) => v.id === state.view) || VIEWS[0]).label;

  renderStatus(visibleCount, systemHidden, total);
  renderSelectionUi();
}

function renderStatus(visibleCount, systemHidden, total) {
  const snap = state.snap;
  const parts = [];
  if (!snap) {
    $('#status-showing').textContent = 'Waiting for the first sample…';
  } else {
    parts.push(`Showing <span class="visible-note">${visibleCount}</span> of ${total} processes`);
    if (visibleCount !== total) {
      const hiddenByView = total - visibleCount;
      parts.push(`<span class="warn-note">${hiddenByView} outside this view</span>`);
    }
    parts.push('nothing hidden by Task Manager 2');
    $('#status-showing').innerHTML = parts.join(' · ');
  }

  const age = snap?.sampler?.age;
  const sampled = snap?.sampledAt ? `${fmtAge(snap.sampledAt)}` : '–';
  let updated = `sampled ${sampled}`;
  if (snap?.sampler?.error) updated = `sampler error: ${snap.sampler.error.slice(0, 60)}`;
  if (state.error) updated = state.error.slice(0, 80);
  $('#status-updated').textContent = updated;

  $('#status-elevated').innerHTML = snap
    ? (snap.elevated ? 'elevated' : '<span class="warn-note">standard user</span>')
    : '–';

  $('#admin-banner').classList.toggle('hidden', Boolean(snap?.elevated));
}

function renderSelectionUi() {
  const count = state.selected.size;
  $('#selection-count').classList.toggle('hidden', count === 0);
  $('#selection-count').textContent = count ? `${count} selected` : '';
  $('#bulk').classList.toggle('hidden', count === 0);
  const boxes = [...document.querySelectorAll('#rows input[data-check]')];
  const allChecked = boxes.length > 0 && boxes.every((b) => b.checked);
  $('#select-all').checked = allChecked;
  $('#select-all').indeterminate = !allChecked && boxes.some((b) => b.checked);
}

// ------------------------------------------------------------------ detail --

async function selectProcess(pid) {
  state.focused = pid;
  state.detailPid = pid;
  state.detail = null;
  const proc = byPid().get(pid);
  renderDetail(proc);
  renderRows();
  try {
    const data = await api(`/api/process/${pid}`);
    if (state.detailPid === pid) {
      state.detail = data.detail;
      renderDetail(byPid().get(pid));
    }
  } catch (error) {
    if (state.detailPid === pid) {
      state.detail = { ok: false, error: error.message };
      renderDetail(byPid().get(pid));
    }
  }
}

function renderDetail(proc) {
  const panel = $('#detail');
  const layout = $('.layout');
  if (!proc) {
    panel.classList.add('hidden');
    layout.classList.remove('with-detail');
    return;
  }
  panel.classList.remove('hidden');
  layout.classList.add('with-detail');

  const detail = state.detail || {};
  $('#detail-name').textContent = proc.name;
  $('#detail-sub').textContent = `PID ${proc.pid} · session ${proc.session} · ${proc.window ? 'window open' : 'background'}`;

  const tier = proc.protection.tier;
  $('#detail-tier').innerHTML = `<div class="tier-banner ${esc(tier)}">${esc(TIER_LABEL[tier])} process${proc.protection.category ? ` · ${esc(proc.protection.category)}` : ''}</div>`;

  const warnings = (proc.protection.warnings || []).map((w) => {
    const cls = tier === 'blocked' || tier === 'critical' ? 'danger' : 'warn';
    return `<div class="detail-warn ${cls}">${warnIcon()}${esc(w)}</div>`;
  }).join('');

  const facts = [
    ['Path', detail.path || proc.path || '–'],
    ['Command line', detail.cmd || proc.cmd || '–'],
    ['User', detail.user || '–'],
    ['Company', detail.company || '–'],
    ['Version', detail.version || '–'],
    ['Started', proc.start ? new Date(proc.start).toLocaleString() : '–'],
    ['CPU time', fmtDuration(proc.cpuMs)],
    ['Memory', `${fmtBytes(proc.ws)} (${fmtPct(proc.memPercent)} of RAM)`],
    ['Private', fmtBytes(proc.priv)],
    ['Threads / handles', `${proc.threads} / ${proc.handles}`],
    ['Parent', proc.parentName ? `${proc.parentName} (${proc.parent})` : 'none'],
    ['Children', String(proc.childCount)],
    ['Priority', detail.priority || proc.priority || '–'],
  ];

  $('#detail-body').innerHTML = `
    ${warnings}
    <div class="detail-section">
      <h3>Details</h3>
      <dl>${facts.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('')}</dl>
    </div>
    <div class="detail-section">
      <h3>Command line</h3>
      <div class="command">${esc(detail.cmd || proc.cmd || 'Not reported for this process.')}</div>
    </div>
    <div class="detail-section">
      <h3>Extensions</h3>
      <div class="check-line" style="color:var(--muted)">${esc(detail.error || (detail.ok === false ? 'Details unavailable.' : 'Loaded on selection.'))}</div>
    </div>`;

  const blocked = !proc.protection.killable;
  const endBtn = $('#detail-end');
  endBtn.disabled = blocked;
  endBtn.textContent = blocked ? 'Protected' : 'End task';
  $('#detail-tree').disabled = blocked || proc.childCount === 0;
}

const warnIcon = () => '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M8 1.8 15 14H1L8 1.8Z" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/><path d="M8 6v3.4M8 11.4v.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>';

const FOLDER_SVG = '<svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true"><path d="M1.5 4.3a1 1 0 0 1 1-1h3.2l1.2 1.4h6.6a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1h-11a1 1 0 0 1-1-1V4.3Z" fill="currentColor"/></svg>';

// ------------------------------------------------------------------ modals --

function closeModal() {
  $('#modal-root').innerHTML = '';
  state.modal = null;
  document.removeEventListener('keydown', onModalKey);
}

function onModalKey(event) {
  if (event.key === 'Escape') {
    event.preventDefault();
    closeModal();
  }
}

function openModal(node, { width = '' } = {}) {
  closeModal();
  const backdrop = el('div', 'modal-backdrop');
  backdrop.appendChild(node);
  backdrop.addEventListener('mousedown', (event) => {
    if (event.target === backdrop) closeModal();
  });
  $('#modal-root').appendChild(backdrop);
  document.addEventListener('keydown', onModalKey);
  state.modal = node;
  const focusTarget = node.querySelector('input[type="text"], input[type="checkbox"], .btn-danger, .btn');
  setTimeout(() => focusTarget?.focus(), 30);
}

/**
 * The End Task dialog. This is the whole point of the app: you cannot end
 * anything risky without reading exactly what breaks.
 */
function openEndDialog(pids, { tree = false } = {}) {
  const map = byPid();
  const procs = pids.map((pid) => map.get(pid)).filter(Boolean);
  if (!procs.length) return;

  const blocked = procs.filter((p) => !p.protection.killable);
  if (blocked.length) {
    const modal = el('div', 'modal');
    modal.innerHTML = `
      <div class="modal-head">
        <h2>${esc(blocked[0].name)} cannot be ended</h2>
        <p>Task Manager 2 blocks processes Windows needs to keep running.</p>
      </div>
      <div class="modal-body">
        <div class="tier-banner blocked">Protected · ${esc(blocked[0].protection.category || 'Windows')}</div>
        <ul class="warn-list">
          ${blocked.map((p) => `<li class="blk">${warnIcon()}<span><strong>${esc(p.name)}</strong> (PID ${p.pid}) — ${esc(p.protection.note || 'This process is protected.')}</span></li>`).join('')}
        </ul>
      </div>
      <div class="modal-foot"><button class="btn btn-ghost" data-close>Close</button></div>`;
    openModal(modal);
    modal.querySelector('[data-close]').addEventListener('click', closeModal);
    return;
  }

  const highest = procs.reduce((worst, p) => (TIER_RANK[p.protection.tier] > TIER_RANK[worst] ? p.protection.tier : worst), 'normal');
  const warnings = [];
  const seen = new Set();
  for (const p of procs) {
    for (const w of p.protection.warnings) {
      if (seen.has(w)) continue;
      seen.add(w);
      warnings.push({ text: w, proc: p });
    }
  }
  const typingProcs = procs.filter((p) => p.protection.requiresTyping);
  const totalChildren = procs.reduce((sum, p) => sum + p.childCount, 0);
  const requiresBox = procs.some((p) => p.protection.requiresCheckbox) || procs.length > 1;

  const title = procs.length === 1 ? `End ${procs[0].name}?` : `End ${procs.length} processes?`;
  const subtitle = procs.length === 1
    ? `PID ${procs[0].pid} · ${fmtBytes(procs[0].ws)} · ${fmtPct(procs[0].cpu)} CPU`
    : procs.slice(0, 4).map((p) => p.name).join(', ') + (procs.length > 4 ? `, +${procs.length - 4} more` : '');

  const modal = el('div', 'modal');
  modal.innerHTML = `
    <div class="modal-head">
      <h2>${esc(title)}</h2>
      <p>${esc(subtitle)}</p>
    </div>
    <div class="modal-body">
      <div class="tier-banner ${esc(highest)}">
        ${highest === 'critical' ? 'Critical process — this can break your session'
          : highest === 'important' ? 'Important process — Windows or an app depends on it'
          : 'Application process'}
      </div>
      <ul class="warn-list">
        ${warnings.map((w) => `<li class="${highest === 'critical' ? 'danger' : ''}">${warnIcon()}<span>${esc(w.text)}</span></li>`).join('')}
        ${warnings.length === 0 ? `<li>${warnIcon()}<span>Nothing flagged. Ending it is the normal way to close a stuck app.</span></li>` : ''}
      </ul>

      ${(totalChildren > 0 || procs.length === 1) ? `
      <label class="tree-toggle">
        <input type="checkbox" id="end-tree" ${tree ? 'checked' : ''} />
        <span>Also end child processes <small>${totalChildren ? `${totalChildren} child process${totalChildren === 1 ? '' : 'es'} depend on this` : 'No child processes found right now'}</small></span>
      </label>` : ''}

      <div class="confirm-block">
        ${typingProcs.map((p) => `
          <div class="field">
            <label for="type-${p.pid}">Type <strong>${esc(p.name)}</strong> to confirm you want to end a critical process</label>
            <input type="text" id="type-${p.pid}" data-type-pid="${p.pid}" autocomplete="off" spellcheck="false" placeholder="${esc(p.name)}" />
          </div>`).join('')}
        ${requiresBox ? `
        <label class="check-line">
          <input type="checkbox" id="ack-box" />
          <span>I understand <em>${esc(procs.length === 1 ? procs[0].name : 'these processes')}</em> will be closed immediately and unsaved work will be lost.</span>
        </label>` : ''}
      </div>
    </div>
    <div class="modal-foot">
      <button class="btn btn-ghost" data-cancel>Cancel</button>
      <button class="btn btn-danger" data-confirm disabled>End ${procs.length === 1 ? 'process' : `${procs.length} processes`}</button>
    </div>`;

  openModal(modal);

  const confirmBtn = modal.querySelector('[data-confirm]');
  const box = modal.querySelector('#ack-box');
  const inputs = [...modal.querySelectorAll('[data-type-pid]')];

  const validate = () => {
    const boxOk = !requiresBox || box?.checked;
    const typingOk = inputs.every((input) => {
      const pid = Number(input.dataset.typePid);
      const proc = procs.find((p) => p.pid === pid);
      const expected = String(proc?.protection.confirmWord || proc?.name || '').toLowerCase();
      return input.value.trim().toLowerCase() === expected;
    });
    confirmBtn.disabled = !(boxOk && typingOk);
  };

  box?.addEventListener('change', validate);
  inputs.forEach((input) => input.addEventListener('input', validate));
  validate();

  modal.querySelector('[data-cancel]').addEventListener('click', closeModal);
  confirmBtn.addEventListener('click', () => {
    const treeToggle = modal.querySelector('#end-tree');
    confirmEnd({
      pids: procs.map((p) => p.pid),
      tree: Boolean(treeToggle?.checked),
      confirmations: Object.fromEntries(inputs.map((i) => [i.dataset.typePid, i.value.trim()])),
      names: procs.map((p) => p.name),
      memory: procs.reduce((sum, p) => sum + p.ws, 0),
    });
  });
}

async function confirmEnd({ pids, tree, confirmations, names, memory }) {
  closeModal();
  try {
    const result = await api('/api/kill', {
      method: 'POST',
      body: { pids, tree, acknowledged: true, confirmations },
    });
    const ended = result.ended || [];
    const failed = result.failed || [];
    if (ended.length) {
      toast('ok', `Ended ${ended.length} process${ended.length === 1 ? '' : 'es'}`,
        `${names.slice(0, 3).join(', ')}${names.length > 3 ? '…' : ''} · freed ${fmtBytes(result.freedBytes || memory)}`
        + (result.skippedTree?.length ? ` · ${result.skippedTree.length} protected child kept` : ''));
      state.selected.clear();
      if (pids.includes(state.focused)) {
        state.focused = null;
        state.detailPid = null;
        state.detail = null;
        $('#detail').classList.add('hidden');
        $('.layout').classList.remove('with-detail');
      }
    }
    if (failed.length) {
      toast('err', `${failed.length} could not be ended`, failed.map((f) => `${f.name} (${f.pid}): ${f.error}. ${f.hint}`).join('  '), 12000);
    }
    if (!ended.length && !failed.length) toast('ok', 'Nothing to end', 'Those processes had already exited.');
    await refresh(true);
  } catch (error) {
    toast('err', 'Windows refused', error.message, 12000);
    await refresh(true);
  }
}

// -------------------------------------------------------------- quick clean --

async function openProcessReview() {
  const modal = el('div', 'modal wide');
  modal.innerHTML = `
    <div class="modal-head">
      <h2>Close background processes</h2>
      <p>Everything below is a candidate, with the reason it was picked. Nothing closes until you confirm.</p>
    </div>
    <div class="modal-body"><div class="qc-none">Scanning…</div></div>
    <div class="modal-foot"><button class="btn btn-ghost" data-cancel>Cancel</button></div>`;
  openModal(modal);
  modal.querySelector('[data-cancel]').addEventListener('click', closeModal);

  let data;
  try {
    data = await api('/api/quickclean');
  } catch (error) {
    modal.querySelector('.modal-body').innerHTML = `<div class="qc-none">Could not scan: ${esc(error.message)}</div>`;
    return;
  }
  state.qcData = data;
  state.qcSelected = new Set(data.recommendedPids || []);
  renderQuickClean(modal, data);
}

function renderQuickClean(modal, data) {
  const selected = state.qcSelected;
  const allItems = data.categories.flatMap((c) => c.items);
  const selectedItems = allItems.filter((i) => selected.has(i.pid));
  const selectedBytes = selectedItems.reduce((sum, i) => sum + i.memory, 0);

  const body = modal.querySelector('.modal-body');
  if (!data.categories.length) {
    body.innerHTML = `<div class="qc-none">Nothing worth closing right now. Every background process is either busy, protected, or too small to matter.</div>`;
    modal.querySelector('.modal-foot').innerHTML = '<button class="btn btn-ghost" data-cancel>Close</button>';
    modal.querySelector('[data-cancel]').addEventListener('click', closeModal);
    return;
  }

  body.innerHTML = `
    <div class="qc-total">
      <b>${fmtBytes(data.totalReclaimable)}</b>
      <span>available across ${allItems.length} processes · ${selectedItems.length} selected now</span>
    </div>
    ${data.categories.map((cat) => {
      const allChecked = cat.items.every((i) => selected.has(i.pid));
      return `
      <div class="qc-cat" data-cat="${esc(cat.id)}">
        <div class="qc-cat-head" data-cat-toggle="${esc(cat.id)}">
          <input type="checkbox" data-cat-check="${esc(cat.id)}" ${allChecked ? 'checked' : ''} />
          <div>
            <div class="qc-title">${esc(cat.title)} ${cat.safe ? '<span class="safe-badge">SAFE</span>' : ''}</div>
            <div class="qc-blurb">${esc(cat.blurb)}</div>
          </div>
          <div class="qc-size">${fmtBytes(cat.memory)}</div>
        </div>
        <div class="qc-items">
          ${cat.items.map((item) => `
            <label class="qc-item">
              <input type="checkbox" data-item="${item.pid}" ${selected.has(item.pid) ? 'checked' : ''} />
              <span class="nm">${esc(item.name)}</span>
              <span class="rsn">${esc(item.reason)}</span>
              <span class="sz">${fmtBytes(item.memory)}</span>
            </label>`).join('')}
        </div>
      </div>`;
    }).join('')}
    <label class="check-line" style="margin-top:4px">
      <input type="checkbox" id="qc-ack" />
      <span>I understand these apps will close immediately. Anything with unsaved work should be closed from its own window instead.</span>
    </label>`;

  const foot = modal.querySelector('.modal-foot');
  foot.innerHTML = `
    <button class="btn btn-ghost" data-recommend>Select recommended</button>
    <button class="btn btn-ghost" data-cancel>Cancel</button>
    <button class="btn btn-danger" data-go disabled>End selected</button>`;

  const totalLabel = () => `${selectedItems.length} processes · ${fmtBytes(selectedBytes)}`;
  const goBtn = foot.querySelector('[data-go]');
  const ack = modal.querySelector('#qc-ack');

  const sync = () => {
    const items = data.categories.flatMap((c) => c.items).filter((i) => selected.has(i.pid));
    const bytes = items.reduce((sum, i) => sum + i.memory, 0);
    goBtn.textContent = items.length ? `End ${items.length} · free ${fmtBytes(bytes)}` : 'Nothing selected';
    goBtn.disabled = items.length === 0 || !ack.checked;
  };

  body.querySelectorAll('[data-item]').forEach((box) => {
    box.addEventListener('change', () => {
      const pid = Number(box.dataset.item);
      if (box.checked) selected.add(pid); else selected.delete(pid);
      const cat = box.closest('.qc-cat');
      const boxes = [...cat.querySelectorAll('[data-item]')];
      cat.querySelector('[data-cat-check]').checked = boxes.every((b) => b.checked);
      sync();
    });
  });

  body.querySelectorAll('[data-cat-check]').forEach((box) => {
    box.addEventListener('change', (event) => {
      event.stopPropagation();
      const cat = data.categories.find((c) => c.id === box.dataset.catCheck);
      for (const item of cat.items) {
        if (box.checked) selected.add(item.pid); else selected.delete(item.pid);
      }
      body.querySelectorAll(`[data-item]`).forEach((itemBox) => {
        if (cat.items.some((i) => i.pid === Number(itemBox.dataset.item))) itemBox.checked = box.checked;
      });
      sync();
    });
  });

  foot.querySelector('[data-recommend]').addEventListener('click', () => {
    state.qcSelected = new Set(data.recommendedPids || []);
    renderQuickClean(modal, data);
  });
  foot.querySelector('[data-cancel]').addEventListener('click', closeModal);
  ack.addEventListener('change', sync);
  goBtn.addEventListener('click', () => {
    const items = data.categories.flatMap((c) => c.items).filter((i) => selected.has(i.pid));
    confirmEnd({
      pids: items.map((i) => i.pid),
      tree: false,
      confirmations: {},
      names: items.map((i) => i.name),
      memory: items.reduce((sum, i) => sum + i.memory, 0),
    });
  });
  sync();
}

// -------------------------------------------------------------- more menu ---

function setMoreMenu(open) {
  $('#more-menu').classList.toggle('hidden', !open);
  $('#btn-more').setAttribute('aria-expanded', String(open));
}

function exportReport() {
  // The report endpoint needs the session token, so fetch it and build a blob
  // instead of pointing the browser at the URL.
  api('/api/report').then((data) => {
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `task-manager-2-report-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.json`;
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
    toast('ok', 'Report exported', `${data.snapshot?.counts?.processes ?? 'All'} processes written to JSON.`);
  }).catch((error) => toast('err', 'Could not export', error.message));
}

// ------------------------------------------------------------------- pages --

function setPage(page) {
  state.page = page === 'graphs' ? 'graphs' : 'processes';
  document.querySelectorAll('.nav-item[data-page]').forEach((button) => {
    const on = button.dataset.page === state.page;
    button.classList.toggle('active', on);
    button.setAttribute('aria-current', on ? 'page' : 'false');
  });
  $('#page-processes').classList.toggle('hidden', state.page !== 'processes');
  $('#page-graphs').classList.toggle('hidden', state.page !== 'graphs');
  render();
}

// ------------------------------------------------------------------ graphs --

const GRAPH_PREFS_KEY = 'tm2.graphs';

function saveGraphPrefs() {
  try {
    localStorage.setItem(GRAPH_PREFS_KEY, JSON.stringify({
      window: state.graphWindow,
      fill: state.graphFill,
      grid: state.graphGrid,
    }));
  } catch { /* storage unavailable */ }
}

function hydrateGraphPrefs() {
  try {
    const saved = JSON.parse(localStorage.getItem(GRAPH_PREFS_KEY) || 'null');
    if (!saved) return;
    if ([30, 60, 300, 600].includes(Number(saved.window))) state.graphWindow = Number(saved.window);
    if (typeof saved.fill === 'boolean') state.graphFill = saved.fill;
    if (typeof saved.grid === 'boolean') state.graphGrid = saved.grid;
  } catch { /* storage unavailable: keep defaults */ }
}

function pushHistory(snap) {
  state.history.push({
    t: Date.now(),
    cpu: Number(snap.load?.cpu) || 0,
    ram: Number(snap.memory?.percent) || 0,
    disk: Number(snap.load?.disk) || 0,
    procs: Number(snap.counts?.processes) || 0,
  });
  const keepSeconds = Math.max(state.graphWindow, 60);
  const cutoff = Date.now() - keepSeconds * 1000;
  while (state.history.length && state.history[0].t < cutoff) state.history.shift();
  if (state.history.length > 4000) state.history.splice(0, state.history.length - 4000);

  // Per-process CPU trace, drawn as the little line under each process name.
  const seen = new Set();
  for (const proc of snap.processes || []) {
    seen.add(proc.pid);
    const series = state.procHistory.get(proc.pid) || [];
    series.push(Number(proc.cpu) || 0);
    if (series.length > 32) series.shift();
    state.procHistory.set(proc.pid, series);
  }
  for (const pid of [...state.procHistory.keys()]) {
    if (!seen.has(pid)) state.procHistory.delete(pid);
  }
}

function renderGraphs() {
  const snap = state.snap;
  if (!snap) return;
  const samples = state.history.length;
  const span = samples > 1 ? Math.round((state.history[samples - 1].t - state.history[0].t) / 1000) : 0;

  $('#graphs-sub').textContent = samples < 2
    ? 'Collecting samples — the lines appear after the second refresh.'
    : `${samples} samples over ${span}s · showing the last ${state.graphWindow}s · one sample every ${Math.round(state.pollMs / 1000)}s`;

  const cpu = snap.load?.cpu;
  const ram = snap.memory?.percent;
  const disk = snap.load?.disk;
  $('#g-cpu-now').textContent = fmtPct(cpu);
  $('#g-ram-now').textContent = fmtPct(ram);
  $('#g-disk-now').textContent = disk == null ? '–' : fmtPct(disk);
  $('#g-both-now').textContent = `${fmtPct(cpu)} / ${fmtPct(ram)}`;
  $('#g-cpu-foot').textContent = `${snap.os?.cores ?? '?'} logical cores`;
  $('#g-ram-foot').textContent = `${fmtBytes(snap.memory?.used)} of ${fmtBytes(snap.memory?.total)}`;
  $('#g-disk-foot').textContent = 'busy time, sampled by TM2';

  drawChart($('#chart-cpu'), [{ key: 'cpu', color: '#38bdf8' }]);
  drawChart($('#chart-ram'), [{ key: 'ram', color: '#4ade80' }]);
  drawChart($('#chart-disk'), [{ key: 'disk', color: '#fbbf24' }]);
  drawChart($('#chart-both'), [{ key: 'cpu', color: '#38bdf8' }, { key: 'ram', color: '#4ade80' }]);
}

function drawChart(canvas, series) {
  if (!canvas) return;
  const dpr = window.devicePixelRatio || 1;
  const cssWidth = canvas.clientWidth || canvas.parentElement?.clientWidth || 320;
  const cssHeight = canvas.clientHeight || 108;
  if (canvas.width !== Math.round(cssWidth * dpr) || canvas.height !== Math.round(cssHeight * dpr)) {
    canvas.width = Math.round(cssWidth * dpr);
    canvas.height = Math.round(cssHeight * dpr);
  }
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, cssWidth, cssHeight);

  if (state.graphGrid) {
    ctx.strokeStyle = 'rgba(120, 150, 175, 0.16)';
    ctx.lineWidth = 1;
    for (let i = 0; i <= 4; i += 1) {
      const y = 4 + ((cssHeight - 8) * i) / 4;
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(cssWidth, y);
      ctx.stroke();
    }
  }

  const now = Date.now();
  const start = now - state.graphWindow * 1000;
  const points = state.history.filter((h) => h.t >= start);

  if (points.length < 2) {
    ctx.fillStyle = 'rgba(150, 170, 190, 0.55)';
    ctx.font = '11px ui-monospace, monospace';
    ctx.fillText('waiting for samples', 6, cssHeight / 2);
    return;
  }

  const xOf = (t) => ((t - start) / (state.graphWindow * 1000)) * cssWidth;
  const yOf = (v) => cssHeight - 4 - (Math.max(0, Math.min(100, v)) / 100) * (cssHeight - 8);

  for (const s of series) {
    ctx.beginPath();
    points.forEach((point, index) => {
      const x = xOf(point.t);
      const y = yOf(point[s.key]);
      if (index === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    });
    ctx.strokeStyle = s.color;
    ctx.lineWidth = 1.8;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.stroke();

    if (state.graphFill) {
      const gradient = ctx.createLinearGradient(0, 0, 0, cssHeight);
      gradient.addColorStop(0, `${s.color}44`);
      gradient.addColorStop(1, `${s.color}00`);
      ctx.lineTo(xOf(points[points.length - 1].t), cssHeight);
      ctx.lineTo(xOf(points[0].t), cssHeight);
      ctx.closePath();
      ctx.fillStyle = gradient;
      ctx.fill();
    }
  }
}

// ----------------------------------------------------------------- settings --

function paintIntervalLabel() {
  const seconds = Math.round(state.pollMs / 1000);
  const label = $('#status-interval');
  if (label) label.textContent = `${seconds}s`;
  const slider = $('#set-interval');
  if (slider) {
    slider.value = String(seconds);
    const pct = ((seconds - Number(slider.min)) / (Number(slider.max) - Number(slider.min))) * 100;
    slider.style.setProperty('--fill', `${pct}%`);
  }
  const value = $('#set-interval-value');
  if (value) value.textContent = `${seconds}s`;
}

function setPollInterval(ms, { reschedule = true } = {}) {
  state.pollMs = Math.max(1000, Math.min(15000, Math.round(ms)));
  try { localStorage.setItem('tm2.pollMs', String(state.pollMs)); } catch {}
  paintIntervalLabel();
  if (reschedule) schedule();
}

const SETTINGS_TABS = [
  { id: 'processes', label: 'Processes' },
  { id: 'graphs', label: 'Graphs' },
  { id: 'about', label: 'About' },
];

function systemNote() {
  return state.showSystem
    ? 'System and protected processes are listed by default and labelled. TM2 never removes them from the list.'
    : 'System processes are currently hidden by your own filter, not by Task Manager 2. The count stays visible in the status bar.';
}

function openSettings(tab = state.settingsTab) {
  const modal = el('div', 'modal wide settings-modal');
  modal.innerHTML = `
    <div class="modal-head">
      <h2>Settings</h2>
      <p>Everything that used to sit in the sidebar lives here, split into tabs. Changes apply immediately and are remembered on this machine.</p>
    </div>
    <div class="tabs" role="tablist">
      ${SETTINGS_TABS.map((t) => `<button class="tab" role="tab" data-tab="${t.id}">${t.label}</button>`).join('')}
    </div>
    <div class="modal-body" id="settings-body"></div>
    <div class="modal-foot"><button class="btn" data-close>Done</button></div>`;

  openModal(modal);
  modal.querySelector('[data-close]').addEventListener('click', closeModal);
  modal.querySelector('.tabs').addEventListener('click', (event) => {
    const button = event.target.closest('[data-tab]');
    if (button) selectSettingsTab(modal, button.dataset.tab);
  });
  selectSettingsTab(modal, tab);
}

function selectSettingsTab(modal, tab) {
  const known = SETTINGS_TABS.some((t) => t.id === tab) ? tab : 'processes';
  state.settingsTab = known;
  modal.querySelectorAll('.tab').forEach((button) => {
    const on = button.dataset.tab === known;
    button.classList.toggle('active', on);
    button.setAttribute('aria-selected', String(on));
  });
  const body = modal.querySelector('#settings-body');
  body.innerHTML = known === 'graphs' ? graphsSettingsHtml()
    : known === 'about' ? aboutSettingsHtml()
      : processesSettingsHtml();
  if (known === 'processes') bindProcessesSettings(modal, body);
  if (known === 'graphs') bindGraphsSettings(body);
}

function processesSettingsHtml() {
  const snap = state.snap;
  const views = VIEWS.map((view) => {
    const count = snap ? snap.processes.filter(view.test).length : 0;
    return `<button class="rail-item${state.view === view.id ? ' active' : ''}" data-set-view="${view.id}">
      <span>${esc(view.label)}</span><span class="count">${count}</span></button>`;
  }).join('');

  const presets = [
    ['cpu:desc', 'Busiest first'],
    ['ws:desc', 'Biggest memory'],
    ['start:desc', 'Newest first'],
    ['name:asc', 'Name A→Z'],
    ['pid:asc', 'PID'],
  ].map(([spec, label]) => {
    const [key, dir] = spec.split(':');
    const on = state.sorts.length === 1 && state.sorts[0].key === key && state.sorts[0].dir === dir;
    return `<button class="rail-item${on ? ' active' : ''}" data-set-sort="${spec}">${esc(label)}</button>`;
  }).join('');

  return `
    <div class="setting">
      <div class="setting-head"><label>View</label><span class="setting-hint">what the process list shows</span></div>
      <div class="settings-list">${views}</div>
    </div>
    <div class="setting">
      <div class="setting-head"><label>Sort presets</label><span class="setting-hint">or click a column header</span></div>
      <div class="settings-list">${presets}</div>
    </div>
    <div class="setting">
      <div class="setting-head"><label>Options</label></div>
      <label class="switch">
        <input type="checkbox" id="set-group" ${state.group ? 'checked' : ''} />
        <span class="switch-track"><i></i></span>
        <span>Group by app</span>
      </label>
      <label class="switch">
        <input type="checkbox" id="set-system" ${state.showSystem ? 'checked' : ''} />
        <span class="switch-track"><i></i></span>
        <span>Show system processes</span>
      </label>
      <p class="setting-note" id="set-system-note">${esc(systemNote())}</p>
    </div>
    <div class="setting">
      <div class="setting-head">
        <label for="set-interval">Refresh interval</label>
        <b id="set-interval-value">${Math.round(state.pollMs / 1000)}s</b>
      </div>
      <input type="range" id="set-interval" min="1" max="15" step="1" value="${Math.round(state.pollMs / 1000)}" />
      <div class="range-ticks"><span>1s — fresher, a little more CPU</span><span>15s</span></div>
    </div>
    <div class="setting">
      <div class="setting-head"><label for="set-live">Live updates</label></div>
      <label class="check-line">
        <input type="checkbox" id="set-live" ${state.live ? 'checked' : ''} />
        <span>Keep reading the machine while the window is open. Turning this off freezes the list where it is.</span>
      </label>
    </div>`;
}

function bindProcessesSettings(modal, body) {
  body.querySelectorAll('[data-set-view]').forEach((button) => {
    button.addEventListener('click', () => {
      state.view = button.dataset.setView;
      body.querySelectorAll('[data-set-view]').forEach((b) => b.classList.toggle('active', b === button));
      render();
    });
  });

  body.querySelectorAll('[data-set-sort]').forEach((button) => {
    button.addEventListener('click', () => {
      const [key, dir] = button.dataset.setSort.split(':');
      state.sorts = [{ key, dir }];
      body.querySelectorAll('[data-set-sort]').forEach((b) => b.classList.toggle('active', b === button));
      render();
    });
  });

  body.querySelector('#set-group').addEventListener('change', (event) => {
    state.group = event.target.checked;
    state.expanded.clear();
    render();
  });

  body.querySelector('#set-system').addEventListener('change', (event) => {
    state.showSystem = event.target.checked;
    body.querySelector('#set-system-note').textContent = systemNote();
    render();
  });

  const slider = body.querySelector('#set-interval');
  const pct = ((Math.round(state.pollMs / 1000) - 1) / 14) * 100;
  slider.style.setProperty('--fill', `${pct}%`);
  slider.addEventListener('input', () => {
    setPollInterval(Number(slider.value) * 1000, { reschedule: false });
  });
  slider.addEventListener('change', () => {
    schedule();
    if (state.live) refresh(true);
  });

  body.querySelector('#set-live').addEventListener('change', (event) => {
    state.live = event.target.checked;
    if (state.live) refresh(true);
  });
}

function graphsSettingsHtml() {
  const choices = [['30', '30s'], ['60', '1 min'], ['300', '5 min'], ['600', '10 min']]
    .map(([value, label]) => `<button data-set-window="${value}" class="${state.graphWindow === Number(value) ? 'active' : ''}">${label}</button>`)
    .join('');
  return `
    <div class="setting">
      <div class="setting-head"><label>History window</label><b id="set-window-value">${state.graphWindow}s</b></div>
      <div class="seg" id="set-window">${choices}</div>
      <p class="setting-note">How much history the graphs keep and draw. A longer window takes longer to fill after the window opens.</p>
    </div>
    <div class="setting">
      <div class="setting-head"><label>Chart style</label></div>
      <label class="check-line"><input type="checkbox" id="set-fill" ${state.graphFill ? 'checked' : ''} /><span>Fill the area under each line</span></label>
      <label class="check-line"><input type="checkbox" id="set-grid" ${state.graphGrid ? 'checked' : ''} /><span>Show horizontal grid lines</span></label>
    </div>
    <div class="setting">
      <div class="setting-head"><label>Samples held</label><b id="set-samples">${state.history.length}</b></div>
      <p class="setting-note">One sample is taken every time the process list refreshes. Change how often that happens on the Processes tab.</p>
    </div>`;
}

function bindGraphsSettings(body) {
  body.querySelectorAll('[data-set-window]').forEach((button) => {
    button.addEventListener('click', () => {
      state.graphWindow = Number(button.dataset.setWindow);
      saveGraphPrefs();
      body.querySelectorAll('[data-set-window]').forEach((b) => b.classList.toggle('active', b === button));
      body.querySelector('#set-window-value').textContent = `${state.graphWindow}s`;
      if (state.page === 'graphs') renderGraphs();
    });
  });
  body.querySelector('#set-fill').addEventListener('change', (event) => {
    state.graphFill = event.target.checked;
    saveGraphPrefs();
    if (state.page === 'graphs') renderGraphs();
  });
  body.querySelector('#set-grid').addEventListener('change', (event) => {
    state.graphGrid = event.target.checked;
    saveGraphPrefs();
    if (state.page === 'graphs') renderGraphs();
  });
}

function aboutSettingsHtml() {
  const snap = state.snap;
  const rows = snap ? machineEntries(snap) : [['Host', '–']];
  return `
    <div class="setting">
      <div class="setting-head"><label>This machine</label></div>
      <dl class="kv settings-kv">${rows.map(([k, v]) => `<dt>${esc(k)}</dt><dd title="${esc(v)}">${esc(v)}</dd>`).join('')}</dl>
    </div>
    <div class="setting">
      <div class="setting-head"><label>Build</label></div>
      <dl class="kv settings-kv">
        <dt>Version</dt><dd>beta 1.5</dd>
        <dt>Channel</dt><dd>pre-release</dd>
        <dt>Protection</dt><dd>5 tiers, re-checked on every end request</dd>
      </dl>
      <p class="setting-note">Betas stay pre-releases until the owner confirms one. Nothing is ever marked Latest.</p>
    </div>`;
}

// --------------------------------------------------------------- clean menu --

const CLEAN_IDS = ['cpu', 'gpu', 'ram', 'internet', 'storage'];
const CLEAN_PREFS_KEY = 'tm2.cleanPrefs';

function hydrateCleanPrefs() {
  try {
    const saved = JSON.parse(localStorage.getItem(CLEAN_PREFS_KEY) || 'null');
    if (saved && typeof saved === 'object') {
      for (const id of CLEAN_IDS) {
        if (typeof saved[id] === 'boolean') state.cleanPrefs[id] = saved[id];
      }
    }
  } catch { /* storage unavailable: keep defaults */ }
  syncCleanInputs();
}

function saveCleanPrefs() {
  try { localStorage.setItem(CLEAN_PREFS_KEY, JSON.stringify(state.cleanPrefs)); } catch {}
}

function syncCleanInputs() {
  document.querySelectorAll('[data-clean]').forEach((box) => {
    box.checked = Boolean(state.cleanPrefs[box.dataset.clean]);
  });
  syncCleanButton();
}

function selectedCleanCategories() {
  return CLEAN_IDS.filter((id) => state.cleanPrefs[id]);
}

function syncCleanButton() {
  const button = $('#btn-clean-run');
  const count = selectedCleanCategories().length;
  button.disabled = count === 0 || state.cleanBusy;
  button.textContent = state.cleanBusy ? 'Cleaning…' : count === 0 ? 'Nothing ticked' : `Clean ${count}`;
}

function setCleanMenu(open) {
  $('#clean-menu').classList.toggle('hidden', !open);
  $('#btn-clean').setAttribute('aria-expanded', String(open));
  if (open) {
    syncCleanInputs();
    loadCleanPreview();
  }
}

async function loadCleanPreview() {
  const setStat = (id, text) => {
    const node = document.querySelector(`[data-clean-stat="${id}"]`);
    if (node) node.textContent = text;
  };
  CLEAN_IDS.forEach((id) => setStat(id, '…'));
  try {
    const data = await api('/api/clean/preview');
    state.cleanPreview = data;
    setStat('cpu', data.cpu.count ? `${data.cpu.count} busy` : 'idle');
    setStat('gpu', data.gpu.bytes ? fmtBytes(data.gpu.bytes) : 'empty');
    setStat('ram', data.ram.count ? `${data.ram.count} · ${fmtBytes(data.ram.bytes)}` : 'nothing idle');
    setStat('internet', 'ready');
    setStat('storage', data.storage.bytes ? `${data.storage.files} · ${fmtBytes(data.storage.bytes)}` : 'clean');
  } catch {
    CLEAN_IDS.forEach((id) => setStat(id, 'n/a'));
  }
}

async function runCleanNow() {
  const ticked = selectedCleanCategories();
  if (!ticked.length) return;
  const fileCategories = ticked.filter((id) => id !== 'cpu');
  const wantsCpu = ticked.includes('cpu');
  setCleanMenu(false);

  if (fileCategories.length) {
    state.cleanBusy = true;
    syncCleanButton();
    try {
      const result = await api('/api/clean', { method: 'POST', body: { categories: fileCategories } });
      const parts = [];
      const r = result.results || {};
      if (r.ram) parts.push(`trimmed ${r.ram.trimmed} processes`);
      if (r.gpu) parts.push(`GPU cache ${fmtBytes(r.gpu.freedBytes)}`);
      if (r.storage) parts.push(`${r.storage.files} temp files ${fmtBytes(r.storage.freedBytes)}`);
      if (r.internet?.flushed) parts.push('DNS flushed');
      toast('ok', result.freedBytes > 0 ? `Freed ${fmtBytes(result.freedBytes)}` : 'Clean finished',
        parts.join(' · ') || 'Nothing needed removing.', 9000);
      const skipped = (r.storage?.failed || 0) + (r.gpu?.failed || 0);
      if (skipped) toast('ok', `${skipped} file${skipped === 1 ? '' : 's'} skipped`, 'In use by a running app.', 6000);
    } catch (error) {
      toast('err', 'Clean failed', error.message, 9000);
    } finally {
      state.cleanBusy = false;
      syncCleanButton();
      await refresh(true);
    }
  }

  // CPU is the one destructive category: it goes through the reviewed list.
  if (wantsCpu) openProcessReview();
}

// -------------------------------------------------------------------- data --

let pollTimer = null;
let ticking = false;

async function refresh(force = false) {
  if (ticking && !force) return;
  ticking = true;
  try {
    const data = await api(`/api/snapshot${force ? '?fresh=1' : ''}`);
    state.snap = data;
    state.error = null;
    pushHistory(data);
    if (state.focused && !data.processes.some((p) => p.pid === state.focused)) {
      state.focused = null;
      state.detailPid = null;
      state.detail = null;
      $('#detail').classList.add('hidden');
      $('.layout').classList.remove('with-detail');
    }
    // Drop selections for processes that no longer exist.
    for (const pid of [...state.selected]) {
      if (!data.processes.some((p) => p.pid === pid)) state.selected.delete(pid);
    }
    render();
  } catch (error) {
    state.error = error.message;
    renderStatus(0, 0, state.snap?.counts?.processes || 0);
  } finally {
    ticking = false;
  }
}

function schedule() {
  clearInterval(pollTimer);
  pollTimer = setInterval(() => {
    if (!state.live || document.hidden) return;
    refresh();
  }, state.pollMs);
}

// ------------------------------------------------------------------ render --

function render() {
  updateHeaderStats();
  if (state.page === 'processes') {
    renderSortChips();
    renderRows();
  } else {
    renderGraphs();
  }
  if (state.page === 'processes' && state.focused) {
    const proc = byPid().get(state.focused);
    if (proc) renderDetail(proc);
  } else {
    $('#detail').classList.add('hidden');
    $('.layout').classList.remove('with-detail');
  }
  const ageLabel = state.snap?.sampler?.age != null ? `${Math.round(state.snap.sampler.age / 100) / 10}s old` : '–';
  $('#status-updated').title = `Snapshot age: ${ageLabel}`;
}

// ------------------------------------------------------------------ events --

function wire() {
  $('#search').addEventListener('input', (event) => {
    state.q = event.target.value;
    renderRows();
  });

  // Page navigation ---------------------------------------------------------
  document.querySelectorAll('.nav-item[data-page]').forEach((button) => {
    button.addEventListener('click', () => setPage(button.dataset.page));
  });
  window.addEventListener('resize', () => {
    if (state.page === 'graphs') renderGraphs();
  });

  document.querySelectorAll('.grid thead th[data-sort-key]').forEach((th) => {
    th.addEventListener('click', (event) => setSort(th.dataset.sortKey, { additive: event.shiftKey }));
  });

  $('#btn-clear-sort').addEventListener('click', () => {
    state.sorts = [];
    render();
  });

  $('#select-all').addEventListener('change', (event) => {
    const boxes = [...document.querySelectorAll('#rows input[data-check]')];
    for (const box of boxes) {
      const pid = Number(box.dataset.check);
      if (event.target.checked) state.selected.add(pid); else state.selected.delete(pid);
    }
    renderRows();
  });

  $('#rows').addEventListener('click', (event) => {
    if (event.target.id === 'select-all') return;
    const check = event.target.closest('input[data-check]');
    if (check) {
      const pid = Number(check.dataset.check);
      if (check.checked) state.selected.add(pid); else state.selected.delete(pid);
      event.stopPropagation();
      renderRows();
      return;
    }
    const groupCheck = event.target.closest('input[data-group-check]');
    if (groupCheck) {
      event.stopPropagation();
      const key = groupCheck.dataset.groupCheck;
      const group = computeRows().rows.find((r) => r.type === 'group' && r.group.key === key)?.group;
      if (group) {
        for (const pid of group.pids) {
          if (groupCheck.checked) state.selected.add(pid); else state.selected.delete(pid);
        }
      }
      renderRows();
      return;
    }
    const groupRow = event.target.closest('tr.group-row');
    if (groupRow) {
      const key = groupRow.dataset.group;
      if (state.expanded.has(key)) state.expanded.delete(key); else state.expanded.add(key);
      renderRows();
      return;
    }
    const row = event.target.closest('tr[data-pid]');
    if (row) selectProcess(Number(row.dataset.pid));
  });

  $('#rows').addEventListener('dblclick', (event) => {
    const row = event.target.closest('tr[data-pid]');
    if (row) openEndDialog([Number(row.dataset.pid)]);
  });

  $('#detail-close').addEventListener('click', () => {
    state.focused = null;
    state.detailPid = null;
    state.detail = null;
    $('#detail').classList.add('hidden');
    $('.layout').classList.remove('with-detail');
    renderRows();
  });

  $('#detail-end').addEventListener('click', () => {
    if (state.focused) openEndDialog([state.focused]);
  });
  $('#detail-tree').addEventListener('click', () => {
    if (state.focused) openEndDialog([state.focused], { tree: true });
  });

  $('#btn-end-selected').addEventListener('click', () => openEndDialog([...state.selected]));
  $('#btn-clear-selection').addEventListener('click', () => {
    state.selected.clear();
    renderRows();
  });

  // Clean dropdown ---------------------------------------------------------
  $('#btn-clean').addEventListener('click', (event) => {
    event.stopPropagation();
    setCleanMenu($('#clean-menu').classList.contains('hidden'));
  });
  $('#clean-menu').addEventListener('click', (event) => event.stopPropagation());
  document.addEventListener('click', () => {
    if (!$('#clean-menu').classList.contains('hidden')) setCleanMenu(false);
  });
  document.querySelectorAll('[data-clean]').forEach((box) => {
    box.addEventListener('change', () => {
      state.cleanPrefs[box.dataset.clean] = box.checked;
      saveCleanPrefs();
      syncCleanButton();
    });
  });
  $('#btn-clean-refresh').addEventListener('click', (event) => {
    event.stopPropagation();
    loadCleanPreview();
  });
  $('#btn-clean-run').addEventListener('click', (event) => {
    event.stopPropagation();
    runCleanNow();
  });
  // More menu (⋯) ----------------------------------------------------------
  $('#btn-more').addEventListener('click', (event) => {
    event.stopPropagation();
    setMoreMenu($('#more-menu').classList.contains('hidden'));
  });
  $('#more-menu').addEventListener('click', (event) => event.stopPropagation());
  document.addEventListener('click', () => {
    if (!$('#more-menu').classList.contains('hidden')) setMoreMenu(false);
  });
  document.querySelectorAll('[data-more]').forEach((button) => {
    button.addEventListener('click', () => {
      setMoreMenu(false);
      if (button.dataset.more === 'settings') openSettings();
      if (button.dataset.more === 'report') exportReport();
    });
  });

  $('#btn-clear-view').addEventListener('click', () => {
    state.q = '';
    state.view = 'all';
    state.showSystem = true;
    $('#search').value = '';
    render();
  });

  $('#btn-elevate').addEventListener('click', async () => {
    if (window.tm2?.relaunchAsAdmin) {
      const result = await window.tm2.relaunchAsAdmin();
      if (!result?.ok) toast('err', 'Could not elevate', result?.error || 'Windows refused the elevation prompt.');
    } else {
      toast('ok', 'Restart as administrator', 'Close this window, then right-click start-desktop.bat and choose "Run as administrator".');
    }
  });

  document.addEventListener('keydown', (event) => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'f') {
      event.preventDefault();
      $('#search').focus();
      $('#search').select();
      return;
    }
    if (event.key === 'Escape' && !state.modal) {
      if (state.focused) {
        state.focused = null;
        state.detailPid = null;
        state.detail = null;
        $('#detail').classList.add('hidden');
        $('.layout').classList.remove('with-detail');
        renderRows();
      }
      return;
    }
    if (event.key === 'Delete' && !state.modal) {
      const pids = state.selected.size ? [...state.selected] : state.focused ? [state.focused] : [];
      if (pids.length) openEndDialog(pids);
    }
  });

  setInterval(() => {
    if (state.snap) {
      const age = state.snap.sampler?.age;
      if (age != null) $('#status-updated').textContent = `sampled ${Math.round(age / 100) / 10}s ago`;
    }
  }, 1000);
}

// -------------------------------------------------------------------- boot --

wire();
hydrateCleanPrefs();
hydrateGraphPrefs();
try {
  const savedInterval = Number(localStorage.getItem('tm2.pollMs'));
  if (Number.isFinite(savedInterval) && savedInterval >= 1000 && savedInterval <= 15000) state.pollMs = savedInterval;
} catch { /* storage unavailable */ }
paintIntervalLabel();
schedule();
refresh(true);
setInterval(() => { if (state.snap && !document.hidden) updateHeaderStats(); }, 15000);
