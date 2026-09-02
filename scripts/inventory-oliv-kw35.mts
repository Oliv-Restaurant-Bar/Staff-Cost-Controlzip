import fs from 'node:fs';
import path from 'node:path';

const env = Object.fromEntries(
  fs.readFileSync('.env', 'utf8')
    .split('\n')
    .filter(line => line.includes('='))
    .map(line => {
      const index = line.indexOf('=');
      return [line.slice(0, index), line.slice(index + 1).trim().replace(/^"|"$/g, '')];
    }),
);

const projectRef = env.VITE_SUPABASE_PROJECT_ID;
const accessToken = process.env.SUPABASE_ACCESS_TOKEN;
if (!projectRef || !accessToken) throw new Error('Supabase project reference or access token is unavailable.');

async function query(sql: string): Promise<Array<{ key: string; value: unknown }>> {
  const response = await fetch(`https://api.supabase.com/v1/projects/${projectRef}/database/query`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ query: sql }),
  });
  if (!response.ok) throw new Error(`Inventory query failed (${response.status}).`);
  const body = await response.json();
  if (!Array.isArray(body)) throw new Error('Inventory query returned an unexpected response.');
  return body;
}

const keys = [
  'supplier_invoices_2026-08',
  'waren_positionen_2026-08_v1',
  'waren_preishinweise_2026-08_v1',
  'waren_import_undo_csv_v1',
  'waren_import_undo_pdf_profil_v1',
  'waren_import_undo_fs_v1',
];
const rows = await query(
  `select key, value from app_settings where key in (${keys.map(key => `'${key}'`).join(',')}) order by key`,
);
const byKey = new Map(rows.map(row => [row.key, row.value]));
const invoices = Array.isArray(byKey.get(keys[0])) ? byKey.get(keys[0]) as Array<Record<string, unknown>> : [];
const kw35 = invoices.filter(invoice => {
  const date = typeof invoice.date === 'string' ? invoice.date : '';
  return date >= '2026-08-24' && date <= '2026-08-30';
});
const positions = (byKey.get(keys[1]) ?? {}) as Record<string, unknown>;
const hints = (byKey.get(keys[2]) ?? {}) as Record<string, unknown>;

const inventory = kw35.map(invoice => {
  const id = String(invoice.id ?? '');
  return {
    id,
    date: invoice.date,
    supplierName: invoice.supplierName,
    reference: invoice.reference,
    amountNet: invoice.amountNet,
    amountGross: invoice.amountGross,
    vatRate: invoice.vatRate,
    vatClassesSource: invoice.vatClassesSource,
    quelle: invoice.quelle,
    receiptPath: invoice.receiptPath,
    kontoSplits: invoice.kontoSplits,
    positions: Array.isArray(positions[id]) ? positions[id] : null,
    priceHints: hints[id] ?? null,
  };
});

if (process.argv.includes('--download-receipts')) {
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const supabaseUrl = env.VITE_SUPABASE_URL;
  if (!serviceRoleKey || !supabaseUrl) throw new Error('Supabase storage access is unavailable.');
  const outputDir = '/tmp/oliv-kw35-receipts';
  fs.mkdirSync(outputDir, { recursive: true });
  const receiptPaths = [...new Set(inventory
    .map(invoice => invoice.receiptPath)
    .filter((value): value is string => typeof value === 'string' && value.length > 0))];
  for (const receiptPath of receiptPaths) {
    const response = await fetch(
      `${supabaseUrl}/storage/v1/object/authenticated/waren-belege/${receiptPath.split('/').map(encodeURIComponent).join('/')}`,
      { headers: { Authorization: `Bearer ${serviceRoleKey}`, apikey: serviceRoleKey } },
    );
    if (!response.ok) throw new Error(`Receipt download failed for ${receiptPath} (${response.status}).`);
    const filename = path.basename(receiptPath);
    fs.writeFileSync(path.join(outputDir, filename), Buffer.from(await response.arrayBuffer()));
  }
  console.error(`Downloaded ${receiptPaths.length} linked receipts to ${outputDir}.`);
}

console.log(JSON.stringify({
  scope: 'OLIV / ISO-KW35 2026 / 2026-08-24..2026-08-30',
  keyPresence: Object.fromEntries(keys.map(key => [key, byKey.has(key)])),
  augustInvoiceCount: invoices.length,
  kw35InvoiceCount: inventory.length,
  invoices: inventory,
  undo: {
    csv: byKey.get(keys[3]) ?? null,
    pdfProfil: byKey.get(keys[4]) ?? null,
    feldschloesschen: byKey.get(keys[5]) ?? null,
  },
}, null, 2));