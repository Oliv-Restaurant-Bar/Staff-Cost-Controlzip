/**
 * Artikelstamm (Stage 1)
 * =======================
 * Zentrale Datenbank für alle Food- und Beverage-Artikel.
 * Dient als Grundlage für Rezeptkosten, Lieferantenrechnungen,
 * Inventur und theoretischen Warenbestand.
 */

import { useEffect, useState, useMemo, Fragment } from 'react';
import { Link } from 'react-router-dom';
import { toast } from 'sonner';
import {
  Plus, Pencil, Trash2, Search, X, Package, Wine,
  ChevronDown, ChevronUp, Eye, EyeOff, Info,
  MapPin, LayoutList, Layers, Star, ClipboardList, Activity, ExternalLink,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Switch } from '@/components/ui/switch';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from '@/components/ui/dialog';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import { Label } from '@/components/ui/label';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Tooltip, TooltipContent, TooltipTrigger,
} from '@/components/ui/tooltip';
import {
  Artikel,
  ArtikelStore,
  InventoryType,
  ALL_STORAGE_LOCATIONS,
  STORAGE_LOCATIONS_FOOD,
  STORAGE_LOCATIONS_BEVERAGE,
  UNITS_FOOD,
  UNITS_BEVERAGE,
  FIBU_ACCOUNTS,
  getFibuLabel,
  createArtikel,
  updateArtikel,
  filterArtikel,
  getArtikelStats,
  loadArtikelFromDB,
  saveArtikelToDB,
} from '@/lib/artikel-store';

// ── Hilfsfunktionen ───────────────────────────────────────────────────────────

function fmtChf(n: number) {
  return n > 0 ? `CHF ${n.toFixed(4)}` : '–';
}

// ── Leerer Artikel (für Create) ───────────────────────────────────────────────

function emptyForm(): Omit<Artikel, 'id' | 'createdAt' | 'updatedAt'> {
  return {
    name:               '',
    inventoryType:      'food',
    unit:               'kg',
    defaultCostPerUnit: 0,
    standardSupplier:   '',
    fallbackEnabled:    false,
    fallbackSupplier:   '',
    fallbackPrice:      0,
    accountingAccount:  '4090',
    storageLocations:   [],
    inventurRelevant:   false,
    trackingAktiv:      false,
    active:             true,
  };
}

// ── Artikel-Dialog (Create / Edit) ────────────────────────────────────────────

interface ArtikelDialogProps {
  open: boolean;
  initial?: Artikel | null;
  onSave: (data: Omit<Artikel, 'id' | 'createdAt' | 'updatedAt'>) => void;
  onClose: () => void;
}

function ArtikelDialog({ open, initial, onSave, onClose }: ArtikelDialogProps) {
  const isEdit = !!initial;
  const [form, setForm] = useState(emptyForm);
  const [customUnit, setCustomUnit] = useState('');
  const [unitMode, setUnitMode] = useState<'list' | 'custom'>('list');

  useEffect(() => {
    if (open) {
      if (initial) {
        const units = initial.inventoryType === 'food' ? UNITS_FOOD : UNITS_BEVERAGE;
        const knownUnit = units.includes(initial.unit);
        setForm({
          name:               initial.name,
          inventoryType:      initial.inventoryType,
          unit:               initial.unit,
          defaultCostPerUnit: initial.defaultCostPerUnit,
          standardSupplier:   initial.standardSupplier  ?? '',
          fallbackEnabled:    initial.fallbackEnabled   ?? false,
          fallbackSupplier:   initial.fallbackSupplier  ?? '',
          fallbackPrice:      initial.fallbackPrice      ?? 0,
          accountingAccount:  initial.accountingAccount ?? '',
          storageLocations:   initial.storageLocations,
          inventurRelevant:   initial.inventurRelevant ?? false,
          trackingAktiv:      (initial as Record<string, unknown>).trackingAktiv as boolean ?? false,
          active:             initial.active,
        });
        setUnitMode(knownUnit ? 'list' : 'custom');
        setCustomUnit(knownUnit ? '' : initial.unit);
      } else {
        setForm(emptyForm());
        setUnitMode('list');
        setCustomUnit('');
      }
    }
  }, [open, initial]);

  const unitOptions = form.inventoryType === 'food' ? UNITS_FOOD : UNITS_BEVERAGE;
  const locations   = form.inventoryType === 'food'
    ? [...STORAGE_LOCATIONS_FOOD]
    : [...STORAGE_LOCATIONS_BEVERAGE];

  function handleTypeChange(t: InventoryType) {
    const newLocations = form.storageLocations.filter(l =>
      (t === 'food' ? STORAGE_LOCATIONS_FOOD : STORAGE_LOCATIONS_BEVERAGE)
        .includes(l as any)
    );
    const firstUnit = t === 'food' ? UNITS_FOOD[0] : UNITS_BEVERAGE[0];
    setForm(f => ({
      ...f,
      inventoryType:    t,
      storageLocations: newLocations,
      unit:             firstUnit,
    }));
    setUnitMode('list');
    setCustomUnit('');
  }

  function toggleLocation(loc: string) {
    setForm(f => ({
      ...f,
      storageLocations: f.storageLocations.includes(loc)
        ? f.storageLocations.filter(l => l !== loc)
        : [...f.storageLocations, loc],
    }));
  }

  function handleSubmit() {
    if (!form.name.trim()) { toast.error('Name ist erforderlich'); return; }
    const effectiveUnit = unitMode === 'custom'
      ? customUnit.trim() || 'Stück'
      : form.unit;
    const effectiveAccount = form.accountingAccount || '4090';
    onSave({ ...form, unit: effectiveUnit, accountingAccount: effectiveAccount });
  }

  return (
    <Dialog open={open} onOpenChange={v => !v && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{isEdit ? 'Artikel bearbeiten' : 'Neuer Artikel'}</DialogTitle>
        </DialogHeader>

        <div className="space-y-4 py-2">

          {/* Artikelname */}
          <div className="space-y-1">
            <Label>Artikelname *</Label>
            <Input
              placeholder="z.B. Rindsentrecôte, Prosecco Hausmarke"
              value={form.name}
              onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
            />
          </div>

          {/* Typ: Food / Beverage */}
          <div className="space-y-1">
            <Label>Kategorie</Label>
            <div className="flex gap-2">
              <button
                onClick={() => handleTypeChange('food')}
                className={`flex-1 flex items-center justify-center gap-2 py-2 px-3 rounded-md border text-sm font-medium transition-colors ${
                  form.inventoryType === 'food'
                    ? 'bg-emerald-600 text-white border-emerald-600'
                    : 'border-border text-muted-foreground hover:bg-accent'
                }`}
              >
                <Package className="h-4 w-4" /> Food
              </button>
              <button
                onClick={() => handleTypeChange('beverage')}
                className={`flex-1 flex items-center justify-center gap-2 py-2 px-3 rounded-md border text-sm font-medium transition-colors ${
                  form.inventoryType === 'beverage'
                    ? 'bg-blue-600 text-white border-blue-600'
                    : 'border-border text-muted-foreground hover:bg-accent'
                }`}
              >
                <Wine className="h-4 w-4" /> Beverage
              </button>
            </div>
          </div>

          {/* Einheit */}
          <div className="space-y-1">
            <Label>Einheit</Label>
            <div className="flex gap-2">
              {unitMode === 'list' ? (
                <>
                  <Select
                    value={form.unit}
                    onValueChange={v => setForm(f => ({ ...f, unit: v }))}
                  >
                    <SelectTrigger className="flex-1">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {unitOptions.map(u => (
                        <SelectItem key={u} value={u}>{u}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <Button variant="outline" size="sm" onClick={() => setUnitMode('custom')}>
                    Andere
                  </Button>
                </>
              ) : (
                <>
                  <Input
                    placeholder="z.B. Portion, Box, Sack"
                    value={customUnit}
                    onChange={e => setCustomUnit(e.target.value)}
                    className="flex-1"
                  />
                  <Button variant="outline" size="sm" onClick={() => setUnitMode('list')}>
                    Liste
                  </Button>
                </>
              )}
            </div>
          </div>

          {/* ── Lieferant ─────────────────────────────────────────────── */}
          <div className="rounded-lg border border-border p-3 space-y-3">
            <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              Standard-Lieferant
            </p>

            {/* Lieferantenname */}
            <div className="space-y-1">
              <Label>Lieferant</Label>
              <Input
                placeholder="z.B. Pistor, Kneuss, Metro"
                value={form.standardSupplier}
                onChange={e => setForm(f => ({ ...f, standardSupplier: e.target.value }))}
              />
            </div>

            {/* Standardpreis – immer NETTO */}
            <div className="space-y-1">
              <div className="flex items-center justify-between">
                <Label>Standardpreis / Einheit</Label>
                <span className="text-xs font-medium text-blue-600 dark:text-blue-400 bg-blue-50 dark:bg-blue-950/40 px-1.5 py-0.5 rounded border border-blue-200 dark:border-blue-800">
                  NETTO exkl. MwSt.
                </span>
              </div>
              <div className="relative">
                <span className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground text-sm">CHF</span>
                <Input
                  type="number"
                  min="0"
                  step="0.0001"
                  placeholder="0.0000"
                  value={form.defaultCostPerUnit || ''}
                  onChange={e => setForm(f => ({ ...f, defaultCostPerUnit: parseFloat(e.target.value) || 0 }))}
                  className="pl-12"
                />
              </div>
            </div>

            {/* Ausweichlieferant aktiv? */}
            <label className="flex items-center gap-2 cursor-pointer pt-1">
              <Checkbox
                checked={form.fallbackEnabled}
                onCheckedChange={v => setForm(f => ({ ...f, fallbackEnabled: !!v }))}
              />
              <span className="text-sm font-medium">Ausweichlieferant aktiv</span>
            </label>

            {/* Ausweich-Felder — nur wenn aktiviert */}
            {form.fallbackEnabled && (
              <div className="space-y-3 pl-6 border-l-2 border-amber-300 dark:border-amber-700">
                <p className="text-xs text-amber-700 dark:text-amber-400">
                  Wird verwendet wenn der Standard-Lieferant nicht liefern kann.
                </p>

                <div className="space-y-1">
                  <Label>Ausweich-Lieferant</Label>
                  <Input
                    placeholder="z.B. Aligro, Lekkerland"
                    value={form.fallbackSupplier}
                    onChange={e => setForm(f => ({ ...f, fallbackSupplier: e.target.value }))}
                  />
                </div>

                <div className="space-y-1">
                  <div className="flex items-center justify-between">
                    <Label>Ausweich-Preis / Einheit</Label>
                    <span className="text-xs font-medium text-blue-600 dark:text-blue-400 bg-blue-50 dark:bg-blue-950/40 px-1.5 py-0.5 rounded border border-blue-200 dark:border-blue-800">
                      NETTO exkl. MwSt.
                    </span>
                  </div>
                  <div className="relative">
                    <span className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground text-sm">CHF</span>
                    <Input
                      type="number"
                      min="0"
                      step="0.0001"
                      placeholder="0.0000"
                      value={form.fallbackPrice || ''}
                      onChange={e => setForm(f => ({ ...f, fallbackPrice: parseFloat(e.target.value) || 0 }))}
                      className="pl-12"
                    />
                  </div>
                </div>
              </div>
            )}
          </div>

          {/* ── Fibu-Konto ────────────────────────────────────────────── */}
          <div className="space-y-1">
            <div className="flex items-center justify-between">
              <Label>Fibu-Konto (WES-Zuordnung)</Label>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Info className="h-3.5 w-3.5 text-muted-foreground cursor-help" />
                </TooltipTrigger>
                <TooltipContent side="top" className="max-w-xs text-left">
                  <p className="font-semibold mb-1">Wozu dient das Konto?</p>
                  <p className="text-xs">
                    Ermöglicht den Vergleich zwischen Rezept-WES, Lieferanten-WES und
                    dem Buchhaltungs-WES auf Kontenebene. Alle Werte werden netto verglichen.
                  </p>
                </TooltipContent>
              </Tooltip>
            </div>
            <Select
              value={form.accountingAccount || '4090'}
              onValueChange={v => setForm(f => ({ ...f, accountingAccount: v }))}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {FIBU_ACCOUNTS.map(acc => (
                  <SelectItem key={acc.code} value={acc.code}>
                    {acc.code} {acc.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-[11px] text-muted-foreground">
              Pflichtfeld · Wird als Quelle für WES-Analyse und Rezepturkosten verwendet.
            </p>
          </div>

          {/* Lagerorte */}
          <div className="space-y-2">
            <Label>Lagerorte</Label>
            <div className="flex flex-wrap gap-2">
              {locations.map(loc => (
                <label key={loc} className="flex items-center gap-1.5 cursor-pointer">
                  <Checkbox
                    checked={form.storageLocations.includes(loc)}
                    onCheckedChange={() => toggleLocation(loc)}
                  />
                  <span className="text-sm">{loc}</span>
                </label>
              ))}
            </div>
            <p className="text-xs text-muted-foreground">
              Ein Artikel kann in mehreren Lagerorten vorkommen.
            </p>
          </div>

          {/* Inventur-relevant */}
          <div className="flex items-start gap-3 rounded-lg border border-amber-200 bg-amber-50 dark:bg-amber-950/20 dark:border-amber-800 p-3">
            <Checkbox
              id="inventurRelevant"
              checked={form.inventurRelevant}
              onCheckedChange={v => setForm(f => ({ ...f, inventurRelevant: v === true }))}
              className="mt-0.5"
            />
            <div>
              <label htmlFor="inventurRelevant" className="text-sm font-medium cursor-pointer flex items-center gap-1.5">
                <Star className="h-3.5 w-3.5 text-amber-500 fill-amber-400" />
                Inventur-relevant
              </label>
              <p className="text-xs text-muted-foreground mt-0.5">
                Artikel wird bei der Inventur und im Lieferanten-Modul speziell hervorgehoben.
                Geeignet für teure Artikel, Grundzutaten (Öl, Rahm, Butter) oder Artikel ohne vollständige Rezepterfassung.
              </p>
            </div>
          </div>

          {/* Tracking aktiv */}
          <div className="flex items-start gap-3 rounded-lg border border-violet-200 bg-violet-50 dark:bg-violet-950/20 dark:border-violet-800 p-3">
            <Checkbox
              id="trackingAktiv"
              checked={form.trackingAktiv}
              onCheckedChange={v => setForm(f => ({ ...f, trackingAktiv: v === true }))}
              className="mt-0.5"
            />
            <div>
              <label htmlFor="trackingAktiv" className="text-sm font-medium cursor-pointer flex items-center gap-1.5">
                <Activity className="h-3.5 w-3.5 text-violet-600" />
                Tracking aktiv
                <span className="text-[10px] font-normal text-violet-500 ml-1">Verbrauch & Einkauf analysieren</span>
              </label>
              <p className="text-xs text-muted-foreground mt-0.5">
                Einkäufe manuell erfassen und monatlich auswerten: Menge, Kosten, Bestellfrequenz und
                theoretischer Verbrauch aus Rezepturen. Ideal für kritische oder hochpreisige Artikel.
              </p>
            </div>
          </div>

          {/* Aktiv */}
          <div className="flex items-center justify-between">
            <div>
              <Label>Aktiv</Label>
              <p className="text-xs text-muted-foreground">Inaktive Artikel werden ausgeblendet</p>
            </div>
            <Switch
              checked={form.active}
              onCheckedChange={v => setForm(f => ({ ...f, active: v }))}
            />
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Abbrechen</Button>
          <Button onClick={handleSubmit}>
            {isEdit ? 'Speichern' : 'Artikel erstellen'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ── Hauptseite ────────────────────────────────────────────────────────────────

export default function ArtikelPage() {
  const [store, setStore]               = useState<ArtikelStore>({ articles: [], updatedAt: '' });
  const [loading, setLoading]           = useState(true);
  const [dialogOpen, setDialogOpen]     = useState(false);
  const [editArtikel, setEditArtikel]   = useState<Artikel | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<Artikel | null>(null);

  // Filter-State
  const [typeFilter, setTypeFilter]     = useState<InventoryType | 'all'>('all');
  const [locationFilter, setLocationFilter] = useState<string | null>(null);
  const [searchQuery, setSearchQuery]   = useState('');
  const [showInactive, setShowInactive] = useState(false);
  const [inventurFilter, setInventurFilter] = useState(false);
  const [trackingFilter, setTrackingFilter]  = useState(false);
  const [sortField, setSortField]       = useState<'name' | 'cost' | 'type'>('name');
  const [sortDir, setSortDir]           = useState<'asc' | 'desc'>('asc');

  // Laden beim Start
  useEffect(() => {
    loadArtikelFromDB()
      .then(s => setStore(s))
      .finally(() => setLoading(false));
  }, []);

  async function persist(updated: ArtikelStore) {
    setStore(updated);
    await saveArtikelToDB(updated);
  }

  function handleSave(data: Omit<Artikel, 'id' | 'createdAt' | 'updatedAt'>) {
    let newArticles: Artikel[];
    if (editArtikel) {
      newArticles = store.articles.map(a =>
        a.id === editArtikel.id ? updateArtikel(a, data) : a
      );
      toast.success('Artikel gespeichert');
    } else {
      newArticles = [...store.articles, createArtikel(data)];
      toast.success('Artikel erstellt');
    }
    persist({ articles: newArticles, updatedAt: new Date().toISOString() });
    setDialogOpen(false);
    setEditArtikel(null);
  }

  function handleDelete(a: Artikel) {
    const newArticles = store.articles.filter(x => x.id !== a.id);
    persist({ articles: newArticles, updatedAt: new Date().toISOString() });
    setConfirmDelete(null);
    toast.success(`"${a.name}" gelöscht`);
  }

  function handleToggleActive(a: Artikel) {
    const updated = updateArtikel(a, { active: !a.active });
    const newArticles = store.articles.map(x => x.id === a.id ? updated : x);
    persist({ articles: newArticles, updatedAt: new Date().toISOString() });
  }

  function openEdit(a: Artikel) {
    setEditArtikel(a);
    setDialogOpen(true);
  }

  function openCreate() {
    setEditArtikel(null);
    setDialogOpen(true);
  }

  function toggleSort(field: typeof sortField) {
    if (sortField === field) {
      setSortDir(d => d === 'asc' ? 'desc' : 'asc');
    } else {
      setSortField(field);
      setSortDir('asc');
    }
  }

  // ── Inventar-Ansicht ────────────────────────────────────────────────────────
  const [inventoryView, setInventoryView] = useState<'artikel' | 'lagerort'>('artikel');
  const [expandedRows,  setExpandedRows]  = useState<Set<string>>(new Set());

  function toggleRow(id: string) {
    setExpandedRows(prev => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  }

  // Sichtbare Lagerorte basierend auf Typ-Filter
  const visibleLocations = useMemo(() => {
    if (typeFilter === 'food')     return [...STORAGE_LOCATIONS_FOOD];
    if (typeFilter === 'beverage') return [...STORAGE_LOCATIONS_BEVERAGE];
    return [...ALL_STORAGE_LOCATIONS];
  }, [typeFilter]);

  // Gefilterte Liste
  const filtered = useMemo(() => {
    let list = filterArtikel(store.articles, {
      inventoryType:        typeFilter,
      storageLocation:      locationFilter,
      search:               searchQuery,
      showInactive,
      onlyInventurRelevant: inventurFilter,
      onlyTracking:         trackingFilter,
    });

    list = [...list].sort((a, b) => {
      let cmp = 0;
      if (sortField === 'name') cmp = a.name.localeCompare(b.name, 'de');
      if (sortField === 'cost') cmp = a.defaultCostPerUnit - b.defaultCostPerUnit;
      if (sortField === 'type') cmp = a.inventoryType.localeCompare(b.inventoryType);
      return sortDir === 'desc' ? -cmp : cmp;
    });
    return list;
  }, [store.articles, typeFilter, locationFilter, searchQuery, showInactive, inventurFilter, trackingFilter, sortField, sortDir]);

  const stats = useMemo(() => getArtikelStats(store.articles), [store.articles]);

  // Gruppiert nach Lagerort — für "Nach Lagerort"-Ansicht
  const byLocation = useMemo(() => {
    const map = new Map<string, Artikel[]>();
    const orderedLocs = typeFilter === 'food'
      ? [...STORAGE_LOCATIONS_FOOD]
      : typeFilter === 'beverage'
      ? [...STORAGE_LOCATIONS_BEVERAGE]
      : [...ALL_STORAGE_LOCATIONS];

    for (const loc of orderedLocs) {
      const arts = filtered.filter(a => a.storageLocations.includes(loc));
      if (arts.length > 0) map.set(loc, arts);
    }
    // Artikel ohne Lagerort
    const withoutLoc = filtered.filter(a => a.storageLocations.length === 0);
    if (withoutLoc.length > 0) map.set('(kein Lagerort)', withoutLoc);
    return map;
  }, [filtered, typeFilter]);

  function SortIcon({ field }: { field: typeof sortField }) {
    if (sortField !== field) return <span className="text-muted-foreground/30 ml-1">↕</span>;
    return <span className="ml-1">{sortDir === 'asc' ? '↑' : '↓'}</span>;
  }

  return (
    <div className="flex flex-col min-h-screen bg-background">

      {/* ── Kopfbereich ─────────────────────────────────────────────────────── */}
      <div className="sticky top-0 z-10 bg-background border-b px-4 pt-4 pb-3 space-y-3">

        {/* Titel + Button */}
        <div className="flex items-center justify-between gap-3">
          <div>
            <h1 className="text-xl font-bold tracking-tight">Artikelstamm</h1>
            <p className="text-xs text-muted-foreground">
              {stats.total} Artikel · {stats.active} aktiv · {stats.food} Food · {stats.beverage} Beverage
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Tooltip>
              <TooltipTrigger asChild>
                <Button variant="ghost" size="icon" className="text-muted-foreground">
                  <Info className="h-4 w-4" />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="bottom" className="max-w-xs text-left">
                <p className="font-semibold mb-1">Was ist der Artikelstamm?</p>
                <p className="text-xs">
                  Zentrale Datenbank aller Zutaten und Getränke.
                  Wird später für Rezeptkosten, Lieferantenrechnungen und Inventur verwendet.
                </p>
              </TooltipContent>
            </Tooltip>
            <Button onClick={openCreate} className="bg-emerald-600 hover:bg-emerald-700 text-white">
              <Plus className="h-4 w-4 mr-1" /> Neuer Artikel
            </Button>
          </div>
        </div>

        {/* Typ-Filter Tabs */}
        <div className="flex gap-1.5">
          {([['all', 'Alle'], ['food', 'Food'], ['beverage', 'Beverage']] as const).map(([val, label]) => (
            <button
              key={val}
              onClick={() => { setTypeFilter(val); setLocationFilter(null); }}
              className={`px-3 py-1 rounded-md text-sm font-medium transition-colors ${
                typeFilter === val
                  ? 'bg-primary text-primary-foreground'
                  : 'text-muted-foreground hover:bg-accent'
              }`}
            >
              {label}
              {val === 'food'     && <span className="ml-1 text-xs opacity-70">({stats.food})</span>}
              {val === 'beverage' && <span className="ml-1 text-xs opacity-70">({stats.beverage})</span>}
              {val === 'all'      && <span className="ml-1 text-xs opacity-70">({stats.total})</span>}
            </button>
          ))}
        </div>

        {/* Suche + Lagerorte + Inaktive */}
        <div className="flex flex-wrap gap-2 items-center">
          <div className="relative flex-1 min-w-48">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
            <Input
              placeholder="Artikel suchen…"
              value={searchQuery}
              onChange={e => setSearchQuery(e.target.value)}
              className="pl-8 h-8 text-sm"
            />
            {searchQuery && (
              <button onClick={() => setSearchQuery('')} className="absolute right-2 top-1/2 -translate-y-1/2">
                <X className="h-3.5 w-3.5 text-muted-foreground" />
              </button>
            )}
          </div>

          {/* Lagerorte */}
          <div className="flex gap-1 flex-wrap">
            {visibleLocations.map(loc => (
              <button
                key={loc}
                onClick={() => setLocationFilter(locationFilter === loc ? null : loc)}
                className={`px-2 py-0.5 rounded text-xs border transition-colors ${
                  locationFilter === loc
                    ? 'bg-primary text-primary-foreground border-primary'
                    : 'border-border text-muted-foreground hover:bg-accent'
                }`}
              >
                {loc}
              </button>
            ))}
          </div>

          <button
            onClick={() => setShowInactive(v => !v)}
            className={`flex items-center gap-1 text-xs px-2 py-1 rounded border transition-colors ${
              showInactive
                ? 'bg-amber-100 text-amber-700 border-amber-200 dark:bg-amber-950/40 dark:text-amber-300'
                : 'border-border text-muted-foreground hover:bg-accent'
            }`}
          >
            {showInactive ? <Eye className="h-3.5 w-3.5" /> : <EyeOff className="h-3.5 w-3.5" />}
            Inaktive
          </button>

          {stats.inventurCount > 0 && (
            <button
              onClick={() => { setInventurFilter(v => !v); setTrackingFilter(false); }}
              className={`flex items-center gap-1.5 text-xs px-2.5 py-1 rounded border transition-colors ${
                inventurFilter
                  ? 'bg-amber-100 text-amber-700 border-amber-300 dark:bg-amber-950/40 dark:text-amber-300 font-medium'
                  : 'border-border text-muted-foreground hover:bg-accent'
              }`}
            >
              <Star className={`h-3.5 w-3.5 ${inventurFilter ? 'fill-amber-500 text-amber-500' : ''}`} />
              Inventur-relevante
              <span className="bg-amber-200 dark:bg-amber-800 text-amber-800 dark:text-amber-200 rounded-full px-1.5 py-px text-[10px] font-bold">
                {stats.inventurCount}
              </span>
            </button>
          )}

          {stats.trackingCount > 0 && (
            <button
              onClick={() => { setTrackingFilter(v => !v); setInventurFilter(false); }}
              className={`flex items-center gap-1.5 text-xs px-2.5 py-1 rounded border transition-colors ${
                trackingFilter
                  ? 'bg-violet-100 text-violet-700 border-violet-300 dark:bg-violet-950/40 dark:text-violet-300 font-medium'
                  : 'border-border text-muted-foreground hover:bg-accent'
              }`}
            >
              <Activity className={`h-3.5 w-3.5 ${trackingFilter ? 'text-violet-600' : ''}`} />
              Tracking aktiv
              <span className="bg-violet-200 dark:bg-violet-800 text-violet-800 dark:text-violet-200 rounded-full px-1.5 py-px text-[10px] font-bold">
                {stats.trackingCount}
              </span>
            </button>
          )}

          {stats.trackingCount > 0 && (
            <Link to="/artikel-tracking">
              <button className="flex items-center gap-1.5 text-xs px-2.5 py-1 rounded border border-violet-300 text-violet-700 bg-violet-50 hover:bg-violet-100 transition-colors dark:border-violet-700 dark:text-violet-300 dark:bg-violet-950/20">
                <ExternalLink className="h-3 w-3" />
                Tracking-Analyse
              </button>
            </Link>
          )}

          {/* Ansichts-Toggle */}
          <div className="flex items-center bg-muted rounded-lg p-0.5 gap-0.5 ml-auto">
            <button
              onClick={() => setInventoryView('artikel')}
              className={`flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs font-medium transition-all ${
                inventoryView === 'artikel' ? 'bg-background shadow-sm text-foreground' : 'text-muted-foreground hover:text-foreground'
              }`}
            >
              <LayoutList className="h-3 w-3" /> Nach Artikel
            </button>
            <button
              onClick={() => setInventoryView('lagerort')}
              className={`flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs font-medium transition-all ${
                inventoryView === 'lagerort' ? 'bg-background shadow-sm text-foreground' : 'text-muted-foreground hover:text-foreground'
              }`}
            >
              <Layers className="h-3 w-3" /> Nach Lagerort
            </button>
          </div>
        </div>
      </div>

      {/* ── Hauptinhalt ──────────────────────────────────────────────────────── */}
      <div className="flex-1 overflow-auto px-4 py-3">

        {loading ? (
          <div className="flex items-center justify-center py-20 text-muted-foreground text-sm">
            Laden…
          </div>
        ) : filtered.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-20 gap-3 text-center">
            <Package className="h-10 w-10 text-muted-foreground/30" />
            <div>
              <p className="font-medium text-muted-foreground">Keine Artikel gefunden</p>
              <p className="text-xs text-muted-foreground/60 mt-1">
                {store.articles.length === 0
                  ? 'Klicke auf "Neuer Artikel" um zu beginnen.'
                  : 'Filter anpassen oder Suche ändern.'}
              </p>
            </div>
            {store.articles.length === 0 && (
              <Button onClick={openCreate} className="mt-2">
                <Plus className="h-4 w-4 mr-1" /> Ersten Artikel erstellen
              </Button>
            )}
          </div>
        ) : inventurFilter ? (
          /* ── Inventur Schnellansicht ──────────────────────────────────── */
          <div className="space-y-4">
            <div className="flex items-center gap-2 text-sm font-medium text-amber-700 dark:text-amber-400">
              <ClipboardList className="h-4 w-4" />
              Inventur-relevante Artikel ({filtered.length})
              <span className="text-muted-foreground font-normal">— Alle markierten Kontrollartikel auf einen Blick</span>
            </div>
            {['food', 'beverage'].map(t => {
              const group = filtered.filter(a => a.inventoryType === t);
              if (group.length === 0) return null;
              return (
                <div key={t}>
                  <h3 className={`text-xs font-semibold uppercase tracking-wide mb-2 ${t === 'food' ? 'text-emerald-700' : 'text-blue-700'}`}>
                    {t === 'food' ? '🥬 Food' : '🍷 Beverage'} ({group.length})
                  </h3>
                  <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2">
                    {group.map(a => (
                      <div
                        key={a.id}
                        className={`rounded-lg border p-3 flex items-start gap-2 cursor-pointer hover:shadow-sm transition-shadow ${
                          t === 'food'
                            ? 'border-emerald-200 bg-emerald-50/50 dark:bg-emerald-950/10 dark:border-emerald-900'
                            : 'border-blue-200 bg-blue-50/50 dark:bg-blue-950/10 dark:border-blue-900'
                        }`}
                        onClick={() => openEdit(a)}
                      >
                        <Star className="h-3.5 w-3.5 mt-0.5 shrink-0 fill-amber-400 text-amber-500" />
                        <div className="min-w-0 flex-1">
                          <p className="font-medium text-sm truncate">{a.name}</p>
                          <div className="flex flex-wrap gap-1 mt-1">
                            <span className="text-[10px] bg-muted text-muted-foreground px-1.5 py-px rounded">{a.unit}</span>
                            {a.accountingAccount && (
                              <span className="text-[10px] bg-violet-100 dark:bg-violet-950/40 text-violet-700 dark:text-violet-300 border border-violet-200 px-1.5 py-px rounded font-mono">
                                {getFibuLabel(a.accountingAccount)}
                              </span>
                            )}
                            {a.storageLocations.map(loc => (
                              <span key={loc} className="text-[10px] bg-muted text-muted-foreground px-1.5 py-px rounded">
                                {loc}
                              </span>
                            ))}
                          </div>
                          {a.defaultCostPerUnit > 0 && (
                            <p className="text-xs text-muted-foreground mt-1">
                              NET CHF {a.defaultCostPerUnit.toFixed(4)} / {a.unit}
                            </p>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
        ) : inventoryView === 'artikel' ? (
          <div className="rounded-lg border overflow-hidden">
            <table className="w-full text-sm">
              <thead className="bg-muted/50">
                <tr>
                  <th
                    className="text-left px-4 py-2.5 font-medium text-muted-foreground cursor-pointer select-none hover:text-foreground"
                    onClick={() => toggleSort('name')}
                  >
                    Artikel <SortIcon field="name" />
                  </th>
                  <th
                    className="text-left px-3 py-2.5 font-medium text-muted-foreground cursor-pointer select-none hover:text-foreground hidden sm:table-cell"
                    onClick={() => toggleSort('type')}
                  >
                    Typ <SortIcon field="type" />
                  </th>
                  <th className="text-left px-3 py-2.5 font-medium text-muted-foreground hidden md:table-cell">
                    Einheit
                  </th>
                  <th className="text-left px-3 py-2.5 font-medium text-muted-foreground hidden xl:table-cell">
                    Lieferant
                  </th>
                  <th
                    className="text-right px-3 py-2.5 font-medium text-muted-foreground cursor-pointer select-none hover:text-foreground"
                    onClick={() => toggleSort('cost')}
                  >
                    Netto-Preis <SortIcon field="cost" />
                  </th>
                  <th className="text-left px-3 py-2.5 font-medium text-muted-foreground hidden xl:table-cell">
                    Fibu-Konto
                  </th>
                  <th className="text-left px-3 py-2.5 font-medium text-muted-foreground hidden lg:table-cell">
                    Lagerorte
                  </th>
                  <th className="text-center px-3 py-2.5 font-medium text-muted-foreground">
                    Aktiv
                  </th>
                  <th className="px-3 py-2.5" />
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {filtered.map(a => {
                  const isExpanded = expandedRows.has(a.id);
                  const hasLocs    = a.storageLocations.length > 0;
                  return (
                  <Fragment key={a.id}>
                  <tr
                    className={`group hover:bg-muted/30 transition-colors ${!a.active ? 'opacity-50' : ''}`}
                  >
                    {/* Name */}
                    <td className="px-4 py-2.5">
                      <span className="flex items-center gap-1.5">
                        {a.inventurRelevant && (
                          <Star className="h-3.5 w-3.5 shrink-0 fill-amber-400 text-amber-500" title="Inventur-relevant" />
                        )}
                        {(a as Record<string, unknown>).trackingAktiv && (
                          <Activity className="h-3.5 w-3.5 shrink-0 text-violet-500" title="Tracking aktiv" />
                        )}
                        <span
                          className="font-medium cursor-pointer hover:underline"
                          onClick={() => openEdit(a)}
                        >
                          {a.name}
                        </span>
                      </span>
                    </td>

                    {/* Typ-Badge */}
                    <td className="px-3 py-2.5 hidden sm:table-cell">
                      {a.inventoryType === 'food' ? (
                        <Badge className="bg-emerald-100 text-emerald-700 border-emerald-200 hover:bg-emerald-100 dark:bg-emerald-950/40 dark:text-emerald-300">
                          <Package className="h-3 w-3 mr-1" /> Food
                        </Badge>
                      ) : (
                        <Badge className="bg-blue-100 text-blue-700 border-blue-200 hover:bg-blue-100 dark:bg-blue-950/40 dark:text-blue-300">
                          <Wine className="h-3 w-3 mr-1" /> Beverage
                        </Badge>
                      )}
                    </td>

                    {/* Einheit */}
                    <td className="px-3 py-2.5 text-muted-foreground hidden md:table-cell">
                      {a.unit}
                    </td>

                    {/* Lieferant */}
                    <td className="px-3 py-2.5 hidden xl:table-cell">
                      {a.standardSupplier ? (
                        <div className="flex items-center gap-1.5">
                          <span className="text-sm truncate max-w-[120px]">{a.standardSupplier}</span>
                          {a.fallbackEnabled && (
                            <Tooltip>
                              <TooltipTrigger asChild>
                                <span className="inline-flex items-center px-1.5 py-0.5 rounded text-xs bg-amber-100 text-amber-700 dark:bg-amber-950/40 dark:text-amber-300 cursor-default border border-amber-200 dark:border-amber-700">
                                  +Ausweich
                                </span>
                              </TooltipTrigger>
                              <TooltipContent side="top">
                                <p className="font-medium">{a.fallbackSupplier || '–'}</p>
                                <p className="text-xs">{fmtChf(a.fallbackPrice)}</p>
                              </TooltipContent>
                            </Tooltip>
                          )}
                        </div>
                      ) : (
                        <span className="text-xs text-muted-foreground/50">–</span>
                      )}
                    </td>

                    {/* Netto-Preis */}
                    <td className="px-3 py-2.5 text-right font-mono text-xs">
                      {fmtChf(a.defaultCostPerUnit)}
                    </td>

                    {/* Fibu-Konto */}
                    <td className="px-3 py-2.5 hidden xl:table-cell">
                      {a.accountingAccount ? (
                        <span className="text-xs bg-violet-50 dark:bg-violet-950/30 text-violet-700 dark:text-violet-300 border border-violet-200 dark:border-violet-800 px-1.5 py-0.5 rounded font-mono">
                          {getFibuLabel(a.accountingAccount)}
                        </span>
                      ) : (
                        <span className="text-xs text-muted-foreground/40">–</span>
                      )}
                    </td>

                    {/* Lagerorte – mit Expand-Toggle */}
                    <td className="px-3 py-2.5 hidden lg:table-cell">
                      {hasLocs ? (
                        <button
                          onClick={() => toggleRow(a.id)}
                          className="flex items-center gap-1.5 text-xs hover:text-foreground text-muted-foreground transition-colors group/loc"
                        >
                          <MapPin className="h-3 w-3 shrink-0" />
                          <span className="font-medium">
                            {a.storageLocations.length === 1
                              ? a.storageLocations[0]
                              : `${a.storageLocations.length} Lagerorte`}
                          </span>
                          {isExpanded
                            ? <ChevronUp className="h-3 w-3" />
                            : <ChevronDown className="h-3 w-3 opacity-40 group-hover/loc:opacity-100" />}
                        </button>
                      ) : (
                        <span className="text-xs text-muted-foreground/50">–</span>
                      )}
                    </td>

                    {/* Aktiv Toggle */}
                    <td className="px-3 py-2.5 text-center">
                      <Switch
                        checked={a.active}
                        onCheckedChange={() => handleToggleActive(a)}
                        className="scale-75"
                      />
                    </td>

                    {/* Aktionen */}
                    <td className="px-3 py-2.5">
                      <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity justify-end">
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-7 w-7"
                          onClick={() => openEdit(a)}
                        >
                          <Pencil className="h-3.5 w-3.5" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-7 w-7 text-destructive hover:text-destructive hover:bg-destructive/10"
                          onClick={() => setConfirmDelete(a)}
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </Button>
                      </div>
                    </td>
                  </tr>

                  {/* Expanded sub-rows: eine Zeile pro Lagerort */}
                  {isExpanded && hasLocs && a.storageLocations.map(loc => {
                    const isFoodLoc = STORAGE_LOCATIONS_FOOD.includes(loc as typeof STORAGE_LOCATIONS_FOOD[number]);
                    return (
                      <tr key={`${a.id}|${loc}`} className="bg-muted/20 border-t-0">
                        <td colSpan={9} className="py-1.5 pr-3 pl-10">
                          <div className="flex items-center gap-2">
                            <MapPin className={`h-3 w-3 shrink-0 ${isFoodLoc ? 'text-emerald-500' : 'text-blue-500'}`} />
                            <span className={`text-xs font-medium px-1.5 py-0.5 rounded ${
                              isFoodLoc
                                ? 'bg-emerald-50 dark:bg-emerald-950/30 text-emerald-700 dark:text-emerald-300'
                                : 'bg-blue-50 dark:bg-blue-950/30 text-blue-700 dark:text-blue-300'
                            }`}>
                              {loc}
                            </span>
                            <span className="text-[10px] text-muted-foreground">
                              {isFoodLoc ? 'Food-Lager' : 'Getränke-Lager'}
                            </span>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                  </Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : (

          /* ══ NACH LAGERORT ══════════════════════════════════════════════════ */
          <div className="space-y-4">
            {byLocation.size === 0 ? (
              <div className="text-center py-12 text-sm text-muted-foreground">
                Keine Artikel gefunden. Filter anpassen.
              </div>
            ) : (
              [...byLocation.entries()].map(([loc, arts]) => {
                const isFoodLoc = STORAGE_LOCATIONS_FOOD.includes(loc as typeof STORAGE_LOCATIONS_FOOD[number]);
                const isBevLoc  = STORAGE_LOCATIONS_BEVERAGE.includes(loc as typeof STORAGE_LOCATIONS_BEVERAGE[number]);
                return (
                  <div key={loc} className="rounded-xl border overflow-hidden">

                    {/* Lagerort-Header */}
                    <div className={`px-4 py-2.5 border-b flex items-center gap-2 ${
                      isFoodLoc
                        ? 'bg-emerald-50/60 dark:bg-emerald-950/20 border-emerald-200 dark:border-emerald-800'
                        : isBevLoc
                        ? 'bg-blue-50/60 dark:bg-blue-950/20 border-blue-200 dark:border-blue-800'
                        : 'bg-muted/40'
                    }`}>
                      <MapPin className={`h-4 w-4 ${
                        isFoodLoc ? 'text-emerald-600' : isBevLoc ? 'text-blue-600' : 'text-muted-foreground'
                      }`} />
                      <span className="font-semibold text-sm">{loc}</span>
                      <span className={`text-xs px-1.5 py-0.5 rounded-full ml-1 ${
                        isFoodLoc
                          ? 'bg-emerald-100 dark:bg-emerald-900/40 text-emerald-700 dark:text-emerald-300'
                          : isBevLoc
                          ? 'bg-blue-100 dark:bg-blue-900/40 text-blue-700 dark:text-blue-300'
                          : 'bg-muted text-muted-foreground'
                      }`}>
                        {arts.length} Artikel
                      </span>
                      <span className="text-xs text-muted-foreground ml-auto">
                        {isFoodLoc ? 'Food-Lager' : isBevLoc ? 'Getränke-Lager' : ''}
                      </span>
                    </div>

                    {/* Artikel-Liste */}
                    <div className="divide-y divide-border/50">
                      {arts.map(a => (
                        <div key={a.id} className={`flex items-center gap-3 px-4 py-2.5 hover:bg-muted/20 transition-colors ${!a.active ? 'opacity-50' : ''}`}>
                          {/* Typ-Indikator */}
                          <span className={`shrink-0 w-1.5 h-6 rounded-full ${
                            a.inventoryType === 'food'
                              ? 'bg-emerald-400 dark:bg-emerald-600'
                              : 'bg-blue-400 dark:bg-blue-600'
                          }`} />

                          {/* Name */}
                          <span
                            className="text-sm font-medium flex-1 min-w-0 truncate cursor-pointer hover:underline"
                            onClick={() => openEdit(a)}
                          >
                            {a.name}
                          </span>

                          {/* Einheit */}
                          <span className="text-xs text-muted-foreground hidden sm:block shrink-0">{a.unit}</span>

                          {/* Alle Lagerorte dieses Artikels */}
                          <div className="hidden md:flex gap-1 flex-wrap shrink-0">
                            {a.storageLocations.map(l => (
                              <span key={l} className={`text-[10px] px-1.5 py-0.5 rounded border ${
                                l === loc
                                  ? isFoodLoc
                                    ? 'bg-emerald-100 dark:bg-emerald-900/40 text-emerald-700 dark:text-emerald-300 border-emerald-300 dark:border-emerald-700 font-medium'
                                    : 'bg-blue-100 dark:bg-blue-900/40 text-blue-700 dark:text-blue-300 border-blue-300 dark:border-blue-700 font-medium'
                                  : 'bg-muted text-muted-foreground border-border/50'
                              }`}>
                                {l}
                              </span>
                            ))}
                          </div>

                          {/* Preis */}
                          <span className="text-xs font-mono text-muted-foreground shrink-0">
                            {a.defaultCostPerUnit > 0 ? `CHF ${a.defaultCostPerUnit.toFixed(4)}` : '–'}
                          </span>

                          {/* Bearbeiten */}
                          <Button variant="ghost" size="icon" className="h-7 w-7 opacity-0 group-hover:opacity-100 shrink-0" onClick={() => openEdit(a)}>
                            <Pencil className="h-3.5 w-3.5" />
                          </Button>
                        </div>
                      ))}
                    </div>
                  </div>
                );
              })
            )}
          </div>
        )}

        {/* Anzahl Ergebnisse */}
        {!loading && filtered.length > 0 && (
          <p className="text-xs text-muted-foreground mt-2 text-right">
            {filtered.length} Artikel angezeigt
            {inventoryView === 'lagerort' && (
              <span> · in {byLocation.size} Lagerorten</span>
            )}
            {!showInactive && store.articles.filter(a => !a.active).length > 0 && (
              <span> · {store.articles.filter(a => !a.active).length} inaktive ausgeblendet</span>
            )}
          </p>
        )}
      </div>

      {/* ── Dialoge ──────────────────────────────────────────────────────────── */}

      <ArtikelDialog
        open={dialogOpen}
        initial={editArtikel}
        onSave={handleSave}
        onClose={() => { setDialogOpen(false); setEditArtikel(null); }}
      />

      {/* Löschen bestätigen */}
      <Dialog open={!!confirmDelete} onOpenChange={v => !v && setConfirmDelete(null)}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>Artikel löschen?</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">
            «{confirmDelete?.name}» wird dauerhaft gelöscht. Diese Aktion kann nicht rückgängig gemacht werden.
          </p>
          <DialogFooter className="mt-2">
            <Button variant="outline" onClick={() => setConfirmDelete(null)}>Abbrechen</Button>
            <Button
              variant="destructive"
              onClick={() => confirmDelete && handleDelete(confirmDelete)}
            >
              Löschen
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
