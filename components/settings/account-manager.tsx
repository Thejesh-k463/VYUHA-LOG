"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { Card,CardContent,CardHeader,CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { AccountDeleteDialog } from "@/components/settings/account-delete-dialog";
import { AccountPlanEditor, type PlanChoice } from "@/components/settings/account-plan-editor";
import { groupByTaxPerson, knownTaxIdentities } from "@/lib/domain/tax-person";

type AccountRow={id:number;name:string;broker:string|null;accountRef:string|null;taxIdentity?:string|null;equityCapital:number|null;activeCapital:number|null;archived:boolean;isDefault:boolean;brokerPlan?:string|null;brokerPlanFrom?:string|null};

/**
 * v4.5.0 wave TP — the TAX PERSON field (owner ruling T1).
 *
 * `accounts.tax_identity` already existed and had no reader; it is now what
 * every tax surface groups on. The control is FREE TEXT — never validated as a
 * PAN, never sent anywhere — with a datalist of the identities already in use,
 * because a typo mints a second person and silently halves an exemption. The
 * list below GROUPS the accounts by person so what is merged is visible.
 *
 * The write is a route handler + fetch + router.refresh(), never a server
 * action (house rule: a server action remounts the sibling client components
 * and resets their state).
 */
function TaxPersonField({account}:{account:AccountRow}){
  const router=useRouter();
  const[value,setValue]=useState(account.taxIdentity??"");
  const[busy,setBusy]=useState(false);
  const dirty=(value.trim())!==((account.taxIdentity??"").trim());
  async function save(){
    setBusy(true);
    await fetch("/api/accounts",{method:"POST",headers:{"Content-Type":"application/json"},
      body:JSON.stringify({action:"upsert",id:account.id,name:account.name,taxIdentity:value.trim()||null})});
    setBusy(false);
    router.refresh();
  }
  return <div className="mt-2">
    <Label className="text-[0.6875rem] text-muted-foreground" htmlFor={`taxid-${account.id}`}>Tax person (name or PAN — accounts sharing this are taxed together)</Label>
    <div className="mt-1 flex items-center gap-1.5">
      <Input id={`taxid-${account.id}`} list="vyuha-tax-identities" className="h-7 text-xs" value={value} placeholder="e.g. Thejesh K"
        onChange={e=>setValue(e.target.value)}/>
      <Button type="button" size="sm" variant="outline" className="h-7 px-2 text-[0.6875rem]" disabled={!dirty||busy} onClick={()=>void save()}>{busy?"Saving…":"Save"}</Button>
    </div>
  </div>;
}

export function AccountManager({accounts,planOptions={}}:{accounts:AccountRow[];
  /** v4.5.0 wave U — plan choices per broker, DERIVED from charge_config by the
   *  server page (`brokerPlanOptions`). A broker absent from this map sells one
   *  plan, so its accounts render no plan control at all. */
  planOptions?:Record<string,PlanChoice[]>}){const router=useRouter();const[busy,setBusy]=useState(false);const[deleteId,setDeleteId]=useState<number|null>(null);const deleteFor=accounts.find(a=>a.id===deleteId)??null;
  const identities=knownTaxIdentities(accounts);
  const groups=groupByTaxPerson(accounts);
  async function save(form:HTMLFormElement){const f=new FormData(form);setBusy(true);await fetch("/api/accounts",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({action:"upsert",name:f.get("name"),broker:f.get("broker")||null,accountRef:f.get("ref")||null,taxIdentity:(f.get("taxIdentity") as string||"").trim()||null,equityCapital:Number(f.get("equity"))||null,activeCapital:Number(f.get("active"))||null,archived:false})});setBusy(false);form.reset();router.refresh();}
  const card=(a:AccountRow)=><div key={a.id} className="rounded-md border border-border p-3 text-xs"><div className="flex items-start justify-between gap-2"><p className="font-medium">{a.name}</p>{accounts.length>1&&<Button type="button" variant="ghost" size="sm" className="h-6 px-2 text-[0.6875rem] text-loss" onClick={()=>setDeleteId(a.id)}>Delete</Button>}</div><p className="text-muted-foreground">{a.broker||"Any broker"}{a.accountRef?` · ${a.accountRef}`:""}</p><p className="mt-1 tabular-nums">Equity {a.equityCapital==null?"inherits global":`₹${a.equityCapital.toLocaleString("en-IN")}`} · F&O {a.activeCapital==null?"inherits global":`₹${a.activeCapital.toLocaleString("en-IN")}`}</p>{(()=>{const opts=planOptions[(a.broker??"").trim().toLowerCase()];return opts&&opts.length>1?<AccountPlanEditor account={{id:a.id,name:a.name,broker:a.broker,brokerPlan:a.brokerPlan??null,brokerPlanFrom:a.brokerPlanFrom??null}} options={opts}/>:null;})()}<TaxPersonField account={a}/></div>;
  return <Card><CardHeader><CardTitle>Portfolio accounts</CardTitle></CardHeader><CardContent className="space-y-4">
    {/* One datalist for every field on the page — suggesting what is already in
        use is what stops a typo becoming a second tax person. */}
    <datalist id="vyuha-tax-identities">{identities.map(i=><option key={i} value={i}/>)}</datalist>
    <div className="space-y-4">{groups.map(g=><div key={g.key}>
      <p className="mb-1 text-[0.6875rem] font-medium text-muted-foreground">
        {g.unassigned?"No tax person set — stands alone for tax":`Tax person: ${g.label}`}
      </p>
      <div className="grid gap-2 md:grid-cols-3">{g.accounts.map(a=>card(a as AccountRow))}</div>
    </div>)}</div>
    {deleteFor&&<AccountDeleteDialog account={deleteFor} accounts={accounts} open={deleteId!==null} onOpenChange={v=>{if(!v)setDeleteId(null);}}/>}
    <form className="grid gap-3 md:grid-cols-6" onSubmit={e=>{e.preventDefault();void save(e.currentTarget)}}><div><Label>Name</Label><Input name="name" required placeholder="Primary Zerodha"/></div><div><Label>Broker</Label><Input name="broker" placeholder="zerodha"/></div><div><Label>Account ref</Label><Input name="ref" placeholder="masked ID"/></div><div><Label>Tax person</Label><Input name="taxIdentity" list="vyuha-tax-identities" placeholder="name or PAN"/></div><div><Label>Equity capital ₹</Label><Input name="equity" type="number" min="0"/></div><div><Label>F&O capital ₹</Label><Input name="active" type="number" min="0"/></div><div className="flex items-end"><Button disabled={busy}>{busy?"Saving…":"Add account"}</Button></div></form>
    <p className="text-[0.6875rem] text-muted-foreground">Account references are labels, not login credentials. “All accounts” consolidates the book; selecting one scopes account-aware reports and new imports. Tax reports follow the TAX PERSON: accounts sharing one tax identity are taxed together, and an account with none stands alone.</p></CardContent></Card>}
