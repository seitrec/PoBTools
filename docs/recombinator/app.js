'use strict';

// Item classes from poedb's Modifiers page. slugOf() turns each name into its poedb
// URL slug ('Gloves(str)' -> 'Gloves_str'); all 52 resolved on 2026-11-12.
const CATEGORIES = [
  ['One Handed Weapons', ['Claws', 'Daggers', 'Wands', 'One Hand Swords', 'One Hand Axes', 'One Hand Maces', 'Sceptres', 'Rune Daggers', 'Thrusting One Hand Swords']],
  ['Two Handed Weapons', ['Bows', 'Staves', 'Two Hand Swords', 'Two Hand Axes', 'Two Hand Maces', 'Warstaves', 'Fishing Rods']],
  ['Jewellery', ['Amulets', 'Rings', 'Belts', 'Trinkets']],
  ['Gloves', ['Gloves(str)', 'Gloves(dex)', 'Gloves(int)', 'Gloves(str_dex)', 'Gloves(str_int)', 'Gloves(dex_int)']],
  ['Boots', ['Boots(str)', 'Boots(dex)', 'Boots(int)', 'Boots(str_dex)', 'Boots(str_int)', 'Boots(dex_int)']],
  ['Body Armours', ['Body Armours(str)', 'Body Armours(dex)', 'Body Armours(int)', 'Body Armours(str_dex)', 'Body Armours(str_int)', 'Body Armours(dex_int)', 'Body Armours(str_dex_int)']],
  ['Helmets', ['Helmets(str)', 'Helmets(dex)', 'Helmets(int)', 'Helmets(str_dex)', 'Helmets(str_int)', 'Helmets(dex_int)']],
  ['Off-hand', ['Quivers', 'Shields(str)', 'Shields(dex)', 'Shields(int)', 'Shields(str_dex)', 'Shields(str_int)', 'Shields(dex_int)']],
];

const INFLUENCES = ['shaper', 'elder', 'crusader', 'redeemer', 'hunter', 'warlord'];
const AFFIXES = ['prefix', 'suffix'];
const AFFIX_TITLES = { prefix: 'Prefixes', suffix: 'Suffixes' };
const MAX_CRAFTED = 3;

// An alteration rerolls a magic item into: 25% prefix only, 25% suffix only,
// 50% prefix + suffix. So a given alt rolls a prefix (resp. a suffix) 75% of the time.
const AFFIX_ROLL_CHANCE = 0.75;

// Recombinator outcome odds, keyed by number of mods of one affix type in the pool,
// then by number of mods kept. From the "Estimated modifier count distribution"
// table on https://www.poewiki.net/wiki/Recombinator (read 2026-11-12) — expected
// to change next patch, re-check it then. Only pools of 2 and 4 are used.
const RECOMB_ODDS = {
  2: { 1: 0.667, 2: 0.333 },
  4: { 1: 0.10, 2: 0.60, 3: 0.30 },
};

// What-if odds for the 1 + 1 step (pool of 2), keyed by mods kept like RECOMB_ODDS.
// The final A + B step always uses RECOMB_ODDS[4].
const RECOMB_SCENARIOS = [
  { name: 'Current (poewiki)', pool2: RECOMB_ODDS[2] },
  { name: 'Scenario 1', pool2: { 2: 0.25, 1: 0.75 } },
  { name: 'Scenario 2', pool2: { 2: 0.20, 1: 0.80 } },
  { name: 'Scenario 3', pool2: { 2: 0.30, 1: 0.60, 0: 0.10 } },
];

const STORE_KEY = 'recombinator.v1';
const store = loadStore();
store.items ??= {};    // per item class: influences, craft side, selected mods
store.values ??= {};   // chaos value per mod tier, shared across sessions
store.ilvl ??= 86;
store.altPrice ??= '';

let current = null;    // { slug, data, open: Set<groupId> }

function loadStore() {
  try { return JSON.parse(localStorage.getItem(STORE_KEY)) || {}; } catch { return {}; }
}
function saveStore() {
  try { localStorage.setItem(STORE_KEY, JSON.stringify(store)); } catch { /* storage unavailable */ }
}

const slugOf = (name) => name.replace(/\(([^)]+)\)/, '_$1').replace(/\s+/g, '_');
const nameOf = (slug) => CATEGORIES.flatMap(([, names]) => names).find((n) => slugOf(n) === slug);
const sum = (xs) => xs.reduce((a, b) => a + b, 0);
const fmt = (n, digits = 0) => Number.isFinite(n)
  ? n.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits })
  : '—';
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
// Same value pattern as fetch_mods.py: numbers and (min—max) ranges
const highlight = (line) => esc(line).replace(/\(?[\d.]+(?:—[\d.]+)?\)?/g, '<span class="v">$&</span>');
const modText = (lines) => lines.map((l) => `<div>${highlight(l)}</div>`).join('');

// ---------- per-item view state ----------

function view() {
  const v = store.items[current.slug] ??= {};
  v.influences ??= [];
  v.craft ??= null;
  v.selected ??= { prefix: [], suffix: [] };
  return v;
}

const activeSources = () => ['normal', ...INFLUENCES.filter((i) => view().influences.includes(i))];
const groupsOf = (source, affix) => current.data.sources[source][affix];
const groupId = (source, affix, gi) => `${source}|${affix}|${gi}`;
const tierOk = (tier) => tier.level <= store.ilvl;
const tierKey = (source, tier) => `${current.slug}|${source}|${tier.level}|${tier.lines.join(' / ')}`;

const groupWeight = (group) => sum(group.tiers.filter(tierOk).map((t) => t.weight));
const blockWeight = (source, affix) => sum(groupsOf(source, affix).map(groupWeight));
const poolWeight = (affix) => sum(activeSources().map((s) => blockWeight(s, affix)));
// Tiers are stored best first, so "this tier or better" is a prefix of the list
const targetWeight = (group, ti) => sum(group.tiers.slice(0, ti + 1).filter(tierOk).map((t) => t.weight));

function odds(sel, affix) {
  const group = groupsOf(sel.source, affix)[sel.group];
  const w = targetWeight(group, sel.tier);
  const W = poolWeight(affix);
  const p = W ? AFFIX_ROLL_CHANCE * w / W : 0;
  return {
    w, W, p,
    expected: p ? 1 / p : Infinity,
    p90: p ? Math.ceil(Math.log(0.1) / Math.log(1 - p)) : Infinity,
  };
}

// ---------- sidebar ----------

function renderNav() {
  const available = new Set(window.MOD_INDEX || []);
  document.getElementById('nav').innerHTML = CATEGORIES.map(([title, names]) => `
    <div class="nav-cat">
      <h3>${esc(title)}</h3>
      ${names.map((name) => {
        const slug = slugOf(name);
        const cls = ['nav-item', available.has(slug) && 'has-data', current?.slug === slug && 'active'].filter(Boolean).join(' ');
        return `<button class="${cls}" data-slug="${slug}" data-name="${esc(name)}">${esc(name)}</button>`;
      }).join('')}
    </div>`).join('');
}

function openItem(slug, name) {
  location.hash = slug;
  const show = () => {
    const data = window.MOD_DATA?.[slug];
    current = data ? { slug, data, open: new Set() } : null;
    renderNav();
    if (data) { render(); refreshCosts(); } else renderMissing(slug, name);
  };
  if (window.MOD_DATA?.[slug] || !(window.MOD_INDEX || []).includes(slug)) return show();
  const script = document.createElement('script');
  script.src = `data/${slug}.js`;
  script.onload = show;
  script.onerror = show;
  document.head.appendChild(script);
}

function renderMissing(slug, name) {
  document.getElementById('main').innerHTML = `
    <div class="empty-state">
      <h2>${esc(name || slug)}</h2>
      <p>No mod data extracted for this item class yet.</p>
      <p>Run <code>python3 fetch_mods.py ${esc(slug)}</code> in <code>recombinator/</code>
      (one request to poedb), then reload this page.</p>
    </div>`;
}

// ---------- main view ----------

function render() {
  const v = view();
  const { data } = current;
  const columns = AFFIXES.map((affix) =>
    v.craft && v.craft !== affix ? renderCraft(v.craft) : renderColumn(affix));

  document.getElementById('main').innerHTML = `
    <header class="item-head">
      <h1>${esc(nameOf(current.slug) || data.name)}</h1>
      <span class="meta">from <a href="${esc(data.source)}#ModifiersCalc" target="_blank" rel="noopener">poedb</a>, extracted ${esc(data.extracted)}</span>
    </header>
    <div class="controls">
      <div class="control">
        <span class="control-label">Influence</span>
        ${INFLUENCES.map((inf) => `
          <button class="chip ${v.influences.includes(inf) ? 'on' : ''}" style="--c: var(--src-${inf})"
                  data-action="influence" data-influence="${inf}">${esc(data.sources[inf].label)}</button>`).join('')}
      </div>
      <div class="control">
        <span class="control-label">Craft</span>
        <div class="segmented">
          ${[[null, 'Browse'], ['prefix', 'Prefixes'], ['suffix', 'Suffixes']].map(([side, label]) => `
            <button class="${v.craft === side ? 'on' : ''}" data-action="craft" data-side="${side ?? ''}">${label}</button>`).join('')}
        </div>
      </div>
      <label class="control">
        <span class="control-label">Item level</span>
        <input class="num-input" type="number" min="1" max="100" value="${store.ilvl}" data-field="ilvl">
      </label>
    </div>
    <div class="columns">${columns.join('')}</div>`;
}

function renderColumn(affix) {
  const blocks = activeSources().map((source) => renderBlock(source, affix)).join('');
  return `
    <section>
      <header class="col-head">
        <h2>${AFFIX_TITLES[affix]}</h2>
        <span class="sub">total weight <span class="weight">${fmt(poolWeight(affix))}</span></span>
      </header>
      ${blocks}
    </section>`;
}

function renderBlock(source, affix) {
  const block = current.data.sources[source];
  const groups = block[affix];
  return `
    <div class="block" style="--c: var(--src-${source})">
      <div class="block-head">
        ${esc(block.label)}
        <span class="count">${groups.length} groups</span>
        <span class="weight">${fmt(blockWeight(source, affix))}</span>
      </div>
      ${groups.length ? groups.map((g, gi) => renderGroup(source, affix, g, gi)).join('')
                      : '<div class="group"><div class="group-head" style="cursor:default;color:var(--muted)">No mods</div></div>'}
    </div>`;
}

function renderGroup(source, affix, group, gi) {
  const id = groupId(source, affix, gi);
  const open = current.open.has(id);
  const selected = view().selected[affix].find((s) => s.source === source && s.group === gi);
  const tags = group.tags.map((t) => `<span class="tag">${esc(t)}</span>`).join('');
  return `
    <div class="group ${open ? 'open' : ''} ${selected ? 'has-sel' : ''}">
      <button class="group-head" data-action="toggle" data-group="${id}">
        <span class="caret"></span>
        <span class="mod-text">${modText(group.tiers[0].lines)}${tags ? `<span class="tags">${tags}</span>` : ''}</span>
        <span class="tiers-n">${group.tiers.length} tier${group.tiers.length > 1 ? 's' : ''}</span>
        <span class="weight">${fmt(groupWeight(group))}</span>
      </button>
      ${open ? renderTiers(source, affix, group, gi, selected) : ''}
    </div>`;
}

function renderTiers(source, affix, group, gi, selected) {
  const v = view();
  const crafting = v.craft === affix;
  const full = v.selected[affix].length >= MAX_CRAFTED && !selected;
  const rows = group.tiers.map((tier, ti) => {
    const ok = tierOk(tier);
    const isSel = selected?.tier === ti;
    const pickable = crafting && ok && !isSel && !full;
    let action = '';
    if (crafting) {
      const label = isSel ? 'Added' : selected ? 'Swap' : 'Add';
      const title = !ok ? 'Above item level' : full ? `Already ${MAX_CRAFTED} mods selected` : '';
      action = `<button class="add-btn" ${pickable ? '' : 'disabled'} title="${title}"
                  data-action="pick" data-group="${groupId(source, affix, gi)}" data-tier="${ti}">${label}</button>`;
    }
    return `
      <tr class="${ok ? '' : 'locked'} ${isSel ? 'selected' : ''} ${pickable ? 'pickable' : ''}"
          ${pickable ? `data-action="pick" data-group="${groupId(source, affix, gi)}" data-tier="${ti}"` : ''}>
        <td class="num">T${ti + 1}</td>
        <td class="tier-name">${esc(tier.name)}</td>
        <td class="num">${tier.level}</td>
        <td class="mod-text">${modText(tier.lines)}</td>
        <td class="num weight">${fmt(tier.weight)}</td>
        <td class="num" title="Weight of this tier and all better tiers">${fmt(targetWeight(group, ti))}</td>
        ${crafting ? `<td>${action}</td>` : ''}
      </tr>`;
  }).join('');
  return `
    <table class="tiers">
      <thead><tr>
        <th>Tier</th><th>Name</th><th>iLvl</th><th>Mod</th><th class="num">Weight</th><th class="num">≥ tier</th>
        ${crafting ? '<th></th>' : ''}
      </tr></thead>
      <tbody>${rows}</tbody>
    </table>`;
}

function renderCraft(affix) {
  const v = view();
  const selected = v.selected[affix];
  const cards = selected.map((sel, i) => renderCard(sel, affix, i)).join('');
  return `
    <section class="craft">
      <header class="col-head">
        <h2>Crafting — ${AFFIX_TITLES[affix].toLowerCase()}</h2>
        <span class="sub">${selected.length} / ${MAX_CRAFTED}</span>
      </header>
      <div class="craft-settings">
        <label>Alteration price
          <input class="num-input" type="number" min="0" step="0.01" value="${esc(store.altPrice)}" data-field="altPrice"> c
        </label>
        <label title="Price of the white/magic base you alt on, added to every alt-rolled mod (not to market values)">Base cost
          <input class="num-input" type="number" min="0" step="0.1" value="${esc(view().baseCost ?? '')}" data-field="baseCost"> c
        </label>
        <span>${AFFIX_TITLES[affix]} pool weight <span class="weight">${fmt(poolWeight(affix))}</span></span>
      </div>
      ${cards || `<div class="craft-empty">Open a mod group in the ${AFFIX_TITLES[affix].toLowerCase()} column
                  and click a tier to add it (up to ${MAX_CRAFTED}).</div>`}
      <div id="recomb"></div>
      <details class="explain">
        <summary>How the costs are computed</summary>
        <p><b>Alts</b>: hit weight = the chosen tier plus every better tier of the same group; pool =
           every ${affix} from Base + checked influences (tiers above item level excluded). An alteration
           rolls a ${affix} ${AFFIX_ROLL_CHANCE * 100}% of the time (25% prefix / 25% suffix / 50% both), so
           <code>p = 0.75 × hit / pool</code> and expected alts = <code>1 / p</code>.</p>
        <p><b>Isolated cost</b> of a mod: the cheaper of its market value and its alt cost
           (expected alts × alt price + base cost).
           Mods are ranked by that cost (by weight while costs are unknown).</p>
        <p><b>2-mod piece</b> (pool of 2): keeps both with p<sub>2</sub>; on a 1-mod result the higher-weight
           mod survives and is reused; a 0-mod result (Scenario 3) leaves an empty base worth the base cost:
           <code>E = (c<sub>x</sub> + c<sub>y</sub> − p<sub>1</sub>·c<sub>kept</sub> − p<sub>0</sub>·base) / p<sub>2</sub></code>.
           The scenarios only change these 1 + 1 odds; the final step always uses the poewiki pool-of-4 odds.</p>
        <p><b>Final</b> (A + B, pool of 4): 3 mods ${pct(RECOMB_ODDS[4][3])} — the shared mod can only be
           picked once, so 3 mods means all three. 2 mods ${pct(RECOMB_ODDS[4][2])}: you keep the 2-mod
           piece of the two highest-weight mods. 1 mod ${pct(RECOMB_ODDS[4][1])}: you keep the highest-weight
           mod. Recovered items are worth their own expected cost:
           <code>E = (E<sub>A</sub> + E<sub>B</sub> − p<sub>2</sub>·R<sub>2</sub> − p<sub>1</sub>·R<sub>1</sub>) / p<sub>3</sub></code>.</p>
        <p>Odds from the <a href="https://www.poewiki.net/wiki/Recombinator" target="_blank" rel="noopener">poewiki
           Recombinator</a> table (read 2026-11-12). Gold and dust costs are not counted.</p>
        <p><b>Bases burned</b>: each recombination takes 2 items and returns 1, so it burns one base. A piece
           takes <code>1 / p</code> attempts; the final burns <code>(burn<sub>A</sub> + burn<sub>B</sub> + 1 −
           p<sub>2</sub>·burn<sub>R2</sub>) / p<sub>3</sub></code>. The chaos in brackets is the bases' share
           of the cost — already counted through base cost / market prices, not added on top.</p>
      </details>
    </section>`;
}

function renderCard(sel, affix, index) {
  const block = current.data.sources[sel.source];
  const group = block[affix][sel.group];
  const tier = group.tiers[sel.tier];
  const o = odds(sel, affix);
  const key = tierKey(sel.source, tier);
  return `
    <div class="card" style="--c: var(--src-${sel.source})">
      <div class="card-main">
        <span class="idx">#${index + 1}</span>
        <div class="card-body">
          <div class="mod-text">${modText(tier.lines)}</div>
          <div class="card-meta"><span class="src">${esc(block.label)}</span> · T${sel.tier + 1} ${esc(tier.name)} · ilvl ${tier.level}
            · weight <span class="weight">${fmt(o.w)}</span></div>
        </div>
        <label class="value" title="Price of this mod alone on a magic item, on the trade site">
          <input class="num-input" type="number" min="0" step="1" placeholder="value" value="${esc(store.values[key] ?? '')}"
                 data-field="value" data-key="${esc(key)}"> c
        </label>
        <button class="remove" title="Remove" data-action="remove" data-index="${index}">×</button>
      </div>
      ${tierOk(tier) ? '' : '<p class="warn">This tier is above the item level and cannot roll.</p>'}
      <div class="card-stats">
        <span>Expected alts <b class="accent">${fmt(o.expected)}</b></span>
        <span>Expected cost <b data-cost="${index}"></b></span>
        <span>Value − cost <b data-net="${index}"></b></span>
      </div>
    </div>`;
}

const pct = (p) => `${fmt(p * 100, p * 100 % 1 ? 1 : 0)}%`;
const chaos = (c) => Number.isFinite(c) ? `${fmt(c, 1)} c` : '—';

// Per selected mod: weight, alt odds and the cost of one isolated copy
function isolatedMods(affix) {
  const altPrice = parseFloat(store.altPrice);
  // The base is bought once per alt-rolled item; market values already include it
  const baseCost = parseFloat(view().baseCost) || 0;
  return view().selected[affix].map((sel, i) => {
    const tier = groupsOf(sel.source, affix)[sel.group].tiers[sel.tier];
    const o = odds(sel, affix);
    const value = parseFloat(store.values[tierKey(sel.source, tier)]);
    const altCost = Number.isFinite(altPrice) ? o.expected * altPrice + baseCost : NaN;
    const known = [value, altCost].filter(Number.isFinite);
    return {
      label: `#${i + 1}`,
      weight: o.w,
      value,
      altCost,
      cost: known.length ? Math.min(...known) : NaN,
      bought: Number.isFinite(value) && !(altCost < value),
    };
  });
}

const byWeight = (mods) => [...mods].sort((a, b) => b.weight - a.weight);

// Expected cost of a 2-mod item from two 1-mod items. On a 1-mod result only the
// higher-weight mod survives and is reused; a 0-mod result leaves an empty base,
// worth the base cost. Recovered items are worth their own cost, so
// E = (c_x + c_y − p1·c_kept − p0·base) / p2.
function piece(x, y, odds2) {
  const [kept] = byWeight([x, y]);
  const p = odds2[2], p1 = odds2[1] || 0, p0 = odds2[0] || 0;
  const base = parseFloat(view().baseCost) || 0;
  const attempt = x.cost + y.cost;
  // Every attempt eats 2 items and returns 1, so it burns one base: 1 / p attempts on average
  return { mods: [x, y], kept, odds: odds2, p, attempt, cost: (attempt - p1 * kept.cost - p0 * base) / p, burn: 1 / p };
}

// Recombination plan for 2 or 3 selected mods (see the "How the costs are computed" notes)
function recombPlan(mods, odds2) {
  // Cheapest first; unknown costs sort last, ties go to the higher weight
  const ranked = [...mods].sort((a, b) =>
    (Number.isFinite(a.cost) ? a.cost : Infinity) - (Number.isFinite(b.cost) ? b.cost : Infinity) || b.weight - a.weight);
  if (mods.length === 2) return { ranked, pieces: [piece(ranked[0], ranked[1], odds2)], final: null };

  const A = piece(ranked[0], ranked[1], odds2);
  const B = piece(ranked[0], ranked[2], odds2);
  const [top1, top2] = byWeight(mods);
  const kept2 = piece(top1, top2, odds2);
  const holder = [A, B].find((pc) => pc.mods.includes(top1) && pc.mods.includes(top2));
  kept2.name = holder === A ? 'piece A' : holder === B ? 'piece B' : `${top1.label} + ${top2.label}`;
  const odds4 = RECOMB_ODDS[4];
  const attempt = A.cost + B.cost;
  const cost = (attempt - odds4[2] * kept2.cost - odds4[1] * top1.cost) / odds4[3];
  // Same recursion for bases: A and B's burns + 1 for this attempt, minus what a kept 2-mod piece already burned
  const burn = (A.burn + B.burn + 1 - odds4[2] * kept2.burn) / odds4[3];
  return { ranked, pieces: [A, B], final: { attempt, kept2, kept1: top1, cost, burn } };
}

const oddsLabel = (odds) => Object.keys(odds).sort((a, b) => b - a).map((n) => `${pct(odds[n])} ${n}`).join(' / ');

function renderRecomb(affix) {
  const mods = isolatedMods(affix);
  if (mods.length < 2) return '';
  const ranked = recombPlan(mods, RECOMB_ODDS[2]).ranked;
  const missing = ranked.some((m) => !Number.isFinite(m.cost));
  return `
    <div class="recomb">
      <div class="recomb-head">
        <h3>Recombination</h3>
        <span class="muted">cheapest first: ${ranked.map((m) =>
          `<b>${m.label}</b> ${chaos(m.cost)}${Number.isFinite(m.cost) ? ` <span class="muted">${m.bought ? 'buy' : 'alt'}</span>` : ''}`).join(' · ')}</span>
      </div>
      ${missing ? '<p class="warn">Set the alteration price (or a market value per mod) to get costs.</p>' : ''}
      ${RECOMB_SCENARIOS.map((sc) => renderScenario(sc, recombPlan(mods, sc.pool2))).join('')}
    </div>`;
}

function renderScenario(scenario, plan) {
  const pieceNames = plan.final ? ['A', 'B'] : [''];
  const modList = (mods) => mods.map((m) => `<b>${m.label}</b>`).join(' + ');
  // Bases are already priced into each mod's cost, so their chaos share is shown, not added
  const baseCost = parseFloat(view().baseCost);
  const burned = (n) => `${fmt(n, 1)}${baseCost ? ` <span class="muted">(${chaos(n * baseCost)})</span>` : ''}`;
  const rows = plan.pieces.map((pc, i) => `
    <tr>
      <td>Piece ${pieceNames[i]}</td>
      <td>${modList(pc.mods)}</td>
      <td class="num">${chaos(pc.attempt)}</td>
      <td class="num">${pct(pc.p)}</td>
      <td>${pc.kept.label} <span class="muted">(${pct(pc.odds[1] || 0)})</span>${pc.odds[0]
        ? `, empty base <span class="muted">(${pct(pc.odds[0])})</span>` : ''}</td>
      <td class="num">${burned(pc.burn)}</td>
      <td class="num accent">${chaos(pc.cost)}</td>
    </tr>`).join('');
  const f = plan.final;
  const finalRow = f ? `
    <tr class="final">
      <td>Final</td>
      <td>A + B</td>
      <td class="num">${chaos(f.attempt)}</td>
      <td class="num">${pct(RECOMB_ODDS[4][3])}</td>
      <td>${f.kept2.name} <span class="muted">(${pct(RECOMB_ODDS[4][2])})</span>,
          ${f.kept1.label} <span class="muted">(${pct(RECOMB_ODDS[4][1])})</span></td>
      <td class="num">${burned(f.burn)}</td>
      <td class="num accent">${chaos(f.cost)}</td>
    </tr>` : '';
  return `
    <div class="scenario">
      <h4>${esc(scenario.name)} <span class="muted">1 + 1: ${oddsLabel(scenario.pool2)} mods</span></h4>
      <table class="recomb-table">
        <thead><tr><th>Step</th><th>Mods</th><th class="num">Inputs</th><th class="num">Success</th><th>Kept on fail</th><th class="num" title="Expected bases consumed, including the steps before. Their price is already inside the costs.">Bases burned</th><th class="num">Expected cost</th></tr></thead>
        <tbody>${rows}${finalRow}</tbody>
      </table>
    </div>`;
}

// Chaos figures depend on free-text inputs, so they are refreshed in place
// on every keystroke instead of re-rendering (which would steal focus).
function refreshCosts() {
  const affix = view().craft;
  if (!affix) return;
  isolatedMods(affix).forEach((mod, i) => {
    document.querySelector(`[data-cost="${i}"]`).textContent = Number.isFinite(mod.altCost) ? chaos(mod.altCost) : 'set alt price';
    const net = mod.value - mod.altCost;
    const netEl = document.querySelector(`[data-net="${i}"]`);
    netEl.textContent = Number.isFinite(net) ? `${net >= 0 ? '+' : ''}${chaos(net)}` : '—';
    netEl.className = Number.isFinite(net) ? (net >= 0 ? 'pos' : 'neg') : '';
  });
  document.getElementById('recomb').innerHTML = renderRecomb(affix);
}

function rerender() {
  saveStore();
  render();
  refreshCosts();
}

// ---------- events ----------

document.getElementById('nav').addEventListener('click', (e) => {
  const btn = e.target.closest('.nav-item');
  if (btn) openItem(btn.dataset.slug, btn.dataset.name);
});

document.getElementById('main').addEventListener('click', (e) => {
  const el = e.target.closest('[data-action]');
  if (!el || el.disabled || !current) return;
  const v = view();

  switch (el.dataset.action) {
    case 'toggle': {
      const id = el.dataset.group;
      current.open.has(id) ? current.open.delete(id) : current.open.add(id);
      break;
    }
    case 'influence': {
      const inf = el.dataset.influence;
      if (v.influences.includes(inf)) {
        v.influences = v.influences.filter((i) => i !== inf);
        for (const affix of AFFIXES) v.selected[affix] = v.selected[affix].filter((s) => s.source !== inf);
      } else {
        v.influences.push(inf);
      }
      break;
    }
    case 'craft':
      v.craft = el.dataset.side || null;
      break;
    case 'pick': {
      const [source, affix, gi] = el.dataset.group.split('|');
      const sel = { source, group: Number(gi), tier: Number(el.dataset.tier) };
      const list = v.selected[affix];
      // A mod group can only appear once on an item: picking another tier swaps it
      const existing = list.findIndex((s) => s.source === sel.source && s.group === sel.group);
      if (existing >= 0) list[existing] = sel;
      else if (list.length < MAX_CRAFTED) list.push(sel);
      break;
    }
    case 'remove':
      v.selected[v.craft].splice(Number(el.dataset.index), 1);
      break;
    default:
      return;
  }
  rerender();
});

document.getElementById('main').addEventListener('input', (e) => {
  const field = e.target.dataset.field;
  if (field === 'value') store.values[e.target.dataset.key] = e.target.value;
  else if (field === 'altPrice') store.altPrice = e.target.value;
  else if (field === 'baseCost') view().baseCost = e.target.value;
  else return;
  saveStore();
  refreshCosts();
});

// Item level changes which tiers count, so it re-renders once the edit is committed
document.getElementById('main').addEventListener('change', (e) => {
  if (e.target.dataset.field !== 'ilvl') return;
  const ilvl = parseInt(e.target.value, 10);
  if (Number.isFinite(ilvl)) store.ilvl = ilvl;
  rerender();
});

// ---------- boot ----------

const initial = location.hash.slice(1) || 'One_Hand_Swords';
renderNav();
openItem(initial, nameOf(initial));
