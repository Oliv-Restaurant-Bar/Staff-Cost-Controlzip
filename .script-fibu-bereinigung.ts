/**
 * FIBU-Bereinigung Beaulieu 2026:
 *  A) Alias Rutishauser-Varianten + FIBU-Duplikat 91091909 löschen
 *  B) Hof-am-Stutz PDF-Duplikate löschen (FIBU-Übernahme behalten)
 * Dry-Run ohne --commit. Backup aller betroffenen Monate nach /tmp.
 */
import { loadMonthInvoices, deleteInvoiceEntry, loadAliasGruppen, saveAliasGruppen, type InvoiceEntry } from '@/lib/waren-db';
import { loadJournalEntriesFromDB } from '@/lib/reporting-store';
import * as fs from 'node:fs';

const TENANT = 'beaulieu'; const YEAR = 2026;
const COMMIT = process.argv.includes('--commit');
const f = (n: number) => n.toFixed(2);

(async () => {
  // Alle Monate laden
  const invByMonth = new Map<string, InvoiceEntry[]>();
  for (let m = 1; m <= 12; m++) {
    const mk = `${YEAR}-${String(m).padStart(2, '0')}`;
    invByMonth.set(mk, await loadMonthInvoices(TENANT, mk).catch(() => []));
  }
  const alle = [...invByMonth.values()].flat();
  const show = (e: InvoiceEntry) => `  ${e.date} | ${e.supplierName} | Ref ${e.reference ?? '—'} | netto ${f(e.amountNet)} / brutto ${f(e.amountGross)} | MwSt ${e.vatRate}% | quelle ${e.quelle ?? 'manuell/pdf'} | id ${e.id}`;

  // ── A) Rutishauser ──
  const ruti = alle.filter(e => /rutishauser/i.test(e.supplierName));
  console.log('— Rutishauser erfasst:'); ruti.forEach(e => console.log(show(e)));
  console.log(`  Σ netto: ${f(ruti.reduce((s, e) => s + e.amountNet, 0))}`);
  let rutiGeb = 0;
  for (let m = 1; m <= 12; m++) {
    const jr = await loadJournalEntriesFromDB(YEAR, m, TENANT).catch(() => []);
    for (const e of jr) if (/rutishauser/i.test(e.text ?? '')) rutiGeb += (e.soll ?? 0) - (e.haben ?? 0);
  }
  console.log(`  Buchhaltung Rutishauser: ${f(rutiGeb)}`);
  // FIBU-Duplikate zu 91091909 (PDF-Eintrag bleibt)
  const rutiDel = ruti.filter(e => e.quelle === 'fibu_uebernahme' && (e.reference ?? '').includes('91091909'));
  console.log('  → LÖSCHEN (FIBU-Duplikat 91091909):'); rutiDel.forEach(e => console.log(show(e)));
  const rutiNach = ruti.filter(e => !rutiDel.some(d => d.id === e.id)).reduce((s, e) => s + e.amountNet, 0);
  console.log(`  Rutishauser NACHHER: ${f(rutiNach)} (Ziel 1570.80)`);

  // ── B) Hof am Stutz ──
  const hof = alle.filter(e => /hof am stutz/i.test(e.supplierName));
  console.log('\n— Hof am Stutz erfasst:'); hof.forEach(e => console.log(show(e)));
  console.log(`  Σ netto: ${f(hof.reduce((s, e) => s + e.amountNet, 0))} (Ziel 1559.93)`);
  // Duplikat-Paare: FIBU-Übernahme + PDF mit gleicher Beleg-Nr ODER brutto(pdf) ≈ netto(fibu)×(1+MwSt)
  const fibuHof = hof.filter(e => e.quelle === 'fibu_uebernahme');
  const pdfHof = hof.filter(e => e.quelle !== 'fibu_uebernahme');
  const hofDel: InvoiceEntry[] = [];
  for (const fb of fibuHof) {
    const kand = pdfHof.filter(p => !hofDel.includes(p) && (
      (fb.reference && p.reference && fb.reference.trim() === p.reference.trim()) ||
      Math.abs(p.amountGross - fb.amountNet * (1 + fb.vatRate / 100)) <= 0.05 ||
      Math.abs(p.amountNet - fb.amountNet) <= 0.05
    ));
    if (kand.length === 1) hofDel.push(kand[0]);
    else if (kand.length > 1) console.log(`  !! MEHRDEUTIG für FIBU ${fb.reference}/${f(fb.amountNet)}: ${kand.map(k => k.id).join(', ')}`);
  }
  console.log('  → LÖSCHEN (PDF-Duplikate):'); hofDel.forEach(e => console.log(show(e)));
  const hofNach = hof.filter(e => !hofDel.some(d => d.id === e.id)).reduce((s, e) => s + e.amountNet, 0);
  console.log(`  Hof am Stutz NACHHER: ${f(hofNach)} (Ziel 1559.93)`);

  // ── Alias-Gruppe Rutishauser ──
  const gruppen = await loadAliasGruppen(TENANT);
  const ID = 'grp-rutishauser'; const NAME = 'Rutishauser-DiVino SA';
  const ALIASES = ['Rutishauser-DiVino', 'Rutishauser-DiVino SA, 4441'];
  const ex = gruppen.find(g => g.id === ID || g.name === NAME);
  console.log(`\nAlias-Gruppe: ${ex ? 'existiert bereits' : `NEU ${ID} | ${NAME} | [${ALIASES.join(' · ')}]`}`);

  if (!COMMIT) { console.log('\nDRY-RUN — nichts geschrieben/gelöscht.'); return; }

  // Backup betroffener Monate
  const betroffen = new Set([...rutiDel, ...hofDel].map(e => e.date.slice(0, 7)));
  const backup: Record<string, InvoiceEntry[]> = {};
  for (const mk of betroffen) backup[mk] = invByMonth.get(mk) ?? [];
  const bf = `/tmp/waren-backup-${TENANT}-${Date.now()}.json`;
  fs.writeFileSync(bf, JSON.stringify(backup, null, 1));
  console.log(`\nBackup: ${bf}`);

  if (!ex) {
    await saveAliasGruppen(TENANT, [...gruppen, { id: ID, name: NAME, aliases: ALIASES }]);
    console.log('Alias-Gruppe gespeichert.');
  }
  for (const e of [...rutiDel, ...hofDel]) {
    await deleteInvoiceEntry(TENANT, e.id, e.date);
    console.log(`gelöscht: ${e.id} (${e.supplierName} ${e.date} ${f(e.amountNet)})`);
  }
  console.log('FERTIG.');
})();
