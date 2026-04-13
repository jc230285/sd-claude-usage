const esbuild = require("esbuild");
const fs = require("fs");
const path = require("path");

const watch = process.argv.includes("--watch");

const opts = {
  entryPoints: ["src/plugin.js"],
  bundle: true,
  platform: "node",
  target: "node20",
  outfile: "com.jkkec.claude-usage.sdPlugin/bin/plugin.js",
  format: "cjs",
  external: ["@elgato/streamdeck"],
};

if (watch) {
  esbuild.context(opts).then((ctx) => ctx.watch());
  console.log("Watching...");
} else {
  esbuild.buildSync(opts);
  console.log("Built.");
}
