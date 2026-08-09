---
name: decision-log
description: Capture a measured fact or a non-obvious decision so it is never rediscovered. Use after measuring something (a ratio, a timing, a count, a limit), after choosing between options for a reason that is not obvious from the code, after a bug whose cause was surprising, or when overriding a spec/default deliberately. Also use to CHECK the log before re-investigating something. Stack-agnostic.
---

# Decision log

The most expensive work on any long-lived project is discovering the same
thing twice.

A codebase records *what* it does. Tests record *that* it works. Neither records
**why this number, why not the obvious alternative, and what we measured to
decide** — so the next person (often the same person, months later) re-runs the
investigation, or worse, "simplifies" the value back to the one that was already
proven wrong.

This skill maintains `docs/DECISIONS.md`: an append-only log of facts that cost
something to learn.

---

## Read it before you investigate

**Before measuring anything, or changing a value that looks arbitrary, search
the log.** An odd-looking constant with an entry is a landmine with a sign on
it; without one, it is just a landmine.

If you are about to override a value that a spec, default or library suggests —
check whether the log already says why the current value differs.

---

## What earns an entry

Add one when:

- **You measured something.** A contrast ratio, a timing, a row count, a size
  limit, a threshold. Record the number AND the method — a ratio measured
  against the wrong background is a different fact.
- **You chose between real options.** Especially when the rejected option is the
  one someone would naturally reach for.
- **A bug's cause was surprising.** If it took more than a few minutes to find,
  the next person will spend the same time unless you write it down.
- **You deliberately deviated** from a spec, a design handoff, a linter, a
  convention, or a library default.
- **Something is intentionally NOT done.** Absent features get "helpfully" added
  by someone who assumes they were forgotten.

Do NOT add an entry for what the code already says plainly, or for a routine
choice with an obvious default. A log full of noise stops being read, and an
unread log is worse than none.

---

## Format

Append to the top of `docs/DECISIONS.md`. One entry, five lines:

```markdown
## <date> — <short claim, stated as the fact>

**Context:** what was being done, in one sentence.
**Measured / found:** the actual numbers or observations, with the method.
**Decision:** what we chose.
**Why not the obvious thing:** the alternative and the reason it loses.
**Invalidated if:** the condition under which this should be revisited.
```

That last line matters most and is the one people skip. A fact with no
expiry condition eventually becomes folklore that nobody dares change.

---

## Example

```markdown
## 2026-08-09 — Table row separators need ~1.48:1, not the design spec's 1.12:1

**Context:** A design handoff specified a lighter hairline colour for table rows.
**Measured / found:** The proposed value composites to 1.12:1 against the panel
background. A previously-shipped value at 1.08:1 was found invisible on tables
250+ rows deep; the fix at that time measured 1.48:1 and worked. Measured live
in-browser against the real painted background, not on paper.
**Decision:** Kept the proven ratio (alpha .23 → 1.487:1), deviating from the
handoff. Documented inline at the token.
**Why not the obvious thing:** Following the handoff verbatim. It never re-ran
the original measurement, and outer structure (header band, drop shadow) does
nothing to separate row 180 from row 181.
**Invalidated if:** The panel background lightens materially, or tables stop
being rendered more than ~50 rows deep.
```

---

## Keep entries honest

- Record what you **measured**, not what you expected. If a number surprised
  you, that is exactly the entry worth having.
- If you did not verify something, say so in the entry rather than implying you
  did. "Assumed, not measured" is a useful and honest note.
- Never edit an old entry to match new reality. **Append a new one that
  supersedes it**, and say which one it replaces. The history of a changed mind
  is itself information.

---

## Wiring it in

Reference the log from the project's `CLAUDE.md` / `AGENTS.md` so it is read at
the start of every session:

```markdown
- **Check `docs/DECISIONS.md` before changing a constant that looks arbitrary,
  or before re-measuring something.** It records what was measured and why the
  obvious alternative loses.
```

Without that line the file exists and nobody opens it.
