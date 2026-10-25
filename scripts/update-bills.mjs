// Refreshes the volatile fields in data/bills.json (status, stage, date, law)
// from the openparliament.ca API, which is built for programmatic access and
// is reachable from GitHub. LEGISinfo blocks GitHub's servers by IP, so it
// cannot be fetched here.
//
// Design: data/bills.json is the baseline. It holds the rich detail seeded
// from LEGISinfo (titles, sponsors, committees, bill-text links). This script
// only OVERLAYS the fast-changing fields from openparliament onto that
// baseline. If a bill cannot be fetched, its baseline record is kept as-is and
// flagged stale. The run never fails just because a fetch did, so the live
// page never breaks.
//
// Committees are not carried by openparliament. They stay in data/bills.json
// and are maintained by hand from LEGISinfo when they change.
//
// Run by .github/workflows/update-legislation-tracker.yml once a day.
// Node 20+ (built-in fetch). No dependencies.

import { readFile, writeFile } from "node:fs/promises";

const SESSION = "45-1";
const CONFIG_PATH = new URL("../data/bills.config.json", import.meta.url);
const OUT_PATH = new URL("../data/bills.json", import.meta.url);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const HEADERS = {
  // openparliament asks (not requires) for a contact email here. Kept to a
  // plain identifier and the site URL at Jeremy's instruction.
  "User-Agent": "RiverRidge-legislation-tracker/1.0 (+https://riverridgeintelligence.ca)",
  Accept: "application/json",
};

async function fetchBill(number) {
  const url = `https://api.openparliament.ca/bills/${SESSION}/${number.toUpperCase()}/?format=json`;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(url, { headers: HEADERS });
      if (res.status === 429) throw new Error("HTTP 429 (rate limited)");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (err) {
      if (attempt === 3) throw err;
      await sleep(3000 * attempt);
    }
  }
}

// openparliament may give status as a string or as {en, fr}. Be tolerant.
function statusText(op) {
  const s = op.status ?? op.status_name ?? op.status_code ?? "";
  if (typeof s === "string") return s.trim();
  if (s && typeof s === "object") return (s.en || s.fr || "").trim();
  return "";
}

const MONTHS = {
  jan: "01", feb: "02", mar: "03", apr: "04", may: "05", jun: "06",
  jul: "07", aug: "08", sep: "09", oct: "10", nov: "11", dec: "12",
};

// Pull "as of Oct. 22, 2026" out of the status string, if present.
function dateFromStatus(s) {
  const m = s.match(/as of\s+([A-Za-z]+)\.?\s+(\d{1,2}),?\s+(\d{4})/i);
  if (!m) return null;
  const mo = MONTHS[m[1].slice(0, 3).toLowerCase()];
  if (!mo) return null;
  return `${m[3]}-${mo}-${String(m[2]).padStart(2, "0")}`;
}

function isLaw(op, s) {
  if (op.law === true) return true;
  return /\b(law|royal assent)\b/i.test(s);
}

// Which chamber the bill is in now, from the status text.
function chamberFromStatus(s) {
  if (/senate/i.test(s)) return "Senate";
  if (/house|commons/i.test(s)) return "House of Commons";
  return "";
}

// Furthest of the 7 stages reached, derived from the status text plus the
// bill's originating chamber. Approximate but only ever used to advance the
// bar: the result is max()'d against the baseline so parsing noise can never
// move a bill backwards.
// Count of true entries at the front of a progress array.
const countProgress = (p) => (Array.isArray(p) ? p.filter(Boolean).length : 0);
const toProgress = (n) => Array.from({ length: 7 }, (_, i) => i < n);

function derivedStages(s, originating) {
  if (isLaw({}, s)) return 7;
  const cur = chamberFromStatus(s) || originating;
  const second = cur && originating && cur !== originating;
  // Stage within the current chamber.
  let within = 0;
  if (/third reading/i.test(s)) within = 3;
  else if (/report stage/i.test(s)) within = 2;
  else if (/committee/i.test(s)) within = 2;
  else if (/second reading/i.test(s)) within = 1;
  else if (/first reading|introduc/i.test(s)) within = 1;
  if (second) return Math.min(7, 3 + within);
  return Math.min(3, within);
}

// Today's date in Ottawa, YYYY-MM-DD.
const today = () => new Date().toLocaleDateString("en-CA", { timeZone: "America/Toronto" });

function overlay(base, op) {
  const s = statusText(op);
  if (!s) return null;
  const law = isLaw(op, s);
  const chamber = chamberFromStatus(s);
  const reached = Math.max(countProgress(base.progress), law ? 7 : derivedStages(s, base.originatingChamber));
  // openparliament gives no event date, so a new status is dated the day this
  // script first sees it. An unchanged status keeps the baseline event, which
  // also preserves the more detailed LEGISinfo event seeded in the baseline.
  const changed = base.statusSource === "openparliament" && base.status !== s;
  const date = dateFromStatus(s) || today();

  const next = {
    ...base,
    status: s,
    statusSource: "openparliament",
    progress: toProgress(reached),
    latestEvent: changed || !base.latestEvent
      ? {
          type: s.replace(/,?\s*as of.*$/i, "").trim() || "Status update",
          date,
          chamber: chamber || base.latestEvent?.chamber || "",
        }
      : base.latestEvent,
    stale: false,
  };
  if (law) {
    next.royalAssent = base.royalAssent || date;
    // Point the bill-text link at the royal-assent version once it is law.
    if (base.textUrl) next.textUrl = base.textUrl.replace(/\/(first-reading|third-reading)$/, "/royal-assent");
  }
  return next;
}

// What moved since the previous run, as changelog entries.
function changesFor(prev, next) {
  if (!prev) return [];
  const entry = (kind, text) => ({ date: today(), number: next.number, kind, text });
  const wasLaw = countProgress(prev.progress) >= 7;
  const isNowLaw = countProgress(next.progress) >= 7;
  if (isNowLaw && !wasLaw) return [entry("law", "Became law (royal assent)")];
  if (countProgress(next.progress) > countProgress(prev.progress)) return [entry("stage", `Advanced to: ${next.status}`)];
  // Wording changes count only when both readings came from openparliament,
  // so the one-time switch from LEGISinfo wording does not flag every bill.
  if (prev.statusSource === "openparliament" && next.statusSource === "openparliament" && prev.status !== next.status) {
    return [entry("status", `Status now: ${next.status}`)];
  }
  return [];
}

const config = JSON.parse(await readFile(CONFIG_PATH, "utf8"));
let previous = { bills: [] };
try {
  previous = JSON.parse(await readFile(OUT_PATH, "utf8"));
} catch {
  console.error("No baseline data/bills.json found; cannot overlay. Exiting without writing.");
  process.exit(1);
}
const baseByNumber = new Map(previous.bills.map((b) => [b.number, b]));

const bills = [];
let updated = 0;
let stale = 0;
const changes = [];
for (const cfg of config.bills) {
  const base = baseByNumber.get(cfg.number) || {
    number: cfg.number,
    originatingChamber: cfg.number.startsWith("S") ? "Senate" : "House of Commons",
    progress: [false, false, false, false, false, false, false],
    committees: [],
    legisinfoUrl: `https://www.parl.ca/legisinfo/en/bill/${SESSION}/${cfg.number.toLowerCase()}`,
    textUrl: `https://www.parl.ca/DocumentViewer/en/${SESSION}/bill/${cfg.number}/first-reading`,
  };
  let rec;
  try {
    const op = await fetchBill(cfg.number);
    rec = overlay(base, op);
    if (rec) {
      console.log(`ok   ${cfg.number}: ${rec.status}`);
      updated++;
    } else {
      rec = { ...base, stale: true };
      stale++;
      console.error(`nostatus ${cfg.number}: no status field in response (kept baseline). Keys: ${Object.keys(op || {}).join(", ")}`);
    }
  } catch (err) {
    rec = { ...base, stale: true };
    stale++;
    console.error(`stale ${cfg.number}: ${err.message} (kept baseline)`);
  }
  // Config is the source of truth for grouping and the written summary.
  rec.theme = cfg.theme;
  rec.summary = cfg.summary || rec.summary || "";
  changes.push(...changesFor(baseByNumber.get(cfg.number), rec));
  bills.push(rec);
  await sleep(1200); // be gentle on openparliament
}

// Rolling changelog: newest first, 60 days, at most 200 entries.
const cutoff = new Date(Date.now() - 60 * 86400000).toISOString().slice(0, 10);
const changelog = [...changes, ...(previous.changelog || [])]
  .filter((c) => c.date >= cutoff)
  .slice(0, 200);

const out = {
  checkedAt: new Date().toISOString(),
  source: "openparliament.ca (bill status) and LEGISinfo, Parliament of Canada (committees and links)",
  session: SESSION,
  themes: config.themes,
  bills,
  changelog,
};
await writeFile(OUT_PATH, JSON.stringify(out, null, 2) + "\n");
for (const c of changes) console.log(`change ${c.number}: ${c.text}`);
console.log(`Wrote ${bills.length} bills: ${updated} refreshed, ${stale} kept from baseline, ${changes.length} changes logged.`);
