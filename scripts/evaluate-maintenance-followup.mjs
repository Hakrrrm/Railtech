import { readFile } from 'node:fs/promises'
import assert from 'node:assert/strict'
const env = Object.fromEntries((await readFile('frontend/.env','utf8')).split(/\r?\n/).filter(l=>/^[A-Z_]+=/.test(l)).map(l=>{const p=l.indexOf('=');return [l.slice(0,p),l.slice(p+1).trim().replace(/^['"]|['"]$/g,'')]}))
const headers={apikey:env.VITE_SUPABASE_ANON_KEY,Authorization:`Bearer ${env.VITE_SUPABASE_ANON_KEY}`,'Content-Type':'application/json'}
const base=env.VITE_SUPABASE_URL
const bookings=async()=>{const r=await fetch(`${base}/rest/v1/maintenance_bookings?select=*&order=id`,{headers});assert(r.ok);return r.json()}
const before=await bookings()
const source=before.find(b=>b.status==='confirmed'&&Date.parse(b.start_at)>Date.now())
assert(source,'Need a future confirmed booking')
for(const message of ['sure do that','sounds good, go for it']){
 const session={sessionId:crypto.randomUUID(),sessionToken:crypto.randomUUID()+crypto.randomUUID()}; let pending
 const act=async(action,extra={})=>{const r=await fetch(`${base}/functions/v1/maintenance-assistant`,{method:'POST',headers,body:JSON.stringify({action,...session,requestId:crypto.randomUUID(),...extra})});const v=await r.json();assert(r.ok,v.error);return v}
 try{
 const date=new Date(Date.parse(source.start_at)+8*3600000).toISOString().slice(0,10)
 const number=source.bay_id.match(/\d+$/)[0]
 const preview=await act('chat',{message:`How could we clear bay ${number} on ${date}? Preview only; do not add a proposal yet.`})
 assert(preview.plan?.bookings?.length,'Need feasible preview')
 const proposed=await act('chat',{message});pending=proposed.batch?.id
 assert(pending,JSON.stringify(proposed.messages?.at(-1)))
 assert(proposed.plan.bookings.every(b=>preview.plan.bookings.some(p=>p.bookingId===b.bookingId)))
 assert.deepEqual(await bookings(),before,'Original bookings changed before confirmation')
 console.log(`PASS ${message}: ${proposed.plan.bookings.length} persisted move proposals, original bookings unchanged`)
 }finally{if(pending)await act('discard',{batchId:pending})}
}
