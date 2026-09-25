"use client";

import Link from "next/link";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { hubTabHref, type Hub } from "@/lib/domain/hubs";

/**
 * The tab strip of an analytics hub (v4.6.0 W3, owner ruling T1).
 *
 * Every tab is a LINK to `${hub.href}?tab=<id>` — the server reads the param
 * and renders only that tab's body, so there is no `TabsContent` here and no
 * client state beyond what Radix keeps for focus. Radix supplies the keyboard
 * contract (arrow keys / Home / End move focus, one tab stop for the strip,
 * `role="tablist"` + `aria-selected`); Enter or a click follows the link.
 *
 * `visible` is decided by the SERVER (workspace mode, `tabVisible`), never
 * here: a tab of the other book is simply not passed in unless it is the one
 * being viewed — the sidebar's `|| isCurrent` rule, so a deep link still opens
 * and the strip still shows where the user is.
 */
export function HubTabs({ hub, active, visible }: { hub: Hub; active: string; visible: readonly string[] }) {
  const tabs = hub.tabs.filter((t) => visible.includes(t.id));
  // aria-controls={undefined}: Radix always points a trigger at a TabsContent
  // id, and this strip has none — the SERVER renders the tab the URL names, so
  // the reference would dangle (an axe violation on every hub). Radix spreads
  // the trigger's own props AFTER its aria-controls, so undefined removes it.
  return (
    <Tabs value={active} className="px-6 pt-3 print:hidden">
      <TabsList aria-label={hub.label}>
        {tabs.map((t) => (
          <TabsTrigger key={t.id} value={t.id} asChild aria-controls={undefined}>
            <Link href={hubTabHref(hub, t.id)}>{t.label}</Link>
          </TabsTrigger>
        ))}
      </TabsList>
    </Tabs>
  );
}
