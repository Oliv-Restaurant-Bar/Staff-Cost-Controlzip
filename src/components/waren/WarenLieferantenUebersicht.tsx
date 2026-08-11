/**
 * WarenLieferantenUebersicht — alle Lieferanten mit Import-Typ und Status.
 * =======================================================================
 * Tabelle, gruppiert in AUTOMATISCH GEPARST (CSV/PDF-Profile) und MANUELL.
 * Spalten: Lieferant · Import-Typ · Konto · Monatsrechnung · Letzter Import ·
 * Rechnungen (Monat) · Status. Klick auf eine Zeile: Rechnungen des Monats
 * + direkter Upload NUR für diesen Lieferanten (Fehlrouting wird gemeldet).
 * Konto je Profil hier editierbar (canEdit), gespeichert im Mandanten-KV.
 */
import { useEffect, useMemo, useState } from 'react';
import { cn } from '@/lib/utils';
import { toast } from 'sonner';
import { CheckCircle2, ChevronDown, ChevronRight, Loader2, Upload } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import {
  loadLieferantenProfile, saveLieferantenProfile, hatMonatsrechnung,
  type LieferantenProfil,
} from '@/lib/lieferanten-profile';
import type { InvoiceEntry, Supplier } from '@/lib/waren-db';
import type { TenantId } from '@/contexts/TenantContext';
import { fmtDatumCH } from '@/lib/waren-fibu-matches';

const fmt = (n: number) => n.toLocaleString('de-CH', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

interface Zeile {
  key: string;
  name: string;
  importTyp: string;
  konto: string;
  monatsrechnung: boolean | null;   // null = entfällt (manuell)
  gruppe: 'auto' | 'manuell';
  /** Ziel-Kanal für den Direkt-Upload dieser Zeile. */
  uploadZiel: 'csv' | 'fs' | 'profil' | null;
  profilId?: string;
  /** Matcher: gehört ein Buchungs-Lieferantenname zu dieser Zeile? */
  match: (supplierName: string) => boolean;
}

function norm(s: string): string {
  return s.toLowerCase().replace(/[^a-zäöüé ]/g, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * Effektiver Final-Status einer Buchung für die Status-Spalte:
 * - final === true  ⇒ final.
 * - final === false ⇒ provisorisch (explizit: FIBU-/Kreditoren-Übernahme).
 * - final fehlt (Altbestand/manuelle Erfassung): «provisorisch» gibt es nur
 *   im Lieferschein→Monatsrechnung-Workflow — bei Lieferanten OHNE
 *   Monatsrechnung (und manuell erfassten) gilt jede Rechnung als final.
 */
function istEffektivFinal(e: InvoiceEntry, monatsrechnung: boolean | null): boolean {
  if (e.final === true) return true;
  if (e.final === false) return false;
  return monatsrechnung !== true;
}

export function WarenLieferantenUebersicht({
  tenantId, entries, suppliers, canEdit, canUpload, monthLabel, onUploadFor,
}: {
  tenantId: TenantId;
  /** Buchungen des angezeigten Monats. */
  entries: InvoiceEntry[];
  suppliers: Supplier[];
  canEdit: boolean;
  /** Erfassungs-Recht: ohne dieses keine Upload-Steuerelemente. */
  canUpload: boolean;
  monthLabel: string;
  /** Direkter Upload je Lieferant: Dateien + erwartete Zeile (Name). */
  onUploadFor: (files: File[], erwartet: { name: string; ziel: 'csv' | 'fs' | 'profil' }) => void;
}) {
  const [profile, setProfile] = useState<LieferantenProfil[] | null>(null);
  const [offen, setOffen] = useState<string | null>(null);
  const [kontoEdit, setKontoEdit] = useState<Record<string, string>>({});
  const [refresh, setRefresh] = useState(0);

  useEffect(() => {
    let alive = true;
    loadLieferantenProfile(tenantId).then(p => { if (alive) setProfile(p); });
    return () => { alive = false; };
  }, [tenantId, refresh]);

  const zeilen = useMemo<Zeile[]>(() => {
    if (profile === null) return [];
    const auto: Zeile[] = [];

    // CSV-Positionsimport (Markt-Spalte entscheidet den Lieferanten).
    auto.push({
      key: 'csv-tg', name: 'Transgourmet / Prodega',
      importTyp: 'CSV-Positionsimport (Warengruppen)',
      konto: '4060 / 4020 / 4701', monatsrechnung: false, gruppe: 'auto', uploadZiel: 'csv',
      match: s => /transgourmet|prodega/i.test(s),
    });
    // Feldschlösschen: PDF mit MwSt-Zusammenfassungs-Split.
    auto.push({
      key: 'fs', name: 'Feldschlösschen',
      importTyp: 'PDF, Split aus «Zusammenfassung MwSt.»',
      konto: '4030 / 4040 / 4050 (+Depot)', monatsrechnung: false, gruppe: 'auto', uploadZiel: 'fs',
      match: s => /feldschl/i.test(s),
    });
    // PDF-Profile (MWST-Nr/Name/IBAN-Erkennung).
    for (const p of profile) {
      // Transgourmet-Profil dient nur der PDF-Erkennung — CSV-Zeile deckt es ab.
      if (p.id === 'transgourmet') continue;
      const mr = hatMonatsrechnung(p);
      auto.push({
        key: `p-${p.id}`, name: p.name,
        importTyp: p.belegtyp === 'dual' ? 'PDF Lieferscheine + Monatsrechnung'
          : p.belegtyp === 'monatsrechnung' ? 'PDF Monatsrechnung'
          : 'PDF Einzelrechnung · final',
        konto: p.id === 'caporaso' ? '4060 / 4701 (MwSt-Split)' : p.konto,
        monatsrechnung: mr, gruppe: 'auto', uploadZiel: 'profil', profilId: p.id,
        match: s => {
          const a = norm(s); const b = norm(p.name);
          return a === b || a.includes(b) || b.includes(a) ||
            (p.erkennungTokens ?? []).every(t => a.includes(norm(t))) && (p.erkennungTokens?.length ?? 0) > 0;
        },
      });
    }

    // MANUELL: alle aktiven Lieferanten, die keine Auto-Zeile abdeckt.
    const manuell: Zeile[] = suppliers
      .filter(s => s.active !== false)
      .filter(s => !auto.some(z => z.match(s.name)))
      .map(s => ({
        key: `m-${s.id}`, name: s.name,
        importTyp: 'Manuelle Erfassung',
        konto: s.defaultWarenkonto ?? '—',
        monatsrechnung: null, gruppe: 'manuell' as const, uploadZiel: null,
        match: (n: string) => norm(n) === norm(s.name),
      }));
    manuell.sort((a, b) => a.name.localeCompare(b.name, 'de-CH'));
    return [...auto, ...manuell];
  }, [profile, suppliers]);

  // Buchungs-Statistik je Zeile (Monat): Anzahl, letzter Import, Status.
  const statsFuer = (z: Zeile) => {
    const eigene = entries.filter(e => z.match(e.supplierName));
    const letzter = eigene.reduce<string | null>((m, e) => (!m || e.createdAt > m ? e.createdAt : m), null);
    const finale = eigene.filter(e => istEffektivFinal(e, z.monatsrechnung)).length;
    const prov = eigene.length - finale;
    return { eigene, letzter, finale, prov };
  };

  const speichereKonto = async (profilId: string, konto: string) => {
    if (!profile) return;
    const k = konto.trim();
    if (!/^\d{4}$/.test(k)) { toast.error('Konto bitte als 4-stellige Nummer (z.B. 4020).'); return; }
    const next = profile.map(p => (p.id === profilId ? { ...p, konto: k } : p));
    try {
      await saveLieferantenProfile(tenantId, next);
      setProfile(next); setRefresh(r => r + 1);
      toast.success(`Konto gespeichert — künftige Importe buchen auf ${k}.`);
    } catch (e) {
      toast.error(`Speichern fehlgeschlagen: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  if (profile === null) {
    return <div className="flex items-center gap-2 text-xs text-muted-foreground py-3"><Loader2 className="h-4 w-4 animate-spin" /> Lieferanten werden geladen…</div>;
  }

  const gruppen: Array<{ label: string; rows: Zeile[] }> = [
    { label: 'AUTOMATISCH GEPARST', rows: zeilen.filter(z => z.gruppe === 'auto') },
    { label: 'MANUELL', rows: zeilen.filter(z => z.gruppe === 'manuell') },
  ];

  return (
    <section className="bg-card border border-border rounded-xl overflow-hidden" data-testid="lieferanten-uebersicht">
      <div className="px-5 py-3 border-b border-border bg-muted/20">
        <h2 className="text-sm font-semibold">Lieferanten-Übersicht · {monthLabel}</h2>
        <p className="text-[11px] text-muted-foreground mt-0.5">
          Klick auf einen Lieferanten: Rechnungen des Monats + Upload nur für ihn. Konto je Profil editierbar.
        </p>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead>
            <tr className="border-b border-border text-muted-foreground">
              <th className="text-left px-4 py-2 font-medium">Lieferant</th>
              <th className="text-left px-2 py-2 font-medium">Import-Typ</th>
              <th className="text-left px-2 py-2 font-medium">Konto</th>
              <th className="text-center px-2 py-2 font-medium">Monatsrechnung</th>
              <th className="text-left px-2 py-2 font-medium">Letzter Import</th>
              <th className="text-right px-2 py-2 font-medium">Rechnungen (Monat)</th>
              <th className="text-left px-4 py-2 font-medium">Status</th>
            </tr>
          </thead>
          {gruppen.map(g => (
            <tbody key={g.label}>
              <tr className="bg-muted/30">
                <td colSpan={7} className="px-4 py-1.5 text-[10px] font-bold tracking-wider text-muted-foreground">{g.label}</td>
              </tr>
              {g.rows.map(z => {
                const st = statsFuer(z);
                const istOffen = offen === z.key;
                return (
                  <FragmentZeile key={z.key} z={z} st={st} istOffen={istOffen}
                    onToggle={() => setOffen(istOffen ? null : z.key)}
                    canEdit={canEdit} canUpload={canUpload}
                    kontoEdit={kontoEdit} setKontoEdit={setKontoEdit}
                    speichereKonto={speichereKonto}
                    onUploadFor={onUploadFor} />
                );
              })}
            </tbody>
          ))}
        </table>
      </div>
    </section>
  );
}

function FragmentZeile({ z, st, istOffen, onToggle, canEdit, canUpload, kontoEdit, setKontoEdit, speichereKonto, onUploadFor }: {
  z: Zeile;
  st: { eigene: InvoiceEntry[]; letzter: string | null; finale: number; prov: number };
  istOffen: boolean;
  onToggle: () => void;
  canEdit: boolean;
  canUpload: boolean;
  kontoEdit: Record<string, string>;
  setKontoEdit: React.Dispatch<React.SetStateAction<Record<string, string>>>;
  speichereKonto: (profilId: string, konto: string) => Promise<void>;
  onUploadFor: (files: File[], erwartet: { name: string; ziel: 'csv' | 'fs' | 'profil' }) => void;
}) {
  return (
    <>
      <tr
        className={cn('border-b border-border/50 cursor-pointer hover:bg-muted/30 transition-colors', istOffen && 'bg-muted/20')}
        onClick={onToggle}
        data-testid={`row-lieferant-${z.key}`}
      >
        <td className="px-4 py-2 font-medium whitespace-nowrap">
          <span className="inline-flex items-center gap-1.5">
            {istOffen ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
            {z.name}
          </span>
        </td>
        <td className="px-2 py-2 text-muted-foreground">{z.importTyp}</td>
        <td className="px-2 py-2 whitespace-nowrap">
          {canEdit && z.profilId && !z.konto.includes('/') ? (
            <span onClick={e => e.stopPropagation()} className="inline-flex items-center gap-1">
              <Input
                className="h-6 w-16 text-xs px-1.5"
                value={kontoEdit[z.profilId] ?? z.konto}
                data-testid={`input-konto-${z.profilId}`}
                onChange={e => setKontoEdit(m => ({ ...m, [z.profilId!]: e.target.value }))}
                onBlur={() => {
                  const v = kontoEdit[z.profilId!];
                  if (v !== undefined && v !== z.konto) void speichereKonto(z.profilId!, v);
                }}
              />
            </span>
          ) : z.konto}
        </td>
        <td className="px-2 py-2 text-center">
          {z.monatsrechnung === null ? '—' : z.monatsrechnung ? 'ja' : 'nein'}
        </td>
        <td className="px-2 py-2 whitespace-nowrap text-muted-foreground">
          {st.letzter ? fmtDatumCH(st.letzter.slice(0, 10)) : '—'}
        </td>
        <td className="px-2 py-2 text-right tabular-nums">{st.eigene.length || '—'}</td>
        <td className="px-4 py-2 whitespace-nowrap">
          {st.eigene.length === 0 ? (
            <span className="text-muted-foreground">keine Buchungen</span>
          ) : st.prov === 0 ? (
            <span className="inline-flex items-center gap-1 text-emerald-600 dark:text-emerald-400">
              <CheckCircle2 className="h-3 w-3" /> {st.finale} final
            </span>
          ) : (
            <span className="text-amber-600 dark:text-amber-400">
              {st.prov} provisorisch{st.finale > 0 ? ` · ${st.finale} final` : ''}
            </span>
          )}
        </td>
      </tr>
      {istOffen && (
        <tr className="border-b border-border/50 bg-muted/10">
          <td colSpan={7} className="px-6 py-3">
            <div className="space-y-2">
              {z.uploadZiel && canUpload && (
                <label className="inline-flex items-center gap-2 text-[11px] font-medium rounded-lg border border-dashed px-3 py-1.5 cursor-pointer hover:bg-muted/40 transition-colors">
                  <Upload className="h-3.5 w-3.5" />
                  Upload nur für {z.name}
                  <input
                    type="file" multiple className="hidden"
                    accept={z.uploadZiel === 'csv' ? '.csv,.txt' : '.pdf,.zip,application/pdf'}
                    data-testid={`input-upload-${z.key}`}
                    onClick={e => e.stopPropagation()}
                    onChange={e => {
                      const files = Array.from(e.target.files ?? []);
                      e.target.value = '';
                      if (files.length) onUploadFor(files, { name: z.name, ziel: z.uploadZiel! });
                    }}
                  />
                </label>
              )}
              {st.eigene.length === 0 ? (
                <p className="text-[11px] text-muted-foreground">Keine Rechnungen in diesem Monat.</p>
              ) : (
                <table className="w-full text-[11px]">
                  <thead>
                    <tr className="text-muted-foreground">
                      <th className="text-left py-1 font-medium">Datum</th>
                      <th className="text-left py-1 font-medium">Referenz</th>
                      <th className="text-right py-1 font-medium">Netto CHF</th>
                      <th className="text-left py-1 pl-3 font-medium">Konto</th>
                      <th className="text-left py-1 pl-3 font-medium">Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {[...st.eigene].sort((a, b) => a.date.localeCompare(b.date)).map(e => (
                      <tr key={e.id} className="border-t border-border/40">
                        <td className="py-1 whitespace-nowrap">{fmtDatumCH(e.date)}</td>
                        <td className="py-1 text-muted-foreground">{e.reference ?? '—'}</td>
                        <td className="py-1 text-right tabular-nums">{fmt(e.amountNet)}</td>
                        <td className="py-1 pl-3">{e.kontoSplits?.length ? e.kontoSplits.map(s => s.warenkonto).join(' / ') : (e.warenkonto ?? '—')}</td>
                        <td className="py-1 pl-3">
                          {e.quelle === 'fibu_uebernahme' ? 'FIBU-Übernahme'
                            : e.quelle === 'kreditoren_uebernahme' ? 'Kreditoren-Übernahme'
                            : istEffektivFinal(e, z.monatsrechnung) ? 'final' : 'provisorisch'}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          </td>
        </tr>
      )}
    </>
  );
}
