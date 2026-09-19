import { buildBayClearancePlan } from '../supabase/functions/_shared/assistantBayScope.js'
import { readFile, writeFile } from 'node:fs/promises'
import assert from 'node:assert/strict'
const env=Object.fromEntries((await readFile('frontend/.env','utf8')).split(/\r?\n/).filter(l=>/^[A-Z_]+=/.test(l)).map(l=>{const p=l.indexOf('=');return[l.slice(0,p),l.slice(p+1).trim().replace(/^['"]|['"]$/g,'')]}))
const base=env.VITE_SUPABASE_URL, headers={apikey:env.VITE_SUPABASE_ANON_KEY,Authorization:`Bearer ${env.VITE_SUPABASE_ANON_KEY}`,'Content-Type':'application/json'}
const session={sessionId:crypto.randomUUID(),sessionToken:crypto.randomUUID()+crypto.randomUUID()}
const rows=async()=>{const r=await fetch(`${base}/rest/v1/maintenance_bookings?select=*&order=id`,{headers});assert(r.ok);return r.json()}
const before=await rows();let pending;const results=[]
const act=async(action,extra={})=>{const r=await fetch(`${base}/functions/v1/maintenance-assistant`,{method:'POST',headers,body:JSON.stringify({action,...session,requestId:crypto.randomUUID(),...extra})});const v=await r.json();assert(r.ok,v.error);return v}
const ask=async(message)=>{const v=await act('chat',{message});pending=v.batch?.status==='proposed'?v.batch.id:null;const text=v.messages.filter(m=>m.role==='assistant').at(-1)?.content;results.push({message,text,intent:v.planningPreferences?.intent,count:v.plan?.bookings?.length,status:v.batch?.status});console.log(JSON.stringify(results.at(-1)));return v}
const discard=async()=>{if(pending){await act('discard',{batchId:pending});pending=null}}
try {
 const date = new Date(Date.now()+8*3600000+3*86400000).toISOString().slice(0,10)
 const named = new Date(`${date}T00:00:00Z`).toLocaleDateString('en-GB',{day:'numeric',month:'short',timeZone:'UTC'})
 for (const [message,day] of [[`Both bays will be closed on ${named}, help me reschedule`,date],['Clear bookings for tomorrow',new Date(Date.now()+8*3600000+86400000).toISOString().slice(0,10)]]) {
   const start=Date.parse(`${day}T00:00:00+08:00`),end=start+86400000
   const expected=before.filter(b=>b.status==='confirmed'&&Date.parse(b.start_at)>Date.now()&&Date.parse(b.start_at)<end&&Date.parse(b.end_at)>start).map(b=>b.id).sort()
   assert(expected.length)
   const v=await ask(message)
   assert(pending,'Expected a persisted whole-day proposal')
   assert.deepEqual(v.plan.bookings.map(b=>b.bookingId).sort(),expected)
   assert(v.plan.bookings.every(b=>Date.parse(b.startAt)>=end||Date.parse(b.endAt)<=start),'Proposal still occupies closed day')
   assert.deepEqual(await rows(),before,'Original bookings changed before confirmation')
   await discard()
 }
 console.log('PASS natural whole-day requests, database proposal persistence, complete source selection and unchanged originals')
}finally{await discard();await writeFile('docs/whole-day-clearance-evaluation.json',JSON.stringify({at:new Date().toISOString(),results},null,2)+'\n')}
