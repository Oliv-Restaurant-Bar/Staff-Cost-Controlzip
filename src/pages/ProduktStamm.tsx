/**
 * ProduktStamm – Produkt-Stammdaten & WES pro Stück
 * ===================================================
 * Einfache Verwaltungsseite für WES-Kosten pro Produkt.
 *
 * Datenquelle: Supabase-Tabelle produkte_kosten
 *   name, category, wes (= wes_per_unit CHF)
 *
 * Funktionen:
 *   - Alle Produkte anzeigen + suchen
 *   - Inline-Bearbeitung von Name, Kategorie, WES
 *   - Neues Produkt erfassen
 *   - Aus Verkaufsdaten befüllen (übernimmt fehlende Namen aus product_sales)
 *   - Löschen einzelner Einträge
 */

import { useState, useEffect, useMemo, useRef } from 'react';
import { Navigate } from 'react-router-dom';
import { usePermissions } from '@/hooks/usePermissions';
import { useTenant } from '@/contexts/TenantContext';
import {
  Package, Plus, RefreshCw, Pencil, Trash2, Check, X,
  Download, Search, AlertTriangle, ChevronDown,
} from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { toast } from 'sonner';
import {
  loadProduktStamm,
  upsertProduktStamm,
  updateProduktStammRow,
  deleteProduktStammRow,
  loadNewNamesFromSales,
  type ProduktStammRow,
} from '@/lib/produkt-stamm-db';

// ─── Hilfsfunktionen ─────────────────────────────────────────────────────────

function fmtChf(v: number): string {
  return new Intl.NumberFormat('de-CH', {
    style: 'currency', currency: 'CHF', minimumFractionDigits: 2, maximumFractionDigits: 4,
  }).format(v);
}

function fmtDate(iso: string): string {
  if (!iso) return '–';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '–';
  return d.toLocaleDateString('de-CH');
}

const CATEGORY_LABELS: Record<string, string> = {
  food:     'Food',
  beverage: 'Beverage',
};

// ─── Inline-Edit-Zeile ───────────────────────────────────────────────────────

interface EditState {
  name:     string;
  category: 'food' | 'beverage';
  wes:      string;
}

function EditRow({
  row,
  onSave,
  onCancel,
}: {
  row: ProduktStammRow;
  onSave: (fields: { name: string; category: 'food' | 'beverage'; wes: number }) => Promise<void>;
  onCancel: () => void;
}) {
  const [state, setState] = useState<EditState>({
    name:     row.name,
    category: row.category,
    wes:      String(row.wes_per_unit),
  });
  const [saving, setSaving] = useState(false);
  const nameRef = useRef<HTMLInputElement>(null);

  useEffect(() => { nameRef.current?.focus(); }, []);

  async function handleSave() {
    const wesNum = parseFloat(state.wes.replace(',', '.'));
    if (!state.name.trim()) { toast.error('Name darf nicht leer sein'); return; }
    if (isNaN(wesNum) || wesNum < 0) { toast.error('WES muss eine Zahl ≥ 0 sein'); return; }
    setSaving(true);
    try {
      await onSave({ name: state.name.trim(), category: state.category, wes: wesNum });
    } finally {
      setSaving(false);
    }
  }

  return (
    <tr className="bg-primary/5 border-primary/30">
      <td className="px-3 py-1.5">
        <Input
          ref={nameRef}
          value={state.name}
          onChange={e => setState(s => ({ ...s, name: e.target.value }))}
          className="h-8 text-sm"
          onKeyDown={e => { if (e.key === 'Enter') handleSave(); if (e.key === 'Escape') onCancel(); }}
        />
      </td>
      <td className="px-3 py-1.5">
        <select
          value={state.category}
          onChange={e => setState(s => ({ ...s, category: e.target.value as 'food' | 'beverage' }))}
          className="h-8 text-sm w-full rounded-md border border-input bg-background px-2 focus:outline-none focus:ring-1 focus:ring-ring"
        >
          <option value="food">Food</option>
          <option value="beverage">Beverage</option>
        </select>
      </td>
      <td className="px-3 py-1.5">
        <Input
          type="number"
          min="0"
          step="0.01"
          value={state.wes}
          onChange={e => setState(s => ({ ...s, wes: e.target.value }))}
          className="h-8 text-sm text-right"
          onKeyDown={e => { if (e.key === 'Enter') handleSave(); if (e.key === 'Escape') onCancel(); }}
        />
      </td>
      <td className="px-3 py-1.5 text-xs text-muted-foreground">–</td>
      <td className="px-3 py-1.5">
        <div className="flex gap-1 justify-end">
          <Button size="sm" className="h-7 px-2.5 text-xs gap-1" onClick={handleSave} disabled={saving}>
            <Check className="h-3.5 w-3.5" />
            {saving ? 'Speichern…' : 'OK'}
          </Button>
          <Button size="sm" variant="ghost" className="h-7 px-2.5 text-xs" onClick={onCancel} disabled={saving}>
            <X className="h-3.5 w-3.5" />
          </Button>
        </div>
      </td>
    </tr>
  );
}

// ─── Neue-Zeile-Formular ─────────────────────────────────────────────────────

function NewRow({
  onSave,
  onCancel,
}: {
  onSave: (entry: { name: string; category: 'food' | 'beverage'; wes: number }) => Promise<void>;
  onCancel: () => void;
}) {
  const [state, setState] = useState<EditState>({ name: '', category: 'food', wes: '0' });
  const [saving, setSaving] = useState(false);
  const nameRef = useRef<HTMLInputElement>(null);
  useEffect(() => { nameRef.current?.focus(); }, []);

  async function handleSave() {
    const wesNum = parseFloat(state.wes.replace(',', '.'));
    if (!state.name.trim()) { toast.error('Name darf nicht leer sein'); return; }
    if (isNaN(wesNum) || wesNum < 0) { toast.error('WES muss eine Zahl ≥ 0 sein'); return; }
    setSaving(true);
    try {
      await onSave({ name: state.name.trim(), category: state.category, wes: wesNum });
    } finally {
      setSaving(false);
    }
  }

  return (
    <tr className="bg-emerald-50/50 dark:bg-emerald-950/20 border-emerald-200 dark:border-emerald-800">
      <td className="px-3 py-1.5">
        <Input
          ref={nameRef}
          placeholder="Produktname…"
          value={state.name}
          onChange={e => setState(s => ({ ...s, name: e.target.value }))}
          className="h-8 text-sm"
          onKeyDown={e => { if (e.key === 'Enter') handleSave(); if (e.key === 'Escape') onCancel(); }}
        />
      </td>
      <td className="px-3 py-1.5">
        <select
          value={state.category}
          onChange={e => setState(s => ({ ...s, category: e.target.value as 'food' | 'beverage' }))}
          className="h-8 text-sm w-full rounded-md border border-input bg-background px-2 focus:outline-none focus:ring-1 focus:ring-ring"
        >
          <option value="food">Food</option>
          <option value="beverage">Beverage</option>
        </select>
      </td>
      <td className="px-3 py-1.5">
        <Input
          type="number"
          min="0"
          step="0.01"
          value={state.wes}
          onChange={e => setState(s => ({ ...s, wes: e.target.value }))}
          className="h-8 text-sm text-right"
          onKeyDown={e => { if (e.key === 'Enter') handleSave(); if (e.key === 'Escape') onCancel(); }}
        />
      </td>
      <td className="px-3 py-1.5 text-xs text-muted-foreground">–</td>
      <td className="px-3 py-1.5">
        <div className="flex gap-1 justify-end">
          <Button size="sm" className="h-7 px-2.5 text-xs gap-1" onClick={handleSave} disabled={saving}>
            <Check className="h-3.5 w-3.5" />
            {saving ? '…' : 'Hinzufügen'}
          </Button>
          <Button size="sm" variant="ghost" className="h-7 px-2.5 text-xs" onClick={onCancel} disabled={saving}>
            <X className="h-3.5 w-3.5" />
          </Button>
        </div>
      </td>
    </tr>
  );
}

// ─── Hauptseite ───────────────────────────────────────────────────────────────

export default function ProduktStamm() {
  const { isAdmin } = usePermissions();
  const { tenantId } = useTenant();
  const restaurantId = tenantId ?? 'oliv';

  if (!isAdmin) return <Navigate to="/" replace />;

  const [rows,        setRows]        = useState<ProduktStammRow[]>([]);
  const [loading,     setLoading]     = useState(true);
  const [dbError,     setDbError]     = useState<string | null>(null);
  const [tableMissing, setTableMissing] = useState(false);
  const [editingId,   setEditingId]   = useState<number | null>(null);
  const [showNewRow,  setShowNewRow]  = useState(false);
  const [searchTerm,  setSearchTerm]  = useState('');
  const [catFilter,   setCatFilter]   = useState<'all' | 'food' | 'beverage'>('all');
  const [importing,   setImporting]   = useState(false);
  const [newNames,    setNewNames]    = useState<string[] | null>(null);

  // ── Laden ──────────────────────────────────────────────────────────────────

  async function load() {
    setLoading(true);
    setDbError(null);
    setTableMissing(false);
    try {
      const data = await loadProduktStamm(restaurantId);
      setRows(data);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('PGRST205') || msg.includes("Tabelle 'produkte_kosten' fehlt")) {
        setTableMissing(true);
      } else {
        setDbError(msg);
      }
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { load(); }, [restaurantId]);

  // ── Gefilterte Zeilen ──────────────────────────────────────────────────────

  const filteredRows = useMemo(() => {
    let r = rows;
    if (catFilter !== 'all') r = r.filter(x => x.category === catFilter);
    if (searchTerm.trim()) {
      const q = searchTerm.trim().toLowerCase();
      r = r.filter(x => x.name.toLowerCase().includes(q));
    }
    return r;
  }, [rows, catFilter, searchTerm]);

  // ── Statistik ──────────────────────────────────────────────────────────────

  const withWes    = rows.filter(r => r.wes_per_unit > 0).length;
  const withoutWes = rows.length - withWes;

  // ── Bearbeiten ─────────────────────────────────────────────────────────────

  async function handleEdit(
    row: ProduktStammRow,
    fields: { name: string; category: 'food' | 'beverage'; wes: number },
  ) {
    await updateProduktStammRow(row.id, {
      name:     fields.name,
      category: fields.category,
      wes:      fields.wes,
    });
    toast.success(`${fields.name} gespeichert`);
    setEditingId(null);
    await load();
  }

  // ── Neu ────────────────────────────────────────────────────────────────────

  async function handleNew(entry: { name: string; category: 'food' | 'beverage'; wes: number }) {
    await upsertProduktStamm({ name: entry.name, category: entry.category, wes: entry.wes, restaurant_id: restaurantId });
    toast.success(`${entry.name} hinzugefügt`);
    setShowNewRow(false);
    await load();
  }

  // ── Löschen ────────────────────────────────────────────────────────────────

  async function handleDelete(row: ProduktStammRow) {
    if (!window.confirm(`«${row.name}» wirklich löschen?`)) return;
    try {
      await deleteProduktStammRow(row.id);
      toast.success(`${row.name} gelöscht`);
      await load();
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : String(err));
    }
  }

  // ── Aus Verkaufsdaten befüllen ─────────────────────────────────────────────

  async function handleLoadFromSales() {
    setImporting(true);
    try {
      const names = await loadNewNamesFromSales(rows);
      if (names.length === 0) {
        toast.info('Alle Produkte aus den Verkaufsdaten sind bereits vorhanden');
        setNewNames([]);
        return;
      }
      setNewNames(names);
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setImporting(false);
    }
  }

  async function handleImportNames(names: string[], category: 'food' | 'beverage') {
    setImporting(true);
    try {
      let count = 0;
      for (const name of names) {
        await upsertProduktStamm({ name, category, wes: 0, restaurant_id: restaurantId });
        count++;
      }
      toast.success(`${count} Produkte importiert (WES = 0, bitte nachtragen)`);
      setNewNames(null);
      await load();
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setImporting(false);
    }
  }

  // ── Skeleton ───────────────────────────────────────────────────────────────

  if (loading) {
    return (
      <div className="p-6 space-y-4 max-w-5xl mx-auto">
        <div className="h-8 w-64 rounded bg-muted animate-pulse" />
        <div className="h-64 rounded-lg bg-muted animate-pulse" />
      </div>
    );
  }

  // ── Render ─────────────────────────────────────────────────────────────────

  return (
    <div className="p-4 md:p-6 space-y-5 max-w-5xl mx-auto">

      {/* Header */}
      <div className="flex items-center justify-between gap-4 flex-wrap">
        <div className="flex items-center gap-3">
          <div className="rounded-lg bg-emerald-100 dark:bg-emerald-950/40 p-2">
            <Package className="h-5 w-5 text-emerald-600 dark:text-emerald-400" />
          </div>
          <div>
            <h1 className="text-xl font-bold">Produkt-Stammdaten</h1>
            <p className="text-sm text-muted-foreground">
              WES pro Stück (CHF) für das Verkaufs-Dashboard
            </p>
          </div>
        </div>
        <div className="flex gap-2 flex-wrap">
          <Button
            variant="outline" size="sm"
            onClick={handleLoadFromSales}
            disabled={importing}
            className="gap-1.5 text-xs"
          >
            <Download className="h-3.5 w-3.5" />
            Aus Verkaufsdaten
          </Button>
          <Button variant="outline" size="sm" onClick={load} className="gap-1.5 text-xs">
            <RefreshCw className="h-3.5 w-3.5" />
            Aktualisieren
          </Button>
          <Button
            size="sm"
            onClick={() => { setShowNewRow(true); setEditingId(null); }}
            className="gap-1.5 text-xs"
            disabled={showNewRow}
          >
            <Plus className="h-3.5 w-3.5" />
            Neues Produkt
          </Button>
        </div>
      </div>

      {/* Tabelle fehlt → SQL-Migration hinweis */}
      {tableMissing && (
        <Card className="border-amber-300 bg-amber-50 dark:bg-amber-950/20">
          <CardContent className="py-4 flex items-start gap-3">
            <AlertTriangle className="h-4 w-4 text-amber-600 mt-0.5 shrink-0" />
            <div>
              <p className="font-semibold text-amber-800 dark:text-amber-400 text-sm">
                Datenbanktabelle fehlt
              </p>
              <p className="text-sm text-amber-700 dark:text-amber-300 mt-1">
                Die Tabelle <code className="font-mono bg-amber-100 dark:bg-amber-900/40 px-1 rounded">produkte_kosten</code> existiert noch nicht in Supabase.
              </p>
              <p className="text-xs text-muted-foreground mt-1">
                Bitte die Datei{' '}
                <code className="font-mono bg-muted px-1 rounded">
                  supabase/migrations/20260428_produkte_kosten_with_tenant.sql
                </code>{' '}
                im Supabase SQL-Editor ausführen.
              </p>
              <Button size="sm" variant="outline" className="mt-3 h-7 text-xs" onClick={load}>
                <RefreshCw className="h-3 w-3 mr-1" /> Nochmals versuchen
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Allgemeiner DB-Fehler */}
      {dbError && !tableMissing && (
        <Card className="border-red-300 bg-red-50 dark:bg-red-950/20">
          <CardContent className="py-4 flex items-start gap-3">
            <AlertTriangle className="h-4 w-4 text-red-500 mt-0.5 shrink-0" />
            <div>
              <p className="font-semibold text-red-700 dark:text-red-400 text-sm">Fehler beim Laden</p>
              <p className="text-xs text-red-500/70 font-mono mt-2">{dbError}</p>
              <Button size="sm" variant="outline" className="mt-2 h-7 text-xs" onClick={load}>Nochmals versuchen</Button>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Neue Namen aus product_sales */}
      {newNames !== null && newNames.length > 0 && (
        <Card className="border-indigo-200 dark:border-indigo-800 bg-indigo-50/40 dark:bg-indigo-950/10">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm text-indigo-700 dark:text-indigo-400">
              {newNames.length} neue Produkte aus Verkaufsdaten gefunden
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <p className="text-xs text-muted-foreground">
              Diese Produkte sind in den Verkaufsdaten vorhanden, aber noch nicht im Stamm.
              WES wird auf 0 gesetzt — danach bitte nachtragen.
            </p>
            <div className="max-h-40 overflow-y-auto space-y-0.5 rounded border border-border/40 bg-background/50 p-2">
              {newNames.slice(0, 50).map(n => (
                <p key={n} className="text-xs truncate">{n}</p>
              ))}
              {newNames.length > 50 && (
                <p className="text-xs text-muted-foreground">… und {newNames.length - 50} weitere</p>
              )}
            </div>
            <div className="flex gap-2 flex-wrap">
              <Button
                size="sm" className="h-7 text-xs gap-1"
                onClick={() => handleImportNames(newNames, 'food')}
                disabled={importing}
              >
                Als Food importieren
              </Button>
              <Button
                size="sm" variant="outline" className="h-7 text-xs gap-1"
                onClick={() => handleImportNames(newNames, 'beverage')}
                disabled={importing}
              >
                Als Beverage importieren
              </Button>
              <Button
                size="sm" variant="ghost" className="h-7 text-xs"
                onClick={() => setNewNames(null)}
              >
                Abbrechen
              </Button>
            </div>
          </CardContent>
        </Card>
      )}
      {newNames !== null && newNames.length === 0 && (
        <div className="text-sm text-emerald-600 dark:text-emerald-400 font-medium">
          Alle Produkte aus den Verkaufsdaten sind bereits im Stamm vorhanden.
        </div>
      )}

      {/* Statistik + Filter + Tabelle: nur anzeigen wenn Tabelle existiert */}
      {!tableMissing && (<>

      {/* Statistik */}
      <div className="grid grid-cols-3 gap-3">
        <Card>
          <CardContent className="pt-4 pb-3">
            <p className="text-[11px] text-muted-foreground uppercase tracking-wide">Produkte total</p>
            <p className="text-2xl font-bold tabular-nums">{rows.length}</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-4 pb-3">
            <p className="text-[11px] text-muted-foreground uppercase tracking-wide">Mit WES</p>
            <p className="text-2xl font-bold tabular-nums text-emerald-600 dark:text-emerald-400">{withWes}</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-4 pb-3">
            <p className="text-[11px] text-muted-foreground uppercase tracking-wide">Ohne WES</p>
            <p className="text-2xl font-bold tabular-nums text-amber-600 dark:text-amber-400">{withoutWes}</p>
          </CardContent>
        </Card>
      </div>

      {/* Filter & Suche */}
      <div className="flex gap-2 items-center flex-wrap">
        <div className="relative flex-1 min-w-[180px]">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
          <Input
            placeholder="Produkt suchen…"
            value={searchTerm}
            onChange={e => setSearchTerm(e.target.value)}
            className="pl-8 h-8 text-sm"
          />
        </div>
        {(['all', 'food', 'beverage'] as const).map(cat => (
          <Button
            key={cat}
            size="sm"
            variant={catFilter === cat ? 'default' : 'outline'}
            className="h-8 text-xs"
            onClick={() => setCatFilter(cat)}
          >
            {cat === 'all' ? 'Alle' : CATEGORY_LABELS[cat]}
          </Button>
        ))}
        <span className="text-xs text-muted-foreground ml-auto">
          {filteredRows.length} von {rows.length}
        </span>
      </div>

      {/* Tabelle */}
      <Card>
        <CardContent className="p-0">
          {rows.length === 0 && !showNewRow ? (
            <div className="py-16 text-center">
              <Package className="h-10 w-10 text-muted-foreground mx-auto mb-3" />
              <p className="font-medium">Noch keine Produkte erfasst</p>
              <p className="text-sm text-muted-foreground mt-1">
                «Neues Produkt» oder «Aus Verkaufsdaten» verwenden
              </p>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border">
                    <th className="px-3 py-2.5 text-left text-[11px] font-semibold text-muted-foreground uppercase tracking-wide">Produktname</th>
                    <th className="px-3 py-2.5 text-left text-[11px] font-semibold text-muted-foreground uppercase tracking-wide">Kategorie</th>
                    <th className="px-3 py-2.5 text-right text-[11px] font-semibold text-muted-foreground uppercase tracking-wide">WES pro Stück (CHF)</th>
                    <th className="px-3 py-2.5 text-left text-[11px] font-semibold text-muted-foreground uppercase tracking-wide">Aktualisiert</th>
                    <th className="px-3 py-2.5 text-right text-[11px] font-semibold text-muted-foreground uppercase tracking-wide">Aktionen</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border/40">

                  {/* Neue-Zeile-Formular oben */}
                  {showNewRow && (
                    <NewRow
                      onSave={handleNew}
                      onCancel={() => setShowNewRow(false)}
                    />
                  )}

                  {filteredRows.map(row => (
                    editingId === row.id ? (
                      <EditRow
                        key={row.id}
                        row={row}
                        onSave={fields => handleEdit(row, fields)}
                        onCancel={() => setEditingId(null)}
                      />
                    ) : (
                      <tr key={row.id} className="hover:bg-muted/30 transition-colors group">
                        <td className="px-3 py-2.5 font-medium max-w-[260px] truncate" title={row.name}>
                          {row.name}
                        </td>
                        <td className="px-3 py-2.5">
                          <Badge
                            variant="outline"
                            className={
                              row.category === 'food'
                                ? 'text-[10px] font-normal border-orange-200 text-orange-700 dark:border-orange-800 dark:text-orange-400'
                                : 'text-[10px] font-normal border-blue-200 text-blue-700 dark:border-blue-800 dark:text-blue-400'
                            }
                          >
                            {CATEGORY_LABELS[row.category] ?? row.category}
                          </Badge>
                        </td>
                        <td className="px-3 py-2.5 text-right tabular-nums">
                          {row.wes_per_unit > 0 ? (
                            <span className="font-semibold">{fmtChf(row.wes_per_unit)}</span>
                          ) : (
                            <span className="text-muted-foreground text-xs italic">kein WES</span>
                          )}
                        </td>
                        <td className="px-3 py-2.5 text-xs text-muted-foreground">
                          {fmtDate(row.updated_at)}
                        </td>
                        <td className="px-3 py-2.5">
                          <div className="flex gap-1 justify-end opacity-0 group-hover:opacity-100 transition-opacity">
                            <Button
                              size="sm" variant="ghost"
                              className="h-7 w-7 p-0"
                              onClick={() => { setEditingId(row.id); setShowNewRow(false); }}
                              title="Bearbeiten"
                            >
                              <Pencil className="h-3.5 w-3.5" />
                            </Button>
                            <Button
                              size="sm" variant="ghost"
                              className="h-7 w-7 p-0 text-destructive hover:text-destructive"
                              onClick={() => handleDelete(row)}
                              title="Löschen"
                            >
                              <Trash2 className="h-3.5 w-3.5" />
                            </Button>
                          </div>
                        </td>
                      </tr>
                    )
                  ))}

                  {filteredRows.length === 0 && rows.length > 0 && !showNewRow && (
                    <tr>
                      <td colSpan={5} className="px-3 py-8 text-center text-sm text-muted-foreground">
                        Keine Produkte für diesen Filter
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Hinweis */}
      <p className="text-[11px] text-muted-foreground">
        WES pro Stück wird im Verkaufs-Dashboard mit der verkauften Menge multipliziert,
        um den Gesamt-Wareneinsatz zu berechnen. Matching erfolgt über den exakten Produktnamen (Gross-/Kleinschreibung ignoriert).
      </p>

      </>)}

    </div>
  );
}
