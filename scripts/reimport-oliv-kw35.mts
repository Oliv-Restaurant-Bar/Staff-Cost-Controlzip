import fs from 'node:fs';
import crypto from 'node:crypto';
import {
  kontoSplitsAusPositionen,
  normalizeArtikelKonten,
  normalizeWarengruppenMapping,
  parseTransgourmetCsv,
  positionenAusRechnung,
  uebernehmeManuelleKontierung,
  vatRateFuerTransgourmetMwstCode,
  type GespeichertePosition,
  type ParsedCsvRechnung,
} from '../src/lib/waren-positionen';
import {
  fsFakturenAlsRechnungen,
  kontoSplitsAusFsKategorien,
  mitFsDefaults,
  parseFsFaktura,
  toFsZeilen,
} from '../src/lib/feldschloesschen';
import { reconstructGnPdfLines, type GnPdfPageItems } from '../src/lib/gn-pdf-lines';

type JsonObject = Record<string, any>;
type Row = { key: string; value: any };

const env = Object.fromEntries(
  fs.readFileSync('.env', 'utf8').split('\n').filter(line => line.includes('=')).map(line => {
    const index = line.indexOf('=');
    return [line.slice(0, index), line.slice(index + 1).trim().replace(/^"|"$/g, '')];
  }),
);
const projectRef = env.VITE_SUPABASE_PROJECT_ID;
const supabaseUrl = env.VITE_SUPABASE_URL;
const accessToken = process.env.SUPABASE_ACCESS_TOKEN;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!projectRef || !supabaseUrl || !accessToken || !serviceRoleKey) {
  throw new Error('Required Supabase configuration is unavailable.');
}

const KEYS = {
  invoices: 'supplier_invoices_2026-08',
  positions: 'waren_positionen_2026-08_v1',
  hints: 'waren_preishinweise_2026-08_v1',
  mapping: 'waren_warengruppen_konten_v1',
  articles: 'waren_artikel_konten_v1',
  undo: 'waren_import_undo_csv_v1',
} as const;
const CSV_PATH = 'oliv/import/transgourmet-csv--kundennummer-rechnungsnummer-datum-markt-warengruppe-positio-8064c313.csv';
const FS_PATH = 'oliv/import/feldschlosschen--fak-87811047-e1c7ad51.pdf';
const CAPORASO_PATH = 'oliv/import/caporaso--2146205-a657a633.pdf';
const EXPECTED_SHA256 = {
  [CSV_PATH]: '0c84aa83c019b5f5db0345d29770bda1a028c40d0e4b25f42c427b742115d2e0',
  [FS_PATH]: '83bf7736967209b90826eeb57871b50b16556242121a7b6f20bf5e5382af33a5',
  [CAPORASO_PATH]: '264ccd8cea0ebbdc61f86fc80f9925f0e5b0bdc3896c0acb19e0e8d710d1bdaa',
};
const CSV_TARGETS = new Set(['249', '64156519', '276', '64161259']);
const CAPORASO_KONTEN: Record<string, string> = { Küche: '4060', Betriebsmaterial: '4701' };

async function db(sql: string): Promise<Row[]> {
  const response = await fetch(`https://api.supabase.com/v1/projects/${projectRef}/database/query`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: sql }),
  });
  if (!response.ok) throw new Error(`Database operation failed (${response.status}).`);
  const body = await response.json();
  return Array.isArray(body) ? body : [];
}

async function download(receiptPath: string): Promise<Buffer> {
  const response = await fetch(
    `${supabaseUrl}/storage/v1/object/authenticated/waren-belege/${receiptPath.split('/').map(encodeURIComponent).join('/')}`,
    { headers: { Authorization: `Bearer ${serviceRoleKey}`, apikey: serviceRoleKey } },
  );
  if (!response.ok) throw new Error(`Receipt download failed for ${receiptPath} (${response.status}).`);
  const bytes = Buffer.from(await response.arrayBuffer());
  const digest = crypto.createHash('sha256').update(bytes).digest('hex');
  if (digest !== EXPECTED_SHA256[receiptPath]) throw new Error(`Receipt hash changed: ${receiptPath}`);
  return bytes;
}

async function pdfPages(bytes: Buffer): Promise<GnPdfPageItems[]> {
  const mod = await import('pdfjs-dist/legacy/build/pdf.js');
  const pdfjs = (mod as any).default ?? mod;
  const document = await pdfjs.getDocument({ data: new Uint8Array(bytes), useSystemFonts: true }).promise;
  const pages: GnPdfPageItems[] = [];
  for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber++) {
    const page = await document.getPage(pageNumber);
    const content = await page.getTextContent();
    pages.push({
      pageNumber,
      items: content.items.filter((item: any) => typeof item.str === 'string').map((item: any) => ({
        x: Math.round(item.transform[4] * 100) / 100,
        y: Math.round(item.transform[5] * 100) / 100,
        str: item.str,
      })),
    });
  }
  return pages;
}

function round2(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

function stable(value: unknown): string {
  const sort = (item: any): any => Array.isArray(item)
    ? item.map(sort)
    : item && typeof item === 'object'
      ? Object.fromEntries(Object.keys(item).sort().map(key => [key, sort(item[key])]))
      : item;
  return JSON.stringify(sort(value ?? null));
}

function sqlJson(value: unknown): string {
  return `'${JSON.stringify(value).replace(/'/g, "''")}'::jsonb`;
}

function findInvoice(invoices: JsonObject[], supplier: string, reference: string, date: string, receiptPath: string): JsonObject {
  const matches = invoices.filter(invoice =>
    invoice.supplierName === supplier && String(invoice.reference ?? '') === reference
    && invoice.date === date && invoice.receiptPath === receiptPath);
  if (matches.length !== 1) throw new Error(`Expected exactly one source-linked invoice: ${supplier} ${reference}`);
  if (matches[0].id.startsWith('manuell-') || matches[0].quelle === 'manuell') {
    throw new Error(`Manual invoice must not be replaced: ${supplier} ${reference}`);
  }
  return matches[0];
}

function desiredInvoice(current: JsonObject, data: {
  amountNet: number;
  amountGross: number;
  vatRate: number;
  kontoSplits: unknown;
  vatClassesSource: 'positions' | 'printed_summary';
}): JsonObject {
  if (round2(current.amountNet) !== round2(data.amountNet) || round2(current.amountGross) !== round2(data.amountGross)) {
    throw new Error(`Source totals do not match inventory for ${current.supplierName} ${current.reference}`);
  }
  const { warenkonto: _legacyKonto, ...rest } = current;
  void _legacyKonto;
  return {
    ...rest,
    vatRate: data.vatRate,
    kontoSplits: data.kontoSplits,
    vatClassesSource: data.vatClassesSource,
  };
}

const sourceRows = await db(
  `select key, value from app_settings where key in (${Object.values(KEYS).map(key => `'${key}'`).join(',')}) order by key`,
);
const source = new Map(sourceRows.map(row => [row.key, row.value]));
for (const key of [KEYS.invoices, KEYS.positions, KEYS.hints]) {
  if (!source.has(key)) throw new Error(`Required inventory key missing: ${key}`);
}

const beforeInvoices = structuredClone(source.get(KEYS.invoices)) as JsonObject[];
const beforePositions = structuredClone(source.get(KEYS.positions)) as Record<string, GespeichertePosition[]>;
const hints = structuredClone(source.get(KEYS.hints));
const invoices = structuredClone(beforeInvoices);
const positions = structuredClone(beforePositions);
const mapping = normalizeWarengruppenMapping(source.get(KEYS.mapping));
const articles = normalizeArtikelKonten(source.get(KEYS.articles));
const manualInvoicesBefore = beforeInvoices.filter(invoice => invoice.id?.startsWith('manuell-') || invoice.quelle === 'manuell');

const [csvBytes, fsBytes, caporasoBytes] = await Promise.all([
  download(CSV_PATH), download(FS_PATH), download(CAPORASO_PATH),
]);

const csv = parseTransgourmetCsv(csvBytes.toString('latin1'));
if (csv.failureReason) throw new Error(csv.failureReason);
const csvTargets = csv.rechnungen.filter(rechnung =>
  CSV_TARGETS.has(rechnung.rechnungsNr) && rechnung.datum >= '2026-08-24' && rechnung.datum <= '2026-08-30');
if (csvTargets.length !== CSV_TARGETS.size) throw new Error('CSV target set is incomplete.');
for (const rechnung of csvTargets) {
  const supplier = rechnung.markt.trim().toLowerCase() === 'bgh' ? 'Transgourmet' : 'Prodega';
  const current = findInvoice(invoices, supplier, rechnung.rechnungsNr, rechnung.datum, CSV_PATH);
  const nextPositions = uebernehmeManuelleKontierung(
    positionenAusRechnung(rechnung, mapping, { lieferant: current.supplierName, konten: articles }),
    positions[current.id],
  );
  const rates = [...new Set(rechnung.positionen
    .map(position => vatRateFuerTransgourmetMwstCode(position.mwstCode))
    .filter(rate => rate !== null))];
  if (rates.length < 2) throw new Error(`Expected mixed VAT source invoice: ${rechnung.rechnungsNr}`);
  const index = invoices.findIndex(invoice => invoice.id === current.id);
  invoices[index] = desiredInvoice(current, {
    amountNet: rechnung.nettoTotal,
    amountGross: rechnung.bruttoTotal,
    vatRate: 0,
    kontoSplits: kontoSplitsAusPositionen(nextPositions),
    vatClassesSource: 'positions',
  });
  positions[current.id] = nextPositions;
}

const fsLines = reconstructGnPdfLines(await pdfPages(fsBytes));
const fsParsed = parseFsFaktura(toFsZeilen(fsLines));
if (fsParsed.failureReason) throw new Error(fsParsed.failureReason);
const fsImport = fsFakturenAlsRechnungen(fsParsed);
if (fsImport.length !== 1 || fsImport[0].r.rechnungsNr !== '87811047') throw new Error('Unexpected Feldschlösschen source.');
const fsSource = fsImport[0];
const fsCurrent = findInvoice(invoices, 'Feldschlösschen', '87811047', '2026-08-28', FS_PATH);
const fsPositions = uebernehmeManuelleKontierung(
  positionenAusRechnung(fsSource.r, mitFsDefaults(mapping), { lieferant: 'Feldschlösschen', konten: articles }),
  positions[fsCurrent.id],
);
const fsSplit = kontoSplitsAusFsKategorien(fsSource.fsKategorien ?? [], mapping, fsSource.r.positionen);
if (fsSplit.offen.length || fsSplit.gebuehrenRest !== 0) throw new Error('Feldschlösschen split is not fully attributable.');
const fsIndex = invoices.findIndex(invoice => invoice.id === fsCurrent.id);
invoices[fsIndex] = desiredInvoice(fsCurrent, {
  amountNet: fsSource.nettoOffiziell!,
  amountGross: fsSource.bruttoOffiziell!,
  vatRate: 0,
  kontoSplits: fsSplit.splits,
  vatClassesSource: 'printed_summary',
});
positions[fsCurrent.id] = fsPositions;

const caporasoText = reconstructGnPdfLines(await pdfPages(caporasoBytes)).map(line => line.text).join('\n');
const storage = new Map<string, string>();
Object.defineProperty(globalThis, 'localStorage', {
  value: {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
    removeItem: (key: string) => storage.delete(key),
    clear: () => storage.clear(),
    key: (index: number) => [...storage.keys()][index] ?? null,
    get length() { return storage.size; },
  },
  configurable: true,
});
const { parseProfilPdf } = await import('../src/lib/profil-pdf-parse');
const caporasoProfile = {
  id: 'caporaso',
  name: 'Caporaso',
  mwstNr: '',
  kategorie: 'Küche',
  konto: '4060',
  mwstSatz: 2.6,
  parser: 'caporaso' as const,
  monatsrechnung: false,
  erkennungTokens: ['caporaso'],
};
const caporaso = parseProfilPdf(caporasoText, [caporasoProfile]);
if (caporaso.rechnungsNr !== '2146205' || caporaso.netto !== 1646.5 || caporaso.mwst !== 52.45
    || caporaso.mwstKlassen.length !== 2) {
  throw new Error('Unexpected Caporaso source totals or VAT classes.');
}
let caporasoRechnung: ParsedCsvRechnung;
const detailNet = round2(caporaso.lieferungen.reduce((sum, delivery) => sum + delivery.nettoTotal, 0));
if (caporaso.positionenErkannt && caporaso.lieferungen.length === 1 && detailNet === caporaso.netto) {
  caporasoRechnung = caporaso.lieferungen[0];
} else {
  caporasoRechnung = {
    docKey: '2146205|2026-08-25|Caporaso',
    rechnungsNr: '2146205',
    datum: '2026-08-25',
    markt: 'Caporaso',
    positionen: caporaso.mwstKlassen.map(vat => ({
      artNr: '',
      bezeichnung: `Rechnung gesamt · MwSt ${vat.satz}%`,
      warengruppe: vat.satz === 8.1 ? 'Betriebsmaterial' : 'Küche',
      menge: 0,
      einheit: '',
      preis: 0,
      positionspreis: vat.basis,
      mwstBetrag: vat.betrag,
      mwstCode: vat.satz === 2.6 ? 1 : 2,
      mwstSatz: vat.satz as 2.6 | 8.1,
    })),
    nettoTotal: caporaso.netto,
    mwstTotal: caporaso.mwst,
    bruttoTotal: round2(caporaso.netto + caporaso.mwst),
  };
}
const capCurrent = findInvoice(invoices, 'Caporaso', '2146205', '2026-08-25', CAPORASO_PATH);
const capPositions = uebernehmeManuelleKontierung(
  positionenAusRechnung(caporasoRechnung, [
    ...Object.entries(CAPORASO_KONTEN).map(([gruppe, konto]) => ({ gruppe, konto })),
    ...mapping,
  ], { lieferant: 'Caporaso', konten: articles }),
  positions[capCurrent.id],
);
const capIndex = invoices.findIndex(invoice => invoice.id === capCurrent.id);
invoices[capIndex] = desiredInvoice(capCurrent, {
  amountNet: caporaso.netto,
  amountGross: round2(caporaso.netto + caporaso.mwst),
  vatRate: 0,
  kontoSplits: kontoSplitsAusPositionen(capPositions),
  vatClassesSource: 'positions',
});
positions[capCurrent.id] = capPositions;

const changedInvoiceIds = invoices.filter((invoice, index) => stable(invoice) !== stable(beforeInvoices[index])).map(invoice => invoice.id);
const changedPositionIds = Object.keys(positions).filter(id => stable(positions[id]) !== stable(beforePositions[id]));
const expectedIds = [...csvTargets.map(rechnung =>
  findInvoice(invoices, rechnung.markt.trim().toLowerCase() === 'bgh' ? 'Transgourmet' : 'Prodega', rechnung.rechnungsNr, rechnung.datum, CSV_PATH).id),
  fsCurrent.id, capCurrent.id].sort();
if (stable([...changedInvoiceIds].sort()) !== stable(expectedIds)
    || stable([...changedPositionIds].sort()) !== stable(expectedIds)) {
  if (changedInvoiceIds.length === 0 && changedPositionIds.length === 0) {
    console.log('NO-OP: all six OLIV KW35 source invoices already contain exact VAT classes.');
    process.exit(0);
  }
  throw new Error(`Unexpected change scope: invoices=${changedInvoiceIds.join(',')} positions=${changedPositionIds.join(',')}`);
}
const manualInvoicesAfter = invoices.filter(invoice => invoice.id?.startsWith('manuell-') || invoice.quelle === 'manuell');
if (stable(manualInvoicesBefore) !== stable(manualInvoicesAfter)) throw new Error('Manual invoices changed.');
if (stable(hints) !== stable(source.get(KEYS.hints))) throw new Error('Price hints changed.');

const now = new Date().toISOString();
for (const id of changedInvoiceIds) {
  const invoice = invoices.find(item => item.id === id)!;
  invoice.updatedAt = now;
}
const beforeSnapshot = {
  invoicesProMonat: { '2026-08': beforeInvoices },
  positionenProMonat: { '2026-08': beforePositions },
  hinweiseProMonat: { '2026-08': hints },
};
const afterSnapshot = {
  invoicesProMonat: { '2026-08': invoices },
  positionenProMonat: { '2026-08': positions },
  hinweiseProMonat: { '2026-08': hints },
};
const undo = {
  typ: 'csv',
  zeitpunkt: now,
  label: 'Historische OLIV-KW35-MwSt-Korrektur (CSV/PDF)',
  anzahlRechnungen: expectedIds.length,
  vorher: beforeSnapshot,
  nachher: afterSnapshot,
};

console.log(JSON.stringify({
  mode: process.argv.includes('--apply') ? 'apply' : 'dry-run',
  changedInvoiceIds,
  manualInvoicesPreserved: manualInvoicesAfter.length,
  priceHintsPreserved: true,
  totals: expectedIds.map(id => {
    const invoice = invoices.find(item => item.id === id)!;
    const vatClasses = (invoice.kontoSplits ?? []).flatMap((split: JsonObject) => split.vatClasses ?? []);
    return {
      supplier: invoice.supplierName,
      reference: invoice.reference,
      net: invoice.amountNet,
      vatPrinted: round2(vatClasses.reduce((sum: number, vat: JsonObject) => sum + vat.amountVat, 0)),
      grossHead: invoice.amountGross,
      grossFromClasses: round2(vatClasses.reduce((sum: number, vat: JsonObject) => sum + vat.amountGross, 0)),
      rates: [...new Set(vatClasses.map((vat: JsonObject) => vat.vatRate))].sort(),
    };
  }),
}, null, 2));

if (!process.argv.includes('--apply')) {
  console.log('DRY-RUN complete. Re-run with --apply to write the atomic correction.');
  process.exit(0);
}

const sql = `
begin;
do $block$
declare affected integer;
begin
  update app_settings set value = ${sqlJson(invoices)}, updated_at = now()
    where key = '${KEYS.invoices}' and value = ${sqlJson(beforeInvoices)};
  get diagnostics affected = row_count;
  if affected <> 1 then raise exception 'Invoice CAS failed'; end if;
  update app_settings set value = ${sqlJson(positions)}, updated_at = now()
    where key = '${KEYS.positions}' and value = ${sqlJson(beforePositions)};
  get diagnostics affected = row_count;
  if affected <> 1 then raise exception 'Position CAS failed'; end if;
end $block$;
insert into app_settings (key, value, updated_at) values ('${KEYS.undo}', ${sqlJson(undo)}, now())
  on conflict (key) do update set value = excluded.value, updated_at = now();
commit;`;
await db(sql);
console.log('APPLIED: six OLIV KW35 invoices corrected atomically; shared undo snapshot saved.');