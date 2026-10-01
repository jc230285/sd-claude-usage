const { streamDeck, SingletonAction } = require("@elgato/streamdeck");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { execFileSync } = require("child_process");

const RATE_LIMITS_PATH = path.join(os.homedir(), ".claude", "rate_limits.json");
const DEFAULT_JARVISAI_URL = "https://ai.viresinnumeris.co.uk";
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
    return execFileSync("wsl.exe", ["-d", "Ubuntu-24.04", "-u", "root", "--", "bao-get", TOKEN_VAULT_KEY], {
      encoding: "utf8", timeout: 5000, windowsHide: true, stdio: ["ignore", "pipe", "ignore"]
    }).trim();
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
  const base = String(baseUrl || DEFAULT_JARVISAI_URL).replace(/\/+$/, "");
  const token = readJarvisToken(settings);
  if (!token) throw new Error("JarvisAI machine credential unavailable");
  const [health, usage] = await Promise.all([
    fetchJson(base + "/v1/health", token),
    fetchJson(base + "/v1/usage", token),
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
  const providers = Object.values(snapshot.providers);
  const burns = providers.map((p) => p.burnPct).filter((v) => v !== null && Number.isFinite(v));
  const maxBurn = burns.length ? Math.max(...burns) : 0;
  const health = t.attention > 0 ? tone({ connected: 1, attention: 1, burnPct: maxBurn }) : tone({ connected: t.connected, attention: 0, burnPct: maxBurn });
  const providerCount = providers.length;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="144" height="144">
    <rect width="144" height="144" rx="12" fill="${health.bg}"/>
    <text x="72" y="20" text-anchor="middle" font-family="Arial" font-size="12" font-weight="700" fill="${health.fg}">JARVIS AI</text>
    <text x="72" y="56" text-anchor="middle" font-family="Arial" font-size="28" font-weight="800" fill="${health.ring}">${t.usable}/${t.connected}</text>
    <text x="72" y="74" text-anchor="middle" font-family="Arial" font-size="10" fill="${health.fg}">usable / connected</text>
    <text x="72" y="96" text-anchor="middle" font-family="Arial" font-size="11" font-weight="700" fill="${health.fg}">${providerCount} providers · ${t.inflight} live</text>
    <text x="72" y="114" text-anchor="middle" font-family="Arial" font-size="10" fill="${health.fg}">${compact(t.requests)} req · ${compact(t.input + t.output)} tok</text>
    <text x="72" y="132" text-anchor="middle" font-family="Arial" font-size="9" fill="${health.fg}">${t.attention ? `${t.attention} need attention` : `max burn ${Math.round(maxBurn)}%`}</text>
  </svg>`;
}

function buildProviderSvg(p) {
  if (!p) return buildWaitingSvg("NO DATA");
  const c = tone(p);
  const burn = p.burnPct === null ? null : Math.max(0, p.burnPct);
  const shown = burn === null ? Math.round((p.usable / Math.max(1, p.connected)) * 100) : Math.round(burn);
  const label = PROVIDER_LABELS[p.kind] || String(p.kind || "AI").toUpperCase().slice(0, 7);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="144" height="144">
    <rect width="144" height="144" rx="12" fill="${c.bg}"/>
    <circle cx="72" cy="66" r="48" fill="none" stroke="#26303a" stroke-width="8"/>
    <path d="${arc(72, 66, 48, Math.min(shown, 100))}" fill="none" stroke="${c.ring}" stroke-width="8" stroke-linecap="round"/>
    <text x="72" y="22" text-anchor="middle" font-family="Arial" font-size="11" font-weight="700" fill="${c.fg}">${label}</text>
    <text x="72" y="62" text-anchor="middle" font-family="Arial" font-size="24" font-weight="800" fill="${c.ring}">${burn === null ? `${p.usable}/${p.connected}` : `${Math.round(burn)}%`}</text>
    <text x="72" y="79" text-anchor="middle" font-family="Arial" font-size="9" fill="${c.fg}">${burn === null ? "usable" : "burn rate"}</text>
    <text x="72" y="103" text-anchor="middle" font-family="Arial" font-size="10" font-weight="700" fill="${c.fg}">${p.usable}/${p.connected} ready · ${p.inflight} live</text>
    <text x="72" y="120" text-anchor="middle" font-family="Arial" font-size="9" fill="${c.fg}">${compact(p.requests)} req · ${compact(p.input + p.output)} tok</text>
    <text x="72" y="136" text-anchor="middle" font-family="Arial" font-size="9" font-weight="700" fill="${c.ring}">${c.state}${p.attention ? ` · ${p.attention} FIX` : ""}</text>
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
    <circle cx="72" cy="67" r="50" fill="none" stroke="#26303a" stroke-width="9"/>
    <path d="${arc(72,67,50,Math.min(pct,100))}" fill="none" stroke="${c.ring}" stroke-width="9" stroke-linecap="round"/>
    <text x="72" y="25" text-anchor="middle" font-family="Arial" font-size="11" font-weight="700" fill="${c.fg}">CLAUDE ${label}</text>
    <text x="72" y="70" text-anchor="middle" font-family="Arial" font-size="27" font-weight="800" fill="${c.ring}">${Math.round(pct)}%</text>
    <text x="72" y="91" text-anchor="middle" font-family="Arial" font-size="10" fill="${c.fg}">used</text>
    <text x="72" y="119" text-anchor="middle" font-family="Arial" font-size="12" font-weight="700" fill="${c.fg}">${p.reset ? timeUntil(p.reset) : "local"}</text>
  </svg>`;
}

function buildWaitingSvg(text = "JARVIS AI") {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="144" height="144"><rect width="144" height="144" rx="12" fill="#0c1016"/><text x="72" y="64" text-anchor="middle" font-family="Arial" font-size="12" font-weight="700" fill="#9aa4b2">${text}</text><text x="72" y="84" text-anchor="middle" font-family="Arial" font-size="10" fill="#667085">waiting for telemetry</text></svg>`;
}

function svgData(svg) { return "data:image/svg+xml;base64," + Buffer.from(svg).toString("base64"); }

const runtimes = new Map();

async function settingsFor(action) {
  try { return await action.getSettings(); }
  catch { return {}; }
}

function availableViews(snapshot) {
  return ["overview", ...PROVIDER_ORDER.filter((p) => snapshot?.providers?.[p])];
}

async function loadSnapshot(settings) {
  if (settings.dataSource !== "local") {
    try { return await readJarvisAi(settings.jarvisAiUrl || DEFAULT_JARVISAI_URL, settings); }
    catch (err) { streamDeck.logger.warn(`JarvisAI telemetry failed: ${err.message}`); }
  }
  return legacySnapshot();
}

async function updateKey(action, runtime = {}) {
  const settings = await settingsFor(action);
  const snapshot = await loadSnapshot(settings);
  runtime.snapshot = snapshot;
  if (!snapshot) { action.setImage(svgData(buildWaitingSvg())); return; }

  let view = settings.viewMode || "overview";
  if (view === "cycle") {
    const views = availableViews(snapshot);
    runtime.viewIndex = Math.max(0, Math.min(runtime.viewIndex || 0, views.length - 1));
    view = views[runtime.viewIndex];
  }
  if (view === "legacy") {
    action.setImage(svgData(buildLegacySvg(legacySnapshot(), settings.displayMode || "auto")));
  } else if (view === "overview") {
    action.setImage(svgData(buildOverviewSvg(snapshot)));
  } else {
    action.setImage(svgData(buildProviderSvg(snapshot.providers[view])));
  }
}

async function startRuntime(action) {
  const id = action.id;
  const old = runtimes.get(id);
  if (old?.timer) clearInterval(old.timer);
  const runtime = old || { viewIndex: 0, timer: null, snapshot: null };
  const settings = await settingsFor(action);
  const seconds = Math.max(10, Math.min(300, num(settings.refreshSeconds, DEFAULT_REFRESH_SECONDS)));
  await updateKey(action, runtime);
  runtime.timer = setInterval(() => updateKey(action, runtime), seconds * 1000);
  runtimes.set(id, runtime);
}

class JarvisAiUsageAction extends SingletonAction {
  constructor() { super(); this.manifestId = "com.jkkec.claude-usage.usage"; }
  onWillAppear(ev) { startRuntime(ev.action); }
  onWillDisappear(ev) { const rt = runtimes.get(ev.action.id); if (rt?.timer) clearInterval(rt.timer); runtimes.delete(ev.action.id); }
  async onKeyDown(ev) {
    const rt = runtimes.get(ev.action.id) || { viewIndex: 0 };
    const settings = await settingsFor(ev.action);
    if ((settings.viewMode || "overview") === "cycle" && rt.snapshot) {
      const views = availableViews(rt.snapshot);
      rt.viewIndex = (rt.viewIndex + 1) % Math.max(1, views.length);
    }
    runtimes.set(ev.action.id, rt);
    await updateKey(ev.action, rt);
  }
  onDidReceiveSettings(ev) { startRuntime(ev.action); }
}

streamDeck.actions.registerAction(new JarvisAiUsageAction());
streamDeck.connect();
