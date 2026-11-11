// Loads PoB's local passive tree data (TreeData/<ver>/tree.lua) and reduces it to what the viewer
// needs: node positions (computed the same way PoB does), names, stats, type flags and edges.
import { readFileSync, existsSync } from "fs";
import { join } from "path";
import { parseLuaTable } from "./lua-table.mjs";

// PoB's PassiveTree:CalcOrbitAngles - orbits with 16 and 40 nodes use hand-tuned angles.
const ANGLES_16 = [0, 30, 45, 60, 90, 120, 135, 150, 180, 210, 225, 240, 270, 300, 315, 330];
const ANGLES_40 = [0, 10, 20, 30, 40, 45, 50, 60, 70, 80, 90, 100, 110, 120, 130, 135, 140, 150, 160, 170, 180,
  190, 200, 210, 220, 225, 230, 240, 250, 260, 270, 280, 290, 300, 310, 315, 320, 330, 340, 350];
function orbitAngles(count) {
  if (count === 16) return ANGLES_16.map((d) => (d * Math.PI) / 180);
  if (count === 40) return ANGLES_40.map((d) => (d * Math.PI) / 180);
  return Array.from({ length: count }, (_, k) => (2 * Math.PI * k) / count);
}

const r1 = (v) => Math.round(v * 10) / 10;

export function loadTree(pobDir, version) {
  const file = join(pobDir, "TreeData", version, "tree.lua");
  if (!existsSync(file)) throw new Error(`No tree data for ${version} at ${file}`);
  const t = parseLuaTable(readFileSync(file, "utf8"));
  const { skillsPerOrbit, orbitRadii } = t.constants;
  const angles = skillsPerOrbit.map(orbitAngles);

  const nodes = {};
  for (const n of Object.values(t.nodes)) {
    if (n.group === undefined || n.skill === undefined) continue; // the "root" pseudo-node
    const g = t.groups[n.group];
    const a = angles[n.orbit][n.orbitIndex];
    const rad = orbitRadii[n.orbit];
    let type = "normal";
    if (n.classStartIndex !== undefined) type = "classStart";
    else if (n.isKeystone) type = "keystone";
    else if (n.isMastery) type = "mastery";
    else if (n.isJewelSocket) type = "jewel";
    else if (n.isNotable) type = "notable";
    const out = {
      id: n.skill,
      name: n.name,
      type,
      x: r1(g.x + Math.sin(a) * rad),
      y: r1(g.y - Math.cos(a) * rad),
      g: n.group,
      o: n.orbit,
      stats: n.stats ?? [],
    };
    if (n.ascendancyName) out.asc = n.ascendancyName;
    if (n.isAscendancyStart) out.ascStart = true;
    if (n.isBloodline) out.bloodline = true;
    if (n.classStartIndex !== undefined) out.classStartIndex = n.classStartIndex;
    if (n.isProxy) out.proxy = true;
    if (n.expansionJewel) out.cluster = true;
    if (n.isMultipleChoiceOption) out.choice = true;
    if (n.masteryEffects) out.masteryEffects = Object.fromEntries(n.masteryEffects.map((e) => [e.effect, e.stats]));
    nodes[n.skill] = out;
  }

  // Edges: undirected, de-duplicated, skipping mastery links and cross-ascendancy links (as PoB does).
  const edges = [];
  const seen = new Set();
  for (const n of Object.values(t.nodes)) {
    const a = nodes[n.skill];
    if (!a) continue;
    for (const o of n.out ?? []) {
      const b = nodes[Number(o)];
      if (!b) continue;
      const key = a.id < b.id ? `${a.id}-${b.id}` : `${b.id}-${a.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      if (a.type === "mastery" || b.type === "mastery") continue;
      if ((a.asc ?? null) !== (b.asc ?? null)) continue;
      if (a.type === "classStart" || b.type === "classStart") {
        if (a.asc || b.asc) continue;
      }
      // Same group + same orbit -> draw as an arc around the group centre.
      const arc = a.g === b.g && a.o === b.o && a.o > 0 ? orbitRadii[a.o] : 0;
      edges.push(arc ? [a.id, b.id, arc] : [a.id, b.id]);
    }
  }

  const groups = {};
  for (const [k, g] of Object.entries(t.groups)) groups[k] = [r1(g.x), r1(g.y)];

  return {
    version,
    bounds: [t.min_x, t.min_y, t.max_x, t.max_y],
    classes: t.classes.map((c) => ({ name: c.name, ascendancies: c.ascendancies.map((a) => a.id) })),
    alternateAscendancies: (t.alternate_ascendancies ?? []).map((a) => a.id),
    groups,
    nodes,
    edges,
  };
}
