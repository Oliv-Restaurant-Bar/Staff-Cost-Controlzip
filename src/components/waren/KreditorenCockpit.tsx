/**
 * Lieferanten-Cockpit — Kreditoren-Abgleich als Vollständigkeits-Kontrollebene
 * ============================================================================
 * 1) Infoniqa Kreditoren-Personenkonto-Auszug (PDF) hochladen → Parser.
 * 2) Zuordnungs-Review: Auto-Vorschlag Waren ja/nein (40xx-Haben-Buchung),
 *    jeder Kreditor an-/abwählbar; «kein Waren» wird pro Mandant dauerhaft
 *    gemerkt (GastroSocial & Co. trotz 40xx-Buchung). Reine-div-Kreditoren
 *    (z.B. Rutishauser-DiVino = Wein) manuell als Waren taggbar.
 * 3) Cockpit: pro Waren-Lieferant Modell · Konto · Anzahl/Betrag Kreditor ↔
 *    erfasst · Differenz · Ampel. Der Auszug ändert NIE bestehende Rechnungen.
 * 4) Fehlende Rechnungen: opt-in-Übernahme (provisorisch, Vorschau, Undo).
 */
import { useMemo, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { toast } from 'sonner';
import { AlertTriangle, CheckCircle2, FileSearch, Loader2, RotateCcw, Upload } from 'lucide-react';
import type { TenantId } from '@/contexts/TenantContext';
import { extractPdfTextLines } from '@/lib/pdf-import-engine';
import {
  parseKreditorenAuszug, analysiereAuszug,
  type KreditorenAuszug, type KreditorAnalyse, type AbrechnungsModell,
} from '@/lib/kreditoren-parser';
import {
  loadKreditorZuordnung, saveKreditorZuordnung, zuordnungKey, abgleichKreditoren,
  buildUebernahmeEntry, loadKreditorIgnoriert, saveKreditorIgnoriert, ignoriertKey,
  supplierMatchesKreditor,
  type KreditorZuordnungMap, type KreditorIgnoriertMap, type AbgleichErgebnis, type BuchungMatch,
} from '@/lib/kreditoren-abgleich';
import {
  baueMonatsAbgleich, wendeMonatsrechnungAn, markiereDifferenzOffen,
  type MonatsAbgleichVorschau, type DifferenzModus,
} from '@/lib/waren-monatsabgleich';
import {
  loadMonthInvoices, saveMonthInvoices, loadWarenkonten, loadSupplierAliases,
  erstelleWarenImportSnapshot, saveWarenImportUndo, loadWarenImportUndo, undoWarenImport,
  type Warenkonto, type WarenImportUndoRecord,
} from '@/lib/waren-db';

const MODELL_LABEL: Record<AbrechnungsModell, string> = {
  monatsrechnung: 'Monatsrechnung (Dual)',
  halbmonatlich: 'Dual halbmonatlich',
  einzelrechnungen: 'Einzelrechnungen',
};

const chf = (n: number) => n.toLocaleString('de-CH', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const defaultVat = (konto: string) => ['4020', '4030', '4040', '4050'].includes(konto) ? 8.1 : 2.6;

/**
 * Eine Abgleich-Gruppe = ein Lieferant × Monat der Übernahme-Auswahl mit
 * vorhandenen provisorischen Lieferscheinen. Der User entscheidet:
 *  'anteilig' | 'rechnungsdatum' → Lieferscheine ERSETZEN (Σ = Monatsrechnung)
 *  'nicht'                      → Lieferscheine bleiben, Differenz offen,
 *                                 die Buchungen werden NICHT übernommen.
 */
interface AbgleichGruppe {
  key: string;             // `${monat}|${lieferant}`
  lieferant: string;
  monat: string;
  fehlendeKeys: string[];  // Auswahl-Zeilen dieser Gruppe
  totalGross: number;
  totalNet: number;
  rechnungsDatum: string;  // späteste Buchung
  referenz?: string;
  konto?: string;
  vatRate: number;
  vorschau: MonatsAbgleichVorschau;
  entscheid: DifferenzModus | 'nicht';
}

interface ReviewRow {
  analyse: KreditorAnalyse;
  waren: boolean;
  konto: string;
  modell: AbrechnungsModell;
  /** bereits früher bestätigt (aus gemerkter Zuordnung) */
  gemerkt: boolean;
}

export default function KreditorenCockpit({ tenantId, canCreate }: { tenantId: TenantId; canCreate: boolean }) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [auszug, setAuszug] = useState<KreditorenAuszug | null>(null);
  const [analysen, setAnalysen] = useState<KreditorAnalyse[]>([]);
  const [review, setReview] = useState<ReviewRow[] | null>(null);
  const [ergebnis, setErgebnis] = useState<AbgleichErgebnis | null>(null);
  const [warenkonten, setWarenkonten] = useState<Warenkonto[]>([]);
  const [undoRec, setUndoRec] = useState<WarenImportUndoRecord | null>(null);
  const [ignoriert, setIgnoriert] = useState<KreditorIgnoriertMap>({});
  // Übernahme-Vorschau: pro Buchung-Key { konto, vatRate, checked }
  const [uebernahme, setUebernahme] = useState<Record<string, { konto: string; vatRate: number; checked: boolean }> | null>(null);
  // Monatsabgleich-Schritt (Lieferschein → Monatsrechnung): Gruppen mit
  // provisorischen Lieferscheinen brauchen eine Entscheidung PRO LIEFERANT,
  // bevor die Übernahme schreibt — sonst wird der Monat verdoppelt.
  const [abgleich, setAbgleich] = useState<AbgleichGruppe[] | null>(null);

  // Eindeutiger Schlüssel pro fehlender Buchung: Index in der fehlende-Liste
  // (gleicher Tag/Betrag/Referenz darf NIE kollidieren — sonst teilen sich
  // zwei echte Buchungen Auswahl-State und eine Aktion übernimmt beide).

  // ── Upload + Parse ─────────────────────────────────────────────────────────
  const onFile = async (f: File) => {
    if (!canCreate) { toast.error('Keine Berechtigung zum Erstellen von Einträgen.'); return; }
    setBusy(true);
    try {
      const { lines, warnings } = await extractPdfTextLines(await f.arrayBuffer());
      const az = parseKreditorenAuszug(lines);
      for (const w of [...warnings, ...az.warnings]) console.warn('[KREDITOREN]', w);
      if (az.debug.failureReason) { toast.error(az.debug.failureReason); return; }
      // Strikte Mandanten-Wache: fail-closed — ohne positiv erkannte Firma
      // wird der Auszug NICHT akzeptiert (nie in den falschen Mandanten laden).
      if (az.mandant !== tenantId) {
        toast.error(az.mandant
          ? `Dieser Auszug gehört zu «${az.firma}» — aktiver Mandant ist ${tenantId}. Bitte Mandant wechseln.`
          : `Firma im Auszug nicht erkannt («${az.firma ?? '—'}») — Import abgelehnt (Mandanten-Schutz).`);
        return;
      }
      if (!az.vonDatum || !az.bisDatum) { toast.error('Zeitraum («Auszug vom … bis …») nicht erkannt.'); return; }
      const an = analysiereAuszug(az);
      const zu = await loadKreditorZuordnung(tenantId);
      const wk = await loadWarenkonten(tenantId);
      setWarenkonten(wk);
      setAuszug(az);
      setAnalysen(an);
      setErgebnis(null);
      setUebernahme(null);
      setUndoRec(await loadWarenImportUndo(tenantId, 'kreditoren'));
      setIgnoriert(await loadKreditorIgnoriert(tenantId));
      // Review-Zeilen: gemerkte Zuordnung vorbelegen, sonst Auto-Vorschlag
      setReview(an
        .filter(a => a.rechnungen.length > 0)
        .map(a => {
          const z = zu[zuordnungKey(a.kreditor.name)];
          return {
            analyse: a,
            waren: z ? z.waren : a.warenVorschlag,
            konto: z?.konto ?? a.standardKontoVorschlag ?? '4060',
            modell: z?.modell ?? a.modellVorschlag,
            gemerkt: !!z,
          };
        }));
      toast.success(`${az.kreditoren.length} Kreditoren gelesen (${az.vonDatum} – ${az.bisDatum}).`);
    } catch (e) {
      console.error('[KREDITOREN] Upload:', e);
      toast.error(`PDF konnte nicht gelesen werden: ${String(e)}`);
    } finally { setBusy(false); }
  };

  // ── Zuordnung bestätigen + Abgleich ───────────────────────────────────────
  const bestaetigen = async () => {
    if (!review || !auszug) return;
    if (!canCreate) { toast.error('Keine Berechtigung zum Erstellen von Einträgen.'); return; }
    setBusy(true);
    try {
      const zu: KreditorZuordnungMap = await loadKreditorZuordnung(tenantId);
      const now = new Date().toISOString();
      for (const r of review) {
        zu[zuordnungKey(r.analyse.kreditor.name)] = {
          waren: r.waren,
          konto: r.waren ? r.konto : undefined,
          modell: r.waren ? r.modell : undefined,
          bestaetigt: now,
        };
      }
      await saveKreditorZuordnung(tenantId, zu);
      const erg = await abgleichKreditoren(tenantId, analysen, zu, auszug.vonDatum!, auszug.bisDatum!, ignoriert);
      setErgebnis(erg);
      toast.success(`Zuordnung gespeichert — ${erg.zeilen.length} Waren-Lieferanten abgeglichen.`);
    } catch (e) {
      console.error('[KREDITOREN] Abgleich:', e);
      toast.error(`Abgleich fehlgeschlagen: ${String(e)}`);
    } finally { setBusy(false); }
  };

  // ── Übernahme (Vorschau → Schreiben mit Undo) ─────────────────────────────
  // Neben 'fehlt' auch 'provisorisch' anbieten: genau dort greift der
  // Monatsabgleich (Monatsrechnung ERSETZT erfasste Lieferscheine). Solche
  // Zeilen werden aber NIE direkt gebucht — nur über eine Abgleich-Gruppe
  // (sonst würde die Buchung zum bereits erfassten Eintrag addiert).
  const fehlende = useMemo(() => {
    if (!ergebnis) return [] as { key: string; zeileName: string; match: BuchungMatch; konto: string; status: 'fehlt' | 'provisorisch' }[];
    return ergebnis.zeilen.flatMap(z =>
      z.matches.filter(m => m.status === 'fehlt' || m.status === 'provisorisch')
        .map(m => ({
          zeileName: z.kreditorName, match: m, status: m.status as 'fehlt' | 'provisorisch',
          konto: (m.buchung.gKonto !== 'div' ? m.buchung.gKonto : z.zuordnung.konto) || z.zuordnung.konto || '4060',
        })))
      .map((f, i) => ({ ...f, key: `f${i}|${f.zeileName}|${f.match.buchung.datum}` }));
  }, [ergebnis]);

  const openUebernahme = (nur?: BuchungMatch) => {
    if (!canCreate) { toast.error('Keine Berechtigung zum Erstellen von Einträgen.'); return; }
    const map: Record<string, { konto: string; vatRate: number; checked: boolean }> = {};
    for (const f of fehlende) {
      // 'provisorisch' (Lieferschein bereits erfasst) standardmässig NICHT
      // vorangekreuzt — der User wählt sie bewusst für den Monatsabgleich.
      map[f.key] = {
        konto: f.konto, vatRate: defaultVat(f.konto),
        checked: nur ? f.match === nur : f.status === 'fehlt',
      };
    }
    setUebernahme(map);
  };

  /**
   * Schritt 1 der Übernahme: prüfen, ob für Lieferant×Monat der Auswahl
   * provisorische Lieferscheine erfasst sind. Wenn ja → Monatsabgleich-Dialog
   * (Entscheidung pro Lieferant), sonst direkt schreiben.
   */
  const uebernehmen = async () => {
    if (!uebernahme || !ergebnis) return;
    if (!canCreate) { toast.error('Keine Berechtigung zum Erstellen von Einträgen.'); return; }
    const auswahl = fehlende.filter(f => uebernahme[f.key]?.checked);
    if (auswahl.length === 0) { toast.error('Nichts ausgewählt.'); return; }
    setBusy(true);
    try {
      const gruppenMap = new Map<string, typeof auswahl>();
      for (const f of auswahl) {
        const key = `${f.match.monat}|${f.zeileName}`;
        gruppenMap.set(key, [...(gruppenMap.get(key) ?? []), f]);
      }
      const bestandByMonat = new Map<string, Awaited<ReturnType<typeof loadMonthInvoices>>>();
      for (const m of [...new Set(auswahl.map(f => f.match.monat))]) {
        bestandByMonat.set(m, await loadMonthInvoices(tenantId, m));
      }
      // Dieselben Aliasse wie der Kreditorenabgleich — sonst öffnet der
      // Monatsabgleich für Alias-Lieferanten nicht und es würde verdoppelt.
      const aliases = await loadSupplierAliases(tenantId);
      const gruppen: AbgleichGruppe[] = [];
      for (const [key, fs] of gruppenMap) {
        const [monat, lieferant] = [fs[0].match.monat, fs[0].zeileName];
        const totalGross = fs.reduce((s, f) => s + f.match.buchung.betrag, 0);
        const totalNet = fs.reduce((s, f) => {
          const rate = uebernahme[f.key].vatRate;
          return s + Math.round((f.match.buchung.betrag / (1 + rate / 100)) * 100) / 100;
        }, 0);
        const vorschau = baueMonatsAbgleich({
          bestand: bestandByMonat.get(monat) ?? [], monat, totalNet, totalGross,
          matcht: name => supplierMatchesKreditor(name, lieferant, aliases),
        });
        if (vorschau.lieferscheine.length === 0) continue;
        const datums = fs.map(f => f.match.buchung.datum).sort();
        gruppen.push({
          key, lieferant, monat, fehlendeKeys: fs.map(f => f.key),
          totalGross: Math.round(totalGross * 100) / 100,
          totalNet: Math.round(totalNet * 100) / 100,
          rechnungsDatum: datums[datums.length - 1],
          referenz: fs.map(f => f.match.buchung.referenz).filter(Boolean).join(', ') || undefined,
          konto: uebernahme[fs[0].key].konto, vatRate: uebernahme[fs[0].key].vatRate,
          vorschau, entscheid: 'anteilig',
        });
      }
      if (gruppen.length > 0) { setAbgleich(gruppen); setBusy(false); return; }
      await schreibeUebernahme(auswahl, []);
    } catch (e) {
      console.error('[KREDITOREN] Übernahme:', e);
      toast.error(`Übernahme fehlgeschlagen: ${String(e)}`);
      setBusy(false);
    }
  };

  /**
   * Schritt 2: schreiben. Gruppen mit Abgleich-Entscheidung ersetzen ihre
   * Lieferscheine (bzw. markieren «Differenz offen» und übernehmen NICHTS);
   * alle übrigen Auswahl-Zeilen werden wie bisher als provisorische
   * Kreditoren-Übernahme angelegt. Lieferscheine werden dabei NIE doppelt
   * addiert — die Monatsrechnung ERSETZT sie.
   */
  const schreibeUebernahme = async (
    auswahl: typeof fehlende,
    entschieden: AbgleichGruppe[],
  ) => {
    if (!uebernahme) return;
    setBusy(true);
    try {
      const abgedeckt = new Set(entschieden.flatMap(g => g.fehlendeKeys));
      // 'provisorisch'-Zeilen dürfen NIE direkt gebucht werden (ihr Gegenstück
      // ist bereits erfasst) — nur echte 'fehlt'-Zeilen ausserhalb der Gruppen.
      const direkt = auswahl.filter(f => !abgedeckt.has(f.key) && f.status === 'fehlt');
      const uebersprungen: string[] = auswahl
        .filter(f => !abgedeckt.has(f.key) && f.status === 'provisorisch')
        .map(f => f.zeileName);
      const nachtraeglichDirekt: typeof auswahl = [];
      const monate = [...new Set([...auswahl.map(f => f.match.monat), ...entschieden.map(g => g.monat)])];
      const vorher = await erstelleWarenImportSnapshot(tenantId, { monate });
      const aliases = await loadSupplierAliases(tenantId);
      const now = new Date().toISOString();
      let uebernommen = 0;
      const proKey = new Map(auswahl.map(f => [f.key, f]));
      for (const m of monate) {
        let liste = await loadMonthInvoices(tenantId, m);
        for (const g of entschieden.filter(x => x.monat === m)) {
          // Stale-Schutz: Vorschau gegen den FRISCH geladenen Bestand neu rechnen.
          const vorschau = baueMonatsAbgleich({
            bestand: liste, monat: m, totalNet: g.totalNet, totalGross: g.totalGross,
            matcht: name => supplierMatchesKreditor(name, g.lieferant, aliases),
          });
          if (vorschau.lieferscheine.length === 0) {
            // Fail-closed: Lieferscheine inzwischen weg/finalisiert → nichts
            // ersetzen. 'fehlt'-Zeilen der Gruppe regulär direkt buchen,
            // 'provisorisch'-Zeilen überspringen (nie blind addieren).
            for (const key of g.fehlendeKeys) {
              const f = proKey.get(key);
              if (!f) continue;
              if (f.status === 'fehlt') nachtraeglichDirekt.push(f);
              else uebersprungen.push(f.zeileName);
            }
            continue;
          }
          if (g.entscheid === 'nicht') {
            liste = markiereDifferenzOffen(liste, vorschau.lieferscheine, now);
            continue; // Buchungen NICHT übernehmen — Lieferscheine bleiben massgeblich
          }
          liste = wendeMonatsrechnungAn({
            bestand: liste, vorschau, modus: g.entscheid, now,
            rechnung: {
              datum: g.rechnungsDatum, referenz: g.referenz,
              totalNet: g.totalNet, totalGross: g.totalGross,
              warenkonto: g.konto, vatRate: g.vatRate,
            },
          });
          uebernommen += 1;
        }
        for (const f of [...direkt, ...nachtraeglichDirekt.filter(x => !direkt.includes(x))].filter(x => x.match.monat === m)) {
          const cfg = uebernahme[f.key];
          liste.push(buildUebernahmeEntry({
            kreditorName: f.zeileName, buchung: f.match.buchung, konto: cfg.konto, vatRate: cfg.vatRate,
          }, now));
          uebernommen += 1;
        }
        await saveMonthInvoices(tenantId, m, liste);
      }
      const nachher = await erstelleWarenImportSnapshot(tenantId, { monate });
      const rec: WarenImportUndoRecord = {
        typ: 'kreditoren', zeitpunkt: now, label: 'Kreditoren-Übernahme',
        anzahlRechnungen: uebernommen, vorher, nachher,
      };
      await saveWarenImportUndo(tenantId, rec);
      setUndoRec(rec);
      setUebernahme(null);
      setAbgleich(null);
      // Abgleich neu rechnen
      const zu = await loadKreditorZuordnung(tenantId);
      setErgebnis(await abgleichKreditoren(tenantId, analysen, zu, auszug!.vonDatum!, auszug!.bisDatum!, ignoriert));
      const offen = entschieden.filter(g => g.entscheid === 'nicht').length;
      toast.success(`${uebernommen} Rechnung(en) übernommen.${offen ? ` ${offen} Lieferant(en) als «Differenz offen» markiert.` : ''}`);
      if (uebersprungen.length > 0) {
        toast.info(`Übersprungen (bereits erfasst, kein Lieferschein zum Ersetzen): ${[...new Set(uebersprungen)].join(', ')}`);
      }
    } catch (e) {
      console.error('[KREDITOREN] Übernahme:', e);
      toast.error(`Übernahme fehlgeschlagen: ${String(e)}`);
    } finally { setBusy(false); }
  };

  const undo = async () => {
    if (!canCreate) { toast.error('Keine Berechtigung zum Erstellen von Einträgen.'); return; }
    setBusy(true);
    try {
      await undoWarenImport(tenantId, 'kreditoren');
      setUndoRec(null);
      if (auszug && ergebnis) {
        const zu = await loadKreditorZuordnung(tenantId);
        setErgebnis(await abgleichKreditoren(tenantId, analysen, zu, auszug.vonDatum!, auszug.bisDatum!, ignoriert));
      }
      toast.success('Kreditoren-Übernahme rückgängig gemacht.');
    } catch (e) {
      toast.error(String(e instanceof Error ? e.message : e));
    } finally { setBusy(false); }
  };

  // ── Ignorieren («kein Wareneinkauf») ──────────────────────────────────────
  const markiereIgnoriert = async (zeileName: string, match: BuchungMatch) => {
    if (!canCreate) { toast.error('Keine Berechtigung.'); return; }
    const notiz = window.prompt('Als «kein Wareneinkauf» ignorieren — Notiz (optional, z.B. «Bonus»):', '');
    if (notiz === null) return; // abgebrochen
    setBusy(true);
    try {
      const map = { ...(await loadKreditorIgnoriert(tenantId)) };
      map[ignoriertKey(zeileName, match.buchung)] = {
        kreditorName: zeileName,
        datum: match.buchung.datum,
        betrag: match.buchung.betrag,
        referenz: match.buchung.referenz ?? undefined,
        notiz: notiz.trim() || undefined,
        markiert: new Date().toISOString(),
      };
      await saveKreditorIgnoriert(tenantId, map);
      setIgnoriert(map);
      // Vorschau schliessen (Keys/Indices ändern sich) + Abgleich neu rechnen
      setUebernahme(null);
      if (auszug) {
        const zu = await loadKreditorZuordnung(tenantId);
        setErgebnis(await abgleichKreditoren(tenantId, analysen, zu, auszug.vonDatum!, auszug.bisDatum!, map));
      }
      toast.success(`Buchung ${match.buchung.datum} / ${chf(match.buchung.betrag)} wird dauerhaft ignoriert (kein Wareneinkauf).`);
    } catch (e) {
      toast.error(`Ignorieren fehlgeschlagen: ${String(e)}`);
    } finally { setBusy(false); }
  };

  const zuruecknehmen = async (zeileName: string, match: BuchungMatch) => {
    if (!canCreate) { toast.error('Keine Berechtigung.'); return; }
    setBusy(true);
    try {
      const map = { ...(await loadKreditorIgnoriert(tenantId)) };
      delete map[ignoriertKey(zeileName, match.buchung)];
      await saveKreditorIgnoriert(tenantId, map);
      setIgnoriert(map);
      if (auszug) {
        const zu = await loadKreditorZuordnung(tenantId);
        setErgebnis(await abgleichKreditoren(tenantId, analysen, zu, auszug.vonDatum!, auszug.bisDatum!, map));
      }
      toast.success('Ignorieren zurückgenommen — Buchung zählt wieder im Abgleich.');
    } catch (e) {
      toast.error(`Zurücknehmen fehlgeschlagen: ${String(e)}`);
    } finally { setBusy(false); }
  };

  const ignorierteMatches = useMemo(() => {
    if (!ergebnis) return [] as { zeileName: string; match: BuchungMatch }[];
    return ergebnis.zeilen.flatMap(z =>
      z.matches.filter(m => m.status === 'ignoriert').map(m => ({ zeileName: z.kreditorName, match: m })));
  }, [ergebnis]);

  const kontoOptions = warenkonten.length > 0 ? warenkonten : [];

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center gap-3">
        <input ref={fileRef} type="file" accept=".pdf" className="hidden"
          onChange={e => { const f = e.target.files?.[0]; if (f) void onFile(f); e.target.value = ''; }} />
        <Button onClick={() => fileRef.current?.click()} disabled={busy || !canCreate} data-testid="button-kreditoren-upload">
          {busy ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <Upload className="h-4 w-4 mr-2" />}
          Kreditoren-Auszug (PDF) hochladen
        </Button>
        {auszug && (
          <span className="text-sm text-muted-foreground">
            {auszug.firma} · {auszug.vonDatum} – {auszug.bisDatum} · {auszug.kreditoren.length} Kreditoren
          </span>
        )}
        {undoRec && (
          <Button variant="outline" size="sm" onClick={() => void undo()} disabled={busy} data-testid="button-kreditoren-undo">
            <RotateCcw className="h-3.5 w-3.5 mr-1.5" />
            Übernahme rückgängig ({undoRec.anzahlRechnungen})
          </Button>
        )}
      </div>

      {!auszug && (
        <p className="text-sm text-muted-foreground">
          Der Infoniqa-Personenkonto-Auszug dient als Kontrollebene über alle Lieferanten:
          er zeigt Vollständigkeit und Abrechnungsmodell je Waren-Lieferant und schlägt fehlende
          Rechnungen zur Übernahme vor. Bestehende Warenrechnungen werden nie verändert.
        </p>
      )}

      {/* ── Schritt 2: Zuordnungs-Review ── */}
      {review && !ergebnis && (
        <div className="border border-border rounded-lg p-4 space-y-3">
          <div className="flex items-center justify-between">
            <h3 className="font-semibold text-sm">Waren-Lieferanten bestätigen</h3>
            <Button size="sm" onClick={() => void bestaetigen()} disabled={busy} data-testid="button-kreditoren-bestaetigen">
              <CheckCircle2 className="h-4 w-4 mr-1.5" />Zuordnung speichern & abgleichen
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">
            Auto-Vorschlag: mind. eine Haben-Buchung auf ein Warenkonto (4000–4070/4090). Der Vorschlag ist
            nur ein Vorschlag — Falsch-Positive (z.B. AHV auf 4060) hier abwählen, reine «div»-Lieferanten
            (z.B. Wein) manuell als Waren taggen. Die Zuordnung wird pro Mandant gemerkt.
          </p>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs text-muted-foreground border-b border-border">
                  <th className="py-1.5 pr-2">Waren</th>
                  <th className="py-1.5 pr-2">Kreditor</th>
                  <th className="py-1.5 pr-2">Rechnungen</th>
                  <th className="py-1.5 pr-2 text-right">Summe brutto</th>
                  <th className="py-1.5 pr-2">Konten</th>
                  <th className="py-1.5 pr-2">Standard-Konto</th>
                  <th className="py-1.5">Modell</th>
                </tr>
              </thead>
              <tbody>
                {review.map((r, i) => (
                  <tr key={r.analyse.kreditor.nr} className={cn('border-b border-border/50', r.analyse.nurDiv && !r.waren && 'bg-amber-500/5')}>
                    <td className="py-1.5 pr-2">
                      <input type="checkbox" checked={r.waren}
                        data-testid={`checkbox-kreditor-waren-${r.analyse.kreditor.nr}`}
                        onChange={e => setReview(rs => rs!.map((x, j) => j === i ? { ...x, waren: e.target.checked } : x))} />
                    </td>
                    <td className="py-1.5 pr-2 font-medium">
                      {r.analyse.kreditor.name}
                      {r.analyse.nurDiv && <span className="ml-1.5 text-[10px] text-amber-600 border border-amber-500/40 rounded px-1">nur div — prüfen</span>}
                      {r.gemerkt && <span className="ml-1.5 text-[10px] text-muted-foreground border border-border rounded px-1">gemerkt</span>}
                    </td>
                    <td className="py-1.5 pr-2">{r.analyse.rechnungen.length}</td>
                    <td className="py-1.5 pr-2 text-right font-mono">{chf(r.analyse.habenSumme)}</td>
                    <td className="py-1.5 pr-2 text-xs text-muted-foreground">
                      {[...Object.keys(r.analyse.kontoCounts), ...(r.analyse.hatDiv ? ['div'] : [])].join(' + ') || '—'}
                    </td>
                    <td className="py-1.5 pr-2">
                      {r.waren && (
                        <select className="bg-background border border-border rounded px-1.5 py-0.5 text-xs" value={r.konto}
                          onChange={e => setReview(rs => rs!.map((x, j) => j === i ? { ...x, konto: e.target.value } : x))}>
                          {[...new Set([r.konto, ...kontoOptions.map(k => k.value)])].map(k =>
                            <option key={k} value={k}>{kontoOptions.find(o => o.value === k)?.label ?? k}</option>)}
                        </select>
                      )}
                    </td>
                    <td className="py-1.5">
                      {r.waren && (
                        <select className="bg-background border border-border rounded px-1.5 py-0.5 text-xs" value={r.modell}
                          onChange={e => setReview(rs => rs!.map((x, j) => j === i ? { ...x, modell: e.target.value as AbrechnungsModell } : x))}>
                          {(Object.keys(MODELL_LABEL) as AbrechnungsModell[]).map(m => <option key={m} value={m}>{MODELL_LABEL[m]}</option>)}
                        </select>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* ── Schritt 3: Cockpit ── */}
      {ergebnis && (
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <h3 className="font-semibold text-sm flex items-center gap-2">
              <FileSearch className="h-4 w-4" />Vollständigkeits-Checkliste ({ergebnis.zeilen.length} Waren-Lieferanten · Toleranz ±{chf(ergebnis.toleranz)})
            </h3>
            <div className="flex gap-2">
              <Button variant="outline" size="sm" onClick={() => setErgebnis(null)}>Zuordnung anpassen</Button>
              {fehlende.length > 0 && (
                <Button size="sm" onClick={() => openUebernahme()} data-testid="button-alle-uebernehmen">
                  Alle fehlenden übernehmen… ({fehlende.length})
                </Button>
              )}
            </div>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs text-muted-foreground border-b border-border">
                  <th className="py-1.5 pr-2">Status</th>
                  <th className="py-1.5 pr-2">Lieferant</th>
                  <th className="py-1.5 pr-2">Modell</th>
                  <th className="py-1.5 pr-2">Konto</th>
                  <th className="py-1.5 pr-2 text-right">Kreditor ↔ erfasst</th>
                  <th className="py-1.5 pr-2 text-right">Betrag Kreditor</th>
                  <th className="py-1.5 pr-2 text-right">erfasst (brutto)</th>
                  <th className="py-1.5 pr-2 text-right">Differenz</th>
                  <th className="py-1.5" />
                </tr>
              </thead>
              <tbody>
                {ergebnis.zeilen.map(z => (
                  <tr key={z.kreditorName} className="border-b border-border/50" data-testid={`row-cockpit-${z.kreditorName}`}>
                    <td className="py-1.5 pr-2">
                      <span className={cn('inline-block h-2.5 w-2.5 rounded-full',
                        z.ampel === 'gruen' ? 'bg-emerald-500' : z.ampel === 'gelb' ? 'bg-amber-500' : 'bg-red-500')} />
                    </td>
                    <td className={cn('py-1.5 pr-2 font-medium', z.anzahlFehlt > 0 && 'text-red-600 dark:text-red-400')}>{z.kreditorName}</td>
                    <td className="py-1.5 pr-2 text-xs">{z.zuordnung.modell ? MODELL_LABEL[z.zuordnung.modell] : '—'}</td>
                    <td className="py-1.5 pr-2 text-xs">{z.zuordnung.konto ?? '—'}</td>
                    <td className="py-1.5 pr-2 text-right font-mono">
                      {z.anzahlKreditor} ↔ {z.anzahlErfasst}
                      {z.anzahlProvisorisch > 0 && <span className="text-amber-600"> (+{z.anzahlProvisorisch} prov.)</span>}
                      {z.anzahlIgnoriert > 0 && <span className="text-muted-foreground"> ({z.anzahlIgnoriert} ign.)</span>}
                    </td>
                    <td className="py-1.5 pr-2 text-right font-mono">{chf(z.summeKreditor)}</td>
                    <td className="py-1.5 pr-2 text-right font-mono">{z.summeErfasst > 0 ? chf(z.summeErfasst) : '—'}</td>
                    <td className={cn('py-1.5 pr-2 text-right font-mono', (z.differenz ?? 0) > ergebnis.toleranz && 'text-red-600 dark:text-red-400 font-semibold')}>
                      {z.differenz === null ? '—' : chf(z.differenz)}
                    </td>
                    <td className="py-1.5 text-right">
                      {z.anzahlFehlt > 0 && (
                        <Button variant="outline" size="sm" className="h-6 text-xs"
                          onClick={() => openUebernahme(z.matches.find(m => m.status === 'fehlt'))}
                          data-testid={`button-uebernehmen-${z.kreditorName}`}>
                          Übernehmen… ({z.anzahlFehlt})
                        </Button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {ergebnis.zeilen.length === 0 && (
            <p className="text-sm text-muted-foreground">Keine Waren-Lieferanten in der Zuordnung — Zuordnung anpassen.</p>
          )}

          {/* ── Ignorierte Buchungen (kein Wareneinkauf) ── */}
          {ignorierteMatches.length > 0 && (
            <details className="border border-border rounded-lg" data-testid="details-kreditoren-ignoriert">
              <summary className="cursor-pointer px-4 py-2 text-sm font-medium text-muted-foreground">
                Ignoriert – kein Wareneinkauf ({ignorierteMatches.length})
              </summary>
              <div className="px-4 pb-3 overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-left text-xs text-muted-foreground border-b border-border">
                      <th className="py-1.5 pr-2">Lieferant</th>
                      <th className="py-1.5 pr-2">Datum</th>
                      <th className="py-1.5 pr-2">Referenz</th>
                      <th className="py-1.5 pr-2 text-right">Betrag</th>
                      <th className="py-1.5 pr-2">Notiz</th>
                      <th className="py-1.5" />
                    </tr>
                  </thead>
                  <tbody>
                    {ignorierteMatches.map(({ zeileName, match }, i) => (
                      <tr key={`ign${i}`} className="border-b border-border/50">
                        <td className="py-1.5 pr-2">{zeileName}</td>
                        <td className="py-1.5 pr-2 font-mono text-xs">{match.buchung.datum}</td>
                        <td className="py-1.5 pr-2 font-mono text-xs">{match.buchung.referenz ?? '—'}</td>
                        <td className="py-1.5 pr-2 text-right font-mono">{chf(match.buchung.betrag)}</td>
                        <td className="py-1.5 pr-2 text-xs text-muted-foreground">{match.notiz ?? '—'}</td>
                        <td className="py-1.5 text-right">
                          <Button variant="ghost" size="sm" className="h-6 text-xs" disabled={busy}
                            onClick={() => void zuruecknehmen(zeileName, match)}
                            data-testid={`button-ignoriert-zurueck-${i}`}>
                            Zurücknehmen
                          </Button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </details>
          )}
        </div>
      )}

      {/* ── Übernahme-Vorschau ── */}
      {uebernahme && (
        <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4" onClick={() => setUebernahme(null)}>
          <div className="bg-background border border-border rounded-lg max-w-3xl w-full max-h-[80vh] overflow-y-auto p-4 space-y-3" onClick={e => e.stopPropagation()}>
            <h3 className="font-semibold text-sm flex items-center gap-2">
              <AlertTriangle className="h-4 w-4 text-amber-500" />
              Fehlende Rechnungen übernehmen (provisorisch)
            </h3>
            <p className="text-xs text-muted-foreground">
              Angelegt wird je eine provisorische Warenrechnung (Herkunft «Kreditoren-Übernahme») — eine später
              hochgeladene Original-Rechnung kann sie gemäss Dual-Modell finalisieren. Betrag inkl. MwSt aus dem
              Kreditor (unveränderbar); Konto und MwSt-Satz anpassbar.
            </p>
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs text-muted-foreground border-b border-border">
                  <th className="py-1.5 pr-2" /><th className="py-1.5 pr-2">Lieferant</th><th className="py-1.5 pr-2">Datum</th>
                  <th className="py-1.5 pr-2">Referenz</th><th className="py-1.5 pr-2">Konto</th><th className="py-1.5 pr-2">MwSt %</th>
                  <th className="py-1.5 text-right">Betrag inkl. MwSt</th>
                  <th className="py-1.5" />
                </tr>
              </thead>
              <tbody>
                {fehlende.map(f => {
                  const k = f.key;
                  const cfg = uebernahme[k];
                  if (!cfg) return null;
                  return (
                    <tr key={k} className="border-b border-border/50">
                      <td className="py-1.5 pr-2">
                        <input type="checkbox" checked={cfg.checked}
                          onChange={e => setUebernahme(u => ({ ...u!, [k]: { ...cfg, checked: e.target.checked } }))} />
                      </td>
                      <td className="py-1.5 pr-2">{f.zeileName}
                        {f.status === 'provisorisch' && (
                          <span className="ml-1.5 inline-block rounded bg-amber-500/15 px-1 py-0.5 text-[10px] text-amber-600 dark:text-amber-400"
                            title="Lieferschein(e) bereits erfasst — Übernahme läuft über den Monatsabgleich (ersetzen, nie addieren)">
                            Lieferschein erfasst
                          </span>
                        )}
                      </td>
                      <td className="py-1.5 pr-2 font-mono text-xs">{f.match.buchung.datum}</td>
                      <td className="py-1.5 pr-2 font-mono text-xs">{f.match.buchung.referenz ?? f.match.buchung.blg ?? '—'}</td>
                      <td className="py-1.5 pr-2">
                        <select className="bg-background border border-border rounded px-1.5 py-0.5 text-xs" value={cfg.konto}
                          onChange={e => setUebernahme(u => ({ ...u!, [k]: { ...cfg, konto: e.target.value, vatRate: defaultVat(e.target.value) } }))}>
                          {[...new Set([cfg.konto, ...kontoOptions.map(o => o.value)])].map(kk => <option key={kk} value={kk}>{kk}</option>)}
                        </select>
                      </td>
                      <td className="py-1.5 pr-2">
                        <select className="bg-background border border-border rounded px-1.5 py-0.5 text-xs" value={cfg.vatRate}
                          onChange={e => setUebernahme(u => ({ ...u!, [k]: { ...cfg, vatRate: Number(e.target.value) } }))}>
                          {[2.6, 8.1, 3.8, 0].map(v => <option key={v} value={v}>{v}</option>)}
                        </select>
                      </td>
                      <td className="py-1.5 text-right font-mono">{chf(f.match.buchung.betrag)}</td>
                      <td className="py-1.5 pl-2 text-right">
                        <Button variant="ghost" size="sm" className="h-6 text-xs text-muted-foreground" disabled={busy}
                          title="Als «kein Wareneinkauf» markieren (Bonus, Korrektur, Pfand …) — wird dauerhaft ignoriert"
                          onClick={() => void markiereIgnoriert(f.zeileName, f.match)}
                          data-testid={`button-ignorieren-${f.key}`}>
                          Kein Wareneinkauf
                        </Button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            <div className="flex justify-end gap-2">
              <Button variant="outline" size="sm" onClick={() => setUebernahme(null)}>Abbrechen</Button>
              <Button size="sm" onClick={() => void uebernehmen()} disabled={busy} data-testid="button-uebernahme-bestaetigen">
                {busy && <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />}
                {Object.values(uebernahme).filter(c => c.checked).length} Rechnung(en) übernehmen
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* ── Monatsabgleich: Lieferschein → Monatsrechnung (pro Lieferant) ── */}
      {abgleich && uebernahme && (
        <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4" onClick={() => setAbgleich(null)}>
          <div className="bg-background border border-border rounded-lg max-w-3xl w-full max-h-[80vh] overflow-y-auto p-4 space-y-3"
            onClick={e => e.stopPropagation()} data-testid="dialog-monatsabgleich">
            <h3 className="font-semibold text-sm flex items-center gap-2">
              <AlertTriangle className="h-4 w-4 text-amber-500" />
              Monatsabgleich: Lieferscheine sind bereits erfasst
            </h3>
            <p className="text-xs text-muted-foreground">
              Für diese Lieferanten sind provisorische Lieferscheine erfasst. «Übernehmen» ERSETZT die
              Lieferscheine durch die Monatsrechnung (der Monat entspricht danach exakt der Buchhaltung —
              es wird NIE addiert). Die Differenz (Rabatt, fehlender/doppelter Lieferschein, Preiskorrektur,
              Retoure) wird anteilig auf die Lieferdaten verteilt oder aufs Rechnungsdatum gebucht.
              «Nicht übernehmen» lässt die Lieferscheine stehen und markiert die Differenz als offen.
            </p>
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs text-muted-foreground border-b border-border">
                  <th className="py-1.5 pr-2">Lieferant</th><th className="py-1.5 pr-2">Monat</th>
                  <th className="py-1.5 pr-2 text-right">Σ Lieferscheine</th>
                  <th className="py-1.5 pr-2 text-right">Monatsrechnung</th>
                  <th className="py-1.5 pr-2 text-right">Differenz</th>
                  <th className="py-1.5">Entscheidung</th>
                </tr>
              </thead>
              <tbody>
                {abgleich.map(g => (
                  <tr key={g.key} className="border-b border-border/50 align-top" data-testid={`row-abgleich-${g.key}`}>
                    <td className="py-1.5 pr-2">{g.lieferant}
                      <div className="text-xs text-muted-foreground">{g.vorschau.lieferscheine.length} Lieferschein(e)</div>
                    </td>
                    <td className="py-1.5 pr-2 font-mono text-xs">{g.monat}</td>
                    <td className="py-1.5 pr-2 text-right font-mono">{chf(g.vorschau.sigmaGross)}</td>
                    <td className="py-1.5 pr-2 text-right font-mono">{chf(g.totalGross)}</td>
                    <td className={cn('py-1.5 pr-2 text-right font-mono',
                      Math.abs(g.vorschau.differenzGross) > 0.05 ? 'text-amber-600 dark:text-amber-400' : 'text-muted-foreground')}>
                      {chf(g.vorschau.differenzGross)}
                    </td>
                    <td className="py-1.5">
                      <select className="bg-background border border-border rounded px-1.5 py-0.5 text-xs w-full max-w-[240px]"
                        value={g.entscheid}
                        data-testid={`select-abgleich-${g.key}`}
                        onChange={e => setAbgleich(a => a!.map(x => x.key === g.key
                          ? { ...x, entscheid: e.target.value as AbgleichGruppe['entscheid'] } : x))}>
                        <option value="anteilig">Übernehmen — Differenz anteilig auf Lieferdaten</option>
                        <option value="rechnungsdatum">Übernehmen — Differenz aufs Rechnungsdatum</option>
                        <option value="nicht">Nicht übernehmen — Differenz offen lassen</option>
                      </select>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="flex justify-end gap-2">
              <Button variant="outline" size="sm" onClick={() => setAbgleich(null)} disabled={busy}>Zurück</Button>
              <Button size="sm" disabled={busy} data-testid="button-abgleich-bestaetigen"
                onClick={() => void schreibeUebernahme(fehlende.filter(f => uebernahme[f.key]?.checked), abgleich)}>
                {busy && <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />}
                Bestätigen & schreiben
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
