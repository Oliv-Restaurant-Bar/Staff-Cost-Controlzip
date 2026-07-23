// Einmal-Werkzeug: extrahiert Text-Items (x/y/str) aus einem PDF als JSON-Fixture.
import fs from 'fs';
const mod = await import("pdfjs-dist/legacy/build/pdf.js");
const pdfjs = mod.default ?? mod;
const data = new Uint8Array(fs.readFileSync(process.argv[2]));
const doc = await pdfjs.getDocument({ data, useSystemFonts: true }).promise;
const pages = [];
for (let p = 1; p <= doc.numPages; p++) {
  const page = await doc.getPage(p);
  const tc = await page.getTextContent();
  const items = tc.items
    .filter(it => typeof it.str === 'string')
    .map(it => ({ x: Math.round(it.transform[4] * 100) / 100, y: Math.round(it.transform[5] * 100) / 100, str: it.str }));
  pages.push({ pageNumber: p, items });
}
fs.writeFileSync(process.argv[3], JSON.stringify({ pageCount: doc.numPages, pages }, null, 1));
console.log('pages:', doc.numPages, 'items total:', pages.reduce((s, p) => s + p.items.length, 0));
