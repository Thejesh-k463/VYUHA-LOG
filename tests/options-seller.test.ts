import { describe,expect,it } from "vitest";
import { optionsSellerReport } from "@/lib/analytics/options-seller";
describe("options seller analytics",()=>{it("measures premium capture, IV change and hedging",()=>{const r=optionsSellerReport([{id:1,symbol:"NIFTY",sellQty:50,buyQty:50,avgSellPrice:100,avgBuyPrice:40,netPnl:2900,riskAmount:10000,entryIv:20,exitIv:15,entryDte:7,hedgeStatus:"hedged",expiryOutcome:"squared_off",adjustmentGroup:null,isOpen:false}]);expect(r.capturePct).toBe(60);expect(r.rows[0].ivChange).toBe(-5);expect(r.hedgedPct).toBe(100);});});
