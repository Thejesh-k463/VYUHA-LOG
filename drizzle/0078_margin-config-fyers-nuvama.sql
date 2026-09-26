-- v4.6.0 fix wave (audit finding SM-1) — the Fyers and Nuvama `margin_config`
-- rows on an UPGRADED database.
--
-- W9 added both brokers to the seed (lib/db/seed-core.ts), but the seed's margin
-- rows reach a FRESH install only: a 4.5.0 database upgraded to 4.6.0 had none,
-- and `capitalBlocked` (lib/risk/margin.ts) then priced a Fyers or Nuvama future
-- or short option at an assumed 100% of notional with the "assumed 100%" note —
-- ROM off by up to 6.7x. The same class as v2.96.0's kotakneo / paytm / sahi.
--
-- INSERT OR IGNORE on the (broker, segment) unique key
-- (`margin_config_broker_segment_uq`, migration 0022): a row the user already
-- has — a hand-added Fyers row included — wins and is never touched, and a fresh
-- install (the seed ran first) adds 0. Sixteen rows = 2 brokers x 8 segments,
-- byte-for-byte `SEED_MARGIN_ROWS` for fyers and nuvama —
-- `tests/margin-config-refresh.test.ts` pins that equality, so the seed and this
-- file cannot drift. The restore paths (lib/backup.ts, settings-baseline.ts) and
-- the desktop launch refresh (scripts/rate-card-refresh.mjs) add the same rows
-- through `refreshMarginConfig` / the template, for a 4.5.0 backup or baseline.
--
-- Hand-written, no drizzle-kit snapshot (AGENTS.md: 0027+), journal entry added.
INSERT OR IGNORE INTO `margin_config` (`broker`, `segment`, `margin_pct`, `note`) VALUES
  ('fyers', 'eq_mtf', 25, 'fyers''s advertised MTF leverage'),
  ('fyers', 'eq_delivery', 100, 'full value deployed'),
  ('fyers', 'eq_intraday', 20, '5x intraday leverage'),
  ('fyers', 'index_option', 12, 'short-option SPAN approx'),
  ('fyers', 'stock_option', 20, 'short-option SPAN approx'),
  ('fyers', 'future', 15, 'SPAN+exposure approx'),
  ('fyers', 'commodity_future', 10, 'SPAN+exposure approx'),
  ('fyers', 'commodity_option', 12, 'short-option SPAN approx'),
  ('nuvama', 'eq_mtf', 25, 'nuvama''s advertised MTF leverage'),
  ('nuvama', 'eq_delivery', 100, 'full value deployed'),
  ('nuvama', 'eq_intraday', 20, '5x intraday leverage'),
  ('nuvama', 'index_option', 12, 'short-option SPAN approx'),
  ('nuvama', 'stock_option', 20, 'short-option SPAN approx'),
  ('nuvama', 'future', 15, 'SPAN+exposure approx'),
  ('nuvama', 'commodity_future', 10, 'SPAN+exposure approx'),
  ('nuvama', 'commodity_option', 12, 'short-option SPAN approx');
