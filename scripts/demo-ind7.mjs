// Reversible demo fixture for verifying the IND-7 physical-settlement panel.
//   node scripts/demo-ind7.mjs insert   → add demo open F&O + spot rows
//   node scripts/demo-ind7.mjs clean    → delete exactly what was inserted
// Inserted ids are recorded in scripts/.demo-ind7.json so cleanup is precise.
import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";

const dbPath = path.join(process.cwd(), "data", "vyuha.sqlite");
const stateFile = path.join(process.cwd(), "scripts", ".demo-ind7.json");
const db = new Database(dbPath);
const mode = process.argv[2];

const iso = (d) => d.toISOString().slice(0, 10);
const plus = (n) => { const d = new Date(); d.setDate(d.getDate() + n); return iso(d); };
const today = iso(new Date());

if (mode === "insert") {
  const tradeIds = [];
  const mtmIds = [];
  const insTrade = db.prepare(`
    INSERT INTO trades (broker,bucket,segment,instrument_type,exchange,symbol,tradingsymbol,
      expiry,strike,option_type,lot_size,buy_qty,avg_buy_price,buy_value,is_open,
      source_file,dedup_hash)
    VALUES (@broker,@bucket,@segment,@instrument_type,@exchange,@symbol,@tradingsymbol,
      @expiry,@strike,@option_type,@lot_size,@buy_qty,@avg_buy_price,@buy_value,1,
      'demo-ind7',@dedup_hash)`);
  const insMtm = db.prepare(`
    INSERT INTO mtm_prices (symbol,tradingsymbol,price,as_of_date) VALUES (?,?,?,?)`);

  const trades = [
    { broker:"dhan", bucket:"active", segment:"future", instrument_type:"future", exchange:"NSE",
      symbol:"RELIANCE", tradingsymbol:`FUT RELIANCE ${plus(1)}`, expiry:plus(1), strike:null,
      option_type:null, lot_size:250, buy_qty:250, avg_buy_price:2950, buy_value:737500,
      dedup_hash:"demo-ind7-fut-rel" },
    { broker:"dhan", bucket:"active", segment:"stock_option", instrument_type:"option", exchange:"NSE",
      symbol:"TCS", tradingsymbol:`OPT TCS ${plus(2)} 3600 CE`, expiry:plus(2), strike:3600,
      option_type:"CE", lot_size:175, buy_qty:175, avg_buy_price:120, buy_value:21000,
      dedup_hash:"demo-ind7-opt-tcs" },
    { broker:"dhan", bucket:"active", segment:"stock_option", instrument_type:"option", exchange:"NSE",
      symbol:"HDFCBANK", tradingsymbol:`OPT HDFCBANK ${plus(3)} 1700 PE`, expiry:plus(3), strike:1700,
      option_type:"PE", lot_size:550, buy_qty:550, avg_buy_price:25, buy_value:13750,
      dedup_hash:"demo-ind7-opt-hdfc" },
    { broker:"dhan", bucket:"active", segment:"index_option", instrument_type:"option", exchange:"NSE",
      symbol:"NIFTY", tradingsymbol:`OPT NIFTY ${plus(2)} 24000 CE`, expiry:plus(2), strike:24000,
      option_type:"CE", lot_size:75, buy_qty:75, avg_buy_price:180, buy_value:13500,
      dedup_hash:"demo-ind7-opt-nifty" },
  ];
  for (const t of trades) tradeIds.push(insTrade.run(t).lastInsertRowid);

  // spot rows: RELIANCE futures price (3000) + TCS underlying spot (3750, makes the 3600 CE ITM).
  mtmIds.push(insMtm.run("RELIANCE", `FUT RELIANCE ${plus(1)}`, 3000, today).lastInsertRowid);
  mtmIds.push(insMtm.run("TCS", "TCS", 3750, today).lastInsertRowid);
  // (HDFCBANK left without spot → demonstrates the "if-ITM" conditional branch.)

  fs.writeFileSync(stateFile, JSON.stringify({ tradeIds, mtmIds }, null, 2));
  console.log(`Inserted ${tradeIds.length} trades, ${mtmIds.length} spot rows. ids → ${stateFile}`);
} else if (mode === "clean") {
  if (!fs.existsSync(stateFile)) { console.log("No demo state file — nothing to clean."); process.exit(0); }
  const { tradeIds, mtmIds } = JSON.parse(fs.readFileSync(stateFile, "utf8"));
  const delT = db.prepare("DELETE FROM trades WHERE id = ?");
  const delM = db.prepare("DELETE FROM mtm_prices WHERE id = ?");
  for (const id of tradeIds) delT.run(id);
  for (const id of mtmIds) delM.run(id);
  fs.rmSync(stateFile);
  console.log(`Cleaned ${tradeIds.length} trades, ${mtmIds.length} spot rows.`);
} else {
  console.log("usage: node scripts/demo-ind7.mjs insert|clean");
}
db.close();
