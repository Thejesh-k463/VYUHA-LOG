import { NextResponse } from "next/server";
import { revalidatePath } from "next/cache";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/lib/db";
import { accounts, settings } from "@/lib/db/schema";
import { recordAudit } from "@/lib/audit";
import { deleteAccount, previewAccountDelete } from "@/lib/queries/account-delete";
import { applyPlanChange, previewPlanChange } from "@/lib/queries/broker-plan";
export const runtime="nodejs";
const upsert=z.object({action:z.literal("upsert"),id:z.number().int().positive().optional(),name:z.string().trim().min(1).max(60),broker:z.string().max(30).nullable().optional(),accountRef:z.string().max(80).nullable().optional(),taxIdentity:z.string().max(80).nullable().optional(),equityCapital:z.number().nonnegative().nullable().optional(),activeCapital:z.number().nonnegative().nullable().optional(),/** v4.5.0 wave TP — OPTIONAL, no longer `.default(false)`. A partial upsert
   *  (the tax-person field saves id + name + taxIdentity) used to carry a
   *  defaulted `archived:false` into the UPDATE and silently un-archive the
   *  account it was editing. Omitted now means "leave it alone"; an INSERT
   *  still defaults to false below. */
  archived:z.boolean().optional(),
  /** v4.5.0 wave U — which of the broker's pricing plans this account is on,
   *  and from when (blank = always). Both null = "not stated", which prices at
   *  the free tier. An omitted field leaves the stored value alone, as every
   *  other field here does. */
  brokerPlan:z.string().max(30).nullable().optional(),
  brokerPlanFrom:z.string().regex(/^\d{4}-\d{2}-\d{2}$/,"Use YYYY-MM-DD for the plan start date.").nullable().optional()});
/**
 * "What would setting this plan move?" — asked BEFORE the plan is stored.
 *
 * The plan re-prices nothing that is already saved, with ONE exception: the
 * daily MTF accrual recomputes interest on still-OPEN rows and writes
 * chargesTotal / netPnl back. DECISIONS 2026-08-30 decision 6 forbids a stored
 * P&L moving with no prompt and no audit row, so the editor shows this preview
 * and the upsert (below) writes one audit row per row it moves.
 */
const planPreview=z.object({action:z.literal("planPreview"),id:z.number().int().positive(),brokerPlan:z.string().max(30).nullable().optional(),brokerPlanFrom:z.string().nullable().optional()});
// Account deletion (v3.1). targetId is validated by lib/queries/account-delete
// (exists, not self, not 0 — the getWriteAccountId rule), so a bad value gets a
// readable refusal rather than a bare 400.
const destructive=z.discriminatedUnion("action",[
  z.object({action:z.literal("delete"),id:z.number().int().positive(),mode:z.enum(["purge","merge"]),targetId:z.number().int().nullable().optional(),connections:z.enum(["delete","move"]).default("delete")}),
  z.object({action:z.literal("deletePreview"),id:z.number().int().positive(),mode:z.enum(["purge","merge"]),targetId:z.number().int().nullable().optional()}),
]);
export async function POST(req:Request){const body=await req.json().catch(()=>null);
  if(body?.action==="planPreview"){
    const q=planPreview.safeParse(body);
    if(!q.success)return NextResponse.json({ok:false,message:q.error.issues[0]?.message},{status:400});
    const prev=previewPlanChange(q.data.id,{brokerPlan:q.data.brokerPlan??null,brokerPlanFrom:q.data.brokerPlanFrom||null});
    return NextResponse.json({ok:true,...prev});
  }
  if(body?.action==="delete"||body?.action==="deletePreview"){
    const d=destructive.safeParse(body);
    if(!d.success)return NextResponse.json({ok:false,message:d.error.issues[0]?.message},{status:400});
    if(d.data.action==="deletePreview"){
      const prev=previewAccountDelete({accountId:d.data.id,mode:d.data.mode,targetId:d.data.targetId});
      return NextResponse.json(prev,{status:prev.ok?200:400});
    }
    const res=deleteAccount({accountId:d.data.id,mode:d.data.mode,targetId:d.data.targetId,connections:d.data.connections,source:"ui"});
    if(res.ok){revalidatePath("/","layout");revalidatePath("/settings");}
    return NextResponse.json(res,{status:res.ok?200:400});
  }
  if(body?.action==="select"){const id=Number(body.id);if(!Number.isInteger(id)||id<0)return NextResponse.json({ok:false,message:"Invalid account."},{status:400});if(id>0&&!db.select().from(accounts).where(eq(accounts.id,id)).get())return NextResponse.json({ok:false,message:"Account not found."},{status:404});db.update(settings).set({selectedAccountId:id,updatedAt:new Date().toISOString()}).run();revalidatePath("/","layout");return NextResponse.json({ok:true});}const p=upsert.safeParse(body);if(!p.success)return NextResponse.json({ok:false,message:p.error.issues[0]?.message},{status:400});const {action:_action,id,...values}=p.data;void _action;let entityId=id;
  // Wave U — A PLAN BELONGS TO A BROKER RELATIONSHIP, so changing the broker
  // ends it: the stored plan and its start date are nulled rather than left to
  // price another broker's trades (design review item 2, which `resolvePlan`
  // also refuses to do at pricing time — two doors, one rule).
  const prior=id?db.select().from(accounts).where(eq(accounts.id,id)).get():null;
  const brokerChanged=!!prior&&values.broker!==undefined&&(prior.broker??null)!==(values.broker??null);
  const write={...values,...(brokerChanged?{brokerPlan:null,brokerPlanFrom:null}:{}),...(id?{}:{archived:values.archived??false})};
  // The rows this plan change re-accrues, priced BEFORE the account row moves
  // (the preview the editor showed is computed the same way).
  const planMoves=id&&!brokerChanged&&(values.brokerPlan!==undefined||values.brokerPlanFrom!==undefined)
    ?previewPlanChange(id,{brokerPlan:values.brokerPlan??null,brokerPlanFrom:values.brokerPlanFrom??null})
    :null;
  if(id)db.update(accounts).set({...write,updatedAt:new Date().toISOString()}).where(eq(accounts.id,id)).run();else entityId=db.insert(accounts).values(write).returning({id:accounts.id}).get()!.id;
  // …and re-accrued immediately after it, one audit row each, so the figure the
  // user confirmed is the figure stored and the daily job finds nothing to move.
  const reaccrued=planMoves&&planMoves.rows.length>0?applyPlanChange(id!,planMoves,values.brokerPlan&&values.brokerPlan!=="default"?values.brokerPlan:"the free plan"):0;
  // Archiving the SELECTED account used to strand the user: the switcher
  // filters archived accounts out of its options while every scoped read kept
  // filtering on the archived id — a select with no matching option and no UI
  // path back (defect D8, 2026-08-12). Selection moves to a live account
  // (default first) the moment its account is archived.
  if(id&&values.archived){const sel=db.select({id:settings.selectedAccountId}).from(settings).limit(1).get()?.id;if(sel===id){const live=db.select({id:accounts.id,isDefault:accounts.isDefault}).from(accounts).where(eq(accounts.archived,false)).all();const next=live.find((a)=>a.isDefault)??live[0];if(next)db.update(settings).set({selectedAccountId:next.id,updatedAt:new Date().toISOString()}).run();revalidatePath("/","layout");}}
  recordAudit({entity:"account",entityId,action:id?"update":"create",summary:values.name,after:write,source:"ui"});revalidatePath("/settings");if(reaccrued)revalidatePath("/equity");return NextResponse.json({ok:true,id:entityId,...(brokerChanged?{planCleared:true}:{}),...(reaccrued?{reaccrued,reaccrueMessage:planMoves!.message}:{})});}
