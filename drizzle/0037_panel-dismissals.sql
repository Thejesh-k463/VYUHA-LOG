-- Dismiss-with-memory for advisory panels.
--
-- Panels like "open holdings with no current price" are COMPUTED from the data,
-- so they cannot simply be closed — the situation persists. A dismissal is
-- therefore keyed on a fingerprint of the situation it was shown for: the panel
-- stays hidden while the facts are unchanged and returns the moment they move
-- (a new unmarked holding, one more or fewer). Nothing is ever hidden while the
-- data is changing underneath the user.
CREATE TABLE `panel_dismissals` (
  `id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  `account_id` integer DEFAULT 1 NOT NULL,
  `panel` text NOT NULL,
  `fingerprint` text NOT NULL,
  `dismissed_at` text DEFAULT (datetime('now')) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `panel_dismissals_uq` ON `panel_dismissals` (`account_id`,`panel`,`fingerprint`);
