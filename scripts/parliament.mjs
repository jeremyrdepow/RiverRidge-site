// Parliament of Canada sources beyond LEGISinfo, used by update-bills.mjs:
// committee meeting notices (witnesses), House committee study pages (briefs
// and witness lists), committee minutes (amendments and how they fared), the
// House list of MPs (party), House and Senate debates (where a bill is
// mentioned) and the House Notice Paper (bills on notice before first reading). Everything here is plain string work on the published
// pages, so there are no dependencies. Each parser was written against real
// pages fetched by GitHub Actions on Oct 27, 2026.

const SESSION = "45-1";
const SESSION_CODE = SESSION.replace("-", ""); // "451", as used in parl.ca paths

const HEADERS = {
  "User-Agent": "RiverRidge-legislation-tracker/1.0 (+https://riverridgeintelligence.ca)",
};

export async function fetchText(url) {
  const res = await fetch(url, { headers: HEADERS });
  if (!res.ok) {
    const err = new Error(`HTTP ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return res.text();
}

const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
const decode = (t) =>
  t.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (all, e) => {
    if (e[0] === "#") return String.fromCodePoint(e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10));
    return ENTITIES[e.toLowerCase()] ?? all;
  });

// Markup to one line of text.
export const plain = (html) => decode(html.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();

// Bill numbers appear with ordinary and non-breaking hyphens ("C‑40"), so
// match any of them. \b keeps C-31 from matching C-310.
export const billPattern = (number) => {
  const [prefix, n] = number.split("-");
  return new RegExp(`\\b${prefix}[-\\u2010\\u2011\\u2012\\u2013]${n}\\b`);
};

const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];

// "Monday, October 26, 2026" or "June 8, 2026" to "2026-10-26".
export function isoDate(text) {
  const m = String(text).match(/([A-Za-z]+)\.? (\d{1,2}), (\d{4})/);
  if (!m) return null;
  const mo = MONTHS.findIndex((name) => name.startsWith(m[1].toLowerCase().slice(0, 3)));
  if (mo < 0) return null;
  return `${m[3]}-${String(mo + 1).padStart(2, "0")}-${m[2].padStart(2, "0")}`;
}

// ---------- Links ----------

const pad3 = (n) => String(n).padStart(3, "0");
export const houseHansardUrl = (sitting) => `https://www.ourcommons.ca/DocumentViewer/en/${SESSION}/house/sitting-${sitting}/hansard`;
export const houseHansardXmlUrl = (sitting) =>
  `https://www.ourcommons.ca/Content/House/${SESSION_CODE}/Debates/${pad3(sitting)}/HAN${pad3(sitting)}-E.XML`;
export const senateDebatesUrl = (sitting, date) =>
  `https://sencanada.ca/en/content/sen/chamber/${SESSION_CODE}/debates/${pad3(sitting)}db_${date}-e`;
export const houseMeetingUrl = (committee, number) =>
  `https://www.ourcommons.ca/DocumentViewer/en/${SESSION}/${committee}/meeting-${number}/notice`;
// Senate meeting pages have no stable per-meeting address; link the committee's
// transcripts and minutes page instead.
export const senateCommitteeUrl = (committee) => `https://sencanada.ca/en/committees/${committee}/transcriptsminutes/${SESSION}`;

// ---------- Committee witnesses (House meeting notices) ----------

// Witnesses heard on this bill at one meeting. A notice can cover several
// agenda items, so only the items whose title names the bill are read.
// Returns { orgs, people, appearing }: organizations, individuals appearing on
// their own, and ministers or others listed under "Appearing".
export function witnessesFrom(html, number) {
  const re = billPattern(number);
  const items = html.split(/<div class=['"]StudyActivity['"]>/i).slice(1);
  const out = { orgs: [], people: [], appearing: [] };
  let study = null;
  for (const item of items) {
    const title = plain(item.slice(0, item.indexOf("</a>") + 4));
    if (!re.test(title)) continue;
    study = study || (item.match(/studyActivityId=(\d+)/) || [])[1] || null;
    // Stop at the next agenda item's markup, which split() already did, and
    // read organizations, people and section headings in document order.
    let section = "Witnesses";
    let org = null;
    const tokens = /class=['"](?:Property|AmendedSection)['"]>([\s\S]*?)<\/div>|class="OrganizationName">([\s\S]*?)<\/div>|class="(?:WitnessListItem|AmendedListItem)"><span[^>]*>([\s\S]*?)<\/span>/g;
    for (const t of item.matchAll(tokens)) {
      if (t[1] !== undefined) {
        section = /appearing/i.test(plain(t[1])) ? "Appearing" : "Witnesses";
        org = null;
      } else if (t[2] !== undefined) {
        org = plain(t[2]);
        if (!/^as an? individual/i.test(org) && !out.orgs.includes(org)) out.orgs.push(org);
      } else {
        const person = plain(t[3]).replace(/^[•\u0095•]\s*/, "").replace(/\s*Amended$/, "");
        if (section === "Appearing") out.appearing.push(person);
        else if (!org || /^as an? individual/i.test(org)) out.people.push(person);
      }
    }
  }
  for (const k of Object.keys(out)) out[k] = [...new Set(out[k])];
  return { ...out, study };
}

// ---------- House committee studies: briefs, witnesses, amendments ----------

export const houseStudyUrl = (committee, id) => `https://www.ourcommons.ca/Committees/en/${committee}/StudyActivity?studyActivityId=${id}`;
const studyPart = (committee, id, part) => `https://www.ourcommons.ca/committees/en/${committee}/StudyActivity/${part}?studyActivityId=${id}`;
export const houseBriefsUrl = (committee, id) => studyPart(committee, id, "GetBriefs");
export const houseStudyWitnessesUrl = (committee, id) => studyPart(committee, id, "Witnesses");
export const houseMinutesUrl = (committee, number) => `https://www.ourcommons.ca/DocumentViewer/en/${SESSION}/${committee}/meeting-${number}/minutes`;
export const MEMBERS_XML_URL = "https://www.ourcommons.ca/Members/en/search/XML";

// Briefs submitted to a House committee study: who sent each, when it was
// published and the PDF. Names written "Last, First" are individuals.
export function briefsFrom(html) {
  return html.split(/class="brief-item/).slice(1).map((item) => {
    const name = plain((item.match(/<div class="name">([\s\S]*?)(?:<a|<\/div>)/) || [])[1] || "");
    const pdf = (item.match(/href="([^"]+\.pdf)"/i) || [])[1] || null;
    const published = isoDate(plain((item.match(/class="published">([\s\S]*?)<\/div>/) || [])[1] || ""));
    return { name, individual: /^[^,]+, [^,]+$/.test(name) && !/\b(inc|ltd|association|council|society|canada)\b/i.test(name), date: published, url: pdf ? (pdf.startsWith("//") ? "https:" + pdf : pdf) : null };
  }).filter((b) => b.name);
}

// Witnesses heard in a House committee study, from the study's witness list:
// each organization with the people who appeared for it and the meetings.
export function studyWitnessesFrom(html) {
  const orgs = new Map();
  let meeting = null;
  let org = null;
  const re = /class="witness-meeting[^"]*">[\s\S]*?\(Meeting (\d+)\)|class="witness-organization[^"]*">([\s\S]*?)<\/div>|class="witness-person">\s*<span>([\s\S]*?)<\/span>/gi;
  for (const m of html.matchAll(re)) {
    if (m[1] !== undefined) { meeting = m[1]; org = null; continue; }
    if (m[2] !== undefined) { org = plain(m[2]); continue; }
    const person = plain(m[3]).replace(/,$/, "");
    const key = org || "As an individual";
    const rec = orgs.get(key) || { name: key, people: [], meetings: [] };
    if (!rec.people.includes(person)) rec.people.push(person);
    if (meeting && !rec.meetings.includes(meeting)) rec.meetings.push(meeting);
    orgs.set(key, rec);
  }
  return [...orgs.values()];
}

// Party of each MP, keyed by "First Last" as committee minutes write names.
export function partiesFrom(xml) {
  const map = new Map();
  for (const m of xml.matchAll(/<MemberOfParliament>([\s\S]*?)<\/MemberOfParliament>/g)) {
    const get = (t) => plain((m[1].match(new RegExp(`<${t}>([^<]*)</${t}>`)) || [])[1] || "");
    map.set(`${get("PersonOfficialFirstName")} ${get("PersonOfficialLastName")}`, get("CaucusShortName"));
  }
  return map;
}

// Amendments decided at one committee meeting, from its minutes: who moved
// each and whether it was agreed to. A meeting can take up more than one bill,
// so each decision is credited to the bill named most recently before it.
export function amendmentsFrom(html, number, partyOf = new Map()) {
  const text = plain(html.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, " "));
  const name = "((?:[A-Z][\\w'\u2019\\-]+ ){1,3}[A-Z][\\w'\u2019\\-]+)";
  const re = new RegExp(`That Bill ([CS])[-\u2010\u2011\u2012\u2013](\\d+)|question was put on the amendment of ${name} and it was (negatived|agreed to)`, "g");
  const target = number.toUpperCase();
  let current = null;
  const out = [];
  for (const m of text.matchAll(re)) {
    if (m[1]) { current = `${m[1]}-${m[2]}`; continue; }
    if (current !== target) continue;
    out.push({ mover: m[3], party: partyOf.get(m[3]) || "", result: m[4] === "agreed to" ? "adopted" : "defeated" });
  }
  return out;
}

// ---------- Mentions in debate ----------

// "Luc Berthold (Mégantic–L'Érable–Lotbinière, CPC)" to "Luc Berthold (CPC)".
function speakerName(affiliation) {
  const m = affiliation.match(/^(.*?)\s*\((.*)\)\s*$/);
  if (!m) return affiliation;
  return `${m[1].trim()} (${m[2].split(",").pop().trim()})`;
}

function addMention(byBill, number, speaker, context) {
  const rec = byBill.get(number) || { speeches: 0, speakers: [], contexts: [] };
  rec.speeches++;
  if (speaker && !rec.speakers.includes(speaker)) rec.speakers.push(speaker);
  if (context && !rec.contexts.includes(context)) rec.contexts.push(context);
  byBill.set(number, rec);
}

// Latest House sitting with a published Hansard, from the "latest" page.
export async function latestHouseSitting() {
  const html = await fetchText("https://www.ourcommons.ca/DocumentViewer/en/house/latest/hansard");
  const nums = [...html.matchAll(/\/house\/sitting-(\d+)\/hansard/gi)].map((m) => Number(m[1]));
  if (!nums.length) throw new Error("no sitting number on the latest Hansard page");
  return Math.max(...nums);
}

// Speeches in one House sitting that name each bill. Reads the Hansard XML:
// order of business and subject headings give the context of each speech.
export function houseMentions(xml, numbers) {
  const date = isoDate((xml.match(/<ExtractedItem Name="Date">([^<]+)</) || [])[1] || "");
  const patterns = numbers.map((n) => [n, billPattern(n)]);
  const byBill = new Map();
  let order = "";
  let subject = "";
  const re = /<OrderOfBusinessTitle>([\s\S]*?)<\/OrderOfBusinessTitle>|<SubjectOfBusinessTitle>([\s\S]*?)<\/SubjectOfBusinessTitle>|<Intervention\b[^>]*>([\s\S]*?)<\/Intervention>/g;
  for (const m of xml.matchAll(re)) {
    if (m[1] !== undefined) {
      order = plain(m[1]);
      subject = "";
      continue;
    }
    if (m[2] !== undefined) {
      subject = plain(m[2]);
      continue;
    }
    const content = plain((m[3].match(/<Content>([\s\S]*?)<\/Content>/) || [])[1] || "");
    const hits = patterns.filter(([, p]) => p.test(content));
    if (!hits.length) continue;
    const speaker = speakerName(plain((m[3].match(/<Affiliation\b[^>]*>([\s\S]*?)<\/Affiliation>/) || [])[1] || ""));
    const context = [order, subject].filter(Boolean).join(": ");
    for (const [n] of hits) addMention(byBill, n, speaker, context);
  }
  return { date, byBill };
}

// Latest Senate sitting with published debates: { sitting, date }.
export async function latestSenateSitting() {
  const html = await fetchText(`https://sencanada.ca/en/in-the-chamber/debates/${SESSION}`);
  const found = [...html.matchAll(new RegExp(`/debates/(\\d{3})db_(\\d{4}-\\d{2}-\\d{2})-e`, "g"))].map((m) => ({
    sitting: Number(m[1]),
    date: m[2],
  }));
  if (!found.length) throw new Error("no sitting link on the Senate debates page");
  return found.sort((a, b) => b.sitting - a.sitting)[0];
}

// Speeches in one Senate sitting that name each bill. Each speech starts with
// the senator's name in bold; procedural text before the first speaker under
// a heading is not counted.
export function senateMentions(html, numbers) {
  const patterns = numbers.map((n) => [n, billPattern(n)]);
  const byBill = new Map();
  let subject = "";
  let speaker = "";
  let turn = 0;
  const counted = new Set();
  for (const m of html.matchAll(/<h2(?:\s[^>]*)?>([\s\S]*?)<\/h2>|<p(?:\s[^>]*)?>([\s\S]*?)<\/p>/g)) {
    if (m[1] !== undefined) {
      subject = plain(m[1]);
      speaker = "";
      continue;
    }
    const lead = m[2].match(/^\s*<b>([^<]+?):\s*<\/b>/);
    if (lead) {
      speaker = plain(lead[1]);
      turn++;
    }
    if (!speaker) continue;
    const text = plain(m[2]);
    for (const [n, p] of patterns) {
      if (!p.test(text) || counted.has(`${n}|${turn}`)) continue;
      counted.add(`${n}|${turn}`);
      addMention(byBill, n, speaker, subject);
    }
  }
  return byBill;
}

// ---------- Bills on the House Notice Paper ----------

// Notices of bills not yet introduced. The Notice Paper's page number changes
// from day to day, so it is found from the latest table of contents.
export async function billsOnNotice() {
  const toc = await fetchText("https://www.ourcommons.ca/DocumentViewer/en/house/latest/order-notice");
  const link = toc.match(/href="(\/documentviewer\/en\/[\d-]+\/house\/sitting-(\d+)\/order-notice\/page-\d+)">Notice Paper</i);
  if (!link) throw new Error("Notice Paper link not found in the table of contents");
  const html = await fetchText(`https://www.ourcommons.ca${link[1]}`);
  const text = decode(html.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ");
  const gov = text.indexOf("Introduction of Government Bills");
  const pmb = text.search(/Introduction of Private Members.{0,2}Bills/);
  const end = text.indexOf("Notices of Motions (Routine Proceedings)", Math.max(gov, pmb));
  if (gov < 0 || pmb < 0) throw new Error("bill sections not found on the Notice Paper");
  const sections = [
    ["Government bill", text.slice(gov, pmb)],
    ["Private member's bill", text.slice(pmb, end > 0 ? end : undefined)],
  ];
  const notices = [];
  for (const [kind, part] of sections) {
    for (const m of part.matchAll(/([A-Z][a-z]+ \d{1,2}, \d{4}) — (.+?) — Bill entitled “\s*(.+?)\s*”/g)) {
      notices.push({ kind, date: isoDate(m[1]), sponsor: m[2].replace(/^The /, "").trim(), title: m[3].trim() });
    }
  }
  return { sitting: Number(link[2]), notices };
}
