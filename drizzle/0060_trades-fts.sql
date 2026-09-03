-- Full-text search over trades (v3.8, Search v1) + three lookup indexes.
--
-- `trades_fts` is an FTS5 EXTERNAL-CONTENT index (it stores tokens only; the
-- text stays in `trades`) with the TRIGGRAM tokenizer, so a query matches
-- mid-word ("kou" finds "breakout") — the search box is for half-remembered
-- notes and partial symbols, not whole words. Three or more characters per
-- term is the tokenizer's rule; shorter terms match nothing.
--
-- The content is read through the VIEW `trades_fts_src`, not `trades`
-- directly, for one reason: `mistake_tags` is JSON text ('["fomo","chased"]')
-- and the index must carry the WORDS, not the punctuation. Whatever transform
-- produces the indexed text has to be applied identically on insert, on
-- delete (an external-content 'delete' must be handed the exact text that was
-- indexed, or stale tokens survive and the index reports phantom rows), and by
-- 'rebuild' — and 'rebuild' only ever reads the content table. Defining the
-- transform ONCE, in the view, is what keeps all three paths the same; the
-- triggers select from the view rather than restating it. The transform is a
-- replace() chain rather than json_each(): a table-valued function inside a
-- view fails with "no such table: main.json_each" when FTS5 reads the view
-- during 'rebuild' (SQLite 3.53.2, verified), and a JSON array of short tag
-- strings has nothing json_each would parse that replace() does not. Invalid
-- JSON (json_valid = 0) is indexed as its raw text; NULL is indexed as ''.
--
-- Triggers: AFTER INSERT and AFTER UPDATE index the new row from the view;
-- BEFORE DELETE and BEFORE UPDATE remove the old row's tokens — BEFORE, because
-- the view can only be read while the row still exists. The UPDATE pair is
-- scoped to the nine indexed columns so a P&L or MTM write costs nothing here.
-- A statement that aborts after a BEFORE trigger (constraint failure) rolls
-- the trigger's write back with it — SQLite statement journal.
--
-- FUTURE MIGRATIONS: an ALTER that rebuilds `trades` (create-copy-drop-rename)
-- drops these triggers with the old table. Re-create them and run 'rebuild'.
--
-- Not expressible in drizzle: the virtual table, the view and the triggers
-- have no schema.ts mirror (lib/db/schema.ts carries a comment beside the
-- trades index extras). The three plain indexes below ARE mirrored there.
CREATE VIEW `trades_fts_src` AS
SELECT
	`id`,
	coalesce(`symbol`, '') AS `symbol`,
	coalesce(`tradingsymbol`, '') AS `tradingsymbol`,
	coalesce(`isin`, '') AS `isin`,
	coalesce(`broker`, '') AS `broker`,
	coalesce(`setup_tag`, '') AS `setup_tag`,
	coalesce(`notes`, '') AS `notes`,
	CASE
		WHEN `mistake_tags` IS NULL THEN ''
		WHEN json_valid(`mistake_tags`) THEN replace(replace(replace(replace(`mistake_tags`, '[', ''), ']', ''), '"', ''), ',', ' ')
		ELSE `mistake_tags`
	END AS `mistake_tags`,
	coalesce(`emotion_tag`, '') AS `emotion_tag`,
	coalesce(`exit_trigger`, '') AS `exit_trigger`
FROM `trades`;
--> statement-breakpoint
CREATE VIRTUAL TABLE `trades_fts` USING fts5(
	`symbol`, `tradingsymbol`, `isin`, `broker`, `setup_tag`, `notes`, `mistake_tags`, `emotion_tag`, `exit_trigger`,
	content='trades_fts_src', content_rowid='id', tokenize='trigram'
);
--> statement-breakpoint
CREATE TRIGGER `trades_fts_ai` AFTER INSERT ON `trades` BEGIN
	INSERT INTO `trades_fts`(rowid, `symbol`, `tradingsymbol`, `isin`, `broker`, `setup_tag`, `notes`, `mistake_tags`, `emotion_tag`, `exit_trigger`)
	SELECT `id`, `symbol`, `tradingsymbol`, `isin`, `broker`, `setup_tag`, `notes`, `mistake_tags`, `emotion_tag`, `exit_trigger`
	FROM `trades_fts_src` WHERE `id` = new.`id`;
END;
--> statement-breakpoint
CREATE TRIGGER `trades_fts_bd` BEFORE DELETE ON `trades` BEGIN
	INSERT INTO `trades_fts`(`trades_fts`, rowid, `symbol`, `tradingsymbol`, `isin`, `broker`, `setup_tag`, `notes`, `mistake_tags`, `emotion_tag`, `exit_trigger`)
	SELECT 'delete', `id`, `symbol`, `tradingsymbol`, `isin`, `broker`, `setup_tag`, `notes`, `mistake_tags`, `emotion_tag`, `exit_trigger`
	FROM `trades_fts_src` WHERE `id` = old.`id`;
END;
--> statement-breakpoint
CREATE TRIGGER `trades_fts_bu` BEFORE UPDATE OF `symbol`, `tradingsymbol`, `isin`, `broker`, `setup_tag`, `notes`, `mistake_tags`, `emotion_tag`, `exit_trigger` ON `trades` BEGIN
	INSERT INTO `trades_fts`(`trades_fts`, rowid, `symbol`, `tradingsymbol`, `isin`, `broker`, `setup_tag`, `notes`, `mistake_tags`, `emotion_tag`, `exit_trigger`)
	SELECT 'delete', `id`, `symbol`, `tradingsymbol`, `isin`, `broker`, `setup_tag`, `notes`, `mistake_tags`, `emotion_tag`, `exit_trigger`
	FROM `trades_fts_src` WHERE `id` = old.`id`;
END;
--> statement-breakpoint
CREATE TRIGGER `trades_fts_au` AFTER UPDATE OF `symbol`, `tradingsymbol`, `isin`, `broker`, `setup_tag`, `notes`, `mistake_tags`, `emotion_tag`, `exit_trigger` ON `trades` BEGIN
	INSERT INTO `trades_fts`(rowid, `symbol`, `tradingsymbol`, `isin`, `broker`, `setup_tag`, `notes`, `mistake_tags`, `emotion_tag`, `exit_trigger`)
	SELECT `id`, `symbol`, `tradingsymbol`, `isin`, `broker`, `setup_tag`, `notes`, `mistake_tags`, `emotion_tag`, `exit_trigger`
	FROM `trades_fts_src` WHERE `id` = new.`id`;
END;
--> statement-breakpoint
CREATE INDEX `trades_symbol_idx` ON `trades` (`symbol`);
--> statement-breakpoint
CREATE INDEX `trades_isin_idx` ON `trades` (`isin`);
--> statement-breakpoint
CREATE INDEX `trades_tradingsymbol_idx` ON `trades` (`tradingsymbol`);
--> statement-breakpoint
INSERT INTO `trades_fts`(`trades_fts`) VALUES ('rebuild');
