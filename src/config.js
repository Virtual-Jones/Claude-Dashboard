const fs = require('fs');
const path = require('path');

// The top-of-widget percentage bars come LIVE from your Claude account
// (Anthropic's /api/oauth/usage, the same source as `/usage`). The token caps
// below are only a FALLBACK: they render estimated gauges from local Claude Code
// logs when the live data is unavailable (offline, or login expired). The raw
// token totals and dollar-value figures in the detail section are always local.
const DEFAULT_CONFIG = {
  // Fallback-only estimated ceilings for the % gauges (in tokens of the chosen
  // usageMetric), used when live account data can't be fetched. Rough Max-20x
  // guesses; tune to taste.
  fiveHourTokenCap: 12_000_000,
  weeklyTokenCap: 120_000_000,

  // Per-model WEEKLY sub-limits -- FALLBACK ONLY. When live account data is
  // available the per-model tiles are driven by it (auto-detecting exactly the
  // bars your account has, e.g. Fable). These caps only render estimated tiles
  // from local logs when live data is unavailable. Keys match the model id as a
  // substring ('opus', 'fable', ...).
  modelWeeklyCaps: {
    opus: 40_000_000,
    fable: 20_000_000,
    // sonnet: 120_000_000, // usually the shared "all other models" baseline --
    //                      // enable only if your /usage shows a separate Sonnet bar
  },

  // 'rolling7d'  -> weekly window = trailing 7 days (safe default)
  // 'calendar'   -> weekly window = since the last weekly reset boundary below
  weekMode: 'rolling7d',

  // Anthropic assigns each account its own weekly reset day/time. If you use
  // weekMode 'calendar', set these to your actual reset (see claude.ai/settings/
  // usage or `/usage` in Claude Code). Day: 0=Sun,1=Mon,...,6=Sat. Hour: 0-23 local.
  weekAnchorDay: 1,
  weekAnchorHour: 0,

  // What counts as a "token used" for the volume/gauge numbers:
  //   'billed' -> input + output + cache-writes   (excludes cheap cache reads)
  //   'all'    -> everything, including cache reads
  usageMetric: 'billed',

  // How often to recompute LOCAL token detail from logs (cheap).
  refreshSeconds: 30,
  // Minimum seconds between LIVE account API calls. The endpoint is rate-limited,
  // so keep this modest; usage bars change slowly. The manual Refresh button and
  // startup always fetch; file-change updates never do.
  liveRefreshSeconds: 60,
  startOnLogin: false,
};

function configPath(dir) {
  return path.join(dir, 'config.json');
}

function loadConfig(dir) {
  try {
    const p = configPath(dir);
    if (fs.existsSync(p)) {
      const raw = JSON.parse(fs.readFileSync(p, 'utf8'));
      return { ...DEFAULT_CONFIG, ...raw };
    }
  } catch (_) {
    // fall through to defaults on any parse/read error
  }
  return { ...DEFAULT_CONFIG };
}

function saveConfig(dir, cfg) {
  try {
    fs.writeFileSync(configPath(dir), JSON.stringify(cfg, null, 2));
  } catch (_) {
    /* best effort */
  }
}

module.exports = { DEFAULT_CONFIG, loadConfig, saveConfig, configPath };
