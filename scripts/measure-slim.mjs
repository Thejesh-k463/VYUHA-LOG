// One-shot measurement: full Trade rows vs the SlimTrade wire projection,
// against the real dev DB (read-only). Run: node scripts/measure-slim.mjs
import Database from "better-sqlite3";

const db = new Database("data/vyuha.sqlite", { readonly: true });
const rows = db.prepare("select * from trades").all();
db.close();

// Mirror lib/domain/slim-trade.ts (snake_case here — raw sqlite rows).
const SLIM = [
  "id","account_id","broker","bucket","segment","instrument_type","exchange",
  "import_batch_id","created_at","symbol","tradingsymbol","expiry","strike",
  "option_type","lot_size","buy_qty","avg_buy_price","sell_qty","avg_sell_price",
  "buy_date","sell_date","buy_value_paise","sell_value_paise","gross_pnl_paise",
  "charges_total_paise","net_pnl_paise","r_multiple","mtf_interest_paise",
  "unrealised_pnl_paise","closing_price","is_open","staged","sl_planned",
  "trailing_sl","target_planned","risk_amount_paise","mtf_funded_amount_paise",
  "setup_tag","playbook_id","emotion_tag","mistake_tags","notes","rule_violations",
];
const present = SLIM.filter((k) => k in rows[0]);
const slim = rows.map((r) => Object.fromEntries(present.map((k) => [k, r[k]])));

const full = JSON.stringify(rows).length;
const thin = JSON.stringify(slim).length;
console.log(`rows: ${rows.length}`);
console.log(`full: ${(full / rows.length).toFixed(0)} B/row  (${(full / 1024).toFixed(0)} KB total)`);
console.log(`slim: ${(thin / rows.length).toFixed(0)} B/row  (${(thin / 1024).toFixed(0)} KB total)`);
console.log(`cut:  ${(100 - (thin / full) * 100).toFixed(1)}%  → at 10k rows: ${((thin / rows.length) * 10000 / 1024 / 1024).toFixed(1)} MB vs ${((full / rows.length) * 10000 / 1024 / 1024).toFixed(1)} MB`);
