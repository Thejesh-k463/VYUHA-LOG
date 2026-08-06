-- "My Default Settings": the configuration kept as the user's baseline.
--
-- Captured automatically the first time the app runs (so every install has a
-- baseline without being asked), replaced only by an explicit "save current as
-- my default". One row. The payload is the JSON baseline from
-- lib/domain/settings-baseline.ts: preference fields plus the three rate
-- tables — never licence, trial, clock-ratchet or accounting state, which are
-- state and facts rather than choices.
CREATE TABLE `settings_baseline` (
  `id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  `captured_at` text DEFAULT (datetime('now')) NOT NULL,
  `payload` text NOT NULL
);
