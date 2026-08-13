import { describe, expect, it } from "vitest";
import { renewalDaysLeft, RENEWAL_NOTICE_DAYS, isKeyExpired, type LicensePayload } from "@/lib/license";

/**
 * The renewal countdown (v2.99.94).
 *
 * Until this existed there was NO warning of any kind before an annual licence
 * lapsed. `isKeyExpired` is binary, so 17 Pro screens locked overnight and the
 * buyer's first signal was a locked screen — on the plan whose entire economics
 * are renewals. The seller had `license-list.mjs --expiring 30`; the customer
 * had nothing.
 *
 * The properties worth pinning are the ones a mistake would cost money:
 *   1. a lifetime key must NEVER show a countdown (it would be a lie, and it
 *      would nag the highest-paying customer forever);
 *   2. the window must not open early or late;
 *   3. an already-expired key is the expired-key STATE, not a warning — the two
 *      must not both fire;
 *   4. the notice window matches the owner's own reminder, so seller and buyer
 *      learn on the same day.
 */

const annual = (expires: string): LicensePayload => ({ email: "b@example.com", sku: "app", issued: "2026-01-01", expires });
const lifetime: LicensePayload = { email: "b@example.com", sku: "app", issued: "2026-01-01" };

describe("renewal notice: warn before, never after", () => {
  it("says nothing for a lifetime key, ever", () => {
    // No `expires` means lifetime. A countdown here would invent an expiry that
    // does not exist, on the ₹29,999 plan.
    expect(renewalDaysLeft(lifetime, new Date("2099-01-01"))).toBeNull();
  });

  it("counts down inside the window", () => {
    // Expires end of 2026-09-01; ten days earlier.
    expect(renewalDaysLeft(annual("2026-09-01"), new Date("2026-08-22T10:00:00Z"))).toBe(11);
  });

  it("stays silent while the renewal is further out than the notice window", () => {
    expect(renewalDaysLeft(annual("2026-12-31"), new Date("2026-08-13"))).toBeNull();
  });

  it("opens exactly at the notice window and not a moment before", () => {
    /**
     * Instants are derived from the SAME parse the implementation uses
     * (`expires + "T23:59:59"`, which is local time), not from UTC literals.
     * An earlier version of this test hard-coded `…Z` instants and failed by a
     * timezone offset — it was asserting about the runner's clock, not about
     * the window.
     */
    const expires = "2026-09-30";
    const end = new Date(expires + "T23:59:59").getTime();
    const day = 86_400_000;

    // Exactly 30 days out → the first day of the window.
    expect(renewalDaysLeft(annual(expires), new Date(end - 30 * day), 30)).toBe(30);
    // A minute earlier than that is still 31 days by ceiling → silent.
    expect(renewalDaysLeft(annual(expires), new Date(end - 30 * day - 60_000), 30)).toBeNull();
  });

  it("goes quiet once the key has actually expired — that is a different state", () => {
    const payload = annual("2026-08-01");
    const after = new Date("2026-08-05");
    expect(isKeyExpired(payload, after)).toBe(true);
    // A warning AND an expired state at once would show a countdown on a locked
    // screen, which is the opposite of a notice.
    expect(renewalDaysLeft(payload, after)).toBeNull();
  });

  it("counts the expiry day itself as still licensed, with 1 day left", () => {
    // The key is valid through the END of `expires` (isKeyExpired uses
    // T23:59:59), so the last day must still read as a day, not as zero.
    const onTheDay = new Date("2026-09-01T09:00:00Z");
    expect(isKeyExpired(annual("2026-09-01"), onTheDay)).toBe(false);
    expect(renewalDaysLeft(annual("2026-09-01"), onTheDay)).toBe(1);
  });

  it("a malformed expiry warns about nothing rather than guessing", () => {
    expect(renewalDaysLeft({ ...lifetime, expires: "not-a-date" }, new Date("2026-08-13"))).toBeNull();
  });

  it("fires on the same day as the owner's own renewal reminder", () => {
    // docs/owner/LICENSE_OPERATIONS.md calls `license-list.mjs --expiring 30`
    // the renewal campaign. If these two numbers drift, the seller is reminded
    // on a different day from the buyer, which is how a renewal gets missed.
    expect(RENEWAL_NOTICE_DAYS).toBe(30);
  });
});
