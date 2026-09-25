# public/help — the Help Desk's screen images

One `<name>.webp` per help topic that names a `screenshot` in `lib/domain/help-topics.ts`. The topic dialog on
`/help` shows it between "Watch out" and "In detail" (`components/help/help-topic-dialog.tsx`), lazily loaded.

**Dark theme, demo data, never a real journal.** Every image is shot from a throwaway database seeded with the
committed test fixture (`tests/fixtures/dhan-gtr.csv`) through the real import screen, at 1440×900, with the dark
theme forced and asserted before the first shot. Never replace a file here with a capture of your own book.

## Regenerate

```
node scripts/capture-help-screens.mjs --list   # which topics, which routes (no server started)
npm run help:shots                             # all of them
node scripts/capture-help-screens.mjs trades   # only the named ones
```

The script needs `sharp` (installed as Next's optional dependency) and Playwright's Chromium; without `sharp` it
exits 2 before shooting anything. It prints each file's size and the total as "installer growth: N KB" — this folder
ships inside the desktop installer. Re-run it whenever a shot screen's layout changes, once per minor release at least.

`tests/help-content.test.ts` fails while a named screenshot has no file here.
