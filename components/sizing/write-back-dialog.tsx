"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { toast } from "@/components/ui/toaster";
import { num } from "@/lib/format";
import type { StopMethod, StoredLiveDeskRisk } from "./lab-config";

/**
 * "Use this in Live Desk" (owner Q36).
 *
 * The Lab computes continuously; it persists NOTHING until this dialog is
 * opened and confirmed, and the dialog's whole job is to show old → new per
 * field first. A slider drag never writes — 03 §11.8, and the reason is that
 * the stored risk figure is the denominator of every risk column in the
 * product, so it changes when the user says so and not a moment earlier.
 *
 * Route handler + `fetch` + `router.refresh()`, never a server action: a
 * server action refreshes this route, remounting the lab's sibling client
 * components and wiping the setup the user has been typing into.
 */

export interface WriteBackValues {
  riskPctPpm: number;
  deployCapPpm: number;
  stopMethod: StopMethod;
  stopAtrLen: number;
  stopAtrMultPermille: number;
}

const pctOf = (ppm: number | null, decimals = 2) => (ppm == null ? "not set" : `${num(ppm / 10_000, decimals)}%`);
const nOf = (permille: number | null) => (permille == null ? "not set" : `${num(permille / 1000, 2)} × ATR`);
const lenOf = (n: number | null) => (n == null ? "not set" : `${num(n, 0)} sessions`);

function Row({ label, from, to }: { label: string; from: string; to: string }) {
  const changed = from !== to;
  return (
    <tr className="border-b border-border/50">
      <th scope="row" className="py-1.5 pr-3 text-left font-normal text-muted-foreground">
        {label}
      </th>
      <td className="py-1.5 pr-3 tabular-nums text-muted-foreground">{from}</td>
      <td className="py-1.5 pr-3 text-muted-foreground">→</td>
      <td className={`py-1.5 tabular-nums ${changed ? "font-semibold text-foreground" : "text-muted-foreground"}`}>
        {to}
      </td>
    </tr>
  );
}

export function WriteBackDialog({
  stored,
  values,
  disabled,
}: {
  stored: StoredLiveDeskRisk | null;
  values: WriteBackValues;
  disabled?: boolean;
}) {
  const router = useRouter();
  const [open, setOpen] = React.useState(false);
  const [pending, setPending] = React.useState(false);

  async function save() {
    setPending(true);
    try {
      const res = await fetch("/api/risk/live-desk", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(values),
      });
      const json = await res.json();
      if (json.ok) {
        toast.success(json.message ?? "Live Desk risk saved.");
        setOpen(false);
        // Invalidate the router cache so the page's server load re-runs and
        // the stored chip shows the figure that was just written.
        router.refresh();
      } else {
        toast.error(json.message ?? "Not saved.");
      }
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setPending(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm" disabled={disabled}>
          Use this in Live Desk
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Store these settings for the Live Desk</DialogTitle>
          <DialogDescription>
            These five fields are what the desk sizes and draws stops from. Nothing else in the Lab is stored.
          </DialogDescription>
        </DialogHeader>

        <table className="w-full text-xs">
          <thead>
            <tr className="border-b border-border text-[0.6875rem] uppercase tracking-[0.08em] text-muted-foreground">
              <th className="py-1.5 pr-3 text-left font-medium">Field</th>
              <th className="py-1.5 pr-3 text-left font-medium">Stored now</th>
              <th />
              <th className="py-1.5 text-left font-medium">After saving</th>
            </tr>
          </thead>
          <tbody>
            <Row label="Risk per trade" from={pctOf(stored?.riskPctPpm ?? null)} to={pctOf(values.riskPctPpm)} />
            <Row
              label="Deploy cap"
              from={pctOf(stored?.deployCapPpm ?? null, 0)}
              to={pctOf(values.deployCapPpm, 0)}
            />
            <Row label="Stop method" from={stored?.stopMethod ?? "not set"} to={values.stopMethod} />
            <Row label="ATR length" from={lenOf(stored?.stopAtrLen ?? null)} to={lenOf(values.stopAtrLen)} />
            <Row
              label="ATR multiple"
              from={nOf(stored?.stopAtrMultPermille ?? null)}
              to={nOf(values.stopAtrMultPermille)}
            />
          </tbody>
        </table>

        <p className="text-[0.6875rem] text-muted-foreground">
          The risk figure becomes the denominator of the risk columns across the app. Every trade already recorded
          keeps the numbers it was recorded with.
        </p>

        <DialogFooter>
          <Button variant="outline" size="sm" onClick={() => setOpen(false)} disabled={pending}>
            Cancel
          </Button>
          <Button size="sm" onClick={save} disabled={pending}>
            {pending ? "Saving…" : "Save to Live Desk"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
