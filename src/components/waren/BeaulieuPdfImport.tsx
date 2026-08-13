/**
 * Lieferanten-PDF-Import über Profile (Mandant Beaulieu).
 *
 * - Mehrere Rechnungs-PDFs hochladen → Erkennung via MWST-Nr-Profile
 *   (Stufe 1: Kopf; Stufe 2: Positionen je Lieferung für Terravigna/Spahni/
 *   Fideco → Preisüberwachung wie Transgourmet/Feldschlösschen).
 * - Vorschau VOR dem Schreiben: Lieferant/Konto/Betrag/Datum korrigierbar;
 *   unbekannte MWST-Nr → «Lieferant offen», Zuordnung wird dauerhaft gelernt.
 * - Buchung über die gemeinsame Kern-Pipeline (Upsert auf Lieferant+Nr+Datum,
 *   nie doppelt), EIN Undo-Slot (Typ «pdf_profil») mit Konfliktschutz.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { toast } from 'sonner';
import { FileScan, Loader2, X } from 'lucide-react';
import { extractGnPdfTextItems } from '@/lib/gn-pdf-text';
import { reconstructGnPdfLines } from '@/lib/gn-pdf-lines';
import { parseProfilPdf, type ProfilPdfErgebnis } from '@/lib/profil-pdf-parse';
import {
  loadLieferantenProfile, saveLieferantenProfile, lerneProfil, normalisiereMwstNr,
  erkenneMandantImText, hatMonatsrechnung, CAPORASO_KONTEN,
  type LieferantenProfil, type ProfilBelegtyp,
} from '@/lib/lieferanten-profile';
import { kernImportiereFsRechnungen, type FsImportRechnung } from '@/lib/fs-import';
import {
  abgleicheMonatsrechnung, kopfAlsLieferung, type MonatsrechnungAbgleich, type AbgleichEintrag,
} from '@/lib/monatsrechnung-abgleich';
import {
  loadSuppliers, saveSuppliers, kategorieFromKonto,
  erstelleWarenImportSnapshot, saveWarenImportUndo,
  loadMonthInvoices, saveMonthInvoices,
  loadRechnungsPositionen, saveRechnungsPositionen,
  loadPreisHinweise, savePreisHinweise, bereinigeFibuMatchesFuerMonat, type InvoiceEntry,
  uploadImportBeleg, importBelegKey,
} from '@/lib/waren-db';
import { WarenImportUndoButton } from '@/components/waren/WarenCsvImport';
import {
  PositionenKontierungListe, effektiveArtikelKonten, offeneAnzahl,
} from '@/components/waren/PositionenKontierungVorschau';
import { loadWarengruppenMapping, loadArtikelKonten, saveArtikelKonten } from '@/lib/waren-db';
import {
  DEFAULT_WARENGRUPPEN_MAPPING,
  type ArtikelKontenMapping, type ParsedCsvRechnung, type WarengruppenMapping,
} from '@/lib/waren-positionen';
import { AlertTriangle } from 'lucide-react';
import type { TenantId } from '@/contexts/TenantContext';

interface VorschauZeile {
  fileName: string;
  /** Quell-PDF — wird beim Buchen als «📎 Beleg» abgelegt. */
  datei: File;
  ergebnis: ProfilPdfErgebnis;
  /** Editierbare Felder (Vorschau-Korrektur). */
  lieferant: string;        // Profil-ID oder '' = offen
  konto: string;
  rechnungsNr: string;
  datum: string;            // Buchungsdatum (Lieferdatum wenn vorhanden)
  netto: string;
  mwst: string;
  /** Zuordnungsfelder für «Lieferant offen». */
  neuName: string;
  neuKonto: string;
  neuKategorie: string;
  /** Dual-Lieferanten: Rolle dieses PDFs. Monatsrechnung ist MASSGEBLICH und
   *  überschreibt provisorische Lieferscheine/ABs mit den finalen Werten. */
  modus: 'lieferschein' | 'monatsrechnung';
  /** Abgleich (nur modus='monatsrechnung'): überschreiben/neu/unverändert. */
  abgleich?: MonatsrechnungAbgleich;
  /** Bestätigung nötig, weil manuell erfasste Buchungen überschrieben würden. */
  bestaetigt?: boolean;
  /** Einzel-Entscheid je «neu aus Rechnung»-Lieferung (Key = LS-Nr|Datum):
   *  'uebernehmen' = frisch (final) buchen, 'ignorieren' = nicht buchen.
   *  Import erst möglich, wenn JEDE neue Lieferung entschieden ist. */
  neuEntscheid?: Record<string, 'uebernehmen' | 'ignorieren'>;
  /** Einzel-Entscheid je «erfasst, aber nicht in der Monatsrechnung»-Buchung
   *  (Key = Buchungs-id): 'behalten' = bleibt provisorisch bestehen,
   *  'ignorieren' = wird beim Import ENTFERNT (nicht verrechnet). */
  lsEntscheid?: Record<string, 'behalten' | 'ignorieren'>;
  /** BELEG-Adresse gehört zum ANDEREN Mandanten → Zeile gesperrt (nie umbuchen). */
  mandantFremd?: 'oliv' | 'beaulieu';
  /** Dublette lt. Bestand (Mandant+Lieferant+Referenz): Re-Import ERSETZT. */
  dublette?: boolean;
}

/** Sammelvorschau-Status je Beleg. */
type BelegStatus = 'NEU' | 'ERSETZT' | 'GESPERRT' | 'FEHLER';

/**
 * Status für die Sammelvorschau: GESPERRT (nicht buchbar — falscher Mandant/
 * keine Rechnung) > FEHLER (Σ Lieferungen ≠ Netto, ±0.05) > ERSETZT (Dublette
 * im Bestand) > NEU.
 */
function belegStatus(z: VorschauZeile, buchbar: boolean): BelegStatus {
  if (!buchbar) return 'GESPERRT';
  const netto = num(z.netto);
  if (z.ergebnis.positionenErkannt && z.ergebnis.lieferungen.length > 0 && netto !== null) {
    const summe = R2(z.ergebnis.lieferungen.reduce((s, l) => s + l.nettoTotal, 0));
    if (Math.abs(summe - netto) > 0.05) return 'FEHLER';
  }
  return z.dublette ? 'ERSETZT' : 'NEU';
}

function num(s: string): number | null {
  const n = Number(s.replace(/[’'\s]/g, '').replace(',', '.'));
  return Number.isFinite(n) ? n : null;
}

const R2 = (n: number) => Math.round(n * 100) / 100;

export function BeaulieuPdfImport({ tenantId, onImported, externalFilesRef, uploadUiVersteckt }: {
  tenantId: TenantId; onImported: () => void;
  /** Optionaler Einspeise-Kanal: die Seite kann erkannte Profil-PDFs (z.B.
   *  Caporaso aus der Schnellerfassung) direkt in diese Vorschau umleiten. */
  externalFilesRef?: { current: ((files: File[]) => void) | null };
  /** true = Datei-Auswahl & Drag-Drop ausblenden (Import nur pro Lieferant
   *  via «Upload nur für …»); Vorschau & Undo bleiben sichtbar. */
  uploadUiVersteckt?: boolean;
}) {
  const [profile, setProfile] = useState<LieferantenProfil[]>([]);
  const [zeilen, setZeilen] = useState<VorschauZeile[]>([]);
  const [busy, setBusy] = useState(false);
  const [undoRefresh, setUndoRefresh] = useState(0);
  // Positions-Kontierung direkt in der Vorschau: Warengruppen-Tabelle des
  // Mandanten, gelernte Artikel-Zuordnungen + Overrides dieser Sitzung.
  const [wgMapping, setWgMapping] = useState<WarengruppenMapping>(DEFAULT_WARENGRUPPEN_MAPPING);
  const [artikelKonten, setArtikelKonten] = useState<ArtikelKontenMapping>({});
  const [kontoOverrides, setKontoOverrides] = useState<ArtikelKontenMapping>({});
  const [aufgeklappt, setAufgeklappt] = useState<Set<number>>(new Set());

  useEffect(() => {
    let alive = true;
    loadLieferantenProfile(tenantId).then(p => { if (alive) setProfile(p); });
    Promise.all([loadWarengruppenMapping(tenantId), loadArtikelKonten(tenantId)])
      .then(([m, ak]) => { if (alive) { setWgMapping(m); setArtikelKonten(ak); } })
      .catch(() => { /* Defaults bleiben */ });
    return () => { alive = false; };
  }, [tenantId]);

  const profilById = useMemo(() => new Map(profile.map(p => [p.id, p])), [profile]);

  const handleFiles = useCallback(async (files: FileList | File[] | null) => {
    if (!files || files.length === 0) return;
    const pdfs = Array.from(files).filter(f => f.type === 'application/pdf' || /\.pdf$/i.test(f.name));
    if (pdfs.length === 0) { toast.error('Bitte PDF-Dateien wählen.'); return; }
    setBusy(true);
    try {
      const aktuelleProfile = await loadLieferantenProfile(tenantId);
      setProfile(aktuelleProfile);
      const neu: VorschauZeile[] = [];
      // Monats-Bestand für den Dubletten-Check nur EINMAL pro Batch laden.
      const bestandCache = new Map<string, InvoiceEntry[]>();
      for (const f of pdfs) {
        try {
          const extract = await extractGnPdfTextItems(f);
          if (!extract.hasTextLayer) {
            toast.warning(`${f.name}: kein Text im PDF (Scan?) — bitte manuell erfassen.`);
            continue;
          }
          const text = reconstructGnPdfLines(extract.pages).map(l => l.text).join('\n');
          const erg = parseProfilPdf(text, aktuelleProfile);
          // Dual-Lieferant: Dokumenttyp INHALTSBASIERT (Belegüberschrift).
          // «Sammelrechnung/Monatsrechnung» = massgeblich/final — auch mit nur
          // EINER Lieferung. «Lieferschein»/AB/Offerte = provisorisch — auch
          // wenn er in mehrere «LS-Nr…vom»-Blöcke zerfällt. Ohne eindeutiges
          // Kopf-Signal ist lieferungen.length>1 nur ZUSAMMEN mit
          // belegart==='rechnung' ein Monatsrechnungs-Indiz, nie allein.
          const istDual = erg.profil?.belegtyp === 'dual';
          // Belegtyp 'monatsrechnung' (z.B. Ambro): die Rechnung ist IMMER die
          // massgebliche Quelle — jede Rechnung mit erkannten Lieferungen final.
          // STUFE-1-MONATSRECHNUNG (Dual OHNE Positions-Parser, z.B. Gourmador):
          // eindeutiger «Sammel-/Monatsrechnung»-Kopf + vollständige Kopf-Daten
          // ⇒ die Rechnung wird als EINE Gesamt-Lieferung abgeglichen und
          // ersetzt die provisorischen Lieferscheine (Einzelbestätigung).
          const kopfMr = istDual && !erg.positionenErkannt && erg.belegart === 'rechnung'
            && erg.dokumenttyp === 'monatsrechnung' && erg.profil
            ? kopfAlsLieferung(erg, erg.profil) : null;
          const modus: VorschauZeile['modus'] =
            erg.profil?.belegtyp === 'monatsrechnung' && erg.positionenErkannt && erg.belegart === 'rechnung'
              ? 'monatsrechnung'
              : istDual && erg.positionenErkannt
              ? (erg.dokumenttyp === 'monatsrechnung' ? 'monatsrechnung'
                : erg.dokumenttyp === 'lieferschein' ? 'lieferschein'
                : (erg.belegart === 'rechnung' && erg.lieferungen.length > 1 ? 'monatsrechnung' : 'lieferschein'))
              : kopfMr
              ? 'monatsrechnung'
              : 'lieferschein';
          // MANDANTEN-GEGENPROBE nach Beleg-Adresse: falscher Mandant ⇒ Sperre.
          const belegMandant = erkenneMandantImText(text);
          const mandantFremd = belegMandant !== null && belegMandant !== tenantId ? belegMandant : undefined;
          if (mandantFremd) {
            erg.hinweise.unshift(`Beleg gehört zu Mandant «${mandantFremd === 'oliv' ? 'Oliv' : 'Beaulieu'}» — wird hier NICHT gebucht. Bitte im richtigen Mandanten importieren.`);
          }
          const abgleich = modus === 'monatsrechnung' && erg.profil
            ? await abgleicheMonatsrechnung(tenantId, erg.profil.name,
                erg.lieferungen.length > 0 ? erg.lieferungen : (kopfMr ? [kopfMr] : []),
                erg.profil.abAlsLieferschein ? 3 : 0)
            : undefined;
          // Dubletten-Check für die Sammelvorschau (Mandant+Lieferant+Referenz,
          // Monate ±1): LS-Nrn UND Rechnungs-Nr prüfen — der Import kann je nach
          // Deckung/Korrekturen auf Stufe 2 (LS) ODER Stufe 1 (Rechnungs-Nr)
          // buchen. NUR Anzeige (NEU/ERSETZT) — massgeblich bleibt der
          // Kern-Upsert. BEST-EFFORT: ein Lesefehler darf die Vorschau NIE
          // beeinflussen (dann dublette=false, Zeile bleibt erhalten).
          let dublette = false;
          if (erg.profil && !mandantFremd) {
            try {
              const refs = new Set([...erg.lieferungen.map(l => l.rechnungsNr), erg.rechnungsNr ?? '']
                .filter(Boolean).map(r => r.trim().toLowerCase()));
              const daten = [
                ...erg.lieferungen.map(l => l.datum),
                ...[erg.lieferdatum ?? erg.rechnungsdatum].filter((d): d is string => !!d),
              ];
              const monate = new Set<string>();
              for (const d of daten) {
                const base = new Date(`${d}T00:00:00Z`);
                if (Number.isNaN(base.getTime())) continue;
                for (const off of [-1, 0, 1]) {
                  const x = new Date(base); x.setUTCMonth(x.getUTCMonth() + off);
                  monate.add(x.toISOString().slice(0, 7));
                }
              }
              const name = erg.profil.name.trim().toLowerCase();
              for (const m of monate) {
                if (dublette) break;
                let bestand = bestandCache.get(m);
                if (!bestand) { bestand = await loadMonthInvoices(tenantId, m); bestandCache.set(m, bestand); }
                dublette = bestand.some(e => e.supplierName.trim().toLowerCase() === name
                  && !!e.reference && refs.has(e.reference.trim().toLowerCase()));
              }
            } catch (e) {
              console.warn('[BEAULIEU-PDF] Dubletten-Check fehlgeschlagen (nur Anzeige, ignoriert):', e);
              dublette = false;
            }
          }
          neu.push({
            dublette,
            modus, abgleich, mandantFremd,
            fileName: f.name, datei: f, ergebnis: erg,
            lieferant: erg.profil?.id ?? '',
            konto: erg.profil?.konto ?? '',
            rechnungsNr: erg.rechnungsNr ?? '',
            datum: erg.lieferdatum ?? erg.rechnungsdatum ?? '',
            netto: erg.netto !== null ? String(erg.netto) : '',
            mwst: erg.mwst !== null ? String(erg.mwst) : '',
            neuName: '', neuKonto: '4060', neuKategorie: '',
          });
        } catch (e) {
          console.error('[BEAULIEU-PDF] Lesen fehlgeschlagen:', f.name, e);
          toast.error(`${f.name}: PDF konnte nicht gelesen werden.`);
        }
      }
      setZeilen(z => [...z, ...neu]);
    } finally { setBusy(false); }
  }, [tenantId]);

  // Einspeise-Kanal für die Seite: erkannte Profil-PDFs (z.B. Caporaso aus der
  // Schnellerfassung) landen direkt in dieser Vorschau statt im Formular.
  useEffect(() => {
    if (!externalFilesRef) return;
    externalFilesRef.current = (files: File[]) => { void handleFiles(files); };
    return () => { externalFilesRef.current = null; };
  }, [externalFilesRef, handleFiles]);

  function patch(i: number, p: Partial<VorschauZeile>) {
    setZeilen(z => z.map((row, idx) => idx === i ? { ...row, ...p } : row));
  }

  /** Zuordnung MWST-Nr → Lieferant/Konto dauerhaft speichern (Vorschau). */
  async function handleZuordnen(i: number) {
    const row = zeilen[i];
    const mwstNr = row.ergebnis.mwstNrn[0] ?? '';
    if (!row.neuName.trim() || !row.neuKonto.trim()) { toast.error('Bitte Lieferant und Konto angeben.'); return; }
    try {
      const satz = row.ergebnis.mwstSatz;
      const next = await lerneProfil(tenantId, {
        mwstNr, name: row.neuName.trim(), konto: row.neuKonto.trim(),
        kategorie: row.neuKategorie.trim() || 'Sonstiges',
        ...(satz !== null ? { mwstSatz: satz } : {}),
      });
      setProfile(next);
      const p = next.find(x => (mwstNr && x.mwstNr === normalisiereMwstNr(mwstNr))
        || x.name.trim().toLowerCase() === row.neuName.trim().toLowerCase());
      if (p) patch(i, { lieferant: p.id, konto: p.konto });
      toast.success(mwstNr
        ? `Zuordnung gespeichert: CHE-${mwstNr} → ${row.neuName.trim()} (gilt künftig automatisch).`
        : `Profil «${row.neuName.trim()}» gespeichert.`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    }
  }

  /** Lieferanten-Stammdaten (manuelle Erfassung) mit Profilen abgleichen —
   *  EIN Batch (ein Read/Write), nie parallel pro Profil (Race-Gefahr). */
  async function syncSuppliers(profs: LieferantenProfil[]) {
    try {
      let sups = await loadSuppliers(tenantId);
      for (const p of profs) {
        const vorhanden = sups.find(s => s.name.trim().toLowerCase() === p.name.trim().toLowerCase());
        const patchSup = {
          defaultWarenkonto: p.konto,
          defaultKategorie: kategorieFromKonto(p.konto),
          ...(p.mwstSatz !== undefined ? { defaultVatRate: p.mwstSatz } : {}),
        };
        sups = vorhanden
          ? sups.map(s => s.id === vorhanden.id ? { ...s, active: true, ...patchSup } : s)
          : [...sups, { id: `sup-${Date.now()}-${sups.length}`, name: p.name, active: true, createdAt: new Date().toISOString(), ...patchSup }];
      }
      await saveSuppliers(tenantId, sups);
    } catch (e) {
      console.warn('[BEAULIEU-PDF] Lieferanten-Sync fehlgeschlagen (nicht kritisch):', e);
    }
  }

  // Belegart-Sperre: Auftragsbestätigungen/Offerten/Bestellungen sind NIE buchbar —
  // AUSNAHME: AB bei Profilen mit «Auftragsbestätigung = Lieferschein» (provisorisch).
  const istBuchbar = (z: VorschauZeile) => !z.mandantFremd
    && (z.ergebnis.belegart === 'rechnung'
      || (z.ergebnis.belegart === 'auftragsbestaetigung' && profilById.get(z.lieferant)?.abAlsLieferschein === true));
  // Differenz-Einzelbestätigung (Dual-Modell): JEDE «neu aus Rechnung»-
  // Lieferung und JEDE «erfasst, aber nicht in der MR»-Buchung braucht einen
  // Entscheid ([Übernehmen]/[Ignorieren]) — nichts wird still übernommen.
  const neuKey = (e: AbgleichEintrag) => `${e.lieferung.rechnungsNr}|${e.lieferung.datum}`;
  /** MR-Lieferungen einer Zeile: Stufe 2 (Parser) oder Stufe-1-Kopf als EINE
   *  Gesamt-Lieferung (Dual ohne Positions-Parser, z.B. Gourmador). */
  const mrLieferungen = (z: VorschauZeile): ParsedCsvRechnung[] => {
    if (z.ergebnis.lieferungen.length > 0) return z.ergebnis.lieferungen;
    const kopf = z.ergebnis.profil ? kopfAlsLieferung(z.ergebnis, z.ergebnis.profil) : null;
    return kopf ? [kopf] : [];
  };
  const alleEntschieden = (z: VorschauZeile) => {
    if (!z.abgleich) return true;
    const neuOffen = z.abgleich.eintraege.some(e => e.status === 'neu' && !z.neuEntscheid?.[neuKey(e)]);
    const lsOffen = z.abgleich.nichtInMr.some(e => !z.lsEntscheid?.[e.id]);
    return !neuOffen && !lsOffen;
  };
  const bereit = zeilen.filter(z => z.lieferant !== ''
    && istBuchbar(z)
    && (z.modus === 'monatsrechnung'
      // Monatsrechnung (MASSGEBLICH): importierbar, sobald Lieferungen erkannt
      // sind; würden MANUELL erfasste Buchungen überschrieben, erst nach
      // ausdrücklicher Bestätigung — und JEDE Differenz-Zeile ist entschieden.
      ? (mrLieferungen(z).length > 0
        && ((z.abgleich?.manuell ?? 0) === 0 || z.bestaetigt === true)
        && alleEntschieden(z))
      : (z.datum !== '' && num(z.netto) !== null)));
  const offen = zeilen.filter(z => istBuchbar(z)
    && (z.lieferant === ''
      || (z.modus === 'monatsrechnung'
        ? (((z.abgleich?.manuell ?? 0) > 0 && z.bestaetigt !== true) || !alleEntschieden(z))
        : (z.datum === '' || num(z.netto) === null)))).length;
  const gesperrt = zeilen.filter(z => !istBuchbar(z)).length;

  async function handleImport() {
    if (bereit.length === 0) { toast.error('Keine importierbaren Rechnungen (Lieferant/Datum/Netto fehlen).'); return; }
    setBusy(true);
    try {
      // Buchungen pro Profil UND Quelle sammeln (provisorische Quellen —
      // Monatsrechnungs-Lückenfüller bzw. Auftragsbestätigungen — laufen als
      // eigene Kern-Aufrufe mit gesetzter quelle).
      const proProfil = new Map<string, {
        profil: LieferantenProfil; rechnungen: FsImportRechnung[];
        quelle?: 'monatsrechnung' | 'auftragsbestaetigung';
        /** Bestätigte «neu aus Rechnung»-LS-Nrn (fail-closed-Wache im Kern). */
        erlaubteNeu?: string[];
      }>();
      // Zum Entfernen bestätigte «erfasst, aber nicht in MR»-Buchungen.
      const zuEntfernen: Array<{ id: string; month: string; date: string; amountGross: number }> = [];
      for (const row of bereit) {
        const profil = profilById.get(row.lieferant);
        if (!profil) continue;
        // Quell-PDF als Beleg ablegen (Schlüssel Lieferant+Rechnungs-Nr —
        // Re-Import ERSETZT). BEST EFFORT: Fehler blockiert die Buchung nie.
        let belegPfad: string | undefined;
        try {
          belegPfad = await uploadImportBeleg(tenantId,
            importBelegKey(profil.name, row.rechnungsNr || row.fileName), row.datei);
        } catch (e) {
          console.warn('[BEAULIEU-PDF] Beleg-Ablage fehlgeschlagen (Buchung läuft weiter):', e);
          toast.warning(`${row.fileName}: Beleg konnte nicht abgelegt werden.`);
        }
        const konto = row.konto.trim() || profil.konto;
        const netto = num(row.netto) ?? 0;
        const mwst = num(row.mwst) ?? 0;
        const istMr = row.modus === 'monatsrechnung';
        // AB-als-Lieferschein (Terravigna): AB wird als PROVISORISCHE Lieferung
        // gebucht (quelle='auftragsbestaetigung'); die Rechnung ersetzt sie später.
        const istAbZeile = row.ergebnis.belegart === 'auftragsbestaetigung' && profil.abAlsLieferschein === true;
        const quelle = istMr ? 'monatsrechnung' as const : istAbZeile ? 'auftragsbestaetigung' as const : undefined;
        // Konto gehört in den Gruppen-Schlüssel: Zeilen desselben Lieferanten mit
        // unterschiedlich editiertem Konto laufen als getrennte Kern-Aufrufe —
        // die Vorschau (row.konto) entspricht so exakt der Buchung (extraMapping).
        const key = `${profil.id}|${konto}${quelle ? `|${quelle}` : ''}`;
        const eintrag = proProfil.get(key) ?? { profil: { ...profil, konto }, rechnungen: [], quelle };
        if (istMr) {
          // MASSGEBLICH: ALLE Lieferungen der Monatsrechnung werden gebucht —
          // der Kern überschreibt gematchte provisorische Buchungen mit den
          // finalen Werten (Lieferdatum je Lieferung aus der Rechnung) und
          // bucht Fehlendes frisch; der Gesamtbetrag wird NIE zusätzlich
          // gebucht. Manuell-Schutz UNMITTELBAR vor dem Schreiben frisch
          // prüfen (Vorschau kann veraltet sein).
          const fenster = profil.abAlsLieferschein ? 3 : 0;
          const mrLief = mrLieferungen(row);
          const frisch = await abgleicheMonatsrechnung(tenantId, profil.name, mrLief, fenster);
          // Bestätigung ist an den EXAKTEN Manuell-Fingerprint gebunden
          // (IDs + alte Werte der manuell erfassten Treffer) — jede Abweichung
          // (auch bei gleicher Anzahl) macht sie ungültig.
          const fingerprint = (a?: MonatsrechnungAbgleich) => (a?.eintraege ?? [])
            .filter(e => e.manuell && e.match)
            .map(e => `${e.match!.id}|${e.match!.date}|${e.match!.amountGross}`)
            .sort().join(';');
          if (frisch.manuell > 0 && fingerprint(frisch) !== fingerprint(row.abgleich)) {
            patch(zeilen.indexOf(row), { abgleich: frisch, bestaetigt: false });
            toast.warning(`${row.fileName}: Die manuell erfassten Treffer haben sich seit der Vorschau geändert — bitte neu prüfen und bestätigen. Nichts importiert.`);
            return;
          }
          // STALE-WACHE Differenz-Entscheide: haben sich die «neu»- oder
          // «nicht in MR»-Mengen seit der Vorschau geändert, sind die Einzel-
          // Entscheide ungültig — Abbruch, neu prüfen (fail-closed).
          const neuFp = (a?: MonatsrechnungAbgleich) => (a?.eintraege ?? [])
            .filter(e => e.status === 'neu').map(neuKey).sort().join(';');
          const lsFp = (a?: MonatsrechnungAbgleich) => (a?.nichtInMr ?? [])
            .map(e => `${e.id}|${e.date}|${e.amountGross}`).sort().join(';');
          if (neuFp(frisch) !== neuFp(row.abgleich) || lsFp(frisch) !== lsFp(row.abgleich)) {
            patch(zeilen.indexOf(row), { abgleich: frisch, neuEntscheid: {}, lsEntscheid: {} });
            toast.warning(`${row.fileName}: Die Differenz zur Monatsrechnung hat sich seit der Vorschau geändert — bitte neu prüfen und einzeln bestätigen. Nichts importiert.`);
            return;
          }
          // Ignorierte «neu»-Lieferungen werden NICHT gebucht; die übrigen
          // laufen mit erlaubteNeu-Wache (nur bestätigte Frisch-Buchungen).
          const ignorierteNeu = new Set(frisch.eintraege
            .filter(e => e.status === 'neu' && row.neuEntscheid?.[neuKey(e)] === 'ignorieren')
            .map(e => `${e.lieferung.rechnungsNr.trim().toLowerCase()}|${e.lieferung.datum}`));
          // VEREINIGEN statt zuweisen: mehrere Monatsrechnungen desselben
          // Profils im Batch teilen sich EINEN Kern-Aufruf — sonst verlöre
          // die letzte Datei die Freigaben der vorherigen.
          // Voller Schlüssel «nr|datum» (wie neuKey) — blosse Nummern sind bei
          // gleichen/leeren LS-Nrn nicht eindeutig (Kern prüft exakt dagegen).
          eintrag.erlaubteNeu = [...(eintrag.erlaubteNeu ?? []), ...frisch.eintraege
            .filter(e => e.status === 'neu' && row.neuEntscheid?.[neuKey(e)] === 'uebernehmen')
            .map(e => `${e.lieferung.rechnungsNr}|${e.lieferung.datum}`)];
          for (const l of mrLief) {
            if (ignorierteNeu.has(`${l.rechnungsNr.trim().toLowerCase()}|${l.datum}`)) continue;
            eintrag.rechnungen.push({ r: l, ...(belegPfad ? { receiptPath: belegPfad } : {}) });
          }
          // Zum ENTFERNEN bestätigte «erfasst, aber nicht in MR»-Buchungen —
          // Identität (id+Datum+Brutto) wird beim Löschen erneut geprüft.
          for (const e of frisch.nichtInMr) {
            if (row.lsEntscheid?.[e.id] === 'ignorieren') {
              zuEntfernen.push({ id: e.id, month: e.date.slice(0, 7), date: e.date, amountGross: e.amountGross });
            }
          }
          proProfil.set(key, eintrag);
          continue;
        }
        // Stufe-2-Lieferungen NUR wenn sie die freigegebene Vorschau exakt
        // decken: Positionssumme = editiertes Netto (±0.05) und Datum
        // unverändert. Sonst gilt die geprüfte Kopf-Buchung (Korrekturen des
        // Users sind führend, nie stumm die Roh-Parsdaten).
        const posSumme = R2(row.ergebnis.lieferungen.reduce((s, l) => s + l.nettoTotal, 0));
        const datumUnveraendert = row.datum === (row.ergebnis.lieferdatum ?? row.ergebnis.rechnungsdatum ?? '');
        const nrUnveraendert = row.rechnungsNr === (row.ergebnis.rechnungsNr ?? '');
        const stufe2Deckend = row.ergebnis.positionenErkannt
          && Math.abs(posSumme - netto) <= 0.05 && datumUnveraendert && nrUnveraendert;
        if (stufe2Deckend) {
          // Stufe 2: eine Buchung PRO LIEFERUNG mit deren LS-Datum.
          for (const l of row.ergebnis.lieferungen) eintrag.rechnungen.push({ r: l, ...(belegPfad ? { receiptPath: belegPfad } : {}) });
        } else {
          // Stufe 1: Kopf-Buchung als Ganzes (editierte Beträge sind führend).
          const satz = netto > 0 ? R2((mwst / netto) * 100) : 0;
          const r: ParsedCsvRechnung = {
            docKey: `${row.rechnungsNr || row.fileName}|${row.datum}|${profil.name}`,
            rechnungsNr: row.rechnungsNr || row.fileName,
            datum: row.datum, markt: profil.name,
            positionen: [{
              artNr: '', bezeichnung: 'Rechnung gesamt', warengruppe: profil.kategorie,
              menge: 0, einheit: '', preis: 0, positionspreis: netto,
              mwstBetrag: mwst, mwstCode: 1,
            }],
            nettoTotal: netto, mwstTotal: mwst, bruttoTotal: R2(netto + mwst),
          };
          void satz;
          eintrag.rechnungen.push({ r, nettoOffiziell: netto, bruttoOffiziell: R2(netto + mwst), ...(belegPfad ? { receiptPath: belegPfad } : {}) });
        }
        proProfil.set(key, eintrag);
      }

      // In der Vorschau gesetzte Kontierungen MERKEN (Artikel→Konto, pro Mandant)
      // — die Kern-Pipeline lädt die Tabelle und wendet sie sofort an.
      if (Object.keys(kontoOverrides).length > 0) {
        await saveArtikelKonten(tenantId, kontoOverrides);
        setArtikelKonten(a => effektiveArtikelKonten(a, kontoOverrides));
        setKontoOverrides({});
      }
      // Snapshot VOR dem Schreiben: alle betroffenen Monate ±1 + Preis-Historie.
      const monate = new Set<string>();
      for (const { rechnungen } of proProfil.values()) {
        for (const { r } of rechnungen) {
          const d = new Date(`${r.datum}T00:00:00Z`);
          for (const off of [-1, 0, 1]) {
            const x = new Date(d); x.setUTCMonth(x.getUTCMonth() + off);
            monate.add(x.toISOString().slice(0, 7));
          }
        }
      }
      for (const e of zuEntfernen) monate.add(e.month);
      const vorher = await erstelleWarenImportSnapshot(tenantId, { monate: [...monate], mitPreisHistorie: true });

      let neu = 0, ersetzt = 0, aenderungen = 0, provErsetzt = 0, ueberschrieben = 0, bereitsFinal = 0, kredFinal = 0;
      const lieferanten: string[] = [];
      for (const { profil, rechnungen, quelle, erlaubteNeu } of proProfil.values()) {
        if (rechnungen.length === 0) continue;
        const erg = await kernImportiereFsRechnungen(tenantId, profil.name, rechnungen, {
          noteLabel: 'Lieferanten-PDF', idPrefix: 'lpdf',
          // Caporaso: fester Split via MwSt-Basis (Küche 4060 / Betriebs-
          // material 4701) — Regeln VOR der Profil-Kategorie einfügen.
          extraMapping: profil.parser === 'caporaso'
            ? { ...CAPORASO_KONTEN, [profil.kategorie]: profil.konto }
            : { [profil.kategorie]: profil.konto },
          defaultKonto: profil.konto,
          ...(quelle ? { quelle } : {}),
          // «Monatsrechnung: nein» ⇒ Einzelrechnungen buchen sofort FINAL.
          ...(!quelle && !hatMonatsrechnung(profil) ? { finalDirekt: true } : {}),
          // AB↔Rechnungs-Match ohne Referenz-Treffer: enges ±3-Tage-Fenster.
          ...(profil.abAlsLieferschein ? { ersatzFensterTage: 3 } : {}),
          // Differenz-Wache: Frisch-Buchungen nur mit Einzelbestätigung.
          ...(quelle === 'monatsrechnung' && erlaubteNeu ? { erlaubteNeu } : {}),
        });
        neu += erg.neu; ersetzt += erg.ersetzt; aenderungen += erg.preisAenderungen;
        provErsetzt += erg.provisorischErsetzt;
        ueberschrieben += erg.ueberschrieben; bereitsFinal += erg.bereitsFinal;
        kredFinal += erg.kreditorenFinalisiert;
        for (const h of erg.hinweise) toast.warning(h, { duration: 12000 });
        if (!lieferanten.includes(profil.name)) lieferanten.push(profil.name);
      }
      // Zum ENTFERNEN bestätigte «erfasst, aber nicht in MR»-Buchungen löschen —
      // NACH dem Kern-Lauf (frischer Bestand), Identität streng geprüft:
      // id + Datum + Brutto unverändert UND weiterhin provisorisch (!final);
      // jede Abweichung lässt die Buchung stehen (fail-closed, Hinweis).
      let entfernt = 0;
      for (const [month, eintraege] of Object.entries(
        zuEntfernen.reduce<Record<string, typeof zuEntfernen>>((acc, e) => {
          (acc[e.month] ??= []).push(e); return acc;
        }, {}))) {
        const bestand = await loadMonthInvoices(tenantId, month);
        const loeschen = new Set<string>();
        for (const e of eintraege) {
          const b = bestand.find(x => x.id === e.id);
          if (b && !b.final && b.date === e.date && Math.abs(b.amountGross - e.amountGross) <= 0.005) {
            loeschen.add(e.id);
          } else {
            toast.warning(`Lieferschein ${e.id} hat sich seit der Vorschau geändert — NICHT entfernt.`, { duration: 12000 });
          }
        }
        if (loeschen.size > 0) {
          const verbleibend = bestand.filter(x => !loeschen.has(x.id));
          await saveMonthInvoices(tenantId, month, verbleibend);
          // Verwaiste Nebenbestände mitbereinigen: Positionen, Preis-Hinweise
          // (beide im Undo-Snapshot) und FIBU-Match-Zuordnungen (best-effort,
          // rein visuell — sonst zeigt der Abgleich «gematcht» für Gelöschte).
          const pos = await loadRechnungsPositionen(tenantId, month);
          let posGeaendert = false;
          for (const id of loeschen) { if (pos[id]) { delete pos[id]; posGeaendert = true; } }
          if (posGeaendert) await saveRechnungsPositionen(tenantId, month, pos);
          const hin = await loadPreisHinweise(tenantId, month);
          let hinGeaendert = false;
          for (const id of loeschen) { if (hin[id]) { delete hin[id]; hinGeaendert = true; } }
          if (hinGeaendert) await savePreisHinweise(tenantId, month, hin);
          await bereinigeFibuMatchesFuerMonat(tenantId, month, new Set(verbleibend.map(x => x.id)));
          entfernt += loeschen.size;
        }
      }

      await syncSuppliers([...proProfil.values()].map(x => x.profil));

      const nachher = await erstelleWarenImportSnapshot(tenantId, { monate: [...monate], mitPreisHistorie: true });
      await saveWarenImportUndo(tenantId, {
        typ: 'pdf_profil',
        label: `Lieferanten-PDF (${lieferanten.join(', ')})`,
        zeitpunkt: new Date().toISOString(),
        anzahlRechnungen: neu + ersetzt,
        vorher, nachher,
      });
      setUndoRefresh(k => k + 1);
      setZeilen(z => z.filter(row => !bereit.includes(row)));
      toast.success(`${neu} Buchung${neu === 1 ? '' : 'en'} neu${ersetzt > 0 ? `, ${ersetzt} aktualisiert` : ''}${ueberschrieben > 0 ? ` (${ueberschrieben} provisorisch→final überschrieben)` : ''}${provErsetzt > 0 ? ` · ${provErsetzt} provisorische ersetzt` : ''}${bereitsFinal > 0 ? ` · ${bereitsFinal} bereits final (unangetastet)` : ''}${kredFinal > 0 ? ` · ${kredFinal} Kreditoren-Übernahme${kredFinal === 1 ? '' : 'n'} finalisiert` : ''}${aenderungen > 0 ? ` · ${aenderungen} Preisänderung${aenderungen === 1 ? '' : 'en'}` : ''}${entfernt > 0 ? ` · ${entfernt} nicht verrechnete${entfernt === 1 ? 'r' : ''} Lieferschein${entfernt === 1 ? '' : 'e'} entfernt` : ''}.`);
      onImported();
    } catch (e) {
      console.error('[BEAULIEU-PDF] Import fehlgeschlagen:', e);
      toast.error(e instanceof Error ? e.message : String(e));
    } finally { setBusy(false); }
  }

  return (
    <div className="border border-border/60 rounded-lg p-3 space-y-3" data-testid="beaulieu-pdf-import"
      onDragOver={e => { if (!uploadUiVersteckt) e.preventDefault(); }}
      onDrop={e => { if (uploadUiVersteckt) return; e.preventDefault(); void handleFiles(e.dataTransfer.files); }}>
      <div className="flex flex-wrap items-center gap-3">
        {!uploadUiVersteckt && (
        <label className="inline-flex items-center gap-2 text-xs font-medium rounded-lg border border-dashed px-3 py-2 cursor-pointer hover:bg-muted/40 transition-colors">
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <FileScan className="h-4 w-4 text-primary" />}
          Lieferanten-PDFs importieren — Mehrfachauswahl/Drag&amp;Drop (Erkennung über MWST-Nr-Profile)
          <input type="file" accept="application/pdf" multiple className="hidden" disabled={busy}
            data-testid="input-beaulieu-pdf"
            onChange={e => { void handleFiles(e.target.files); e.target.value = ''; }} />
        </label>
        )}
        <span className="text-[11px] text-muted-foreground">
          Kopf-Erkennung für alle Profile · Positionen je Lieferung für Terravigna, Spahni, Fideco, Ambro, Transgourmet · Bohnenblust nur manuell
        </span>
      </div>

      <WarenImportUndoButton tenantId={tenantId} typ="pdf_profil" refresh={undoRefresh}
        onUndone={() => { setUndoRefresh(k => k + 1); onImported(); }} />

      {zeilen.length > 1 && (
        <div className="rounded-md border border-border/50 overflow-x-auto" data-testid="beaulieu-pdf-sammelvorschau">
          <table className="w-full text-xs">
            <thead>
              <tr className="text-[11px] text-muted-foreground border-b border-border/40">
                <th className="text-left font-medium px-2 py-1">Lieferant</th>
                <th className="text-left font-medium px-2 py-1">Rechnungs-Nr</th>
                <th className="text-left font-medium px-2 py-1">Rechnungsdatum</th>
                <th className="text-right font-medium px-2 py-1">Lieferungen</th>
                <th className="text-right font-medium px-2 py-1">Netto</th>
                <th className="text-right font-medium px-2 py-1">Brutto</th>
                <th className="text-left font-medium px-2 py-1">Status</th>
              </tr>
            </thead>
            <tbody>
              {zeilen.map((z, i) => {
                const status = belegStatus(z, istBuchbar(z));
                const netto = num(z.netto);
                const mwst = num(z.mwst);
                const brutto = netto !== null ? R2(netto + (mwst ?? 0)) : null;
                const rd = z.ergebnis.rechnungsdatum;
                return (
                  <tr key={`${z.fileName}-${i}`} className="border-b border-border/30 last:border-0"
                    data-testid={`beaulieu-pdf-sammel-${i}`}>
                    <td className="px-2 py-1">{profilById.get(z.lieferant)?.name ?? z.ergebnis.profil?.name ?? <span className="text-amber-600">offen</span>}</td>
                    <td className="px-2 py-1">{z.rechnungsNr || '—'}</td>
                    <td className="px-2 py-1">{rd ? rd.split('-').reverse().join('.') : '—'}</td>
                    <td className="px-2 py-1 text-right">{z.ergebnis.lieferungen.length || '—'}</td>
                    <td className="px-2 py-1 text-right tabular-nums">{netto !== null ? netto.toFixed(2) : '—'}</td>
                    <td className="px-2 py-1 text-right tabular-nums">{brutto !== null ? brutto.toFixed(2) : '—'}</td>
                    <td className="px-2 py-1">
                      <span className={`font-medium ${
                        status === 'NEU' ? 'text-emerald-600'
                        : status === 'ERSETZT' ? 'text-sky-600'
                        : status === 'FEHLER' ? 'text-amber-600'
                        : 'text-destructive'}`}
                        data-testid={`beaulieu-pdf-status-${i}`}>
                        {status}{status === 'ERSETZT' ? ' (Dublette)' : ''}
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
            <tfoot>
              {(() => {
                // Fusszeile: Σ nur über NEU + ERSETZT (buchbare, fehlerfreie Belege).
                const zaehlbar = zeilen.filter(z => {
                  const s = belegStatus(z, istBuchbar(z));
                  return s === 'NEU' || s === 'ERSETZT';
                });
                const sumNetto = R2(zaehlbar.reduce((s, z) => s + (num(z.netto) ?? 0), 0));
                const sumBrutto = R2(zaehlbar.reduce((s, z) => {
                  const n = num(z.netto); const m = num(z.mwst);
                  return n !== null ? s + n + (m ?? 0) : s;
                }, 0));
                const sumLief = zaehlbar.reduce((s, z) => s + z.ergebnis.lieferungen.length, 0);
                return (
                  <tr className="border-t border-border/50 font-medium" data-testid="beaulieu-pdf-sammel-total">
                    <td className="px-2 py-1" colSpan={3}>Σ {zaehlbar.length} Beleg{zaehlbar.length === 1 ? '' : 'e'} (NEU + ERSETZT)</td>
                    <td className="px-2 py-1 text-right">{sumLief}</td>
                    <td className="px-2 py-1 text-right tabular-nums">{sumNetto.toFixed(2)}</td>
                    <td className="px-2 py-1 text-right tabular-nums">{sumBrutto.toFixed(2)}</td>
                    <td className="px-2 py-1" />
                  </tr>
                );
              })()}
            </tfoot>
          </table>
        </div>
      )}

      {zeilen.length > 0 && (
        <div className="space-y-2" data-testid="beaulieu-pdf-vorschau">
          {zeilen.map((row, i) => {
            const erg = row.ergebnis;
            const istGesperrt = !istBuchbar(row);
            const istAb = !istGesperrt && erg.belegart === 'auftragsbestaetigung';
            const istOffen = !istGesperrt && row.lieferant === '';
            if (istGesperrt) {
              // Belegart-Sperre: erkannt, aber NIE buchbar — nur Hinweis.
              return (
                <div key={`${row.fileName}-${i}`}
                  className="rounded-md border border-destructive/50 bg-destructive/5 p-2 space-y-1"
                  data-testid={`beaulieu-pdf-gesperrt-${i}`}>
                  <div className="flex flex-wrap items-center gap-2 text-xs">
                    <span className="font-medium truncate max-w-[220px]" title={row.fileName}>{row.fileName}</span>
                    <span className="text-destructive font-medium">{erg.hinweise[0] ?? 'Keine Rechnung — wird nicht gebucht'}</span>
                    <button className="ml-auto text-muted-foreground hover:text-destructive"
                      onClick={() => setZeilen(z => z.filter((_, idx) => idx !== i))} title="Zeile entfernen">
                      <X className="h-3.5 w-3.5" />
                    </button>
                  </div>
                  {erg.netto !== null && (
                    <div className="text-[11px] text-muted-foreground">
                      Erkannt: {erg.profil?.name ?? 'Lieferant unbekannt'} · netto CHF {erg.netto.toFixed(2)} — wird ignoriert.
                    </div>
                  )}
                </div>
              );
            }
            return (
              <div key={`${row.fileName}-${i}`}
                className={`rounded-md border p-2 space-y-2 ${istOffen ? 'border-amber-500/60 bg-amber-500/5' : 'border-border/50'}`}>
                <div className="flex flex-wrap items-center gap-2 text-xs">
                  <span className="font-medium truncate max-w-[220px]" title={row.fileName}>{row.fileName}</span>
                  {istOffen
                    ? <span className="text-amber-600 font-medium">Lieferant offen{erg.mwstNrn[0] ? ` · CHE-${erg.mwstNrn[0]}` : ''}</span>
                    : <span className="text-muted-foreground">
                        {istAb
                          ? 'Auftragsbestätigung → provisorische Lieferung (Monatsrechnung überschreibt sie final)'
                          : row.modus === 'monatsrechnung'
                          ? `Monatsrechnung (massgeblich — überschreibt provisorische Buchungen) · ${erg.lieferungen.length > 0
                              ? `${erg.lieferungen.length} Lieferung${erg.lieferungen.length === 1 ? '' : 'en'}`
                              : 'Gesamtbuchung (ohne Positions-Parser)'}`
                          : erg.positionenErkannt
                          ? `${erg.lieferungen.length} Lieferung${erg.lieferungen.length === 1 ? '' : 'en'} · ${erg.lieferungen.reduce((s, l) => s + l.positionen.length, 0)} Positionen${erg.profil && !hatMonatsrechnung(erg.profil) ? ' · bucht sofort final' : ''}`
                          : `Kopf-Buchung (ohne Positionen)${erg.profil && !hatMonatsrechnung(erg.profil) ? ' · bucht sofort final' : ''}`}
                      </span>}
                  {!istOffen && profilById.get(row.lieferant)?.belegtyp === 'dual' && erg.positionenErkannt && (
                    <Select value={row.modus}
                      onValueChange={async v => {
                        const modus = v as VorschauZeile['modus'];
                        if (modus === 'monatsrechnung' && !row.abgleich) {
                          const p = profilById.get(row.lieferant);
                          const abgleich = p ? await abgleicheMonatsrechnung(tenantId, p.name, erg.lieferungen, p.abAlsLieferschein ? 3 : 0) : undefined;
                          patch(i, { modus, abgleich });
                        } else patch(i, { modus });
                      }}>
                      <SelectTrigger className="h-6 w-auto text-[11px]" data-testid={`beaulieu-pdf-modus-${i}`}>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="lieferschein">Einzel-Lieferschein(e) — provisorisch</SelectItem>
                        <SelectItem value="monatsrechnung">Monatsrechnung — massgeblich (überschreibt)</SelectItem>
                      </SelectContent>
                    </Select>
                  )}
                  <button className="ml-auto text-muted-foreground hover:text-destructive"
                    onClick={() => setZeilen(z => z.filter((_, idx) => idx !== i))} title="Zeile entfernen">
                    <X className="h-3.5 w-3.5" />
                  </button>
                </div>

                <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-2 text-xs">
                  <label className="space-y-0.5">
                    <span className="text-muted-foreground">Lieferant</span>
                    <Select value={row.lieferant || undefined}
                      onValueChange={v => {
                        const p = profilById.get(v);
                        patch(i, { lieferant: v, konto: p?.konto ?? row.konto });
                      }}>
                      <SelectTrigger className="h-7 text-xs" data-testid={`beaulieu-pdf-lieferant-${i}`}>
                        <SelectValue placeholder="wählen…" />
                      </SelectTrigger>
                      <SelectContent>
                        {profile.map(p => <SelectItem key={p.id} value={p.id}>{p.name}</SelectItem>)}
                      </SelectContent>
                    </Select>
                  </label>
                  <label className="space-y-0.5">
                    <span className="text-muted-foreground">Konto</span>
                    <Input className="h-7 text-xs" value={row.konto} onChange={e => patch(i, { konto: e.target.value })} />
                  </label>
                  <label className="space-y-0.5">
                    <span className="text-muted-foreground">Rechnungs-Nr</span>
                    <Input className="h-7 text-xs" value={row.rechnungsNr} onChange={e => patch(i, { rechnungsNr: e.target.value })} />
                  </label>
                  <label className="space-y-0.5">
                    <span className="text-muted-foreground">{erg.positionenErkannt ? 'Rechnungsdatum' : 'Buchungs-/Lieferdatum'}</span>
                    <Input className="h-7 text-xs" type="date" value={row.datum} onChange={e => patch(i, { datum: e.target.value })} />
                  </label>
                  <label className="space-y-0.5">
                    <span className="text-muted-foreground">Netto CHF</span>
                    <Input className="h-7 text-xs" inputMode="decimal" value={row.netto}
                      onChange={e => patch(i, { netto: e.target.value })} data-testid={`beaulieu-pdf-netto-${i}`} />
                  </label>
                  <label className="space-y-0.5">
                    <span className="text-muted-foreground">MwSt CHF{erg.mwstSatz !== null ? ` (${erg.mwstSatz}%)` : ''}</span>
                    <Input className="h-7 text-xs" inputMode="decimal" value={row.mwst} onChange={e => patch(i, { mwst: e.target.value })} />
                  </label>
                </div>

                {/* Positions-Kontierung: «⚠ N offen» anklickbar → Liste mit Konto-Dropdown */}
                {!istOffen && erg.positionenErkannt && (() => {
                  const profil = profilById.get(row.lieferant);
                  if (!profil) return null;
                  // Profil-Kategorie→Konto wie beim Import (extraMapping) VORNE einfügen.
                  const rowMapping: WarengruppenMapping = [
                    ...(profil.kategorie && (row.konto || profil.konto)
                      ? [{ gruppe: profil.kategorie, konto: (row.konto || profil.konto).trim() }] : []),
                    ...wgMapping,
                  ];
                  const effektiv = effektiveArtikelKonten(artikelKonten, kontoOverrides);
                  const allePos = erg.lieferungen.flatMap(l => l.positionen);
                  const offenAnz = offeneAnzahl(profil.name, allePos, rowMapping, effektiv);
                  const auf = aufgeklappt.has(i);
                  return (
                    <div className="border-t border-border/40 pt-1.5 space-y-1">
                      <button type="button"
                        className={`inline-flex items-center gap-1 text-[11px] rounded px-1 hover:underline ${
                          offenAnz > 0 ? 'text-amber-600 font-medium' : 'text-muted-foreground'}`}
                        title={offenAnz > 0 ? `${offenAnz} Position(en) ohne Konto — klicken zum Zuordnen` : 'Positionen anzeigen/kontieren'}
                        onClick={() => setAufgeklappt(prev => {
                          const next = new Set(prev);
                          if (next.has(i)) next.delete(i); else next.add(i);
                          return next;
                        })}
                        data-testid={`beaulieu-pdf-offen-${i}`}>
                        {offenAnz > 0 && <AlertTriangle className="h-3 w-3" />}
                        {offenAnz > 0
                          ? `${offenAnz} Position${offenAnz === 1 ? '' : 'en'} offen — Konto direkt zuordnen`
                          : `${allePos.length} Positionen anzeigen/kontieren`}
                      </button>
                      {auf && (
                        <PositionenKontierungListe lieferant={profil.name} positionen={allePos}
                          mapping={rowMapping} artikelKonten={effektiv}
                          onKonto={(key, konto) => setKontoOverrides(o => ({ ...o, [key]: konto }))}
                          testidPrefix={`beaulieu-pdf-${i}`} />
                      )}
                    </div>
                  );
                })()}

                {istOffen && (
                  <div className="flex flex-wrap items-end gap-2 text-xs border-t border-border/40 pt-2">
                    <label className="space-y-0.5">
                      <span className="text-muted-foreground">Neuer Lieferant</span>
                      <Input className="h-7 text-xs w-44" value={row.neuName} onChange={e => patch(i, { neuName: e.target.value })} />
                    </label>
                    <label className="space-y-0.5">
                      <span className="text-muted-foreground">Konto</span>
                      <Input className="h-7 text-xs w-20" value={row.neuKonto} onChange={e => patch(i, { neuKonto: e.target.value })} />
                    </label>
                    <label className="space-y-0.5">
                      <span className="text-muted-foreground">Kategorie</span>
                      <Input className="h-7 text-xs w-32" placeholder="z.B. Wein" value={row.neuKategorie}
                        onChange={e => patch(i, { neuKategorie: e.target.value })} />
                    </label>
                    <Button size="sm" variant="outline" className="h-7 text-xs" onClick={() => void handleZuordnen(i)}
                      data-testid={`beaulieu-pdf-zuordnen-${i}`}>
                      Zuordnung speichern (gilt künftig)
                    </Button>
                  </div>
                )}

                {row.modus === 'monatsrechnung' && row.abgleich && (
                  <div className="text-[11px] border-t border-border/40 pt-2 space-y-1"
                    data-testid={`beaulieu-pdf-abgleich-${i}`}>
                    <div className="text-foreground font-medium">
                      überschrieben (provisorisch→final): {row.abgleich.ueberschrieben} · neu aus
                      Rechnung: {row.abgleich.neu} · unverändert: {row.abgleich.unveraendert} · Summe
                      Monatsrechnung CHF {row.abgleich.summeMonatsrechnung.toFixed(2)}
                    </div>
                    {row.abgleich.eintraege.filter(e => e.status === 'ueberschreiben').map((e, j) => (
                      <div key={j} className="text-muted-foreground">
                        · {e.lieferung.positionen[0]?.bezeichnung === 'Monatsrechnung gesamt' ? 'Monatsrechnung' : 'Lieferung'} {e.lieferung.rechnungsNr} vom {e.lieferung.datum.split('-').reverse().join('.')} wird final
                        {e.diffBetrag ? ` · Betrag CHF ${e.diffBetrag.alt.toFixed(2)} → ${e.diffBetrag.neu.toFixed(2)}` : ''}
                        {e.diffDatum ? ` · Datum ${e.diffDatum.alt.split('-').reverse().join('.')} → ${e.diffDatum.neu.split('-').reverse().join('.')}` : ''}
                        {e.manuell ? ' · manuell erfasst!' : ''}
                      </div>
                    ))}
                    {(() => {
                      // Sichtbare Differenz Monatsrechnung ↔ erfasste Lieferscheine
                      // (leer wenn 0).
                      const diff = R2(row.abgleich.summeMonatsrechnung - row.abgleich.summeErfasst);
                      return Math.abs(diff) > 0.005 ? (
                        <div className="text-amber-600 font-medium" data-testid={`beaulieu-pdf-differenz-${i}`}>
                          Differenz Monatsrechnung ↔ erfasste Lieferscheine: CHF {diff.toFixed(2)}
                          {' '}(MR {row.abgleich.summeMonatsrechnung.toFixed(2)} · erfasst {row.abgleich.summeErfasst.toFixed(2)})
                        </div>
                      ) : null;
                    })()}
                    {row.abgleich.eintraege.filter(e => e.status === 'neu').map((e, j) => {
                      const k = neuKey(e);
                      const wahl = row.neuEntscheid?.[k];
                      const istKopfMr = e.lieferung.positionen[0]?.bezeichnung === 'Monatsrechnung gesamt';
                      return (
                        <div key={j} className="flex flex-wrap items-center gap-1.5 text-amber-600"
                          data-testid={`beaulieu-pdf-neu-${i}-${j}`}>
                          <span>
                            {istKopfMr
                              ? <>· Monatsrechnung {e.lieferung.rechnungsNr} vom {e.lieferung.datum.split('-').reverse().join('.')}
                                {' '}(CHF {e.lieferung.nettoTotal.toFixed(2)}) wird als Gesamtbuchung final gebucht und ersetzt
                                die Lieferscheine — bitte bestätigen:</>
                              : <>· Lieferung {e.lieferung.rechnungsNr} vom {e.lieferung.datum.split('-').reverse().join('.')}
                                {' '}(CHF {e.lieferung.nettoTotal.toFixed(2)}) steht in der Monatsrechnung, ist aber NICHT als
                                Lieferschein erfasst — bitte entscheiden:</>}
                          </span>
                          <Button size="sm" variant={wahl === 'uebernehmen' ? 'default' : 'outline'} className="h-5 px-2 text-[10px]"
                            data-testid={`beaulieu-pdf-neu-uebernehmen-${i}-${j}`}
                            onClick={() => patch(i, { neuEntscheid: { ...row.neuEntscheid, [k]: 'uebernehmen' } })}>
                            Übernehmen
                          </Button>
                          <Button size="sm" variant={wahl === 'ignorieren' ? 'default' : 'outline'} className="h-5 px-2 text-[10px]"
                            data-testid={`beaulieu-pdf-neu-ignorieren-${i}-${j}`}
                            onClick={() => patch(i, { neuEntscheid: { ...row.neuEntscheid, [k]: 'ignorieren' } })}>
                            Ignorieren
                          </Button>
                          {wahl === 'uebernehmen' && <span className="text-emerald-600">wird final gebucht</span>}
                          {wahl === 'ignorieren' && <span className="text-muted-foreground">wird nicht gebucht</span>}
                        </div>
                      );
                    })}
                    {row.abgleich.nichtInMr.map((e, j) => {
                      const wahl = row.lsEntscheid?.[e.id];
                      return (
                        <div key={e.id} className="flex flex-wrap items-center gap-1.5 text-amber-600"
                          data-testid={`beaulieu-pdf-nichtinmr-${i}-${j}`}>
                          <span>
                            · Lieferschein {e.reference || '—'} vom {e.date.split('-').reverse().join('.')}
                            {' '}(CHF {e.amountNet.toFixed(2)}) ist erfasst, fehlt aber in der Monatsrechnung — bitte entscheiden:
                          </span>
                          <Button size="sm" variant={wahl === 'behalten' ? 'default' : 'outline'} className="h-5 px-2 text-[10px]"
                            data-testid={`beaulieu-pdf-nichtinmr-behalten-${i}-${j}`}
                            onClick={() => patch(i, { lsEntscheid: { ...row.lsEntscheid, [e.id]: 'behalten' } })}>
                            Behalten
                          </Button>
                          <Button size="sm" variant={wahl === 'ignorieren' ? 'default' : 'outline'} className="h-5 px-2 text-[10px]"
                            data-testid={`beaulieu-pdf-nichtinmr-ignorieren-${i}-${j}`}
                            onClick={() => patch(i, { lsEntscheid: { ...row.lsEntscheid, [e.id]: 'ignorieren' } })}>
                            Ignorieren (entfernen)
                          </Button>
                          {wahl === 'behalten' && <span className="text-muted-foreground">bleibt provisorisch bestehen</span>}
                          {wahl === 'ignorieren' && <span className="text-destructive">wird beim Import entfernt</span>}
                        </div>
                      );
                    })}
                    {row.abgleich.manuell > 0 && (
                      <label className="flex items-center gap-2 text-amber-600 font-medium cursor-pointer"
                        data-testid={`beaulieu-pdf-manuell-bestaetigen-${i}`}>
                        <input type="checkbox" checked={row.bestaetigt === true}
                          onChange={e => patch(i, { bestaetigt: e.target.checked })} />
                        {row.abgleich.manuell} manuell erfasste Buchung{row.abgleich.manuell === 1 ? '' : 'en'} würde
                        {row.abgleich.manuell === 1 ? '' : 'n'} überschrieben — Überschreiben ausdrücklich bestätigen.
                      </label>
                    )}
                  </div>
                )}

                {erg.hinweise.length > 0 && row.modus !== 'monatsrechnung' && (
                  <div className="text-[11px] text-amber-600 space-y-0.5">
                    {erg.hinweise.map((h, j) => <div key={j}>· {h}</div>)}
                  </div>
                )}
              </div>
            );
          })}

          <div className="flex items-center gap-3">
            <Button size="sm" disabled={busy || bereit.length === 0} onClick={() => void handleImport()}
              data-testid="beaulieu-pdf-import-button">
              {busy ? <Loader2 className="h-4 w-4 animate-spin mr-1" /> : null}
              {bereit.length} Rechnung{bereit.length === 1 ? '' : 'en'} importieren
            </Button>
            {offen > 0 && <span className="text-[11px] text-amber-600">{offen} noch nicht importierbar (Zuordnung/Datum/Betrag fehlt)</span>}
            {(() => {
              const effektiv = effektiveArtikelKonten(artikelKonten, kontoOverrides);
              const offenPos = bereit.reduce((s, row) => {
                const profil = profilById.get(row.lieferant);
                if (!profil || !row.ergebnis.positionenErkannt) return s;
                const rowMapping: WarengruppenMapping = [
                  ...(profil.kategorie && (row.konto || profil.konto)
                    ? [{ gruppe: profil.kategorie, konto: (row.konto || profil.konto).trim() }] : []),
                  ...wgMapping,
                ];
                return s + offeneAnzahl(profil.name, row.ergebnis.lieferungen.flatMap(l => l.positionen), rowMapping, effektiv);
              }, 0);
              return offenPos > 0 ? (
                <span className="text-[11px] text-amber-600 inline-flex items-center gap-1" data-testid="beaulieu-pdf-offen-total">
                  <AlertTriangle className="h-3 w-3" />
                  {offenPos} Position{offenPos === 1 ? '' : 'en'} noch ohne Konto — Import möglich (provisorisch als Warenkosten)
                </span>
              ) : null;
            })()}
            {gesperrt > 0 && <span className="text-[11px] text-destructive">{gesperrt} Beleg{gesperrt === 1 ? '' : 'e'} gesperrt (keine Rechnung oder falscher Mandant — wird nicht gebucht)</span>}
            <Button size="sm" variant="ghost" className="text-xs" onClick={() => setZeilen([])}>Vorschau leeren</Button>
          </div>
        </div>
      )}
    </div>
  );
}

/** Einstellungen-Editor «Lieferanten-Profile (PDF-Erkennung)». */
export function LieferantenProfilEditor({ tenantId, canEdit }: { tenantId: TenantId; canEdit: boolean }) {
  const [profile, setProfile] = useState<LieferantenProfil[] | null>(null);
  // Save-Queue: Schreibvorgänge strikt serialisieren (Tipp-Races vermeiden).
  const saveQueue = useState(() => ({ p: Promise.resolve() }))[0];
  useEffect(() => {
    let alive = true;
    loadLieferantenProfile(tenantId).then(p => { if (alive) setProfile(p); });
    return () => { alive = false; };
  }, [tenantId]);
  if (!profile) return <div className="text-xs text-muted-foreground">Lade Profile…</div>;

  function save(next: LieferantenProfil[]) {
    setProfile(next);
    saveQueue.p = saveQueue.p
      .then(() => saveLieferantenProfile(tenantId, next))
      .catch(e => { toast.error(e instanceof Error ? e.message : String(e)); });
  }

  return (
    <div className="space-y-1.5" data-testid="lieferanten-profil-editor">
      <div className="grid grid-cols-[1fr_110px_110px_70px_60px_150px_110px_24px] gap-1.5 text-[11px] text-muted-foreground px-0.5">
        <span>Lieferant</span><span>MWST-Nr</span><span>Kategorie</span><span>Konto</span><span>MwSt %</span><span>Belegtyp</span><span>Monatsrechnung</span><span />
      </div>
      {profile.map(p => (
        <div key={p.id} className="grid grid-cols-[1fr_110px_110px_70px_60px_150px_110px_24px] gap-1.5 items-center">
          <Input className="h-7 text-xs" value={p.name} disabled={!canEdit}
            onChange={e => save(profile.map(x => x.id === p.id ? { ...x, name: e.target.value } : x))} />
          <Input className="h-7 text-xs" value={p.mwstNr} disabled={!canEdit} placeholder="—"
            onChange={e => save(profile.map(x => x.id === p.id ? { ...x, mwstNr: e.target.value } : x))} />
          <Input className="h-7 text-xs" value={p.kategorie} disabled={!canEdit}
            onChange={e => save(profile.map(x => x.id === p.id ? { ...x, kategorie: e.target.value } : x))} />
          <Input className="h-7 text-xs" value={p.konto} disabled={!canEdit}
            onChange={e => save(profile.map(x => x.id === p.id ? { ...x, konto: e.target.value } : x))} />
          <Input className="h-7 text-xs" value={p.mwstSatz ?? ''} disabled={!canEdit} inputMode="decimal"
            onChange={e => {
              const v = e.target.value.trim() === '' ? undefined : Number(e.target.value.replace(',', '.'));
              save(profile.map(x => x.id === p.id ? { ...x, mwstSatz: Number.isFinite(v as number) ? v : undefined } : x));
            }} />
          <Select value={p.belegtyp ?? 'einzelrechnung'} disabled={!canEdit}
            onValueChange={v => save(profile.map(x => x.id === p.id ? { ...x, belegtyp: v as ProfilBelegtyp } : x))}>
            <SelectTrigger className="h-7 text-[11px]" data-testid={`profil-belegtyp-${p.id}`}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="dual">Lieferscheine + Monatsrechnung</SelectItem>
              <SelectItem value="monatsrechnung">nur Monats-/Sammelrechnung</SelectItem>
              <SelectItem value="einzelrechnung">nur Einzelrechnung</SelectItem>
            </SelectContent>
          </Select>
          <Select value={hatMonatsrechnung(p) ? 'ja' : 'nein'} disabled={!canEdit}
            onValueChange={v => save(profile.map(x => x.id === p.id ? { ...x, monatsrechnung: v === 'ja' } : x))}>
            <SelectTrigger className="h-7 text-[11px]" data-testid={`profil-monatsrechnung-${p.id}`}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="ja">ja — LS provisorisch</SelectItem>
              <SelectItem value="nein">nein — bucht final</SelectItem>
            </SelectContent>
          </Select>
          {canEdit && p.id.startsWith('p-') ? (
            <button className="text-muted-foreground hover:text-destructive" title="Gelerntes Profil entfernen"
              onClick={() => save(profile.filter(x => x.id !== p.id))}>
              <X className="h-3.5 w-3.5" />
            </button>
          ) : <span />}
        </div>
      ))}
      <p className="text-[11px] text-muted-foreground pt-1">
        Erkennung über die MWST-Nr im PDF; Zuordnungen aus der Import-Vorschau erscheinen hier
        und sind jederzeit anpassbar. Konto/Kategorie/MwSt-Satz befüllen auch die manuelle Erfassung vor.
      </p>
    </div>
  );
}
