// Reads every PoB build in the builds folder, parses it, loads the passive tree data each build
// references, and writes:
//   out/data.json   - everything, for other scripts / later tooling
//   out/index.html  - self-contained viewer (data embedded, opens straight from disk)
//
// Usage: node build.mjs [--builds <dir>] [--pob <PoB install dir>] [--open]
import { readFileSync, writeFileSync, mkdirSync, readdirSync, statSync } from "fs";
import { join, relative, dirname } from "path";
import { fileURLToPath } from "url";
import { execFile } from "child_process";
import { homedir } from "os";
import { parseBuildXml } from "./lib/parse-build.mjs";
import { loadTree } from "./lib/tree.mjs";
import { parseLuaTable } from "./lib/lua-table.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const arg = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };

const config = JSON.parse(readFileSync(join(here, "config.json"), "utf8"));
const buildsDir = arg("--builds", config.buildsDir.replace(/^~/, homedir()));
const pobDir = arg("--pob", config.pobDir.replace(/%APPDATA%/i, process.env.APPDATA));

function walk(dir) {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? walk(p) : /\.xml$/i.test(f) ? [p] : [];
  });
}

const builds = [];
const versions = new Set();
for (const file of walk(buildsDir)) {
  const rel = relative(buildsDir, file).replace(/\\/g, "/");
  try {
    const b = parseBuildXml(readFileSync(file, "utf8"));
    const st = statSync(file);
    builds.push({ file: rel, name: rel.replace(/\.xml$/i, ""), modified: st.mtime.toISOString(), ...b });
    b.tree.specs.forEach((s) => s.treeVersion && versions.add(s.treeVersion));
  } catch (e) {
    console.warn(`skip ${rel}: ${e.message}`);
  }
}
builds.sort((a, b) => b.modified.localeCompare(a.modified));

const trees = {};
for (const v of versions) {
  try {
    trees[v] = loadTree(pobDir, v);
  } catch (e) {
    console.warn(`tree ${v}: ${e.message}`);
  }
}

// Gem colour (dominant attribute requirement) and tags from PoB's Data/Gems.lua.
try {
  const gems = parseLuaTable(readFileSync(join(pobDir, "Data", "Gems.lua"), "utf8"));
  const byEffect = {};
  for (const g of Object.values(gems)) byEffect[g.grantedEffectId] = g;
  for (const b of builds) for (const s of b.skills.sets) for (const grp of s.groups) for (const gem of grp.gems) {
    const g = byEffect[gem.skillId] ?? gems[gem.gemId];
    if (!g) continue;
    const req = { R: g.reqStr ?? 0, G: g.reqDex ?? 0, B: g.reqInt ?? 0 };
    const top = Object.entries(req).sort((a, b) => b[1] - a[1])[0];
    gem.color = top[1] > 0 ? top[0] : "W";
    gem.tags = g.tagString ?? "";
    if (g.tags?.support) gem.support = true;
  }
} catch (e) {
  console.warn(`gem data: ${e.message}`);
}

const data = { generated: new Date().toISOString(), buildsDir, pobDir, builds, trees };
const outDir = join(here, "out");
mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, "data.json"), JSON.stringify(data));

const template = readFileSync(join(here, "viewer", "viewer.html"), "utf8");
const embedded = JSON.stringify(data).replace(/</g, "\\u003c");
writeFileSync(join(outDir, "index.html"), template.replace("/*__POB_DATA__*/null", () => embedded));

const kb = (p) => Math.round(statSync(join(outDir, p)).size / 1024);
console.log(`${builds.length} builds, trees: ${[...versions].join(", ") || "none"}`);
console.log(`out/index.html (${kb("index.html")} KB), out/data.json (${kb("data.json")} KB)`);

if (args.includes("--open")) execFile("cmd", ["/c", "start", "", join(outDir, "index.html")]);
