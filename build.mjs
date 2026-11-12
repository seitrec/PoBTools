// Reads every PoB build in the builds folder, parses it, loads the passive tree data each build
// references, and writes:
//   out/data.json   - everything, for other scripts / later tooling
//   out/index.html  - self-contained viewer (data embedded, opens straight from disk)
//
// Usage: node build.mjs [--builds <dir>] [--pob <PoB install dir>] [--open]
import { readFileSync, writeFileSync, mkdirSync, readdirSync, statSync, existsSync } from "fs";
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

// Only the newest game-version folder counts (e.g. "3.30"; a "3.31" folder would replace it). Loose files at the
// root, "old/" and older version folders are ignored.
const versionOf = (name) => (/^\d+(\.\d+)*$/.test(name) ? name.split(".").map(Number) : null);
const newer = (a, b) => { for (let i = 0; i < Math.max(a.length, b.length); i++) if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0); return false; };
const latest = readdirSync(buildsDir, { withFileTypes: true })
  .filter((d) => d.isDirectory() && versionOf(d.name))
  .reduce((best, d) => (!best || newer(versionOf(d.name), versionOf(best)) ? d.name : best), null);
if (!latest) throw new Error(`No version folder (like "3.30") in ${buildsDir}`);
const versionDir = join(buildsDir, latest);
console.log(`using builds from ${latest}/`);

const builds = [];
const versions = new Set();
for (const file of walk(versionDir)) {
  const rel = relative(versionDir, file).replace(/\\/g, "/");
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
  const byEffect = {}, byGameId = {};
  for (const g of Object.values(gems)) {
    byEffect[g.grantedEffectId] = g;
    // Several entries share a gameId (base + transfigured "AltX/AltY" variants); the base one wins.
    if (/Alt[XYZ]?$/.test(g.variantId ?? "")) byGameId[g.gameId] ??= g;
    else byGameId[g.gameId] = g;
  }
  const itemName = (g) => g.baseTypeName ?? (g.tags?.support ? `${g.name} Support` : g.name);
  for (const b of builds) for (const s of b.skills.sets) for (const grp of s.groups) for (const gem of grp.gems) {
    const g = byEffect[gem.skillId] ?? gems[gem.gemId];
    if (!g) continue;
    // Shop/quest name of the gem item (transfigured gems resolve to their base gem via gemId).
    gem.baseName = itemName(byGameId[gem.gemId] ?? g);
    const req = { R: g.reqStr ?? 0, G: g.reqDex ?? 0, B: g.reqInt ?? 0 };
    const top = Object.entries(req).sort((a, b) => b[1] - a[1])[0];
    gem.color = top[1] > 0 ? top[0] : "W";
    gem.tags = g.tagString ?? "";
    if (g.tags?.support) gem.support = true;
  }
} catch (e) {
  console.warn(`gem data: ${e.message}`);
}

// Quest reward / vendor availability + search regexes (from `node fetch-sources.mjs`).
const sourcesFile = join(here, "data", "gem-sources.json");
const gemSources = existsSync(sourcesFile) ? JSON.parse(readFileSync(sourcesFile, "utf8")) : null;
if (!gemSources) console.warn("no data/gem-sources.json - run `node fetch-sources.mjs` for the Leveling tab");

const data = { generated: new Date().toISOString(), buildsDir: versionDir, pobDir, builds, trees, gemSources };
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
