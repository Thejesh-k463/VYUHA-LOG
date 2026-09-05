import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { generateKeyPairSync, sign } from "node:crypto";
import { openTempDb, type TempDb } from "./helpers/temp-db";

/**
 * v3.9.1 item 3 — a machine-bound key must be refused AT ACTIVATION.
 *
 * `app/api/license/route.ts` verified the pasted key without this computer's
 * id, so a key locked to someone else's machine activated cleanly (toast:
 * "Activated: …"), was encrypted into settings, and only failed later on the
 * read path — `lib/queries/license.ts` passes `getMachineId()` — where it
 * silently reads back unlicensed. The buyer sees a successful activation and
 * an unlicensed app, with no message explaining why.
 *
 * The route must ask the same question the read path asks, and surface the
 * same sentence `verifyLicenseKey` produces for a mismatch.
 */

const h = vi.hoisted(() => ({ machine: "M2", pem: "" }));

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/machine-id.server", () => ({
  getMachineId: () => h.machine,
  resetMachineIdCache: () => {},
}));
// The route verifies against the baked-in vendor key; tests mint against an
// ephemeral keypair, exactly as tests/license.test.ts does.
vi.mock("@/lib/license", async () => {
  const actual = await vi.importActual<typeof import("@/lib/license")>("@/lib/license");
  // A getter, not a value: the factory runs the first time anything imports
  // the module, which can be before this file's body has minted the keypair.
  return { ...actual, get LICENSE_PUBLIC_KEY_PEM() { return h.pem; } };
});
// The vault needs a real DEK file on disk; the binding decision happens well
// before storage, so encryption is stubbed rather than exercised here.
vi.mock("@/lib/vault", async () => {
  const actual = await vi.importActual<typeof import("@/lib/vault")>("@/lib/vault");
  return { ...actual, encryptSecret: (s: string) => `enc:${s}` };
});

const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const PUB_PEM = publicKey.export({ type: "spki", format: "pem" }).toString();
h.pem = PUB_PEM;

function issue(fields: Record<string, unknown>): string {
  const payload = Buffer.from(JSON.stringify({ email: "buyer@x.com", sku: "app", issued: "2026-07-01", ...fields }), "utf8");
  return `VYUHA-${payload.toString("base64url")}.${sign(null, payload, privateKey).toString("base64url")}`;
}

const BOUND_TO_M1 = issue({ machine: "M1" });
const UNBOUND = issue({});

let t: TempDb;
let route: typeof import("@/app/api/license/route");
let lic: typeof import("@/lib/license");

function activate(key: string): Promise<Response> {
  return route.POST(new Request("http://local/api/license", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "activate", key }),
  }));
}

const storedKey = () => t.db.select({ k: t.schema.settings.licenseKey }).from(t.schema.settings).get()?.k ?? null;

function clearKey() {
  t.db.update(t.schema.settings).set({ licenseKey: null }).run();
}

beforeAll(async () => {
  t = await openTempDb("license-activation-binding", { seed: true });
  lic = await vi.importActual<typeof import("@/lib/license")>("@/lib/license");
  route = await import("@/app/api/license/route");
});

afterAll(() => t?.cleanup());

describe("activation asks the same machine question the read path asks", () => {
  it("refuses a key bound to another machine, with the read path's own sentence", async () => {
    h.machine = "M2";
    clearKey();
    const res = await activate(BOUND_TO_M1);
    const body = (await res.json()) as { ok: boolean; message: string };

    // The exact sentence lib/license.ts produces for a mismatch — the one
    // lib/queries/license.ts already surfaces on the read path.
    const expected = lic.verifyLicenseKey(BOUND_TO_M1, PUB_PEM, [], "M2").reason;
    expect(expected).toBe("This key is locked to a different computer. Send your Machine ID (M2) to support to have it re-issued.");

    expect(res.status).toBe(400);
    expect(body.ok).toBe(false);
    expect(body.message).toBe(expected);
    // Nothing was written: a refused activation must not leave a foreign key
    // sitting in settings for the read path to reject forever.
    expect(storedKey()).toBeNull();
  });

  it("activates the same key on the machine it is bound to", async () => {
    h.machine = "M1";
    clearKey();
    const res = await activate(BOUND_TO_M1);
    const body = (await res.json()) as { ok: boolean; message: string };
    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.message).toContain("Activated:");
    expect(storedKey()).toBe(`enc:${BOUND_TO_M1}`);
  });

  it("still activates an unbound key on any machine", async () => {
    for (const m of ["M1", "M2", "some-other-machine"]) {
      h.machine = m;
      clearKey();
      const res = await activate(UNBOUND);
      const body = (await res.json()) as { ok: boolean; message: string };
      expect(res.status).toBe(200);
      expect(body.ok).toBe(true);
      expect(storedKey()).toBe(`enc:${UNBOUND}`);
    }
  });
});
