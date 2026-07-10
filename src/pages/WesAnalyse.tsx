/**
 * WES-Analyse – Wareneinsatz-Vergleich
 * ======================================
 *
 * Vergleicht drei Quellen:
 *  1. Rezeptur   – theoretischer WES aus Rezepten × Verkaufsmengen
 *  2. Lieferanten – operativer WES aus erfassten Lieferscheinen/Rechnungen
 *  3. Buchhaltung – gebuchter WES aus Konten 4020–4090 (Sage-Import)
 */

import React, { useState, useEffect, useMemo } from 'react';
import { TrendingDown, ChevronDown, Info, HelpCircle } from 'lucide-react';
import { Button }        from '@/components/ui/button';
import { Badge }         from '@/components/ui/badge';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

import { loadYear, loadMonth, STORAGE_KEY as REPORTING_STORAGE_KEY } from '@/lib/reporting-store';
import { useTenant } from '@/contexts/TenantContext';
import { getMonthSummary }     from '@/lib/supplier-documents-store';
import { loadProductCosts, loadProdukteData } from '@/lib/produkte-store';
import { MONTH_NAMES_DE }      from '@/types/reporting';

// ─── FIBU-Konten → Kategorie & Label ──────────────────────────────────────────

const FIBU_META: Record<string, { label: string; category: 'food' | 'beverage' | 'other' }> = {
  '4020': { label: 'Wein',            category: 'beverage' },
  '4030': { label: 'Bier',            category: 'beverage' },
  '4040': { label: 'Spirituosen',     category: 'beverage' },
  '4050': { label: 'Mineral',         category: 'beverage' },
  '4060': { label: 'Küche / Food',    category: 'food'     },
  '4061': { label: 'Rest Food',       category: 'food'     },
  '4070': { label: 'Kaffee & Tee',    category: 'beverage' },
  '4090': { label: 'Diverses',        category: 'other'    },
  '4701': { label: 'Betriebsmaterial',category: 'other'    },
};

// Menschenlesbare categoryIds (manuelle Erfassung) → Kategorie
function categorizeByCategoryId(id: string): 'food' | 'beverage' | 'other' | null {
  if (/wareneinsatz_kueche|warenaufwand_kueche|food_cost|cogs_food/.test(id)) return 'food';
  if (/wareneinsatz_bar|wareneinsatz_getraenke|beverage_cost|cogs_bev/.test(id)) return 'beverage';
  if (/wareneinsatz_diverses|warenaufwand_diverses/.test(id)) return 'other';
  return null;
}

// ─── Typen ────────────────────────────────────────────────────────────────────

interface AccountRow {
  code:     string;
  label:    string;
  category: 'food' | 'beverage' | 'other';
  amount:   number;
}

interface WesMonthRow {
  year:        number;
  month:       number;
  monthLabel:  string;
  revenue:     number;

  // Quelle 1: Rezeptur
  rezFood:     number;
  rezBeverage: number;
  rezTotal:    number;

  // Quelle 2: Lieferanten
  liefFood:     number;
  liefBeverage: number;
  liefTotal:    number;

  // Quelle 3: Buchhaltung
  buchFood:     number;
  buchBeverage: number;
  buchTotal:    number;
  hasBuchData:  boolean;

  // Aufschlüsselung nach Konto (Buchhaltung)
  byAccount:   AccountRow[];
}

// ─── Datenaufbereitung ────────────────────────────────────────────────────────

function buildMonthRow(year: number, monthIdx: number, storeKey: string = REPORTING_STORAGE_KEY): WesMonthRow {
  const month = monthIdx + 1; // 1-12

  // Umsatz
  const reporting = loadMonth(year, month, storeKey);
  const revenue   = reporting.revenueActual ?? 0;

  // ── Rezeptur ────────────────────────────────────────────────────────────────
  const costEntries = loadProductCosts();      // wes pro Einheit
  const prodData    = loadProdukteData();      // Verkaufsmengen

  const monthKey = `${year}-${String(month).padStart(2, '0')}`; // 'yyyy-MM'

  const entriesForMonth = prodData
    ? prodData.entries.filter(e => e.month === monthKey)
    : [];

  let rezFood     = 0;
  let rezBeverage = 0;

  for (const entry of entriesForMonth) {
    const costEntry = costEntries.find(
      c => c.name === entry.name && c.category === entry.category,
    );
    if (!costEntry || costEntry.wes <= 0) continue;
    const contribution = costEntry.wes * (entry.count || 0);
    if (entry.category === 'food')     rezFood     += contribution;
    else                               rezBeverage += contribution;
  }

  // ── Lieferanten ─────────────────────────────────────────────────────────────
  const lief = getMonthSummary(year, month);

  // ── Buchhaltung ─────────────────────────────────────────────────────────────
  const byAccount: AccountRow[] = [];
  let buchFood     = 0;
  let buchBeverage = 0;
  let buchOther    = 0;
  let hasBuchData  = false;

  for (const cat of reporting.expenseCategories) {
    const { categoryId, amount = 0 } = cat;
    if (amount === 0) continue;

    // 4-stellige Kontonummer
    if (/^\d{4}$/.test(categoryId)) {
      const meta = FIBU_META[categoryId];
      if (meta) {
        byAccount.push({ code: categoryId, label: meta.label, category: meta.category, amount });
        if (meta.category === 'food')     buchFood     += amount;
        else if (meta.category === 'beverage') buchBeverage += amount;
        else                              buchOther    += amount;
        hasBuchData = true;
      }
    }
    // Menschenlesbare IDs
    else {
      const cat3 = categorizeByCategoryId(categoryId);
      if (cat3) {
        byAccount.push({ code: '-', label: cat.label, category: cat3, amount });
        if (cat3 === 'food')     buchFood     += amount;
        else if (cat3 === 'beverage') buchBeverage += amount;
        else                     buchOther    += amount;
        hasBuchData = true;
      }
    }
  }

  return {
    year,
    month,
    monthLabel: MONTH_NAMES_DE[monthIdx],
    revenue,
    rezFood,
    rezBeverage,
    rezTotal:    rezFood + rezBeverage,
    liefFood:    lief.foodCost,
    liefBeverage: lief.beverageCost,
    liefTotal:   lief.totalCost,
    buchFood,
    buchBeverage,
    buchTotal:   buchFood + buchBeverage + buchOther,
    hasBuchData,
    byAccount:   byAccount.sort((a, b) => b.amount - a.amount),
  };
}

// ─── Formatierung ─────────────────────────────────────────────────────────────

function chf(val: number): string {
  return val.toLocaleString('de-CH', { minimumFractionDigits: 0, maximumFractionDigits: 0 });
}

function pct(cost: number, revenue: number): string {
  if (revenue <= 0) return '–';
  return ((cost / revenue) * 100).toFixed(1) + ' %';
}

function diffBadge(val: number) {
  if (val === 0) return null;
  const color = Math.abs(val) < 500
    ? 'bg-green-100 text-green-800'
    : val > 0
      ? 'bg-orange-100 text-orange-800'
      : 'bg-blue-100 text-blue-800';
  return (
    <span className={`inline-block text-xs px-1.5 py-0.5 rounded font-medium ${color}`}>
      {val > 0 ? '+' : ''}{chf(val)}
    </span>
  );
}

// ─── Hauptkomponente ──────────────────────────────────────────────────────────

type Tab = 'uebersicht' | 'konto' | 'erklaerung';

export default function WesAnalyse() {
  const { tenantId, tenantKey } = useTenant();
  const currentYear = new Date().getFullYear();
  const [year, setYear]         = useState(currentYear);
  const [activeTab, setActiveTab] = useState<Tab>('uebersicht');
  const [rows, setRows]         = useState<WesMonthRow[]>([]);

  // Verfügbare Jahre (aktuelles + 2 zurück)
  const years = [currentYear, currentYear - 1, currentYear - 2];

  useEffect(() => {
    const sk = tenantKey(REPORTING_STORAGE_KEY);
    const built = Array.from({ length: 12 }, (_, i) => buildMonthRow(year, i, sk));
    setRows(built);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [year, tenantId]);

  // Jahressumme
  const totals = useMemo(() => ({
    revenue:     rows.reduce((s, r) => s + r.revenue,     0),
    rezTotal:    rows.reduce((s, r) => s + r.rezTotal,    0),
    liefTotal:   rows.reduce((s, r) => s + r.liefTotal,   0),
    buchTotal:   rows.reduce((s, r) => s + r.buchTotal,   0),
    rezFood:     rows.reduce((s, r) => s + r.rezFood,     0),
    rezBeverage: rows.reduce((s, r) => s + r.rezBeverage, 0),
    liefFood:    rows.reduce((s, r) => s + r.liefFood,    0),
    liefBeverage:rows.reduce((s, r) => s + r.liefBeverage,0),
    buchFood:    rows.reduce((s, r) => s + r.buchFood,    0),
    buchBeverage:rows.reduce((s, r) => s + r.buchBeverage,0),
  }), [rows]);

  // Alle Konten über das Jahr aggregiert
  const yearAccounts = useMemo(() => {
    const map = new Map<string, AccountRow>();
    for (const row of rows) {
      for (const a of row.byAccount) {
        const key = a.code + '|' + a.label;
        const prev = map.get(key);
        if (prev) prev.amount += a.amount;
        else map.set(key, { ...a });
      }
    }
    return [...map.values()].sort((a, b) => b.amount - a.amount);
  }, [rows]);

  const hasAnyBuchData = rows.some(r => r.hasBuchData);
  const hasAnyRezData  = rows.some(r => r.rezTotal > 0);
  const hasAnyLiefData = rows.some(r => r.liefTotal > 0);

  // ─── Render ──────────────────────────────────────────────────────────────────
  return (
    <div className="p-4 md:p-6 max-w-7xl mx-auto space-y-6">

      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <TrendingDown className="h-6 w-6 text-primary" />
            WES-Analyse
          </h1>
          <p className="text-sm text-muted-foreground mt-0.5">
            Wareneinsatz aus 3 Quellen im Vergleich
          </p>
        </div>
        <Select value={String(year)} onValueChange={v => setYear(Number(v))}>
          <SelectTrigger className="w-32">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {years.map(y => (
              <SelectItem key={y} value={String(y)}>{y}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {/* Quellen-Legende */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <SourceCard
          number="1"
          title="Rezeptur"
          desc="Theoretischer WES aus Rezepten × Verkaufsmengen (Kalkulation)"
          color="violet"
          hasData={hasAnyRezData}
        />
        <SourceCard
          number="2"
          title="Lieferanten"
          desc="Operativer WES aus erfassten Lieferscheinen & Rechnungen"
          color="blue"
          hasData={hasAnyLiefData}
        />
        <SourceCard
          number="3"
          title="Buchhaltung"
          desc="Gebuchter WES aus Konten 4020–4090 (Sage-Import)"
          color="emerald"
          hasData={hasAnyBuchData}
        />
      </div>

      {/* Tabs */}
      <div className="border-b border-border">
        <div className="flex gap-1">
          {([ ['uebersicht','Übersicht'], ['konto','Nach Konto'], ['erklaerung','Erklärung'] ] as [Tab, string][]).map(([id, label]) => (
            <button
              key={id}
              onClick={() => setActiveTab(id)}
              className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
                activeTab === id
                  ? 'border-primary text-primary'
                  : 'border-transparent text-muted-foreground hover:text-foreground'
              }`}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      {/* ── Tab: Übersicht ─────────────────────────────────────────────────── */}
      {activeTab === 'uebersicht' && (
        <div className="space-y-4">
          <div className="rounded-lg border overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b bg-muted/40">
                  <th className="text-left px-3 py-2.5 font-medium text-muted-foreground">Monat</th>
                  <th className="text-right px-3 py-2.5 font-medium text-muted-foreground">Umsatz</th>
                  {/* Rezeptur */}
                  <th className="text-right px-3 py-2.5 font-medium text-violet-700 bg-violet-50/60">Rezeptur CHF</th>
                  <th className="text-right px-3 py-2.5 font-medium text-violet-700 bg-violet-50/60">Rez. %</th>
                  {/* Lieferanten */}
                  <th className="text-right px-3 py-2.5 font-medium text-blue-700 bg-blue-50/60">Lief. CHF</th>
                  <th className="text-right px-3 py-2.5 font-medium text-blue-700 bg-blue-50/60">Lief. %</th>
                  {/* Buchhaltung */}
                  <th className="text-right px-3 py-2.5 font-medium text-emerald-700 bg-emerald-50/60">Buch. CHF</th>
                  <th className="text-right px-3 py-2.5 font-medium text-emerald-700 bg-emerald-50/60">Buch. %</th>
                  {/* Differenz Lief – Buch */}
                  <th className="text-right px-3 py-2.5 font-medium text-muted-foreground">Diff. Lief/Buch</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row, i) => {
                  const diffLiefBuch = row.liefTotal - row.buchTotal;
                  const hasData = row.revenue > 0 || row.rezTotal > 0 || row.liefTotal > 0 || row.hasBuchData;
                  return (
                    <tr key={i} className={`border-b last:border-0 ${hasData ? '' : 'opacity-40'}`}>
                      <td className="px-3 py-2 font-medium">{row.monthLabel}</td>
                      <td className="px-3 py-2 text-right tabular-nums">
                        {row.revenue > 0 ? chf(row.revenue) : <span className="text-muted-foreground">–</span>}
                      </td>
                      {/* Rezeptur */}
                      <td className="px-3 py-2 text-right tabular-nums bg-violet-50/30">
                        {row.rezTotal > 0 ? chf(row.rezTotal) : <span className="text-muted-foreground">–</span>}
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums bg-violet-50/30 text-violet-700">
                        {row.rezTotal > 0 ? pct(row.rezTotal, row.revenue) : '–'}
                      </td>
                      {/* Lieferanten */}
                      <td className="px-3 py-2 text-right tabular-nums bg-blue-50/30">
                        {row.liefTotal > 0 ? chf(row.liefTotal) : <span className="text-muted-foreground">–</span>}
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums bg-blue-50/30 text-blue-700">
                        {row.liefTotal > 0 ? pct(row.liefFood + row.liefBeverage, row.revenue) : '–'}
                      </td>
                      {/* Buchhaltung */}
                      <td className="px-3 py-2 text-right tabular-nums bg-emerald-50/30">
                        {row.hasBuchData ? chf(row.buchTotal) : <span className="text-muted-foreground">–</span>}
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums bg-emerald-50/30 text-emerald-700">
                        {row.hasBuchData ? pct(row.buchFood + row.buchBeverage, row.revenue) : '–'}
                      </td>
                      {/* Diff */}
                      <td className="px-3 py-2 text-right">
                        {row.hasBuchData && row.liefTotal > 0
                          ? diffBadge(diffLiefBuch)
                          : <span className="text-muted-foreground text-xs">–</span>}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
              {/* Jahressumme */}
              <tfoot>
                <tr className="bg-muted/50 font-semibold border-t-2">
                  <td className="px-3 py-2.5">Total {year}</td>
                  <td className="px-3 py-2.5 text-right tabular-nums">
                    {totals.revenue > 0 ? chf(totals.revenue) : '–'}
                  </td>
                  <td className="px-3 py-2.5 text-right tabular-nums bg-violet-50/30">
                    {totals.rezTotal > 0 ? chf(totals.rezTotal) : '–'}
                  </td>
                  <td className="px-3 py-2.5 text-right tabular-nums bg-violet-50/30 text-violet-700">
                    {totals.rezTotal > 0 ? pct(totals.rezTotal, totals.revenue) : '–'}
                  </td>
                  <td className="px-3 py-2.5 text-right tabular-nums bg-blue-50/30">
                    {totals.liefTotal > 0 ? chf(totals.liefTotal) : '–'}
                  </td>
                  <td className="px-3 py-2.5 text-right tabular-nums bg-blue-50/30 text-blue-700">
                    {totals.liefTotal > 0 ? pct(totals.liefFood + totals.liefBeverage, totals.revenue) : '–'}
                  </td>
                  <td className="px-3 py-2.5 text-right tabular-nums bg-emerald-50/30">
                    {hasAnyBuchData ? chf(totals.buchTotal) : '–'}
                  </td>
                  <td className="px-3 py-2.5 text-right tabular-nums bg-emerald-50/30 text-emerald-700">
                    {hasAnyBuchData ? pct(totals.buchFood + totals.buchBeverage, totals.revenue) : '–'}
                  </td>
                  <td className="px-3 py-2.5 text-right">
                    {hasAnyBuchData && hasAnyLiefData
                      ? diffBadge(totals.liefTotal - totals.buchTotal)
                      : '–'}
                  </td>
                </tr>
              </tfoot>
            </table>
          </div>

          <p className="text-xs text-muted-foreground">
            Die Quote (%) basiert auf den relevanten Warenkosten (Food + Beverage); «Diverses / Betriebsmaterial» ist ausgeschlossen. Die CHF-Beträge zeigen den vollen Aufwand inkl. Diverses.
          </p>

          {/* Food vs Beverage Split */}
          {(hasAnyRezData || hasAnyLiefData || hasAnyBuchData) && (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <CategorySplitCard
                title="Food"
                rez={totals.rezFood}
                lief={totals.liefFood}
                buch={totals.buchFood}
                revenue={totals.revenue}
                hasBuch={hasAnyBuchData}
                hasRez={hasAnyRezData}
                hasLief={hasAnyLiefData}
              />
              <CategorySplitCard
                title="Beverage"
                rez={totals.rezBeverage}
                lief={totals.liefBeverage}
                buch={totals.buchBeverage}
                revenue={totals.revenue}
                hasBuch={hasAnyBuchData}
                hasRez={hasAnyRezData}
                hasLief={hasAnyLiefData}
              />
            </div>
          )}
        </div>
      )}

      {/* ── Tab: Nach Konto ────────────────────────────────────────────────── */}
      {activeTab === 'konto' && (
        <div className="space-y-4">
          {!hasAnyBuchData ? (
            <NoDataHint>
              Keine Buchhaltungsdaten für {year} vorhanden. Importiere zuerst einen
              Sage-Export über die Import-Zentrale (Konten 4020–4090).
            </NoDataHint>
          ) : (
            <>
              {/* Food */}
              <AccountGroupTable
                title="Food"
                accounts={yearAccounts.filter(a => a.category === 'food')}
                revenue={totals.revenue}
                colorClass="text-amber-700 bg-amber-50"
              />
              {/* Beverage */}
              <AccountGroupTable
                title="Beverage"
                accounts={yearAccounts.filter(a => a.category === 'beverage')}
                revenue={totals.revenue}
                colorClass="text-blue-700 bg-blue-50"
              />
              {/* Other */}
              {yearAccounts.some(a => a.category === 'other') && (
                <AccountGroupTable
                  title="Diverses / Betriebsmaterial"
                  accounts={yearAccounts.filter(a => a.category === 'other')}
                  revenue={totals.revenue}
                  colorClass="text-gray-600 bg-gray-50"
                />
              )}
            </>
          )}
        </div>
      )}

      {/* ── Tab: Erklärung ─────────────────────────────────────────────────── */}
      {activeTab === 'erklaerung' && (
        <div className="max-w-3xl space-y-6">
          <ExplanationSection
            title="Was wird hier verglichen?"
            content={`Diese Seite zeigt den Wareneinsatz (WES) aus drei verschiedenen Quellen 
für dasselbe Jahr – damit du erkennen kannst, ob die Zahlen übereinstimmen 
oder ob es Abweichungen gibt, die untersucht werden sollten.`}
          />
          <div className="space-y-4">
            <ExplanationBlock
              nr="1"
              color="violet"
              title="Rezeptur (theoretischer WES)"
              what="Berechnet aus: Rezeptkosten × tatsächlich verkaufte Stückzahl pro Produkt."
              use="Zeigt, wie hoch der WES sein SOLLTE – wenn die Rezepten stimmen und kein Abfall, Verderb oder Schwund passiert."
              check="Vergleiche diesen Wert mit dem Lieferanten-WES. Ist der Lieferanten-WES deutlich höher, gibt es Schwund, Fehlmengen oder zu grosse Portionen."
            />
            <ExplanationBlock
              nr="2"
              color="blue"
              title="Lieferanten (operativer WES)"
              what="Summe aller erfassten Lieferscheine und Rechnungen im Modul «Lieferanten»."
              use="Zeigt, wie viel du im Monat tatsächlich eingekauft hast – unabhängig davon, ob alles verbraucht wurde."
              check="Vergleiche mit der Buchhaltung. Stimmen die Werte nicht überein, fehlen möglicherweise gebuchte Rechnungen oder es gibt Doppelerfassungen."
            />
            <ExplanationBlock
              nr="3"
              color="emerald"
              title="Buchhaltung (gebuchter WES)"
              what="Summe der Konten 4020 (Wein), 4030 (Bier), 4040 (Spirituosen), 4050 (Mineral), 4060 (Küche), 4070 (Kaffee & Tee) aus dem Sage-Import."
              use="Das sind die offiziell gebuchten Wareneinsatzkosten, die in der Erfolgsrechnung erscheinen."
              check="Dieser Wert ist die «Wahrheit» der Buchhaltung. Er sollte dem Lieferanten-WES möglichst nahe sein."
            />
          </div>
          <ExplanationSection
            title="Was solltest du überprüfen?"
            content={`Differenz Lieferanten vs. Buchhaltung:
→ Kleiner als CHF 500 pro Monat: Normal, kein Handlungsbedarf.
→ Zwischen CHF 500–2'000: Schau nach fehlenden Buchungen oder nicht erfassten Lieferscheinen.
→ Über CHF 2'000: Dringend prüfen – mögliche Ursachen: Rechnungen nicht gebucht, falsche Kontozuweisung, oder Bestand wurde aufgebaut/abgebaut.

Differenz Rezeptur vs. Lieferanten:
→ Lieferanten deutlich höher als Rezeptur: Du kaufst mehr ein als du laut Rezepten brauchst → Schwund, Verderb oder zu grosse Portionen.
→ Rezeptur höher als Lieferanten: Rezepte haben höhere Kosten als erfasst → möglicherweise fehlende Lieferantendokumente.`}
          />
          <ExplanationSection
            title="Wo kommen die Daten her?"
            content={`Rezeptur: Modul «Produkte → Kalkulation» – dort hinterlegte Rezeptkosten × Verkaufszahlen aus dem Kassensystem.
Lieferanten: Modul «Lieferanten» – dort manuell erfasste Lieferscheine und Rechnungen.
Buchhaltung: Modul «Import-Zentrale» – importierter Sage-Kontoauszug mit Konten 4020–4090.`}
          />
        </div>
      )}
    </div>
  );
}

// ─── Hilfskomponenten ──────────────────────────────────────────────────────────

function SourceCard({
  number, title, desc, color, hasData,
}: { number: string; title: string; desc: string; color: 'violet'|'blue'|'emerald'; hasData: boolean }) {
  const colorMap = {
    violet:  'border-violet-200 bg-violet-50',
    blue:    'border-blue-200 bg-blue-50',
    emerald: 'border-emerald-200 bg-emerald-50',
  };
  const textMap = {
    violet:  'text-violet-800',
    blue:    'text-blue-800',
    emerald: 'text-emerald-800',
  };
  const badgeMap = {
    violet:  'bg-violet-200 text-violet-900',
    blue:    'bg-blue-200 text-blue-900',
    emerald: 'bg-emerald-200 text-emerald-900',
  };
  return (
    <div className={`rounded-lg border p-4 ${colorMap[color]}`}>
      <div className="flex items-start gap-3">
        <span className={`inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-xs font-bold ${badgeMap[color]}`}>
          {number}
        </span>
        <div className="min-w-0">
          <p className={`font-semibold text-sm ${textMap[color]}`}>{title}</p>
          <p className="text-xs text-muted-foreground mt-0.5 leading-snug">{desc}</p>
          {!hasData && (
            <p className="text-xs mt-1.5 text-muted-foreground italic">Noch keine Daten</p>
          )}
        </div>
      </div>
    </div>
  );
}

function CategorySplitCard({
  title, rez, lief, buch, revenue, hasBuch, hasRez, hasLief,
}: {
  title: string; rez: number; lief: number; buch: number; revenue: number;
  hasBuch: boolean; hasRez: boolean; hasLief: boolean;
}) {
  return (
    <div className="rounded-lg border p-4 space-y-3">
      <h3 className="font-semibold text-sm">{title}</h3>
      <div className="space-y-2 text-sm">
        {hasRez && (
          <div className="flex items-center justify-between">
            <span className="flex items-center gap-2 text-muted-foreground">
              <span className="h-2 w-2 rounded-full bg-violet-500 inline-block" />
              Rezeptur
            </span>
            <span className="font-medium tabular-nums">
              {chf(rez)} <span className="text-muted-foreground text-xs">{pct(rez, revenue)}</span>
            </span>
          </div>
        )}
        {hasLief && (
          <div className="flex items-center justify-between">
            <span className="flex items-center gap-2 text-muted-foreground">
              <span className="h-2 w-2 rounded-full bg-blue-500 inline-block" />
              Lieferanten
            </span>
            <span className="font-medium tabular-nums">
              {chf(lief)} <span className="text-muted-foreground text-xs">{pct(lief, revenue)}</span>
            </span>
          </div>
        )}
        {hasBuch && (
          <div className="flex items-center justify-between">
            <span className="flex items-center gap-2 text-muted-foreground">
              <span className="h-2 w-2 rounded-full bg-emerald-500 inline-block" />
              Buchhaltung
            </span>
            <span className="font-medium tabular-nums">
              {chf(buch)} <span className="text-muted-foreground text-xs">{pct(buch, revenue)}</span>
            </span>
          </div>
        )}
      </div>
    </div>
  );
}

function AccountGroupTable({
  title, accounts, revenue, colorClass,
}: { title: string; accounts: AccountRow[]; revenue: number; colorClass: string }) {
  const total = accounts.reduce((s, a) => s + a.amount, 0);
  if (accounts.length === 0) return null;
  return (
    <div className="rounded-lg border overflow-hidden">
      <div className={`px-4 py-2 flex items-center justify-between ${colorClass}`}>
        <span className="font-semibold text-sm">{title}</span>
        <span className="text-sm font-medium tabular-nums">
          {chf(total)} {revenue > 0 && <span className="text-xs opacity-70">({pct(total, revenue)})</span>}
        </span>
      </div>
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b bg-muted/30">
            <th className="text-left px-4 py-2 font-medium text-muted-foreground">Konto</th>
            <th className="text-left px-4 py-2 font-medium text-muted-foreground">Bezeichnung</th>
            <th className="text-right px-4 py-2 font-medium text-muted-foreground">CHF (Jahr)</th>
            <th className="text-right px-4 py-2 font-medium text-muted-foreground">% Umsatz</th>
          </tr>
        </thead>
        <tbody>
          {accounts.map((a, i) => (
            <tr key={i} className="border-b last:border-0">
              <td className="px-4 py-2 font-mono text-xs text-muted-foreground">{a.code}</td>
              <td className="px-4 py-2">{a.label}</td>
              <td className="px-4 py-2 text-right tabular-nums font-medium">{chf(a.amount)}</td>
              <td className="px-4 py-2 text-right tabular-nums text-muted-foreground">{pct(a.amount, revenue)}</td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr className="bg-muted/30 font-semibold border-t">
            <td className="px-4 py-2" colSpan={2}>Total {title}</td>
            <td className="px-4 py-2 text-right tabular-nums">{chf(total)}</td>
            <td className="px-4 py-2 text-right tabular-nums text-muted-foreground">{pct(total, revenue)}</td>
          </tr>
        </tfoot>
      </table>
    </div>
  );
}

function NoDataHint({ children }: { children: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-dashed p-8 text-center text-muted-foreground">
      <HelpCircle className="h-8 w-8 mx-auto mb-3 opacity-40" />
      <p className="text-sm">{children}</p>
    </div>
  );
}

function ExplanationSection({ title, content }: { title: string; content: string }) {
  return (
    <div className="rounded-lg border p-5 space-y-2">
      <h3 className="font-semibold flex items-center gap-2">
        <Info className="h-4 w-4 text-primary" />
        {title}
      </h3>
      <p className="text-sm text-muted-foreground whitespace-pre-line leading-relaxed">{content}</p>
    </div>
  );
}

function ExplanationBlock({
  nr, color, title, what, use, check,
}: { nr: string; color: 'violet'|'blue'|'emerald'; title: string; what: string; use: string; check: string }) {
  const colorMap = {
    violet:  'bg-violet-100 text-violet-800',
    blue:    'bg-blue-100 text-blue-800',
    emerald: 'bg-emerald-100 text-emerald-800',
  };
  return (
    <div className="rounded-lg border p-5 space-y-3">
      <div className="flex items-center gap-2">
        <span className={`inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-xs font-bold ${colorMap[color]}`}>
          {nr}
        </span>
        <h4 className="font-semibold text-sm">{title}</h4>
      </div>
      <dl className="grid gap-2 text-sm">
        <div>
          <dt className="font-medium text-muted-foreground text-xs uppercase tracking-wide">Was wird gemessen</dt>
          <dd className="mt-0.5">{what}</dd>
        </div>
        <div>
          <dt className="font-medium text-muted-foreground text-xs uppercase tracking-wide">Wofür es nützt</dt>
          <dd className="mt-0.5">{use}</dd>
        </div>
        <div className="rounded-md bg-amber-50 border border-amber-200 p-3">
          <dt className="font-medium text-amber-800 text-xs uppercase tracking-wide">Was du prüfen solltest</dt>
          <dd className="mt-0.5 text-amber-900">{check}</dd>
        </div>
      </dl>
    </div>
  );
}
