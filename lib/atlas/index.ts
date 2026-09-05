/**
 * lib/atlas — the daily market-context library (v4.0, Live Desk W5).
 *
 * Pure by construction: no DB, no React, no `node:*`, no `fetch`, no clock.
 * The server wrapper (`lib/queries/atlas.ts`) reads `price_history`, resolves
 * sectors through `getSectorResolution()` and supplies the clock and the hash.
 *
 * Ships only plain public definitions, each with its formula and denominator
 * on the row. No proprietary score, no Chartink data, no parity claim.
 */
export * from "./types";
export * from "./anchor";
export * from "./breadth";
export * from "./sma-breadth";
export * from "./high-low";
export * from "./returns";
export * from "./volume";
export * from "./groups";
export * from "./regime";
export * from "./ledger";
export * from "./compute-daily";
