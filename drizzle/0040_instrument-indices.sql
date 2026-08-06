-- NSE thematic index memberships (symbol × index), reference data.
-- Populated from the bundled NSE index map or uploaded ind_*_list.csv files;
-- re-loading upserts on the unique pair, so refreshes never duplicate.
CREATE TABLE `instrument_indices` (
  `id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  `symbol` text NOT NULL,
  `index_name` text NOT NULL,
  `created_at` text DEFAULT (datetime('now')) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `instrument_indices_pair_uq` ON `instrument_indices` (`symbol`,`index_name`);
--> statement-breakpoint
CREATE INDEX `instrument_indices_symbol_idx` ON `instrument_indices` (`symbol`);
