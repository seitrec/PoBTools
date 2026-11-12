// Gathers per-gem acquisition data and search regexes from two external sources, politely:
//   - poedb.tw/us/Quest : ONE page holding the quest-reward and quest-vendor tables (quest x class) and the
//                         ordered quest list
//   - poe.re            : the gem -> stash/vendor-search regex table (one JSON file)
// Raw downloads are cached in cache/ and only re-downloaded with --refresh.
// Output: data/gem-sources.json (consumed by build.mjs).
//
// Usage: node fetch-sources.mjs [--refresh]
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { parse } from "node-html-parser";

const here = dirname(fileURLToPath(import.meta.url));
const refresh = process.argv.includes("--refresh");
const UA = "PoBTools/0.1 (personal build viewer)";
const CLASSES = ["Marauder", "Witch", "Scion", "Ranger", "Duelist", "Shadow", "Templar"];
const LILLY = { name: "Lilly Roth (Act 6)", act: 6, lilly: true };

async function cached(file, url, kind = "text") {
  const p = join(here, "cache", file);
  if (!refresh && existsSync(p)) return kind === "json" ? JSON.parse(readFileSync(p, "utf8")) : readFileSync(p, "utf8");
  console.log(`GET ${url}`);
  const res = await fetch(url, { headers: { "user-agent": UA } });
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  const body = await res.text();
  mkdirSync(join(here, "cache"), { recursive: true });
  writeFileSync(p, body);
  return kind === "json" ? JSON.parse(body) : body;
}

// ---------- poe.re regexes ----------
const current = await cached("poere-current.json", "https://data.poe.re/current.json", "json");
const patch = current.current.poe1.patch;
const poere = await cached(`poere-gems-${patch}.json`, `https://data.poe.re/generated/poe1/${patch}/gems/Generated.Gems.ENGLISH.min.json`, "json");

// ---------- poedb quest page ----------
const html = parse(await cached("poedb-quest.html", "https://poedb.tw/us/Quest"));
const cardByHeader = (prefix) =>
  html.querySelectorAll(".card").find((c) => (c.querySelector(".card-header")?.text ?? "").trim().startsWith(prefix) && c.querySelector("table, .col"));

// Quest x class tables. Class columns come from a header row (thead or a first row of class names).
function questClassTable(card) {
  const out = [];
  let cols = CLASSES;
  for (const tr of card.querySelectorAll("tr")) {
    const cells = tr.childNodes.filter((n) => n.tagName === "TD" || n.tagName === "TH");
    const texts = cells.map((c) => c.text.trim());
    if (texts.length > 2 && texts.slice(1).every((t) => CLASSES.includes(t))) { cols = texts.slice(1); continue; }
    const questLink = cells[0]?.querySelector("a");
    if (!questLink) continue;
    const quest = questLink.text.trim();
    const act = /Act\s*(-?\d+)/.exec(cells[0].text)?.[1];
    cells.slice(1).forEach((td, i) => {
      for (const a of td.querySelectorAll("a")) {
        const item = a.text.trim();
        if (item) out.push({ quest, act: act === undefined ? null : Number(act), cls: cols[i], item });
      }
    });
  }
  return out;
}
const rewards = questClassTable(cardByHeader("Quest Reward"));
const vendor = questClassTable(cardByHeader("Quest Vendor Rewards"));

// Ordered quest list (game order within acts; master missions / heist listed first and ignored here).
const questList = cardByHeader("Quest /").querySelectorAll(".col").map((c) => {
  const props = c.querySelectorAll(".property").map((p) => p.text.trim());
  const act = props.map((p) => /^Act\s*(-?\d+)$/.exec(p)?.[1]).find((x) => x !== undefined);
  return { name: c.querySelector(".flex-grow-1 a")?.text.trim(), act: act === undefined ? null : Number(act), type: props[0] };
}).filter((q) => q.name);

// ---------- join ----------
const tokenByName = new Map(poere.tokens.map((t) => [t.rawText, t]));
const isGem = (name) => tokenByName.has(name);

const gems = {};
const gem = (name) => (gems[name] ??= { reward: {}, vendor: {} });
for (const r of rewards) if (isGem(r.item)) (gem(r.item).reward[r.quest] ??= []).push(r.cls);
for (const v of vendor) if (isGem(v.item)) (gem(v.item).vendor[v.quest] ??= []).push(v.cls);

// Quests referenced by gem data, in game order. Act: the reward table's act when it has one, else first list hit.
const used = new Set(Object.values(gems).flatMap((g) => [...Object.keys(g.reward), ...Object.keys(g.vendor)]));
const rewardAct = Object.fromEntries(rewards.filter((r) => r.act !== null).map((r) => [r.quest, r.act]));
const quests = [];
if (used.has("The Twilight Strand")) quests.push({ name: "The Twilight Strand", act: 1 });
questList.forEach((q, idx) => {
  if (!used.has(q.name) || quests.some((x) => x.name === q.name)) return;
  const act = rewardAct[q.name] ?? q.act;
  // Prefer the occurrence whose act matches the reward table (e.g. Return to Oriath: Act 5, not the Act 4 entry).
  const match = questList.findIndex((x) => x.name === q.name && x.act === act);
  quests.push({ name: q.name, act, listIndex: match >= 0 ? match : idx });
});
const missing = [...used].filter((n) => !quests.some((q) => q.name === n));
if (missing.length) console.warn("quests not found in the ordered list:", missing);
quests.sort((a, b) => (a.listIndex ?? -1) - (b.listIndex ?? -1));
// Lilly Roth sells every gem to every class from the start of Act 6.
const lillyAt = quests.findIndex((q) => q.act >= 6);
quests.splice(lillyAt < 0 ? quests.length : lillyAt, 0, LILLY);
quests.forEach((q, i) => { q.order = i; delete q.listIndex; });

const tokens = Object.fromEntries(poere.tokens.map((t) => [t.rawText, {
  id: t.id, regex: t.regex, color: t.options.c, support: !!t.options.support,
}]));
const optimization = Object.values(poere.optimizationTable).map((o) => ({ ids: o.ids, regex: o.regex }));

const out = {
  generated: new Date().toISOString(),
  sources: { poedb: "https://poedb.tw/us/Quest", poere: `poe.re gems regex, patch ${patch}` },
  classes: CLASSES,
  lilly: LILLY.name,
  quests,
  gems,
  regex: { tokens, optimization },
};
mkdirSync(join(here, "data"), { recursive: true });
writeFileSync(join(here, "data", "gem-sources.json"), JSON.stringify(out, null, 1));
console.log(`${Object.keys(gems).length} gems with quest data, ${quests.length} quests (incl. Lilly), ${Object.keys(tokens).length} regex tokens, ${optimization.length} shared regexes (poe.re ${patch})`);
const skipped = [...new Set([...rewards, ...vendor].map((r) => r.item).filter((n) => !isGem(n)))];
console.log(`non-gem rewards skipped: ${skipped.length} (e.g. ${skipped.slice(0, 6).join(", ")})`);
