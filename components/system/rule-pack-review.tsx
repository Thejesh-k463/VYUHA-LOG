"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
export function RulePackReview({ id }: { id: number }) { const router = useRouter(); const [busy, setBusy] = useState(false); return <Button size="sm" variant="outline" disabled={busy} onClick={async () => { setBusy(true); const r = await fetch("/api/rule-packs", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id }) }); setBusy(false); if (r.ok) router.refresh(); }}>{busy ? "Saving…" : "Mark source reviewed"}</Button>; }
