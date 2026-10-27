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
// openparliament page either way. scripts/parliament.mjs adds witnesses from
// House committee notices, briefs and witness lists from House committee
// studies, amendments from committee minutes, speeches naming each bill from
// House and Senate debates, and digital bills on the House Notice Paper.
// scripts/billtext.mjs reads each published version of a bill: what changed,
// when it comes into force and the penalties it names. The run never fails
// because a fetch did, so the live page never breaks. It also writes
// data/bills.csv, a spreadsheet copy of the tracker.
//
// Run by .github/workflows/update-legislation-tracker.yml once a day.
// Node 20+ (built-in fetch). No dependencies.

import { readFile, writeFile } from "node:fs/promises";
import { analyse, versionFiles } from "./billtext.mjs";
import {
  MEMBERS_XML_URL,
  amendmentsFrom,
  billsOnNotice,
  briefsFrom,
  fetchText,
  houseBriefsUrl,
  houseMinutesUrl,
  houseStudyUrl,
  houseStudyWitnessesUrl,
  partiesFrom,
  studyWitnessesFrom,
  houseHansardUrl,
  houseHansardXmlUrl,
  houseMeetingUrl,
  houseMentions,
  latestHouseSitting,
  latestSenateSitting,
  senateCommitteeUrl,
  senateDebatesUrl,
  senateMentions,
  witnessesFrom,
} from "./parliament.mjs";

const SESSION = "45-1";
const CONFIG_PATH = new URL("../data/bills.config.json", import.meta.url);
const OUT_PATH = new URL("../data/bills.json", import.meta.url);
const CSV_PATH = new URL("../data/bills.csv", import.meta.url);

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

// The bill's parliamentary record from LEGISinfo's stage data: committee
// meetings, sitting days on which something happened in the chamber, and
// recorded decisions. Witness lists read on earlier runs are carried over.
function activityFrom(bill, base) {
  const day = (t) => (t || "").slice(0, 10);
  const key = (m) => `${m.chamber}|${m.committee}|${m.number}`;
  const known = new Map((base.activity?.meetings || []).map((m) => [key(m), m]));
  const meetings = new Map();
  const sittings = [];
  const decisions = [];
  const stages = bill.BillStages || {};
  for (const [list, chamber] of [
    [stages.HouseBillStages, "House"],
    [stages.SenateBillStages, "Senate"],
  ]) {
    for (const st of list || []) {
      for (const m of st.CommitteeMeetings || []) {
        const meeting = {
          date: day(m.Date),
          chamber,
          committee: m.CommitteeAcronym || "",
          number: String(m.Number ?? ""),
          url: chamber === "House" ? houseMeetingUrl(m.CommitteeAcronym, m.Number) : senateCommitteeUrl(m.CommitteeAcronym),
        };
        const seen = known.get(key(meeting));
        if (seen?.witnesses) meeting.witnesses = seen.witnesses;
        if (seen?.study !== undefined) meeting.study = seen.study;
        if (seen?.amendments) meeting.amendments = seen.amendments;
        meetings.set(key(meeting), meeting); // a meeting can be listed under two stages
      }
      for (const s of st.Sittings || []) {
        sittings.push({
          date: day(s.Date),
          chamber,
          sitting: String(s.Number ?? ""),
          event: s.NameEn || "",
          url: chamber === "House" ? houseHansardUrl(s.Number) : senateDebatesUrl(s.Number, day(s.Date)),
        });
      }
      for (const d of st.Decisions || []) {
        decisions.push({
          date: day(d.DecisionSittingDate),
          chamber,
          motion: d.DecisionMotionTitleEn || "",
          result: d.DecisionResultNameEn || "",
          method: d.DecisionMethodNameEn || "",
          yeas: d.DivisionVotesYeas ?? null,
          nays: d.DivisionVotesNays ?? null,
        });
      }
    }
  }
  const newestFirst = (a, b) => b.date.localeCompare(a.date);
  return {
    meetings: [...meetings.values()].sort(newestFirst),
    sittings: sittings.sort(newestFirst),
    decisions: decisions.sort(newestFirst),
  };
}

// A full record from LEGISinfo. Fields LEGISinfo does not carry (official
// summary, mentions, RiverRidge fields) come through from the previous record.
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
    activity: activityFrom(bill, base),
    publications: (bill.Publications || []).map((p) => ({ id: String(p.PublicationId), type: p.PublicationTypeNameEn || "" })),
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

// Committee amendments decided on a bill (or only those adopted), from the
// minutes read so far; null when no minutes have been read yet.
function amendmentCount(b, result) {
  const read = (b.activity?.meetings || []).filter((m) => m.amendments);
  if (!read.length) return null;
  return read.reduce((n, m) => n + m.amendments.filter((a) => !result || a.result === result).length, 0);
}

// A flat copy for spreadsheets, one row per bill. The byte-order mark makes
// Excel read the accents correctly.
function toCsv(bills, themes) {
  const themeLabel = new Map(themes.map((t) => [t.id, t.label]));
  const since30 = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
  const cell = (v) => {
    const t = v == null ? "" : String(v);
    return /[",\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t;
  };
  const rows = [
    [
      "Bill", "Short title", "Long title", "Policy area", "Type", "Sponsor", "Status", "Stages passed (of 7)",
      "Last activity", "Last activity date", "Last activity chamber", "Committees", "Royal assent", "Statute",
      "Committee meetings", "Last committee meeting", "Speeches naming the bill (last 30 days)",
      "Provisions changed in committee", "Coming into force", "Briefs to House committee",
      "Organizations heard at House committee", "Committee amendments adopted", "Committee amendments decided",
      "RiverRidge summary", "LEGISinfo", "Bill text",
    ],
    ...bills.map((b) => [
      b.number, b.shortTitle, b.longTitle, themeLabel.get(b.theme) || b.theme, b.type, b.sponsor, b.status,
      countProgress(b.progress), b.latestEvent?.type, b.latestEvent?.date, b.latestEvent?.chamber,
      (b.committees || []).map((c) => `${c.acronym}${c.current ? " (now)" : ""}${c.role === "pre-study" ? " (pre-study)" : ""}`).join("; "),
      b.royalAssent, b.statute, b.activity?.meetings?.length ?? "", b.activity?.meetings?.[0]?.date,
      (b.mentions || []).filter((m) => m.date >= since30).reduce((n, m) => n + m.speeches, 0),
      (b.text?.changes || []).filter((c) => /committee/i.test(c.to)).reduce((n, c) => n + c.provisions.filter((p) => p.kind !== "renumbered").length, 0) || "",
      (b.text?.inForce || []).map((f) => `${f.ref}: ${f.text}`).join(" | "),
      (b.studies || []).reduce((n, x) => n + x.briefs.length, 0) || "",
      (b.studies || []).reduce((n, x) => n + x.witnesses.filter((w) => w.name !== "As an individual").length, 0) || "",
      amendmentCount(b, "adopted") ?? "", amendmentCount(b) ?? "",
      b.summary, b.legisinfoUrl, b.textUrl,
    ]),
  ];
  return "\uFEFF" + rows.map((r) => r.map(cell).join(",")).join("\r\n") + "\r\n";
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

// House committee meetings on each bill: the notice (witnesses, and the
// study the meeting belongs to) and the minutes (amendments decided and how
// they fared). Both are final once a meeting has happened, so each is read
// once, newest meetings first, at most MEETING_READS meetings per run (the
// first runs backfill). The notice is skipped when witnesses are already
// known and the bill's study at that committee is known from another meeting.
const MEETING_READS = 30;
let partyOf = null;
const studyKnown = (b, committee) => (b.activity?.meetings || []).some((m) => m.committee === committee && m.study);
const meetingQueue = bills
  .flatMap((b) => (b.activity?.meetings || []).map((m) => ({ b, m })))
  .filter(({ b, m }) => m.chamber === "House" && m.date && m.date < today() &&
    (!m.witnesses || m.amendments === undefined || (m.study === undefined && !studyKnown(b, m.committee))))
  .sort((x, y) => y.m.date.localeCompare(x.m.date))
  .slice(0, MEETING_READS);
let meetingsRead = 0;
for (const { b, m } of meetingQueue) {
  if (!m.witnesses || (m.study === undefined && !studyKnown(b, m.committee))) {
    try {
      const { study, ...w } = witnessesFrom(await fetchText(m.url), b.number);
      m.witnesses = w;
      m.study = study;
    } catch (err) {
      if (err.status === 404) { m.witnesses = m.witnesses || { orgs: [], people: [], appearing: [] }; m.study = m.study ?? null; }
      console.error(`notice ${b.number} ${m.committee} ${m.number}: ${err.message}`);
    }
    await sleep(1200);
  }
  if (m.amendments === undefined) {
    try {
      if (!partyOf) {
        partyOf = partiesFrom(await fetchText(MEMBERS_XML_URL));
        await sleep(1200);
      }
      m.amendments = amendmentsFrom(await fetchText(houseMinutesUrl(m.committee, m.number)), b.number, partyOf);
    } catch (err) {
      if (err.status === 404) m.amendments = [];
      console.error(`minutes ${b.number} ${m.committee} ${m.number}: ${err.message}`);
    }
    await sleep(1200);
  }
  meetingsRead++;
}

// Each House committee study of a bill: the briefs submitted and the
// witnesses heard, from the study's own lists. Refreshed weekly, or daily
// while the committee has met on the bill in the last 30 days.
const STUDY_DAYS = 30;
let studiesRead = 0;
for (const b of bills) {
  const ids = new Map();
  for (const m of b.activity?.meetings || []) if (m.chamber === "House" && m.study) ids.set(`${m.committee}|${m.study}`, m);
  const previousStudies = new Map((b.studies || []).map((x) => [`${x.committee}|${x.id}`, x]));
  const studies = [];
  for (const [k, m] of ids) {
    const prev = previousStudies.get(k);
    const lastMeeting = (b.activity.meetings.filter((x) => x.committee === m.committee && x.date <= today())[0] || {}).date || "";
    const recent = lastMeeting >= new Date(Date.now() - STUDY_DAYS * 86400000).toISOString().slice(0, 10);
    const stale = !prev || !prev.checked || prev.checked < new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10);
    if (prev && !recent && !stale) { studies.push(prev); continue; }
    try {
      const briefs = briefsFrom(await fetchText(houseBriefsUrl(m.committee, m.study)));
      await sleep(1200);
      const witnesses = studyWitnessesFrom(await fetchText(houseStudyWitnessesUrl(m.committee, m.study)));
      await sleep(1200);
      studies.push({ chamber: "House", committee: m.committee, id: m.study, url: houseStudyUrl(m.committee, m.study), briefs, witnesses, checked: today() });
      studiesRead++;
    } catch (err) {
      console.error(`study ${b.number} ${m.committee} ${m.study}: ${err.message}`);
      if (prev) studies.push(prev);
    }
  }
  if (studies.length) b.studies = studies;
}

// Bill text: what each published version changed from the one before, when
// the bill comes into force and the penalties it names. A version's page is
// read once for its XML address; the analysis reruns only when a new version
// appears. At most TEXT_FETCHES pages and files per run (the first runs
// backfill).
const TEXT_FETCHES = 60;
let textFetches = 0;
let textsAnalysed = 0;
for (const b of bills) {
  const pubs = b.publications || [];
  const prev = b.text || {};
  const basis = pubs.map((p) => p.id).join(",");
  if (!pubs.length || prev.basis === basis) continue;
  const known = new Map((prev.versions || []).map((v) => [v.id, v]));
  const versions = [];
  try {
    for (const p of pubs) {
      let v = known.get(p.id);
      if (!v?.xml) {
        if (textFetches >= TEXT_FETCHES) throw new Error("run limit reached; continuing tomorrow");
        textFetches++;
        v = { id: p.id, type: p.type, ...versionFiles(await fetchText(`https://www.parl.ca/DocumentViewer/en/${p.id}`)) };
        await sleep(1200);
      }
      versions.push(v);
    }
    const docs = [];
    for (const v of versions) {
      if (!v.xml) throw new Error(`no XML for version ${v.id} (${v.type})`);
      if (textFetches >= TEXT_FETCHES) throw new Error("run limit reached; continuing tomorrow");
      textFetches++;
      docs.push({ type: v.type, xml: await fetchText(v.xml) });
      await sleep(1200);
    }
    b.text = { basis, versions, ...analyse(docs) };
    textsAnalysed++;
  } catch (err) {
    console.error(`bill text ${b.number}: ${err.message}`);
    // Keep the version addresses found so far for the next run.
    b.text = { ...prev, versions: [...versions, ...(prev.versions || []).filter((v) => !versions.some((x) => x.id === v.id))] };
  }
}

// Mentions in debate: speeches naming a tracked bill, from each House sitting
// since the last run (the first run reads the last 20) and the latest Senate
// sitting. Kept for MENTION_DAYS.
const MENTION_DAYS = 90;
const numbers = config.bills.map((b) => b.number);
const scan = { ...(previous.scan || {}) };
const found = [];
try {
  const latest = await latestHouseSitting();
  for (let n = scan.houseSitting ? scan.houseSitting + 1 : latest - 19; n <= latest; n++) {
    try {
      const { date, byBill } = houseMentions(await fetchText(houseHansardXmlUrl(n)), numbers);
      for (const [number, r] of byBill) found.push({ number, chamber: "House", sitting: String(n), date, url: houseHansardUrl(n), ...r });
      scan.houseSitting = n;
    } catch (err) {
      console.error(`hansard House ${n}: ${err.message}`);
      if (n === latest) break; // not published yet; try again tomorrow
      scan.houseSitting = n;
    }
    await sleep(1200);
  }
} catch (err) {
  console.error(`hansard House: ${err.message}`);
}
try {
  const latest = await latestSenateSitting();
  if (!scan.senateSitting || latest.sitting > scan.senateSitting) {
    const url = senateDebatesUrl(latest.sitting, latest.date);
    for (const [number, r] of senateMentions(await fetchText(url), numbers)) {
      found.push({ number, chamber: "Senate", sitting: String(latest.sitting), date: latest.date, url, ...r });
    }
    scan.senateSitting = latest.sitting;
  }
} catch (err) {
  console.error(`debates Senate: ${err.message}`);
}
const mentionCutoff = new Date(Date.now() - MENTION_DAYS * 86400000).toISOString().slice(0, 10);
for (const b of bills) {
  const fresh = found.filter((f) => f.number === b.number).map(({ number, ...m }) => m);
  const kept = (b.mentions || []).filter((m) => !fresh.some((f) => f.chamber === m.chamber && f.sitting === m.sitting));
  b.mentions = [...fresh, ...kept].filter((m) => m.date >= mentionCutoff).sort((x, y) => y.date.localeCompare(x.date));
}

// Digital-policy bills on notice in the House, before first reading. The
// match is on the bill's title; a failed read keeps yesterday's list.
const DIGITAL =
  /\b(online|internet|digital|cyber\w*|data|privacy|personal information|artificial intelligence|AI|algorithm\w*|deepfakes?|platforms?|social media|telecommunications?|broadband|spectrum|wireless|radiocommunication|broadcasting|streaming|electronic|software|computers?|crypto\w*|stablecoins?|surveillance|lawful access|encryption|chatbots?|technolog\w*)\b/i;
let upcoming = previous.upcoming || [];
try {
  const { sitting, notices } = await billsOnNotice();
  const firstSeen = new Map(upcoming.map((u) => [u.title, u.firstSeen]));
  upcoming = notices
    .filter((n) => DIGITAL.test(n.title))
    .map((n) => ({ chamber: "House", ...n, sitting, firstSeen: firstSeen.get(n.title) || today() }));
} catch (err) {
  console.error(`notice paper: ${err.message} (kept previous list)`);
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
  upcoming,
  scan,
};
// House style: no em dashes anywhere, including riding names in source text.
const noEm = (t) => t.replace(/\u2014/g, "\u2013");
await writeFile(OUT_PATH, noEm(JSON.stringify(out, null, 2)) + "\n");
await writeFile(CSV_PATH, noEm(toCsv(bills, config.themes)));
for (const c of changes) console.log(`change ${c.number}: ${c.text}`);
console.log(
  `Wrote ${bills.length} bills: ${count.legisinfo} from LEGISinfo, ${count.openparliament} from openparliament.ca, ` +
    `${count.stale} kept stale, ${changes.length} changes logged. ${meetingsRead} committee meetings read, ` +
    `${studiesRead} committee studies refreshed, ${textsAnalysed} bill texts analysed, ` +
    `${found.length} new mentions, ${upcoming.length} digital bills on notice.`
);
