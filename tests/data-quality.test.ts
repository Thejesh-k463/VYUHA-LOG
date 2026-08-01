import { describe, expect, it } from "vitest";
import { assessDataQuality, type QualityTrade } from "@/lib/analytics/data-quality";
const trade = (p: Partial<QualityTrade> = {}): QualityTrade => ({ id: 1, isOpen: false, acquisition: null, acquisitionPrice: null, closingPrice: null, slPlanned: 90, riskAmount: 1000, segment: "eq_delivery", mtfFundedAmount: null, instrumentType: "equity", expiry: null, strike: null, optionType: null, symbol: "ABC", ...p });
describe("data quality", () => {
  it("scores complete records at 100", () => { const r=assessDataQuality({trades:[trade()],markedTradeIds:new Set(),knownSymbols:new Set(["ABC"]),ipoLinkedTradeIds:new Set(),staleMtmCount:0,missingAttachmentFiles:0}); expect(r.score).toBe(100); expect(r.issues).toHaveLength(0); });
  it("surfaces money-changing unknowns as critical", () => { const r=assessDataQuality({trades:[trade({acquisition:"unknown"}),trade({id:2,isOpen:true,slPlanned:null,riskAmount:null})],markedTradeIds:new Set(),knownSymbols:new Set(["ABC"]),ipoLinkedTradeIds:new Set(),staleMtmCount:0,missingAttachmentFiles:0}); expect(r.issues.find(x=>x.code==="unknown_basis")?.severity).toBe("critical"); expect(r.issues.find(x=>x.code==="unmarked_open")?.count).toBe(1); expect(r.score).toBeLessThan(100); });
});
