import { NextResponse } from "next/server";
import { revalidatePath } from "next/cache";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/lib/db";
import { trades } from "@/lib/db/schema";
import { recordAudit } from "@/lib/audit";
export const runtime = "nodejs";
const schema = z.object({ id: z.number().int().positive(), entryIv: z.number().nonnegative().nullable(), exitIv: z.number().nonnegative().nullable(), entryDte: z.number().int().nonnegative().nullable(), hedgeStatus: z.enum(["unhedged","partial","hedged","not_applicable"]).nullable(), expiryOutcome: z.enum(["open","squared_off","expired_worthless","exercised","assigned"]).nullable(), adjustmentGroup: z.string().max(80).nullable() });
export async function POST(req: Request) { const p = schema.safeParse(await req.json().catch(()=>null)); if (!p.success) return NextResponse.json({ok:false,message:p.error.issues[0]?.message},{status:400}); const before=db.select().from(trades).where(eq(trades.id,p.data.id)).get(); if (!before || before.instrumentType !== "option") return NextResponse.json({ok:false,message:"Option trade not found."},{status:404}); const {id,...values}=p.data; db.update(trades).set({...values,updatedAt:new Date().toISOString()}).where(eq(trades.id,id)).run(); recordAudit({entity:"trade",entityId:id,action:"update",summary:"options journal fields",before,after:{...before,...values},source:"ui"}); revalidatePath("/options-journal"); return NextResponse.json({ok:true}); }
