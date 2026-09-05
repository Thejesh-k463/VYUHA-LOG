---
name: vyuha-status
description: One-screen VYUHA release status — CI runs, newest tag, updater endpoint, revocation-list prerelease flag, and renewals due in 30 days. Use at the start of a release-day session or whenever asked what is live.
user-invocable: true
context: fork
agent: vyuha-monitor
background: false
---

# /vyuha-status

Five facts about what is live, gathered read-only in a forked context so the raw `gh` and
`curl` output never enters this session.

Task for the agent:

1. `gh auth status` first. If it is not authenticated, say so and skip the `gh` steps rather
   than guessing.
2. `gh run list --limit 5 --json name,status,conclusion,headBranch`.
3. Newest tag (`git describe --tags --abbrev=0`), HEAD short sha, `package.json` version.
4. The updater endpoint must answer 302 or 200:
   `curl -sI https://github.com/Thejesh-k463/VYUHA-LOG/releases/latest/download/latest.json | head -1`.
   Anything else is stop-the-line — installed copies auto-update through this URL.
5. `gh release view revocations --json isPrerelease` must be `true`. `false` means the
   revocation list has taken `releases/latest` and auto-update is dead for every installed
   copy (v2.99.91).
6. `npm run renewals -- --days 30`.

Return the agent's table verbatim, including its "Not observed" list. An unknown is a
result; a guess is a defect.
