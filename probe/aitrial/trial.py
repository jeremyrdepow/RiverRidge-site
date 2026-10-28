# AI model trial: stakeholder positions from the organization briefs on Bill C-22.
#
# Each model reads the same 35 briefs (the House public safety committee's
# study of C-22) and returns the organization's stance, its main asks and an
# exact quote that shows the stance. The script then checks every quote
# against the brief text, compares stances across models and totals the cost.
# Runs in GitHub Actions through OpenRouter (one key for every provider):
# set the repository secret OPENROUTER_API_KEY. Results go to probe/aitrial/.
# Python 3 standard library only.

import difflib, html, json, os, re, subprocess, sys, time, urllib.error, urllib.request
from collections import Counter

OUT = "probe/aitrial"
KEY = os.environ.get("OPENROUTER_API_KEY", "").strip()
UA = "RiverRidge-legislation-tracker/1.0 (+https://riverridgeintelligence.ca)"
BRIEFS = "https://www.ourcommons.ca/committees/en/SECU/StudyActivity/GetBriefs?studyActivityId=13454852"

# One strong current model per provider, with OpenRouter's list prices on
# Oct 27, 2026 (USD per million tokens, input and output).
MODELS = [
    ("OpenAI", "openai/gpt-6.1-sol", 2.00, 10.00),
    ("Google", "google/gemini-4-argon", 2.00, 10.00),
    ("Mistral", "mistralai/mistral-large-4-0", 1.36, 4.18),
    ("Cohere", "cohere/command-a-plus", 0.30, 1.50),
    ("Anthropic (reference)", "anthropic/claude-sonnet-5.5", 2.00, 10.00),
]
SPEND_CAP = 5.00          # stop if the running cost passes this (USD)
MAX_CHARS = 60000         # longest brief text sent, about 15,000 tokens
STANCES = ["supports", "supports with amendments", "opposes", "no clear position"]

PROMPT = """You are reading a brief submitted to the House of Commons Standing Committee on Public Safety and National Security about Bill C-22, the Lawful Access Act, 2026. Answer only from the brief. Do not use outside knowledge.

Return one JSON object with exactly these keys:
- "organization": the organization that submitted the brief
- "stance": one of "supports", "supports with amendments", "opposes", "no clear position"
- "main_asks": up to three short phrases, the changes or actions the brief asks for
- "quote": one sentence copied exactly, word for word, from the brief, that best shows the stance (at most 40 words)
- "confidence": "high", "medium" or "low"

Return only the JSON object.

BRIEF:
"""


def get(url, data=None, headers=None, timeout=120):
    req = urllib.request.Request(url, data=data, headers={"User-Agent": UA, **(headers or {})})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read()


def briefs():
    page = get(BRIEFS).decode("utf8")
    out = []
    for item in page.split('class="brief-item')[1:]:
        name = html.unescape(re.sub(r"<[^>]+>", "", (re.search(r'<div class="name">([\s\S]*?)(?:<a|</div>)', item) or [None, ""])[1])).strip()
        url = (re.search(r'href="([^"]+\.pdf)"', item, re.I) or [None, ""])[1]
        individual = bool(re.match(r"^[^,]+, [^,]+$", name)) and not re.search(r"\b(inc|ltd|association|council|society|canada)\b", name, re.I)
        if individual or not url:
            continue  # organizations only
        if url.startswith("//"):
            url = "https:" + url
        open("/tmp/brief.pdf", "wb").write(get(url))
        text = subprocess.run(["pdftotext", "/tmp/brief.pdf", "-"], capture_output=True, text=True).stdout.strip()
        out.append({"name": name, "url": url, "text": text})
        time.sleep(1.5)
    return out


def norm(t):
    t = t.replace("’", "'").replace("‘", "'").replace("“", '"').replace("”", '"')
    t = re.sub(r"[‐-―]", "-", t)
    t = re.sub(r"-\s*\n\s*", "", t)  # words split across lines
    return re.sub(r"\s+", " ", t).strip().lower()


def quote_check(quote, text):
    """'exact' if the quote is in the brief, 'close' if a passage matches 90%+, else 'not found'."""
    q, t = norm(quote or ""), norm(text)
    if len(q) < 15:
        return "not found"
    if q.strip(' ."') in t:
        return "exact"
    sm = difflib.SequenceMatcher(None, t, q, autojunk=False)
    m = sm.find_longest_match(0, len(t), 0, len(q))
    start = max(0, m.a - m.b)
    window = t[start:start + len(q) + 20]
    return "close" if difflib.SequenceMatcher(None, window, q).ratio() >= 0.9 else "not found"


class OutOfCredit(Exception):
    """OpenRouter answered 402: the account has no credit left."""


def ask(model, text):
    body = json.dumps({
        "model": model,
        "messages": [{"role": "user", "content": PROMPT + text[:MAX_CHARS]}],
        "temperature": 0,
        "max_tokens": 1200,
    }).encode()
    headers = {
        "Authorization": f"Bearer {KEY}",
        "Content-Type": "application/json",
        "HTTP-Referer": "https://riverridgeintelligence.ca",
        "X-Title": "RiverRidge bill tracker model trial",
    }
    t0 = time.time()
    # 429 means too many requests in a short time: wait and try again. 402
    # means the credit has run out, which no amount of waiting fixes.
    for attempt in range(4):
        try:
            raw = get("https://openrouter.ai/api/v1/chat/completions", data=body, timeout=240, headers=headers)
            break
        except urllib.error.HTTPError as e:
            if e.code == 402:
                raise OutOfCredit("OpenRouter says the account is out of credit")
            if e.code != 429 or attempt == 3:
                raise
            time.sleep(5 * 3 ** attempt)  # 5s, 15s, 45s
    r = json.loads(raw)
    msg = (r.get("choices") or [{}])[0].get("message") or {}
    # Some models put the answer in "reasoning" and leave "content" empty.
    content = msg.get("content") or msg.get("reasoning") or ""
    return extract(content), r.get("usage", {}), time.time() - t0, content


# Pull the JSON object out of a reply. Models wrap it in prose or code fences,
# and some emit several objects, so take the first complete, balanced one.
def extract(content):
    text = re.sub(r"^\s*```(?:json)?|```\s*$", "", content.strip(), flags=re.M)
    for start in (i for i, ch in enumerate(text) if ch == "{"):
        depth, instr, esc = 0, False, False
        for i in range(start, len(text)):
            ch = text[i]
            if esc:
                esc = False
            elif ch == "\\":
                esc = True
            elif ch == '"':
                instr = not instr
            elif not instr and ch == "{":
                depth += 1
            elif not instr and ch == "}":
                depth -= 1
                if depth == 0:
                    try:
                        got = json.loads(text[start:i + 1])
                    except Exception:
                        break
                    if isinstance(got, dict) and "stance" in got:
                        return got
                    break
    return None


def main():
    os.makedirs(OUT, exist_ok=True)
    global MODELS
    only = os.environ.get("TRIAL_MODELS", "").strip()
    if only:
        MODELS = [m for m in MODELS if any(w.lower() in m[1].lower() for w in only.split(","))]
    limit = int(os.environ.get("TRIAL_BRIEFS", "0") or 0)
    if not KEY:
        open(f"{OUT}/status.txt", "w").write("Waiting for the OPENROUTER_API_KEY repository secret. Nothing was sent to any AI service.\n")
        print("no key; stopping")
        return
    docs = briefs()
    if limit:
        docs = docs[:limit]
    results, spent = [], 0.0
    stopped = False
    for provider, model, pin, pout in MODELS:
        for d in docs:
            rec = {"provider": provider, "model": model, "organization": d["name"], "url": d["url"]}
            if spent > SPEND_CAP:
                rec["error"] = "spend cap reached"
                results.append(rec)
                continue
            try:
                answer, usage, secs, content = ask(model, d["text"])
                cost = usage.get("prompt_tokens", 0) / 1e6 * pin + usage.get("completion_tokens", 0) / 1e6 * pout
                spent += cost
                rec.update({"answer": answer, "seconds": round(secs, 1), "cost": round(cost, 5),
                            "quote_check": quote_check((answer or {}).get("quote", ""), d["text"]) if answer else "no answer"})
                if not answer:
                    rec["raw_reply"] = content[:600]
                    rec["finish_reason"] = usage.get("finish_reason", "")
            except OutOfCredit as e:
                rec["error"] = str(e)
                results.append(rec)
                print(f"STOPPING: {e}. {len(docs) * len(MODELS) - len(results)} requests not made.")
                stopped = True
                break
            except Exception as e:
                rec["error"] = str(e)[:200]
            results.append(rec)
            time.sleep(1.0)
        if stopped:
            break
    json.dump(results, open(f"{OUT}/results.json", "w"), indent=1, ensure_ascii=False)

    # Stance each model gave per organization, and the majority among them.
    grid = {}
    for r in results:
        s = ((r.get("answer") or {}).get("stance") or "").lower().strip()
        grid.setdefault(r["organization"], {})[r["provider"]] = s if s in STANCES else ("(other)" if s else "(none)")
    majority = {org: Counter(v for v in row.values() if v in STANCES).most_common(1)[0][0] if any(v in STANCES for v in row.values()) else "" for org, row in grid.items()}

    errors = Counter(r["error"].split(":")[0] for r in results if r.get("error"))
    lines = ["# Model trial: stances in the organization briefs on C-22", "",
             f"{len(docs)} briefs, {len(MODELS)} models, total cost US${spent:.2f}. Unverified AI output, for comparing models only.", "",
             ("**Run stopped early: the OpenRouter account ran out of credit.**" if stopped else ""),
             (f"Failed requests: {dict(errors)}" if errors else ""), "",
             "| Model | Answers | Quote found exactly | Quote close | Quote not found | Agrees with majority | Cost (US$) | Seconds per brief |",
             "|---|---|---|---|---|---|---|---|"]
    for provider, model, _, _ in MODELS:
        rs = [r for r in results if r["model"] == model]
        ok = [r for r in rs if r.get("answer")]
        qc = Counter(r.get("quote_check") for r in ok)
        agree = sum(1 for r in ok if grid[r["organization"]][provider] == majority[r["organization"]])
        cost = sum(r.get("cost", 0) for r in rs)
        secs = sum(r.get("seconds", 0) for r in ok) / max(1, len(ok))
        lines.append(f"| {provider}: {model} | {len(ok)}/{len(rs)} | {qc['exact']} | {qc['close']} | {qc['not found']} | {agree}/{len(ok)} | {cost:.2f} | {secs:.1f} |")
    lines += ["", "## Stance by organization", "", "| Organization | " + " | ".join(p for p, *_ in MODELS) + " | Split? |",
              "|---|" + "---|" * len(MODELS) + "---|"]
    for org, row in sorted(grid.items()):
        vals = [row.get(p, "") for p, *_ in MODELS]
        split = "yes" if len(set(v for v in vals if v in STANCES)) > 1 else ""
        lines.append(f"| {org} | " + " | ".join(vals) + f" | {split} |")
    open(f"{OUT}/summary.md", "w").write("\n".join(lines) + "\n")
    print("\n".join(lines[:12]))


if __name__ == "__main__":
    main()
