import fs from "node:fs";
import path from "node:path";
import { generateKeyPairSync, sign } from "node:crypto";
import { describe, expect, it } from "vitest";
import { PRESCRIPTIVE_LANGUAGE } from "@/lib/intelligence/insight";
import { PRO_FEATURES, evaluateEntitlement } from "@/lib/license";
import { isoWeekLabel, isoWeekStart } from "@/lib/analytics/week";
import { previousWeekStart } from "@/components/review/week-gap";

/**
 * THE REVIEW DESK'S COPY GUARD — a SOURCE guard, not a runtime one.
 *
 * Owner decision #7: the desk describes, it never prescribes. Nothing in the
 * type system can enforce a voice, so this reads the real files and runs every
 * piece of user-visible text through the SAME regex the insight contract uses
 * (`PRESCRIPTIVE_LANGUAGE` — it bans "must" and "avoid" outright, among
 * others). Importing that regex rather than re-typing it is the point: one
 * definition of the house voice, and narrowing it fails the insight tests too.
 *
 * "User-visible text" is taken to mean both string literals and JSX text, since
 * a sentence typed straight between two tags is copy exactly as much as one in
 * quotes — scanning only quoted strings would leave the larger half unguarded.
 *
 * It also pins the gate in both directions, because the two halves of Pro
 * gating live in different files and nothing else couples them: /review is
 * wrapped in <ProGate> AND advertised in PRO_FEATURES. One without the other is
 * either a Pro screen rendering free, or a user blocked by something the upsell
 * card never mentioned.
 */

const ROOT = path.resolve(__dirname, "..");
const PAGE = path.join(ROOT, "app/review/page.tsx");
const COMPONENTS = path.join(ROOT, "components/review");

function sourceFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (/\.tsx?$/.test(e.name)) out.push(full);
    }
  };
  walk(COMPONENTS);
  out.push(PAGE);
  return out;
}

/**
 * Split a source file into its string literals and its remaining code, with
 * comments dropped.
 *
 * A hand-rolled scanner rather than a regex sweep: a regex cannot tell a `//`
 * inside a string from a comment, and stripping comments first with one would
 * mangle any literal containing a slash. Comments are dropped deliberately —
 * the notes in these files discuss the prescriptive rule by name and are not
 * copy.
 */
function scan(src: string): { strings: string[]; code: string } {
  const strings: string[] = [];
  let code = "";
  let i = 0;
  while (i < src.length) {
    const two = src.slice(i, i + 2);
    if (two === "//") {
      while (i < src.length && src[i] !== "\n") i++;
      continue;
    }
    if (two === "/*") {
      i += 2;
      while (i < src.length && src.slice(i, i + 2) !== "*/") i++;
      i += 2;
      continue;
    }
    const c = src[i];
    if (c === '"' || c === "'" || c === "`") {
      i++;
      let buf = "";
      while (i < src.length) {
        if (src[i] === "\\") {
          buf += src[i + 1] ?? "";
          i += 2;
          continue;
        }
        if (src[i] === c) {
          i++;
          break;
        }
        buf += src[i++];
      }
      strings.push(buf);
      code += " "; // keep tag structure intact for the JSX-text pass
      continue;
    }
    code += c;
    i++;
  }
  return { strings, code };
}

/** Text sitting between two tags — copy that never went through a quote. */
function jsxText(code: string): string[] {
  const out: string[] = [];
  for (const m of code.matchAll(/>([^<>{}]+)</g)) {
    const t = m[1].replace(/\s+/g, " ").trim();
    if (/[A-Za-z]/.test(t)) out.push(t);
  }
  return out;
}

interface Fragment {
  file: string;
  text: string;
}

function fragments(): Fragment[] {
  const out: Fragment[] = [];
  for (const file of sourceFiles()) {
    const rel = path.relative(ROOT, file).replace(/\\/g, "/");
    const { strings, code } = scan(fs.readFileSync(file, "utf8"));
    for (const s of [...strings, ...jsxText(code)]) out.push({ file: rel, text: s });
  }
  return out;
}

describe("the review desk describes, it never prescribes", () => {
  const frags = fragments();

  it("scans real text — the guard is not passing vacuously", () => {
    // If a refactor breaks the scanner, the set-difference test below would go
    // green against nothing at all. These floors are the tripwire.
    expect(sourceFiles().length).toBeGreaterThanOrEqual(5);
    expect(frags.length).toBeGreaterThan(80);
    expect(frags.some((f) => f.text.includes("Process Score"))).toBe(true);
    expect(frags.some((f) => f.file === "app/review/page.tsx")).toBe(true);
  });

  it("no string literal or JSX text in the desk is prescriptive", () => {
    const offenders = frags
      .filter((f) => PRESCRIPTIVE_LANGUAGE.test(f.text))
      .map((f) => `${f.file}: ${f.text.slice(0, 90)}`);
    expect(offenders, `prescriptive copy on the review desk:\n${offenders.join("\n")}`).toEqual([]);
  });

  it("reports the expectancy GAP and never a counterfactual", () => {
    // Invariant 6's third clause. "would have" / "if you had" is the shape the
    // mistake economics were built to refuse; the desk inherits that refusal.
    const counterfactual = /would have (?:made|earned|kept|been)|if you had|had you (?:not|avoided)/i;
    const offenders = frags.filter((f) => counterfactual.test(f.text)).map((f) => `${f.file}: ${f.text}`);
    expect(offenders, `counterfactual P&L on the review desk:\n${offenders.join("\n")}`).toEqual([]);
    // …and the gap language it uses instead is actually there.
    expect(frags.some((f) => /expectancy gap/i.test(f.text))).toBe(true);
  });

  it("the imported regex still catches the shapes it exists to catch", () => {
    // Guards the guard: narrowing PRESCRIPTIVE_LANGUAGE would silently disarm
    // every assertion above, so the bans are pinned here directly.
    for (const s of [
      "you must review these trades",
      "avoid revenge trades next week",
      "you should size down",
      "you'll need to add a stop",
      "we recommend closing early",
    ]) {
      expect(PRESCRIPTIVE_LANGUAGE.test(s), s).toBe(true);
    }
    for (const s of [
      "Traders historically work the queue oldest-first",
      "The gap is measured against the untagged closed trades in the same week",
      "4 closed trades this week; the score needs 10",
    ]) {
      expect(PRESCRIPTIVE_LANGUAGE.test(s), s).toBe(false);
    }
  });
});

describe("/review is gated in BOTH places", () => {
  it("the page body is wrapped in <ProGate>", () => {
    expect(fs.readFileSync(PAGE, "utf8")).toContain("<ProGate>");
  });

  it("and the desk is advertised in PRO_FEATURES", () => {
    const entry = PRO_FEATURES.find((f) => f.href === "/review");
    expect(entry, "/review is gated but not advertised on the upsell card").toBeTruthy();
    expect(entry?.partial, "/review is a whole Pro page, not a partial capability").toBeUndefined();
    expect(entry!.label.length).toBeGreaterThan(5);
  });

  it("the CORE JOURNAL is not dragged in with it", () => {
    // Invariant 7. The desk reads the journal; gating the journal itself would
    // hold a trader's own record hostage, and /trades is where that record is.
    expect(PRO_FEATURES.some((f) => f.href === "/trades")).toBe(false);
    expect(fs.readFileSync(path.join(ROOT, "app/trades/page.tsx"), "utf8")).not.toContain("<ProGate>");
  });
});

// ── The desk's SURFACES ─────────────────────────────────────────────────────
//
// Four defects from the v3.7.0 adversarial audit, all of them invisible to the
// query layer and to the e2e suite. Each is pinned against the real file,
// because every one of them lives in a client component or a server component
// that vitest's node environment cannot render.

const src = (rel: string) => fs.readFileSync(path.join(ROOT, rel), "utf8");

describe("a weekly note cannot survive an account switch", () => {
  const panel = src("components/review/sunday-ritual-panel.tsx");

  it("the textarea is DERIVED from the draft's owner, never seeded once", () => {
    // `useState(note)` seeded the box at mount. The account switcher ends in
    // router.refresh() — a soft refresh that keeps this instance alive — so one
    // book's prose stayed on screen beside another book's figures and "Save
    // note" filed it against the wrong account.
    expect(panel, "the draft is seeded from the note prop again").not.toMatch(/useState\(note\)/);
    expect(panel).toMatch(/noteDraftText\(draft, owner, note\)/);
    expect(panel).toMatch(/value=\{text\}/);
    // …and what is POSTed is the derived text, not a stale state variable.
    expect(panel).toMatch(/note: text,/);
  });

  it("the owner is the account AND the week, both supplied by the page", () => {
    expect(panel).toMatch(/noteOwner\(accountId, weekStart\)/);
    const page = src("app/review/page.tsx");
    expect(page).toMatch(/accountId=\{accountId\}/);
    expect(page).toMatch(/getSelectedAccountId\(\)/);
  });

  it("is not fixed with a state-sync effect, which is what AGENTS.md bans", () => {
    expect(panel, "a useEffect is back in the ritual panel").not.toMatch(/useEffect/);
  });

  it("stranded prose is stated, not silently binned", () => {
    // The blunt fix (a `key` on the panel) trades a wrong-book write for a
    // silent loss of what the user typed. Both are defects.
    expect(panel).toMatch(/carriedOverDraft\(draft, owner\)/);
    expect(panel).toMatch(/data-testid="ritual-carried-note"/);
  });
});

describe("the dashboard card and the desk agree about which week it is", () => {
  const card = src("components/review/review-open-card.tsx");
  const page = src("app/review/page.tsx");

  it("both read today in the SAME zone", () => {
    // The third UTC-vs-local defect of this release. `toISOString()` on the
    // card and Asia/Kolkata on the desk disagree every Monday between 00:00
    // and 05:30 IST.
    // v3.8 (WS8): both now read the ONE IST helper — the inline expression
    // this guard used to look for lives in lib/domain/trading-day.ts alone
    // (tests/today-clock.test.ts pins that there is exactly one definition).
    const ist = 'todayIstIso } from "@/lib/domain/trading-day"';
    expect(page).toContain(ist);
    expect(card).toContain(ist);
    expect(card, "the card is back on UTC").not.toMatch(/toISOString\(\)\.slice\(0, 10\)/);
    expect(page, "the desk is back on UTC").not.toMatch(/toISOString\(\)\.slice\(0, 10\)/);
  });

  it("and the two zones really do name different weeks at that hour", () => {
    // 2026-08-30T20:30:00Z is 02:00 IST on Monday 2026-08-31. The guard above
    // is only worth having because this is true.
    const at = new Date("2026-08-30T20:30:00Z");
    const utcDay = at.toISOString().slice(0, 10);
    const istDay = at.toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
    expect(utcDay).toBe("2026-08-30");
    expect(istDay).toBe("2026-08-31");
    const ritual = (day: string) => isoWeekLabel(previousWeekStart(isoWeekStart(day)));
    expect(ritual(utcDay)).toBe("2026-W34");
    expect(ritual(istDay)).toBe("2026-W35");
    expect(ritual(utcDay)).not.toBe(ritual(istDay));
  });
});

describe("the card gates on the CAPABILITY, not on a list of state names", () => {
  const card = src("components/review/review-open-card.tsx");

  it("reads ent.pro and enumerates no states", () => {
    expect(card).toMatch(/if \(!ent\.pro\) return null;/);
    // The scanner drops comments, so the prose ABOVE the gate may name the
    // states it stopped comparing against; only a real literal reddens this.
    const literals = scan(card).strings;
    for (const state of ["licensed", "trial", "expired-key", "unlicensed"]) {
      expect(literals, `the card is comparing against "${state}" again`).not.toContain(state);
    }
  });

  it("because an entitlement exists where the two answers disagree", () => {
    // An expired ANNUAL key with trial days left: ProGate serves the desk
    // (it reads `pro`), so a card enumerating states hid the pointer to a
    // screen that works. Minted here rather than asserted from memory.
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    const pem = publicKey.export({ type: "spki", format: "pem" }).toString();
    const payload = Buffer.from(
      JSON.stringify({ email: "annual@x.com", sku: "app", issued: "2026-01-01", expires: "2026-06-30" }),
      "utf8",
    );
    const key = `VYUHA-${payload.toString("base64url")}.${sign(null, payload, privateKey).toString("base64url")}`;
    const ent = evaluateEntitlement(key, "2026-07-01T00:00:00.000Z", new Date("2026-07-05T12:00:00"), pem);
    expect(ent.state).toBe("expired-key");
    expect(ent.pro).toBe(true);
    // The reverted predicate, spelled out: it hides a card the gate would show.
    expect(ent.state !== "licensed" && ent.state !== "trial").toBe(true);
  });
});

describe("the queue is honest about what it refuses and what it holds back", () => {
  const queue = src("components/review/review-queue-panel.tsx");
  const page = src("app/review/page.tsx");

  it("every write path on the row follows the All-accounts notice", () => {
    // Saving the journal stamps `reviewed_at`, so the row vanishes from the
    // queue — a write, and it was the one button not gated while the panel
    // printed "The All-accounts view reads only".
    // Comments and string literals are stripped first: the panel's own header
    // discusses "Mark reviewed" in prose, which is not a button.
    const code = scan(queue).code;
    for (const label of ["Open journal", "Mark reviewed", "Reopen"]) {
      const at = code.indexOf(label);
      expect(at, `${label} is gone from the queue panel`).toBeGreaterThan(0);
      const button = code.slice(Math.max(0, at - 420), at);
      expect(button, `"${label}" is live in the All-accounts view`).toMatch(/aggregateView/);
    }
  });

  it("the reviewed list STATES its cap instead of printing a slice as a total", () => {
    expect(page).toMatch(/REVIEWED_LIMIT/);
    expect(page).toMatch(/reviewedTotal=\{reviewedAll\.length\}/);
    // The header used to read "Recently reviewed (20)" over a book of 300.
    expect(queue).not.toMatch(/Recently reviewed \(\{reviewed\.length\}\)/);
    expect(queue).toMatch(/\{reviewed\.length\} of \{reviewedTotal\}/);
    expect(queue).toMatch(/data-testid="reviewed-window"/);
  });
});
