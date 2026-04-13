const { streamDeck, SingletonAction } = require("@elgato/streamdeck");
const fs = require("fs");
const path = require("path");
const os = require("os");

const RATE_LIMITS_PATH = path.join(os.homedir(), ".claude", "rate_limits.json");
const UPDATE_MS = 5 * 60 * 1000;

function readRateLimits() {
  try {
    return JSON.parse(fs.readFileSync(RATE_LIMITS_PATH, "utf8"));
  } catch {
    return null;
  }
}

function timeUntil(epochSec) {
  const ms = epochSec * 1000 - Date.now();
  if (ms <= 0) return { value: 0, unit: "h" };
  const hours = ms / 3600000;
  if (hours >= 48) {
    return { value: Math.round(hours / 24 * 10) / 10, unit: "d" };
  }
  return { value: Math.round(hours * 10) / 10, unit: "h" };
}

// Draws arc that fills from bottom upward, 0% at bottom, 100% at top
function describeArc(cx, cy, r, pct) {
  const angle = Math.min(Math.max(pct * 3.6, 1), 359.9);
  // 0 deg = 12 o'clock (top). We want 100% to end at top (0 deg).
  // Start: 0 - angle (goes backwards from top), End: 0 (top)
  // At low %, the arc is a small sliver near the top... that's wrong.
  // We want: start at bottom, fill up both sides, meet at top.
  // So: start at (180 + angle/2), sweep clockwise to (180 - angle/2)
  // This spreads symmetrically from bottom upward on both sides.
  const half = angle / 2;
  const startDeg = 180 + half;
  const endDeg = 180 - half;
  const rad = (deg) => ((deg - 90) * Math.PI) / 180;
  const x1 = cx + r * Math.cos(rad(startDeg));
  const y1 = cy + r * Math.sin(rad(startDeg));
  const x2 = cx + r * Math.cos(rad(endDeg));
  const y2 = cy + r * Math.sin(rad(endDeg));
  // Sweep goes clockwise from start to end (the short way round when <180, long way when >180)
  // But startDeg > endDeg so clockwise sweep goes the long way round = through the top
  const largeArc = angle > 180 ? 1 : 0;
  // Sweep flag 0 = counter-clockwise (from start, goes up through top to end)
  return `M ${x1} ${y1} A ${r} ${r} 0 ${largeArc} 0 ${x2} ${y2}`;
}

function buildSvg(data, displayMode) {
  const size = 144;
  const cx = size / 2;
  const cy = size / 2;

  if (!data || (!data.five_hour && !data.seven_day)) {
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}">
      <rect width="${size}" height="${size}" fill="#000000" rx="12"/>
      <text x="${cx}" y="${cy}" text-anchor="middle" dominant-baseline="central"
            font-family="Arial,sans-serif" font-size="14" fill="#888">Waiting...</text>
    </svg>`;
  }

  const fiveH = data.five_hour || {};
  const sevenD = data.seven_day || {};
  const fiveHPct = fiveH.used_percentage || 0;
  const sevenDPct = sevenD.used_percentage || 0;

  let usedPct, resetAt, label;
  const mode = displayMode || "auto";

  if (mode === "five_hour") {
    usedPct = fiveHPct;
    resetAt = fiveH.resets_at || 0;
    label = "5H";
  } else if (mode === "seven_day") {
    usedPct = sevenDPct;
    resetAt = sevenD.resets_at || 0;
    label = "7D";
  } else {
    // auto: pick whichever is higher
    if (fiveHPct >= sevenDPct) {
      usedPct = fiveHPct;
      resetAt = fiveH.resets_at || 0;
      label = "5H";
    } else {
      usedPct = sevenDPct;
      resetAt = sevenD.resets_at || 0;
      label = "7D";
    }
  }

  const time = timeUntil(resetAt);
  // Time elapsed as % of the window (5h = 18000s, 7d = 604800s)
  const windowSec = label === "5H" ? 5 * 3600 : 7 * 24 * 3600;
  const secsLeft = Math.max((resetAt * 1000 - Date.now()) / 1000, 0);
  const timeElapsedPct = Math.min(((windowSec - secsLeft) / windowSec) * 100, 100);

  // Session (5H) = red, Weekly (7D) = green, time = blue
  const usedColor = label === "5H" ? "#ff4757" : "#2ed573";
  const remainColor = "#3b9dff";
  const bgRing = "#2f3542";
  const timeColor = "#3b9dff";
  const bgColor = usedPct > timeElapsedPct ? "#6b0000" : "#000000";

  const outerR = 62;
  const innerR = 47;
  const sw = 10;

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}">
  <rect width="${size}" height="${size}" fill="${bgColor}" rx="12"/>
  <circle cx="${cx}" cy="${cy}" r="${outerR}" fill="none" stroke="${bgRing}" stroke-width="${sw}"/>
  <path d="${describeArc(cx, cy, outerR, usedPct)}" fill="none" stroke="${usedColor}" stroke-width="${sw}" stroke-linecap="round"/>
  <circle cx="${cx}" cy="${cy}" r="${innerR}" fill="none" stroke="${bgRing}" stroke-width="${sw}"/>
  <path d="${describeArc(cx, cy, innerR, timeElapsedPct)}" fill="none" stroke="${remainColor}" stroke-width="${sw}" stroke-linecap="round"/>
  <text x="${cx}" y="${cy - 16}" text-anchor="middle" dominant-baseline="central" font-family="Arial,sans-serif" font-size="11" font-weight="bold" fill="${usedColor}">${label}</text>
  <text x="${cx}" y="${cy + 4}" text-anchor="middle" dominant-baseline="central" font-family="Arial,sans-serif" font-size="24" font-weight="bold" fill="${timeColor}">${time.value}${time.unit}</text>
  <text x="${cx}" y="${cy + 22}" text-anchor="middle" dominant-baseline="central" font-family="Arial,sans-serif" font-size="11" fill="${usedColor}">${Math.round(usedPct)}% used</text>
</svg>`;
}

function svgToBase64(svg) {
  return "data:image/svg+xml;base64," + Buffer.from(svg).toString("base64");
}

async function updateKey(action) {
  const data = readRateLimits();
  let displayMode = "auto";
  try {
    const s = await action.getSettings();
    displayMode = s.displayMode || "auto";
  } catch {}
  const svg = buildSvg(data, displayMode);
  action.setImage(svgToBase64(svg));
}

const intervals = new Map();

class ClaudeUsageAction extends SingletonAction {
  constructor() {
    super();
    this.manifestId = "com.jkkec.claude-usage.usage";
  }

  onWillAppear(ev) {
    updateKey(ev.action);
    const iv = setInterval(() => updateKey(ev.action), UPDATE_MS);
    intervals.set(ev.action.id, iv);
  }

  onWillDisappear(ev) {
    const iv = intervals.get(ev.action.id);
    if (iv) clearInterval(iv);
    intervals.delete(ev.action.id);
  }

  onKeyDown(ev) {
    updateKey(ev.action);
  }

  onDidReceiveSettings(ev) {
    updateKey(ev.action);
  }
}

streamDeck.actions.registerAction(new ClaudeUsageAction());
streamDeck.connect();
