/**
 * Rezensionen — einfache Google-Back-Office-Erfassung (ohne API-Anbindung)
 * ========================================================================
 * - Simples Formular: Datum, Sterne 1–5 (anklickbar), optional Screenshot +
 *   Bemerkung. «Speichern» legt die Rezension sofort an.
 * - Plattform ist fix Google (kein Plattform-Feld).
 * - Liste der Einträge (Datum, Sterne, Bemerkung, Screenshot-Vorschau),
 *   einzeln editier-/löschbar. Vergangene Einträge nachtragbar.
 * - Wochentracking nach Sternen (gleiche Ansicht wie im Cockpit).
 * - Mandantengetrennt (reviews_data:<tenant> + Storage tenant/…); Erfassen nur
 *   berechtigte Rollen, Gäste rein lesend.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { format } from 'date-fns';
import { Star, Loader2, Image as ImageIcon, Pencil, Trash2, Upload } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { ReviewsWeeklyTracker } from '@/components/reviews/ReviewsWeeklyTracker';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { useToast } from '@/hooks/use-toast';
import { usePermissions } from '@/hooks/usePermissions';
import { useTenant } from '@/contexts/TenantContext';
import {
  fetchReviewsData, upsertSingleReview, deleteSingleReview,
  uploadReviewScreenshot, getReviewScreenshotUrl, deleteReviewScreenshot,
  newReviewId, upsertSingleReviews, fetchReviewsRawValue,
  type ReviewsData, type SingleReview,
} from '@/lib/reviews-store';
import {
  parseFeedbackCsv, buildFeedbackPreview, FEEDBACK_PLATFORM,
  type FeedbackPreview, type FeedbackParseResult,
} from '@/lib/feedback-import';
import { recordImportRun } from '@/lib/import-undo-store';
import { LastImportPanel } from '@/components/import-center/LastImportPanel';
import { CsvPasteBox } from '@/components/import/CsvPasteBox';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from '@/components/ui/dialog';
import { cn } from '@/lib/utils';

const PLATFORM = 'Google';
/** Wählbare Plattformen der manuellen Erfassung (Import setzt Lunchgate fix). */
const PLATFORMS = [PLATFORM, FEEDBACK_PLATFORM] as const;

/** Anklickbare Sterne-Auswahl (1–5). */
function StarPicker({ value, onChange, disabled }: {
  value: number; onChange: (v: number) => void; disabled?: boolean;
}) {
  return (
    <div className="flex items-center gap-1" data-testid="star-picker">
      {[1, 2, 3, 4, 5].map(s => (
        <button
          key={s} type="button" disabled={disabled}
          onClick={() => onChange(s)}
          data-testid={`star-${s}`}
          className={cn('p-0.5 transition-transform hover:scale-110 disabled:opacity-50')}
          aria-label={`${s} Sterne`}
        >
          <Star className={cn('h-7 w-7',
            s <= value ? 'fill-amber-400 text-amber-400' : 'text-muted-foreground/40')} />
        </button>
      ))}
      <span className="ml-2 text-sm text-muted-foreground tabular-nums">{value > 0 ? `${value}/5` : '—'}</span>
    </div>
  );
}

/** Screenshot-Vorschau mit signierter URL (lädt lazily, tenant-geprüft). */
function ScreenshotThumb({ tenantId, path }: { tenantId: string; path: string }) {
  const [url, setUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let alive = true;
    setUrl(null); setFailed(false);
    getReviewScreenshotUrl(tenantId, path)
      .then(u => { if (alive) setUrl(u); })
      .catch(() => { if (alive) setFailed(true); });
    return () => { alive = false; };
  }, [tenantId, path]);
  if (failed) return <span className="text-xs text-muted-foreground">Screenshot nicht verfügbar</span>;
  if (!url) return <span className="inline-flex items-center gap-1 text-xs text-muted-foreground"><Loader2 className="h-3 w-3 animate-spin" /> Screenshot …</span>;
  return (
    <a href={url} target="_blank" rel="noreferrer" data-testid="screenshot-link">
      <img src={url} alt="Screenshot der Rezension" className="max-h-24 rounded-md border border-border object-contain" />
    </a>
  );
}

interface FormState {
  id: string | null;          // null = neu
  date: string;               // yyyy-MM-dd
  platform: string;           // Google | Lunchgate
  stars: number;              // 0 = noch nicht gewählt
  text: string;               // Bemerkung
  screenshotPath?: string;    // bestehender Screenshot (beim Editieren)
  file: File | null;          // neu gewählter Screenshot
}

const emptyForm = (): FormState => ({
  id: null, date: format(new Date(), 'yyyy-MM-dd'), platform: PLATFORM, stars: 0, text: '', file: null,
});

export default function Rezensionen() {
  const { tenantId, tenant } = useTenant();
  const { isAdmin, isGuest, isBeaulieuManager } = usePermissions();
  const { toast } = useToast();
  const canEdit = (isAdmin && !isGuest) || isBeaulieuManager;

  const [data, setData] = useState<ReviewsData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState<FormState>(emptyForm());

  useEffect(() => {
    let alive = true;
    // State-Reset bei Tenant-Wechsel — nie Daten des anderen Mandanten zeigen
    setData(null); setError(null); setForm(emptyForm());
    fetchReviewsData(tenantId)
      .then(d => { if (alive) setData(d); })
      .catch(e => { if (alive) setError(e instanceof Error ? e.message : String(e)); });
    return () => { alive = false; };
  }, [tenantId]);

  const sorted = useMemo(
    () => [...(data?.singleReviews ?? [])].sort((a, b) => b.date.localeCompare(a.date)),
    [data],
  );

  async function handleSave() {
    if (!canEdit || saving) return;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(form.date)) {
      toast({ variant: 'destructive', title: 'Bitte gültiges Datum wählen.' }); return;
    }
    if (!Number.isInteger(form.stars) || form.stars < 1 || form.stars > 5) {
      toast({ variant: 'destructive', title: 'Bitte Sterne (1–5) anklicken.' }); return;
    }
    setSaving(true);
    try {
      const id = form.id ?? newReviewId('rz');
      let screenshotPath = form.screenshotPath;
      if (form.file) {
        screenshotPath = await uploadReviewScreenshot(tenantId, id, form.file);
      }
      const existing = form.id ? data?.singleReviews.find(r => r.id === form.id) : undefined;
      const review: SingleReview = {
        // Import-Felder (visitDate/pax/avgExact/importKey/…) beim Editieren erhalten.
        ...(existing ?? {}),
        id,
        date: form.date,
        platform: form.platform,
        stars: form.stars,
        text: form.text.trim(),
        answered: existing?.answered ?? false,
        ...(screenshotPath ? { screenshotPath } : {}),
        updatedAt: new Date().toISOString(),
      };
      const next = await upsertSingleReview(tenantId, review);
      setData(next);
      setForm(emptyForm());
      toast({ title: form.id ? 'Rezension aktualisiert.' : 'Rezension gespeichert.' });
    } catch (e) {
      toast({ variant: 'destructive', title: 'Speichern fehlgeschlagen', description: e instanceof Error ? e.message : String(e) });
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete(r: SingleReview) {
    if (!canEdit || saving) return;
    setSaving(true);
    try {
      const next = await deleteSingleReview(tenantId, r);
      if (r.screenshotPath) await deleteReviewScreenshot(tenantId, r.screenshotPath); // best effort
      setData(next);
      if (form.id === r.id) setForm(emptyForm());
      toast({ title: 'Rezension gelöscht.' });
    } catch (e) {
      toast({ variant: 'destructive', title: 'Löschen fehlgeschlagen', description: e instanceof Error ? e.message : String(e) });
    } finally {
      setSaving(false);
    }
  }

  function startEdit(r: SingleReview) {
    setForm({ id: r.id, date: r.date, platform: r.platform, stars: r.stars, text: r.text, screenshotPath: r.screenshotPath, file: null });
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  // ── Feedback-CSV-Import (Lunchgate): Datei → Vorschau → Bestätigen ─────────
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [importState, setImportState] = useState<{
    fileName: string; parse: FeedbackParseResult; preview: FeedbackPreview;
  } | null>(null);
  const [importing, setImporting] = useState(false);
  const [importDragging, setImportDragging] = useState(false);

  /** Gemeinsamer Kern für Datei-Dialog, Drag & Drop und «CSV einfügen». */
  function handleImportText(text: string, sourceLabel: string) {
    // NIE still abbrechen — jeder Abbruchgrund wird dem Nutzer gemeldet.
    if (!canEdit) {
      toast({ variant: 'destructive', title: 'Keine Berechtigung', description: 'Der Feedback-Import ist Administratoren/Geschäftsführung vorbehalten.' });
      return;
    }
    if (!data) {
      toast({ variant: 'destructive', title: 'Rezensionen noch nicht geladen', description: error ? `Laden fehlgeschlagen: ${error}` : 'Bitte warten, bis die Seite fertig geladen ist, und erneut versuchen.' });
      return;
    }
    console.info('[Feedback-Import] Quelle:', sourceLabel, `${text.length} Zeichen`);
    const parse = parseFeedbackCsv(text);
    if (parse.failureReason) {
      console.error('[Feedback-Import] Parser-Fehler:', parse.failureReason, parse.debug);
      toast({ variant: 'destructive', title: 'CSV konnte nicht gelesen werden', description: parse.failureReason });
      return;
    }
    // Vorschau (Upsert): Match über importKey — Ersetzen statt Duplikat.
    const preview = buildFeedbackPreview(parse.rows, data.singleReviews, () => newReviewId('fb'));
    console.info('[Feedback-Import] Vorschau:', preview.neu, 'neu ·', preview.aktualisiert, 'aktualisiert ·', preview.unveraendert, 'unverändert');
    setImportState({ fileName: sourceLabel, parse, preview });
  }

  async function handleImportFile(file: File) {
    console.info('[Feedback-Import] Datei gewählt:', file.name, file.type || '(kein MIME)', `${file.size} Bytes`);
    try {
      const text = await file.text();
      handleImportText(text, file.name);
    } catch (e) {
      console.error('[Feedback-Import] Datei-Lesefehler:', e);
      toast({ variant: 'destructive', title: 'Datei konnte nicht gelesen werden', description: e instanceof Error ? e.message : String(e) });
    } finally {
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  }

  async function handleConfirmImport() {
    if (!importState || importing || !canEdit) return;
    const { preview, parse, fileName } = importState;
    setImporting(true);
    try {
      // 1) Backup: kompletter reviews_data-Blob VOR dem Schreiben (inkl. Tombstones).
      const prior = await fetchReviewsRawValue(tenantId);
      // 2) Schreiben: EIN Batch-Upsert (neu + aktualisiert); unverändert bleibt unangetastet.
      let next = data;
      if (preview.toWrite.length > 0) {
        next = await upsertSingleReviews(tenantId, preview.toWrite);
        setData(next);
      }
      // 3) Protokoll + Undo-Snapshot — best effort, bricht den Import nie ab.
      const dates = parse.rows.map(r => r.publishDate).sort();
      try {
        await recordImportRun(tenantId, {
          source: 'feedback-rezensionen',
          periodLabel: dates.length > 0 ? `${dates[0]} – ${dates[dates.length - 1]}` : '—',
          itemCount: preview.toWrite.length,
          itemLabel: 'Bewertungen',
          fileName,
          details: `${preview.neu} neu · ${preview.aktualisiert} aktualisiert · ${preview.unveraendert} unverändert`
            + (parse.skipped.length > 0 ? ` · ${parse.skipped.length} übersprungen` : ''),
          snapshot: { kind: 'kv-keys', items: [{ key: `reviews_data:${tenantId}`, value: prior }] },
        });
      } catch {
        toast({ title: 'Hinweis', description: 'Import erfolgreich, aber das Protokoll konnte nicht gesichert werden — «Rückgängig» ist für diesen Lauf nicht verfügbar.' });
      }
      toast({
        title: 'Import abgeschlossen',
        description: `${preview.neu} neu · ${preview.aktualisiert} aktualisiert · ${preview.unveraendert} unverändert`,
      });
      setImportState(null);
    } catch (e) {
      toast({ variant: 'destructive', title: 'Import fehlgeschlagen', description: e instanceof Error ? e.message : String(e) });
    } finally {
      setImporting(false);
    }
  }

  return (
    <div className="bg-background">
      <main className="px-4 py-6 lg:px-8 space-y-6 max-w-4xl mx-auto">
        <div className="flex items-center gap-3">
          <Star className="h-6 w-6 text-amber-500" />
          <div>
            <h1 className="text-xl font-bold tracking-tight" data-testid="rezensionen-title">
              Rezensionen — {tenant.shortName}
            </h1>
            <p className="text-xs text-muted-foreground">
              Google-Rezensionen manuell erfassen · Wochentracking nach Sternen · keine API-Anbindung
            </p>
          </div>
        </div>

        {error && (
          <div className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700" data-testid="rezensionen-error">
            Fehler beim Laden: {error}
          </div>
        )}
        {!data && !error && <p className="text-sm text-muted-foreground py-8">Lade Rezensionen …</p>}

        {data && (
          <>
            {/* ── Erfassung (nur berechtigte Rollen) ─────────────────────── */}
            {canEdit && (
              <Card data-testid="review-form">
                <CardHeader className="pb-2">
                  <CardTitle className="text-base">
                    {form.id ? 'Rezension bearbeiten' : 'Neue Rezension erfassen'}
                  </CardTitle>
                </CardHeader>
                <CardContent className="space-y-3">
                  <div className="flex flex-wrap items-end gap-4">
                    <div className="space-y-1">
                      <span className="text-xs font-medium text-muted-foreground block">Plattform</span>
                      <div className="flex rounded-md border border-border overflow-hidden">
                        {PLATFORMS.map(p => (
                          <button key={p} type="button" disabled={saving}
                            onClick={() => setForm(f => ({ ...f, platform: p }))}
                            data-testid={`platform-${p.toLowerCase()}`}
                            className={cn('px-3 h-9 text-xs font-medium transition-colors',
                              form.platform === p ? 'bg-foreground text-background' : 'bg-card hover:bg-muted')}>
                            {p}
                          </button>
                        ))}
                      </div>
                    </div>
                    <label className="space-y-1">
                      <span className="text-xs font-medium text-muted-foreground">Datum</span>
                      <Input
                        type="date" value={form.date} max={format(new Date(), 'yyyy-MM-dd')}
                        onChange={e => setForm(f => ({ ...f, date: e.target.value }))}
                        className="h-9 w-[160px]" data-testid="input-review-date"
                      />
                    </label>
                    <div className="space-y-1">
                      <span className="text-xs font-medium text-muted-foreground block">Sterne</span>
                      <StarPicker value={form.stars} onChange={v => setForm(f => ({ ...f, stars: v }))} disabled={saving} />
                    </div>
                  </div>
                  <label className="block space-y-1">
                    <span className="text-xs font-medium text-muted-foreground">Bemerkung (optional)</span>
                    <Textarea
                      value={form.text} rows={2} placeholder="z. B. Stichworte zur Rezension"
                      onChange={e => setForm(f => ({ ...f, text: e.target.value }))}
                      data-testid="input-review-text"
                    />
                  </label>
                  <div className="flex flex-wrap items-center gap-3">
                    <label className="inline-flex items-center gap-2 text-xs text-muted-foreground cursor-pointer">
                      <ImageIcon className="h-4 w-4" />
                      <span>{form.file ? form.file.name : form.screenshotPath ? 'Screenshot ersetzen (optional)' : 'Screenshot (optional)'}</span>
                      <input
                        type="file" accept="image/png,image/jpeg,image/webp" className="hidden"
                        data-testid="input-review-screenshot"
                        onChange={e => setForm(f => ({ ...f, file: e.target.files?.[0] ?? null }))}
                      />
                    </label>
                    {form.screenshotPath && !form.file && <ScreenshotThumb tenantId={tenantId} path={form.screenshotPath} />}
                  </div>
                  <div className="flex gap-2">
                    <Button size="sm" onClick={handleSave} disabled={saving} data-testid="button-save-review">
                      {saving && <Loader2 className="h-3.5 w-3.5 animate-spin mr-1.5" />}
                      Speichern
                    </Button>
                    {form.id && (
                      <Button size="sm" variant="outline" onClick={() => setForm(emptyForm())} disabled={saving}>
                        Abbrechen
                      </Button>
                    )}
                  </div>
                </CardContent>
              </Card>
            )}

            {/* ── Feedback-CSV-Import (Lunchgate) ─────────────────────────── */}
            {canEdit && (
              <Card data-testid="feedback-import-card">
                <CardHeader className="pb-2">
                  <CardTitle className="text-base flex items-center gap-2">
                    <Upload className="h-4 w-4" /> Feedback-CSV importieren (Lunchgate)
                  </CardTitle>
                </CardHeader>
                <CardContent className="space-y-3">
                  <p className="text-xs text-muted-foreground">
                    Format: «;»-getrennt, UTF-8 — Spalten «Publish Date», «Pax», «Guest», «Reservation Date»,
                    «Average», «Service», «Kitchen», «Atmosphere», «Performance», «Comment».
                    Erneuter Import derselben Datei legt nichts doppelt an: bestehende Bewertungen
                    (gleicher Schlüssel Publish Date + Gast + Reservationsdatum) werden ERSETZT.
                    Import in den aktiven Mandanten ({tenant.shortName}).
                  </p>
                  {/* Nativer <label htmlFor>-Pfad: der Klick öffnet den Datei-Dialog
                      GARANTIERT über den Browser selbst (kein programmatisches
                      ref.click(), das je nach Browser/Iframe geblockt werden kann).
                      accept enthält auch application/vnd.ms-excel — Windows
                      registriert .csv oft mit diesem MIME-Typ, sonst wären die
                      Dateien im Dialog ausgegraut. */}
                  <input
                    ref={fileInputRef} id="feedback-csv-input" type="file"
                    accept=".csv,text/csv,application/vnd.ms-excel" className="sr-only"
                    disabled={importing}
                    data-testid="input-feedback-csv"
                    onChange={e => {
                      const f = e.target.files?.[0];
                      console.info('[Feedback-Import] onChange, Datei:', f ? f.name : '(keine)');
                      if (f) void handleImportFile(f);
                    }}
                  />
                  <Button size="sm" variant="outline" asChild disabled={importing}
                    data-testid="button-feedback-import">
                    <label htmlFor="feedback-csv-input" className="cursor-pointer">
                      <Upload className="h-3.5 w-3.5 mr-1.5" /> CSV-Datei wählen …
                    </label>
                  </Button>
                  {/* Alternative 1: Drag & Drop — funktioniert auch, wenn der
                      Datei-Dialog in der eingebetteten Vorschau blockiert ist. */}
                  <div
                    onDragOver={e => { e.preventDefault(); setImportDragging(true); }}
                    onDragLeave={() => setImportDragging(false)}
                    onDrop={e => {
                      e.preventDefault();
                      setImportDragging(false);
                      const f = e.dataTransfer.files?.[0];
                      if (!f) {
                        toast({ variant: 'destructive', title: 'Keine Datei erkannt', description: 'Bitte eine .csv-Datei auf das Feld ziehen.' });
                        return;
                      }
                      void handleImportFile(f);
                    }}
                    className={cn(
                      'rounded-lg border-2 border-dashed p-4 text-center text-xs text-muted-foreground transition-colors',
                      importDragging ? 'border-primary bg-primary/5' : 'border-border',
                    )}
                    data-testid="feedback-csv-dropzone"
                  >
                    … oder CSV-Datei hierher ziehen
                  </div>
                  {/* Alternative 2: kopierten CSV-Inhalt einfügen. */}
                  <CsvPasteBox
                    disabled={importing}
                    testIdPrefix="feedback-csv-paste"
                    onText={(text, label) => handleImportText(text, label)}
                  />
                  <LastImportPanel
                    source="feedback-rezensionen"
                    undoHint="Setzt die Rezensionen auf den Stand unmittelbar VOR dem letzten Feedback-Import zurück (inkl. allfälliger manueller Änderungen seither)."
                  />
                </CardContent>
              </Card>
            )}

            {/* ── Import-Vorschau (Bestätigen vor dem Schreiben) ──────────── */}
            <Dialog open={importState !== null} onOpenChange={o => { if (!o && !importing) setImportState(null); }}>
              <DialogContent className="max-w-md" data-testid="feedback-import-preview">
                <DialogHeader>
                  <DialogTitle>Import-Vorschau — {importState?.fileName}</DialogTitle>
                </DialogHeader>
                {importState && (
                  <div className="space-y-3 text-sm">
                    <p className="font-semibold" data-testid="preview-counts">
                      {importState.preview.neu} neu · {importState.preview.aktualisiert} aktualisiert · {importState.preview.unveraendert} unverändert
                    </p>
                    <div className="space-y-1">
                      <p className="text-xs font-medium text-muted-foreground">Sterne-Verteilung (alle Zeilen der Datei)</p>
                      {[5, 4, 3, 2, 1].map(s => (
                        <div key={s} className="flex items-center gap-2 text-xs tabular-nums" data-testid={`preview-stars-${s}`}>
                          <span className="w-14 text-amber-500">{'★'.repeat(s)}</span>
                          <span>{importState.preview.starDist[s as 1 | 2 | 3 | 4 | 5]}</span>
                        </div>
                      ))}
                    </div>
                    {importState.parse.skipped.length > 0 && (
                      <p className="text-xs text-amber-700 dark:text-amber-400">
                        {importState.parse.skipped.length} Zeile(n) übersprungen (z. B. ungültiges Datum/Average) —
                        erste: Zeile {importState.parse.skipped[0].line}: {importState.parse.skipped[0].reason}
                      </p>
                    )}
                    <p className="text-xs text-muted-foreground">
                      Vor dem Schreiben wird ein Backup erstellt («Letzter Import rückgängig machen»).
                      Plattform: {FEEDBACK_PLATFORM} · Mandant: {tenant.shortName}.
                    </p>
                  </div>
                )}
                <DialogFooter>
                  <Button variant="outline" size="sm" onClick={() => setImportState(null)} disabled={importing}>Abbrechen</Button>
                  <Button size="sm" onClick={handleConfirmImport}
                    disabled={importing || !importState || importState.preview.toWrite.length === 0}
                    data-testid="button-confirm-import">
                    {importing && <Loader2 className="h-3.5 w-3.5 animate-spin mr-1.5" />}
                    {importState && importState.preview.toWrite.length === 0 ? 'Nichts zu schreiben' : 'Importieren'}
                  </Button>
                </DialogFooter>
              </DialogContent>
            </Dialog>

            {/* ── Wochentracking (gleiche Ansicht wie im Cockpit) ─────────── */}
            <Card>
              <CardContent className="pt-4">
                <ReviewsWeeklyTracker reviews={data.singleReviews} />
              </CardContent>
            </Card>

            {/* ── Liste ───────────────────────────────────────────────────── */}
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-base">
                  Erfasste Rezensionen
                  <span className="ml-2 text-xs font-normal text-muted-foreground">{sorted.length} Einträge · Google + {FEEDBACK_PLATFORM}</span>
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-2">
                {sorted.length === 0 ? (
                  <div className="space-y-2">
                    {/* Beispielzeile — wird NICHT gespeichert */}
                    <div className="rounded-lg border border-dashed border-border/70 p-3 flex flex-wrap items-start gap-x-4 gap-y-1 text-sm italic text-muted-foreground"
                      data-testid="single-review-example">
                      <span className="font-mono text-xs">2026-07-28</span>
                      <span className="text-amber-600/70 font-semibold whitespace-nowrap not-italic">★★★★★</span>
                      <p className="w-full">Beispielzeile — «Super Service, gerne wieder!» (so sieht ein Eintrag aus)</p>
                    </div>
                    <p className="text-sm text-muted-foreground">Noch keine Rezensionen erfasst.</p>
                  </div>
                ) : (
                  sorted.map(r => (
                    <div key={r.id}
                      className="rounded-lg border border-border/70 p-3 flex flex-wrap items-start gap-x-4 gap-y-1.5 text-sm"
                      data-testid={`review-row-${r.id}`}>
                      <span className="font-mono text-xs text-muted-foreground pt-0.5">{r.date}</span>
                      {/* Plattform immer kennzeichnen — Google und Lunchgate nie vermischen */}
                      <span className={cn('text-[10px] px-1.5 py-0.5 rounded whitespace-nowrap',
                        r.platform === FEEDBACK_PLATFORM
                          ? 'bg-sky-100 text-sky-800 dark:bg-sky-900/40 dark:text-sky-300'
                          : 'bg-muted text-muted-foreground')}
                        data-testid={`review-platform-badge-${r.id}`}>
                        {r.platform}
                      </span>
                      <span className="text-amber-500 font-semibold whitespace-nowrap" title={`${r.stars} von 5 Sternen`}>
                        {'★'.repeat(r.stars)}<span className="text-muted-foreground/40">{'★'.repeat(5 - r.stars)}</span>
                      </span>
                      {r.author && <span className="text-xs text-muted-foreground pt-0.5" data-testid={`review-guest-${r.id}`}>{r.author}</span>}
                      {r.avgExact != null && (
                        <span className="text-xs text-muted-foreground pt-0.5 tabular-nums" title="Exakter Average aus dem Feedback-CSV">
                          Ø {r.avgExact.toFixed(1)}
                        </span>
                      )}
                      {r.visitDate && (
                        <span className="text-xs text-muted-foreground pt-0.5" title="Besuchsdatum (Reservation Date)">
                          Besuch {r.visitDate}{r.pax != null ? ` · ${r.pax} Pers.` : ''}
                        </span>
                      )}
                      {r.text && <p className="w-full text-muted-foreground">{r.text}</p>}
                      {/* Screenshots können PII enthalten (Namen/Avatare) → für Gast-Sessions ausgeblendet */}
                      {r.screenshotPath && !isGuest && <div className="w-full"><ScreenshotThumb tenantId={tenantId} path={r.screenshotPath} /></div>}
                      {canEdit && (
                        <span className="ml-auto whitespace-nowrap -mt-1">
                          <Button size="icon" variant="ghost" className="h-6 w-6"
                            onClick={() => startEdit(r)} title="Bearbeiten" data-testid={`button-edit-${r.id}`}>
                            <Pencil className="h-3.5 w-3.5" />
                          </Button>
                          <Button size="icon" variant="ghost" className="h-6 w-6 text-destructive"
                            disabled={saving} onClick={() => handleDelete(r)} title="Löschen" data-testid={`button-delete-${r.id}`}>
                            <Trash2 className="h-3.5 w-3.5" />
                          </Button>
                        </span>
                      )}
                    </div>
                  ))
                )}
              </CardContent>
            </Card>
          </>
        )}
      </main>
    </div>
  );
}
