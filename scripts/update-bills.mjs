// Refreshes data/bills.json from LEGISinfo (Parliament of Canada).
// Run by .github/workflows/update-legislation-tracker.yml once a day.
// Usage: node scripts/update-bills.mjs
// Node 20+ (uses built-in fetch). No dependencies.

import { readFile, writeFile } from "node:fs/promises";

const SESSION = "45-1";
const CONFIG_PATH = new URL("../data/bills.config.json", import.meta.url);
const OUT_PATH = new URL("../data/bills.json", import.meta.url);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Send the headers a real browser would. LEGISinfo sits behind bot protection
// that rejects requests with a non-browser User-Agent or missing Accept headers.
const BROWSER_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36",
  Accept: "application/json, text/javascript, */*; q=0.01",
  "Accept-Language": "en-CA,en;q=0.9,fr;q=0.8",
  Referer: "https://www.parl.ca/legisinfo/en/bills?parlsession=45-1",
};

async function fetchBill(number) {
  const url = `https://www.parl.ca/legisinfo/en/bill/${SESSION}/${number.toLowerCase()}/json`;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(url, { headers: BROWSER_HEADERS });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      const bill = Array.isArray(data) ? data[0] : data;
      if (!bill || !bill.NumberCode) throw new Error("unexpected payload");
      return bill;
    } catch (err) {
      if (attempt === 3) throw err;
      await sleep(2000 * attempt);
    }
  }
}

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

function toRecord(bill, cfg) {
  const statute =
    bill.StatuteYear && bill.StatuteChapter ? `S.C. ${bill.StatuteYear}, c. ${bill.StatuteChapter}` : null;
  return {
    number: bill.NumberCode,
    theme: cfg.theme,
    summary: cfg.summary || "",
    shortTitle: bill.ShortTitleEn || "",
    longTitle: bill.LongTitleEn || "",
    type: bill.BillDocumentTypeNameEn || "",
    isGovernmentBill: !!bill.IsGovernmentBill,
    originatingChamber: bill.OriginatingChamberNameEn || "",
    sponsor: [bill.SponsorPersonShortHonorificEn, (bill.SponsorPersonName || "").trim()]
      .filter(Boolean)
      .join(" ")
      .trim(),
    sponsorTitle: bill.SponsorAffiliationTitleEn || bill.SponsorConstituencyNameEn || "",
    status: bill.StatusNameEn || "",
    latestEvent: bill.LatestBillEventTypeNameEn
      ? {
          type: bill.LatestBillEventTypeNameEn,
          date: (bill.LatestBillEventDateTime || "").slice(0, 10),
          chamber: bill.LatestBillEventChamberNameEn || "",
        }
      : null,
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

const config = JSON.parse(await readFile(CONFIG_PATH, "utf8"));
let previous = { bills: [] };
try {
  previous = JSON.parse(await readFile(OUT_PATH, "utf8"));
} catch {}
const prevByNumber = new Map(previous.bills.map((b) => [b.number, b]));

const bills = [];
let failures = 0;
for (const cfg of config.bills) {
  try {
    const bill = await fetchBill(cfg.number);
    bills.push(toRecord(bill, cfg));
    console.log(`ok   ${cfg.number}: ${bill.StatusNameEn}`);
  } catch (err) {
    failures++;
    const prev = prevByNumber.get(cfg.number);
    if (prev) bills.push({ ...prev, theme: cfg.theme, summary: cfg.summary || prev.summary, stale: true });
    console.error(`FAIL ${cfg.number}: ${err.message}${prev ? " (kept previous record)" : ""}`);
  }
  await sleep(500);
}

if (failures > config.bills.length / 2) {
  console.error(`Too many failures (${failures}/${config.bills.length}); leaving bills.json unchanged.`);
  process.exit(1);
}

const out = {
  checkedAt: new Date().toISOString(),
  source: "LEGISinfo, Parliament of Canada",
  session: SESSION,
  themes: config.themes,
  bills,
};
await writeFile(OUT_PATH, JSON.stringify(out, null, 2) + "\n");
console.log(`Wrote ${bills.length} bills (${failures} failed).`);
