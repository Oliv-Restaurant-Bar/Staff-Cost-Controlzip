/**
 * VjDailyImportSection
 * ====================
 * Importiert Vorjahres-Tagesumsätze aus einer Gastronovi-Excel-Datei
 * und speichert sie per Batch-Upsert in Supabase (app_settings).
 *
 * Supabase-Struktur:
 *   key   = "vj_daily:2025-04-03"
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
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { toast } from 'sonner';
import { Upload, CheckCircle2, Loader2, AlertCircle, Database } from 'lucide-react';
import {
  upsertVjDailyBatch,
  countVjDailyYear,
  type VjDayRecord,
} from '@/lib/vj-daily-supabase';

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

async function parseVjDaily(file: File, year: number): Promise<VjPreview> {
  const buf = await file.arrayBuffer();
  const wb  = XLSX.read(buf, { type: 'array' });
  const ws  = wb.Sheets[wb.SheetNames[0]];
  const raw = XLSX.utils.sheet_to_json<unknown[]>(ws, { header: 1, defval: '' });

  if (raw.length < 2) throw new Error('Datei enthält zu wenig Zeilen');

  const headerRow = raw[0] as unknown[];
  const colToDate: Record<number, string> = {};
  for (let c = 0; c < headerRow.length; c++) {
    const cell = String(headerRow[c] ?? '').trim();
    const m = cell.match(/^(\d{1,2})\.(\d{1,2})\.?$/);
    if (!m) continue;
    const dd = m[1].padStart(2, '0');
    const mm = m[2].padStart(2, '0');
    colToDate[c] = `${year}-${mm}-${dd}`;
  }

  if (Object.keys(colToDate).length < 28) {
    throw new Error(`Zu wenige Datum-Spalten erkannt (${Object.keys(colToDate).length}). Bitte Datei prüfen.`);
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
  const fileRef   = useRef<HTMLInputElement>(null);
  const [year,    setYear]    = useState(currentYear - 1);
  const [parsing, setParsing] = useState(false);
  const [saving,  setSaving]  = useState(false);
  const [saved,   setSaved]   = useState(false);
  const [preview, setPreview] = useState<VjPreview | null>(null);
  const [error,   setError]   = useState<string | null>(null);
  const [existingCount, setExistingCount] = useState<number | null>(null);

  // Beim Laden prüfen ob bereits VJ-Daten in Supabase vorhanden sind
  useEffect(() => {
    countVjDailyYear(year).then(n => setExistingCount(n));
  }, [year]);

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
    setSaving(true);
    try {
      // VjDayRecord-Array aus Preview aufbauen
      const records: VjDayRecord[] = Object.entries(preview.days).map(([date, entry]) => ({
        date,
        year:          preview.year,
        actualRevenue: entry.gesamt,
        source:        'vorjahr_import',
        ...(entry.food     != null ? { foodRevenue: entry.food }         : {}),
        ...(entry.beverage != null ? { beverageRevenue: entry.beverage } : {}),
      }));

      const { upserted, error: supaErr } = await upsertVjDailyBatch(records);

      if (supaErr) {
        toast.error('Supabase-Fehler: ' + supaErr);
        return;
      }

      // Session-Storage zurücksetzen damit useVj2025Import nicht mehr alt-importiert
      sessionStorage.removeItem('vj2025_imported_v1');
      window.dispatchEvent(new Event('supabase-kv-synced'));
      setExistingCount(upserted);
      setSaved(true);
      toast.success(`${upserted} Tage für ${preview.year} in Supabase gespeichert`);
    } catch (e) {
      toast.error('Speicher-Fehler: ' + String(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-4">

      {/* Supabase-Status ─────────────────────────────────────────────────────── */}
      {existingCount !== null && (
        <div className={`flex items-center gap-2 rounded-lg border px-3 py-2 text-[11px] ${
          existingCount > 0
            ? 'border-teal-200 dark:border-teal-800 bg-teal-50 dark:bg-teal-950/20 text-teal-700 dark:text-teal-400'
            : 'border-border bg-muted/40 text-muted-foreground'
        }`}>
          <Database className="h-3.5 w-3.5 shrink-0" />
          {existingCount > 0
            ? <span>Supabase enthält <strong>{existingCount}</strong> VJ-Tagesdatensätze für {year} — Tagesansicht liest diese bereits.</span>
            : <span>Noch keine VJ-Tagesdaten in Supabase für {year}. Datei hochladen um zu importieren.</span>
          }
        </div>
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
              countVjDailyYear(Number(v)).then(n => setExistingCount(n));
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
            disabled={parsing}
          >
            {parsing
              ? <><Loader2 className="h-3.5 w-3.5 animate-spin" />Wird analysiert…</>
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
              disabled={saving}
            >
              {saving
                ? <><Loader2 className="h-3.5 w-3.5 animate-spin" />Wird in Supabase gespeichert…</>
                : <><Database className="h-3.5 w-3.5" />In Supabase speichern ({preview.year})</>}
            </Button>
            <p className="text-[11px] text-muted-foreground">
              Upsert · bestehende {preview.year}-Datensätze werden aktualisiert
            </p>
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
          <p>• Format: Gastronovi-Tagesbericht Excel (.xlsx)</p>
          <p>• Erste Zeile: Datumsheader <span className="font-mono bg-muted px-1 rounded">01.01.</span>, <span className="font-mono bg-muted px-1 rounded">02.01.</span> …</p>
          <p>• Spalte A: <span className="font-mono bg-muted px-1 rounded">Gesamt</span>, <span className="font-mono bg-muted px-1 rounded">Food (Speisen)</span>, <span className="font-mono bg-muted px-1 rounded">Beverage (Getränke)</span></p>
          <p>• Werte: <span className="font-mono bg-muted px-1 rounded">CHF 7'118.00</span> oder <span className="font-mono bg-muted px-1 rounded">CHF 7118,75</span></p>
          <p>• Supabase ist die primäre Datenquelle — Daten werden dauerhaft gespeichert</p>
        </div>
      )}
    </div>
  );
}
