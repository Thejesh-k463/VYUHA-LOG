# Decisions

Append-only. Newest first.

Facts that cost something to learn: measured numbers, choices where the obvious
option loses, surprising bug causes, deliberate deviations from a spec or
default, and things intentionally NOT done.

**Read this before changing a constant that looks arbitrary, or before
re-measuring something.** An odd value with an entry here is a landmine with a
sign on it.

Never edit an old entry to match new reality — append a new one that supersedes
it and say which. A changed mind is itself information.

Format:

```markdown
## <date> — <short claim, stated as the fact>

**Context:** what was being done, in one sentence.
**Measured / found:** the actual numbers or observations, with the method.
**Decision:** what we chose.
**Why not the obvious thing:** the alternative and why it loses.
**Invalidated if:** the condition under which to revisit this.
```

---

## 2026-08-09 — The desktop build ran every step twice

**Context:** Investigating why `npm run desktop:build` took so long.
**Measured / found:** The log showed two "Creating an optimized production
build" and two "assembling desktop-dist". `desktop:build` ran `next build &&
build-desktop.mjs` and then invoked Tauri, whose `beforeBuildCommand` is
`npm run build && npm run desktop:bundle` — the same two steps. Cost per
duplicate pass: a Next compile, a typecheck (19.3s + 13.2s across the two), a
template-DB seed, and a copy of an 81 MB node.exe into a 168 MB tree.
**Decision:** `desktop:build` is now just `node scripts/tauri-build.mjs`.
Measured after the change: 292s wall, 1 Next pass, 1 assembly pass.
**Why not the obvious thing:** Removing `beforeBuildCommand` instead would
break CI — tauri-action reads it from the config and silently ignores one
passed as a workflow input. The AGENTS.md "always rebuilds the bundle" rule
still holds; it just happens once, where Tauri asks for it.
**Invalidated if:** `beforeBuildCommand` is removed from tauri.conf.json, or
`tauri-build.mjs` ever starts depending on desktop-dist existing beforehand.

## 2026-08-09 — Light-theme gold is #8f6207, not the handoff's #9a6b08

**Context:** Applying the v3 design tokens to light mode.
**Measured / found:** The handoff proposed ~#9a6b08. Against this app's real
light canvas #f4f6f9 that measures **4.33:1 — under the 4.5:1 AA floor**. It
only clears AA against pure white (4.69:1), and gold is small text here (charge
lines, MTF splits, warnings). #8f6207 holds the hue at 4.95:1. The ceiling at
this hue/saturation is ~#966808 (4.53:1), which is why the light ramp's bright
end is pinned there rather than at the dark theme's #f5d478.
**Decision:** Ship #8f6207; violet #6d28d9 verified at 6.56:1 and kept as-is.
**Why not the obvious thing:** Following the handoff verbatim. It gave hues
with no measured ratios, unlike the #0b7a70 precedent it was citing.
**Invalidated if:** The light canvas changes from #f4f6f9, or gold stops being
used for small text.

## 2026-08-09 — Table row separators need ~1.48:1, not the handoff's 1.12:1

**Context:** Applying the v3 token sheet, which specifies
`--color-rule: rgba(148,163,184,.08)`.
**Measured / found:** That composites to **1.12:1** over the new panel gradient.
A previously shipped value at 1.08:1 was found invisible on tables 250+ rows
deep; the fix then measured 1.48:1 and worked. Only those two data points exist,
so any value between them is a guess. Alpha .23 measured **1.471:1 live in the
browser** against the actual painted table background, on a 252-row table.
**Decision:** Keep the proven ratio in the rgba form v3 wants (alpha .23).
Documented inline at the token.
**Why not the obvious thing:** Following the spec. It never re-ran the original
measurement, and a header band plus a drop shadow give a table its OUTER
structure — they do nothing to separate row 180 from row 181.
**Invalidated if:** The panel background lightens materially, or tables stop
rendering more than ~50 rows.

<!-- First entry goes here. -->
