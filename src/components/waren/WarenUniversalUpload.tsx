/**
 * WarenUniversalUpload — EIN Upload für alle Warenrechnungs-Formate.
 * =================================================================
 * Eine Drop-Zone: CSV (Transgourmet/Prodega) und PDFs (Feldschlösschen,
 * Lieferanten-Profile, Unbekannt) werden automatisch klassifiziert und an
 * den richtigen Import-Kanal weitergeleitet (externalFilesRef der
 * bestehenden Import-Komponenten). Gemischte Stapel sind erlaubt.
 *
 * Erkennungsreihenfolge pro PDF (nie raten):
 *   1. Feldschlösschen-Kennung im Text  → Feldschlösschen-Import
 *   2. Lieferanten-Profil (MWST-Nr/Name/IBAN) → Profil-PDF-Import
 *   3. Unbekannt → ebenfalls Profil-PDF-Import: dort erscheint der Beleg
 *      als «Unbekannter Lieferant» mit MANUELLER Zuordnung (nie automatisch).
 * ZIP-Dateien gehen direkt an den Feldschlösschen-Import (Jahres-Historie).
 */
import { useState } from 'react';
import { cn } from '@/lib/utils';
import { toast } from 'sonner';
import { Loader2, UploadCloud } from 'lucide-react';
import { extractGnPdfTextItems } from '@/lib/gn-pdf-text';
import { reconstructGnPdfLines } from '@/lib/gn-pdf-lines';
import { toFsZeilen, istFeldschloesschenPdf } from '@/lib/feldschloesschen';
import { loadLieferantenProfile, findeProfilImText } from '@/lib/lieferanten-profile';
import type { TenantId } from '@/contexts/TenantContext';

export interface UploadRouting {
  csv: File[];
  fs: File[];
  profil: File[];       // erkannte UND unbekannte PDFs (manuelle Zuordnung dort)
  /** Klassifikation je Datei (für Anzeige + gezielte Filterung). */
  erkannt: Array<{
    datei: File;
    file: string;                          // Dateiname (Anzeige)
    ziel: string;                          // Label (Anzeige)
    kanal: 'csv' | 'fs' | 'profil' | null; // null = abgewiesen
    /** Erkannter Profil-Lieferant (nur kanal 'profil' mit Treffer). */
    profilName?: string;
  }>;
}

/** Dateien klassifizieren (exportiert für gezielten Upload je Lieferant). */
export async function klassifiziereWarenDateien(
  tenantId: TenantId,
  files: File[],
): Promise<UploadRouting> {
  const routing: UploadRouting = { csv: [], fs: [], profil: [], erkannt: [] };
  const profile = await loadLieferantenProfile(tenantId);
  for (const f of files) {
    if (/\.(csv|txt)$/i.test(f.name)) {
      routing.csv.push(f);
      routing.erkannt.push({ datei: f, file: f.name, ziel: 'CSV-Positionsimport (Transgourmet/Prodega)', kanal: 'csv' });
      continue;
    }
    if (/\.zip$/i.test(f.name)) {
      routing.fs.push(f);
      routing.erkannt.push({ datei: f, file: f.name, ziel: 'Feldschlösschen (Jahres-ZIP)', kanal: 'fs' });
      continue;
    }
    if (!(f.type === 'application/pdf' || /\.pdf$/i.test(f.name))) {
      toast.warning(`${f.name}: Format nicht unterstützt (CSV, PDF oder ZIP).`);
      routing.erkannt.push({ datei: f, file: f.name, ziel: 'Format nicht unterstützt', kanal: null });
      continue;
    }
    // PDF: Text extrahieren und klassifizieren. Ohne Text-Layer → Profil-
    // Import (zeigt selbst die passende Fehlermeldung/manuelle Zuordnung).
    try {
      const res = await extractGnPdfTextItems(f);
      let text: string;
      let perOcr = false;
      if (!res.hasTextLayer) {
        // OCR-FALLBACK VOR dem Text-Layer-Gate: Scans werden ZUERST per OCR
        // gelesen und erst DANACH klassifiziert/abgewiesen — nie vorher.
        toast.info(`${f.name}: kein Text-Layer — Texterkennung (OCR) läuft …`);
        const ocr = await (await import('@/lib/pdf-ocr')).ocrPdfText(f).catch(() => null);
        if (!ocr) {
          routing.profil.push(f);
          routing.erkannt.push({ datei: f, file: f.name, ziel: 'Lieferanten-PDF (kein Text erkennbar, auch per OCR nicht — manuelle Prüfung)', kanal: 'profil' });
          continue;
        }
        text = ocr.text;
        perOcr = true;
      } else {
        const zeilen = toFsZeilen(reconstructGnPdfLines(res.pages));
        if (istFeldschloesschenPdf(zeilen)) {
          routing.fs.push(f);
          routing.erkannt.push({ datei: f, file: f.name, ziel: 'Feldschlösschen', kanal: 'fs' });
          continue;
        }
        text = zeilen.map(z => z.text).join('\n');
      }
      const { profil } = findeProfilImText(text, profile);
      routing.profil.push(f);
      routing.erkannt.push({
        datei: f, file: f.name, kanal: 'profil',
        ziel: profil
          ? `${profil.name} (Profil${perOcr ? ', OCR' : ''})`
          : perOcr ? 'Scan (OCR) — unbekannter Lieferant, manuelle Zuordnung'
          : 'Unbekannter Lieferant — manuelle Zuordnung',
        profilName: profil?.name,
      });
    } catch (e) {
      // Lesefehler: trotzdem an den Profil-Import geben — der meldet sauber.
      routing.profil.push(f);
      routing.erkannt.push({ datei: f, file: f.name, ziel: `Lesefehler (${e instanceof Error ? e.message : String(e)}) — manuelle Prüfung`, kanal: 'profil' });
    }
  }
  return routing;
}

export function WarenUniversalUpload({ tenantId, tenantColor, onRoute }: {
  tenantId: TenantId;
  tenantColor: string;
  /** Leitet klassifizierte Dateien an die Import-Kanäle weiter. */
  onRoute: (routing: UploadRouting) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const [letzte, setLetzte] = useState<UploadRouting['erkannt']>([]);

  const verarbeite = async (list: FileList | File[] | null) => {
    const files = Array.from(list ?? []);
    if (files.length === 0) return;
    setBusy(true);
    try {
      const routing = await klassifiziereWarenDateien(tenantId, files);
      setLetzte(routing.erkannt);
      onRoute(routing);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-2">
      <label
        className={cn(
          'flex flex-col items-center justify-center gap-1.5 rounded-xl border-2 border-dashed px-4 py-6 cursor-pointer transition-colors text-center',
          dragOver ? 'border-primary bg-primary/5' : 'border-border hover:bg-muted/30',
          busy && 'opacity-60 pointer-events-none',
        )}
        onDragOver={e => { e.preventDefault(); setDragOver(true); }}
        onDragLeave={() => setDragOver(false)}
        onDrop={e => { e.preventDefault(); setDragOver(false); void verarbeite(e.dataTransfer.files); }}
        data-testid="dropzone-universal-upload"
      >
        {busy
          ? <Loader2 className="h-6 w-6 animate-spin" style={{ color: tenantColor }} />
          : <UploadCloud className="h-6 w-6" style={{ color: tenantColor }} />}
        <span className="text-sm font-medium">
          {busy ? 'Dateien werden erkannt…' : 'Beleg hochladen — Lieferant wird automatisch erkannt'}
        </span>
        <span className="text-[11px] text-muted-foreground">
          Lieferant wird automatisch erkannt (MWST-Nr / Name / Format) — auch gemischte Stapel.
          Unbekannte Belege: manuelle Zuordnung, nie geraten.
        </span>
        <input
          type="file" multiple className="hidden"
          accept=".csv,.txt,.zip,application/pdf"
          data-testid="input-universal-upload"
          onChange={e => { void verarbeite(e.target.files); e.target.value = ''; }}
        />
      </label>
      {letzte.length > 0 && (
        <div className="rounded-lg border border-border bg-muted/20 px-3 py-2 text-[11px] space-y-0.5" data-testid="universal-upload-erkennung">
          {letzte.map((z, i) => (
            <div key={i} className="flex justify-between gap-3">
              <span className="truncate">{z.file}</span>
              <span className={cn('shrink-0', /Unbekannt|Lesefehler|manuelle/.test(z.ziel) ? 'text-amber-600 dark:text-amber-400' : 'text-muted-foreground')}>
                → {z.ziel}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
