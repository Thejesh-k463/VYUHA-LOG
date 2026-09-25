import { redirect } from "next/navigation";
import { legacyRedirect } from "@/lib/domain/hubs";

// Request-time, never prerendered: the redirect is answered per request.
export const dynamic = "force-dynamic";

/**
 * v4.6.0 W3 (owner ruling T1): /reports/expiry is a tab of an analytics hub now
 * (lib/domain/hubs.ts). A TEMPORARY 307 — not permanentRedirect — because
 * 4.7.0 re-maps the Edge Clinic's default tab and a browser-cached 308 would
 * outlive that. No Pro gate here: the hub it lands on owns the gate.
 */
export default function Page() {
  redirect(legacyRedirect("/reports/expiry")!);
}
