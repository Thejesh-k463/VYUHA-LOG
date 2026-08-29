import { NextResponse } from "next/server";
import { revalidatePath } from "next/cache";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/lib/db";
import { accounts, settings } from "@/lib/db/schema";
import { recordAudit } from "@/lib/audit";
import { deleteAccount, previewAccountDelete } from "@/lib/queries/account-delete";
export const runtime="nodejs";
const upsert=z.object({action:z.literal("upsert"),id:z.number().int().positive().optional(),name:z.string().trim().min(1).max(60),broker:z.string().max(30).nullable().optional(),accountRef:z.string().max(80).nullable().optional(),taxIdentity:z.string().max(80).nullable().optional(),equityCapital:z.number().nonnegative().nullable().optional(),activeCapital:z.number().nonnegative().nullable().optional(),archived:z.boolean().default(false)});
// Account deletion (v3.1). targetId is validated by lib/queries/account-delete
// (exists, not self, not 0 — the getWriteAccountId rule), so a bad value gets a
// readable refusal rather than a bare 400.
const destructive=z.discriminatedUnion("action",[
  z.object({action:z.literal("delete"),id:z.number().int().positive(),mode:z.enum(["purge","merge"]),targetId:z.number().int().nullable().optional(),connections:z.enum(["delete","move"]).default("delete")}),
  z.object({action:z.literal("deletePreview"),id:z.number().int().positive(),mode:z.enum(["purge","merge"]),targetId:z.number().int().nullable().optional()}),
]);
export async function POST(req:Request){const body=await req.json().catch(()=>null);
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
  if(body?.action==="select"){const id=Number(body.id);if(!Number.isInteger(id)||id<0)return NextResponse.json({ok:false,message:"Invalid account."},{status:400});if(id>0&&!db.select().from(accounts).where(eq(accounts.id,id)).get())return NextResponse.json({ok:false,message:"Account not found."},{status:404});db.update(settings).set({selectedAccountId:id,updatedAt:new Date().toISOString()}).run();revalidatePath("/","layout");return NextResponse.json({ok:true});}const p=upsert.safeParse(body);if(!p.success)return NextResponse.json({ok:false,message:p.error.issues[0]?.message},{status:400});const {action:_action,id,...values}=p.data;void _action;let entityId=id;if(id)db.update(accounts).set({...values,updatedAt:new Date().toISOString()}).where(eq(accounts.id,id)).run();else entityId=db.insert(accounts).values(values).returning({id:accounts.id}).get()!.id;
  // Archiving the SELECTED account used to strand the user: the switcher
  // filters archived accounts out of its options while every scoped read kept
  // filtering on the archived id — a select with no matching option and no UI
  // path back (defect D8, 2026-08-12). Selection moves to a live account
  // (default first) the moment its account is archived.
  if(id&&values.archived){const sel=db.select({id:settings.selectedAccountId}).from(settings).limit(1).get()?.id;if(sel===id){const live=db.select({id:accounts.id,isDefault:accounts.isDefault}).from(accounts).where(eq(accounts.archived,false)).all();const next=live.find((a)=>a.isDefault)??live[0];if(next)db.update(settings).set({selectedAccountId:next.id,updatedAt:new Date().toISOString()}).run();revalidatePath("/","layout");}}
  recordAudit({entity:"account",entityId,action:id?"update":"create",summary:values.name,after:values,source:"ui"});revalidatePath("/settings");return NextResponse.json({ok:true,id:entityId});}
