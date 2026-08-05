import fs from 'fs';
import { parseTransgourmetCsv, findeCsvBestandsTreffer, lieferantFuerMarkt, DEFAULT_MARKT_LIEFERANTEN } from '../src/lib/waren-positionen';
const env = Object.fromEntries(fs.readFileSync('.env','utf8').split('\n').filter(l=>l.includes('=')).map(l=>[l.slice(0,l.indexOf('=')),l.slice(l.indexOf('=')+1).trim().replace(/^"|"$/g,'')]));
const REF = env.VITE_SUPABASE_PROJECT_ID;
async function q(query: string){ const r = await fetch(`https://api.supabase.com/v1/projects/${REF}/database/query`,{method:'POST',headers:{Authorization:`Bearer ${process.env.SUPABASE_ACCESS_TOKEN}`,'Content-Type':'application/json'},body:JSON.stringify({query})}); return r.json(); }
const text = fs.readFileSync('attached_assets/0_Rechnungen_Oliv_2026_1785788736110.csv','latin1');
const res = parseTransgourmetCsv(text);
console.log('Rechnungen geparst:', res.rechnungen.length, res.failureReason ?? '');
const monate = [...new Set(res.rechnungen.map(r=>r.datum.slice(0,7)))].sort();
const bestand: Record<string, any[]> = {};
for (const m of monate) {
  const rows = await q(`select value from app_settings where key = 'supplier_invoices_${m}'`);
  bestand[m] = rows?.[0]?.value ?? [];
}
let ersetzt=0, neu=0; const matchedIds = new Map<string,string>(); const probleme:string[]=[];
for (const r of res.rechnungen) {
  const lieferant = lieferantFuerMarkt(r.markt, DEFAULT_MARKT_LIEFERANTEN);
  if (!lieferant) { probleme.push(`Lieferant offen: ${r.docKey}`); continue; }
  const b = bestand[r.datum.slice(0,7)];
  const t = findeCsvBestandsTreffer(b, r, lieferant);
  if (t) {
    if (matchedIds.has(t.id)) probleme.push(`DOPPELT gematcht: ${t.id} von ${matchedIds.get(t.id)} UND ${r.docKey}`);
    matchedIds.set(t.id, r.docKey); ersetzt++;
  } else { neu++; probleme.push(`KEIN Treffer (würde neu anlegen): ${r.docKey}`); }
}
console.log(`ersetzt=${ersetzt} neu=${neu}`);
console.log(probleme.length ? probleme.join('\n') : 'OK: 1:1-idempotent, keine Kollisionen.');
