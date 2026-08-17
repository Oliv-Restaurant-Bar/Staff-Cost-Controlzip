/**
 * UmsatzKategorienTab — «Umsatzanalyse Kategorien» in der Produkteanalyse
 * =======================================================================
 * Eigener Import-Kanal (Excel, breites Format mit Tagesspalten) + Auswertung
 * je Gruppe (Food/Beverage): Ranking-Tabelle mit Anteil % und horizontale
 * Balken, Zeitraum-Label dynamisch aus den vorhandenen Daten des Jahres.
 *
 * Mandantengetrennt (tenantKey), dublettensicher (Ersetzen statt Addieren),
 * mit Vorschau vor dem Anwenden und Undo des letzten Imports.
 * PDF-Export: dieselben Vektor-Seiten wie im Cockpit-Export.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Upload, Undo2, FileDown, Utensils, Wine } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { useToast } from '@/hooks/use-toast';
import { useTenant } from '@/contexts/TenantContext';
import {
  parseUmsatzKategorienExcel, applyUmsatzKategorienImport,
  loadUmsatzKategorien, loadUmsatzKategorienUndoInfo, undoUmsatzKategorienImport,
  berechneKatAuswertung,
  UMSATZ_KATEGORIEN_UPDATED_EVENT,
  type KatParseErgebnis, type KatGruppe, type UmsatzKategorienBlob,
} from '@/lib/umsatz-kategorien';
import { ZeitraumSteuerung } from '@/components/ZeitraumSteuerung';
import { initialZeitraum, zeitraumGrenzen, type Zeitraum } from '@/lib/zeitraum';

const fmtChf = (n: number) => n.toLocaleString('de-CH', { maximumFractionDigits: 0 });
const fmtDatum = (iso: string) => `${iso.slice(8, 10)}.${iso.slice(5, 7)}.${iso.slice(0, 4)}`;

export default function UmsatzKategorienTab() {
  const { tenantId } = useTenant();
  const { toast } = useToast();
  const fileRef = useRef<HTMLInputElement>(null);

  // Race-Wache: async Ergebnisse (Laden/Parsen) nur übernehmen, wenn der
  // Mandant seit dem Start unverändert ist (Wechsel darf nichts «mitnehmen»).
  const tenantRef = useRef(tenantId);
  tenantRef.current = tenantId;

  const [blob, setBlob] = useState<UmsatzKategorienBlob | null>(null);
  // Zeitraum-Steuerung: Woche/Monat/Jahr, Standard = aktueller Monat.
  const [zeitraum, setZeitraum] = useState<Zeitraum>(() => initialZeitraum('monat'));
  const [ladeFehler, setLadeFehler] = useState<string | null>(null);
  const [vorschau, setVorschau] = useState<{ parse: KatParseErgebnis; fileName: string; tenantId: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [undoInfo, setUndoInfo] = useState<{ fileName: string; at: string } | null>(null);

  const laden = useCallback(async () => {
    const tid = tenantId;
    setLadeFehler(null);
    try {
      const geladen = await loadUmsatzKategorien(tid);
      const undo = await loadUmsatzKategorienUndoInfo(tid).catch(() => null);
      if (tenantRef.current !== tid) return; // Mandant gewechselt → verwerfen
      setBlob(geladen);
      setUndoInfo(undo);
    } catch (e) {
      if (tenantRef.current !== tid) return;
      setBlob(null);
      setLadeFehler(e instanceof Error ? e.message : 'Daten konnten nicht geladen werden.');
    }
  }, [tenantId]);

  useEffect(() => {
    // Mandantenwechsel: nichts «mitnehmen»
    setBlob(null); setVorschau(null); setUndoInfo(null); setLadeFehler(null);
    void laden();
    const h = () => { void laden(); };
    window.addEventListener(UMSATZ_KATEGORIEN_UPDATED_EVENT, h);
    return () => window.removeEventListener(UMSATZ_KATEGORIEN_UPDATED_EVENT, h);
  }, [laden]);

  // ── Datei wählen → nur Vorschau (noch nichts speichern) ─────────────────────
  const handleFile = useCallback(async (file: File) => {
    const tid = tenantId;
    const parse = parseUmsatzKategorienExcel(await file.arrayBuffer());
    if (tenantRef.current !== tid) return; // Wechsel während des Parsens
    setVorschau({ parse, fileName: file.name, tenantId: tid });
  }, [tenantId]);

  const vorschauStats = useMemo(() => {
    if (!vorschau || vorschau.parse.failureReason) return null;
    const tage = new Set<string>(); const kats = new Set<string>();
    let food = 0, bev = 0;
    for (const e of vorschau.parse.eintraege) {
      tage.add(e.datum); kats.add(`${e.gruppe}|${e.kategorie}`);
      if (e.gruppe === 'food') food += e.umsatz; else bev += e.umsatz;
    }
    const sorted = Array.from(tage).sort();
    return { tage: tage.size, von: sorted[0], bis: sorted[sorted.length - 1], kategorien: kats.size, food, bev };
  }, [vorschau]);

  const anwenden = useCallback(async () => {
    if (!vorschau || vorschau.parse.failureReason) return;
    if (vorschau.tenantId !== tenantId) { // Sicherheitsnetz gegen Fremd-Mandant
      toast({ title: 'Import abgebrochen', description: 'Vorschau stammt von einem anderen Mandanten.', variant: 'destructive' });
      setVorschau(null);
      return;
    }
    setBusy(true);
    try {
      const r = await applyUmsatzKategorienImport(tenantId, vorschau.parse.eintraege, vorschau.fileName);
      toast({ title: 'Import angewendet', description: `${r.neu} neue, ${r.ersetzt} ersetzte Werte über ${r.tage} Tage.` });
      setVorschau(null);
      await laden();
    } catch (e) {
      toast({ title: 'Import fehlgeschlagen', description: e instanceof Error ? e.message : 'Unbekannter Fehler', variant: 'destructive' });
    } finally { setBusy(false); }
  }, [vorschau, tenantId, toast, laden]);

  const undo = useCallback(async () => {
    setBusy(true);
    try {
      await undoUmsatzKategorienImport(tenantId);
      toast({ title: 'Import rückgängig gemacht' });
      await laden();
    } catch (e) {
      toast({ title: 'Undo nicht möglich', description: e instanceof Error ? e.message : 'Unbekannter Fehler', variant: 'destructive' });
    } finally { setBusy(false); }
  }, [tenantId, toast, laden]);

  // Auswertung für den gewählten Zeitraum (Woche/Monat/Jahr).
  const grenzen = useMemo(() => zeitraumGrenzen(zeitraum), [zeitraum]);
  const auswertung = useMemo(
    () => (blob ? berechneKatAuswertung(blob, zeitraum.year, { from: grenzen.from, to: grenzen.to }) : null),
    [blob, zeitraum.year, grenzen],
  );

  const pdfExport = useCallback(async () => {
    if (!auswertung) return;
    const [{ jsPDF }, mod, branding] = await Promise.all([
      import('jspdf'), import('@/lib/umsatzanalyse-kategorien-pdf'), import('@/lib/pl-branding'),
    ]);
    const pdf = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });
    mod.zeichneUmsatzKategorienSeite(pdf, auswertung, branding.getBranding(tenantId).displayName, false);
    pdf.save(`umsatzanalyse-kategorien-${grenzen.from}-${grenzen.to}.pdf`);
  }, [auswertung, tenantId, grenzen]);

  return (
    <div className="space-y-4">

      {/* Import-Kanal */}
      <Card>
        <CardContent className="pt-4 pb-4 space-y-3">
          <div className="flex items-center justify-between flex-wrap gap-2">
            <div>
              <div className="font-semibold text-sm">Import «Umsatzanalyse Kategorien»</div>
              <div className="text-xs text-muted-foreground">
                Excel im breiten Format: Bezeichnung | Gesamtbetrag (ignoriert) | Tagesspalten TT.MM.JJJJ.
                Erneuter Upload ersetzt die Werte der enthaltenen Tage/Kategorien (kein Aufsummieren).
              </div>
            </div>
            <div className="flex items-center gap-2">
              <input
                ref={fileRef} type="file" accept=".xlsx,.xls" className="hidden"
                data-testid="input-umsatzkategorien-datei"
                onChange={e => { const f = e.target.files?.[0]; if (f) void handleFile(f); e.target.value = ''; }}
              />
              <Button size="sm" variant="outline" className="gap-1.5" disabled={busy}
                data-testid="button-umsatzkategorien-upload"
                onClick={() => fileRef.current?.click()}>
                <Upload className="h-3.5 w-3.5" /> Excel wählen
              </Button>
              {undoInfo && (
                <Button size="sm" variant="ghost" className="gap-1.5" disabled={busy}
                  data-testid="button-umsatzkategorien-undo" onClick={() => void undo()}>
                  <Undo2 className="h-3.5 w-3.5" /> Letzten Import rückgängig
                </Button>
              )}
            </div>
          </div>

          {/* Vorschau */}
          {vorschau && (
            <div className="rounded-md border p-3 text-sm space-y-2" data-testid="panel-umsatzkategorien-vorschau">
              {vorschau.parse.failureReason ? (
                <div className="text-destructive text-xs">
                  <div className="font-medium">Datei nicht erkannt: {vorschau.parse.failureReason}</div>
                  <div className="text-muted-foreground mt-1">
                    Erkannt: {vorschau.parse.debug.tagesSpalten} Tagesspalten,
                    Gruppen: {vorschau.parse.debug.gruppenGefunden.join(', ') || 'keine'} ·
                    Kopf: {vorschau.parse.debug.kopfBeispiele.join(' | ')}
                  </div>
                </div>
              ) : vorschauStats && (
                <>
                  <div className="font-medium">{vorschau.fileName}</div>
                  <div className="text-xs text-muted-foreground">
                    {vorschauStats.tage} Tage ({fmtDatum(vorschauStats.von)}–{fmtDatum(vorschauStats.bis)}) ·{' '}
                    {vorschauStats.kategorien} Kategorien · Food CHF {fmtChf(vorschauStats.food)} · Beverage CHF {fmtChf(vorschauStats.bev)}
                  </div>
                  <div className="flex gap-2">
                    <Button size="sm" disabled={busy} data-testid="button-umsatzkategorien-anwenden"
                      onClick={() => void anwenden()}>
                      Import anwenden
                    </Button>
                    <Button size="sm" variant="ghost" disabled={busy} onClick={() => setVorschau(null)}>
                      Verwerfen
                    </Button>
                  </div>
                </>
              )}
            </div>
          )}
        </CardContent>
      </Card>

      {ladeFehler && <div className="text-sm text-destructive" data-testid="text-umsatzkategorien-fehler">{ladeFehler}</div>}

      {/* Auswertung: Food & Beverage untereinander (volles Ranking je Gruppe) */}
      <Card>
        <CardContent className="pt-4 pb-4 space-y-6">
          <div className="flex items-center justify-between flex-wrap gap-2">
            <div>
              <div className="font-semibold">Umsatzanalyse Food & Beverage Kategorien</div>
              <div className="text-xs text-muted-foreground" data-testid="text-umsatzkategorien-zeitraum">
                {auswertung?.zeitraum
                  ? `Daten: ${fmtDatum(auswertung.zeitraum.von)} bis ${fmtDatum(auswertung.zeitraum.bis)}`
                  : 'Keine Daten im gewählten Zeitraum.'}
              </div>
            </div>
            <div className="flex items-center gap-2 flex-wrap">
              <ZeitraumSteuerung
                value={zeitraum}
                onChange={setZeitraum}
                granularitaeten={['woche', 'monat', 'jahr']}
              />
              <Button size="sm" variant="outline" className="gap-1.5" disabled={!auswertung?.zeitraum}
                data-testid="button-umsatzkategorien-pdf" onClick={() => void pdfExport()}>
                <FileDown className="h-3.5 w-3.5" /> PDF
              </Button>
            </div>
          </div>

          {(['food', 'beverage'] as KatGruppe[]).map(k => {
            const g = auswertung ? auswertung[k] : null;
            const label = k === 'food' ? 'Food' : 'Beverage';
            if (!g || g.zeilen.length === 0) {
              return (
                <div key={k} className="text-sm text-muted-foreground py-4 text-center border rounded-md">
                  Keine {label}-Daten im gewählten Zeitraum — ggf. Excel oben importieren.
                </div>
              );
            }
            const maxPct = Math.max(...g.zeilen.map(z => z.anteilPct ?? 0), 0.001);
            return (
              <div key={k} className="space-y-3" data-testid={`block-umsatzkategorien-${k}`}>
                <div className="flex items-center gap-2 font-semibold text-sm">
                  <span className="inline-block w-1 h-4 rounded bg-teal-600" />
                  {k === 'food' ? <Utensils className="h-3.5 w-3.5" /> : <Wine className="h-3.5 w-3.5" />}
                  {label}
                  {g.total != null && (
                    <span className="ml-auto text-xs font-bold text-muted-foreground">
                      TOTAL {label.toUpperCase()} UMSATZ: CHF {fmtChf(g.total)}
                    </span>
                  )}
                </div>
                <div className="grid md:grid-cols-2 gap-6">
                  {/* Ranking (volle Liste) */}
                  <div>
                    <table className="w-full text-sm" data-testid={`table-umsatzkategorien-ranking-${k}`}>
                      <thead>
                        <tr className="text-xs uppercase tracking-wide text-muted-foreground border-b">
                          <th className="text-left py-1.5 pr-2 w-10">Rang</th>
                          <th className="text-left py-1.5 pr-2">Kategorie</th>
                          <th className="text-right py-1.5 pr-2">Umsatz (CHF)</th>
                          <th className="text-right py-1.5">Anteil %</th>
                        </tr>
                      </thead>
                      <tbody>
                        {g.zeilen.map((z, i) => (
                          <tr key={z.kategorie} className={cn('border-b last:border-b-0', i < 3 && 'font-semibold')}>
                            <td className="py-1.5 pr-2">{i + 1}</td>
                            <td className="py-1.5 pr-2">{z.kategorie}</td>
                            <td className="py-1.5 pr-2 text-right tabular-nums">{fmtChf(z.umsatz)}</td>
                            <td className="py-1.5 text-right tabular-nums">{z.anteilPct != null ? `${z.anteilPct.toFixed(1)} %` : '—'}</td>
                          </tr>
                        ))}
                        <tr className="font-bold bg-muted/40">
                          <td className="py-1.5 pr-2" colSpan={2}>TOTAL {label.toUpperCase()}</td>
                          <td className="py-1.5 pr-2 text-right tabular-nums">{g.total != null ? fmtChf(g.total) : '—'}</td>
                          <td className="py-1.5 text-right tabular-nums">100.0 %</td>
                        </tr>
                      </tbody>
                    </table>
                  </div>
                  {/* Balken (Top 12 wie PDF) */}
                  <div>
                    <div className="text-xs font-medium text-muted-foreground mb-2">Umsatzanteil je Kategorie (Top 12)</div>
                    <div className="space-y-1.5" data-testid={`chart-umsatzkategorien-balken-${k}`}>
                      {g.zeilen.slice(0, 12).map(z => (
                        <div key={z.kategorie} className="flex items-center gap-2 text-xs">
                          <span className="w-28 shrink-0 truncate text-right text-muted-foreground">{z.kategorie}</span>
                          <div className="flex-1 h-4 bg-muted/40 rounded-sm overflow-hidden">
                            <div className="h-full rounded-sm bg-teal-600"
                              style={{ width: `${Math.max(((z.anteilPct ?? 0) / maxPct) * 100, 1)}%` }} />
                          </div>
                          <span className="w-12 shrink-0 tabular-nums font-medium">
                            {z.anteilPct != null ? `${z.anteilPct.toFixed(1)} %` : '—'}
                          </span>
                        </div>
                      ))}
                    </div>
                    {/* Kernaussage */}
                    {(() => {
                      const pctSum = (n: number) => {
                        const v = g.zeilen.slice(0, n).map(z => z.anteilPct).filter((p): p is number => p != null);
                        return v.length ? v.reduce((s, p) => s + p, 0) : null;
                      };
                      const top2 = pctSum(2), top4 = pctSum(4);
                      return top2 != null ? (
                        <div className="mt-4 rounded-md border-l-2 border-teal-600 bg-muted/30 p-3 text-xs" data-testid={`text-umsatzkategorien-kernaussage-${k}`}>
                          <span className="font-semibold">Kernaussage: </span>
                          Top 2 zusammen {top2.toFixed(1)} %
                          {top4 != null ? `, Top 4 zusammen ${top4.toFixed(1)} %` : ''} des {label}-Umsatzes.
                        </div>
                      ) : null;
                    })()}
                  </div>
                </div>
              </div>
            );
          })}
        </CardContent>
      </Card>
    </div>
  );
}
