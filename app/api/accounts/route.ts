import { NextResponse } from "next/server";
import { revalidatePath } from "next/cache";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/lib/db";
import { accounts, settings } from "@/lib/db/schema";
import { recordAudit } from "@/lib/audit";
export const runtime="nodejs";
const upsert=z.object({action:z.literal("upsert"),id:z.number().int().positive().optional(),name:z.string().min(1).max(60),broker:z.string().max(30).nullable().optional(),accountRef:z.string().max(80).nullable().optional(),taxIdentity:z.string().max(80).nullable().optional(),equityCapital:z.number().nonnegative().nullable().optional(),activeCapital:z.number().nonnegative().nullable().optional(),archived:z.boolean().default(false)});
export async function POST(req:Request){const body=await req.json().catch(()=>null);if(body?.action==="select"){const id=Number(body.id);if(!Number.isInteger(id)||id<0)return NextResponse.json({ok:false,message:"Invalid account."},{status:400});if(id>0&&!db.select().from(accounts).where(eq(accounts.id,id)).get())return NextResponse.json({ok:false,message:"Account not found."},{status:404});db.update(settings).set({selectedAccountId:id,updatedAt:new Date().toISOString()}).run();revalidatePath("/","layout");return NextResponse.json({ok:true});}const p=upsert.safeParse(body);if(!p.success)return NextResponse.json({ok:false,message:p.error.issues[0]?.message},{status:400});const {action:_action,id,...values}=p.data;void _action;let entityId=id;if(id)db.update(accounts).set({...values,updatedAt:new Date().toISOString()}).where(eq(accounts.id,id)).run();else entityId=db.insert(accounts).values(values).returning({id:accounts.id}).get()!.id;recordAudit({entity:"account",entityId,action:id?"update":"create",summary:values.name,after:values,source:"ui"});revalidatePath("/settings");return NextResponse.json({ok:true,id:entityId});}
