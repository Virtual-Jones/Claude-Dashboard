// Authoritative usage via Anthropic's own endpoint -- the same source Claude
// Code's `/usage` command and the desktop Usage tab use. Reverse-engineered from
// the Claude Code binary (v2.0.31):
//   GET https://api.anthropic.com/api/oauth/usage
//   headers: Authorization: Bearer <oauth token>, anthropic-beta: oauth-2025-04-20,
//            anthropic-version: 2023-06-01
//   body: { five_hour:{utilization,resets_at}, seven_day:{...}, seven_day_opus:{...}, ... }
//         utilization is a percent 0-100 (or null); resets_at is a timestamp.
//
// The OAuth token is read from ~/.claude/.credentials.json at call time and is
// ONLY ever sent to api.anthropic.com. It is never logged, cached, or written
// anywhere by this widget.

const fs = require('fs');
const path = require('path');
const os = require('os');
const https = require('https');

const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';
const CREDENTIALS = path.join(os.homedir(), '.claude', '.credentials.json');

// ---- token ------------------------------------------------------------------

function extractToken(obj) {
  if (!obj || typeof obj !== 'object') return null;
  const oa = obj.claudeAiOauth || obj.oauth || obj;
  const direct = oa.accessToken || oa.access_token || obj.accessToken || obj.access_token;
  if (typeof direct === 'string' && direct) return direct;
  // Fallback: scan for a value that looks like an OAuth access token.
  for (const k of Object.keys(obj)) {
    const v = obj[k];
    if (typeof v === 'string' && /^sk-ant-oat/i.test(v)) return v;
    if (v && typeof v === 'object') {
      const t = extractToken(v);
      if (t) return t;
    }
  }
  return null;
}

function readCredentials() {
  const raw = JSON.parse(fs.readFileSync(CREDENTIALS, 'utf8'));
  const token = extractToken(raw);
  const oa = raw.claudeAiOauth || raw || {};
  return { token, expiresAt: oa.expiresAt || oa.expires_at || null };
}

// ---- fetch ------------------------------------------------------------------

function httpGet(url, headers, timeout) {
  return new Promise((resolve, reject) => {
    const req = https.request(url, { method: 'GET', headers, timeout }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => (body += c));
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('request timed out')));
    req.end();
  });
}

async function fetchUsageRaw() {
  const { token } = readCredentials();
  if (!token) {
    const e = new Error('No Claude Code login token found. Sign in with Claude Code first.');
    e.code = 'NO_TOKEN';
    throw e;
  }
  const { status, body } = await httpGet(
    USAGE_URL,
    {
      Authorization: `Bearer ${token}`,
      'anthropic-beta': 'oauth-2025-04-20',
      'anthropic-version': '2023-06-01',
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    8000
  );
  if (status === 401 || status === 403) {
    const e = new Error('Login expired. Open Claude Code to refresh your session, then Refresh.');
    e.code = 'AUTH';
    throw e;
  }
  if (status < 200 || status >= 300) {
    const e = new Error(`Usage API returned HTTP ${status}.`);
    e.code = 'HTTP';
    throw e;
  }
  return JSON.parse(body);
}

// ---- normalize --------------------------------------------------------------

function parseReset(v) {
  if (v == null) return null;
  if (typeof v === 'number') return v < 1e12 ? v * 1000 : v; // seconds -> ms
  const t = Date.parse(v);
  return Number.isNaN(t) ? null : t;
}

function toBucket(b) {
  if (!b || typeof b !== 'object') return null;
  const u = typeof b.utilization === 'number' ? b.utilization : null;
  return { utilization: u, resetsAt: parseReset(b.resets_at) };
}

function cap(s) {
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : s;
}

function scopeLabel(scope) {
  if (!scope || typeof scope !== 'object') return null;
  if (scope.model && scope.model.display_name) return scope.model.display_name;
  if (scope.surface) {
    return typeof scope.surface === 'string' ? cap(scope.surface) : scope.surface.display_name || null;
  }
  return null;
}

function finalizeModels(out) {
  out.models = out.models.filter((m) => m.utilization != null);
  const rank = { opus: 0, fable: 1 };
  out.models.sort(
    (a, z) => (rank[a.family] ?? 9) - (rank[z.family] ?? 9) || a.family.localeCompare(z.family)
  );
  return out;
}

// Turn the raw API object into { session, weekAll, models[] }.
// Current API returns a `limits` array of { kind, group, percent, severity,
// resets_at, scope, is_active }; `weekly_scoped` entries carry the per-model bar
// (scope.model.display_name, e.g. "Fable"). Older builds used flat
// five_hour/seven_day/seven_day_<model> keys -- kept as a fallback.
function normalizeLive(raw) {
  const out = { ok: true, session: null, weekAll: null, models: [] };

  if (raw && Array.isArray(raw.limits) && raw.limits.length) {
    for (const lim of raw.limits) {
      if (!lim || typeof lim !== 'object') continue;
      const b = {
        utilization: typeof lim.percent === 'number' ? lim.percent : null,
        resetsAt: parseReset(lim.resets_at),
        severity: lim.severity || null,
        isActive: lim.is_active !== false,
      };
      const kind = lim.kind || '';
      const group = lim.group || '';
      if (kind === 'session' || group === 'session') {
        out.session = b;
      } else if (kind === 'weekly_all' || (group === 'weekly' && !lim.scope)) {
        out.weekAll = b;
      } else if (kind === 'weekly_scoped' || group === 'weekly') {
        const label = scopeLabel(lim.scope);
        if (label) out.models.push({ family: label.toLowerCase(), label, ...b });
      }
    }
    return finalizeModels(out);
  }

  // Legacy fallback: flat five_hour / seven_day / seven_day_<model> keys.
  for (const [key, val] of Object.entries(raw || {})) {
    const b = toBucket(val);
    if (!b) continue;
    if (key === 'five_hour') out.session = b;
    else if (key === 'seven_day') out.weekAll = b;
    else if (key.startsWith('seven_day_')) {
      const fam = key.slice('seven_day_'.length);
      out.models.push({ family: fam, label: cap(fam), ...b });
    }
  }
  return finalizeModels(out);
}

async function fetchUsage() {
  const norm = normalizeLive(await fetchUsageRaw());
  return norm;
}

// ---- probe (user-run verification; never prints the token) ------------------

async function probe() {
  try {
    const { token, expiresAt } = readCredentials();
    console.log('token found:', token ? 'yes' : 'NO',
      expiresAt ? `(expires ${new Date(expiresAt).toLocaleString()})` : '');
    const raw = await fetchUsageRaw();
    console.log('\nraw top-level keys:', Object.keys(raw).join(', '));
    console.log('\n=== RAW RESPONSE (usage data only; no token) ===');
    console.log(JSON.stringify(raw, null, 2));
    console.log('=== END RAW ===');
    const n = normalizeLive(raw);
    console.log('\nnormalized:');
    const fmt = (b) => (b ? `${b.utilization}%  resets ${b.resetsAt ? new Date(b.resetsAt).toLocaleString() : '—'}` : 'n/a');
    console.log('  Current session :', fmt(n.session));
    console.log('  All models (wk) :', fmt(n.weekAll));
    for (const m of n.models) console.log(`  ${m.label.padEnd(15)} :`, fmt(m));
  } catch (e) {
    console.error('PROBE FAILED:', e.code ? `[${e.code}] ` : '', e.message);
    process.exitCode = 1;
  }
}

module.exports = { fetchUsage, normalizeLive, fetchUsageRaw, readCredentials, probe };

if (require.main === module) probe();
