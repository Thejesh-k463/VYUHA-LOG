/**
 * Same-origin guard shared by the three `/api/atlas` handlers.
 *
 * There is no shared helper in this repo to reuse — `app/api/live/stream/
 * route.ts` says so and carries its own copy — and these three routes WRITE
 * (recompute, start a download, apply files), so the check cannot be skipped
 * on any of them. One colocated module beats three copies drifting apart.
 *
 * It is a DENY of the known-cross-origin case, not an allow-list of one fixed
 * origin: the desktop shell serves the app from `tauri.localhost`, the dev
 * server from `localhost`, and a same-origin `fetch` from the page sends no
 * `Origin` header at all — requiring one would break the desk itself.
 */

/** The desktop shell and the dev server; anything else must match the host. */
const LOCAL_ORIGINS = /^(?:tauri\.localhost|localhost|127\.0\.0\.1|\[::1\]|::1)$/i;

export function isSameOrigin(req: Request): boolean {
  const site = req.headers.get("sec-fetch-site");
  if (site && site !== "same-origin" && site !== "none") return false;
  const origin = req.headers.get("origin");
  if (!origin) return true;
  try {
    const url = new URL(origin);
    if (LOCAL_ORIGINS.test(url.hostname)) return true;
    return url.host === (req.headers.get("host") ?? "");
  } catch {
    return false;
  }
}

export const CROSS_ORIGIN_MESSAGE = "Cross-origin request refused.";
