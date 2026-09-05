import Link from "next/link";
import { PageHeader } from "@/components/layout/page-header";
import { PricingTable } from "@/components/system/pricing-table";
import { PricingComparison } from "@/components/system/pricing-comparison";
import { getEntitlement } from "@/lib/queries/license";
import { Card, CardContent } from "@/components/ui/card";
import { BadgeCheck } from "lucide-react";

export const dynamic = "force-dynamic";

/**
 * The in-app pricing page. Reached from the upsell panel, the licence card
 * and the locked buttons — deliberately NOT in the sidebar: a permanent
 * "Pricing" nav item is noise for a licensed user, and adding it to
 * NAV_ITEMS would drag in a help-desk entry (tests/help-content.test.ts
 * couples nav ↔ help in both directions).
 */
export default function PricingPage() {
  const ent = getEntitlement();

  return (
    <>
      <PageHeader
        title="Pricing"
        description="Two ways to pay. The core journal stays free forever — the analytics are the product."
      />
      <div className="mx-auto max-w-4xl space-y-5 p-6">
        {ent.state === "licensed" && (
          <Card>
            <CardContent className="flex items-center gap-2 p-4 text-sm">
              <BadgeCheck className="size-4 text-profit" />
              You already hold a licence — this page is here if you are comparing plans for someone else.
            </CardContent>
          </Card>
        )}

        <PricingTable />

        <PricingComparison />

        <p className="text-xs text-muted-foreground">
          Every purchase is a WhatsApp conversation, not a checkout — the key is issued personally and shows your
          email in-app. The free tier is not a trial: recording closed trades, every broker importer, the
          dashboard, staged positions, playbooks, the calculator and backups stay free forever, and your
          record stays yours either way. Already bought?{" "}
          <Link href="/settings#license" className="text-accent underline-offset-2 hover:underline">
            Activate your key
          </Link>
          .
        </p>
      </div>
    </>
  );
}
