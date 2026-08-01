"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { Select } from "@/components/ui/select";
export function AccountSwitcher({accounts,selected,compact=false}:{accounts:{id:number;name:string;archived:boolean}[];selected:number;compact?:boolean}){const router=useRouter();const[busy,setBusy]=useState(false);return <Select aria-label="Portfolio account" className={compact?"h-8 text-xs":"h-9"} disabled={busy} value={String(selected)} onChange={async(e)=>{setBusy(true);await fetch("/api/accounts",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({action:"select",id:Number(e.target.value)})});setBusy(false);router.refresh();}}><option value="0">All accounts</option>{accounts.filter(a=>!a.archived).map(a=><option key={a.id} value={a.id}>{a.name}</option>)}</Select>}
