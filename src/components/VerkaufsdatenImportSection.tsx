/**
 * VerkaufsdatenImportSection — Gastronovi Food/Beverage-Jahresexport (Artikel)
 * ============================================================================
 * Vier Tab-getrennte Dateien pro Jahr (Food-Umsatz, Food-Anzahl,
 * Beverage-Umsatz, Beverage-Anzahl) → speist AUSSCHLIESSLICH «Gäste Take
 * Away» (TA-Artikel = 1 Gast/Einheit) und das Verkaufszahlen-Archiv.
 * Cockpit-Food/Beverage kommt NICHT von hier (nur Umsatz-Excel);
 * Artikel-Details für die Produktanalyse über den Produkte-Import.
 * Parser/Speicherlogik in src/lib/verkaufsdaten-import.ts; hier nur UI,
 * Vorschau, Sperre, Undo-Snapshot.
 */

import { useMemo, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { toast } from 'sonner';
import { Upload, CheckCircle2, Loader2, AlertCircle, FileSpreadsheet, X } from 'lucide-react';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { LastImportPanel } from '@/components/import-center/LastImportPanel';
import { useTenant } from '@/contexts/TenantContext';
import { recordImportRun, type KvKeyItem } from '@/lib/import-undo-store';
import {
  parseVerkaufsdatenFile, buildVkPlan, commitVerkaufsdaten, verkaufszahlenKey,
  type VkParsedFile, type VkBlob, type VkPlan,
} from '@/lib/verkaufsdaten-import';
import { taGaesteKeyFor } from '@/lib/ta-gaeste-store';
import { notifyReportingDataChanged } from '@/lib/import-events';

const fmtChf = (v: number) => v.toLocaleString('de-CH', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmtCnt = (v: number) => Math.round(v).toLocaleString('de-CH');

const KIND_LABEL = { umsatz: 'Umsatz (CHF)', anzahl: 'Anzahl (Stück)' } as const;
const CAT_LABEL = { food: 'Food', beverage: 'Beverage' } as const;

export function VerkaufsdatenImportSection() {
  const { tenantId, tenantKey, tenant } = useTenant();
  const currentYear = new Date().getFullYear();
  const years = Array.from({ length: 6 }, (_, i) => currentYear - i);

  const [year, setYear] = useState(currentYear - 1);
  const [files, setFiles] = useState<VkParsedFile[]>([]);
  const [plan, setPlan] = useState<VkPlan | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const reset = () => { setFiles([]); setPlan(null); setConfirmOpen(false); };

  // Dubletten: gleiche Kategorie+Typ doppelt hochgeladen → blockieren.
  const duplicateSlots = useMemo(() => {
    const seen = new Set<string>(); const dups = new Set<string>();
    for (const f of files) {
      if (!f.ok || !f.category || !f.kind) continue;
      const slot = `${f.category}/${f.kind}`;
      if (seen.has(slot)) dups.add(slot); else seen.add(slot);
    }
    return dups;
  }, [files]);
  const okFiles = files.filter(f => f.ok);

  const handleFiles = async (list: FileList | null) => {
    if (!list || list.length === 0) return;
    setBusy(true); setPlan(null);
    try {
      const parsed: VkParsedFile[] = [...files];
      for (const file of Array.from(list)) {
        const text = await file.text(); // UTF-8
        const p = parseVerkaufsdatenFile(text, file.name);
        if (!p.ok) {
          console.warn(`[VERKAUFSDATEN] Parser-Fehler «${file.name}»: ${p.failureReason}`, p.debug);
        }
        parsed.push(p);
      }
      setFiles(parsed);
    } finally {
      setBusy(false);
      if (inputRef.current) inputRef.current.value = '';
    }
  };

  const buildPreview = async () => {
    if (okFiles.length === 0 || duplicateSlots.size > 0) return;
    setBusy(true);
    try {
      // Bestand fürs neu/aktualisiert/unverändert-Diff (Archiv-Blob); Lesefehler
      // ⇒ Vorschau ohne Diff wäre irreführend → Fehler zeigen, Import stoppen.
      const { kvGetStrict } = await import('@/lib/supabase-kv');
      const prev = (await kvGetStrict(tenantKey(verkaufszahlenKey(year)))) as VkBlob | null;
      setPlan(buildVkPlan(year, okFiles, prev?.days ?? {}));
    } catch (e) {
      toast.error('Bestand konnte nicht gelesen werden (Vorschau abgebrochen): ' + String(e instanceof Error ? e.message : e));
    } finally {
      setBusy(false);
    }
  };

  const monthSummary = useMemo(() => {
    if (!plan) return [];
    const acc = new Map<string, { foodRev: number; bevRev: number; foodCnt: number; bevCnt: number; taGuests: number; hasTa: boolean; days: number }>();
    for (const [date, rec] of Object.entries(plan.days)) {
      const m = date.slice(0, 7);
      const a = acc.get(m) ?? { foodRev: 0, bevRev: 0, foodCnt: 0, bevCnt: 0, taGuests: 0, hasTa: false, days: 0 };
      a.foodRev += rec.foodRevenue ?? 0; a.bevRev += rec.beverageRevenue ?? 0;
      a.foodCnt += rec.foodCount ?? 0; a.bevCnt += rec.beverageCount ?? 0;
      if (rec.taGuests !== undefined) { a.taGuests += rec.taGuests; a.hasTa = true; }
      a.days++;
      acc.set(m, a);
    }
    return [...acc.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [plan]);

  const totals = useMemo(() => monthSummary.reduce((t, [, m]) => ({
    foodRev: t.foodRev + m.foodRev, bevRev: t.bevRev + m.bevRev,
    foodCnt: t.foodCnt + m.foodCnt, bevCnt: t.bevCnt + m.bevCnt,
    taGuests: t.taGuests + m.taGuests, hasTa: t.hasTa || m.hasTa,
  }), { foodRev: 0, bevRev: 0, foodCnt: 0, bevCnt: 0, taGuests: 0, hasTa: false }), [monthSummary]);

  const handleCommit = async () => {
    if (!plan) return;
    setConfirmOpen(false);
    setBusy(true);
    try {
      // KEINE Jahres-Sperr-Prüfung: dieser Import berührt keine
      // festgeschriebenen Umsatz-/Kosten-/Cockpit-Daten (nur Archiv + Gäste
      // Take Away) und ist deshalb bewusst von der Sperre ausgenommen.
      const archiveKey = tenantKey(verkaufszahlenKey(year));
      const taGaesteKey = taGaesteKeyFor(tenantKey);
      const hasTaGuests = Object.values(plan.days).some(r => r.taGuests !== undefined);

      // ── Undo-Snapshot VOR den Writes (best-effort; ohne Snapshot Warnung) ──
      // Gesichert werden nur die tatsächlich geschriebenen Ziele: Archiv-Blob
      // + «Gäste Take Away»-Blob. dailyBudgets/vj_daily werden seit der
      // Datenquellen-Trennung nicht mehr angefasst.
      let snapshot: Parameters<typeof recordImportRun>[1]['snapshot'];
      try {
        const { kvGetStrict } = await import('@/lib/supabase-kv');
        const kvItems: KvKeyItem[] = [{
          key: archiveKey,
          value: ((await kvGetStrict(archiveKey)) as unknown) ?? null,
        }];
        if (hasTaGuests) {
          // «Gäste Take Away»-Blob komplett sichern (Merge-Save → Undo stellt
          // den ganzen Vorzustand wieder her, andere Jahre inklusive).
          kvItems.push({
            key: taGaesteKey,
            value: ((await kvGetStrict(taGaesteKey)) as unknown) ?? null,
          });
        }
        snapshot = { kind: 'kv-keys' as const, items: kvItems };
      } catch (err) {
        snapshot = undefined;
        console.warn('[VERKAUFSDATEN] Undo-Snapshot fehlgeschlagen (Import läuft weiter):', err);
        toast.warning('Rückgängig-Protokoll nicht verfügbar — Import läuft ohne Undo weiter.');
      }

      const res = await commitVerkaufsdaten({ archiveKey, taGaesteKey, plan });

      const slotList = okFiles.map(f => `${CAT_LABEL[f.category!]} ${f.kind === 'umsatz' ? 'Umsatz' : 'Anzahl'}`).join(', ');
      try {
        await recordImportRun(tenantId, {
          source: 'verkaufsdaten-food-beverage',
          periodLabel: `Jahr ${year}`,
          itemCount: res.archivedDays,
          itemLabel: 'Tage',
          fileName: okFiles.map(f => f.fileName).join(' · '),
          details: `${slotList} — neu ${plan.neu} / aktualisiert ${plan.aktualisiert} / unverändert ${plan.unveraendert}` +
            (res.taGuestDays > 0 ? ` — Gäste Take Away: ${res.taGuestDays} Tage` : ''),
          ...(snapshot ? { snapshot } : {}),
        });
      } catch (err) {
        console.error('[VERKAUFSDATEN] Import-Protokoll fehlgeschlagen:', err);
        toast.warning('Import-Protokoll konnte nicht gespeichert werden — «Rückgängig» ist für diesen Lauf nicht verfügbar.');
      }

      window.dispatchEvent(new Event('supabase-kv-synced'));
      notifyReportingDataChanged();
      console.log(`[VERKAUFSDATEN] tenant: ${tenantId} | Jahr ${year} | Archiv-Tage: ${res.archivedDays} | Gäste TA: ${res.taGuestDays}`);
      toast.success(`Verkaufsdaten ${year} gespeichert: ${res.archivedDays} Tage im Archiv${res.taGuestDays > 0 ? `, ${res.taGuestDays} Tage Gäste Take Away` : ''} — Cockpit-Food/Beverage bleibt unverändert (Quelle: Umsatz-Excel).`);
      reset();
    } catch (e) {
      toast.error('Fehler beim Speichern: ' + String(e instanceof Error ? e.message : e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-3" data-testid="verkaufsdaten-import-section">
      <LastImportPanel
        source="verkaufsdaten-food-beverage"
        undoHint="Zurückgesetzt werden das Verkaufsdaten-Archiv des Jahres und die «Gäste Take Away»-Tageswerte. Cockpit-Food/Beverage und übrige Tagesdaten (Umsatz, Gäste IN) werden von diesem Import gar nicht berührt."
      />
      <div className="rounded-lg border border-lime-300 dark:border-lime-800 bg-lime-50/50 dark:bg-lime-950/10 p-4 space-y-3">
        <p className="text-xs text-muted-foreground">
          Vier Gastronovi-Artikel-Exporte pro Jahr (Tab-getrennt): <strong>Food-Umsatz,
          Food-Anzahl, Beverage-Umsatz, Beverage-Anzahl</strong>. Speist ausschliesslich{' '}
          <strong>«Gäste Take Away»</strong> (pro verkauftem TA-Artikel zählt 1 Gast — daraus
          auch der Take-Away-Anteil) und das Verkaufszahlen-Archiv. Die Cockpit-Zeilen{' '}
          <strong>Food/Beverage kommen NICHT von hier</strong> — sie stammen ausschliesslich
          aus dem Umsatz-Excel («Umsatz Ist»/«Umsatz Vorjahr»). Artikel-Umsätze und -Anzahlen
          für die <strong>Produktanalyse</strong> importierst du über den Produkte-Import
          (Seite «Produkte»). Aktiver Mandant: <strong>{tenant?.name ?? tenantId ?? 'Oliv'}</strong>.
        </p>

        <div className="flex flex-wrap items-center gap-2">
          <Select value={String(year)} onValueChange={v => { setYear(Number(v)); setPlan(null); }}>
            <SelectTrigger className="w-28 h-8 text-xs" data-testid="vk-year-select">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {years.map(y => <SelectItem key={y} value={String(y)}>{y}</SelectItem>)}
            </SelectContent>
          </Select>
          <input
            ref={inputRef} type="file" multiple accept=".txt,.tsv,.csv,.xls,text/plain,text/tab-separated-values"
            className="hidden" onChange={e => void handleFiles(e.target.files)}
            data-testid="vk-file-input"
          />
          <Button size="sm" variant="outline" className="h-8 text-xs" disabled={busy}
            onClick={() => inputRef.current?.click()} data-testid="vk-upload-button">
            <Upload className="h-3.5 w-3.5 mr-1" /> Dateien wählen (bis 4)
          </Button>
          {files.length > 0 && (
            <Button size="sm" variant="ghost" className="h-8 text-xs" onClick={reset} data-testid="vk-reset">
              <X className="h-3.5 w-3.5 mr-1" /> Zurücksetzen
            </Button>
          )}
        </div>

        {files.length > 0 && (
          <div className="space-y-1" data-testid="vk-file-list">
            {files.map((f, i) => (
              <div key={i} className="flex flex-wrap items-center gap-2 text-xs rounded border bg-background px-2 py-1.5">
                <FileSpreadsheet className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                <span className="truncate max-w-[220px]" title={f.fileName}>{f.fileName}</span>
                {f.ok && f.category && f.kind ? (
                  <>
                    <span className="rounded border border-lime-300 bg-lime-50 dark:bg-lime-950/30 px-1 py-px">
                      {CAT_LABEL[f.category]} · {KIND_LABEL[f.kind]}
                    </span>
                    <span className="text-muted-foreground">{Object.keys(f.days).length} Tage</span>
                    {f.periodTotal !== null && (
                      <span className="text-muted-foreground">
                        Zeitraum-Total: {f.kind === 'umsatz' ? `CHF ${fmtChf(f.periodTotal)}` : fmtCnt(f.periodTotal)}
                      </span>
                    )}
                  </>
                ) : (
                  <span className="text-red-600 inline-flex items-center gap-1">
                    <AlertCircle className="h-3.5 w-3.5" /> {f.failureReason}
                  </span>
                )}
              </div>
            ))}
            {duplicateSlots.size > 0 && (
              <p className="text-xs text-red-600">
                Doppelt hochgeladen: {[...duplicateSlots].join(', ')} — bitte zurücksetzen und je Kategorie/Typ nur eine Datei wählen.
              </p>
            )}
          </div>
        )}

        {okFiles.length > 0 && duplicateSlots.size === 0 && !plan && (
          <Button size="sm" className="h-8 text-xs" disabled={busy} onClick={() => void buildPreview()} data-testid="vk-preview-button">
            {busy ? <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" /> : null}
            Vorschau erstellen ({okFiles.length} Datei{okFiles.length > 1 ? 'en' : ''}, Jahr {year})
          </Button>
        )}

        {plan && (
          <div className="space-y-2" data-testid="vk-preview">
            <div className="flex flex-wrap gap-2 text-xs">
              <span className="rounded border border-emerald-300 bg-emerald-50 dark:bg-emerald-950/30 px-1.5 py-0.5" data-testid="vk-count-neu">neu: {plan.neu}</span>
              <span className="rounded border border-amber-300 bg-amber-50 dark:bg-amber-950/30 px-1.5 py-0.5" data-testid="vk-count-akt">aktualisiert: {plan.aktualisiert}</span>
              <span className="rounded border bg-muted/40 px-1.5 py-0.5" data-testid="vk-count-unv">unverändert: {plan.unveraendert}</span>
            </div>
            <div className="overflow-x-auto rounded border bg-background">
              <table className="w-full text-xs">
                <thead>
                  <tr className="border-b bg-muted/50 text-muted-foreground">
                    <th className="px-2 py-1 text-left">Monat</th>
                    <th className="px-2 py-1 text-right">Food (CHF)</th>
                    <th className="px-2 py-1 text-right">Food (Stück)</th>
                    <th className="px-2 py-1 text-right">Beverage (CHF)</th>
                    <th className="px-2 py-1 text-right">Beverage (Stück)</th>
                    {totals.hasTa && <th className="px-2 py-1 text-right">Gäste TA</th>}
                    <th className="px-2 py-1 text-right">Tage</th>
                  </tr>
                </thead>
                <tbody>
                  {monthSummary.map(([m, s]) => (
                    <tr key={m} className="border-b last:border-0">
                      <td className="px-2 py-1">{m}</td>
                      <td className="px-2 py-1 text-right tabular-nums">{s.foodRev > 0 ? fmtChf(s.foodRev) : ''}</td>
                      <td className="px-2 py-1 text-right tabular-nums">{s.foodCnt > 0 ? fmtCnt(s.foodCnt) : ''}</td>
                      <td className="px-2 py-1 text-right tabular-nums">{s.bevRev > 0 ? fmtChf(s.bevRev) : ''}</td>
                      <td className="px-2 py-1 text-right tabular-nums">{s.bevCnt > 0 ? fmtCnt(s.bevCnt) : ''}</td>
                      {totals.hasTa && <td className="px-2 py-1 text-right tabular-nums">{s.hasTa ? fmtCnt(s.taGuests) : ''}</td>}
                      <td className="px-2 py-1 text-right tabular-nums">{s.days}</td>
                    </tr>
                  ))}
                  <tr className="font-semibold bg-muted/30">
                    <td className="px-2 py-1">Total {year}</td>
                    <td className="px-2 py-1 text-right tabular-nums" data-testid="vk-total-food">{totals.foodRev > 0 ? fmtChf(totals.foodRev) : ''}</td>
                    <td className="px-2 py-1 text-right tabular-nums">{totals.foodCnt > 0 ? fmtCnt(totals.foodCnt) : ''}</td>
                    <td className="px-2 py-1 text-right tabular-nums" data-testid="vk-total-bev">{totals.bevRev > 0 ? fmtChf(totals.bevRev) : ''}</td>
                    <td className="px-2 py-1 text-right tabular-nums">{totals.bevCnt > 0 ? fmtCnt(totals.bevCnt) : ''}</td>
                    {totals.hasTa && <td className="px-2 py-1 text-right tabular-nums" data-testid="vk-total-ta-gaeste">{fmtCnt(totals.taGuests)}</td>}
                    <td className="px-2 py-1 text-right tabular-nums">{Object.keys(plan.days).length}</td>
                  </tr>
                </tbody>
              </table>
            </div>
            <Button size="sm" className="h-8 text-xs" disabled={busy} onClick={() => setConfirmOpen(true)} data-testid="vk-commit-button">
              {busy ? <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" /> : <CheckCircle2 className="h-3.5 w-3.5 mr-1" />}
              Import ausführen
            </Button>
          </div>
        )}
      </div>

      <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <AlertDialogContent data-testid="vk-confirm-dialog">
          <AlertDialogHeader>
            <AlertDialogTitle>Verkaufsdaten {year} importieren?</AlertDialogTitle>
            <AlertDialogDescription>
              Mandant <strong>{tenant?.name ?? tenantId ?? 'Oliv'}</strong>, Jahr <strong>{year}</strong>:{' '}
              {plan ? <>{plan.neu} neue, {plan.aktualisiert} aktualisierte, {plan.unveraendert} unveränderte Tage.</> : null}{' '}
              Geschrieben werden nur das Verkaufszahlen-Archiv und — falls die Anzahl-Dateien
              Take-Away-Artikel enthalten — die Cockpit-Zeile «Gäste Take Away».
              Cockpit-Food/Beverage (Quelle: Umsatz-Excel) und übrige Tagesdaten bleiben
              unberührt — deshalb gilt die Jahres-Sperre für diesen Import nicht (auch
              festgeschriebene Jahre sind importierbar). Der Lauf ist über «Rückgängig»
              rückgängig machbar.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel data-testid="vk-confirm-cancel">Abbrechen</AlertDialogCancel>
            <AlertDialogAction onClick={() => void handleCommit()} data-testid="vk-confirm-ok">Importieren</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
