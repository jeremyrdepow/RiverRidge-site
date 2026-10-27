// Bill text analysis for update-bills.mjs: what changed between published
// versions of a bill, when it comes into force, and the penalty amounts it
// names. Reads the XML that parl.ca publishes for each version. Written
// against C-22's three versions, fetched by GitHub Actions on Oct 27, 2026.
// No dependencies: the bill XML is regular enough for the small reader below.

// ---------- A minimal XML reader ----------

const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
const decode = (t) =>
  t.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (all, e) => {
    if (e[0] === "#") return String.fromCodePoint(e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10));
    return ENTITIES[e.toLowerCase()] ?? all;
  });

// Elements become { tag, kids }, text becomes strings. Comments, processing
// instructions and attributes are dropped; the analysis needs none of them.
export function parseXml(xml) {
  const root = { tag: "#root", kids: [] };
  const stack = [root];
  const re = /<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<!\[CDATA\[([\s\S]*?)\]\]>|<(\/?)([A-Za-z_][\w.:-]*)[^>]*?(\/?)>|([^<]+)/g;
  for (const m of xml.matchAll(re)) {
    const top = stack[stack.length - 1];
    if (m[5] !== undefined) top.kids.push(decode(m[5]));
    else if (m[1] !== undefined) top.kids.push(m[1]);
    else if (m[3] === undefined) continue; // comment or processing instruction
    else if (m[2] === "/") {
      if (stack.length > 1) stack.pop();
    } else {
      const el = { tag: m[3], kids: [] };
      top.kids.push(el);
      if (m[4] !== "/") stack.push(el);
    }
  }
  return root;
}

const isEl = (k) => typeof k === "object";
const child = (el, tag) => el.kids.find((k) => isEl(k) && k.tag === tag);
const find = (el, tag) => {
  for (const k of el.kids) {
    if (!isEl(k)) continue;
    if (k.tag === tag) return k;
    const f = find(k, tag);
    if (f) return f;
  }
  return null;
};
// Text with element boundaries kept as spaces, so "(a)" and "that" do not run together.
const text = (el) => {
  const parts = [];
  const walk = (e) => e.kids.forEach((k) => (isEl(k) ? (parts.push(" "), walk(k), parts.push(" ")) : parts.push(k)));
  walk(el);
  return parts.join("").replace(/\s+/g, " ").replace(/\s+([,.;:)])/g, "$1").replace(/\(\s+/g, "(").trim();
};
// The provision's own words, without its number and margin note.
const bodyText = (el) => {
  const parts = [];
  const walk = (e) => e.kids.forEach((k) => {
    if (!isEl(k)) parts.push(k);
    else if (k.tag !== "MarginalNote" && !(k.tag === "Label" && e === el)) { parts.push(" "); walk(k); parts.push(" "); }
  });
  walk(el);
  return parts.join("").replace(/\s+/g, " ").replace(/\s+([,.;:)])/g, "$1").replace(/\(\s+/g, "(").trim();
};

// ---------- Provisions ----------

// Every numbered section that holds no further section: the smallest units a
// committee amends. ref is the bill clause, then the section number inside the
// Act it amends or enacts ("41 / 36"). heading is the nearest heading above.
export function provisions(root) {
  const body = find(root, "Body");
  if (!body) return [];
  const out = [];
  let heading = "";
  const walk = (node, path) => {
    for (const k of node.kids) {
      if (!isEl(k)) continue;
      if (k.tag === "Heading") {
        heading = text(k);
        continue;
      }
      if (k.tag === "Section") {
        const label = child(k, "Label");
        const here = [...path, label ? text(label) : "?"];
        if (find(k, "Section")) walk(k, here);
        else {
          const note = child(k, "MarginalNote");
          const words = bodyText(k);
          out.push({ ref: here.join(" / "), note: note ? text(note) : "", heading, text: words, key: words.replace(/\s+/g, "") });
        }
        continue;
      }
      walk(k, path);
    }
  };
  walk(body, []);
  return out;
}

// Provisions that differ between two versions. The two lists are aligned on
// their wording (whitespace ignored, so reformatting is not a change). Within
// each stretch that does not line up, a removed and an added provision are
// paired as one amendment when their wording is similar, since sections are
// often renumbered. A pair whose only difference is numbering is "renumbered".
const words = (t) => new Set(t.toLowerCase().match(/[a-z]+/g) || []);
const similarity = (x, y) => {
  const a = words(x.text);
  const b = words(y.text);
  let shared = 0;
  for (const w of a) if (b.has(w)) shared++;
  return shared / Math.max(1, a.size + b.size - shared) + (x.note && x.note === y.note ? 0.3 : 0);
};
const digitless = (k) => k.replace(/[\d.]+/g, "#");

export function changedProvisions(before, after) {
  const a = before.map((p) => p.key);
  const b = after.map((p) => p.key);
  const n = a.length;
  const m = b.length;
  // Longest common subsequence table, filled from the end.
  const L = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) L[i][j] = a[i] === b[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
  const out = [];
  let removed = [];
  let added = [];
  const flush = () => {
    const used = new Set();
    for (const r of removed) {
      let best = -1;
      let score = 0.5; // below this, treat as unrelated
      added.forEach((x, k) => {
        if (used.has(k)) return;
        const s = similarity(r, x);
        if (s >= score) { score = s; best = k; }
      });
      if (best < 0) { out.push({ kind: "removed", ref: r.ref, note: r.note }); continue; }
      used.add(best);
      const x = added[best];
      out.push({ kind: digitless(r.key) === digitless(x.key) ? "renumbered" : "amended", ref: x.ref, note: x.note || r.note, ...(r.ref !== x.ref ? { was: r.ref } : {}) });
    }
    added.forEach((x, k) => used.has(k) || out.push({ kind: "added", ref: x.ref, note: x.note }));
    removed = [];
    added = [];
  };
  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && a[i] === b[j]) { flush(); i++; j++; continue; }
    if (j < m && (i === n || L[i][j + 1] >= L[i + 1][j])) added.push(after[j++]);
    else removed.push(before[i++]);
  }
  flush();
  return out;
}

// Provisions about coming into force: under a "Coming into Force" heading, or
// with a margin note or wording that says so.
export function comingIntoForce(list) {
  return list
    .filter((p) => /coming into force/i.test(p.heading) || (/coming into force|royal assent|order in council/i.test(p.note) && /into force/i.test(p.text)))
    .map(({ ref, note, text }) => ({ ref, note, text: text.length > 300 ? text.slice(0, 297) + "..." : text }));
}

// Dollar amounts named in provisions about penalties or fines, with the
// sentence that names them.
export function penalties(list) {
  const out = [];
  for (const p of list) {
    if (!/\$\s?\d/.test(p.text) || !/penalt|fine|liable/i.test(p.text)) continue;
    const amounts = [...new Set(p.text.match(/\$\s?[\d,]+(?:\.\d+)?(?: (?:million|billion))?/g) || [])];
    const at = p.text.search(/\$\s?\d/);
    const start = Math.max(0, p.text.lastIndexOf(". ", at) + 2);
    const end = p.text.indexOf(". ", at);
    const sentence = p.text.slice(start, end > 0 ? end + 1 : undefined);
    out.push({ ref: p.ref, note: p.note, amounts, text: sentence.length > 280 ? sentence.slice(0, 277) + "..." : sentence });
  }
  return out;
}

// The XML and PDF addresses for one published version, from its parl.ca page.
export function versionFiles(viewerHtml) {
  const xml = viewerHtml.match(/href="(\/Content\/Bills\/[^"]+_E\.xml)"/i);
  const pdf = viewerHtml.match(/href="(\/Content\/Bills\/[^"]+\.PDF)"/i);
  return {
    xml: xml ? `https://www.parl.ca${xml[1]}` : null,
    pdf: pdf ? `https://www.parl.ca${pdf[1]}` : null,
  };
}

// What each published version changed from the one before, plus coming into
// force and penalties from the latest version. versions: [{ type, xml }] in
// publication order, where xml is the document text.
export function analyse(versions) {
  const parsed = versions.map((v) => ({ type: v.type, provisions: provisions(parseXml(v.xml)) }));
  const changes = [];
  for (let k = 1; k < parsed.length; k++) {
    const list = changedProvisions(parsed[k - 1].provisions, parsed[k].provisions);
    if (list.length) changes.push({ from: parsed[k - 1].type, to: parsed[k].type, provisions: list });
  }
  const latest = parsed[parsed.length - 1]?.provisions || [];
  return { changes, inForce: comingIntoForce(latest), penalties: penalties(latest).slice(0, 20), provisionCount: latest.length };
}
