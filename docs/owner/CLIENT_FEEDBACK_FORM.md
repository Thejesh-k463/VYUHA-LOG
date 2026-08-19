# Vyuha client Google Form — what to ask, and why

Purpose: one form, three jobs — (a) capture who the trader is so you can support and price
right, (b) find the two or three defects that matter, (c) collect quotable, consented feedback
for the landing page. Keep it under 6 minutes; ~20 questions; mark only the first block required.
Set the form to *not* collect email automatically — ask for it, and say why. Never ask for
API keys, TOTP secrets, PAN, or account numbers.

## Section 1 — About you (required)
1. Name · 2. Email · 3. WhatsApp number (optional) · 4. City
5. Which best describes you? (single choice) — Intraday · Swing/positional · Options seller ·
   Options buyer · Long-term investor with some trading · Full-time trader · Part-time
6. Brokers you actively use (checkboxes) — Zerodha, Dhan, Groww, Angel One, Upstox, Paytm Money,
   Kotak Neo, Sahi, ICICI Direct, HDFC Sky, Other (text)
7. Approximate trades per month (ranges: <20 · 20–100 · 100–500 · 500+)
8. Segments (checkboxes) — Equity delivery · Intraday · Equity MTF · Index options · Stock
   options · Futures · MCX commodities · Currency

## Section 2 — How you found and use Vyuha
9. How did you hear about Vyuha? (WhatsApp / a creator (name) / X-Twitter / GitHub / friend /
   search / other)
10. Vyuha version you are on (Settings → License, or the sidebar footer) — text
11. Plan (single) - Pro annual · Lifetime 
12. How did you get your trades in? (checkboxes) — Zerodha file · Dhan file · Groww · Angel One ·
    Upstox · Paytm Money · column mapper (which broker?) · Kite API · Dhan API · Angel One API ·
    typed by hand - check and update me on WhatsApp after few days or weeks of Usage if there is a problem.
13. Did the import work first time? (Yes / Needed the column mapper / Wrong numbers / Failed) +
    "If not, what happened?" (paragraph — ask them to attach a **redacted** screenshot, never the file) - check and update me on WhatsApp after few days or weeks of Usage if there is a problem.
14. Do the charges Vyuha computed match your contract note? (Yes within a rupee · Off by a small
    amount · Off by a lot · Didn't check). - check and update me on WhatsApp after few days or weeks of Usage if there is a problem.

## Section 3 — What matters (the ranking that sets the roadmap)
15. Rank the five things you use most (grid or checkboxes, max 5): Dashboard/KPIs · Trades table ·
    Staged positions · Options Seller Journal · Portfolio risk · Tax pack (ITR/AIS/advance tax) ·
    Arjun's Eye / Discipline · Lenses / Edge · Playbooks · Trade calculator · Charges & MTF
    comparison · Backup/restore · Appearance (skins/tint/custom/wallpaper)
16. What is missing that would make you open Vyuha every day? (paragraph)- Optional
17. Which broker would you most like connected next, and how — file, API, or "just Manual work"? (short)
18. Would a Mac or web version matter to you? (No · Nice to have · I can't use it without)

## Section 4 — Price and trust

19. Which matters more to you: data on your own machine, or access from any device? (single)
20. Net Promoter: how likely are you to recommend Vyuha to a trading friend? (0–10)

## Section 5 — Consent and follow-up
21. May we quote your feedback (first name + city, or anonymously) on the landing page? (Yes with
    name · Yes anonymously · No)
22. Happy to do a 10-minute call? (Yes / No) + best time
23. Anything else — bugs, praise, rants. (paragraph)

## Build it in 2 minutes (no clicking through 23 questions)

`docs/owner/forms/client-feedback-form.gs` is an Apps Script that creates this exact form in your
Google Drive: open https://script.google.com, New project, paste the file, Run
`createVyuhaFeedbackForm`, approve the one-time permission, then View > Logs prints the EDIT and
SHARE links plus a RESPONSES SHEET link (the script links a Sheet for you), installs an on-submit
trigger so every submission emails you a digest with running totals (responses / Pro annual /
Lifetime), and `vyuhaSummary` prints those counts on demand. Set `OWNER_EMAIL` at the top first. Re-running makes a second form, so
edit the script and re-run only when the spec changes. Manual alternative: every numbered question
above maps 1:1 to a Forms item type (short answer, paragraph, multiple choice, checkboxes,
linear scale 0-10); the five sections are page breaks.

## Setup notes
- Google Forms → Settings: collect email addresses = *Verified* off (ask instead); limit to 1
  response off (they may fill it again after an update); progress bar on; confirmation message
  = "Thank you — reply lands on WhatsApp within a day. Nothing you typed is shared."
- Link the responses sheet; add a column "Version" and one "Followed up (date)". Review weekly.
- Put the form link in: the post-purchase email, `docs/client/README.md` "Help" line, the Help
  Desk screen copy (owner decision — needs a small code change to add the URL), and the trial-end
  upsell mail.
- What NOT to ask: API keys/secrets, PAN, DP id, screenshots of full contract notes, P&L
  amounts (ask for *ratios or ranges* if you must — SEBI-adjacent and privacy).
