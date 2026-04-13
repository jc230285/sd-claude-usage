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

function describeArc(cx, cy, r, startAngle, endAngle) {
  const rad = (deg) => ((deg - 90) * Math.PI) / 180;
  const x1 = cx + r * Math.cos(rad(startAngle));
  const y1 = cy + r * Math.sin(rad(startAngle));
  const x2 = cx + r * Math.cos(rad(endAngle));
  const y2 = cy + r * Math.sin(rad(endAngle));
  const largeArc = endAngle - startAngle > 180 ? 1 : 0;
  return `M ${x1} ${y1} A ${r} ${r} 0 ${largeArc} 1 ${x2} ${y2}`;
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

  const remainPct = 100 - usedPct;
  const time = timeUntil(resetAt);

  // Session (5H) = red, Weekly (7D) = green, time = blue
  const usedColor = label === "5H" ? "#ff4757" : "#2ed573";
  const remainColor = "#3b9dff";
  const bgRing = "#2f3542";
  const timeColor = "#3b9dff";
  const bgColor = remainPct < usedPct ? "#3a0000" : "#000000";

  const outerR = 62;
  const innerR = 47;
  const sw = 10;

  const usedAngle = Math.min(Math.max(usedPct * 3.6, 1), 359.9);
  const remainAngle = Math.min(Math.max(remainPct * 3.6, 1), 359.9);

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}">
  <rect width="${size}" height="${size}" fill="${bgColor}" rx="12"/>
  <circle cx="${cx}" cy="${cy}" r="${outerR}" fill="none" stroke="${bgRing}" stroke-width="${sw}"/>
  <path d="${describeArc(cx, cy, outerR, 180, 180 + usedAngle)}" fill="none" stroke="${usedColor}" stroke-width="${sw}" stroke-linecap="round"/>
  <circle cx="${cx}" cy="${cy}" r="${innerR}" fill="none" stroke="${bgRing}" stroke-width="${sw}"/>
  <path d="${describeArc(cx, cy, innerR, 180, 180 + remainAngle)}" fill="none" stroke="${remainColor}" stroke-width="${sw}" stroke-linecap="round"/>
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
