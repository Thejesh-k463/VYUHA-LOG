-- Workspace mode: which book the user trades (both | equity | fno).
-- Hides the other book's screens from the sidebar and command palette and
-- sets the bucket default on shared screens. Purely a display preference:
-- every route still resolves and no total is filtered behind the user's back
-- (lib/domain/workspace.ts). Existing installs default to 'both', which is
-- exactly the behaviour they have today.
ALTER TABLE `settings` ADD COLUMN `workspace` text DEFAULT 'both' NOT NULL;
