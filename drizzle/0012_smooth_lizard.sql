ALTER TABLE `ipos` ADD `board` text DEFAULT 'mainboard' NOT NULL;--> statement-breakpoint
ALTER TABLE `ipos` ADD `category` text;--> statement-breakpoint
ALTER TABLE `ipos` ADD `discount_per_share` real DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `ipos` ADD `allotment_date` text;