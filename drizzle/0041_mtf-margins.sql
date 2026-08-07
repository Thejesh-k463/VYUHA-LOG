-- Per-stock MTF own-margin overrides (broker × symbol), reference data.
-- The bundled snapshot (lib/data/mtf-margins.json) is read-only; rows here are
-- user refreshes uploaded from a broker's own file and take precedence over
-- the bundle. Upserts on the unique pair — re-uploading never duplicates.
CREATE TABLE `mtf_margins` (
  `id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  `broker` text NOT NULL,
  `symbol` text NOT NULL,
  `margin_pct` real NOT NULL,
  `isin` text,
  `as_of` text NOT NULL,
  `source` text NOT NULL,
  `created_at` text DEFAULT (datetime('now')) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `mtf_margins_pair_uq` ON `mtf_margins` (`broker`,`symbol`);
--> statement-breakpoint
CREATE INDEX `mtf_margins_broker_idx` ON `mtf_margins` (`broker`);
