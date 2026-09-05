-- v4.0 "Live Desk" — the market-context cache.
--
-- Three additive tables holding figures computed ENTIRELY from `price_history`
-- rows the user already imported. No new network host, no bundled price file,
-- no fetch: v4.0 adds zero egress, and these tables are the reason it does not
-- need any — the context panel reads a snapshot instead of asking the internet.
--
-- THEY ARE A CACHE, NOT A SOURCE OF TRUTH. Every row is reproducible from
-- `price_history`, so dropping all three loses nothing the user typed. Two
-- consequences are deliberate:
--   * they are NOT in BACKUP_TABLES (lib/backup-format.ts) — a backup carries
--     the user's book, not a derived snapshot that would be stale on restore;
--   * they carry NO `account_id`. Market breadth is a property of the market,
--     not of a book, so `tests/account-isolation.test.ts` has nothing to own
--     here. If a future metric ever becomes per-book, it needs its own table
--     with `account_id` and a scoped read (invariant 8), not a column here.
--
-- WHY THREE TABLES AND NOT ONE JSON BLOB.
--   `atlas_daily`     one row per session: the provenance of the run.
--   `atlas_metric`    LONG FORM, one row per (metric, group). A new metric is
--                     a row, not a schema change, and — the load-bearing part —
--                     every row carries its OWN `denominator` and
--                     `coverage_ppm`. Invariant 6: a figure published without
--                     its denominator is not publishable at all. A wide table
--                     would have made the denominator optional by construction.
--   `atlas_staleness` one row per symbol we could not use, WITH the reason.
--                     "Excluded as stale" and "held, but with insufficient
--                     history" are different facts about different symbols and
--                     are never added together into one number on screen.
--
-- `as_of` IS THE ANCHOR SESSION, NOT max(date). Bhavcopy imports land at
-- different times for different symbols, so `max(date)` collapses market
-- breadth to whatever refreshed first: on the morning after a partial import,
-- a five-symbol file would decide the breadth of two thousand. The anchor is
-- the LATEST MODAL valid session (ties broken by the later date) — see
-- lib/live/market-hours.ts `anchorSession`. Symbols ahead of the anchor are
-- truncated to it and symbols behind it are excluded, and BOTH counts are
-- published (`universe_included` / `universe_excluded`, `anchor_coverage`).
--
-- `spec_version` IS SEMVER ON THE FORMULA SET, not on the app version.
-- Changing "strictly above the SMA" to "at or above" is a MAJOR bump and it
-- invalidates every stored row computed under the old definition. Without this
-- column a redefinition would silently mix two different metrics in one series.
--
-- `input_checksum` is sha256 over the sorted (symbol, date, close, volume) rows
-- actually used. On a mismatch the snapshot is stale EVIDENCE — something that
-- was true of inputs we no longer have — and never re-served as data.
--
-- UNITS (invariant 1): ratios are ppm INTEGERS (`value_ppm`, `coverage_ppm`,
-- `anchor_coverage_ppm`); counts are plain integers. A count metric (advances,
-- declines, unchanged) puts its count in `numerator` and leaves `value_ppm`
-- NULL rather than dressing a count up as a ratio. `denominator` NULL means the
-- figure itself is NULL — never 0.
--
-- ADDITIVE AND REVERSIBLE: three new tables, nothing in v3.9.1 reads them, and
-- the down path is DROP TABLE `atlas_staleness` / `atlas_metric` / `atlas_daily`.
CREATE TABLE `atlas_daily` (
	`as_of` text PRIMARY KEY NOT NULL,
	`generated_at` text DEFAULT (datetime('now')) NOT NULL,
	`spec_version` text NOT NULL,
	`source_mode` text NOT NULL,
	`input_checksum` text NOT NULL,
	`universe_included` integer DEFAULT 0 NOT NULL,
	`universe_excluded` integer DEFAULT 0 NOT NULL,
	`anchor_coverage` integer DEFAULT 0 NOT NULL,
	`anchor_coverage_ppm` integer,
	`payload_json` text
);
--> statement-breakpoint
CREATE TABLE `atlas_metric` (
	`as_of` text NOT NULL,
	`metric` text NOT NULL,
	`group_kind` text NOT NULL,
	`group_name` text DEFAULT '*' NOT NULL,
	`value_ppm` integer,
	`numerator` integer,
	`denominator` integer,
	`coverage_ppm` integer,
	`insufficient_history` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE `atlas_staleness` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`as_of` text NOT NULL,
	`symbol` text NOT NULL,
	`reason` text NOT NULL,
	`last_seen_date` text,
	`sessions_behind` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `atlas_metric_uq` ON `atlas_metric` (`as_of`,`metric`,`group_kind`,`group_name`);--> statement-breakpoint
CREATE INDEX `atlas_metric_asof_idx` ON `atlas_metric` (`as_of`);--> statement-breakpoint
CREATE UNIQUE INDEX `atlas_staleness_uq` ON `atlas_staleness` (`as_of`,`symbol`,`reason`);--> statement-breakpoint
CREATE INDEX `atlas_staleness_asof_idx` ON `atlas_staleness` (`as_of`);
