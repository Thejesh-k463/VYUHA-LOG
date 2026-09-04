import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * GET /api/search — WHOSE fault was the throw? (v3.8.0 fix pass 2)
 *
 * The fan-out used to be wrapped in a blanket `} catch {` that answered 400
 * "That query could not be searched." for EVERY throw. A locked database, a
 * missing `trades_fts` table and an entitlement failure therefore reached the
 * user as a complaint about what they typed, and never reached the perf
 * sweep's console-error gate, which only watches 5xx.
 *
 * So: a throw whose message is SQLite's own wording for a MATCH expression it
 * cannot parse is the query's fault (400); anything else is the install's
 * fault and is logged and rethrown (500).
 *
 * No database — `searchAll` and the account resolver are both mocked, which
 * is the only way to make an infrastructure throw happen on demand.
 */

const searchAll = vi.fn();

vi.mock("@/lib/queries/search", () => ({ searchAll: (...a: unknown[]) => searchAll(...a) }));
vi.mock("@/lib/queries/accounts", () => ({ getSelectedAccountId: () => 1 }));

const route = await import("@/app/api/search/route");

const get = async (qs: string) => {
  const res = await route.GET(new Request(`http://local/api/search${qs}`));
  return { status: res.status, body: await res.json() };
};

afterEach(() => {
  searchAll.mockReset();
  vi.restoreAllMocks();
});

describe("a QUERY-shaped throw is the user's 400", () => {
  it.each([
    ["unterminated string", "unterminated string"],
    ["fts5 syntax", 'fts5: syntax error near ""'],
    ["malformed MATCH", "malformed MATCH expression for table trades_fts"],
  ])("%s → 400 with the palette's message, and nothing logged as an error", async (_name, message) => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    searchAll.mockImplementation(() => {
      throw new Error(message);
    });
    const r = await get("?q=whatever");
    expect(r.status).toBe(400);
    expect(r.body).toMatchObject({ ok: false, message: "That query could not be searched." });
    expect(spy).not.toHaveBeenCalled();
  });
});

describe("an INFRASTRUCTURE throw is not the user's fault", () => {
  it.each([
    ["a locked database", "SQLITE_BUSY: database is locked"],
    ["a missing table", "no such table: trades_fts"],
    ["an entitlement failure", "getEntitlement failed: settings row missing"],
    // FIX PASS 3: both of these MENTION the query-fault words without being
    // the query's fault. Unanchored, `fts5|syntax error` matched them and the
    // user was told their search was bad while FTS5 was simply not compiled
    // in, or OUR OWN SQL was malformed.
    ["FTS5 not compiled in", "no such module: fts5"],
    ["a syntax error in our own SQL", 'near "selec": syntax error'],
  ])("%s propagates (500) and is logged", async (_name, message) => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const err = new Error(message);
    searchAll.mockImplementation(() => {
      throw err;
    });
    // Red-on-revert: with the blanket `} catch {` this RESOLVED to a 400
    // carrying "That query could not be searched." — the assertion that fails
    // on revert is `rejects.toThrow`, because the route no longer throws.
    await expect(route.GET(new Request("http://local/api/search?q=whatever"))).rejects.toThrow(message);
    expect(spy).toHaveBeenCalled();
    expect(String(spy.mock.calls[0]![0])).toContain("[api/search]");
  });
});

describe("the 400s that were never about the fan-out still stand", () => {
  it("a blank q is refused before searchAll is reached", async () => {
    const r = await get("?q=%20%20");
    expect(r.status).toBe(400);
    expect(searchAll).not.toHaveBeenCalled();
  });

  it("an unknown cat is refused before searchAll is reached", async () => {
    const r = await get("?q=tcs&cat=nope");
    expect(r.status).toBe(400);
    expect(r.body.message).toMatch(/cat names no known source/);
    expect(searchAll).not.toHaveBeenCalled();
  });

  it("a successful search still answers ok with no-store", async () => {
    searchAll.mockReturnValue({ results: [], tookMs: 1 });
    const res = await route.GET(new Request("http://local/api/search?q=tcs"));
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect((await res.json()).ok).toBe(true);
  });
});
