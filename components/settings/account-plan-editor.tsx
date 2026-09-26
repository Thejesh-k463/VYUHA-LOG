"use client";

/**
 * WHICH PRICING PLAN IS THIS ACCOUNT ON — v4.5.0 wave U.
 *
 * Rendered ONLY for an account whose broker actually sells more than one plan,
 * and the list comes from `charge_config` (`brokerPlanOptions`, derived in the
 * server page), never from a hard-coded broker name: the day a second broker
 * gets a tier, its accounts get this control with no change here. Zerodha,
 * Groww, Dhan and the rest show nothing at all.
 *
 * Route handler + `fetch` + `router.refresh()`, never a server action
 * (AGENTS.md Conventions): a server action auto-refreshes the route and
 * remounts the sibling cards, silently resetting their state.
 *
 * TWO CLICKS WHEN, AND ONLY WHEN, MONEY MOVES. Setting a plan re-prices
 * nothing already saved — except the daily MTF accrual, which recomputes
 * interest on still-OPEN rows and writes `charges_total` / `net_pnl` back. So
 * Save asks the server first ("planPreview"): with rows to move it states
 * "N open MTF rows re-accrue: was X, will be Y" and waits for a second,
 * deliberate click; with nothing to move it just saves. Each moved row gets an
 * audit entry (DECISIONS 2026-08-30 decision 6).
 */

import * as React from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { toast } from "@/components/ui/toaster";

export interface PlanChoice {
  plan: string;
  label: string;
  subscriptionMonthly: number;
}

export interface PlanAccountLite {
  id: number;
  name: string;
  broker: string | null;
  brokerPlan: string | null;
  brokerPlanFrom: string | null;
}

/**
 * What Save stores. The default plan is stored as its own id, "default" — NOT
 * as null (v4.6.0 audit DA-1): null means "never chosen", which Data Quality
 * (`getAccountsWithoutPlan`) flags on a multi-plan broker and the dashboard's
 * "Charges plan set" step reads, so a user who explicitly chose the free plan
 * was flagged forever. Pricing cannot tell them apart: `resolvePlan`
 * (lib/engine/rates.ts) returns "default" for null and for "default" alike.
 */
export function planFields(plan: string, from: string): { brokerPlan: string; brokerPlanFrom: string | null } {
  return { brokerPlan: plan, brokerPlanFrom: from.trim() === "" ? null : from.trim() };
}

/** Is there anything to save? A never-chosen (null) plan is savable as the default — that IS the choice. */
export function planChanged(account: Pick<PlanAccountLite, "brokerPlan" | "brokerPlanFrom">, plan: string, from: string): boolean {
  return account.brokerPlan !== plan || (account.brokerPlanFrom ?? "") !== from;
}

export function AccountPlanEditor({ account, options }: { account: PlanAccountLite; options: PlanChoice[] }) {
  const router = useRouter();
  const [plan, setPlan] = React.useState(account.brokerPlan ?? "default");
  const [from, setFrom] = React.useState(account.brokerPlanFrom ?? "");
  const [busy, setBusy] = React.useState(false);
  const [pending, setPending] = React.useState<string | null>(null);

  const changed = planChanged(account, plan, from);

  async function post(body: Record<string, unknown>) {
    const res = await fetch("/api/accounts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    return (await res.json().catch(() => ({ ok: false, message: "The save could not be read." }))) as {
      ok: boolean;
      message?: string;
      count?: number;
      reaccrued?: number;
      reaccrueMessage?: string;
    };
  }

  const fields = planFields(plan, from);

  async function save() {
    setBusy(true);
    const res = await post({ action: "upsert", id: account.id, name: account.name, ...fields });
    setBusy(false);
    setPending(null);
    if (!res.ok) {
      toast.error(res.message ?? "The plan was not saved.");
      return;
    }
    toast.success(res.reaccrued ? `Plan saved. ${res.reaccrueMessage}` : "Plan saved.");
    router.refresh();
  }

  async function onSave() {
    if (pending) return void save();
    setBusy(true);
    const prev = await post({ action: "planPreview", id: account.id, ...fields });
    setBusy(false);
    if (prev.ok && (prev.count ?? 0) > 0) {
      setPending(prev.message ?? "Open MTF rows re-accrue under this plan.");
      return;
    }
    await save();
  }

  return (
    <div className="mt-2 space-y-1.5 border-t border-border pt-2">
      <div className="flex items-end gap-1.5">
        <div className="min-w-0 flex-1">
          <label className="block text-[0.625rem] text-muted-foreground" htmlFor={`plan-${account.id}`}>
            Brokerage plan
          </label>
          <Select
            id={`plan-${account.id}`}
            className="h-7 text-xs"
            value={plan}
            onChange={(e) => {
              setPlan(e.target.value);
              setPending(null);
            }}
          >
            {options.map((o) => (
              <option key={o.plan} value={o.plan}>
                {/* D4 — "· paid" is claimed ONLY for a plan with a real fee. A
                    zero-fee opt-in tier (Upstox Plus) is priced through its
                    higher per-order brokerage, not a subscription. */}
                {o.label}
                {o.subscriptionMonthly > 0 ? ` · ₹${o.subscriptionMonthly}/mo` : o.plan === "default" ? "" : " · opt-in"}
              </option>
            ))}
          </Select>
        </div>
        <div className="w-[7.5rem]">
          <label className="block text-[0.625rem] text-muted-foreground" htmlFor={`plan-from-${account.id}`}>
            From (optional)
          </label>
          <Input
            id={`plan-from-${account.id}`}
            className="h-7 text-xs"
            type="date"
            value={from}
            disabled={plan === "default"}
            onChange={(e) => {
              setFrom(e.target.value);
              setPending(null);
            }}
          />
        </div>
        <Button type="button" size="sm" className="h-7 px-2 text-[0.6875rem]" disabled={busy || !changed} onClick={() => void onSave()}>
          {busy ? "…" : pending ? "Confirm" : "Save"}
        </Button>
      </div>
      <p className="text-[0.625rem] text-muted-foreground">
        {pending
          ? pending
          : plan === "default"
            ? "Priced on the free plan. Trades already saved are never re-priced."
            : from
              ? `Priced on this plan for trades from ${from}. Trades already saved are never re-priced.`
              : "Priced on this plan for the whole history. Trades already saved are never re-priced."}
      </p>
    </div>
  );
}
