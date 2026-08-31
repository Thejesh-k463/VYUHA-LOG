"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { toast } from "@/components/ui/toaster";

/**
 * Closes the review loop on a past session card: a note plus "Mark reviewed",
 * written through the sessions route's PATCH (status/notes only — the POST
 * upsert would replace the whole plan). Route handler + fetch +
 * router.refresh(), never a server action (house convention).
 */
export function SessionReviewControls({ sessionId }: { sessionId: number }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [notes, setNotes] = useState("");
  const [busy, setBusy] = useState(false);

  async function markReviewed() {
    setBusy(true);
    const res = await fetch("/api/sessions", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: sessionId, status: "reviewed", reviewNotes: notes.trim() || null }),
    });
    const data = await res.json().catch(() => ({ ok: false, message: "Request failed." }));
    setBusy(false);
    if (data.ok) {
      toast.success("Session marked reviewed.");
      router.refresh();
    } else {
      toast.error(data.message ?? "Could not mark the session reviewed.");
    }
  }

  if (!open) {
    return (
      <div className="border-t border-rule pt-2">
        <Button type="button" variant="outline" size="sm" onClick={() => setOpen(true)}>
          Mark reviewed
        </Button>
      </div>
    );
  }
  return (
    <div className="space-y-2 border-t border-rule pt-2">
      <textarea
        value={notes}
        onChange={(e) => setNotes(e.target.value)}
        rows={2}
        className="w-full rounded-md border border-border bg-input px-3 py-2 text-sm"
        placeholder="What did this session teach you? (optional)"
      />
      <div className="flex items-center gap-2">
        <Button type="button" size="sm" disabled={busy} onClick={() => void markReviewed()}>
          {busy ? "Saving…" : "Mark reviewed"}
        </Button>
        <Button type="button" variant="ghost" size="sm" disabled={busy} onClick={() => setOpen(false)}>
          Cancel
        </Button>
      </div>
    </div>
  );
}
