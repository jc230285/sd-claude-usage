const { streamDeck, SingletonAction } = require("@elgato/streamdeck");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { execFileSync } = require("child_process");

const RATE_LIMITS_PATH = path.join(os.homedir(), ".claude", "rate_limits.json");
const DEFAULT_JARVISAI_URL = "http://100.96.106.91:8792";
const LOGIN_PAGE_BASE = "https://jarvis.viresinnumeris.co.uk/ai-login";
const TOKEN_VAULT_KEY = "JARVIS_AGENT_PROXY_KEY";
const DEFAULT_REFRESH_SECONDS = 30;
const PROVIDER_ORDER = ["claude", "codex", "gemini", "groq", "openrouter", "ollama"];
const PROVIDER_LABELS = {
  claude: "CLAUDE",
  codex: "CODEX",
  gemini: "GEMINI",
  groq: "GROQ",
  openrouter: "OPENR",
  ollama: "OLLAMA",
};

function num(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function readRateLimits() {
  try { return JSON.parse(fs.readFileSync(RATE_LIMITS_PATH, "utf8")); }
  catch { return null; }
}

async function fetchJson(url, token = "", timeoutMs = 3500) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const headers = { accept: "application/json" };
    if (token) headers.authorization = `Bearer ${token}`;
    const res = await fetch(url, { headers, cache: "no-store", signal: ctrl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally { clearTimeout(timer); }
}

function readJarvisToken(settings = {}) {
  if (settings.token) return String(settings.token).trim();
  if (process.env.JARVISAI_TOKEN) return String(process.env.JARVISAI_TOKEN).trim();
  try {
    const raw = execFileSync("wsl.exe", ["-d", "Ubuntu-24.04", "-u", "root", "--", "bao-get", TOKEN_VAULT_KEY], {
      encoding: "utf8", timeout: 5000, windowsHide: true, stdio: ["ignore", "pipe", "ignore"]
    });
    const lines = raw.split(/\r?\n/).map((line) => line.replace(/\x1b\[[0-9;]*m/g, "").trim()).filter(Boolean);
    return (lines.at(-1) || "").replace(/[^\x21-\x7e]/g, "");
  } catch { return ""; }
}

function providerKind(row = {}) {
  const raw = String(row.kind || row.provider || row.providerId || row.provider_id || "").toLowerCase();
  if (raw.includes("anthropic") || raw.includes("claude")) return "claude";
  if (raw.includes("openai") || raw.includes("codex") || raw.includes("gpt")) return "codex";
  if (raw.includes("google") || raw.includes("gemini")) return "gemini";
  if (raw.includes("groq")) return "groq";
  if (raw.includes("openrouter")) return "openrouter";
  if (raw.includes("ollama")) return "ollama";
  return raw || "unknown";
}

function rowBurnPct(row = {}) {
  const burn = row.burn || {};
  const direct = [
    row.weekly_burn_rate_pct, row.burn_rate_pct, row.burnRatePct,
    burn.weekly_burn_rate_pct, burn.burn_rate_pct,
  ].map(Number).find(Number.isFinite);
  if (Number.isFinite(direct)) return direct;

  const weekly = burn.weekly || row.weekly || {};
  let max = null;
  for (const win of Object.values(weekly)) {
    const used = num(win?.used_pct ?? win?.used_percentage, NaN);
    const elapsed = num(win?.time_elapsed_pct, NaN);
    if (Number.isFinite(used) && Number.isFinite(elapsed) && elapsed > 0) {
      const rate = (used / elapsed) * 100;
      max = max === null ? rate : Math.max(max, rate);
    } else if (Number.isFinite(used)) {
      max = max === null ? used : Math.max(max, used);
    }
  }
  return max;
}

function normalizeJarvisV1(health = {}, usage = {}) {
  const rows = Array.isArray(health.accounts) ? health.accounts : [];
  const byAccount = usage.byAccount || {};
  const grouped = new Map();
  for (const row of rows) {
    const kind = providerKind({ kind: row.providerKind || row.provider || row.kind });
    if (!PROVIDER_ORDER.includes(kind)) continue;
    if (!grouped.has(kind)) grouped.set(kind, []);
    const weekly = (row.burnWindows || []).find((w) => w.name === "weekly:all_models")
      || (row.burnWindows || []).find((w) => String(w.name || "").startsWith("weekly:")) || null;
    const u = byAccount[row.id]?.["24h"] || {};
    grouped.get(kind).push({
      kind,
      enabled: Boolean(row.enabled),
      connected: Boolean(row.connected),
      inPool: Boolean(row.inPool),
      available: row.available === undefined ? String(row.status || "").toLowerCase() === "available" : Boolean(row.available),
      status: String(row.status || ""),
      reauth: Boolean(row.reauthRequired),
      limitReached: Boolean(row.usageLimitReached || row.burnRateExceeded),
      burnPct: weekly?.burnRatePercent == null ? null : num(weekly.burnRatePercent, null),
      usedPct: weekly?.usagePercent == null ? null : num(weekly.usagePercent, null),
      inflight: num(row.quota?.usage?.inFlight),
      requests: num(u.requests),
      input: num(u.usage?.inputTokens),
      output: num(u.usage?.outputTokens),
      cost: num(u.costUsd),
    });
  }

  const providers = {};
  for (const kind of PROVIDER_ORDER) {
    const list = grouped.get(kind) || [];
    if (!list.length) continue;
    const connectedRows = list.filter((r) => r.enabled && r.connected && r.inPool);
    const operational = connectedRows.filter((r) => r.available && !r.reauth && !r.limitReached && !["held","unhealthy","offline","disabled","quota_exhausted","usage_limit_reached","reauth_required"].includes(r.status.toLowerCase()));
    const burns = connectedRows.map((r) => r.burnPct).filter((v) => v !== null && Number.isFinite(v));
    providers[kind] = {
      kind, accounts: list.length, connected: connectedRows.length,
      usable: operational.filter((r) => r.burnPct === null || r.burnPct < 100).length,
      operational: operational.length,
      requests: list.reduce((n,r)=>n+r.requests,0), input: list.reduce((n,r)=>n+r.input,0), output: list.reduce((n,r)=>n+r.output,0),
      inflight: list.reduce((n,r)=>n+r.inflight,0), cost: list.reduce((n,r)=>n+r.cost,0),
      attention: connectedRows.filter((r) => r.reauth || !r.available).length,
      burnPct: burns.length ? burns.reduce((a,b)=>a+b,0)/burns.length : null,
      lowestBurnPct: burns.length ? Math.min(...burns) : null,
    };
  }
  const vals = Object.values(providers);
  return {
    source: "jarvisai-v1", generatedAt: new Date().toISOString(), providers,
    totals: {
      accounts: vals.reduce((n,p)=>n+p.accounts,0), connected: vals.reduce((n,p)=>n+p.connected,0), usable: vals.reduce((n,p)=>n+p.usable,0),
      requests: vals.reduce((n,p)=>n+p.requests,0), input: vals.reduce((n,p)=>n+p.input,0), output: vals.reduce((n,p)=>n+p.output,0),
      inflight: vals.reduce((n,p)=>n+p.inflight,0), cost: vals.reduce((n,p)=>n+p.cost,0), attention: vals.reduce((n,p)=>n+p.attention,0),
    }
  };
}

async function readJarvisAi(baseUrl, settings = {}) {
  const configured = String(baseUrl || "").replace(/\/+$/, "");
  const preferred = String(DEFAULT_JARVISAI_URL).replace(/\/+$/, "");
  const candidates = [...new Set([preferred, configured].filter(Boolean))];
  let bridgeError = null;

  // Preferred path: always try the Tailscale-only Home1 bridge, even when an
  // existing key still carries a legacy endpoint in its saved settings.
  for (const base of candidates) {
    try {
      const bridge = await fetchJson(base + "/stats");
      if (bridge && bridge.providers && bridge.totals) return bridge;
    } catch (err) { bridgeError = err; }
  }

  // Direct JarvisAI v1 fallback for machines that have the BAO credential.
  const token = readJarvisToken(settings);
  if (!token) throw new Error(`JarvisAI bridge unavailable (${bridgeError?.message || "unknown"}); machine credential unavailable`);
  const directBase = configured && !configured.includes(":8792") ? configured : "https://ai.viresinnumeris.co.uk";
  const [health, usage] = await Promise.all([
    fetchJson(directBase + "/v1/health", token),
    fetchJson(directBase + "/v1/usage", token),
  ]);
  return normalizeJarvisV1(health, usage);
}

function timeUntil(epochSec) {
  const ms = epochSec * 1000 - Date.now();
  if (ms <= 0) return "now";
  const hours = ms / 3600000;
  return hours >= 48 ? `${Math.round(hours / 24 * 10) / 10}d` : `${Math.round(hours * 10) / 10}h`;
}

function legacySnapshot() {
  const data = readRateLimits();
  if (!data) return null;
  const five = data.five_hour || {};
  const seven = data.seven_day || {};
  return {
    source: "local-claude",
    providers: {
      claude: {
        kind: "claude", accounts: 1, connected: 1, usable: 1, capacity: 1,
        burnPct: Math.max(num(five.used_percentage), num(seven.used_percentage)),
        fivePct: num(five.used_percentage), weeklyPct: num(seven.used_percentage),
        reset: Math.max(num(five.resets_at), num(seven.resets_at)),
        requests: 0, input: 0, output: 0, inflight: 0, cost: 0, attention: 0,
      },
    },
    totals: { accounts: 1, connected: 1, usable: 1, requests: 0, input: 0, output: 0, inflight: 0, cost: 0, attention: 0 },
  };
}

function compact(n) {
  n = num(n);
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)}b`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}m`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}k`;
  return String(Math.round(n));
}

function tone(p) {
  if (!p || p.connected === 0) return { bg: "#14171d", fg: "#77808e", ring: "#4b5563", state: "OFF" };
  if (p.attention > 0) return { bg: "#321014", fg: "#ffb4bc", ring: "#ff4757", state: "FIX" };
  if (p.burnPct !== null && p.burnPct >= 120) return { bg: "#420b0b", fg: "#ffd0d0", ring: "#ff3344", state: "STOP" };
  if (p.burnPct !== null && p.burnPct >= 100) return { bg: "#37130a", fg: "#ffd8c2", ring: "#ff7b32", state: "HOLD" };
  if (p.burnPct !== null && p.burnPct >= 80) return { bg: "#2e2607", fg: "#fff0a6", ring: "#f1c40f", state: "HIGH" };
  return { bg: "#071d16", fg: "#b9ffe3", ring: "#2ed573", state: "READY" };
}

function arc(cx, cy, r, pct) {
  const v = Math.max(0.01, Math.min(99.99, num(pct)));
  const angle = v * 3.6;
  const start = -90;
  const end = start + angle;
  const rad = (d) => d * Math.PI / 180;
  const x1 = cx + r * Math.cos(rad(start));
  const y1 = cy + r * Math.sin(rad(start));
  const x2 = cx + r * Math.cos(rad(end));
  const y2 = cy + r * Math.sin(rad(end));
  return `M ${x1} ${y1} A ${r} ${r} 0 ${angle > 180 ? 1 : 0} 1 ${x2} ${y2}`;
}

function buildOverviewSvg(snapshot) {
  const t = snapshot.totals;
  const claude = snapshot.providers?.claude;
  const burn = claude?.burnPct;
  const health = tone(claude || { connected: t.connected, attention: t.attention, burnPct: 0 });
  const loginCount = Array.isArray(snapshot.loginActions) ? snapshot.loginActions.length : 0;
  const value = burn === null || burn === undefined ? null : Math.round(burn);
  const footer = loginCount ? `${loginCount} LOGIN${loginCount === 1 ? "" : "S"}` : `${t.usable}/${t.accounts} READY`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="144" height="144">
    <rect width="144" height="144" rx="12" fill="${health.bg}"/>
    <text x="72" y="28" text-anchor="middle" font-family="Arial" font-size="24" font-weight="800" fill="${health.fg}">CLAUDE 7D</text>
    <text x="72" y="94" text-anchor="middle" font-family="Arial" font-weight="900" fill="${health.ring}">${value === null ? '<tspan font-size="64">—</tspan>' : `<tspan font-size="64">${value}</tspan><tspan font-size="24" dy="-24">%</tspan>`}</text>
    <text x="72" y="132" text-anchor="middle" font-family="Arial" font-size="24" font-weight="800" fill="${health.fg}">${footer}</text>
  </svg>`;
}

function buildProviderSvg(p) {
  if (!p) return buildWaitingSvg("NO DATA");
  const c = tone(p);
  const burn = p.burnPct === null ? null : Math.max(0, p.burnPct);
  const label = PROVIDER_LABELS[p.kind] || String(p.kind || "AI").toUpperCase().slice(0, 7);
  const top = p.kind === "claude" ? "CLAUDE 7D" : label;
  const value = burn === null ? null : Math.round(burn);
  const bottom = p.attention ? `${p.attention} LOGIN${p.attention === 1 ? "" : "S"}` : `${p.usable}/${p.connected} READY`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="144" height="144">
    <rect width="144" height="144" rx="12" fill="${c.bg}"/>
    <text x="72" y="28" text-anchor="middle" font-family="Arial" font-size="24" font-weight="800" fill="${c.fg}">${top}</text>
    <text x="72" y="94" text-anchor="middle" font-family="Arial" font-weight="900" fill="${c.ring}">${burn === null ? `<tspan font-size="52">${p.usable}/${p.connected}</tspan>` : `<tspan font-size="60">${value}</tspan><tspan font-size="24" dy="-22">%</tspan>`}</text>
    <text x="72" y="132" text-anchor="middle" font-family="Arial" font-size="24" font-weight="800" fill="${c.fg}">${bottom}</text>
  </svg>`;
}

function buildLoginSvg(snapshot) {
  const actions = Array.isArray(snapshot?.loginActions) ? snapshot.loginActions : [];
  const count = actions.length;
  const c = count ? {bg:'#321014',fg:'#ffd0d4',ring:'#ff4757'} : {bg:'#071d16',fg:'#b9ffe3',ring:'#2ed573'};
  return `<svg xmlns="http://www.w3.org/2000/svg" width="144" height="144">
    <rect width="144" height="144" rx="12" fill="${c.bg}"/>
    <text x="72" y="28" text-anchor="middle" font-family="Arial" font-size="24" font-weight="800" fill="${c.fg}">LOGINS</text>
    <text x="72" y="94" text-anchor="middle" font-family="Arial" font-size="68" font-weight="900" fill="${c.ring}">${count}</text>
    <text x="72" y="132" text-anchor="middle" font-family="Arial" font-size="24" font-weight="800" fill="${c.fg}">${count ? 'PRESS' : 'OK'}</text>
  </svg>`;
}

function buildLegacySvg(snapshot, displayMode) {
  const p = snapshot?.providers?.claude;
  if (!p) return buildWaitingSvg("CLAUDE ?");
  let pct = p.burnPct || 0;
  let label = "AUTO";
  if (displayMode === "five_hour") { pct = p.fivePct || 0; label = "5H"; }
  else if (displayMode === "seven_day") { pct = p.weeklyPct || 0; label = "7D"; }
  const c = tone({ ...p, burnPct: pct });
  return `<svg xmlns="http://www.w3.org/2000/svg" width="144" height="144">
    <rect width="144" height="144" rx="12" fill="${c.bg}"/>
    <text x="72" y="28" text-anchor="middle" font-family="Arial" font-size="24" font-weight="800" fill="${c.fg}">CLAUDE ${label}</text>
    <text x="72" y="94" text-anchor="middle" font-family="Arial" font-weight="900" fill="${c.ring}"><tspan font-size="60">${Math.round(pct)}</tspan><tspan font-size="24" dy="-22">%</tspan></text>
    <text x="72" y="132" text-anchor="middle" font-family="Arial" font-size="24" font-weight="800" fill="${c.fg}">${p.reset ? timeUntil(p.reset) : 'LOCAL'}</text>
  </svg>`;
}

function buildWaitingSvg(text = "JARVIS") {
  const short = String(text || 'JARVIS').toUpperCase().slice(0, 12);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="144" height="144"><rect width="144" height="144" rx="12" fill="#0c1016"/><text x="72" y="74" text-anchor="middle" font-family="Arial" font-size="28" font-weight="800" fill="#9aa4b2">${short}</text><text x="72" y="116" text-anchor="middle" font-family="Arial" font-size="24" font-weight="800" fill="#667085">WAIT</text></svg>`;
}

function svgData(svg) { return "data:image/svg+xml;base64," + Buffer.from(svg).toString("base64"); }

const runtimes = new Map();
let sharedSnapshot = null;
let sharedTimer = null;
let sharedPollPromise = null;
let lastPollAt = 0;

async function settingsFor(action) {
  try { return await action.getSettings(); }
  catch { return {}; }
}

function availableViews(snapshot) {
  return ["overview", ...PROVIDER_ORDER.filter((p) => snapshot?.providers?.[p])];
}

function renderAction(runtime) {
  const action = runtime.action;
  const settings = runtime.settings || {};
  const snapshot = sharedSnapshot;
  if (!snapshot) { action.setImage(svgData(buildWaitingSvg())); return; }
  if (snapshot.offline) { action.setImage(svgData(buildWaitingSvg("JARVIS OFFLINE"))); return; }

  let view = settings.viewMode || "overview";
  if (view === "cycle") {
    const views = availableViews(snapshot);
    const saved = settings.cycleView;
    view = views.includes(saved) ? saved : views[0];
  }
  if (view === "legacy") {
    action.setImage(svgData(buildLegacySvg(legacySnapshot(), settings.displayMode || "auto")));
  } else if (view === "login_attention") {
    action.setImage(svgData(buildLoginSvg(snapshot)));
  } else if (view === "overview") {
    action.setImage(svgData(buildOverviewSvg(snapshot)));
  } else {
    action.setImage(svgData(buildProviderSvg(snapshot.providers?.[view])));
  }
}

function renderAll() {
  for (const runtime of runtimes.values()) renderAction(runtime);
}

function globalRefreshSeconds() {
  const configured = [...runtimes.values()]
    .map((r) => num(r.settings?.refreshSeconds, DEFAULT_REFRESH_SECONDS))
    .filter(Number.isFinite);
  return Math.max(10, Math.min(300, configured.length ? Math.min(...configured) : DEFAULT_REFRESH_SECONDS));
}

function armSharedTimer() {
  if (sharedTimer) clearInterval(sharedTimer);
  if (!runtimes.size) { sharedTimer = null; return; }
  sharedTimer = setInterval(() => pollShared(false), globalRefreshSeconds() * 1000);
}

async function pollShared(force = false) {
  if (sharedPollPromise) return sharedPollPromise;
  if (!force && sharedSnapshot && Date.now() - lastPollAt < 5000) return sharedSnapshot;

  sharedPollPromise = (async () => {
    try {
      // One authoritative fetch for the whole plugin process, regardless of how many
      // keys/profiles Stream Deck has instantiated.
      sharedSnapshot = await readJarvisAi(DEFAULT_JARVISAI_URL, {});
    } catch (err) {
      streamDeck.logger.warn(`JarvisAI shared telemetry failed: ${err.message}`);
      sharedSnapshot = { source: "offline", offline: true, error: err.message, providers: {}, loginActions: [], totals: { accounts: 0, connected: 0, usable: 0, requests: 0, input: 0, output: 0, inflight: 0, cost: 0, attention: 0 } };
    }
    lastPollAt = Date.now();
    renderAll();
    return sharedSnapshot;
  })();

  try { return await sharedPollPromise; }
  finally { sharedPollPromise = null; }
}

async function registerRuntime(action, incomingSettings = null) {
  const id = action.id;
  const old = runtimes.get(id) || { action, settings: {}, viewIndex: 0 };
  old.action = action;
  old.settings = incomingSettings || await settingsFor(action);
  runtimes.set(id, old);
  renderAction(old);
  armSharedTimer();
  await pollShared(false);
}

class JarvisAiUsageAction extends SingletonAction {
  constructor() { super(); this.manifestId = "com.jkkec.claude-usage.usage"; }

  async onWillAppear(ev) {
    await registerRuntime(ev.action, ev.payload?.settings || null);
  }

  onWillDisappear(ev) {
    runtimes.delete(ev.action.id);
    armSharedTimer();
  }

  async onKeyDown(ev) {
    let runtime = runtimes.get(ev.action.id);
    if (!runtime) {
      await registerRuntime(ev.action, ev.payload?.settings || null);
      runtime = runtimes.get(ev.action.id);
    }
    const mode = runtime.settings?.viewMode || "overview";
    if (mode === "cycle" && sharedSnapshot) {
      const views = availableViews(sharedSnapshot);
      const current = views.includes(runtime.settings?.cycleView) ? runtime.settings.cycleView : views[0];
      const next = views[(views.indexOf(current) + 1) % Math.max(1, views.length)];
      runtime.settings = { ...runtime.settings, cycleView: next };
      await runtime.action.setSettings(runtime.settings);
      renderAction(runtime);
    } else if (mode === "login_attention" && sharedSnapshot) {
      const actions = Array.isArray(sharedSnapshot.loginActions) ? sharedSnapshot.loginActions : [];
      const url = actions.length === 1 ? actions[0].url : LOGIN_PAGE_BASE;
      if (actions.length) await streamDeck.system.openUrl(url);
    }
    await pollShared(true);
  }

  async onDidReceiveSettings(ev) {
    const runtime = runtimes.get(ev.action.id) || { action: ev.action, settings: {}, viewIndex: 0 };
    runtime.action = ev.action;
    runtime.settings = ev.payload?.settings || await settingsFor(ev.action);
    runtimes.set(ev.action.id, runtime);
    renderAction(runtime);
    armSharedTimer();
  }
}

streamDeck.actions.registerAction(new JarvisAiUsageAction());
streamDeck.connect();
