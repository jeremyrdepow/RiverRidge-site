// Refreshes data/bills.json once a day. Sources, in order of preference:
//
// 1. LEGISinfo (Parliament of Canada), the official record: status, stage
//    progress, latest event and its date, committees, royal assent.
// 2. openparliament.ca, when LEGISinfo does not answer. parl.ca blocks
//    GitHub's servers on some days (HTTP 403). openparliament carries status
//    only, so a bill's last LEGISinfo record is kept unless openparliament
//    shows the bill has moved since.
// 3. The previous record, flagged stale, when neither answers.
//
// The official summary printed in each bill comes from the bill's
// openparliament page either way. The run never fails because a fetch did,
// so the live page never breaks.
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

// GET JSON with up to three attempts. A 403 is a block, not a hiccup, so it
// is not retried.
async function getJson(url) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(url, { headers: HEADERS });
      if (!res.ok) {
        const err = new Error(`HTTP ${res.status}`);
        err.status = res.status;
        throw err;
      }
      return await res.json();
    } catch (err) {
      if (attempt === 3 || err.status === 403) throw err;
      await sleep(3000 * attempt);
    }
  }
}

async function fetchLegisinfo(number) {
  const data = await getJson(`https://www.parl.ca/legisinfo/en/bill/${SESSION}/${number.toLowerCase()}/json`);
  const bill = Array.isArray(data) ? data[0] : data;
  if (!bill || !bill.NumberCode) throw new Error("unexpected payload");
  return bill;
}

const fetchOpenparliament = (number) =>
  getJson(`https://api.openparliament.ca/bills/${SESSION}/${number.toUpperCase()}/?format=json`);

function committeeUrl(acronym, chamber) {
  if (!acronym) return null;
  return chamber === "Senate"
    ? `https://sencanada.ca/en/committees/${acronym}/${SESSION}`
    : `https://www.ourcommons.ca/Committees/en/${acronym}?parl=45&session=1`;
}

function committeesFrom(bill) {
  const list = [];
  const seen = new Set();
  const add = (c, chamber, role) => {
    if (!c || !c.CommitteeNameEn) return;
    const key = `${chamber}|${c.CommitteeAcronym || c.CommitteeNameEn}|${role}`;
    if (seen.has(key)) return;
    seen.add(key);
    list.push({
      name: c.CommitteeNameEn,
      acronym: c.CommitteeAcronym || "",
      chamber,
      role,
      url: committeeUrl(c.CommitteeAcronym, chamber),
      current: false,
    });
  };
  const stages = bill.BillStages || {};
  for (const [arr, chamber] of [
    [stages.HouseBillStages, "House of Commons"],
    [stages.SenateBillStages, "Senate"],
  ]) {
    for (const st of arr || []) {
      add(st.Committee, chamber, "study");
      for (const m of st.CommitteeMeetings || []) add(m, chamber, "study");
    }
  }
  const pre = bill.SenatePreStudyCommitteeDetails;
  for (const c of Array.isArray(pre) ? pre : pre ? [pre] : []) add(c, "Senate", "pre-study");

  // Flag the committee(s) holding the bill right now.
  const status = bill.StatusNameEn || "";
  if (/committee/i.test(status)) {
    const chamber = /Senate/.test(status) ? "Senate" : "House of Commons";
    const inChamber = list.filter((c) => c.chamber === chamber && c.role === "study");
    if (inChamber.length) inChamber[inChamber.length - 1].current = true;
  }
  if (bill.IsInSenatePreStudy) list.filter((c) => c.role === "pre-study").forEach((c) => (c.current = true));
  return list;
}

function textUrl(bill) {
  const code = bill.NumberCode.toUpperCase();
  let version = "first-reading";
  if (bill.ReceivedRoyalAssent) version = "royal-assent";
  else if (bill.PassedFirstChamberThirdReading) version = "third-reading";
  return `https://www.parl.ca/DocumentViewer/en/${SESSION}/bill/${code}/${version}`;
}

// A full record from LEGISinfo. Fields LEGISinfo does not carry (official
// summary, RiverRidge fields) come through from the previous record.
function fromLegisinfo(bill, base) {
  const statute =
    bill.StatuteYear && bill.StatuteChapter ? `S.C. ${bill.StatuteYear}, c. ${bill.StatuteChapter}` : null;
  return {
    ...base,
    number: bill.NumberCode,
    shortTitle: bill.ShortTitleEn || "",
    longTitle: bill.LongTitleEn || "",
    type: bill.BillDocumentTypeNameEn || "",
    isGovernmentBill: !!bill.IsGovernmentBill,
    originatingChamber: bill.OriginatingChamberNameEn || base.originatingChamber || "",
    sponsor: [bill.SponsorPersonShortHonorificEn, (bill.SponsorPersonName || "").trim()]
      .filter(Boolean)
      .join(" ")
      .trim(),
    sponsorTitle: bill.SponsorAffiliationTitleEn || bill.SponsorConstituencyNameEn || "",
    status: bill.StatusNameEn || base.status || "",
    statusSource: "legisinfo",
    latestEvent: bill.LatestBillEventTypeNameEn
      ? {
          type: bill.LatestBillEventTypeNameEn,
          date: (bill.LatestBillEventDateTime || "").slice(0, 10),
          chamber: bill.LatestBillEventChamberNameEn || "",
        }
      : base.latestEvent || null,
    progress: [
      !!bill.PassedFirstChamberFirstReading,
      !!bill.PassedFirstChamberSecondReading,
      !!bill.PassedFirstChamberThirdReading,
      !!bill.PassedSecondChamberFirstReading,
      !!bill.PassedSecondChamberSecondReading,
      !!bill.PassedSecondChamberThirdReading,
      !!bill.ReceivedRoyalAssent,
    ],
    royalAssent: bill.ReceivedRoyalAssentDateTime ? bill.ReceivedRoyalAssentDateTime.slice(0, 10) : null,
    statute,
    committees: committeesFrom(bill),
    legisinfoUrl: `https://www.parl.ca/legisinfo/en/bill/${SESSION}/${bill.NumberCode.toLowerCase()}`,
    textUrl: textUrl(bill),
    stale: false,
  };
}

// The official summary printed in the bill, as shown on the bill's
// openparliament page (the API does not carry it). Returns
// { paragraphs, lopUrl } or null. Any failure keeps the previous summary.
async function fetchSummary(number) {
  const url = `https://openparliament.ca/bills/${SESSION}/${number.toUpperCase()}/`;
  const res = await fetch(url, { headers: { ...HEADERS, Accept: "text/html" } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const html = await res.text();
  const m = html.match(/<div class="bill_summary">([\s\S]*?)<\/div>/);
  if (!m) return null;
  const paragraphs = [...m[1].matchAll(/<p>([\s\S]*?)<\/p>/g)]
    .flatMap((p) => cleanText(p[1]).split("\n"))
    .filter(Boolean);
  if (!paragraphs.length) return null;
  const lop = html.match(/href="(https:\/\/loppublicservices\.parl\.ca\/[^"]+)"[^>]*>legislative summary/);
  return { paragraphs, lopUrl: lop ? decodeEntities(lop[1]) : null };
}

const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', "#39": "'", nbsp: " " };
const decodeEntities = (t) =>
  t.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (all, e) => {
    if (e[0] === "#") return String.fromCodePoint(e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10));
    return ENTITIES[e.toLowerCase()] ?? all;
  });

// Bill text to plain text: <br> becomes a line break, tags go, and the double
// spaces left where italics were removed are tidied. Em dashes in the official
// text are shown as spaced en dashes to match the site's house style.
function cleanText(fragment) {
  return decodeEntities(fragment.replace(/<br\s*\/?>/gi, "\n").replace(/<[^>]+>/g, ""))
    .split("\n")
    .map((line) => line.replace(/\s+/g, " ").replace(/\s+([,.;:)])/g, "$1").replace(/\(\s+/g, "(").trim())
    .filter(Boolean)
    .join("\n")
    .replace(/\s*\u2014\s*/g, " \u2013 ");
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

// Furthest of the 7 stages passed, derived from openparliament's status text
// ("Third reading (House)" means at third reading, so two readings passed, as
// LEGISinfo counts them) plus the bill's originating chamber. Approximate but
// only ever used to advance the bar: the result is max()'d against the
// previous record so parsing noise can never move a bill backwards.
// Count of true entries at the front of a progress array.
const countProgress = (p) => (Array.isArray(p) ? p.filter(Boolean).length : 0);
const toProgress = (n) => Array.from({ length: 7 }, (_, i) => i < n);

function derivedStages(s, originating) {
  if (isLaw({}, s)) return 7;
  const cur = chamberFromStatus(s) || originating;
  const second = cur && originating && cur !== originating;
  // Stage within the current chamber.
  let within = 0;
  if (/third reading/i.test(s)) within = 2;
  else if (/report stage/i.test(s)) within = 2;
  else if (/committee/i.test(s)) within = 2;
  else if (/second reading/i.test(s)) within = 1;
  else if (/first reading|introduc/i.test(s)) within = 1;
  if (second) return Math.min(7, 3 + within);
  return Math.min(3, within);
}

// Today's date in Ottawa, YYYY-MM-DD.
const today = () => new Date().toLocaleDateString("en-CA", { timeZone: "America/Toronto" });

function fromOpenparliament(base, op) {
  const s = statusText(op);
  if (!s) return null;
  const law = isLaw(op, s);
  const chamber = chamberFromStatus(s);
  const had = countProgress(base.progress);
  const derived = law ? 7 : derivedStages(s, base.originatingChamber);
  // The last LEGISinfo record is richer (exact dates, committees). Keep it
  // unless openparliament shows the bill has moved on since.
  if (base.statusSource === "legisinfo" && derived <= had) return { ...base, stale: false };
  const reached = Math.max(had, derived);
  // openparliament gives no event date, so a new status is dated the day this
  // script first sees it. An unchanged status keeps the previous event.
  const changed = derived > had || (base.statusSource === "openparliament" && base.status !== s);
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
  // LEGISinfo dates the event itself; openparliament only lets us date the
  // day the change was first seen.
  const date = (next.statusSource === "legisinfo" && next.latestEvent?.date) || today();
  const entry = (kind, text) => ({ date, number: next.number, kind, text });
  const wasLaw = countProgress(prev.progress) >= 7;
  const isNowLaw = countProgress(next.progress) >= 7;
  if (isNowLaw && !wasLaw) return [entry("law", "Became law (royal assent)")];
  if (countProgress(next.progress) > countProgress(prev.progress)) return [entry("stage", `Advanced to: ${next.status}`)];
  // Wording changes count only when both readings came from the same source,
  // so switching between LEGISinfo and openparliament wording is not a change.
  if (prev.statusSource && prev.statusSource === next.statusSource && prev.status !== next.status) {
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
const count = { legisinfo: 0, openparliament: 0, stale: 0 };
const changes = [];
// After three 403s in a row parl.ca is blocking this run; stop asking it.
let legisinfoBlocks = 0;
for (const cfg of config.bills) {
  const base = baseByNumber.get(cfg.number) || {
    number: cfg.number,
    originatingChamber: cfg.number.startsWith("S") ? "Senate" : "House of Commons",
    progress: [false, false, false, false, false, false, false],
    committees: [],
    legisinfoUrl: `https://www.parl.ca/legisinfo/en/bill/${SESSION}/${cfg.number.toLowerCase()}`,
    textUrl: `https://www.parl.ca/DocumentViewer/en/${SESSION}/bill/${cfg.number}/first-reading`,
  };
  let rec = null;
  if (legisinfoBlocks < 3) {
    try {
      rec = fromLegisinfo(await fetchLegisinfo(cfg.number), base);
      legisinfoBlocks = 0;
      count.legisinfo++;
      console.log(`ok   ${cfg.number} (LEGISinfo): ${rec.status}`);
    } catch (err) {
      if (err.status === 403 && ++legisinfoBlocks === 3) {
        console.error("LEGISinfo returned 403 three times in a row; using openparliament.ca for the remaining bills.");
      }
      console.error(`legisinfo ${cfg.number}: ${err.message}`);
    }
    await sleep(1200);
  }
  if (!rec) {
    try {
      const op = await fetchOpenparliament(cfg.number);
      rec = fromOpenparliament(base, op);
      if (rec) {
        count.openparliament++;
        console.log(`ok   ${cfg.number} (openparliament): ${rec.status}`);
      } else {
        console.error(`nostatus ${cfg.number}: no status field in response. Keys: ${Object.keys(op || {}).join(", ")}`);
      }
    } catch (err) {
      console.error(`openparliament ${cfg.number}: ${err.message}`);
    }
    await sleep(1200);
  }
  if (!rec) {
    rec = { ...base, stale: true };
    count.stale++;
    console.error(`stale ${cfg.number}: no source answered (kept previous record)`);
  }

  // Official summary: refreshed when the page can be read, otherwise kept.
  try {
    const sum = await fetchSummary(cfg.number);
    if (sum) {
      rec.officialSummary = sum.paragraphs;
      if (sum.lopUrl) rec.lopSummaryUrl = sum.lopUrl;
    } else if (!rec.officialSummary) {
      console.error(`nosummary ${cfg.number}: no summary block on the openparliament page`);
    }
  } catch (err) {
    console.error(`nosummary ${cfg.number}: ${err.message} (kept previous)`);
  }

  // Config is the source of truth for grouping and the written summary.
  rec.theme = cfg.theme;
  rec.summary = cfg.summary || rec.summary || "";
  // Optional RiverRidge outlook, written by hand in the config: { "text": "...", "date": "YYYY-MM-DD" }.
  if (cfg.outlook && cfg.outlook.text) rec.outlook = cfg.outlook;
  else delete rec.outlook;
  changes.push(...changesFor(baseByNumber.get(cfg.number), rec));
  bills.push(rec);
  await sleep(1200); // be gentle on both sites
}

// Rolling changelog: newest first, 60 days, at most 200 entries.
const cutoff = new Date(Date.now() - 60 * 86400000).toISOString().slice(0, 10);
const changelog = [...changes, ...(previous.changelog || [])]
  .filter((c) => c.date >= cutoff)
  .sort((a, b) => b.date.localeCompare(a.date))
  .slice(0, 200);

const out = {
  checkedAt: new Date().toISOString(),
  source: "LEGISinfo, Parliament of Canada (status, dates, committees), with openparliament.ca as backup and for official summaries",
  session: SESSION,
  themes: config.themes,
  bills,
  changelog,
};
await writeFile(OUT_PATH, JSON.stringify(out, null, 2) + "\n");
for (const c of changes) console.log(`change ${c.number}: ${c.text}`);
console.log(
  `Wrote ${bills.length} bills: ${count.legisinfo} from LEGISinfo, ${count.openparliament} from openparliament.ca, ` +
    `${count.stale} kept stale, ${changes.length} changes logged.`
);
