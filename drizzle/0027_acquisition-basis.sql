ALTER TABLE `trades` ADD `acquisition` text;--> statement-breakpoint
ALTER TABLE `trades` ADD `acquisition_price` real;--> statement-breakpoint
ALTER TABLE `trades` ADD `acquisition_date` text;--> statement-breakpoint
ALTER TABLE `trades` ADD `suggested_basis_price` real;--> statement-breakpoint
ALTER TABLE `trades` ADD `import_notes` text;--> statement-breakpoint
CREATE INDEX `trades_acquisition_idx` ON `trades` (`acquisition`);
