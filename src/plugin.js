const streamDeck = require("@elgato/streamdeck");
const fs = require("fs");
const path = require("path");
const os = require("os");

const RATE_LIMITS_PATH = path.join(os.homedir(), ".claude", "rate_limits.json");
const UPDATE_MS = 5 * 60 * 1000;

const intervals = new Map();

function readRateLimits() {
  try {
    const raw = fs.readFileSync(RATE_LIMITS_PATH, "utf8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function hoursUntil(epochSec) {
  const ms = epochSec * 1000 - Date.now();
  if (ms <= 0) return 0;
  return Math.round((ms / 3600000) * 10) / 10;
}

function arcPath(cx, cy, r, startDeg, endDeg) {
  const startRad = ((startDeg - 90) * Math.PI) / 180;
  const endRad = ((endDeg - 90) * Math.PI) / 180;
  const x1 = cx + r * Math.cos(startRad);
  const y1 = cy + r * Math.sin(startRad);
  const x2 = cx + r * Math.cos(endRad);
  const y2 = cy + r * Math.sin(endRad);
  const large = endDeg - startDeg > 180 ? 1 : 0;
  return `M ${x1} ${y1} A ${r} ${r} 0 ${large} 1 ${x2} ${y2}`;
}

function buildSvg(data) {
  const size = 144;
  const cx = size / 2;
  const cy = size / 2;

  let usedPct = 0;
  let resetAt = 0;
  let label = "";

  if (!data || (!data.five_hour && !data.seven_day)) {
    // No data - show waiting state
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}">
      <rect width="${size}" height="${size}" fill="#1a1a2e" rx="12"/>
      <text x="${cx}" y="${cy}" text-anchor="middle" dominant-baseline="central"
            font-family="Arial,sans-serif" font-size="14" fill="#888">Waiting...</text>
    </svg>`;
  }

  const fiveH = data.five_hour || {};
  const sevenD = data.seven_day || {};
  const fiveHPct = fiveH.used_percentage || 0;
  const sevenDPct = sevenD.used_percentage || 0;

  // Pick whichever window has higher usage
  if (fiveHPct >= sevenDPct) {
    usedPct = fiveHPct;
    resetAt = fiveH.resets_at || 0;
    label = "5H";
  } else {
    usedPct = sevenDPct;
    resetAt = sevenD.resets_at || 0;
    label = "7D";
  }

  const remainPct = 100 - usedPct;
  const hours = hoursUntil(resetAt);

  // Colors
  const usedColor = usedPct > 80 ? "#ff4757" : usedPct > 50 ? "#ffa502" : "#2ed573";
  const remainColor = "#3742fa";
  const bgRingColor = "#2f3542";

  // Outer ring = usage %, Inner ring = remaining %
  const outerR = 62;
  const innerR = 47;
  const strokeW = 10;

  const usedAngle = Math.max(usedPct * 3.6, 0.1);
  const remainAngle = Math.max(remainPct * 3.6, 0.1);

  // Clamp to avoid full-circle SVG arc issue
  const clamp = (a) => Math.min(a, 359.9);

  let svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}">
  <rect width="${size}" height="${size}" fill="#1a1a2e" rx="12"/>

  <!-- Outer ring background -->
  <circle cx="${cx}" cy="${cy}" r="${outerR}" fill="none" stroke="${bgRingColor}" stroke-width="${strokeW}"/>
  <!-- Outer ring: usage % -->
  <path d="${arcPath(cx, cy, outerR, 0, clamp(usedAngle))}"
        fill="none" stroke="${usedColor}" stroke-width="${strokeW}" stroke-linecap="round"/>

  <!-- Inner ring background -->
  <circle cx="${cx}" cy="${cy}" r="${innerR}" fill="none" stroke="${bgRingColor}" stroke-width="${strokeW}"/>
  <!-- Inner ring: remaining % -->
  <path d="${arcPath(cx, cy, innerR, 0, clamp(remainAngle))}"
        fill="none" stroke="${remainColor}" stroke-width="${strokeW}" stroke-linecap="round"/>

  <!-- Center text: hours until reset -->
  <text x="${cx}" y="${cx - 16}" text-anchor="middle" dominant-baseline="central"
        font-family="Arial,sans-serif" font-size="11" font-weight="bold" fill="#aaa">${label}</text>
  <text x="${cx}" y="${cx + 4}" text-anchor="middle" dominant-baseline="central"
        font-family="Arial,sans-serif" font-size="24" font-weight="bold" fill="#fff">${hours}h</text>
  <text x="${cx}" y="${cx + 22}" text-anchor="middle" dominant-baseline="central"
        font-family="Arial,sans-serif" font-size="11" fill="#aaa">${Math.round(usedPct)}% used</text>
</svg>`;

  return svg;
}

function updateKey(action) {
  const data = readRateLimits();
  const svg = buildSvg(data);
  const encoded = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
  action.setImage(encoded);
}

const claudeUsage = new streamDeck.Action("com.jkkec.claude-usage.usage");

claudeUsage.onWillAppear(({ action }) => {
  updateKey(action);
  const iv = setInterval(() => updateKey(action), UPDATE_MS);
  intervals.set(action.id, iv);
});

claudeUsage.onWillDisappear(({ action }) => {
  const iv = intervals.get(action.id);
  if (iv) clearInterval(iv);
  intervals.delete(action.id);
});

claudeUsage.onKeyDown(({ action }) => {
  // Manual refresh on press
  updateKey(action);
});

streamDeck.registerAction(claudeUsage);
streamDeck.connect();
