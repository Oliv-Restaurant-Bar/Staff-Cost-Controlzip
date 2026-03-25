/**
 * RezepturDialog – Produktkalkulation
 * =====================================
 * Ermöglicht die Kalkulation eines Produkts in drei Modi:
 *   Pauschal  → manuell eingegebener Einkaufspreis
 *   Rezeptur  → Zutaten aus Artikelstamm, automatische Kostenberechnung
 *   Gemischt  → Rezeptur + Zusatzkosten
 */

import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Plus, Trash2, ChevronRight, Package, Wine, Layers, Utensils, ShoppingBag, CircleAlert } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from '@/components/ui/dialog';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import type { ProductCostEntry } from '@/lib/produkte-store';
import {
  type CostMode, type ProductRecipe, type RecipeIngredient, type LunchPool, type SalesChannel,
  emptyRecipe, emptyIngredient, computeRecipeCosts,
} from '@/lib/rezeptur-store';
import { getFibuLabel, resolveIngredientAccount, loadArtikelFromDB, type Artikel } from '@/lib/artikel-store';
import {
  getWesStatus, getWesBadgeClasses, getWesStatusFullLabel, getSmartSuggestions,
} from '@/lib/wes-status';
import {
  type BaseComponentMap,
  loadBasiskomponentenFromDB, makeBaseComponentIngredient, computeBaseComponentCost,
} from '@/lib/basiskomponenten-store';

// ── Helpers ───────────────────────────────────────────────────────────────────

const fmtChf  = (n: number) => `CHF ${n.toFixed(2)}`;
const fmtPct  = (n: number) => `${n.toFixed(1)} %`;

function wesColor(q: number) {
  if (q < 25) return 'text-emerald-600 dark:text-emerald-400';
  if (q < 35) return 'text-amber-600 dark:text-amber-400';
  return 'text-red-600 dark:text-red-400';
}
function margeColor(p: number) {
  if (p >= 70) return 'text-emerald-600 dark:text-emerald-400';
  if (p >= 50) return 'text-green-600 dark:text-green-400';
  if (p >= 30) return 'text-amber-600 dark:text-amber-400';
  return 'text-red-600 dark:text-red-400';
}

// ── Modus-Karte ───────────────────────────────────────────────────────────────

function ModeCard({
  mode, selected, label, description, onClick,
}: { mode: CostMode; selected: boolean; label: string; description: string; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className={`flex-1 rounded-lg border p-3 text-left transition-all ${
        selected
          ? 'border-primary bg-primary/5 ring-1 ring-primary'
          : 'border-border hover:bg-accent hover:border-accent-foreground/20'
      }`}
    >
      <div className="flex items-center justify-between">
        <span className={`text-sm font-semibold ${selected ? 'text-primary' : ''}`}>{label}</span>
        {selected && <ChevronRight className="h-3.5 w-3.5 text-primary" />}
      </div>
      <p className="text-[11px] text-muted-foreground mt-0.5 leading-tight">{description}</p>
    </button>
  );
}

// ── Zutaten-Zeile ─────────────────────────────────────────────────────────────

function IngredientRow({
  ing, articles, onChange, onRemove,
}: {
  ing: RecipeIngredient;
  articles: Artikel[];
  onChange: (patch: Partial<RecipeIngredient>) => void;
  onRemove: () => void;
}) {
  const lineCost = ing.quantity * ing.costPerUnit;

  function handleArticleChange(articleId: string) {
    if (!articleId) {
      onChange({ articleId: '', articleName: '', costPerUnit: 0, unit: 'Stück', supplier: '', accountingAccount: '' });
      return;
    }
    const art = articles.find(a => a.id === articleId);
    if (!art) return;
    onChange({
      articleId:        art.id,
      articleName:      art.name,
      costPerUnit:      art.defaultCostPerUnit,
      unit:             art.unit,
      supplier:         art.standardSupplier,
      accountingAccount: art.accountingAccount,
    });
  }

  return (
    <div className="grid grid-cols-[1fr_80px_80px_90px_32px] gap-1.5 items-center py-2 border-b border-border/50 last:border-0">
      {/* Artikel */}
      <div className="min-w-0">
        <Select value={ing.articleId || '__manual__'} onValueChange={v => handleArticleChange(v === '__manual__' ? '' : v)}>
          <SelectTrigger className="h-7 text-xs">
            <SelectValue placeholder="Artikel wählen…" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="__manual__">– Manuell –</SelectItem>
            {articles.map(a => (
              <SelectItem key={a.id} value={a.id}>
                {a.name}
                {a.standardSupplier && <span className="text-muted-foreground ml-1">({a.standardSupplier})</span>}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {/* Manueller Name falls kein Artikel gewählt */}
        {!ing.articleId && (
          <Input
            className="h-6 text-xs mt-1"
            placeholder="Bezeichnung"
            value={ing.articleName}
            onChange={e => onChange({ articleName: e.target.value })}
          />
        )}
        {/* Lieferant-Info + Fibu-Konto wenn Artikel gewählt */}
        {ing.articleId && (
          <div className="flex gap-1 mt-0.5 flex-wrap">
            {ing.supplier && (
              <span className="text-[10px] text-muted-foreground bg-muted px-1 rounded">
                {ing.supplier}
              </span>
            )}
            {/* Fibu-Konto: immer live aus Artikelstamm – Single Source of Truth */}
            <span
              className="text-[10px] text-violet-600 dark:text-violet-400 bg-violet-50 dark:bg-violet-950/30 px-1 rounded border border-violet-200 dark:border-violet-800"
              title="Fibu-Konto aus Artikelstamm – ändert sich automatisch wenn du das Konto im Artikelstamm anpasst"
            >
              {getFibuLabel(resolveIngredientAccount(ing, articles))}
            </span>
          </div>
        )}
      </div>

      {/* Menge */}
      <Input
        type="number"
        min="0"
        step="0.001"
        className="h-7 text-xs text-right"
        value={ing.quantity || ''}
        onChange={e => onChange({ quantity: parseFloat(e.target.value) || 0 })}
      />

      {/* Einheit */}
      <Input
        className="h-7 text-xs"
        value={ing.unit}
        onChange={e => onChange({ unit: e.target.value })}
        placeholder="kg"
      />

      {/* Kosten/Einheit → Zeilenkosten */}
      <div className="text-right">
        <Input
          type="number"
          min="0"
          step="0.0001"
          className="h-7 text-xs text-right"
          value={ing.costPerUnit || ''}
          onChange={e => onChange({ costPerUnit: parseFloat(e.target.value) || 0 })}
          placeholder="0.00"
        />
        <div className="text-[10px] text-muted-foreground mt-0.5 pr-1">
          = {fmtChf(lineCost)}
        </div>
      </div>

      {/* Entfernen */}
      <button
        onClick={onRemove}
        className="text-muted-foreground hover:text-destructive transition-colors self-start mt-1"
      >
        <Trash2 className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}

// ── KPI Bar ───────────────────────────────────────────────────────────────────

function KpiBar({ recipe, cost }: { recipe: ProductRecipe; cost: ProductCostEntry }) {
  const kpis      = computeRecipeCosts(recipe, cost.nettoPrice, cost.bruttoPrice);
  const refPrice  = cost.nettoPrice > 0 ? cost.nettoPrice : cost.bruttoPrice;
  const wesStatus = refPrice > 0 ? getWesStatus(kpis.wesQ) : 'unknown';
  const suggestions = getSmartSuggestions(kpis.wesQ);

  return (
    <div className={`rounded-lg border px-4 py-3 space-y-3 ${
      wesStatus === 'red'
        ? 'border-red-200 bg-red-50/30 dark:border-red-800 dark:bg-red-950/10'
        : wesStatus === 'amber'
          ? 'border-amber-200/60 bg-amber-50/20 dark:border-amber-800/60 dark:bg-amber-950/5'
          : 'bg-muted/60 border-border'
    }`}>
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <div>
          <p className="text-[10px] text-muted-foreground uppercase tracking-wide">Kosten netto</p>
          <p className="text-base font-bold">{fmtChf(kpis.totalCost)}</p>
          {recipe.costMode !== 'pauschal' && kpis.ingredientsCost !== kpis.totalCost && (
            <p className="text-[10px] text-muted-foreground">Zutaten: {fmtChf(kpis.ingredientsCost)}</p>
          )}
        </div>
        <div>
          <p className="text-[10px] text-muted-foreground uppercase tracking-wide">WES-Quote</p>
          <div className="flex items-center gap-1.5 flex-wrap">
            <p className={`text-base font-bold ${wesColor(kpis.wesQ)}`}>
              {refPrice > 0 ? fmtPct(kpis.wesQ) : '–'}
            </p>
            {refPrice > 0 && (
              <span className={`text-[9px] font-semibold px-1.5 py-0.5 rounded-full border ${getWesBadgeClasses(wesStatus)}`}>
                {getWesStatusFullLabel(wesStatus)}
              </span>
            )}
          </div>
          <p className="text-[10px] text-muted-foreground">VKP netto: {fmtChf(refPrice)}</p>
        </div>
        <div>
          <p className="text-[10px] text-muted-foreground uppercase tracking-wide">Marge</p>
          <p className={`text-base font-bold ${margeColor(kpis.margePct)}`}>
            {refPrice > 0 ? fmtPct(kpis.margePct) : '–'}
          </p>
        </div>
        <div>
          <p className="text-[10px] text-muted-foreground uppercase tracking-wide">Deckungsbeitrag</p>
          <p className={`text-base font-bold ${kpis.deckungsbeitrag >= 0 ? 'text-emerald-600 dark:text-emerald-400' : 'text-red-600'}`}>
            {fmtChf(kpis.deckungsbeitrag)}
          </p>
        </div>
      </div>

      {/* Verbesserungsvorschläge – nur wenn WES kritisch (rot) */}
      {suggestions.length > 0 && (
        <div className="rounded-md bg-red-100 dark:bg-red-950/30 border border-red-200 dark:border-red-800 px-3 py-2 flex items-start gap-2">
          <CircleAlert className="h-3.5 w-3.5 text-red-600 dark:text-red-400 mt-0.5 shrink-0" />
          <div className="space-y-0.5">
            <p className="text-[10px] font-semibold text-red-700 dark:text-red-400 uppercase tracking-wide">
              WES zu hoch – Handlungsempfehlungen
            </p>
            <div className="flex flex-wrap gap-1.5 mt-1">
              {suggestions.map(s => (
                <span key={s} className="text-[10px] px-2 py-0.5 rounded-full bg-red-200/70 dark:bg-red-900/40 text-red-700 dark:text-red-400 font-medium border border-red-300 dark:border-red-700">
                  {s}
                </span>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Haupt-Dialog ──────────────────────────────────────────────────────────────

interface RezepturDialogProps {
  open: boolean;
  cost: ProductCostEntry | null;
  existingRecipe: ProductRecipe | null;
  onSave: (recipe: ProductRecipe) => void;
  onClose: () => void;
}

export default function RezepturDialog({
  open, cost, existingRecipe, onSave, onClose,
}: RezepturDialogProps) {
  const [recipe, setRecipe] = useState<ProductRecipe | null>(null);
  const [articles, setArticles] = useState<Artikel[]>([]);
  const [baseComponents, setBaseComponents] = useState<BaseComponentMap>({});
  const [loadingArts, setLoadingArts] = useState(false);
  const [showBaseSelect, setShowBaseSelect] = useState(false);
  const [selectedBaseId, setSelectedBaseId] = useState('');

  // Formular initialisieren wenn Dialog öffnet
  useEffect(() => {
    if (open && cost) {
      setRecipe(existingRecipe
        ? { ...existingRecipe }
        : emptyRecipe(cost.name, cost.category),
      );
      setShowBaseSelect(false);
      setSelectedBaseId('');
    }
  }, [open, cost, existingRecipe]);

  // Artikel + Basiskomponenten laden (einmalig pro Dialog-Öffnung)
  useEffect(() => {
    if (open && articles.length === 0) {
      setLoadingArts(true);
      Promise.all([
        loadArtikelFromDB().then(store => store.articles.filter(a => a.active)),
        loadBasiskomponentenFromDB(),
      ]).then(([arts, bases]) => {
        setArticles(arts);
        setBaseComponents(bases);
      }).finally(() => setLoadingArts(false));
    }
  }, [open]);

  if (!recipe || !cost) return null;

  function setMode(m: CostMode) {
    setRecipe(r => r ? { ...r, costMode: m } : r);
  }

  function setManualCost(v: number) {
    setRecipe(r => r ? { ...r, manualCost: v } : r);
  }

  function setManualNote(v: string) {
    setRecipe(r => r ? { ...r, manualCostNote: v } : r);
  }

  function setLunchPool(v: string) {
    const pool = v === '__none__' ? undefined : v as LunchPool;
    setRecipe(r => r ? { ...r, lunchPool: pool } : r);
  }

  function setSalesChannel(v: string) {
    const ch = v === '__none__' ? undefined : v as SalesChannel;
    setRecipe(r => {
      if (!r) return r;
      // Wenn kein Lunch-Kanal gewählt → lunchPool löschen
      const lunchPool = ch === 'lunch' ? r.lunchPool : undefined;
      return { ...r, salesChannel: ch, lunchPool };
    });
  }

  /** Effektiver Kanal: explizit gesetzt oder aus lunchPool abgeleitet */
  function effectiveChannel(): SalesChannel | undefined {
    if (!recipe) return undefined;
    if (recipe.salesChannel) return recipe.salesChannel;
    if (recipe.lunchPool) return 'lunch';
    return undefined;
  }

  function addIngredient() {
    setRecipe(r => r ? { ...r, ingredients: [...r.ingredients, emptyIngredient()] } : r);
  }

  function addBaseComponent() {
    if (!selectedBaseId) return;
    const bc = baseComponents[selectedBaseId];
    if (!bc) return;
    const ing = makeBaseComponentIngredient(bc, 1);
    setRecipe(r => r ? { ...r, ingredients: [...r.ingredients, ing] } : r);
    setShowBaseSelect(false);
    setSelectedBaseId('');
  }

  function updateIngredient(id: string, patch: Partial<RecipeIngredient>) {
    setRecipe(r => r ? {
      ...r,
      ingredients: r.ingredients.map(i => i.id === id ? { ...i, ...patch } : i),
    } : r);
  }

  function removeIngredient(id: string) {
    setRecipe(r => r ? { ...r, ingredients: r.ingredients.filter(i => i.id !== id) } : r);
  }

  function handleSave() {
    if (!recipe) return;
    if (recipe.costMode === 'pauschal' && recipe.manualCost <= 0) {
      toast.error('Bitte Pauschalpreis eingeben');
      return;
    }
    if ((recipe.costMode === 'rezeptur' || recipe.costMode === 'gemischt') && recipe.ingredients.length === 0) {
      toast.error('Mindestens eine Zutat erforderlich');
      return;
    }
    onSave({ ...recipe, updatedAt: new Date().toISOString() });
  }

  const hasIngredients = recipe.costMode === 'rezeptur' || recipe.costMode === 'gemischt';
  const hasManual      = recipe.costMode === 'pauschal' || recipe.costMode === 'gemischt';
  const refPrice       = cost.nettoPrice > 0 ? cost.nettoPrice : cost.bruttoPrice;

  return (
    <Dialog open={open} onOpenChange={v => !v && onClose()}>
      <DialogContent className="max-w-2xl max-h-[90vh] flex flex-col overflow-hidden">
        <DialogHeader className="shrink-0">
          <DialogTitle className="flex items-center gap-2">
            {cost.category === 'food'
              ? <Package className="h-4 w-4 text-emerald-600" />
              : <Wine className="h-4 w-4 text-blue-600" />}
            {cost.name}
            <span className="text-sm font-normal text-muted-foreground ml-1">
              VKP: {fmtChf(refPrice)} netto
            </span>
          </DialogTitle>
        </DialogHeader>

        <div className="flex-1 overflow-y-auto space-y-4 pr-1">

          {/* ── Modus-Wahl ─────────────────────────────────────────────── */}
          <div>
            <Label className="text-xs text-muted-foreground mb-1.5 block">Kalkulationsmodus</Label>
            <div className="flex gap-2">
              <ModeCard
                mode="pauschal" selected={recipe.costMode === 'pauschal'}
                label="Pauschal" description="Manuell eingetragener Gesamtbetrag"
                onClick={() => setMode('pauschal')}
              />
              <ModeCard
                mode="rezeptur" selected={recipe.costMode === 'rezeptur'}
                label="Rezeptur" description="Zutaten aus Artikelstamm"
                onClick={() => setMode('rezeptur')}
              />
              <ModeCard
                mode="gemischt" selected={recipe.costMode === 'gemischt'}
                label="Gemischt" description="Rezeptur + Zusatzkosten"
                onClick={() => setMode('gemischt')}
              />
            </div>
          </div>

          {/* ── Zutaten-Liste (Rezeptur / Gemischt) ───────────────────── */}
          {hasIngredients && (
            <div>
              <div className="flex items-center justify-between mb-1">
                <Label className="text-xs text-muted-foreground">
                  Zutaten
                  {loadingArts && <span className="ml-1 opacity-60">(Artikel werden geladen…)</span>}
                </Label>
                <span className="text-xs text-muted-foreground">Menge · Einheit · CHF/Einheit</span>
              </div>

              {recipe.ingredients.length === 0 ? (
                <div className="text-center py-4 text-xs text-muted-foreground border border-dashed rounded-lg">
                  Noch keine Zutaten. Klicke «Zutat hinzufügen».
                </div>
              ) : (
                <div className="rounded-lg border bg-card">
                  {/* Spalten-Header */}
                  <div className="grid grid-cols-[1fr_80px_80px_90px_32px] gap-1.5 px-3 py-1.5 border-b bg-muted/40">
                    <span className="text-[10px] text-muted-foreground font-medium">Artikel / Bezeichnung</span>
                    <span className="text-[10px] text-muted-foreground font-medium text-right">Menge</span>
                    <span className="text-[10px] text-muted-foreground font-medium">Einheit</span>
                    <span className="text-[10px] text-muted-foreground font-medium text-right">CHF/Einheit</span>
                    <span />
                  </div>
                  <div className="px-3 divide-y divide-border/30">
                    {recipe.ingredients.map(ing => {
                      // Basiskomponente-Zutat: anders darstellen
                      if (ing.baseRecipeId) {
                        const bc = baseComponents[ing.baseRecipeId];
                        const currentPortionCost = bc ? computeBaseComponentCost(bc) : ing.costPerUnit;
                        return (
                          <div key={ing.id}
                            className="grid grid-cols-[1fr_80px_80px_90px_32px] gap-1.5 items-center py-2 border-b border-border/50 last:border-0">
                            <div className="min-w-0 space-y-0.5">
                              <div className="flex items-center gap-1.5">
                                <span className="inline-flex items-center gap-1 text-[10px] font-semibold bg-violet-100 dark:bg-violet-900/40 text-violet-700 dark:text-violet-400 border border-violet-200 dark:border-violet-800 px-1.5 py-0.5 rounded">
                                  <Layers className="h-2.5 w-2.5" /> Basis
                                </span>
                                <span className="text-xs font-medium truncate">{ing.articleName}</span>
                              </div>
                              <div className="text-[10px] text-muted-foreground">
                                {fmtChf(currentPortionCost)} / {ing.unit}
                                {bc && Math.abs(currentPortionCost - ing.costPerUnit) > 0.0001 && (
                                  <span className="ml-1 text-amber-600 dark:text-amber-400">(veraltet – neu berechnen)</span>
                                )}
                              </div>
                            </div>
                            <Input
                              type="number" min="0" step="0.001"
                              className="h-7 text-xs text-right"
                              value={ing.quantity || ''}
                              onChange={e => updateIngredient(ing.id, { quantity: parseFloat(e.target.value) || 0 })}
                              title="Anzahl Portionen"
                            />
                            <div className="text-xs text-muted-foreground px-1">{ing.unit}</div>
                            <div className="text-right text-xs font-mono font-medium">
                              = {fmtChf(ing.quantity * ing.costPerUnit)}
                            </div>
                            <button onClick={() => removeIngredient(ing.id)}
                              className="text-muted-foreground hover:text-destructive transition-colors self-start mt-1">
                              <Trash2 className="h-3.5 w-3.5" />
                            </button>
                          </div>
                        );
                      }
                      // Normale Zutat
                      return (
                        <IngredientRow
                          key={ing.id}
                          ing={ing}
                          articles={articles}
                          onChange={patch => updateIngredient(ing.id, patch)}
                          onRemove={() => removeIngredient(ing.id)}
                        />
                      );
                    })}
                  </div>
                  {/* Summe */}
                  <div className="px-3 py-2 border-t bg-muted/30 flex justify-end">
                    <span className="text-xs font-medium">
                      Zutaten gesamt: {fmtChf(
                        recipe.ingredients.reduce((s, i) => s + i.quantity * i.costPerUnit, 0)
                      )}
                    </span>
                  </div>
                </div>
              )}

              <div className="mt-2 flex gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={addIngredient}
                  className="flex-1 text-xs h-7"
                >
                  <Plus className="h-3.5 w-3.5 mr-1" /> Zutat hinzufügen
                </Button>
                {Object.keys(baseComponents).length > 0 && !showBaseSelect && (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setShowBaseSelect(true)}
                    className="flex-1 text-xs h-7 border-violet-200 text-violet-700 hover:bg-violet-50 dark:border-violet-800 dark:text-violet-400 dark:hover:bg-violet-950/30"
                  >
                    <Layers className="h-3.5 w-3.5 mr-1" /> Basiskomponente hinzufügen
                  </Button>
                )}
              </div>

              {/* Basiskomponente-Auswahl */}
              {showBaseSelect && (
                <div className="mt-2 flex gap-2 items-center rounded-lg border border-violet-200 dark:border-violet-800 bg-violet-50/60 dark:bg-violet-950/20 px-3 py-2">
                  <Layers className="h-3.5 w-3.5 text-violet-600 shrink-0" />
                  <Select value={selectedBaseId} onValueChange={setSelectedBaseId}>
                    <SelectTrigger className="h-7 text-xs flex-1 border-violet-200 dark:border-violet-800">
                      <SelectValue placeholder="Basiskomponente wählen…" />
                    </SelectTrigger>
                    <SelectContent>
                      {Object.values(baseComponents).sort((a, b) => a.name.localeCompare(b.name, 'de')).map(bc => (
                        <SelectItem key={bc.id} value={bc.id}>
                          <span className="flex items-center gap-2">
                            {bc.name}
                            <span className="text-[10px] text-muted-foreground font-mono">
                              CHF {(bc.ingredients.reduce((s, i) => s + i.quantity * i.costPerUnit, 0)).toFixed(2)} / {bc.unit}
                            </span>
                          </span>
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <Button size="sm" className="h-7 text-xs" onClick={addBaseComponent} disabled={!selectedBaseId}>
                    Hinzufügen
                  </Button>
                  <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={() => { setShowBaseSelect(false); setSelectedBaseId(''); }}>
                    ×
                  </Button>
                </div>
              )}
            </div>
          )}

          {/* ── Pauschal / Zusatzkosten (Gemischt) ────────────────────── */}
          {hasManual && (
            <div className={`rounded-lg border p-3 space-y-2 ${
              recipe.costMode === 'gemischt'
                ? 'border-amber-200 dark:border-amber-800 bg-amber-50/40 dark:bg-amber-950/10'
                : 'border-border'
            }`}>
              <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
                {recipe.costMode === 'gemischt' ? 'Zusatzkosten' : 'Pauschaler Wareneinsatz'}
              </p>

              <div className="flex gap-2">
                <div className="flex-1 space-y-1">
                  <Label className="text-xs">
                    {recipe.costMode === 'gemischt' ? 'Zusatzkosten (z.B. Verpackung, Energie)' : 'Wareneinsatz'}
                    <span className="ml-1 text-[10px] text-blue-600 dark:text-blue-400 bg-blue-50 dark:bg-blue-950/40 px-1 rounded border border-blue-200 dark:border-blue-800">
                      NETTO
                    </span>
                  </Label>
                  <div className="relative">
                    <span className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground text-xs">CHF</span>
                    <Input
                      type="number"
                      min="0"
                      step="0.01"
                      placeholder="0.00"
                      value={recipe.manualCost || ''}
                      onChange={e => setManualCost(parseFloat(e.target.value) || 0)}
                      className="pl-10 h-8 text-sm"
                    />
                  </div>
                </div>
                <div className="flex-1 space-y-1">
                  <Label className="text-xs">Beschreibung (optional)</Label>
                  <Input
                    placeholder={recipe.costMode === 'gemischt' ? 'z.B. Verpackung' : 'z.B. Lieferant'}
                    value={recipe.manualCostNote}
                    onChange={e => setManualNote(e.target.value)}
                    className="h-8 text-sm"
                  />
                </div>
              </div>
            </div>
          )}

          {/* ── Vertriebskanal + Pool-Zuordnung ───────────────────────── */}
          <div className="rounded-lg border border-dashed border-orange-200 dark:border-orange-800 bg-orange-50/30 dark:bg-orange-950/10 p-3 space-y-3">
            {/* Kanal-Header */}
            <div className="flex items-center gap-1.5">
              <ShoppingBag className="h-3.5 w-3.5 text-orange-600" />
              <p className="text-xs font-medium text-orange-700 dark:text-orange-400 uppercase tracking-wide">
                Vertriebskanal &amp; Pool (für WES-Analyse)
              </p>
            </div>

            {/* Kanal-Selector */}
            <div className="space-y-1">
              <p className="text-[10px] text-muted-foreground font-medium">Vertriebskanal</p>
              <Select value={effectiveChannel() ?? '__none__'} onValueChange={setSalesChannel}>
                <SelectTrigger className="h-8 text-xs">
                  <SelectValue placeholder="Restaurant (Standard)" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="__none__" className="text-xs">
                    <span className="text-muted-foreground italic">Restaurant / À la carte (Standard)</span>
                  </SelectItem>
                  <SelectItem value="lunch" className="text-xs">
                    <span className="flex items-center gap-1.5">
                      <Utensils className="h-3 w-3 text-orange-500" />
                      Mittagsmenu / Lunch
                    </span>
                  </SelectItem>
                  <SelectItem value="takeaway" className="text-xs">
                    <span className="flex items-center gap-1.5">
                      <ShoppingBag className="h-3 w-3 text-teal-500" />
                      Take Away
                    </span>
                  </SelectItem>
                </SelectContent>
              </Select>
              <p className="text-[10px] text-muted-foreground">
                Restaurant = Standard (keine Sonderanalyse). Lunch = erscheint in Lunch-WES-Analyse.
                Take Away = erscheint in Take-Away-Analyse.
              </p>
            </div>

            {/* Lunch-Pool-Picker – nur sichtbar wenn Kanal = Lunch */}
            {effectiveChannel() === 'lunch' && (
              <div className="space-y-1 pt-1 border-t border-orange-200/60 dark:border-orange-700/40">
                <p className="text-[10px] text-muted-foreground font-medium">Lunch-Pool</p>
                <Select value={recipe.lunchPool ?? '__none__'} onValueChange={setLunchPool}>
                  <SelectTrigger className="h-8 text-xs">
                    <SelectValue placeholder="Lunch Allgemein" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="__none__" className="text-xs">
                      <span className="text-muted-foreground italic">Ohne Unterscheidung (Allgemein)</span>
                    </SelectItem>
                    <SelectItem value="lunch_basic" className="text-xs">Lunch Basic (Tagesmenu 1)</SelectItem>
                    <SelectItem value="lunch_premium" className="text-xs">Lunch Premium (Tagesmenu 2)</SelectItem>
                    <SelectItem value="lunch_allgemein" className="text-xs">Lunch Allgemein</SelectItem>
                  </SelectContent>
                </Select>
                <p className="text-[10px] text-muted-foreground">
                  Differenziert den Lunch-Pool für Menu 1 / Menu 2.
                </p>
              </div>
            )}

            {/* Take Away Hinweis */}
            {effectiveChannel() === 'takeaway' && (
              <div className="rounded-md bg-teal-50 dark:bg-teal-950/20 border border-teal-200 dark:border-teal-700 px-2.5 py-2 text-[10px] text-teal-700 dark:text-teal-400 flex items-start gap-1.5">
                <ShoppingBag className="h-3 w-3 mt-0.5 shrink-0" />
                <span>
                  Dieses Produkt erscheint in der <strong>Take-Away-Analyse</strong> als Soll-Benchmark.
                  Einkäufe mit Kostenzuordnung «Take Away» werden als Ist-WES gewertet.
                </span>
              </div>
            )}
          </div>

          {/* ── KPI-Bar ────────────────────────────────────────────────── */}
          <KpiBar recipe={recipe} cost={cost} />
        </div>

        <DialogFooter className="shrink-0 mt-2 pt-2 border-t">
          <Button variant="outline" onClick={onClose}>Abbrechen</Button>
          <Button onClick={handleSave}>Kalkulation speichern</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
