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
import { Plus, Trash2, ChevronRight, Package, Wine } from 'lucide-react';
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
  type CostMode, type ProductRecipe, type RecipeIngredient,
  emptyRecipe, emptyIngredient, computeRecipeCosts,
} from '@/lib/rezeptur-store';
import { getFibuLabel, resolveIngredientAccount, loadArtikelFromDB, type Artikel } from '@/lib/artikel-store';

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
  const kpis = computeRecipeCosts(recipe, cost.nettoPrice, cost.bruttoPrice);
  const refPrice = cost.nettoPrice > 0 ? cost.nettoPrice : cost.bruttoPrice;

  return (
    <div className="rounded-lg bg-muted/60 border border-border px-4 py-3">
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
          <p className={`text-base font-bold ${wesColor(kpis.wesQ)}`}>
            {refPrice > 0 ? fmtPct(kpis.wesQ) : '–'}
          </p>
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
  const [loadingArts, setLoadingArts] = useState(false);

  // Formular initialisieren wenn Dialog öffnet
  useEffect(() => {
    if (open && cost) {
      setRecipe(existingRecipe
        ? { ...existingRecipe }
        : emptyRecipe(cost.name, cost.category),
      );
    }
  }, [open, cost, existingRecipe]);

  // Artikel laden (einmalig pro Dialog-Öffnung)
  useEffect(() => {
    if (open && articles.length === 0) {
      setLoadingArts(true);
      loadArtikelFromDB()
        .then(store => setArticles(store.articles.filter(a => a.active)))
        .finally(() => setLoadingArts(false));
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

  function addIngredient() {
    setRecipe(r => r ? { ...r, ingredients: [...r.ingredients, emptyIngredient()] } : r);
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
                    {recipe.ingredients.map(ing => (
                      <IngredientRow
                        key={ing.id}
                        ing={ing}
                        articles={articles}
                        onChange={patch => updateIngredient(ing.id, patch)}
                        onRemove={() => removeIngredient(ing.id)}
                      />
                    ))}
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

              <Button
                variant="outline"
                size="sm"
                onClick={addIngredient}
                className="mt-2 w-full text-xs h-7"
              >
                <Plus className="h-3.5 w-3.5 mr-1" /> Zutat hinzufügen
              </Button>
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
