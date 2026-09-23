# v4.6.0 / v4.7.0 LEDGER — the tagged record (owner ruling R1, 2026-09-24)

One line per entry, APPEND-ONLY, newest last. Tags: **[LESSON]** a trap and how to avoid it · **[FIX]** a defect fixed
(MUST name the test that goes red on revert) · **[UPGRADE]** a feature shipped · **[RESEARCH]** a report and what it
settled · **[DECISION]** a ruling or a session decision (the WHY lives in `docs/DECISIONS.md`).
Format: `ID | date | tag | what | evidence (sha / test / file)`. Ids: `L-`, `F-`, `U-`, `R-`, `D-` + a number.
Before building anything, grep this file and DECISIONS for the topic — a [LESSON] here is the reason it is not re-learnt.

| ID | Date | Tag | What | Evidence |
|---|---|---|---|---|
| R-1 | 2026-09-24 | [RESEARCH] | Inventory: rows 6/8/9/10/17 in full; 71 analytics modules (lib/analytics; R0 said 74 — corrected by the prose pass), all DESCRIPTIVE by their own headers; Help = 3 TS data files (~1,600 lines, 48 entries); 5,691 ISINs resolved but only 1,379 classified | `research/R0-INVENTORY.md` |
| R-2 | 2026-09-24 | [RESEARCH] | Prescriptive analytics: 18 techniques with formulas + sample guardrails; no competitor publishes a significance method; the Clinic design | `research/R1-PRESCRIPTIVE-ANALYTICS.md` (Bailey/LdP formulas UNVERIFIED — §F) |
| R-3 | 2026-09-24 | [RESEARCH] | Help UX: search-first IA, Radix/shadcn, MiniSearch, cmdk, driver.js; **Shepherd.js is AGPL — never use** | `research/R2-HELP-DESK.md` |
| R-4 | 2026-09-24 | [RESEARCH] | Universe: NSE `getSymbolData` + BSE `ComHeadernew` give the same 4-level taxonomy (28/29 agree); AMFI 5,427 rows; NSE Emerge absent from AMFI; ~98% classifiable | `research/R3-STOCK-UNIVERSE.md` |
| R-5 | 2026-09-24 | [RESEARCH] | Market calendar: CAS effective 2026-08-03 (F&O stocks' continuous session ends 15:15, auction to 15:35, F&O to 15:40, post-close 15:50–16:00); pre-open revised 2026-09-07; 21 hard-coded call sites | `research/R4-MARKET-CALENDAR.md` (only the SEBI circular primary) |
| L-1 | 2026-09-24 | [LESSON] | A calendar fact with no expiry date is a silent defect: CAS went live 2026-08-03 and nothing in the repo knew for 52 days; the holiday list ends 2026-12-31 with no warning. Every dated rule gets `effectiveFrom` + a `coversThrough` DQ warning. | R-5; W1 scan test |
| L-2 | 2026-09-24 | [LESSON] | NSE archives time out and BSE/MCX PDFs return 403 to an agent; BSE `ComHeadernew` answers only Node `fetch` (curl 403). Primary exchange files come from the OWNER's browser download, recorded with sha256. | R-4, R-5 |
| L-3 | 2026-09-24 | [LESSON] | "1,379 stocks" was never a symbol-coverage gap (5,691 ISINs resolve) — it was a CLASSIFICATION gap. Measure what a count counts before scoping a fix. | R-1 Part D |
| D-1 | 2026-09-24 | [DECISION] | Scope + two-release split + every ruling S1–S4, U1–U4, H1–H4, T1, K1–K3, C1–C4, Q18, P1–P2, R1 | `00-SPEC-PLAN.md` §0; DECISIONS 2026-09-24 scope entry |
| D-2 | 2026-09-24 | [DECISION] | Session decisions: no cmdk (extend the existing palette); one new dep `@radix-ui/react-accordion`; weekdays past `coversThrough` = trading days FLAGGED; hubs ship in 4.6.0, Clinic tab in 4.7.0; openalgo facade stays unbuilt | `00-SPEC-PLAN.md` §0 last paragraph |
