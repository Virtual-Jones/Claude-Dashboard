# Claude Usage — Windows 11 taskbar widget

A system-tray widget that tracks your **Claude Max** usage. The tray icon is a
live ring showing how full your current session limit is (color = green → amber →
red as you approach it); **click it** for a Fluent-design flyout with the full
breakdown.

It's a **hybrid**: the limit percentages come **live from your Claude account**
(the exact same numbers as `/usage` and the desktop Usage tab), while the token
detail below is computed from your local Claude Code logs.

## What it shows

**Quick stats (tray icon + hover tooltip)**
- A ring that fills with your current session usage and recolors by severity.
- Tooltip: session, weekly, and per-model (Opus/Fable/…) percentages at a glance.

**Full view (click the tray icon)** — top section is **live from your account**:
- **Current session** gauge with a live "resets in …" countdown — your real
  *Current session* limit.
- **This week (all models)** plus a **per-model weekly tile** for each separate
  bar your account actually has — **auto-detected** from the live data (e.g.
  Fable, Opus). Anthropic meters some models against their own weekly ceiling, so
  a Fable- or Opus-heavy week can max one out while the overall bar has room.

**…and the lower section is your local Claude Code usage (this machine):**
- **API-equivalent value** — what your Code tokens would have cost at API rates.
- **Token composition** (input / output / cache-write / cache-read) and a
  **per-model** token breakdown, switchable between session, today, and week.

## How the two sources fit together

The **percentage bars are authoritative** — they mirror `claude.ai/settings/usage`
exactly, including usage from claude.ai chat, Cowork, and every device, and the
real reset times. If the live data can't be fetched (offline, or your Claude Code
login has expired), the widget falls back to **estimated** bars computed from local
logs and shows a banner saying so.

The **token/dollar detail is local** to this machine's Claude Code activity — the
API doesn't expose per-model token counts or cost, so that part is a Code-only
view (and a lower bound on your whole account).

### Privacy / your login token

To read the live numbers, the widget reads your Claude Code OAuth token from
`~/.claude/.credentials.json` at refresh time and sends it **only** to
`api.anthropic.com/api/oauth/usage` (the same call `/usage` makes). The token is
never logged, cached, or sent anywhere else. Verify what it returns yourself:

```powershell
npm run probe
```

That prints your live session / weekly / per-model percentages (and never prints
the token). It should match your desktop's **Settings → Usage** screen.

## Run it

Requires Node.js 20+ on Windows 11.

```powershell
cd path\to\Claude-Dashboard
npm install
npm start
```

A ring icon appears in the notification area (click the `^` overflow arrow if you
don't see it, and drag it onto the taskbar to pin it). **Left-click** toggles the
flyout; **right-click** for Refresh / Settings / Start-on-login / Quit.

## Package it into a standalone app

### Portable build (recommended — no admin needed)

```powershell
npm run pack
```

Produces a self-contained folder `dist\Claude Usage-win32-ia32\` with
**`Claude Usage.exe`** — double-click to run, no install step. To launch it at
sign-in, drop a shortcut to that exe into `shell:startup` (press `Win+R`, type
`shell:startup`), or just use the tray **Start on login** toggle after first run.
You can zip the folder to move it to another PC.

> Built for `ia32` because your Node/Electron install is 32-bit; a 32-bit app runs
> fine on 64-bit Windows. `npm run icon` regenerates the app icon (`build/icon.ico`).

### Installer (optional — needs elevation)

```powershell
npm run dist
```

Produces `dist\ClaudeUsage-Setup-1.0.0.exe` (electron-builder / NSIS). **This
requires an *Administrator* terminal or Windows Developer Mode enabled** — otherwise
it fails extracting electron-builder's `winCodeSign` bundle with *"Cannot create
symbolic link: A required privilege is not held by the client"* (the bundle
contains macOS symlinks, and creating symlinks on Windows is a privileged
operation). The portable build above avoids this entirely. If you have local
admin, right-click your terminal → *Run as administrator*, then `npm run dist`.

## Settings

Right-click the tray icon → **Edit settings…** opens `config.json` (in your user
data folder). Edit and either **Refresh now** or restart. The percentage bars use
your live account data; these settings only tune the **fallback** estimate used
when live data is unavailable.

| Key | Meaning |
| --- | --- |
| `fiveHourTokenCap` | Fallback estimated ceiling for the session gauge. |
| `weeklyTokenCap` | Fallback estimated weekly (all-models) ceiling. |
| `modelWeeklyCaps` | Fallback per-model weekly tiles — one per entry (default `opus` + `fable`). Keys match the model id as a substring. (Live mode auto-detects your real per-model bars instead.) |
| `weekMode` | `rolling7d` (trailing 7 days, default) or `calendar` (since your weekly reset). |
| `weekAnchorDay` / `weekAnchorHour` | Your account's weekly reset (used when `weekMode` = `calendar`). Day: 0=Sun … 6=Sat. Find yours at `claude.ai/settings/usage`. |
| `usageMetric` | `billed` (input+output+cache-writes, default) or `all` (also counts cache reads). |
| `refreshSeconds` | Local token-detail refresh interval (also refreshes on log changes). |
| `liveRefreshSeconds` | Minimum seconds between live account API calls (rate-limited endpoint; default 60). |
| `startOnLogin` | Launch at sign-in (also toggleable from the tray menu). |

## How it works

- **`src/live-usage.js`** — fetches `GET api.anthropic.com/api/oauth/usage` with
  your local OAuth token and parses the `limits[]` array (session / weekly-all /
  per-model `weekly_scoped` bars, auto-detecting Fable etc.). This drives the
  authoritative percentage bars.
- **`src/usage.js`** — recursively scans `~/.claude/projects` (including nested
  `subagents/` folders), keeps only `assistant` lines with a `message.usage`
  object, and **dedupes by `message.id`, keeping the record with the greatest
  `output_tokens`** (Claude Code writes each streaming message many times with
  growing output; naive summing over-counts by ~2×). It never sums
  `usage.iterations[]` and buckets by model and time window. Drives the local
  token/dollar detail.
- **`src/pricing.js`** — Anthropic list prices per model for the value estimate.
- **`src/tray-icon.js`** — a tiny pure-JS PNG encoder (Node `zlib` only, no native
  modules) that rasterizes the progress ring at runtime.
- **`src/main.js`** — tray, the acrylic Win11 flyout, tray-anchored positioning,
  light-dismiss on blur, throttled live fetch + local file watching, single-instance
  lock, and start-on-login.
- **`src/preload.js` / `src/renderer/`** — a locked-down `contextBridge` API and
  the Fluent-design UI (Segoe UI Variable, SVG gauges, light/dark).

## Notes & limitations

- The acrylic backdrop needs **Windows 11 22H2+**; on older builds it falls back
  to a solid Fluent surface color automatically.
- The live endpoint is rate-limited, so calls are throttled (`liveRefreshSeconds`);
  a transient failure keeps showing the last good data as "Live · cached".
- The Fable value estimate uses a placeholder price (public API price not yet
  documented); token counts and percentages are unaffected.
