CREATE TABLE `playbooks` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`rules` text DEFAULT '[]' NOT NULL,
	`archived` integer DEFAULT false NOT NULL,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	`updated_at` text DEFAULT (datetime('now')) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `playbooks_name_unique` ON `playbooks` (`name`);--> statement-breakpoint
ALTER TABLE `trades` ADD `playbook_id` integer;--> statement-breakpoint
ALTER TABLE `trades` ADD `emotion_tag` text;