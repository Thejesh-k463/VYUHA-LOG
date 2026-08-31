import * as XLSX from "xlsx";
import path from "node:path";

const norm = (s: string) => s.toLowerCase().replace(/[\s_.]/g, "");
for (const file of ["zerodha-taxpnl-fy2425.xlsx", "zerodha-taxpnl-fy2526.xlsx"]) {
  const wb = XLSX.readFile(path.join("tests", "fixtures", "redacted", file));
  const rows = XLSX.utils.sheet_to_json<string[]>(wb.Sheets[wb.SheetNames[0]!]!, { header: 1, raw: false, defval: "" }) as string[][];
  const hi = rows.findIndex((r) => r.map(norm).includes("entrydate"));
  const header = rows[hi]!;
  const ci = (name: string) => header.findIndex((c) => norm(c) === norm(name));
  const [cE, cX, cP, cB, cS] = [ci("entry date"), ci("exit date"), ci("profit"), ci("buy value"), ci("sell value")];
  console.log(file, "header row", hi, "cols entry/exit/profit:", cE, cX, cP);
  console.log("sample rows:", JSON.stringify(rows.slice(hi + 1, hi + 4).map(r => [r[cE], r[cX], r[cB], r[cS], r[cP]])));
  let total = 0, entryFirst = 0, exitFirst = 0, equal = 0;
  let overnight = 0, overnightEntryFirst = 0;
  for (const r of rows.slice(hi + 1)) {
    const e = Date.parse(String(r[cE] ?? ""));
    const x = Date.parse(String(r[cX] ?? ""));
    if (!Number.isFinite(e) || !Number.isFinite(x)) continue;
    total++;
    if (e < x) entryFirst++; else if (e > x) exitFirst++; else equal++;
    const sameDay = String(r[cE]).slice(0, 10) === String(r[cX]).slice(0, 10);
    if (!sameDay) { overnight++; if (e < x) overnightEntryFirst++; }
  }
  console.log({ total, entryFirst, exitFirst, equal, overnight, overnightEntryFirst });
}
