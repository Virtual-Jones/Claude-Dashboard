/* Renderer: read-only view over the usage snapshot pushed from main. */

const $ = (id) => document.getElementById(id);

let latest = null;
let detailWin = 'week'; // 'block' | 'today' | 'week'

// ---- formatting -------------------------------------------------------------

function fmtTok(n) {
  n = n || 0;
  if (n >= 1e9) return (n / 1e9).toFixed(2) + 'B';
  if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'k';
  return String(Math.round(n));
}
function fmtUSD(n) {
  n = n || 0;
  if (n >= 1000) return '$' + n.toLocaleString('en-US', { maximumFractionDigits: 0 });
  return '$' + n.toFixed(2);
}
function pctText(p) {
  if (p == null || !isFinite(p)) return '—';
  return Math.round(p * 100) + '%';
}
function shortReset(ts) {
  if (!ts) return '—';
  try {
    return new Date(ts).toLocaleString(undefined, {
      weekday: 'short',
      hour: 'numeric',
      minute: '2-digit',
    });
  } catch (_) {
    return '—';
  }
}
function liveErrorText(live) {
  const msg = live && live.error ? live.error : 'reason unknown';
  return `Live account usage unavailable (${msg}) — showing local estimate from Claude Code logs.`;
}
function sevColor(p) {
  if (p >= 0.85) return '#E81123';
  if (p >= 0.6) return '#F7630C';
  return '#3A96DD';
}
function durText(ms) {
  if (ms <= 0) return 'now';
  const m = Math.floor(ms / 60000);
  const h = Math.floor(m / 60);
  if (h >= 1) return `${h}h ${m % 60}m`;
  if (m >= 1) return `${m}m`;
  return `${Math.floor(ms / 1000)}s`;
}
function agoText(ts) {
  const s = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (s < 60) return `Updated ${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `Updated ${m}m ago`;
  return `Updated ${Math.floor(m / 60)}h ago`;
}
// Compact "how long since" for the last local Claude Code message. Without this
// an idle Code section (no new messages) looks indistinguishable from a stuck one.
function sinceText(ts) {
  const ms = Date.now() - ts;
  if (ms < 60000) return 'just now';
  const m = Math.floor(ms / 60000);
  const h = Math.floor(m / 60);
  const d = Math.floor(h / 24);
  if (d >= 1) return `${d}d ago`;
  if (h >= 1) return `${h}h ago`;
  return `${m}m ago`;
}

function modelInfo(id) {
  const m = String(id).toLowerCase();
  let color = '#8a8f98';
  let family = '';
  if (m.includes('opus')) { color = '#a06cf0'; family = 'Opus'; }
  else if (m.includes('sonnet')) { color = '#4c8ef7'; family = 'Sonnet'; }
  else if (m.includes('haiku')) { color = '#12b5a5'; family = 'Haiku'; }
  else if (m.includes('fable')) { color = '#d16ba5'; family = 'Fable'; }
  const v = (m.match(/(?:opus|sonnet|haiku|fable)-(\d+(?:-\d+)?)/) || [])[1];
  const ver = v ? v.replace('-', '.') : '';
  return { name: family ? `${family}${ver ? ' ' + ver : ''}` : id, color };
}

// ---- SVG donut gauge --------------------------------------------------------

function donut(pct, color, size = 104, stroke = 11) {
  const r = (size - stroke) / 2 - 1;
  const c = 2 * Math.PI * r;
  const off = c * (1 - Math.max(0, Math.min(1, pct)));
  const cx = size / 2;
  return `<svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
    <circle cx="${cx}" cy="${cx}" r="${r}" fill="none"
      stroke="var(--track)" stroke-width="${stroke}" />
    <circle cx="${cx}" cy="${cx}" r="${r}" fill="none"
      stroke="${color}" stroke-width="${stroke}" stroke-linecap="round"
      stroke-dasharray="${c.toFixed(2)}" stroke-dashoffset="${off.toFixed(2)}"
      transform="rotate(-90 ${cx} ${cx})" />
  </svg>`;
}

// ---- render -----------------------------------------------------------------

function render() {
  if (!latest) return;
  const bars = latest.bars || {};
  const live = latest.live || {};
  const isLive = bars.source === 'live';

  // Source banner + header subtitle
  const banner = $('srcBanner');
  banner.hidden = isLive;
  if (!isLive) banner.textContent = liveErrorText(live);
  $('planSub').textContent = isLive
    ? live.stale
      ? 'Live · cached'
      : 'Live account usage'
    : 'Local estimate';

  // Current session gauge (authoritative %)
  const s = bars.session || {};
  $('sessionGauge').innerHTML = donut(s.pct || 0, sevColor(s.pct || 0));
  $('sessionPct').textContent = pctText(s.pct);
  $('sessionCap').textContent = isLive ? 'of limit' : 'of est. cap';
  $('statusDot').style.background = s.pct != null ? sevColor(s.pct) : 'var(--text-3)';

  // Weekly — all models
  const w = bars.weekAll || {};
  $('weekPct').textContent = pctText(w.pct);
  setBar('weekBar', w.pct || 0);

  // Per-model weekly tiles (Opus, Fable, …)
  renderModelTiles(bars.models || []);

  updateReset();
  renderDetail();
  const local = latest.local || {};
  $('lastActive').textContent = local.lastActivity
    ? ` · last active ${sinceText(local.lastActivity)}`
    : '';
  $('updated').textContent =
    agoText(latest.generatedAt) + ` · ${local.filesScanned || 0} logs`;
}

function setBar(id, pct) {
  const el = $(id);
  el.style.width = Math.min(100, Math.max(2, pct * 100)) + '%';
  el.style.background = sevColor(pct);
}

function renderModelTiles(models) {
  const wrap = $('modelTiles');
  wrap.style.display = models.length ? '' : 'none';
  const isLive = (latest.bars || {}).source === 'live';
  wrap.innerHTML = models
    .map((m) => {
      const color = modelInfo(m.family).color;
      const p = m.pct;
      const w = Math.min(100, Math.max(2, (p || 0) * 100));
      const foot = !isLive
        ? 'of est. cap'
        : m.resetsAt
        ? 'resets ' + shortReset(m.resetsAt)
        : 'weekly limit';
      return `<section class="card tile">
        <div class="tile-head"><span class="model-swatch" style="background:${color}"></span>${m.label} <span class="badge">weekly</span></div>
        <div class="tile-tokens">${pctText(p)}</div>
        <div class="bar"><div class="bar-fill" style="width:${w}%;background:${sevColor(p || 0)}"></div></div>
        <div class="tile-foot">${foot}</div>
      </section>`;
    })
    .join('');
}

function updateReset() {
  if (!latest) return;
  const bars = latest.bars || {};
  const isLive = bars.source === 'live';

  // Session countdown
  const s = bars.session || {};
  const sEl = $('sessionReset');
  if (s.resetsAt) {
    sEl.innerHTML = `Resets in <b style="color:var(--text-1)">${durText(s.resetsAt - Date.now())}</b>`;
  } else {
    sEl.textContent = isLive ? 'No active session' : 'Idle — no active session';
  }

  // Session sub: local Code tokens in the current block
  const block = (latest.local || {}).block || {};
  $('sessionSub').textContent = block.tokens
    ? `${fmtTok(block.tokens)} tokens via Claude Code`
    : '';

  // Week all-models foot
  const w = bars.weekAll || {};
  $('weekFoot').innerHTML = isLive
    ? w.resetsAt
      ? `resets ${shortReset(w.resetsAt)}`
      : 'all models'
    : '<span>of est. cap</span>';
}

const COMP = [
  { key: 'input', label: 'Input', color: '#4c8ef7' },
  { key: 'output', label: 'Output', color: '#2ea043' },
  { key: 'cacheCreate', label: 'Cache write', color: '#d98a00' },
  { key: 'cacheRead', label: 'Cache read', color: '#8a8f98' },
];

function renderDetail() {
  const local = latest.local || {};
  const b = local[detailWin] || local.week || {};

  $('detailValue').textContent = fmtUSD(b.cost);
  $('detailMsgs').textContent = (b.messages || 0).toLocaleString('en-US') + ' msgs';

  // Composition stacked bar
  const total = (b.input || 0) + (b.output || 0) + (b.cacheCreate || 0) + (b.cacheRead || 0);
  const comp = $('composition');
  const legend = $('compLegend');
  if (total <= 0) {
    comp.innerHTML = '<span style="width:100%;background:var(--track)"></span>';
    legend.innerHTML = '';
  } else {
    comp.innerHTML = COMP.map((c) => {
      const w = (b[c.key] / total) * 100;
      return `<span style="width:${w}%;background:${c.color}"></span>`;
    }).join('');
    legend.innerHTML = COMP.map(
      (c) =>
        `<div class="item"><span class="swatch" style="background:${c.color}"></span>${c.label} ${fmtTok(b[c.key])}</div>`
    ).join('');
  }

  // By-model rows
  const models = $('models');
  const entries = Object.entries(b.perModel || {}).sort(
    (a, z) => z[1].tokens - a[1].tokens
  );
  if (entries.length === 0) {
    models.innerHTML = '<div class="empty">No usage in this window</div>';
    return;
  }
  const max = entries[0][1].tokens || 1;
  models.innerHTML = entries
    .map(([id, m]) => {
      const info = modelInfo(id);
      const w = Math.max(3, (m.tokens / max) * 100);
      return `<div class="model-row">
        <div class="model-name"><span class="model-swatch" style="background:${info.color}"></span>${info.name}</div>
        <div class="model-figs">${fmtTok(m.tokens)}<span class="cost">${fmtUSD(m.cost)}</span></div>
        <div class="model-bar bar"><div class="bar-fill" style="width:${w}%;background:${info.color};transition:none"></div></div>
      </div>`;
    })
    .join('');
}

// ---- interactions -----------------------------------------------------------

document.querySelectorAll('.seg').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.seg').forEach((b) => b.classList.remove('is-active'));
    btn.classList.add('is-active');
    detailWin = btn.dataset.win;
    renderDetail();
  });
});

$('btnRefresh').addEventListener('click', async () => {
  $('btnRefresh').classList.add('spin');
  latest = await window.usageAPI.refresh();
  render();
  setTimeout(() => $('btnRefresh').classList.remove('spin'), 400);
});
$('btnSettings').addEventListener('click', () => window.usageAPI.openConfig());

// ---- wiring -----------------------------------------------------------------

window.usageAPI.onUpdate((data) => {
  latest = data;
  render();
});

(async () => {
  try {
    latest = await window.usageAPI.get();
    if (latest) render();
  } catch (_) {}
})();

// Live countdown + "updated" tick.
setInterval(() => {
  if (!latest) return;
  updateReset();
  const local = latest.local || {};
  $('updated').textContent =
    agoText(latest.generatedAt) + ` · ${local.filesScanned || 0} logs`;
}, 1000);
