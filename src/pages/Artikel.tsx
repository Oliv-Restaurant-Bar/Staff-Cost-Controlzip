/**
 * Artikelstamm (Stage 1)
 * =======================
 * Zentrale Datenbank für alle Food- und Beverage-Artikel.
 * Dient als Grundlage für Rezeptkosten, Lieferantenrechnungen,
 * Inventur und theoretischen Warenbestand.
 */

import { useEffect, useState, useMemo } from 'react';
import { toast } from 'sonner';
import {
  Plus, Pencil, Trash2, Search, X, Package, Wine,
  ChevronDown, ChevronUp, Eye, EyeOff, Info,
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
    name:                 '',
    inventoryType:        'food',
    unit:                 'kg',
    defaultCostPerUnit:   0,
    storageLocations:     [],
    active:               true,
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
          storageLocations:   initial.storageLocations,
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
    onSave({ ...form, unit: effectiveUnit });
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

          {/* Einkaufspreis */}
          <div className="space-y-1">
            <Label>Einkaufspreis / Einheit (CHF)</Label>
            <div className="relative">
              <span className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground text-sm">CHF</span>
              <Input
                type="number"
                min="0"
                step="0.01"
                placeholder="0.00"
                value={form.defaultCostPerUnit || ''}
                onChange={e => setForm(f => ({ ...f, defaultCostPerUnit: parseFloat(e.target.value) || 0 }))}
                className="pl-12"
              />
            </div>
            <p className="text-xs text-muted-foreground">
              Kann pro Lieferant/Bestellung überschrieben werden.
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

  // Sichtbare Lagerorte basierend auf Typ-Filter
  const visibleLocations = useMemo(() => {
    if (typeFilter === 'food')     return [...STORAGE_LOCATIONS_FOOD];
    if (typeFilter === 'beverage') return [...STORAGE_LOCATIONS_BEVERAGE];
    return [...ALL_STORAGE_LOCATIONS];
  }, [typeFilter]);

  // Gefilterte Liste
  const filtered = useMemo(() => {
    let list = filterArtikel(store.articles, {
      inventoryType:   typeFilter,
      storageLocation: locationFilter,
      search:          searchQuery,
      showInactive,
    });

    list = [...list].sort((a, b) => {
      let cmp = 0;
      if (sortField === 'name') cmp = a.name.localeCompare(b.name, 'de');
      if (sortField === 'cost') cmp = a.defaultCostPerUnit - b.defaultCostPerUnit;
      if (sortField === 'type') cmp = a.inventoryType.localeCompare(b.inventoryType);
      return sortDir === 'desc' ? -cmp : cmp;
    });
    return list;
  }, [store.articles, typeFilter, locationFilter, searchQuery, showInactive, sortField, sortDir]);

  const stats = useMemo(() => getArtikelStats(store.articles), [store.articles]);

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
        ) : (
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
                  <th
                    className="text-right px-3 py-2.5 font-medium text-muted-foreground cursor-pointer select-none hover:text-foreground"
                    onClick={() => toggleSort('cost')}
                  >
                    Kosten/Einheit <SortIcon field="cost" />
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
                {filtered.map(a => (
                  <tr
                    key={a.id}
                    className={`group hover:bg-muted/30 transition-colors ${!a.active ? 'opacity-50' : ''}`}
                  >
                    {/* Name */}
                    <td className="px-4 py-2.5">
                      <span
                        className="font-medium cursor-pointer hover:underline"
                        onClick={() => openEdit(a)}
                      >
                        {a.name}
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

                    {/* Kosten */}
                    <td className="px-3 py-2.5 text-right font-mono text-xs">
                      {fmtChf(a.defaultCostPerUnit)}
                    </td>

                    {/* Lagerorte */}
                    <td className="px-3 py-2.5 hidden lg:table-cell">
                      <div className="flex gap-1 flex-wrap">
                        {a.storageLocations.length > 0
                          ? a.storageLocations.map(l => (
                              <span key={l} className="text-xs bg-muted px-1.5 py-0.5 rounded">
                                {l}
                              </span>
                            ))
                          : <span className="text-xs text-muted-foreground/50">–</span>}
                      </div>
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
                ))}
              </tbody>
            </table>
          </div>
        )}

        {/* Anzahl Ergebnisse */}
        {!loading && filtered.length > 0 && (
          <p className="text-xs text-muted-foreground mt-2 text-right">
            {filtered.length} Artikel angezeigt
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
