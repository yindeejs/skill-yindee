// Tolerant TOML subset parser — enough for Cargo.toml / pyproject.toml.
// Handles tables, array-of-tables, dotted keys, strings, numbers, bools,
// (multi-line) arrays and inline tables. Anything exotic degrades to a string
// rather than throwing, because callers only ever read a handful of keys.

function stripComment(line) {
  let out = '';
  let quote = null;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quote) {
      out += c;
      if (c === quote && line[i - 1] !== '\\') quote = null;
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      out += c;
      continue;
    }
    if (c === '#') break;
    out += c;
  }
  return out;
}

function splitKey(raw) {
  const parts = [];
  let cur = '';
  let quote = null;
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i];
    if (quote) {
      if (c === quote) quote = null;
      else cur += c;
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      continue;
    }
    if (c === '.') {
      parts.push(cur.trim());
      cur = '';
      continue;
    }
    cur += c;
  }
  if (cur.trim()) parts.push(cur.trim());
  return parts.filter(Boolean);
}

function balanced(s) {
  let depth = 0;
  let quote = null;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quote) {
      if (c === quote && s[i - 1] !== '\\') quote = null;
      continue;
    }
    if (c === '"' || c === "'") quote = c;
    else if (c === '[' || c === '{') depth++;
    else if (c === ']' || c === '}') depth--;
  }
  return depth <= 0 && !quote;
}

/** Split on top-level commas (ignoring nested brackets/strings). */
function splitTop(body) {
  const out = [];
  let depth = 0;
  let quote = null;
  let cur = '';
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (quote) {
      cur += c;
      if (c === quote && body[i - 1] !== '\\') quote = null;
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      cur += c;
      continue;
    }
    if (c === '[' || c === '{') depth++;
    if (c === ']' || c === '}') depth--;
    if (c === ',' && depth === 0) {
      out.push(cur);
      cur = '';
      continue;
    }
    cur += c;
  }
  if (cur.trim()) out.push(cur);
  return out.map((s) => s.trim()).filter(Boolean);
}

function parseValue(raw) {
  const v = String(raw).trim();
  if (!v) return '';
  if (v.startsWith('[')) {
    const body = v.slice(1, v.lastIndexOf(']'));
    return splitTop(body).map(parseValue);
  }
  if (v.startsWith('{')) {
    const body = v.slice(1, v.lastIndexOf('}'));
    const obj = {};
    for (const pair of splitTop(body)) {
      const eq = pair.indexOf('=');
      if (eq === -1) continue;
      const path = splitKey(pair.slice(0, eq));
      setPath(obj, path, parseValue(pair.slice(eq + 1)));
    }
    return obj;
  }
  if (v.startsWith('"""') || v.startsWith("'''")) return v.slice(3, -3);
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
    return v.slice(1, -1).replace(/\\"/g, '"');
  }
  if (v === 'true') return true;
  if (v === 'false') return false;
  if (/^-?\d+$/.test(v)) return Number(v);
  if (/^-?\d*\.\d+$/.test(v)) return Number(v);
  return v;
}

function setPath(obj, path, value) {
  let cur = obj;
  for (let i = 0; i < path.length - 1; i++) {
    const k = path[i];
    if (typeof cur[k] !== 'object' || cur[k] === null || Array.isArray(cur[k])) cur[k] = {};
    cur = cur[k];
  }
  cur[path[path.length - 1]] = value;
}

function tableAt(root, path, isArray) {
  let cur = root;
  for (let i = 0; i < path.length; i++) {
    const k = path[i];
    const last = i === path.length - 1;
    if (last && isArray) {
      if (!Array.isArray(cur[k])) cur[k] = [];
      const entry = {};
      cur[k].push(entry);
      return entry;
    }
    if (Array.isArray(cur[k])) cur = cur[k][cur[k].length - 1];
    else {
      if (typeof cur[k] !== 'object' || cur[k] === null) cur[k] = {};
      cur = cur[k];
    }
  }
  return cur;
}

export function parseToml(src) {
  const root = {};
  let cur = root;
  const lines = String(src || '').split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    let line = stripComment(lines[i]).trim();
    if (!line) continue;

    if (line.startsWith('[[') || line.startsWith('[')) {
      const isArray = line.startsWith('[[');
      const close = isArray ? line.indexOf(']]') : line.indexOf(']');
      if (close === -1) continue;
      const name = line.slice(isArray ? 2 : 1, close);
      cur = tableAt(root, splitKey(name), isArray);
      continue;
    }

    const eq = (() => {
      let quote = null;
      for (let j = 0; j < line.length; j++) {
        const c = line[j];
        if (quote) {
          if (c === quote) quote = null;
          continue;
        }
        if (c === '"' || c === "'") quote = c;
        else if (c === '=') return j;
      }
      return -1;
    })();
    if (eq === -1) continue;

    const key = line.slice(0, eq);
    let raw = line.slice(eq + 1).trim();
    // Multi-line arrays / inline tables / triple-quoted strings.
    while (!balanced(raw) && i + 1 < lines.length) {
      i += 1;
      raw += '\n' + stripComment(lines[i]).trim();
    }
    setPath(cur, splitKey(key), parseValue(raw));
  }
  return root;
}
