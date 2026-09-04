-- Full-text search over the CASH LEDGER and the AUDIT TRAIL (v3.9, Search v2).
--
-- Two more FTS5 EXTERNAL-CONTENT indexes in exactly the shape 0060 gave
-- `trades_fts`: a VIEW that defines the indexed text once, a virtual table
-- whose `content=` is that view, four triggers that keep it in step with the
-- base table, and a closing 'rebuild' so rows written before this migration
-- are indexed too. The TRIGRAM tokenizer again, so a query matches mid-word
-- ("harg" finds "charge") — three or more characters per term is the
-- tokenizer's rule; shorter terms match nothing.
--
-- The view exists for the same reason it does in 0060: whatever transform
-- produces the indexed text has to be applied identically on insert, on
-- delete (an external-content 'delete' must be handed the EXACT text that was
-- indexed, or stale tokens survive and the index reports phantom rows) and by
-- 'rebuild' — and 'rebuild' only ever reads the content table. Defining it
-- ONCE, in the view, is what keeps all three paths the same. Here the
-- transform is only coalesce(…, '') — NULL is indexed as '' — but the shape is
-- kept so a future column with structure has somewhere to go.
--
-- SCOPING. `ledger_entries` is account-scoped (invariant 8), so a ledger
-- search MUST filter on `account_id` — an unscoped read merges two books and
-- nothing on screen looks broken. The column is carried by the VIEW
-- `ledger_fts_src`, NOT as a column of `ledger_fts` itself, and a search joins
-- the match back to the base table:
--
--   SELECT l.id FROM ledger_fts f JOIN ledger_entries l ON l.id = f.rowid
--   WHERE ledger_fts MATCH ? AND (:acct = 0 OR l.account_id = :acct)
--
-- That is 0060's shape — `trades_fts` carries no account_id either, and
-- `trades` is account-scoped — and it is deliberate: an FTS5 virtual table
-- reports its declared columns to `pragma_table_info`, so an `account_id`
-- column here would enter the account-scoped-table registry
-- (tests/account-isolation.test.ts) as a table needing a scoped owner. An
-- index is not a place data lives; declaring it as one would make the registry
-- describe a boundary that does not exist.
-- `audit_log` HAS NO account_id COLUMN — the audit trail is global, one
-- append-only history for the whole install — so `audit_fts` has nothing to
-- scope BY. That is a property of the table, not an omission here: if
-- `audit_log` ever gains `account_id`, this index must gain it too and every
-- reader must start filtering.
--
-- Triggers: AFTER INSERT and AFTER UPDATE index the new row from the view;
-- BEFORE DELETE and BEFORE UPDATE remove the old row's tokens — BEFORE,
-- because the view can only be read while the row still exists. The UPDATE
-- pairs are scoped to the indexed columns so an unrelated write costs nothing
-- here. `audit_log` is documented append-only (never updated, never deleted),
-- but its triggers are written anyway: a table that is only *supposed* to be
-- append-only still leaves a corrupt index behind the day something updates
-- it, and an index that reports rows that are gone is worse than no index.
--
-- FUTURE MIGRATIONS: an ALTER that rebuilds either base table
-- (create-copy-drop-rename) drops these triggers with the old table.
-- Re-create them and run 'rebuild'.
--
-- Not expressible in drizzle: the virtual tables, the views and the triggers
-- have no schema.ts mirror — the same exception 0060 records there.
CREATE VIEW `ledger_fts_src` AS
SELECT
	`id`,
	coalesce(`note`, '') AS `note`,
	coalesce(`symbol`, '') AS `symbol`,
	coalesce(`type`, '') AS `type`,
	coalesce(`bucket`, '') AS `bucket`,
	coalesce(`date`, '') AS `date`,
	`account_id`
FROM `ledger_entries`;
--> statement-breakpoint
CREATE VIRTUAL TABLE `ledger_fts` USING fts5(
	`note`, `symbol`, `type`, `bucket`, `date`,
	content='ledger_fts_src', content_rowid='id', tokenize='trigram'
);
--> statement-breakpoint
CREATE TRIGGER `ledger_fts_ai` AFTER INSERT ON `ledger_entries` BEGIN
	INSERT INTO `ledger_fts`(rowid, `note`, `symbol`, `type`, `bucket`, `date`)
	SELECT `id`, `note`, `symbol`, `type`, `bucket`, `date`
	FROM `ledger_fts_src` WHERE `id` = new.`id`;
END;
--> statement-breakpoint
CREATE TRIGGER `ledger_fts_bd` BEFORE DELETE ON `ledger_entries` BEGIN
	INSERT INTO `ledger_fts`(`ledger_fts`, rowid, `note`, `symbol`, `type`, `bucket`, `date`)
	SELECT 'delete', `id`, `note`, `symbol`, `type`, `bucket`, `date`
	FROM `ledger_fts_src` WHERE `id` = old.`id`;
END;
--> statement-breakpoint
CREATE TRIGGER `ledger_fts_bu` BEFORE UPDATE OF `note`, `symbol`, `type`, `bucket`, `date` ON `ledger_entries` BEGIN
	INSERT INTO `ledger_fts`(`ledger_fts`, rowid, `note`, `symbol`, `type`, `bucket`, `date`)
	SELECT 'delete', `id`, `note`, `symbol`, `type`, `bucket`, `date`
	FROM `ledger_fts_src` WHERE `id` = old.`id`;
END;
--> statement-breakpoint
CREATE TRIGGER `ledger_fts_au` AFTER UPDATE OF `note`, `symbol`, `type`, `bucket`, `date` ON `ledger_entries` BEGIN
	INSERT INTO `ledger_fts`(rowid, `note`, `symbol`, `type`, `bucket`, `date`)
	SELECT `id`, `note`, `symbol`, `type`, `bucket`, `date`
	FROM `ledger_fts_src` WHERE `id` = new.`id`;
END;
--> statement-breakpoint
CREATE VIEW `audit_fts_src` AS
SELECT
	`id`,
	coalesce(`action`, '') AS `action`,
	coalesce(`entity`, '') AS `entity`,
	coalesce(`summary`, '') AS `summary`,
	coalesce(`ts`, '') AS `ts`
FROM `audit_log`;
--> statement-breakpoint
CREATE VIRTUAL TABLE `audit_fts` USING fts5(
	`action`, `entity`, `summary`, `ts`,
	content='audit_fts_src', content_rowid='id', tokenize='trigram'
);
--> statement-breakpoint
CREATE TRIGGER `audit_fts_ai` AFTER INSERT ON `audit_log` BEGIN
	INSERT INTO `audit_fts`(rowid, `action`, `entity`, `summary`, `ts`)
	SELECT `id`, `action`, `entity`, `summary`, `ts`
	FROM `audit_fts_src` WHERE `id` = new.`id`;
END;
--> statement-breakpoint
CREATE TRIGGER `audit_fts_bd` BEFORE DELETE ON `audit_log` BEGIN
	INSERT INTO `audit_fts`(`audit_fts`, rowid, `action`, `entity`, `summary`, `ts`)
	SELECT 'delete', `id`, `action`, `entity`, `summary`, `ts`
	FROM `audit_fts_src` WHERE `id` = old.`id`;
END;
--> statement-breakpoint
CREATE TRIGGER `audit_fts_bu` BEFORE UPDATE OF `action`, `entity`, `summary`, `ts` ON `audit_log` BEGIN
	INSERT INTO `audit_fts`(`audit_fts`, rowid, `action`, `entity`, `summary`, `ts`)
	SELECT 'delete', `id`, `action`, `entity`, `summary`, `ts`
	FROM `audit_fts_src` WHERE `id` = old.`id`;
END;
--> statement-breakpoint
CREATE TRIGGER `audit_fts_au` AFTER UPDATE OF `action`, `entity`, `summary`, `ts` ON `audit_log` BEGIN
	INSERT INTO `audit_fts`(rowid, `action`, `entity`, `summary`, `ts`)
	SELECT `id`, `action`, `entity`, `summary`, `ts`
	FROM `audit_fts_src` WHERE `id` = new.`id`;
END;
--> statement-breakpoint
INSERT INTO `ledger_fts`(`ledger_fts`) VALUES ('rebuild');
--> statement-breakpoint
INSERT INTO `audit_fts`(`audit_fts`) VALUES ('rebuild');
