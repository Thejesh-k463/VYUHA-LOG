import { describe, expect, it } from "vitest";
import {
  DIGEST_FOOTER,
  TELEGRAM_MESSAGE_CAP,
  chunkMessage,
  escapeHtml,
  formatEodDigest,
  inrDigest,
  type EodDigestInput,
} from "@/lib/telegram/format";
import { TELEGRAM_DISCLOSURE } from "@/lib/domain/telegram-disclosure";

/**
 * The digest is the ONLY Vyuha output that leaves the machine, so its shape is
 * pinned hard: escaping (a real F&O symbol carries "&"), the 4,096 cap with a
 * STATED truncation, the invariant-6 omission of any % whose denominator is
 * unknown, and the footer as the literal last line of every message.
 */

const base: EodDigestInput = {
  date: "2026-09-02",
  accountLabel: "Primary",
  openPositions: [
    { symbol: "M&M-FUT", side: "short", qty: 50 },
    { symbol: "TCS", side: "long", qty: 10 },
    { symbol: "INFY", side: "long", qty: 5 },
  ],
  openRiskRupees: 12500,
  openRiskUnknownCount: 1,
  capitalTotal: 500000,
  capitalDeployed: 456789.5,
  realisedToday: -1234.56,
  realisedWeek: 8000,
  realisedMonth: 15000.25,
  closedToday: 3,
  journalPendingCount: 4,
};

describe("escapeHtml", () => {
  it("escapes exactly & < > (Telegram HTML parse mode), ampersand first", () => {
    expect(escapeHtml(`M&M <FUT> "x" & 1<2>3`)).toBe(`M&amp;M &lt;FUT&gt; "x" &amp; 1&lt;2&gt;3`);
  });
  it("does not double-escape an already-escaped ampersand's output", () => {
    // & → &amp; ; running the OUTPUT through again would give &amp;amp; — the
    // function is single-pass by contract, callers escape raw text once.
    expect(escapeHtml("&")).toBe("&amp;");
  });
});

describe("formatEodDigest", () => {
  it("escapes the M&M-FUT symbol and never emits a raw < > & from data", () => {
    const msg = formatEodDigest(base);
    expect(msg).toContain("M&amp;M-FUT short ×50");
    expect(msg).not.toContain("M&M-FUT");
    // The only raw < > allowed are the <b> tags this module itself writes.
    expect(msg.replace(/<\/?b>/g, "")).not.toMatch(/[<>]/);
  });

  it("counts sides and shows risk with % of capital when capital is known", () => {
    const msg = formatEodDigest(base);
    expect(msg).toContain("Open positions: 3 (2 long / 1 short)");
    expect(msg).toContain("Open risk: ₹12,500 (2.5% of capital)");
    expect(msg).toContain("1 position without a recorded risk");
    expect(msg).toContain("Capital deployed: ₹4,56,789.50");
    expect(msg).toContain("today −₹1,234.56 · 7 days ₹8,000 · month ₹15,000.25");
    expect(msg).toContain("Plan: 3 closed today · 4 closed this week awaiting journal notes");
  });

  it("OMITS the % line when capital is unknown — never renders 0% (invariant 6)", () => {
    const msg = formatEodDigest({ ...base, capitalTotal: null });
    expect(msg).toContain("Open risk: ₹12,500");
    expect(msg).not.toContain("% of capital");
    expect(msg).not.toContain("0.0%");
    const zeroCap = formatEodDigest({ ...base, capitalTotal: 0 });
    expect(zeroCap).not.toContain("% of capital");
  });

  it("says risk is unrecorded rather than inventing ₹0 when no position has one", () => {
    const msg = formatEodDigest({ ...base, openRiskRupees: null, openRiskUnknownCount: 3 });
    expect(msg).toContain("Open risk: not recorded on any open position");
    expect(msg).not.toContain("Open risk: ₹0");
  });

  it("pins the footer verbatim as the last line, matching the disclosure const", () => {
    const msg = formatEodDigest(base);
    const lines = msg.split("\n");
    expect(lines[lines.length - 1]).toBe("Your own recorded data. Not investment advice.");
    expect(DIGEST_FOOTER).toBe(TELEGRAM_DISCLOSURE.footer); // one string, two homes, pinned together
  });

  it("stays under the 4,096 cap by truncating the positions list with a stated +N more", () => {
    const many: EodDigestInput = {
      ...base,
      openPositions: Array.from({ length: 500 }, (_, i) => ({
        symbol: `SYMBOL-${String(i).padStart(3, "0")}-EQ`,
        side: (i % 2 ? "long" : "short") as "long" | "short",
        qty: i + 1,
      })),
    };
    const msg = formatEodDigest(many);
    expect(msg.length).toBeLessThanOrEqual(TELEGRAM_MESSAGE_CAP);
    const m = msg.match(/… \+(\d+) more/);
    expect(m, "truncation must be STATED").toBeTruthy();
    const shown = (msg.match(/^• /gm) ?? []).length;
    expect(shown + Number(m![1])).toBe(500); // nothing silently dropped
    // The totals and footer survive truncation — the list is the only elastic part.
    expect(msg).toContain("Open positions: 500");
    expect(msg.endsWith(DIGEST_FOOTER)).toBe(true);
  });

  it("red-on-revert: without the cap logic a 500-position digest would overflow", () => {
    // Prove the cap actually binds for the fixture above — if formatEodDigest
    // stopped truncating, the previous test's length assertion is what reddens.
    const full = formatEodDigest(
      { ...base, openPositions: Array.from({ length: 500 }, (_, i) => ({ symbol: `SYMBOL-${i}-EQ`, side: "long" as const, qty: 1 })) },
      Number.MAX_SAFE_INTEGER,
    );
    expect(full.length).toBeGreaterThan(TELEGRAM_MESSAGE_CAP);
  });
});

describe("inrDigest", () => {
  it("uses Indian grouping and drops .00 on whole rupees", () => {
    expect(inrDigest(456789.5)).toBe("₹4,56,789.50");
    expect(inrDigest(8000)).toBe("₹8,000");
    expect(inrDigest(-1234.56)).toBe("−₹1,234.56");
  });
});

describe("chunkMessage", () => {
  it("returns one chunk when under the cap and splits on line boundaries over it", () => {
    expect(chunkMessage("short")).toEqual(["short"]);
    const lines = Array.from({ length: 100 }, (_, i) => `line-${i}-${"x".repeat(90)}`);
    const chunks = chunkMessage(lines.join("\n"), 1000);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(1000);
    expect(chunks.join("\n")).toBe(lines.join("\n")); // lossless
  });
});
