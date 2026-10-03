"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Loader2, TriangleAlert } from "lucide-react";

/**
 * v4.7.0 C2 (design D3) — the Clinic's compute trigger. The page NEVER runs the
 * engine; it reads the cache (`getClinicState()`), and when that says `stale`
 * or `missing` this asks POST /api/edge-clinic/compute ONCE, then
 * `router.refresh()` so the server re-reads a fresh cache row.
 *
 * Once means once per digest: a ref remembers which input digest has been
 * asked for, so a refresh that still reads stale (the book changed again
 * mid-compute) or React's dev double-mount cannot loop. There is no polling —
 * a failed compute says so and stops; a reload is the retry.
 *
 * Route handler + client fetch + router.refresh(), never a server action
 * (AGENTS.md: a server action refreshes the route and resets sibling state).
 * The "computing" line is DERIVED from the props, not mirrored into state.
 */
export function ClinicRunner({
  status,
  digest,
  staleAge,
}: {
  status: "fresh" | "stale" | "missing";
  digest: string;
  /** How old the report on screen is, when it is stale ("3 h"); computed on the server. */
  staleAge: string | null;
}) {
  const router = useRouter();
  const asked = React.useRef<Set<string>>(new Set());
  const [failed, setFailed] = React.useState<{ digest: string; message: string } | null>(null);

  React.useEffect(() => {
    if (status === "fresh" || asked.current.has(digest)) return;
    asked.current.add(digest);
    fetch("/api/edge-clinic/compute", { method: "POST" })
      .then(async (r) => {
        const d = (await r.json().catch(() => null)) as { ok?: boolean; message?: string } | null;
        if (!r.ok || !d?.ok) throw new Error(d?.message ?? `HTTP ${r.status}`);
        router.refresh();
      })
      .catch((e: unknown) => {
        setFailed({ digest, message: e instanceof Error ? e.message : "The compute did not finish." });
      });
  }, [status, digest, router]);

  if (status === "fresh") return null;
  if (failed && failed.digest === digest) {
    return (
      <div role="status" className="flex items-start gap-2 rounded-md border border-warning/40 bg-warning/5 p-3 text-xs">
        <TriangleAlert className="mt-0.5 size-3.5 shrink-0 text-warning" />
        <span>
          The Clinic could not read your book this time ({failed.message}).{" "}
          {staleAge ? `The report below is ${staleAge} old. ` : null}Reload the page to try again.
        </span>
      </div>
    );
  }
  return (
    <div role="status" data-clinic-status={status} className="flex items-center gap-2 rounded-md border border-border bg-card-hover/40 p-3 text-xs text-muted-foreground">
      <Loader2 className="size-3.5 shrink-0 animate-spin motion-reduce:animate-none" />
      <span>
        Computing the Clinic…{" "}
        {status === "stale" && staleAge
          ? `Its inputs changed since the last read (the book, a risk setting or the date) — the report below is ${staleAge} old until this finishes.`
          : "It reads your closed trades once per change to the book; this page updates when it is done."}
      </span>
    </div>
  );
}
