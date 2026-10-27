// Writes a draft of the weekly digest, in Markdown, from data/bills.json:
// what moved in the past seven days and what is coming up. Run each Monday by
// .github/workflows/weekly-legislation-digest.yml, which opens the draft as a
// GitHub issue so it arrives by email, ready to edit and paste into Substack.
// Usage: node scripts/weekly-digest.mjs > digest.md
// Node 20+. No dependencies.

import { readFile } from "node:fs/promises";

const TRACKER = "https://riverridgeintelligence.ca/legislation-tracker.html";
const data = JSON.parse(await readFile(new URL("../data/bills.json", import.meta.url), "utf8"));

// Dates are Ottawa calendar days. The week is the seven days before today.
const ottawa = (d) => d.toLocaleDateString("en-CA", { timeZone: "America/Toronto" });
const today = ottawa(new Date());
const shift = (iso, days) => ottawa(new Date(new Date(iso + "T12:00:00Z").getTime() + days * 86400000));
const from = shift(today, -7);
const to = shift(today, -1);
const inWeek = (d) => d && d >= from && d <= to;
const fmt = (iso, withYear = false) =>
  new Date(iso + "T12:00:00Z").toLocaleDateString("en-CA", { month: "short", day: "numeric", ...(withYear ? { year: "numeric" } : {}), timeZone: "UTC" });
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

const bills = data.bills || [];
const name = (b) => `${b.number}${b.shortTitle ? ` (${b.shortTitle})` : ""}`;
const link = (b) => `[${name(b)}](${TRACKER}#${b.number.toLowerCase()})`;
const byNumber = new Map(bills.map((b) => [b.number, b]));

const lines = [`# Digital policy bills: ${fmt(from)} to ${fmt(to, true)}`, ""];
const section = (title, items) => {
  if (!items.length) return;
  lines.push(`## ${title}`, "", ...items.map((t) => `- ${t}`), "");
};

// Stage changes, from the tracker's changelog.
section(
  "Bills that moved",
  (data.changelog || [])
    .filter((c) => inWeek(c.date))
    .map((c) => `${byNumber.has(c.number) ? link(byNumber.get(c.number)) : c.number}: ${c.text}, ${fmt(c.date)}.`)
);

// Committee meetings held, with the organizations heard.
section(
  "In committee",
  bills.flatMap((b) =>
    (b.activity?.meetings || [])
      .filter((m) => inWeek(m.date))
      .map((m) => {
        const w = m.witnesses?.orgs?.length ? ` Heard from ${m.witnesses.orgs.slice(0, 5).join(", ")}${m.witnesses.orgs.length > 5 ? " and others" : ""}.` : "";
        const a = m.amendments?.length ? ` ${plural(m.amendments.length, "amendment", "amendments")} decided, ${m.amendments.filter((x) => x.result === "adopted").length} adopted.` : "";
        return `${link(b)}: ${m.committee} meeting ${m.number} (${m.chamber}), ${fmt(m.date)}.${w}${a}`;
      })
  )
);

// Briefs published to House committees this week.
section(
  "New briefs to committee",
  bills.flatMap((b) => {
    const fresh = (b.studies || []).flatMap((x) => x.briefs.filter((r) => inWeek(r.date)));
    if (!fresh.length) return [];
    const orgs = fresh.filter((r) => !r.individual).map((r) => r.name);
    const people = fresh.length - orgs.length;
    return [`${link(b)}: ${plural(fresh.length, "brief", "briefs")}${orgs.length ? `, including from ${orgs.slice(0, 5).join(", ")}${orgs.length > 5 ? " and others" : ""}` : ""}${people && orgs.length ? `, and ${plural(people, "individual", "individuals")}` : ""}.`];
  })
);

// Things that happened in the House or Senate chamber.
section(
  "In the chamber",
  bills.flatMap((b) =>
    (b.activity?.sittings || []).filter((x) => inWeek(x.date)).map((x) => `${link(b)}: ${x.event}, ${x.chamber}, ${fmt(x.date)}.`)
  )
);

// Recorded decisions.
section(
  "Decisions",
  bills.flatMap((b) =>
    (b.activity?.decisions || [])
      .filter((d) => inWeek(d.date))
      .map((d) => `${link(b)}: ${d.motion}, ${d.result.toLowerCase()}${d.yeas != null && d.nays != null ? ` (${d.yeas} to ${d.nays})` : ""}, ${d.chamber}, ${fmt(d.date)}.`)
  )
);

// Which bills came up most in debate.
const talk = bills
  .map((b) => ({ b, speeches: (b.mentions || []).filter((m) => inWeek(m.date)).reduce((n, m) => n + m.speeches, 0) }))
  .filter((x) => x.speeches)
  .sort((x, y) => y.speeches - x.speeches)
  .slice(0, 5);
section("Most discussed in debate", talk.map(({ b, speeches }) => `${link(b)}: named in ${plural(speeches, "speech", "speeches")}.`));

// Coming up: scheduled meetings in the next two weeks and bills on notice.
const soon = shift(today, 14);
section("Coming up", [
  ...bills.flatMap((b) =>
    (b.activity?.meetings || [])
      .filter((m) => m.date >= today && m.date <= soon)
      .map((m) => `${link(b)}: ${m.committee} meeting ${m.number} scheduled for ${fmt(m.date)}.`)
  ),
  ...(data.upcoming || []).map((u) => `On notice in the House since ${fmt(u.date)}: ${u.title}. ${u.kind} from ${u.sponsor}.`),
]);

if (lines.length <= 2) lines.push("A quiet week: no tracked bill moved, met in committee or came up in debate.", "");

lines.push(
  "---",
  "",
  `Full tracker: ${TRACKER}`,
  "",
  "_Draft generated automatically from LEGISinfo and the House and Senate records. Check it and add your view before publishing._"
);
console.log(lines.join("\n"));
