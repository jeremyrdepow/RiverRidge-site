// Reads each organization's brief to a House committee and records where it
// stands on the bill. Two models read every brief independently through
// OpenRouter. A position is published only when both agree on the stance and
// the quote they give is found word for word in the brief. Anything else is
// held back for Jeremy to read.
//
// Chosen from the trial of five models on the 35 organization briefs on C-22
// (probe/aitrial, Oct 28 2026): both of these quoted the briefs accurately,
// and together they cost about a third of the alternatives.
//
// Needs the OPENROUTER_API_KEY secret and the pdftotext command. Without the
// key the whole step is skipped, so the tracker still builds.

import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

export const MODELS = [
  { name: "Cohere", id: "cohere/command-a-plus", in: 0.30, out: 1.50 },
  { name: "Google", id: "google/gemini-4-argon", in: 2.00, out: 10.00 },
];

const STANCES = ["supports", "supports with amendments", "opposes", "no clear position"];
const MAX_CHARS = 60000; // about 15,000 tokens, which covers all but the longest briefs

const PROMPT = (number) => `You are reading a brief submitted to a committee of the Canadian House of Commons about Bill ${number}. Answer only from the brief. Do not use outside knowledge.

Return one JSON object with exactly these keys:
- "organization": the organization that submitted the brief
- "stance": one of "supports", "supports with amendments", "opposes", "no clear position"
- "main_asks": up to three short phrases, the changes or actions the brief asks for
- "quote": one sentence copied exactly, word for word, from the brief, that best shows the stance (at most 40 words). Copy it in the language the brief is written in. Do not translate it.
- "confidence": "high", "medium" or "low"

Return only the JSON object.

BRIEF:
`;

export class OutOfCredit extends Error {}

// ---------- Reading the brief ----------

// A brief's text, from its PDF. Returns "" when the file cannot be read.
export async function briefText(url) {
  const dir = await mkdtemp(join(tmpdir(), "brief-"));
  try {
    const res = await fetch(url, { headers: { "User-Agent": "RiverRidge-legislation-tracker/1.0 (+https://riverridgeintelligence.ca)" } });
    if (!res.ok) return "";
    const pdf = join(dir, "brief.pdf");
    await writeFile(pdf, Buffer.from(await res.arrayBuffer()));
    const { stdout } = await run("pdftotext", [pdf, "-"], { maxBuffer: 32 * 1024 * 1024 });
    return stdout.trim();
  } catch {
    return "";
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

// ---------- Asking a model ----------

// The first complete, balanced JSON object in a reply that carries a stance.
// Models wrap the object in prose or code fences and sometimes emit more than
// one, so a plain first-brace-to-last-brace match is not enough.
export function extractJson(content) {
  const text = String(content || "").replace(/^\s*```(?:json)?|```\s*$/gm, "").trim();
  for (let start = text.indexOf("{"); start >= 0; start = text.indexOf("{", start + 1)) {
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let i = start; i < text.length; i++) {
      const ch = text[i];
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = !inString;
      else if (!inString && ch === "{") depth++;
      else if (!inString && ch === "}" && --depth === 0) {
        try {
          const got = JSON.parse(text.slice(start, i + 1));
          if (got && typeof got === "object" && got.stance) return got;
        } catch {}
        break;
      }
    }
  }
  return null;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// One model's reading of one brief. Retries when asked to slow down; a 402
// means the account is out of credit, which waiting cannot fix.
export async function askModel(model, number, text, key) {
  const body = JSON.stringify({
    model: model.id,
    messages: [{ role: "user", content: PROMPT(number) + text.slice(0, MAX_CHARS) }],
    temperature: 0,
    // Both models think before answering; too low a ceiling cuts them off
    // part way and the reply never reaches the JSON.
    max_tokens: 4000,
  });
  let res;
  for (let attempt = 0; attempt < 4; attempt++) {
    res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
        "HTTP-Referer": "https://riverridgeintelligence.ca",
        "X-Title": "RiverRidge bill tracker",
      },
      body,
    });
    if (res.status === 402) throw new OutOfCredit("OpenRouter says the account is out of credit");
    if (res.status !== 429) break;
    if (attempt === 3) throw new Error("HTTP 429 after four attempts");
    await sleep(5000 * 3 ** attempt);
  }
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const r = await res.json();
  const msg = r.choices?.[0]?.message || {};
  const usage = r.usage || {};
  return {
    answer: extractJson(msg.content || msg.reasoning || ""),
    cost: (usage.prompt_tokens || 0) / 1e6 * model.in + (usage.completion_tokens || 0) / 1e6 * model.out,
  };
}

// ---------- Checking a quote against the brief ----------

const normalise = (t) =>
  String(t || "")
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[‐-―]/g, "-")
    .replace(/-\s*\n\s*/g, "") // words split across a line break
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();

// "exact" when the quote appears in the brief, "close" when all but a few of
// its words appear in one passage, "not found" otherwise. A quote the model
// translated reads as not found, which is the result we want.
export function quoteCheck(quote, text) {
  const q = normalise(quote);
  const t = normalise(text);
  if (q.length < 15) return "not found";
  if (t.includes(q.replace(/^["']|["'.]+$/g, ""))) return "exact";
  const words = q.split(" ").filter((w) => w.length > 3);
  if (!words.length) return "not found";
  const hits = words.filter((w) => t.includes(w)).length;
  return hits / words.length >= 0.9 ? "close" : "not found";
}

// ---------- One brief, both models ----------

// Both models read the brief. The position is "agreed" only when they give
// the same stance and both quotes are found in the text. Everything else is
// marked for review, with each model's reading kept so the split is visible.
export async function positionFor({ number, name, url }, key) {
  const text = await briefText(url);
  if (!text || text.length < 200) return { name, url, status: "unreadable", cost: 0 };

  const readings = [];
  let cost = 0;
  for (const model of MODELS) {
    try {
      const { answer, cost: c } = await askModel(model, number, text, key);
      cost += c;
      if (answer) {
        readings.push({
          model: model.name,
          stance: STANCES.includes(String(answer.stance || "").toLowerCase().trim()) ? String(answer.stance).toLowerCase().trim() : "",
          asks: (Array.isArray(answer.main_asks) ? answer.main_asks : []).slice(0, 3).map((a) => String(a).slice(0, 120)),
          quote: String(answer.quote || "").slice(0, 400),
          quoteOk: quoteCheck(answer.quote, text),
        });
      }
    } catch (err) {
      if (err instanceof OutOfCredit) throw err;
      console.error(`position ${number} ${name} (${model.name}): ${err.message}`);
    }
    await sleep(1000);
  }

  if (readings.length < MODELS.length) return { name, url, status: "incomplete", readings, cost };
  const [a, b] = readings;
  const sameStance = a.stance && a.stance === b.stance;
  const quotesOk = a.quoteOk === "exact" && b.quoteOk === "exact";
  if (sameStance && quotesOk) {
    // Prefer the quote that reads as a fuller sentence.
    const best = b.quote.length > a.quote.length ? b : a;
    return {
      name, url, status: "agreed", stance: a.stance, quote: best.quote,
      asks: [...new Set([...a.asks, ...b.asks])].slice(0, 3), readings, cost,
    };
  }
  return { name, url, status: sameStance ? "quote-unverified" : "split", stance: sameStance ? a.stance : "", readings, cost };
}
