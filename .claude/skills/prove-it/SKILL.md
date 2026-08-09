---
name: prove-it
description: Verification discipline for before you claim a change is done. Use when finishing any task, before reporting success, before committing, before a release, or whenever you are about to say something "works", "passes" or "is fixed". Turns a green check into actual evidence, and hunts the specific traps where a check passes while the thing is broken. Stack-agnostic.
---

# Prove it

A passing check is not evidence. It is evidence that *the check* passed.

Almost every defect that survives to the user is one where something *did* pass:
the test suite was green while the feature was invisible; the build succeeded
while shipping last week's bundle; a bounding-rect measurement reported clearance
while the text visibly overflowed. The check was answering a question nobody had
asked.

This skill is the discipline that closes that gap. Work through it before you
report a task as done.

---

## 1. Name the observable first

Before verifying anything, answer in one sentence: **what would the user
actually see, receive, or be able to do that they could not before?**

Write it down. That sentence is what you must verify. Not "the function
returns the right value" — *"the trade appears in the journal with the right
broker and charges"*.

If you cannot state the observable, you do not yet know what you built, and
nothing you verify will mean anything.

---

## 2. Verify the artifact, not the log

A log line is a claim made by the process about itself. The artifact is the
thing that ships.

| Don't accept | Do check |
|---|---|
| `✓ signed` | Decode the signature and compare the key id to the expected one |
| `Build succeeded` | Open the built output; confirm a marker of the NEWEST change is inside it |
| `Deployed` | Fetch the deployed URL and assert on the response |
| `Migration applied` | Query the schema/table and see the change |
| `Tests passed` | Confirm the tests actually execute the new code path |
| `Copied N files` | Stat the destination |

The rule: **if a step claims it did something, look at what it produced.**

Two specific traps worth naming, because both have shipped real breakage:

- **Stale artifact.** A build that "succeeds" without rebuilding leaves the
  previous output in place. Always check freshness (modification time) AND
  content (grep the output for a string only the newest change introduces).
- **Right-looking, wrong-source.** Something signed/derived with the wrong key,
  the wrong config, or the wrong input file will report success at every step
  and fail only on the user's machine. Compare identifiers, not adjectives.

---

## 3. If it is visual, look at it

Computed values verify what you thought to check. Looking verifies what you
did not.

Capture the rendered result — screenshot, exported file, generated image, PDF —
and actually inspect it. Then compare against the source of truth if one exists
(pixel-diff a generated asset against its master; a near-zero difference is
proof, "looks right" is not).

**Capture at the right fidelity.** A screenshot taken at 1× on a HiDPI display
throws away half the pixels and makes crisp text look broken — you will
"discover" a bug that does not exist, or miss one that does. Match the device
pixel ratio.

Three classes of bug that ONLY looking has ever caught:

- **Overflow that measurement misses.** A shrunk box with non-wrapping content
  paints outside its own rectangle. `getBoundingClientRect` returns the *box*,
  not the ink. Measure the rendered text range, or look.
- **A mode you did not switch into.** Light/dark, RTL, empty state, long value,
  small window. Hard-coded values that suit one mode vanish in the other, and
  every automated check still passes.
- **Layout that is valid but wrong.** Overlap, clipping, a control pushed off
  screen. All perfectly legal CSS.

---

## 4. Read the exit code from the command that matters

`cmd | tail` reports the exit status of `tail`. Piping, `&&` chains and
subshells all hide failures.

Run the thing, capture its status immediately, then inspect the output
separately:

```
run-the-command > out.log 2>&1; echo "EXIT=$?"; tail out.log
```

Never infer success from the last lines of output looking healthy.

---

## 5. Hunt the silent-success traps

These are the failure modes that produce no error. Ask each one explicitly:

- **Does a fallback ever fire?** A default that is always set means the fallback
  branch is dead. (A registered CSS property with an initial value; a config
  default that masks a missing key; `??` on a value that is never nullish.)
- **Does a catch swallow the failure?** An empty `catch` turns a broken feature
  into a quiet no-op. If a handler throws before it sets state, the whole
  feature dies and looks exactly like a feature that was never invoked.
- **Is a bad input coerced instead of refused?** Reading a non-number as `0`
  invents data. When the input's meaning is not guaranteed, refuse and report,
  do not coerce. A wrong number that looks right is far worse than a rejection.
- **Is the identifier generic enough to match the wrong thing?** A detector
  that keys on *shape* rather than *identity* will claim inputs it should not.
  Require evidence of identity before claiming ownership.
- **Does the check assert presence only?** Also assert the negative: that the
  wrong thing does NOT happen, that the other case is unaffected, that nothing
  else moved.

---

## 6. Prove the negative

Most verification only shows the new thing works. Also show that nothing else
changed:

- Run the FULL suite, not just the new tests, and compare the count to the
  previous run. A number that went down silently is a deleted test.
- For a shared component or utility, check a second, untouched consumer.
- For a change with a "before" behaviour, verify the before-case still behaves.

---

## 7. Report evidence, not adjectives

When you report, give the numbers you actually observed:

> Bad: "Verified, everything works."
> Good: "1295 tests / 95 files pass (was 1242), build clean, 20/20 e2e.
> Signature key id `4FF8…A21D` matches the configured pubkey. Contrast measured
> 4.95:1 against the real background."

If you could not verify something, say so plainly and say why. An unverified
claim reported as verified is worse than an admitted gap — the gap can be
closed, the false claim gets built on.

---

## 8. When a check contradicts your eyes

Trust neither automatically — find which one is answering the wrong question.
Usually the check is measuring a proxy (a box instead of the ink, a log instead
of the artifact, a mock instead of the real path). Identify the proxy, then
measure the real thing.

Whichever way it resolves, that is a fact worth recording — see the
`decision-log` skill.
