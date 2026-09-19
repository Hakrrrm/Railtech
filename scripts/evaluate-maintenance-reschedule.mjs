import { readFile, writeFile } from 'node:fs/promises'
import assert from 'node:assert/strict'
const env = Object.fromEntries((await readFile('frontend/.env','utf8')).split(/\r?\n/).filter(l=>/^[A-Z_]+=/.test(l)).map(l=>{const p=l.indexOf('=');return [l.slice(0,p),l.slice(p+1).trim().replace(/^['"]|['"]$/g,'')]}))
const base=env.VITE_SUPABASE_URL, key=env.VITE_SUPABASE_ANON_KEY
const headers={apikey:key,Authorization:`Bearer ${key}`,'Content-Type':'application/json'}
const bookings=async()=>{const r=await fetch(`${base}/rest/v1/maintenance_bookings?select=*`,{headers});assert(r.ok);return r.json()}
const before=await bookings();const session={sessionId:crypto.randomUUID(),sessionToken:crypto.randomUUID()+crypto.randomUUID()}
const results=[];let pending
async function act(action,extra={}){const r=await fetch(`${base}/functions/v1/maintenance-assistant`,{method:'POST',headers,body:JSON.stringify({action,...session,requestId:crypto.randomUUID(),...extra})});const v=await r.json();if(!r.ok)throw Error(v.error||r.status);return v}
async function ask(message){const v=await act('chat',{message});const text=v.messages.filter(m=>m.role==='assistant').at(-1)?.content;results.push({message,text,wordCount:text?.split(/\s+/).length,kind:v.plan?.kind,count:v.plan?.bookings?.length});console.log(JSON.stringify(results.at(-1)));return v}
try {
const source=before.filter(b=>['D23','D24'].includes(b.lrv_id)&&b.status==='confirmed'&&Date.parse(b.start_at)>Date.now());assert.equal(source.length,2,'Expected future V23/V24 fixtures')
const target=source[0].bay_id==='SPLRT-BAY-1'?'SPLRT-BAY-2':source[0].bay_id==='BAY-1'?'BAY-2':'BAY-1'
const preview=await ask(`Preview rescheduling V23 and V24 to ${target}. Keep their original dates and times. Do not add bookings.`)
assert.equal(preview.plan?.kind,'reschedule');assert.equal(preview.plan.bookings.length,2);assert(!preview.batch)
const proposal=await ask(`Reschedule V23 and V24 to ${target}. Keep their original dates and times.`)
pending=proposal.batch?.id;assert(pending);assert.equal(proposal.plan?.kind,'reschedule');assert.equal(proposal.plan.bookings.length,2)
assert.deepEqual(await bookings(),before,'Proposal changed original bookings')
await act('discard',{batchId:pending});pending=null
await ask('Which vehicle is most urgent? One short answer please.')
assert(results.every(r=>r.wordCount<=100),'Reply exceeds concise target')
assert.deepEqual(await bookings(),before,'Evaluation changed bookings')
await writeFile('docs/maintenance-reschedule-evaluation.json',JSON.stringify({evaluatedAt:new Date().toISOString(),model:'gpt-4.1-mini',passed:3,bookingsUnchanged:true,results},null,2)+'\n')
} catch(error) {
  assert.deepEqual(await bookings(),before,'Evaluation changed bookings')
  await writeFile('docs/maintenance-reschedule-evaluation.json',JSON.stringify({evaluatedAt:new Date().toISOString(),model:'gpt-4.1-mini',completed:results.length,blocked:error.message,bookingsUnchanged:true,results},null,2)+'\n')
  throw error
} finally {if(pending)await act('discard',{batchId:pending})}
