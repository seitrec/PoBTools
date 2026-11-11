// Minimal parser for PoB's data files that are a single `return { ... }` Lua table literal
// (e.g. TreeData/<ver>/tree.lua). Supports strings, numbers, booleans, nil, nested tables,
// `["key"]=` / `[n]=` / bare-identifier keys. Tables with only positional items become arrays.

export function parseLuaTable(src) {
  let i = 0;
  const n = src.length;

  const ws = () => {
    for (;;) {
      while (i < n && /\s/.test(src[i])) i++;
      if (src.startsWith("--", i)) {
        if (src.startsWith("--[[", i)) {
          const end = src.indexOf("]]", i);
          i = end < 0 ? n : end + 2;
        } else {
          while (i < n && src[i] !== "\n") i++;
        }
        continue;
      }
      break;
    }
  };

  const str = () => {
    const q = src[i++];
    let out = "";
    while (i < n && src[i] !== q) {
      let c = src[i++];
      if (c === "\\") {
        const e = src[i++];
        c = { n: "\n", t: "\t", r: "\r", "\\": "\\", '"': '"', "'": "'" }[e];
        if (c === undefined) {
          if (/\d/.test(e)) {
            let d = e;
            while (d.length < 3 && /\d/.test(src[i])) d += src[i++];
            c = String.fromCharCode(parseInt(d, 10));
          } else c = e;
        }
      }
      out += c;
    }
    i++;
    return out;
  };

  const num = () => {
    const m = /^-?(0x[0-9a-fA-F]+|\d*\.?\d+(?:[eE][-+]?\d+)?)/.exec(src.slice(i, i + 64));
    if (!m) throw new Error(`Bad number at ${i}: ${src.slice(i, i + 20)}`);
    i += m[0].length;
    return Number(m[0]);
  };

  const value = () => {
    ws();
    const c = src[i];
    if (c === "{") return table();
    if (c === '"' || c === "'") return str();
    if (c === "-" || c === "." || /\d/.test(c)) return num();
    const m = /^[A-Za-z_]\w*/.exec(src.slice(i, i + 32));
    if (!m) throw new Error(`Unexpected '${c}' at ${i}`);
    i += m[0].length;
    if (m[0] === "true") return true;
    if (m[0] === "false") return false;
    if (m[0] === "nil") return null;
    throw new Error(`Unsupported identifier '${m[0]}' at ${i}`);
  };

  const table = () => {
    i++; // {
    const arr = [];
    const obj = {};
    let keyed = false;
    for (;;) {
      ws();
      if (src[i] === "}") { i++; break; }
      let key;
      if (src[i] === "[") {
        i++;
        key = value();
        ws(); i++; // ]
        ws(); i++; // =
      } else {
        const m = /^([A-Za-z_]\w*)\s*=(?!=)/.exec(src.slice(i, i + 64));
        if (m) { key = m[1]; i += m[0].length; }
      }
      const v = value();
      if (key === undefined) arr.push(v);
      else { obj[key] = v; keyed = true; }
      ws();
      if (src[i] === "," || src[i] === ";") i++;
    }
    if (!keyed) return arr;
    arr.forEach((v, k) => { obj[k + 1] = v; });
    return obj;
  };

  ws();
  if (src.startsWith("return", i)) i += 6;
  return value();
}
