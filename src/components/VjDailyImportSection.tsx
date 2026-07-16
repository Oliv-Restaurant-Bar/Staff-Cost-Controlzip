/**
 * VjDailyImportSection
 * ====================
 * Importiert Vorjahres-Tagesumsätze aus einer Gastronovi-Excel-Datei
 * und speichert sie per Batch-Upsert in Supabase (app_settings).
 *
 * Supabase-Struktur:
 *   Oliv:     key = "vj_daily:2025-04-03"          (rückwärtskompatibel)
 *   Beaulieu: key = "vj_daily:beaulieu:2025-04-03"  (tenant-isoliert)
 *   value = { date, year, actualRevenue, foodRevenue, beverageRevenue, source }
 *
 * Excel-Format (Gastronovi Tagesbericht):
 *   Zeile 1  = Datum-Header: "Bezeichnung", "Zeitraum", "01.01.", "02.01." …
 *   Zeile n  = Kategorie-Zeilen: "Gesamt", "Food (Speisen)", "Beverage (Getränke)"
 *   Werte    = "CHF 7'118.00" | "CHF 7118,75" | leer → 0
 *
 * Debug-Logs:
 *   [VJ-IMPORT] detected year: 2025
 *   [VJ-IMPORT] row found: Gesamt
 *   [VJ-IMPORT] rows parsed: 365
 *   [VJ-SUPABASE] rows upserted to supabase: 365
 *   [VJ-SUPABASE] source of truth: supabase
 */

import { useState, useRef, useEffect } from 'react';
import * as XLSX from 'xlsx';
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const XLSXany = XLSX as any;
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { toast } from 'sonner';
import { Upload, CheckCircle2, Loader2, AlertCircle, Database, Lock, LockOpen, ShieldCheck } from 'lucide-react';
import {
  upsertVjDailyBatch,
  countVjDailyYear,
  loadVjDailyYear,
  type VjDayRecord,
} from '@/lib/vj-daily-supabase';
import { useTenant } from '@/contexts/TenantContext';
import { usePermissions } from '@/hooks/usePermissions';
import {
  getLockState,
  lockYear,
  unlockYear,
  formatLockedAt,
  type PriorYearLockState,
} from '@/lib/prior-year-lock';
import { Checkbox } from '@/components/ui/checkbox';
import {
  saveMonth,
  loadYear,
  retryReportingMonthsBackup,
  STORAGE_KEY as REPORTING_STORAGE_KEY,
} from '@/lib/reporting-store';
import { notifyKVBackupProblem } from '@/lib/supabase-kv';
import { notifyReportingDataChanged } from '@/lib/import-events';
import {
  buildVjTransferPlan,
  buildVjTransferPayload,
  selectTransferMonths,
  type VjTransferMonthPlan,
} from '@/lib/vj-daily-transfer';

// ── Typen ─────────────────────────────────────────────────────────────────────

interface DayEntry {
  gesamt:   number;
  food:     number | null;
  beverage: number | null;
}

interface VjPreview {
  year:      number;
  dayCount:  number;
  rowsFound: string[];
  samples:   Array<{ date: string; gesamt: number; food: number | null; beverage: number | null }>;
  days:      Record<string, DayEntry>;
}

// ── Parser ────────────────────────────────────────────────────────────────────

function parseCHF(raw: unknown): number {
  if (raw === null || raw === undefined || raw === '') return 0;
  const s = String(raw);
  const cleaned = s
    .replace(/CHF\s*/i, '')
    .replace(/['\u2019\u2018\s]/g, '')
    .replace(',', '.');
  const n = parseFloat(cleaned);
  return isNaN(n) ? 0 : Math.round(n * 100) / 100;
}

const ROW_GESAMT   = ['gesamt', 'total', 'gesamtumsatz'];
const ROW_FOOD     = ['food', 'speisen', 'food (speisen)', 'food(speisen)'];
const ROW_BEVERAGE = ['beverage', 'getränke', 'beverage (getränke)', 'beverage(getränke)'];

function matchRow(label: string, patterns: string[]): boolean {
  const l = label.toLowerCase().trim();
  return patterns.some(p => l.includes(p));
}

/**
 * Extrahiert Tag (1–31) und Monat (1–12) aus einer Zelle im Tabellenkopf.
 * Unterstützt:
 *   - String  "01.04."  / "01.04"  / "01.04.2025"
 *   - Excel-Date-Serial  (Zahl > 1)
 *   - JavaScript Date-Objekt
 * Gibt null zurück wenn kein Datum erkannt.
 */
function extractDayMonth(cell: unknown): { dd: string; mm: string } | null {
  if (cell === null || cell === undefined || cell === '') return null;

  // String-basiert
  if (typeof cell === 'string') {
    const s = cell.trim();
    // "01.04." / "01.04" / "01.04.2025" / "01.04.25"
    const m = s.match(/^(\d{1,2})\.(\d{1,2})\.?(?:\d{2,4})?$/);
    if (m) {
      const dd = m[1].padStart(2, '0');
      const mm = m[2].padStart(2, '0');
      const day = parseInt(dd); const month = parseInt(mm);
      if (day >= 1 && day <= 31 && month >= 1 && month <= 12) return { dd, mm };
    }
    // ISO: "2025-04-01"
    const iso = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (iso) {
      const mm = iso[2]; const dd = iso[3];
      if (parseInt(mm) >= 1 && parseInt(mm) <= 12) return { dd, mm };
    }
    return null;
  }

  // JavaScript Date-Objekt (aus XLSX mit cellDates: true)
  if (cell instanceof Date && !isNaN(cell.getTime())) {
    const dd = String(cell.getDate()).padStart(2, '0');
    const mm = String(cell.getMonth() + 1).padStart(2, '0');
    return { dd, mm };
  }

  // Excel-Date-Serial (Zahl > 1)
  if (typeof cell === 'number' && cell > 1) {
    try {
      const parsed = XLSXany.SSF.parse_date_code(cell);
      if (parsed && parsed.d >= 1 && parsed.m >= 1 && parsed.m <= 12) {
        return {
          dd: String(parsed.d).padStart(2, '0'),
          mm: String(parsed.m).padStart(2, '0'),
        };
      }
    } catch { /* ignore */ }
  }

  return null;
}

async function parseVjDaily(file: File, year: number): Promise<VjPreview> {
  const buf = await file.arrayBuffer();

  // Erst mit cellDates: true → Datumszellen kommen als JS Date
  const wb  = XLSX.read(buf, { type: 'array', cellDates: true });
  const ws  = wb.Sheets[wb.SheetNames[0]];
  const raw = XLSX.utils.sheet_to_json<unknown[]>(ws, { header: 1, defval: '', raw: false });

  if (raw.length < 2) throw new Error('Datei enthält zu wenig Zeilen');

  const headerRow = raw[0] as unknown[];
  let colToDate: Record<number, string> = {};

  for (let c = 0; c < headerRow.length; c++) {
    const dm = extractDayMonth(headerRow[c]);
    if (!dm) continue;
    colToDate[c] = `${year}-${dm.mm}-${dm.dd}`;
  }

  // Fallback: rohe Zahlen (Excel-Serial) wenn cellDates nicht ausreicht
  if (Object.keys(colToDate).length < 7) {
    const wb2  = XLSX.read(buf, { type: 'array', cellDates: false });
    const ws2  = wb2.Sheets[wb2.SheetNames[0]];
    const raw2 = XLSX.utils.sheet_to_json<unknown[]>(ws2, { header: 1, defval: '', raw: true });
    const hr2  = (raw2[0] ?? []) as unknown[];
    const colToDate2: Record<number, string> = {};
    for (let c = 0; c < hr2.length; c++) {
      const dm = extractDayMonth(hr2[c]);
      if (!dm) continue;
      colToDate2[c] = `${year}-${dm.mm}-${dm.dd}`;
    }
    if (Object.keys(colToDate2).length > Object.keys(colToDate).length) {
      colToDate = colToDate2;
      // Re-read data rows too
      const dataRows2 = raw2 as unknown[][];
      // Replace raw with raw2 for row matching below
      (raw as unknown[]).length = 0;
      for (const r of dataRows2) (raw as unknown[]).push(r);
    }
  }

  const detectedDays = Object.keys(colToDate).length;
  console.log(`[VJ-IMPORT] header samples: ${headerRow.slice(0, 5).map(x => typeof x === 'object' ? JSON.stringify(x) : String(x)).join(' | ')}`);
  console.log(`[VJ-IMPORT] date columns detected: ${detectedDays}`);

  if (detectedDays < 1) {
    const sample = headerRow.slice(0, 6).map(x => typeof x === 'object' && x instanceof Date ? x.toISOString() : String(x ?? '')).join(' | ');
    throw new Error(
      `Keine Datum-Spalten erkannt (0 Tage). Stichprobe der Spaltenköpfe: "${sample}". ` +
      `Erwartet: "01.04.", "01.04.2025" oder Excel-Datumszellen.`
    );
  }

  let gesamtRow: unknown[] | null = null;
  let foodRow:   unknown[] | null = null;
  let bevRow:    unknown[] | null = null;
  const rowsFound: string[] = [];

  for (let r = 1; r < raw.length; r++) {
    const row   = raw[r] as unknown[];
    const label = String(row[0] ?? '').trim();
    if (!label) continue;
    if (!gesamtRow && matchRow(label, ROW_GESAMT)) {
      gesamtRow = row; rowsFound.push('Gesamt');
      console.log('[VJ-IMPORT] row found: Gesamt');
    } else if (!foodRow && matchRow(label, ROW_FOOD)) {
      foodRow = row; rowsFound.push('Food (Speisen)');
      console.log('[VJ-IMPORT] row found: Food (Speisen)');
    } else if (!bevRow && matchRow(label, ROW_BEVERAGE)) {
      bevRow = row; rowsFound.push('Beverage (Getränke)');
      console.log('[VJ-IMPORT] row found: Beverage (Getränke)');
    }
  }

  if (!gesamtRow) throw new Error('Zeile "Gesamt" nicht gefunden. Bitte Spaltenbeschriftung prüfen.');

  const days: Record<string, DayEntry> = {};
  for (const [cStr, iso] of Object.entries(colToDate)) {
    const c        = parseInt(cStr);
    const gesamt   = parseCHF(gesamtRow[c]);
    const food     = foodRow ? parseCHF(foodRow[c]) : null;
    const beverage = bevRow  ? parseCHF(bevRow[c])  : null;
    days[iso] = { gesamt, food, beverage };
  }

  const dayCount = Object.keys(days).length;
  console.log(`[VJ-IMPORT] detected year: ${year}`);
  console.log(`[VJ-IMPORT] rows parsed: ${dayCount}`);

  const samples = Object.entries(days)
    .filter(([, v]) => v.gesamt > 0)
    .slice(0, 3)
    .map(([date, v]) => ({ date, ...v }));

  return { year, dayCount, rowsFound, samples, days };
}

// ── Format-Hilfsfunktionen ────────────────────────────────────────────────────

const NUM  = new Intl.NumberFormat('de-CH', { maximumFractionDigits: 0 });
const fmtN = (v: number | null | undefined) => v != null ? NUM.format(Math.round(v)) : '–';

function fmtDate(iso: string): string {
  return `${iso.slice(8)}.${iso.slice(5, 7)}.${iso.slice(0, 4)}`;
}

// ── Hauptkomponente ───────────────────────────────────────────────────────────

const currentYear = new Date().getFullYear();

export function VjDailyImportSection() {
  const { tenantId, tenantKey } = useTenant();
  const { isAdmin, isGuest } = usePermissions();
  const fileRef   = useRef<HTMLInputElement>(null);
  const [year,    setYear]    = useState(currentYear - 1);
  const [parsing, setParsing] = useState(false);
  const [saving,  setSaving]  = useState(false);
  const [saved,   setSaved]   = useState(false);
  const [preview, setPreview] = useState<VjPreview | null>(null);
  const [error,   setError]   = useState<string | null>(null);
  const [existingCount, setExistingCount]   = useState<number | null>(null);
  const [lockState,     setLockState]       = useState<PriorYearLockState>({ locked: false });
  const [lockLoading,   setLockLoading]     = useState(false);
  // Übernahme in die Erfolgsrechnung (A/B): NUR auf Klick — reines Öffnen löst keine Reads/Writes aus
  const [transferPlan,     setTransferPlan]     = useState<VjTransferMonthPlan[] | null>(null);
  const [transferChecking, setTransferChecking] = useState(false);
  const [transferError,    setTransferError]    = useState<string | null>(null);
  const [overwriteMonths,  setOverwriteMonths]  = useState<Set<number>>(new Set());
  const [transferring,     setTransferring]     = useState(false);
  const [transferDone,     setTransferDone]     = useState<string | null>(null);

  // Beim Laden: Datenzähler + Lock-Status laden
  useEffect(() => {
    const tid = tenantId ?? 'oliv';
    countVjDailyYear(year, tid).then(n => setExistingCount(n));
    getLockState(tid, year).then(s => setLockState(s));
    // Jahr-/Tenant-Wechsel: Übernahme-Vorschau verwerfen (gehört zum alten Kontext)
    setTransferPlan(null);
    setTransferError(null);
    setTransferDone(null);
    setOverwriteMonths(new Set());
  }, [year, tenantId]);

  const handleFile = async (file: File) => {
    setParsing(true);
    setPreview(null);
    setError(null);
    setSaved(false);
    const yearFromName = file.name.match(/20(\d{2})/)?.[0];
    const detectedYear = yearFromName ? parseInt(yearFromName) : year;
    if (yearFromName) setYear(detectedYear);
    try {
      const result = await parseVjDaily(file, detectedYear);
      setPreview(result);
    } catch (e) {
      setError(String(e));
      toast.error('Parse-Fehler: ' + String(e));
    } finally {
      setParsing(false);
    }
  };

  const handleSave = async () => {
    if (!preview) return;
    const tid = tenantId ?? 'oliv';

    // Lock-Check: Abbruch wenn Vorjahresdaten gesperrt sind
    if (lockState.locked) {
      console.warn(`[PRIOR-YEAR] import blocked: locked | tenant: ${tid} | year: ${preview.year}`);
      toast.error(`VJ ${preview.year} ist gesperrt. Bitte zuerst entsperren (nur Admin).`);
      return;
    }

    setSaving(true);
    try {
      const records: VjDayRecord[] = Object.entries(preview.days).map(([date, entry]) => ({
        date,
        year:          preview.year,
        actualRevenue: entry.gesamt,
        source:        'vorjahr_import',
        ...(entry.food     != null ? { foodRevenue: entry.food }         : {}),
        ...(entry.beverage != null ? { beverageRevenue: entry.beverage } : {}),
      }));

      const { upserted, error: supaErr } = await upsertVjDailyBatch(records, tid);

      if (supaErr) {
        toast.error('Supabase-Fehler: ' + supaErr);
        return;
      }

      // Seed-Flags zurücksetzen (verhindert alten Seed-Daten das Überschreiben)
      sessionStorage.removeItem('vj2025_imported_v1');
      sessionStorage.removeItem('vj2025_beaulieu_imported_v1');
      window.dispatchEvent(new Event('supabase-kv-synced'));
      setExistingCount(upserted);
      setSaved(true);
      console.log(`[PRIOR-YEAR] values preserved: yes | tenant: ${tid} | year: ${preview.year} | upserted: ${upserted}`);
      toast.success(`${upserted} Tage für ${preview.year} in Supabase gespeichert`);
    } catch (e) {
      toast.error('Speicher-Fehler: ' + String(e));
    } finally {
      setSaving(false);
    }
  };

  const handleLock = async () => {
    const tid = tenantId ?? 'oliv';
    setLockLoading(true);
    try {
      const { error } = await lockYear(tid, year, {
        source: 'vorjahr_import',
        days:   existingCount ?? undefined,
      });
      if (error) { toast.error('Sperren fehlgeschlagen: ' + error); return; }
      const newState = await getLockState(tid, year);
      setLockState(newState);
      toast.success(`VJ ${year} gesperrt — keine weiteren Imports möglich`);
    } finally {
      setLockLoading(false);
    }
  };

  const handleUnlock = async () => {
    const tid = tenantId ?? 'oliv';
    setLockLoading(true);
    try {
      const { error } = await unlockYear(tid, year);
      if (error) { toast.error('Entsperren fehlgeschlagen: ' + error); return; }
      setLockState({ locked: false });
      toast.success(`VJ ${year} entsperrt — Import wieder möglich`);
    } finally {
      setLockLoading(false);
    }
  };

  /**
   * Übernahme-Vorschau (A): liest die vj_daily-Tageswerte des Jahres (read-only)
   * und gleicht sie gegen die bestehenden Erfolgsrechnungs-Monate ab.
   * Die Jahres-Sperre blockiert nur vj_daily-WRITES — die Übernahme liest nur
   * vj_daily und schreibt ausschliesslich in die Erfolgsrechnung.
   */
  const handleTransferCheck = async () => {
    setTransferChecking(true);
    setTransferError(null);
    setTransferPlan(null);
    setTransferDone(null);
    setOverwriteMonths(new Set());
    try {
      const days = await loadVjDailyYear(year, tenantId);
      if (Object.keys(days).filter(d => d.startsWith(`${year}-`)).length === 0) {
        setTransferError(
          `Keine vj_daily-Tageswerte für ${year} gefunden (oder Supabase nicht erreichbar). ` +
          'Es wird nichts übernommen — fehlende Daten werden nie als 0 interpretiert.',
        );
        return;
      }
      const existing = loadYear(year, tenantKey(REPORTING_STORAGE_KEY));
      setTransferPlan(buildVjTransferPlan(year, days, existing));
    } catch (e) {
      setTransferError('Übernahme-Prüfung fehlgeschlagen: ' + String(e));
    } finally {
      setTransferChecking(false);
    }
  };

  /**
   * Übernahme bestätigen: schreibt NUR die gewählten Monate via saveMonth
   * (update-Merge, skipKvBackup) und sichert danach SEQUENZIELL nach Supabase
   * (retryReportingMonthsBackup) — parallele Blob-Upserts würden sich sonst
   * gegenseitig mit veralteten Monatswerten überschreiben. Backup-Fehler
   * werden sichtbar gemeldet (notifyKVBackupProblem mit «Erneut versuchen»).
   */
  const handleTransferConfirm = async () => {
    if (!transferPlan) return;
    const toTransfer = selectTransferMonths(transferPlan, overwriteMonths);
    if (toTransfer.length === 0) return;
    setTransferring(true);
    try {
      const storeKey = tenantKey(REPORTING_STORAGE_KEY);
      const monthIds: string[] = [];
      for (const p of toTransfer) {
        saveMonth(
          buildVjTransferPayload(year, p),
          'vj_daily_transfer',
          'update',
          {
            note: `Übernahme aus vj_daily (${p.dayCount} Tage, Brutto ${NUM.format(Math.round(p.grossTotal))} CHF)`,
            skipKvBackup: true,
          },
          storeKey,
        );
        monthIds.push(p.monthId);
      }
      const skippedConflicts = transferPlan.filter(p => p.transferable && p.conflict && !overwriteMonths.has(p.month)).length;
      setTransferDone(
        `${toTransfer.length} Monat(e) in die Erfolgsrechnung übernommen` +
        (skippedConflicts > 0 ? ` — ${skippedConflicts} Konflikt-Monat(e) unverändert gelassen` : ''),
      );
      setTransferPlan(null);
      setOverwriteMonths(new Set());
      notifyReportingDataChanged();
      toast.success(`${toTransfer.length} Monat(e) für ${year} in die Erfolgsrechnung übernommen`);

      // Sequenzielle Supabase-Sicherung der übernommenen Monate — Fehler sichtbar
      const backup = await retryReportingMonthsBackup(monthIds, storeKey);
      if (backup.failedMonths.length > 0) {
        const failed = backup.failedMonths;
        void notifyKVBackupProblem(backup.lastError, `Übernahme ${year} (${failed.length} Monat(e))`, {
          toastId: `vj-transfer-backup-${year}`,
          retry: async () => {
            const res = await retryReportingMonthsBackup(failed, storeKey);
            if (res.failedMonths.length > 0) {
              throw res.lastError ?? new Error(`${res.failedMonths.length} Monat(e) weiterhin nicht gesichert`);
            }
            toast.success(`Supabase-Backup vervollständigt (${failed.length} Monat(e) nachgesichert).`);
          },
        });
      }
    } catch (e) {
      toast.error('Übernahme fehlgeschlagen: ' + String(e));
    } finally {
      setTransferring(false);
    }
  };

  return (
    <div className="space-y-4">

      {/* Lock-Status ─────────────────────────────────────────────────────────── */}
      {lockState.locked ? (
        <div className="flex items-center gap-2 rounded-lg border border-amber-300 dark:border-amber-700 bg-amber-50 dark:bg-amber-950/20 px-3 py-2 text-[11px]">
          <Lock className="h-3.5 w-3.5 shrink-0 text-amber-600 dark:text-amber-400" />
          <span className="text-amber-800 dark:text-amber-300 flex-1">
            <strong>VJ {year} gesperrt</strong> — Import blockiert.
            {lockState.lockedAt && <> Fixiert am {formatLockedAt(lockState.lockedAt)}.</>}
            {lockState.source   && <> Quelle: <span className="font-mono">{lockState.source}</span>.</>}
            {lockState.days != null && <> {lockState.days} Tage importiert.</>}
          </span>
          {isAdmin && (
            <Button
              size="sm" variant="outline"
              className="h-6 px-2 text-[10px] gap-1 border-amber-400 text-amber-700 hover:bg-amber-100 dark:text-amber-300 dark:border-amber-600"
              onClick={handleUnlock}
              disabled={lockLoading}
            >
              {lockLoading ? <Loader2 className="h-3 w-3 animate-spin" /> : <LockOpen className="h-3 w-3" />}
              Entsperren
            </Button>
          )}
        </div>
      ) : (
        <>
          {/* Supabase-Status (nur wenn entsperrt) */}
          {existingCount !== null && existingCount > 0 && (
            <div className="flex items-center gap-2 rounded-lg border border-teal-200 dark:border-teal-800 bg-teal-50 dark:bg-teal-950/20 px-3 py-2 text-[11px]">
              <ShieldCheck className="h-3.5 w-3.5 shrink-0 text-teal-600 dark:text-teal-400" />
              <span className="text-teal-700 dark:text-teal-400 flex-1">
                Supabase: <strong>{existingCount}</strong> VJ-Datensätze für {year} — Tagesansicht liest diese bereits.
              </span>
              {isAdmin && (
                <Button
                  size="sm" variant="outline"
                  className="h-6 px-2 text-[10px] gap-1 border-teal-400 text-teal-700 hover:bg-teal-100 dark:text-teal-300 dark:border-teal-600"
                  onClick={handleLock}
                  disabled={lockLoading}
                >
                  {lockLoading ? <Loader2 className="h-3 w-3 animate-spin" /> : <Lock className="h-3 w-3" />}
                  Fixieren
                </Button>
              )}
            </div>
          )}
          {existingCount !== null && existingCount === 0 && (
            <div className="flex items-center gap-2 rounded-lg border border-border bg-muted/40 px-3 py-2 text-[11px] text-muted-foreground">
              <Database className="h-3.5 w-3.5 shrink-0" />
              <span>Noch keine VJ-Tagesdaten in Supabase für {year}. Datei hochladen um zu importieren.</span>
            </div>
          )}
        </>
      )}

      {/* Jahres-Auswahl + Upload ──────────────────────────────────────────── */}
      <div className="flex items-end gap-3 flex-wrap">
        <div className="flex flex-col gap-1">
          <label className="text-[11px] text-muted-foreground font-medium">Importjahr</label>
          <Select
            value={String(year)}
            onValueChange={v => {
              setYear(Number(v));
              setPreview(null);
              setSaved(false);
              countVjDailyYear(Number(v), tenantId).then(n => setExistingCount(n));
            }}
          >
            <SelectTrigger className="h-8 w-28 text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {[currentYear - 2, currentYear - 1, currentYear].map(y => (
                <SelectItem key={y} value={String(y)} className="text-xs">{y}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div>
          <input
            ref={fileRef}
            type="file"
            accept=".xlsx,.xls"
            className="hidden"
            onChange={e => { const f = e.target.files?.[0]; if (f) handleFile(f); e.target.value = ''; }}
          />
          <Button
            size="sm"
            variant="outline"
            className="h-8 text-xs gap-1.5"
            onClick={() => fileRef.current?.click()}
            disabled={parsing || lockState.locked}
            title={lockState.locked ? `VJ ${year} ist gesperrt — Entsperren um zu importieren` : undefined}
          >
            {parsing
              ? <><Loader2 className="h-3.5 w-3.5 animate-spin" />Wird analysiert…</>
              : lockState.locked
                ? <><Lock className="h-3.5 w-3.5" />VJ {year} gesperrt</>
                : <><Upload className="h-3.5 w-3.5" />Excel-Datei wählen</>}
          </Button>
        </div>
      </div>

      {/* Fehler ──────────────────────────────────────────────────────────── */}
      {error && (
        <div className="flex items-start gap-2 rounded-lg border border-red-200 dark:border-red-800 bg-red-50 dark:bg-red-950/20 px-3 py-2.5 text-xs text-red-700 dark:text-red-400">
          <AlertCircle className="h-3.5 w-3.5 shrink-0 mt-0.5" />
          {error}
        </div>
      )}

      {/* Vorschau ────────────────────────────────────────────────────────── */}
      {preview && !saved && (
        <div className="rounded-lg border border-border bg-muted/30 p-3 space-y-3">
          {/* Erkennung */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-xs">
            <div className="bg-background rounded border border-border px-2 py-1.5">
              <p className="text-[10px] text-muted-foreground uppercase tracking-wide">Jahr</p>
              <p className="font-semibold mt-0.5">{preview.year}</p>
            </div>
            <div className="bg-background rounded border border-border px-2 py-1.5">
              <p className="text-[10px] text-muted-foreground uppercase tracking-wide">Tage erkannt</p>
              <p className="font-semibold mt-0.5">{preview.dayCount}</p>
            </div>
            <div className="bg-background rounded border border-border px-2 py-1.5 col-span-2">
              <p className="text-[10px] text-muted-foreground uppercase tracking-wide">Kategorien</p>
              <p className="font-semibold mt-0.5">{preview.rowsFound.join(' · ')}</p>
            </div>
          </div>

          {/* Sample-Werte */}
          <div>
            <p className="text-[11px] text-muted-foreground font-medium mb-1.5">Vorschau (erste 3 Tage mit Umsatz)</p>
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b border-border text-[10px] text-muted-foreground">
                  <th className="text-left pb-1">Datum</th>
                  <th className="text-right pb-1">Gesamt CHF</th>
                  {preview.rowsFound.includes('Food (Speisen)')      && <th className="text-right pb-1">Food CHF</th>}
                  {preview.rowsFound.includes('Beverage (Getränke)') && <th className="text-right pb-1">Bev. CHF</th>}
                </tr>
              </thead>
              <tbody>
                {preview.samples.map(s => (
                  <tr key={s.date} className="border-b border-border/40">
                    <td className="py-1 font-mono text-[11px] text-muted-foreground">{fmtDate(s.date)}</td>
                    <td className="py-1 text-right tabular-nums font-medium">{fmtN(s.gesamt)}</td>
                    {preview.rowsFound.includes('Food (Speisen)')      && <td className="py-1 text-right tabular-nums text-muted-foreground">{fmtN(s.food)}</td>}
                    {preview.rowsFound.includes('Beverage (Getränke)') && <td className="py-1 text-right tabular-nums text-muted-foreground">{fmtN(s.beverage)}</td>}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Supabase-Hinweis */}
          <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground bg-teal-50 dark:bg-teal-950/20 border border-teal-200 dark:border-teal-800 rounded px-2.5 py-1.5">
            <Database className="h-3.5 w-3.5 text-teal-600 dark:text-teal-400 shrink-0" />
            <span>Wird als <strong>{preview.dayCount} einzelne Zeilen</strong> in Supabase gespeichert (key: <code className="font-mono">vj_daily:YYYY-MM-DD</code>)</span>
          </div>

          {/* Speichern */}
          <div className="flex items-center gap-2 pt-1">
            <Button
              size="sm"
              className="h-8 text-xs gap-1.5"
              onClick={handleSave}
              disabled={saving || lockState.locked}
            >
              {saving
                ? <><Loader2 className="h-3.5 w-3.5 animate-spin" />Wird in Supabase gespeichert…</>
                : lockState.locked
                  ? <><Lock className="h-3.5 w-3.5" />Import gesperrt</>
                  : <><Database className="h-3.5 w-3.5" />In Supabase speichern ({preview.year})</>}
            </Button>
            {!lockState.locked && (
              <p className="text-[11px] text-muted-foreground">
                Upsert · bestehende {preview.year}-Datensätze werden aktualisiert
              </p>
            )}
          </div>
        </div>
      )}

      {/* Erfolg ──────────────────────────────────────────────────────────── */}
      {saved && preview && (
        <div className="flex items-center gap-2 rounded-lg border border-emerald-200 dark:border-emerald-800 bg-emerald-50 dark:bg-emerald-950/20 px-3 py-2.5 text-xs text-emerald-700 dark:text-emerald-400">
          <CheckCircle2 className="h-3.5 w-3.5 shrink-0" />
          <span>
            <strong>{preview.dayCount} Tage</strong> für {preview.year} in Supabase gespeichert.
            Tagesansicht liest ab sofort exakte Tageswerte aus Supabase.
          </span>
          <button
            className="ml-auto text-[11px] underline"
            onClick={() => { setPreview(null); setSaved(false); }}
          >
            Neue Datei
          </button>
        </div>
      )}

      {/* Hinweis / Leerzustand ───────────────────────────────────────────── */}
      {!preview && !error && (
        <div className="text-[11px] text-muted-foreground space-y-0.5">
          <p>• Format: Gastronovi-Tagesbericht Excel (.xlsx) — <strong>Jahres- oder Monats-Export</strong></p>
          <p>• Datumsheader: <span className="font-mono bg-muted px-1 rounded">01.04.</span>, <span className="font-mono bg-muted px-1 rounded">01.04.2025</span> oder Excel-Datumszellen — alle Formate werden erkannt</p>
          <p>• Spalte A: <span className="font-mono bg-muted px-1 rounded">Gesamt</span>, <span className="font-mono bg-muted px-1 rounded">Food (Speisen)</span>, <span className="font-mono bg-muted px-1 rounded">Beverage (Getränke)</span></p>
          <p>• Werte: <span className="font-mono bg-muted px-1 rounded">CHF 7'118.00</span> oder <span className="font-mono bg-muted px-1 rounded">CHF 7118,75</span></p>
          <p>• Monatsexport möglich: Nur die Tage des gewählten Monats werden importiert</p>
          <p>• Supabase ist die primäre Datenquelle — Daten werden dauerhaft gespeichert</p>
        </div>
      )}

      {/* Übernahme in die Erfolgsrechnung ────────────────────────────────── */}
      {isAdmin && !isGuest && (
        <div className="border-t border-border pt-3 space-y-2" data-testid="vj-transfer-section">
          <div className="flex items-center gap-2 flex-wrap">
            <p className="text-[11px] font-medium text-muted-foreground">
              Übernahme in die Erfolgsrechnung ({year})
            </p>
            <Button
              size="sm" variant="outline" className="h-7 text-[11px] gap-1"
              onClick={handleTransferCheck}
              disabled={transferChecking || transferring}
              data-testid="vj-transfer-check-button"
            >
              {transferChecking
                ? <Loader2 className="h-3 w-3 animate-spin" />
                : <Database className="h-3 w-3" />}
              Übernahme prüfen
            </Button>
          </div>
          <p className="text-[10px] text-muted-foreground">
            Überträgt die Monatssummen der importierten Tageswerte als Umsatz in die Erfolgsrechnung:
            Brutto = Summe der Tage, Netto = Brutto ÷ 1.081 (8.1 % MwSt, ohne Take-Away-Split).
            Monate ohne Tageswerte werden nie angelegt. Eine Jahres-Sperre blockiert nur den
            Tageswerte-Import — die Übernahme bleibt möglich.
          </p>

          {transferError && (
            <div className="flex items-start gap-2 text-xs text-red-600 dark:text-red-400" data-testid="vj-transfer-error">
              <AlertCircle className="h-4 w-4 flex-shrink-0 mt-0.5" />
              <span>{transferError}</span>
            </div>
          )}

          {transferDone && (
            <div className="flex items-center gap-2 text-xs text-emerald-700 dark:text-emerald-400" data-testid="vj-transfer-done">
              <CheckCircle2 className="h-3.5 w-3.5 shrink-0" />
              <span>{transferDone}</span>
            </div>
          )}

          {transferPlan && (() => {
            const transferable   = transferPlan.filter(p => p.transferable);
            const freeMonths     = transferable.filter(p => !p.conflict);
            const conflictMonths = transferable.filter(p => p.conflict);
            const selected       = selectTransferMonths(transferPlan, overwriteMonths);
            return (
              <div className="space-y-2" data-testid="vj-transfer-preview">
                <div className="rounded border text-[11px] overflow-auto">
                  <table className="w-full min-w-[520px]">
                    <thead className="bg-muted">
                      <tr>
                        <th className="text-left py-1 px-2 font-medium">Monat</th>
                        <th className="text-right py-1 px-2 font-medium">Tage</th>
                        <th className="text-right py-1 px-2 font-medium">Brutto CHF</th>
                        <th className="text-right py-1 px-2 font-medium">Netto CHF</th>
                        <th className="text-left py-1 px-2 font-medium">Ziel (Erfolgsrechnung)</th>
                        <th className="text-center py-1 px-2 font-medium">Überschreiben</th>
                      </tr>
                    </thead>
                    <tbody>
                      {transferPlan.map(p => (
                        <tr key={p.month} className="border-t" data-testid={`vj-transfer-row-${p.month}`}>
                          <td className="py-1 px-2 font-mono">{p.monthId}</td>
                          <td className="py-1 px-2 text-right tabular-nums">{p.dayCount > 0 ? p.dayCount : '—'}</td>
                          <td className="py-1 px-2 text-right tabular-nums">
                            {p.transferable ? NUM.format(Math.round(p.grossTotal)) : '—'}
                          </td>
                          <td className="py-1 px-2 text-right tabular-nums">
                            {p.transferable ? NUM.format(Math.round(p.netTotal)) : '—'}
                          </td>
                          <td className="py-1 px-2">
                            {!p.transferable ? (
                              <span className="text-muted-foreground">
                                {p.dayCount === 0 ? 'keine Tageswerte — wird nicht angelegt' : 'Summe 0 — wird nicht angelegt'}
                              </span>
                            ) : p.conflict ? (
                              <span className="text-amber-700 dark:text-amber-400">
                                belegt{p.existingGross !== undefined && <> · Brutto {NUM.format(Math.round(p.existingGross))}</>}
                                {p.existingNet !== undefined && <> · Netto {NUM.format(Math.round(p.existingNet))}</>}
                              </span>
                            ) : (
                              <span className="text-emerald-700 dark:text-emerald-400">frei</span>
                            )}
                          </td>
                          <td className="py-1 px-2 text-center">
                            {p.transferable && p.conflict && (
                              <Checkbox
                                checked={overwriteMonths.has(p.month)}
                                onCheckedChange={checked => {
                                  setOverwriteMonths(prev => {
                                    const next = new Set(prev);
                                    if (checked === true) next.add(p.month); else next.delete(p.month);
                                    return next;
                                  });
                                }}
                                data-testid={`vj-transfer-overwrite-${p.month}`}
                              />
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>

                <p className="text-[10px] text-muted-foreground">
                  {freeMonths.length} freie Monat(e) werden übernommen
                  {conflictMonths.length > 0 && (
                    <> · {conflictMonths.length} Monat(e) mit bestehenden Umsatzwerten werden nur
                    überschrieben, wenn oben explizit markiert</>
                  )}.
                  Übrige Monatsfelder (Kosten, Kategorien, Budget) bleiben unangetastet.
                  Hinweis: Die Tagesansicht und VJ-Vergleiche lesen weiterhin die Tageswerte
                  (vj_daily) — spätere manuelle Änderungen an diesen Erfolgsrechnungs-Monaten
                  erscheinen dort nicht.
                </p>

                <div className="flex items-center gap-2">
                  <Button
                    size="sm" className="h-8 text-xs gap-1.5"
                    onClick={handleTransferConfirm}
                    disabled={transferring || selected.length === 0}
                    data-testid="vj-transfer-confirm"
                  >
                    {transferring
                      ? <><Loader2 className="h-3.5 w-3.5 animate-spin" />Wird übernommen…</>
                      : <><CheckCircle2 className="h-3.5 w-3.5" />{selected.length} Monat(e) übernehmen</>}
                  </Button>
                  <Button
                    size="sm" variant="outline" className="h-8 text-xs"
                    onClick={() => { setTransferPlan(null); setOverwriteMonths(new Set()); }}
                    disabled={transferring}
                  >
                    Abbrechen
                  </Button>
                </div>
              </div>
            );
          })()}
        </div>
      )}
    </div>
  );
}
