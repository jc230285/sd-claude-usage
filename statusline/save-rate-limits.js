#!/usr/bin/env node
// Claude Code statusline script that saves rate_limits data to a JSON file.
// Configure in ~/.claude/settings.json under "statusline" key.
const fs = require("fs");
const path = require("path");
const os = require("os");

const OUTPUT_PATH = path.join(os.homedir(), ".claude", "rate_limits.json");

let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => (input += chunk));
process.stdin.on("end", () => {
  try {
    const data = JSON.parse(input);
    if (data.rate_limits) {
      const out = {
        ...data.rate_limits,
        updated_at: Date.now(),
      };
      fs.writeFileSync(OUTPUT_PATH, JSON.stringify(out, null, 2));
    }
  } catch {
    // ignore parse errors
  }
});
