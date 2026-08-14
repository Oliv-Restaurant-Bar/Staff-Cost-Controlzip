/**
 * Import «Manuelle Buchungen (CSV/Text)» — beide Mandanten
 * =========================================================
 * Nimmt einen eingefügten Text-Block ODER eine .csv/.txt-Datei mit festem
 * Schema (Mandant;Lieferant;Datum;BelegNr;Kategorie;Konto;Netto;MwSt%;Bemerkung)
 * und legt je Zeile eine provisorische Warenrechnungs-Buchung an (Dual-Modell:
 * eine spätere Monatsrechnung darf ersetzen).
 *
 * Grundsätze:
 * - Jede Zeile wird in die Keys IHRES Mandanten geschrieben (Oliv unpräfixiert
 *   / Beaulieu «beaulieu:») — nie still in den falschen Mandanten.
 * - Dublettensicher: existiert (Mandant, Lieferant, BelegNr) bereits, werden
 *   ALLE Zeilen dieses Belegs ERSETZT (nie addiert).
 * - Unbekannte Lieferanten werden in der Vorschau als «neu» markiert und erst
 *   beim bestätigten Import im Lieferanten-Stamm angelegt (kein Raten).
 * - Schreiben NUR über saveMonthInvoices (Ignore-/Privat-Fence bleibt aktiv).
 * - Undo: ein Slot je Mandant (Typ «manuell»), Snapshot vor/nach dem Schreiben.
 */
import { useMemo, useState } from 'react';
import { toast } from 'sonner';
import { ClipboardPaste, Loader2, Upload } from 'lucide-react';
import type { TenantId } from '@/contexts/TenantContext';
import {
  type InvoiceEntry,
  loadMonthInvoices, saveMonthInvoices,
  loadSuppliers, saveSuppliers,
  erstelleWarenImportSnapshot, saveWarenImportUndo,
} from '@/lib/waren-db';
import {
  MANUELLE_BUCHUNGEN_SPALTEN, parseManuelleBuchungen, belegKey, summenJeMandant,
  istManuellErsetzbar, type ManuelleBuchungZeile,
} from '@/lib/manuelle-buchungen-import';
import { WarenImportUndoButton } from '@/components/waren/WarenCsvImport';

interface VorschauZeile extends ManuelleBuchungZeile {
  /** Kanonischer Name aus dem Lieferanten-Stamm (case-insensitiv gematcht). */
  lieferantKanonisch: string;
  neuerLieferant: boolean;
  /** true = Beleg (Mandant, Lieferant, BelegNr) existiert → wird ERSETZT. */
  dublette: boolean;
  /** Kollision mit geschützter Buchung (final/Monatsrechnung/markt) —
   *  Zeile wird ÜBERSPRUNGEN, nie still ersetzt oder addiert. */
  geschuetzt: string | null;
}

const fmtChf = (n: number | null) =>
  n === null ? '—' : n.toLocaleString('de-CH', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** Nachbar-Monate (±1) für Dubletten-Suche/Ersetzung/Snapshot: bestehende
 *  Beleg-Zeilen können durch Datum-Korrekturen im Nachbarmonat liegen. */
function monateMitNachbarn(isoDaten: string[]): string[] {
  const set = new Set<string>();
  for (const iso of isoDaten) {
    const d = new Date(`${iso}T00:00:00Z`);
    for (const off of [-1, 0, 1]) {
      const dd = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + off, 1));
      set.add(`${dd.getUTCFullYear()}-${String(dd.getUTCMonth() + 1).padStart(2, '0')}`);
    }
  }
  return [...set].sort();
}

export function ManuelleBuchungenImport({ tenantId, onImported }: {
  tenantId: TenantId;
  onImported: () => void;
}) {
  const [text, setText] = useState('');
  const [zeilen, setZeilen] = useState<VorschauZeile[]>([]);
  const [strukturFehler, setStrukturFehler] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [undoRefresh, setUndoRefresh] = useState(0);

  const importierbar = useMemo(() => zeilen.filter(z => z.fehler.length === 0 && !z.geschuetzt), [zeilen]);
  const summen = useMemo(() => summenJeMandant(importierbar), [importierbar]);
  const neueLieferanten = useMemo(() => {
    const set = new Map<string, string>(); // key mandant|name-lower → Anzeige
    for (const z of importierbar) {
      if (z.neuerLieferant && z.mandant) set.set(`${z.mandant}|${z.lieferantKanonisch.toLowerCase()}`,
        `${z.lieferantKanonisch} (${z.mandant === 'oliv' ? 'Oliv' : 'Beaulieu'})`);
    }
    return [...set.values()];
  }, [importierbar]);

  /** Text/Datei parsen und Vorschau mit Stamm-/Dubletten-Abgleich aufbauen. */
  async function handleVorschau(input: string) {
    if (!input.trim()) { toast.error('Bitte Text einfügen oder Datei wählen.'); return; }
    setBusy(true);
    try {
      const erg = parseManuelleBuchungen(input);
      setStrukturFehler(erg.fehler);
      if (erg.fehler.length > 0) { setZeilen([]); return; }

      // Beteiligte Mandanten: Stamm + Bestand je Mandant EINMAL laden.
      const mandanten = [...new Set(erg.zeilen.map(z => z.mandant).filter((m): m is TenantId => m !== null))];
      const stammProMandant = new Map<TenantId, Awaited<ReturnType<typeof loadSuppliers>>>();
      const bestandProMandant = new Map<TenantId, InvoiceEntry[]>();
      for (const m of mandanten) {
        stammProMandant.set(m, await loadSuppliers(m));
        const monate = monateMitNachbarn(erg.zeilen
          .filter(z => z.mandant === m && z.datum !== null).map(z => z.datum as string));
        const alle: InvoiceEntry[] = [];
        for (const mon of monate) alle.push(...await loadMonthInvoices(m, mon));
        bestandProMandant.set(m, alle);
      }

      const vorschau: VorschauZeile[] = erg.zeilen.map(z => {
        const stamm = z.mandant ? stammProMandant.get(z.mandant) ?? [] : [];
        const treffer = stamm.find(s => s.name.trim().toLowerCase() === z.lieferant.trim().toLowerCase());
        const kanonisch = treffer?.name ?? z.lieferant.trim();
        const bestand = z.mandant ? bestandProMandant.get(z.mandant) ?? [] : [];
        const treffend = z.belegNr === '' ? [] : bestand.filter(e =>
          e.supplierName.trim().toLowerCase() === kanonisch.trim().toLowerCase()
          && (e.reference ?? '').trim() === z.belegNr.trim());
        const geschuetzte = treffend.filter(e => !istManuellErsetzbar(e));
        const geschuetzt = geschuetzte.length === 0 ? null
          : geschuetzte.some(e => e.markt)
          ? 'Kollision mit markt-gebundener CSV-Buchung — wird übersprungen'
          : 'Beleg bereits final gebucht (Monatsrechnung) — wird übersprungen';
        const dublette = geschuetzt === null && treffend.length > 0;
        return { ...z, lieferantKanonisch: kanonisch, neuerLieferant: !treffer && z.lieferant.trim() !== '', dublette, geschuetzt };
      });
      setZeilen(vorschau);
      const fehlerhafte = vorschau.filter(z => z.fehler.length > 0).length;
      toast.success(`${vorschau.length} Zeile${vorschau.length === 1 ? '' : 'n'} geparst${fehlerhafte > 0 ? ` — ${fehlerhafte} mit Fehlern (werden NICHT gebucht)` : ''}.`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally { setBusy(false); }
  }

  /** Bestätigter Import: je Mandant Snapshot → Beleg-Ersetzung → Undo-Slot. */
  async function handleImport() {
    if (importierbar.length === 0) { toast.error('Keine importierbaren Zeilen.'); return; }
    setBusy(true);
    const fertigeMandanten: TenantId[] = [];
    try {
      const mandanten = [...new Set(importierbar.map(z => z.mandant).filter((m): m is TenantId => m !== null))];
      let neu = 0;
      let ersetzt = 0;
      let uebersprungen = 0;
      for (const m of mandanten) {
        const alleRows = importierbar.filter(z => z.mandant === m && z.datum !== null);
        if (alleRows.length === 0) continue;
        const monate = monateMitNachbarn(alleRows.map(z => z.datum as string));
        const vorher = await erstelleWarenImportSnapshot(m, { monate });

        // SCHUTZ-GEGENPROBE frisch beim Import (nicht nur Vorschau-Stand):
        // Belege mit final/Monatsrechnungs- oder markt-gebundenen Treffern
        // werden komplett übersprungen — nie still ersetzen oder addieren.
        const frisch: InvoiceEntry[] = Object.values(vorher.invoicesProMonat).flat();
        const geschuetzteKeys = new Set<string>();
        for (const e of frisch) {
          const ref = (e.reference ?? '').trim();
          if (ref !== '' && !istManuellErsetzbar(e)) geschuetzteKeys.add(belegKey(m, e.supplierName, ref));
        }
        const rows = alleRows.filter(z => !geschuetzteKeys.has(belegKey(m, z.lieferantKanonisch, z.belegNr)));
        uebersprungen += alleRows.length - rows.length;
        if (rows.length === 0) continue;

        // Beleg-Schlüssel dieses Imports: (Lieferant ci, BelegNr) je Mandant.
        const belegKeys = new Set(rows.map(z => belegKey(m, z.lieferantKanonisch, z.belegNr)));
        const entferntProBeleg = new Set<string>();

        // Bestehende ERSETZBARE Zeilen aller betroffenen Belege entfernen
        // (ersetzen, nie addieren); geschützte Buchungen bleiben unangetastet.
        const proMonat = new Map<string, InvoiceEntry[]>();
        for (const mon of monate) {
          const entries = await loadMonthInvoices(m, mon);
          const behalten = entries.filter(e => {
            const ref = (e.reference ?? '').trim();
            const k = belegKey(m, e.supplierName, ref);
            if (ref !== '' && belegKeys.has(k) && istManuellErsetzbar(e)) { entferntProBeleg.add(k); return false; }
            return true;
          });
          proMonat.set(mon, behalten);
        }

        // Neue Buchungen anlegen (provisorisch im Dual-Modell: kein final/quelle).
        const jetzt = new Date().toISOString();
        rows.forEach((z, i) => {
          const k = belegKey(m, z.lieferantKanonisch, z.belegNr);
          if (entferntProBeleg.has(k)) ersetzt += 1; else neu += 1;
          const mon = (z.datum as string).slice(0, 7);
          const liste = proMonat.get(mon) ?? [];
          liste.push({
            id: `manuell-${Date.now()}-${i}-${Math.random().toString(36).slice(2, 8)}`,
            date: z.datum as string,
            supplierName: z.lieferantKanonisch,
            amountNet: z.netto as number,
            amountGross: z.brutto as number,
            vatIncluded: false,
            vatRate: z.mwstSatz as number,
            reference: z.belegNr,
            ...(z.bemerkung ? { note: z.bemerkung } : {}),
            warenkonto: z.konto,
            kategorie: z.kategorie,
            createdAt: jetzt, updatedAt: jetzt,
          });
          proMonat.set(mon, liste);
        });

        // MANDANT-LOKAL «ATOMAR»: Scheitert IRGENDEIN Schreibvorgang dieses
        // Mandanten, werden alle bereits geschriebenen Monate aus dem
        // vorher-Snapshot zurückgerollt (und ggf. der Lieferanten-Stamm).
        // Nur ein vollständig geschriebener Mandant gilt als «fertig».
        const geschriebeneMonate: string[] = [];
        let supsVorher: Awaited<ReturnType<typeof loadSuppliers>> | null = null;
        try {
          for (const [mon, entries] of proMonat) {
            await saveMonthInvoices(m, mon, entries);
            geschriebeneMonate.push(mon);
          }

          // Neue Lieferanten im Stamm anlegen (EIN Batch, bestätigt durch Import).
          const neueNamen = [...new Map(rows.filter(z => z.neuerLieferant)
            .map(z => [z.lieferantKanonisch.toLowerCase(), z] as const)).values()];
          if (neueNamen.length > 0) {
            let sups = await loadSuppliers(m);
            supsVorher = sups;
            for (const z of neueNamen) {
              if (sups.some(s => s.name.trim().toLowerCase() === z.lieferantKanonisch.toLowerCase())) continue;
              sups = [...sups, {
                id: `sup-${Date.now()}-${sups.length}`, name: z.lieferantKanonisch, active: true,
                createdAt: jetzt, defaultWarenkonto: z.konto, defaultKategorie: z.kategorie,
                ...(z.mwstSatz !== null ? { defaultVatRate: z.mwstSatz } : {}),
              }];
            }
            await saveSuppliers(m, sups);
          }

          // Undo-Slot SOFORT nach dem Schreiben dieses Mandanten sichern —
          // scheitert ein späterer Mandant, bleibt der fertige undo-bar.
          // Hinweis: Der Undo-Snapshot umfasst BEWUSST nur Buchungen — neu
          // angelegte Lieferanten sind bestätigte Stammdaten und bleiben.
          const nachher = await erstelleWarenImportSnapshot(m, { monate });
          await saveWarenImportUndo(m, {
            typ: 'manuell',
            label: `Manuelle Buchungen (${rows.length} Zeile${rows.length === 1 ? '' : 'n'})`,
            zeitpunkt: jetzt,
            anzahlRechnungen: rows.length,
            vorher, nachher,
          });
          fertigeMandanten.push(m);
        } catch (e) {
          // Kompensations-Rollback aus dem vorher-Snapshot (frisch gelesen).
          let rollbackOk = true;
          for (const mon of geschriebeneMonate) {
            try { await saveMonthInvoices(m, mon, vorher.invoicesProMonat[mon] ?? []); }
            catch { rollbackOk = false; }
          }
          if (supsVorher) {
            try { await saveSuppliers(m, supsVorher); } catch { rollbackOk = false; }
          }
          const name = m === 'oliv' ? 'Oliv' : 'Beaulieu';
          throw new Error(`Mandant ${name}: ${e instanceof Error ? e.message : String(e)}${
            rollbackOk
              ? ' — Änderungen dieses Mandanten wurden zurückgerollt.'
              : ` — ACHTUNG: Rollback unvollständig, Bestand von ${name} bitte prüfen!`}`);
        }
      }
      setUndoRefresh(k => k + 1);
      setZeilen([]);
      setText('');
      toast.success(`Import abgeschlossen: ${neu} neu, ${ersetzt} ersetzt${uebersprungen > 0 ? `, ${uebersprungen} übersprungen (geschützte Belege)` : ''}.`);
      onImported();
    } catch (e) {
      console.error('[MANUELL-IMPORT] fehlgeschlagen:', e);
      // Teil-Import klar ausweisen: bereits fertige Mandanten sind gebucht
      // UND per «Rückgängig» (im jeweiligen Mandanten) rückholbar.
      const fertig = fertigeMandanten.map(m => m === 'oliv' ? 'Oliv' : 'Beaulieu').join(', ');
      toast.error(`${e instanceof Error ? e.message : String(e)}${fertig ? ` — TEIL-IMPORT: ${fertig} wurde vollständig gebucht (dort per «Rückgängig» rückholbar).` : ''}`);
      setUndoRefresh(k => k + 1);
      // Ansicht immer neu laden: auch nach (Teil-)Rollback soll der User den
      // tatsächlichen Bestand sehen (insb. bei «Rollback unvollständig»).
      onImported();
    } finally { setBusy(false); }
  }

  return (
    <div className="border border-border/60 rounded-lg p-3 space-y-3" data-testid="manuelle-buchungen-import">
      <div className="flex flex-wrap items-center gap-3">
        <span className="text-xs font-medium inline-flex items-center gap-1.5">
          <ClipboardPaste className="h-4 w-4 text-primary" />
          Manuelle Buchungen (CSV/Text)
        </span>
        <label className="inline-flex items-center gap-1.5 text-[11px] rounded-md border border-dashed px-2 py-1 cursor-pointer hover:bg-muted/40 transition-colors">
          <Upload className="h-3.5 w-3.5" /> .csv/.txt wählen
          <input type="file" accept=".csv,.txt,text/csv,text/plain" className="hidden" disabled={busy}
            data-testid="input-manuelle-buchungen-datei"
            onChange={e => {
              const f = e.target.files?.[0];
              e.target.value = '';
              if (!f) return;
              void f.text().then(t => { setText(t); void handleVorschau(t); });
            }} />
        </label>
        <span className="text-[11px] text-muted-foreground">
          Schema: {MANUELLE_BUCHUNGEN_SPALTEN.join(';')} · «#»-Zeilen werden ignoriert
        </span>
      </div>

      <textarea
        className="w-full h-28 rounded-md border border-border bg-background p-2 text-xs font-mono"
        placeholder={`${MANUELLE_BUCHUNGEN_SPALTEN.join(';')}\nOliv;Metzgerei Spahni;05.08.2026;Q-1234;Food;4060;164.50;2.6;Barausgabe Quittung`}
        value={text}
        onChange={e => setText(e.target.value)}
        data-testid="textarea-manuelle-buchungen"
      />
      <div className="flex items-center gap-2">
        <button type="button" disabled={busy}
          className="text-xs font-medium rounded-lg border border-border px-3 py-1.5 hover:bg-muted/40 transition-colors inline-flex items-center gap-1.5"
          onClick={() => void handleVorschau(text)}
          data-testid="button-manuelle-buchungen-vorschau">
          {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" />} Vorschau
        </button>
        {zeilen.length > 0 && (
          <button type="button" disabled={busy || importierbar.length === 0}
            className="text-xs font-medium rounded-lg bg-primary text-primary-foreground px-3 py-1.5 hover:opacity-90 transition-opacity disabled:opacity-50"
            onClick={() => void handleImport()}
            data-testid="button-manuelle-buchungen-import">
            {importierbar.length} Buchung{importierbar.length === 1 ? '' : 'en'} importieren
          </button>
        )}
      </div>

      {strukturFehler.length > 0 && (
        <div className="text-xs text-red-600" data-testid="manuelle-buchungen-fehler">
          {strukturFehler.map((f, i) => <div key={i}>{f}</div>)}
        </div>
      )}

      {neueLieferanten.length > 0 && (
        <div className="text-[11px] rounded-md border border-amber-300/60 bg-amber-50 dark:bg-amber-950/30 px-2 py-1.5">
          Neue Lieferanten (werden beim Import im Stamm angelegt): {neueLieferanten.join(', ')}
        </div>
      )}

      {zeilen.length > 0 && (
        <div className="rounded-md border border-border/50 overflow-x-auto" data-testid="manuelle-buchungen-vorschau">
          <table className="w-full text-xs">
            <thead>
              <tr className="bg-muted/40 text-left">
                <th className="px-2 py-1.5">Mandant</th>
                <th className="px-2 py-1.5">Lieferant</th>
                <th className="px-2 py-1.5">Datum</th>
                <th className="px-2 py-1.5">BelegNr</th>
                <th className="px-2 py-1.5">Kategorie</th>
                <th className="px-2 py-1.5">Konto</th>
                <th className="px-2 py-1.5 text-right">Netto</th>
                <th className="px-2 py-1.5 text-right">MwSt %</th>
                <th className="px-2 py-1.5 text-right">MwSt CHF</th>
                <th className="px-2 py-1.5 text-right">Brutto</th>
                <th className="px-2 py-1.5">Bemerkung</th>
                <th className="px-2 py-1.5">Status</th>
              </tr>
            </thead>
            <tbody>
              {zeilen.map((z, i) => (
                <tr key={i} className={z.fehler.length > 0 ? 'bg-red-50 dark:bg-red-950/20' : undefined}
                  data-testid={`manuelle-buchungen-zeile-${i}`}>
                  <td className="px-2 py-1">
                    {z.mandant === 'oliv' ? 'Oliv' : z.mandant === 'beaulieu' ? 'Beaulieu' : z.mandantRoh}
                    {z.mandant !== null && z.mandant !== tenantId && (
                      <span className="ml-1 text-[10px] text-amber-600" title="Wird in den Keys dieses Mandanten gebucht — nicht im aktuell angezeigten.">anderer Mandant</span>
                    )}
                  </td>
                  <td className="px-2 py-1">
                    {z.lieferantKanonisch || '—'}
                    {z.neuerLieferant && <span className="ml-1 text-[10px] text-amber-600">neu</span>}
                  </td>
                  <td className="px-2 py-1">{z.datum ?? '—'}</td>
                  <td className="px-2 py-1">{z.belegNr || '—'}</td>
                  <td className="px-2 py-1">{z.kategorie}</td>
                  <td className="px-2 py-1">{z.konto || '—'}</td>
                  <td className="px-2 py-1 text-right tabular-nums">{fmtChf(z.netto)}</td>
                  <td className="px-2 py-1 text-right tabular-nums">{z.mwstSatz ?? '—'}</td>
                  <td className="px-2 py-1 text-right tabular-nums">{fmtChf(z.mwst)}</td>
                  <td className="px-2 py-1 text-right tabular-nums">{fmtChf(z.brutto)}</td>
                  <td className="px-2 py-1 max-w-[160px] truncate" title={z.bemerkung}>{z.bemerkung}</td>
                  <td className="px-2 py-1">
                    {z.fehler.length > 0
                      ? <span className="text-red-600" title={z.fehler.join(' · ')}>Fehler: {z.fehler[0]}</span>
                      : z.geschuetzt
                      ? <span className="text-red-600" title={z.geschuetzt}>geschützt — übersprungen</span>
                      : z.dublette
                      ? <span className="text-amber-600" title="Beleg existiert — alle bestehenden (ersetzbaren) Zeilen dieses Belegs werden ersetzt.">wird ersetzt</span>
                      : <span className="text-emerald-600">neu</span>}
                  </td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              {(['oliv', 'beaulieu'] as const).map(m => summen[m] && (
                <tr key={m} className="border-t border-border/50 font-medium bg-muted/20">
                  <td className="px-2 py-1.5" colSpan={6}>Summe {m === 'oliv' ? 'Oliv' : 'Beaulieu'} ({summen[m]!.anzahl} Zeilen)</td>
                  <td className="px-2 py-1.5 text-right tabular-nums">{fmtChf(summen[m]!.netto)}</td>
                  <td className="px-2 py-1.5" />
                  <td className="px-2 py-1.5 text-right tabular-nums">{fmtChf(summen[m]!.mwst)}</td>
                  <td className="px-2 py-1.5 text-right tabular-nums">{fmtChf(summen[m]!.brutto)}</td>
                  <td className="px-2 py-1.5" colSpan={2} />
                </tr>
              ))}
            </tfoot>
          </table>
        </div>
      )}

      <WarenImportUndoButton tenantId={tenantId} typ="manuell" refresh={undoRefresh}
        onUndone={() => { setUndoRefresh(k => k + 1); onImported(); }} />
    </div>
  );
}
