const fsp = require('fs/promises');
const path = require('path');
const { costOf } = require('./pricing');

const FIVE_HOURS = 5 * 60 * 60 * 1000;
const DAY = 24 * 60 * 60 * 1000;

// ---- file discovery ---------------------------------------------------------

async function findJsonlFiles(root) {
  const out = [];
  async function walk(dir) {
    let entries;
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) await walk(full);
      else if (e.isFile() && e.name.endsWith('.jsonl')) out.push(full);
    }
  }
  await walk(root);
  return out;
}

// ---- record normalization ---------------------------------------------------

function num(x) {
  return typeof x === 'number' && isFinite(x) ? x : 0;
}

// Convert one parsed JSONL object into a normalized usage record, or null.
// Only `assistant` lines carrying a real usage object count toward tokens; every
// other type (user, system, ai-title, last-prompt, mode, queue-operation,
// attachment, ...) is noise for our purposes.
function toRecord(obj) {
  if (!obj || obj.type !== 'assistant') return null;
  // API-error / synthetic turns (e.g. 401s) are type 'assistant' with all-zero
  // usage and a bogus model -- exclude so they don't create junk model buckets.
  if (obj.isApiErrorMessage === true) return null;
  const msg = obj.message;
  const u = msg && msg.usage;
  if (!u) return null;

  const ts = obj.timestamp ? new Date(obj.timestamp) : null;
  if (!ts || isNaN(ts.getTime())) return null;

  const model = String(msg.model || '');
  // Skip synthetic assistant turns (no real model / no tokens).
  if (!model || model === '<synthetic>') return null;

  const input = num(u.input_tokens);
  const output = num(u.output_tokens);
  const cacheRead = num(u.cache_read_input_tokens);

  let c5 = 0;
  let c1h = 0;
  if (u.cache_creation && typeof u.cache_creation === 'object') {
    c5 = num(u.cache_creation.ephemeral_5m_input_tokens);
    c1h = num(u.cache_creation.ephemeral_1h_input_tokens);
  }
  const cacheCreateTop = num(u.cache_creation_input_tokens);
  const cacheCreate = Math.max(cacheCreateTop, c5 + c1h);

  // NOTE: never sum u.iterations[] -- those per-iteration figures already roll
  // up into the top-level input/output/cache fields and would double-count.

  // Dedupe key: the same logical assistant message is written many times --
  // streaming partials (growing output_tokens), repeated snapshots, and
  // resume/rewind duplication across files. The API message id ('msg_...') is
  // the stable identity; subagent files carry distinct ids so global dedupe by
  // message.id is safe. Fall back to requestId, then line uuid.
  const mid = msg.id;
  const key =
    (mid && /^msg_/.test(mid) && `m:${mid}`) ||
    (obj.requestId && `r:${obj.requestId}`) ||
    (mid && `m:${mid}`) ||
    (obj.uuid && `u:${obj.uuid}`) ||
    `f:${ts.getTime()}:${model}:${input}:${output}`;

  return {
    key,
    ts: ts.getTime(),
    model,
    input,
    output,
    cacheRead,
    cacheCreate5m: c5,
    cacheCreate1h: c1h,
    cacheCreate,
  };
}

// ---- aggregation ------------------------------------------------------------

function volumeTokens(r, metric) {
  const create = r.cacheCreate || 0;
  if (metric === 'all') return r.input + r.output + create + r.cacheRead;
  return r.input + r.output + create; // 'billed'
}

function emptyBucket() {
  return {
    tokens: 0,
    input: 0,
    output: 0,
    cacheCreate: 0,
    cacheRead: 0,
    cost: 0,
    messages: 0,
    perModel: {},
  };
}

function addTo(bucket, r, metric) {
  const vol = volumeTokens(r, metric);
  const cost = costOf(r.model, r);
  bucket.tokens += vol;
  bucket.input += r.input;
  bucket.output += r.output;
  bucket.cacheCreate += r.cacheCreate;
  bucket.cacheRead += r.cacheRead;
  bucket.cost += cost;
  bucket.messages += 1;
  const pm =
    bucket.perModel[r.model] ||
    (bucket.perModel[r.model] = { tokens: 0, cost: 0, messages: 0 });
  pm.tokens += vol;
  pm.cost += cost;
  pm.messages += 1;
}

function startOfDay(ts) {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

// Anthropic assigns each account its own weekly reset day/time, so the calendar
// week is anchored to a user-configurable weekday (0=Sun..6=Sat) and hour.
function startOfWeekAnchored(ts, day, hour) {
  const anchor = new Date(ts);
  anchor.setHours(hour || 0, 0, 0, 0);
  const back = (anchor.getDay() - day + 7) % 7;
  anchor.setDate(anchor.getDate() - back);
  if (anchor.getTime() > ts) anchor.setDate(anchor.getDate() - 7);
  return anchor.getTime();
}

function floorHour(ts) {
  const d = new Date(ts);
  d.setMinutes(0, 0, 0);
  return d.getTime();
}

// Determine the currently-active 5-hour usage block, ccusage-style: a block
// starts at the (hour-floored) first activity and lasts 5 hours; a new block
// begins on the first activity after the current block ends or after a >5h gap.
function activeBlock(records, now, metric) {
  const empty = {
    active: false,
    startTs: null,
    resetTs: null,
    ...emptyBucket(),
  };
  if (records.length === 0) return empty;

  let blockStart = floorHour(records[0].ts);
  let lastTs = records[0].ts;
  let curStart = blockStart;
  let curRecords = [];
  let lastBlock = null;

  for (const r of records) {
    if (r.ts - blockStart >= FIVE_HOURS || r.ts - lastTs >= FIVE_HOURS) {
      lastBlock = { startTs: curStart, records: curRecords };
      blockStart = floorHour(r.ts);
      curStart = blockStart;
      curRecords = [];
    }
    curRecords.push(r);
    lastTs = r.ts;
  }
  lastBlock = { startTs: curStart, records: curRecords };

  const resetTs = lastBlock.startTs + FIVE_HOURS;
  const active = now < resetTs;
  const bucket = emptyBucket();
  if (active) for (const r of lastBlock.records) addTo(bucket, r, metric);

  return {
    active,
    startTs: active ? lastBlock.startTs : null,
    resetTs: active ? resetTs : null,
    ...bucket,
  };
}

// ---- public API -------------------------------------------------------------

async function computeUsage(projectsDir, cfg) {
  const metric = (cfg && cfg.usageMetric) || 'billed';
  const files = await findJsonlFiles(projectsDir);

  // Keep exactly ONE record per message.id -- the one with the greatest
  // output_tokens (the final, complete streaming snapshot). Keeping the first
  // occurrence would keep a partial and undercount; summing all would inflate
  // ~2.14x on real data.
  const byKey = new Map();
  for (const file of files) {
    let content;
    try {
      content = await fsp.readFile(file, 'utf8');
    } catch {
      continue;
    }
    for (const line of content.split('\n')) {
      const t = line.length && line.charCodeAt(0) === 123 ? line : line.trim();
      if (!t || t.charCodeAt(0) !== 123) continue; // must start with '{'
      let obj;
      try {
        obj = JSON.parse(t);
      } catch {
        continue; // skip malformed / partially-written (in-flight) lines
      }
      const r = toRecord(obj);
      if (!r) continue;
      const prev = byKey.get(r.key);
      if (!prev || r.output > prev.output) byKey.set(r.key, r);
    }
  }

  const records = Array.from(byKey.values());
  records.sort((a, b) => a.ts - b.ts);
  const now = Date.now();

  const startToday = startOfDay(now);
  const weekStart =
    cfg && cfg.weekMode === 'calendar'
      ? startOfWeekAnchored(
          now,
          cfg.weekAnchorDay != null ? cfg.weekAnchorDay : 1,
          cfg.weekAnchorHour != null ? cfg.weekAnchorHour : 0
        )
      : now - 7 * DAY;

  const today = emptyBucket();
  const week = emptyBucket();
  const all = emptyBucket();

  for (const r of records) {
    addTo(all, r, metric);
    if (r.ts >= startToday) addTo(today, r, metric);
    if (r.ts >= weekStart) addTo(week, r, metric);
  }

  // Per-model weekly sub-limits: Anthropic meters certain models (Opus, Fable,
  // and sometimes Sonnet) against their OWN weekly ceiling, on top of the shared
  // weekly cap, and surfaces a dedicated bar for each in /usage. Build one bucket
  // per configured model family by substring-matching the model id, so 'opus'
  // covers claude-opus-4-8/4-7, 'fable' covers claude-fable-5, etc.
  const modelWeeklyCaps = (cfg && cfg.modelWeeklyCaps) || {};
  const trackedWeek = Object.keys(modelWeeklyCaps).map((family) => {
    const key = family.toLowerCase();
    let tokens = 0;
    let cost = 0;
    let messages = 0;
    for (const [id, m] of Object.entries(week.perModel)) {
      if (id.toLowerCase().includes(key)) {
        tokens += m.tokens;
        cost += m.cost;
        messages += m.messages;
      }
    }
    return {
      family,
      label: family.charAt(0).toUpperCase() + family.slice(1),
      tokens,
      cost,
      messages,
      cap: modelWeeklyCaps[family],
    };
  });

  const block = activeBlock(records, now, metric);
  const first = records.length ? records[0].ts : null;
  const last = records.length ? records[records.length - 1].ts : null;

  return {
    generatedAt: now,
    metric,
    filesScanned: files.length,
    firstActivity: first,
    lastActivity: last,
    block,
    today,
    week,
    trackedWeek,
    all,
    weekStart,
    weekResetTs:
      cfg && cfg.weekMode === 'calendar' ? weekStart + 7 * DAY : null,
    weekMode: (cfg && cfg.weekMode) || 'rolling7d',
    caps: {
      fiveHour: cfg ? cfg.fiveHourTokenCap : 0,
      weekly: cfg ? cfg.weeklyTokenCap : 0,
    },
  };
}

module.exports = { computeUsage, findJsonlFiles, toRecord };
