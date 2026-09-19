import { readFile } from 'node:fs/promises'
import assert from 'node:assert/strict'
const env=Object.fromEntries((await readFile('frontend/.env','utf8')).split(/\r?\n/).filter(l=>/^[A-Z_]+=/.test(l)).map(l=>{const p=l.indexOf('=');return[l.slice(0,p),l.slice(p+1).trim().replace(/^['"]|['"]$/g,'')]}))
const headers={apikey:env.VITE_SUPABASE_ANON_KEY,Authorization:`Bearer ${env.VITE_SUPABASE_ANON_KEY}`,'Content-Type':'application/json'}
for(const messages of [['i need to clear bay 1 on 21 sept where can i reschedule to?'],['clear bay 1','21 sept']]){
 const session={sessionId:crypto.randomUUID(),sessionToken:crypto.randomUUID()+crypto.randomUUID()}
 let state
 for(const message of messages){const r=await fetch(`${env.VITE_SUPABASE_URL}/functions/v1/maintenance-assistant`,{method:'POST',headers,body:JSON.stringify({action:'chat',...session,message,requestId:crypto.randomUUID()})});state=await r.json();assert(r.ok,state.error);console.log(message, state.messages.at(-1)?.content)}
 assert(!state.batch)
 assert(!/Which date|What would you like to check/.test(state.messages.at(-1)?.content))
 assert(state.plan || /no active maintenance bookings/.test(state.messages.at(-1)?.content))
}
console.log('PASS deployed named-date and date-only clarification; no proposals saved')
