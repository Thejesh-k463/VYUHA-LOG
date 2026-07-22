<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->


# Verify with `npm run verify`, not just tests

`npm run typecheck && lint && test` all pass on code that **cannot be bundled**. Client components
import `lib/license.ts`, so anything in its import graph must stay browser-safe — a `node:child_process`
import there fails only at `next build`, which is what `npm run verify` adds. CI runs the build too, so
this is about catching it before the push, not instead of CI.
