-- Appearance settings (v2.99.97): tint intensity, panel style, custom theme,
-- wallpaper. See lib/domain/appearance.ts for what each column drives.
--
-- All defaults reproduce the shipped look exactly: tint 50 is the calibrated
-- midpoint of the chrome-tint curve, panel_style 'luxe' is the gradient look
-- every install has rendered since v3, and a NULL custom_theme / wallpaper is
-- "none". No existing row changes appearance on upgrade.
--
-- Preferences, not machine state: these travel with a backup like theme and
-- accent_skin do. wallpaper_stored_name is a FILE name in the app-data
-- wallpaper directory (the upload route owns it), so a restore onto a machine
-- without that file simply renders no wallpaper.
ALTER TABLE `settings` ADD COLUMN `tint_intensity` integer DEFAULT 50 NOT NULL;--> statement-breakpoint
ALTER TABLE `settings` ADD COLUMN `panel_style` text DEFAULT 'luxe' NOT NULL;--> statement-breakpoint
ALTER TABLE `settings` ADD COLUMN `custom_theme` text;--> statement-breakpoint
ALTER TABLE `settings` ADD COLUMN `wallpaper_stored_name` text;--> statement-breakpoint
ALTER TABLE `settings` ADD COLUMN `wallpaper_opacity` integer DEFAULT 35 NOT NULL;
