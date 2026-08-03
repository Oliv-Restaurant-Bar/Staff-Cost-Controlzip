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
  type LieferantenProfil,
} from '@/lib/lieferanten-profile';
import { kernImportiereFsRechnungen, type FsImportRechnung } from '@/lib/fs-import';
import {
  loadSuppliers, saveSuppliers, kategorieFromKonto,
  erstelleWarenImportSnapshot, saveWarenImportUndo,
} from '@/lib/waren-db';
import { WarenImportUndoButton } from '@/components/waren/WarenCsvImport';
import type { ParsedCsvRechnung } from '@/lib/waren-positionen';
import type { TenantId } from '@/contexts/TenantContext';

interface VorschauZeile {
  fileName: string;
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
}

function num(s: string): number | null {
  const n = Number(s.replace(/[’'\s]/g, '').replace(',', '.'));
  return Number.isFinite(n) ? n : null;
}

const R2 = (n: number) => Math.round(n * 100) / 100;

export function BeaulieuPdfImport({ tenantId, onImported }: {
  tenantId: TenantId; onImported: () => void;
}) {
  const [profile, setProfile] = useState<LieferantenProfil[]>([]);
  const [zeilen, setZeilen] = useState<VorschauZeile[]>([]);
  const [busy, setBusy] = useState(false);
  const [undoRefresh, setUndoRefresh] = useState(0);

  useEffect(() => {
    let alive = true;
    loadLieferantenProfile(tenantId).then(p => { if (alive) setProfile(p); });
    return () => { alive = false; };
  }, [tenantId]);

  const profilById = useMemo(() => new Map(profile.map(p => [p.id, p])), [profile]);

  const handleFiles = useCallback(async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    const pdfs = Array.from(files).filter(f => f.type === 'application/pdf' || /\.pdf$/i.test(f.name));
    if (pdfs.length === 0) { toast.error('Bitte PDF-Dateien wählen.'); return; }
    setBusy(true);
    try {
      const aktuelleProfile = await loadLieferantenProfile(tenantId);
      setProfile(aktuelleProfile);
      const neu: VorschauZeile[] = [];
      for (const f of pdfs) {
        try {
          const extract = await extractGnPdfTextItems(f);
          if (!extract.hasTextLayer) {
            toast.warning(`${f.name}: kein Text im PDF (Scan?) — bitte manuell erfassen.`);
            continue;
          }
          const text = reconstructGnPdfLines(extract.pages).map(l => l.text).join('\n');
          const erg = parseProfilPdf(text, aktuelleProfile);
          neu.push({
            fileName: f.name, ergebnis: erg,
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

  const bereit = zeilen.filter(z => z.lieferant !== '' && z.datum && num(z.netto) !== null);
  const offen = zeilen.length - bereit.length;

  async function handleImport() {
    if (bereit.length === 0) { toast.error('Keine importierbaren Rechnungen (Lieferant/Datum/Netto fehlen).'); return; }
    setBusy(true);
    try {
      // Buchungen pro Profil sammeln (Kern-Pipeline arbeitet je Lieferant).
      const proProfil = new Map<string, { profil: LieferantenProfil; rechnungen: FsImportRechnung[] }>();
      for (const row of bereit) {
        const profil = profilById.get(row.lieferant);
        if (!profil) continue;
        const konto = row.konto.trim() || profil.konto;
        const netto = num(row.netto)!;
        const mwst = num(row.mwst) ?? 0;
        const eintrag = proProfil.get(profil.id) ?? { profil: { ...profil, konto }, rechnungen: [] };
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
          for (const l of row.ergebnis.lieferungen) eintrag.rechnungen.push({ r: l });
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
          eintrag.rechnungen.push({ r, nettoOffiziell: netto, bruttoOffiziell: R2(netto + mwst) });
        }
        proProfil.set(profil.id, eintrag);
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
      const vorher = await erstelleWarenImportSnapshot(tenantId, { monate: [...monate], mitPreisHistorie: true });

      let neu = 0, ersetzt = 0, aenderungen = 0;
      const lieferanten: string[] = [];
      for (const { profil, rechnungen } of proProfil.values()) {
        const erg = await kernImportiereFsRechnungen(tenantId, profil.name, rechnungen, {
          noteLabel: 'Lieferanten-PDF', idPrefix: 'lpdf',
          extraMapping: { [profil.kategorie]: profil.konto },
          defaultKonto: profil.konto,
        });
        neu += erg.neu; ersetzt += erg.ersetzt; aenderungen += erg.preisAenderungen;
        lieferanten.push(profil.name);
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
      toast.success(`${neu} Buchung${neu === 1 ? '' : 'en'} importiert${ersetzt > 0 ? `, ${ersetzt} ersetzt` : ''}${aenderungen > 0 ? ` · ${aenderungen} Preisänderung${aenderungen === 1 ? '' : 'en'}` : ''}.`);
      onImported();
    } catch (e) {
      console.error('[BEAULIEU-PDF] Import fehlgeschlagen:', e);
      toast.error(e instanceof Error ? e.message : String(e));
    } finally { setBusy(false); }
  }

  return (
    <div className="border border-border/60 rounded-lg p-3 space-y-3" data-testid="beaulieu-pdf-import">
      <div className="flex flex-wrap items-center gap-3">
        <label className="inline-flex items-center gap-2 text-xs font-medium rounded-lg border border-dashed px-3 py-2 cursor-pointer hover:bg-muted/40 transition-colors">
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <FileScan className="h-4 w-4 text-primary" />}
          Lieferanten-PDFs importieren (Erkennung über MWST-Nr-Profile)
          <input type="file" accept="application/pdf" multiple className="hidden" disabled={busy}
            data-testid="input-beaulieu-pdf"
            onChange={e => { void handleFiles(e.target.files); e.target.value = ''; }} />
        </label>
        <span className="text-[11px] text-muted-foreground">
          Kopf-Erkennung für alle Profile · Positionen je Lieferung für Terravigna, Spahni, Fideco
        </span>
      </div>

      <WarenImportUndoButton tenantId={tenantId} typ="pdf_profil" refresh={undoRefresh}
        onUndone={() => { setUndoRefresh(k => k + 1); onImported(); }} />

      {zeilen.length > 0 && (
        <div className="space-y-2" data-testid="beaulieu-pdf-vorschau">
          {zeilen.map((row, i) => {
            const erg = row.ergebnis;
            const istOffen = row.lieferant === '';
            return (
              <div key={`${row.fileName}-${i}`}
                className={`rounded-md border p-2 space-y-2 ${istOffen ? 'border-amber-500/60 bg-amber-500/5' : 'border-border/50'}`}>
                <div className="flex flex-wrap items-center gap-2 text-xs">
                  <span className="font-medium truncate max-w-[220px]" title={row.fileName}>{row.fileName}</span>
                  {istOffen
                    ? <span className="text-amber-600 font-medium">Lieferant offen{erg.mwstNrn[0] ? ` · CHE-${erg.mwstNrn[0]}` : ''}</span>
                    : <span className="text-muted-foreground">
                        {erg.positionenErkannt
                          ? `${erg.lieferungen.length} Lieferung${erg.lieferungen.length === 1 ? '' : 'en'} · ${erg.lieferungen.reduce((s, l) => s + l.positionen.length, 0)} Positionen`
                          : 'Kopf-Buchung (ohne Positionen)'}
                      </span>}
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

                {erg.hinweise.length > 0 && (
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
      <div className="grid grid-cols-[1fr_110px_110px_70px_60px_24px] gap-1.5 text-[11px] text-muted-foreground px-0.5">
        <span>Lieferant</span><span>MWST-Nr</span><span>Kategorie</span><span>Konto</span><span>MwSt %</span><span />
      </div>
      {profile.map(p => (
        <div key={p.id} className="grid grid-cols-[1fr_110px_110px_70px_60px_24px] gap-1.5 items-center">
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
