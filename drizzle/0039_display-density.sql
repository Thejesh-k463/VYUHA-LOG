-- Display density: compact (16px root, the shipped look) or comfortable (17px).
-- A preference, so it also joins the "My Default Settings" baseline fields.
ALTER TABLE `settings` ADD `density` text DEFAULT 'compact' NOT NULL;
