// Parses a PoB (PoE1) build XML into a plain JSON-friendly object:
// meta, stats, skill sets (socket groups + gems), item sets (slot -> item), tree specs, notes.
import { XMLParser } from "fast-xml-parser";

const ARRAY_TAGS = new Set([
  "PlayerStat", "MinionStat", "SkillSet", "Skill", "Gem", "Item", "ItemSet", "Slot",
  "Spec", "Socket", "Input", "Placeholder", "ConfigSet", "ModRange", "SocketIdURL",
]);

const xml = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "",
  parseAttributeValue: false,
  textNodeName: "#text",
  trimValues: false,
  isArray: (name) => ARRAY_TAGS.has(name),
});

const num = (v) => (v === undefined || v === "" || isNaN(Number(v)) ? v : Number(v));
const bool = (v) => v === "true" || v === true;
// PoB loadouts: tree/item/skill sets whose titles end in the same "{n}" belong together.
const loadout = (title) => {
  const m = /\s*\{(\d+)\}\s*$/.exec(title || "");
  return m ? { title: title.slice(0, m.index), loadout: Number(m[1]) } : { title, loadout: null };
};
const text = (node) => (typeof node === "string" ? node : node?.["#text"] ?? "");

export function parseBuildXml(src) {
  const root = xml.parse(src).PathOfBuilding;
  if (!root) throw new Error("Not a PathOfBuilding XML");
  const b = root.Build ?? {};

  const stats = {};
  for (const s of b.PlayerStat ?? []) stats[s.stat] = num(s.value);
  const minionStats = {};
  for (const s of b.MinionStat ?? []) minionStats[s.stat] = num(s.value);

  return {
    meta: {
      className: b.className,
      ascendClassName: b.ascendClassName,
      level: num(b.level),
      bandit: b.bandit,
      pantheonMajor: b.pantheonMajorGod,
      pantheonMinor: b.pantheonMinorGod,
      mainSocketGroup: num(b.mainSocketGroup),
      targetVersion: b.targetVersion,
    },
    stats,
    minionStats,
    skills: parseSkills(root.Skills),
    items: parseItems(root.Items),
    tree: parseTree(root.Tree),
    notes: text(root.Notes).replace(/\^x[0-9A-Fa-f]{6}|\^\d/g, "").trim(),
  };
}

function parseSkills(sk) {
  if (!sk) return { active: null, sets: [] };
  // Older builds have <Skill> directly under <Skills>; newer ones wrap them in <SkillSet>.
  const sets = sk.SkillSet ?? [{ id: "1", title: "Default", Skill: sk.Skill ?? [] }];
  return {
    active: num(sk.activeSkillSet),
    sets: sets.map((s) => ({
      id: num(s.id),
      ...loadout(s.title || `Skill set ${s.id}`),
      groups: (s.Skill ?? []).map((g) => ({
        label: g.label || "",
        slot: g.slot || "",
        enabled: bool(g.enabled),
        includeInFullDPS: bool(g.includeInFullDPS),
        source: g.source || "",
        gems: (g.Gem ?? []).filter((x) => x.nameSpec || x.skillId).map((x) => ({
          name: x.nameSpec || x.skillId,
          skillId: x.skillId || "",
          gemId: x.gemId || "",
          level: num(x.level),
          quality: num(x.quality),
          qualityId: x.qualityId || "Default",
          enabled: bool(x.enabled),
          support: /^Support/.test(x.skillId || "") || /Support/.test(x.gemId || ""),
          count: num(x.count) ?? 1,
        })),
      })),
    })),
  };
}

function parseItems(it) {
  if (!it) return { active: null, items: {}, sets: [] };
  const items = {};
  for (const raw of it.Item ?? []) {
    const parsed = parseItemText(text(raw));
    // Newer PoB stores the selected variant and the roll ranges as attributes / child nodes.
    if (raw.variant) parsed.variant = num(raw.variant);
    items[raw.id] = { id: num(raw.id), ...parsed };
  }
  return {
    active: num(it.activeItemSet),
    items,
    sets: (it.ItemSet ?? []).map((s) => ({
      id: num(s.id),
      ...loadout(s.title || `Item set ${s.id}`),
      useSecondWeaponSet: bool(s.useSecondWeaponSet),
      slots: (s.Slot ?? [])
        .filter((x) => x.itemId && x.itemId !== "0")
        .map((x) => ({ name: x.name, itemId: num(x.itemId), active: x.active === undefined ? true : bool(x.active) })),
    })),
  };
}

const HEADER_KEYS = new Set([
  "Unique ID", "Item Level", "LevelReq", "Quality", "CatalystQuality", "Sockets", "Implicits",
  "Selected Variant", "Selected Alt Variant", "Selected Alt Variant Two", "Has Alt Variant",
  "Has Alt Variant Two", "League", "Source", "Upgrade", "Variant", "Radius", "Limited to",
  "Evasion", "Armour", "Energy Shield", "Ward", "EvasionBasePercentile", "ArmourBasePercentile",
  "EnergyShieldBasePercentile", "WardBasePercentile", "Talisman Tier", "Requires", "Catalyst",
  "Cluster Jewel Skill", "Cluster Jewel Node Count", "Prefix", "Suffix", "Crafted", "Imbued",
]);

// Turns PoB's raw item text into { rarity, name, base, props, implicits[], explicits[], ... }.
export function parseItemText(t) {
  const lines = t.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const out = { rarity: "NORMAL", name: "", base: "", props: {}, variants: [], implicits: [], explicits: [], flags: [] };
  let i = 0;
  if (/^Rarity:/.test(lines[0] ?? "")) out.rarity = lines[i++].slice(7).trim().toUpperCase();
  out.name = lines[i++] ?? "";
  if (out.rarity !== "NORMAL" && out.rarity !== "MAGIC" && lines[i] && !/^[\w ]+:/.test(lines[i])) out.base = lines[i++];
  else out.base = out.name;

  let implicitCount = null;
  const mods = [];
  for (; i < lines.length; i++) {
    const l = lines[i];
    const m = /^([A-Za-z ]+):\s*(.*)$/.exec(l);
    if (m && HEADER_KEYS.has(m[1]) && implicitCount === null) {
      if (m[1] === "Variant") out.variants.push(m[2]);
      else if (m[1] === "Implicits") implicitCount = Number(m[2]);
      else out.props[m[1]] = num(m[2]);
      continue;
    }
    if (/^(Corrupted|Mirrored|Split|Fractured Item|Synthesised Item|Unidentified|Shaper Item|Elder Item|Crusader Item|Redeemer Item|Hunter Item|Warlord Item|Searing Exarch Item|Eater of Worlds Item)$/.test(l)) {
      out.flags.push(l);
      continue;
    }
    if (implicitCount === null && m && /^[A-Z][A-Za-z ]+$/.test(m[1]) && !/[%+]/.test(l)) {
      out.props[m[1]] = num(m[2]); // unknown header field, keep it rather than mis-read as a mod
      continue;
    }
    mods.push(l);
  }

  const selected = out.props["Selected Variant"];
  const selectedAlt = [out.props["Selected Alt Variant"], out.props["Selected Alt Variant Two"]].filter(Boolean);
  const kept = [];
  for (const raw of mods) {
    const mod = parseModLine(raw);
    if (mod.variants && selected !== undefined) {
      const ok = mod.variants.includes(selected) || mod.variants.some((v) => selectedAlt.includes(v));
      if (!ok) continue;
    }
    kept.push(mod);
  }
  const ic = implicitCount ?? 0;
  out.implicits = kept.slice(0, ic);
  out.explicits = kept.slice(ic);
  if (out.variants.length && selected) out.variantName = out.variants[selected - 1];
  return out;
}

// "{crafted}{range:0.5}+(10-20) to maximum Life" -> { text: "+15 to maximum Life", crafted: true, ... }
function parseModLine(raw) {
  const mod = { text: "", tags: [] };
  let s = raw;
  let range = 0.5;
  for (;;) {
    const m = /^\{([^}]*)\}/.exec(s);
    if (!m) break;
    s = s.slice(m[0].length);
    const [k, v] = m[1].split(":");
    if (k === "range") range = Number(v);
    else if (k === "variant") mod.variants = v.split(",").map(Number);
    else if (k === "tags") mod.tags = v.split(",");
    else mod[k] = v ?? true; // crafted, fractured, enchant, scourge, crucible, custom, exarch, eater...
  }
  mod.text = resolveRanges(s, range);
  return mod;
}

function resolveRanges(s, r) {
  return s.replace(/\((-?[\d.]+)-(-?[\d.]+)\)/g, (_, a, b) => {
    const lo = Number(a), hi = Number(b);
    const dec = Math.max((a.split(".")[1] ?? "").length, (b.split(".")[1] ?? "").length);
    const v = lo + (hi - lo) * r;
    return dec ? v.toFixed(dec) : String(Math.round(v));
  });
}

function parseTree(tr) {
  if (!tr) return { active: null, specs: [] };
  return {
    active: num(tr.activeSpec),
    specs: (tr.Spec ?? []).map((s, idx) => ({
      index: idx + 1,
      ...loadout(s.title || `Tree ${idx + 1}`),
      treeVersion: s.treeVersion,
      classId: num(s.classId),
      ascendClassId: num(s.ascendClassId),
      secondaryAscendClassId: s.secondaryAscendClassId === "nil" ? null : num(s.secondaryAscendClassId),
      nodes: (s.nodes || "").split(",").filter(Boolean).map(Number),
      masteryEffects: [...(s.masteryEffects || "").matchAll(/\{(\d+),(\d+)\}/g)].map((m) => [Number(m[1]), Number(m[2])]),
      jewels: (s.Sockets?.Socket ?? []).filter((x) => x.itemId && x.itemId !== "0").map((x) => ({ nodeId: num(x.nodeId), itemId: num(x.itemId) })),
      url: text(s.URL).trim(),
    })),
  };
}
