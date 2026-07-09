import Link from "next/link";
import { KeyRound } from "lucide-react";
import { getLicenseStatus } from "@/lib/queries/license";

/**
 * Shown on Pro screens when no valid license is on record. In "banner" enforcement
 * (current) it's informational only; switching lib/license.ts to "block" is where a
 * hard gate would be added. Server component — safe to drop into any page.
 */
export function LicenseBanner() {
  const status = getLicenseStatus();
  if (status.licensed) return null;
  return (
    <div className="flex items-start gap-2 rounded-md border border-accent/30 bg-accent/5 p-3 text-xs text-muted-foreground">
      <KeyRound className="size-4 shrink-0 text-accent" />
      <div>
        <span className="font-medium text-foreground">Pro feature — unlicensed copy.</span> This screen is part of
        the paid toolkit. Already bought it? Activate your key in{" "}
        <Link href="/settings" className="text-accent underline-offset-2 hover:underline">Settings → License</Link>.
      </div>
    </div>
  );
}
