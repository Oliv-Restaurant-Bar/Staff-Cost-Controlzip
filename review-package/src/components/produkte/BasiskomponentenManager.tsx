/**
 * BasiskomponentenManager
 * ========================
 * Verwaltet wiederverwendbare Basisrezepturen (z.B. "Pasta Basis", "Risotto Basis").
 *
 * Features:
 *   – Erstellen/Bearbeiten/Löschen von Basiskomponenten
 *   – Zutatenliste mit Artikelstamm-Verknüpfung
 *   – Anzeige verlinkter Produkte (welche Rezepturen verwenden diese Basis?)
 *   – Propagation: Änderungen mit Vorschau auf betroffene Produkte anwenden
 *   – Kostenkalkulation pro Portion live
 */

import { useState, useEffect, useMemo } from 'react';
import {
  Plus, Trash2, Pencil, ChevronDown, ChevronRight,
  Layers, AlertTriangle, Check, X, Package, ArrowRight, RefreshCw,
} from 'lucide-react';
import { toast }    from 'sonner';
import { Button }   from '@/components/ui/button';
import { Input }    from '@/components/ui/input';
import { Label }    from '@/components/ui/label';
import { Badge }    from '@/components/ui/badge';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import {
  type BaseComponent, type BaseComponentMap,
  computeBaseComponentCost, propagateBaseComponentChange,
  getLinkedRecipes, makeBaseComponentIngredient,
  createBaseComponent, saveBasiskomponentenToDB,
} from '@/lib/basiskomponenten-store';
import {
  type RecipeIngredient, type RezepturenMap,
  emptyIngredient, computeRecipeCosts,
  saveRezepturenToDB,
} from '@/lib/rezeptur-store';
import { loadArtikelFromDB, type Artikel } from '@/lib/artikel-store';
import type { ProductCostEntry } from '@/lib/produkte-store';

const fmtChf = (n: number) => `CHF ${n.toFixed(4)}`;
const fmtChf2 = (n: number) => `CHF ${n.toFixed(2)}`;

// ── Ingredient Editor Row (reused in editor) ──────────────────────────────────

function BcIngredientRow({
  ing, articles, onChange, onRemove,
}: {
  ing: RecipeIngredient;
  articles: Artikel[];
  onChange: (p: Partial<RecipeIngredient>) => void;
  onRemove: () => void;
}) {
  function handleArticleChange(id: string) {
    if (!id || id === '__manual__') {
      onChange({ articleId: '', articleName: '', costPerUnit: 0, unit: 'Stück', supplier: '' });
      return;
    }
    const art = articles.find(a => a.id === id);
    if (!art) return;
    onChange({ articleId: art.id, articleName: art.name, costPerUnit: art.defaultCostPerUnit, unit: art.unit, supplier: art.standardSupplier });
  }
  const lineCost = ing.quantity * ing.costPerUnit;

  return (
    <div className="grid grid-cols-[1fr_72px_64px_84px_28px] gap-1.5 items-center py-1.5 border-b border-border/40 last:border-0">
      <div className="min-w-0">
        <Select value={ing.articleId || '__manual__'} onValueChange={v => handleArticleChange(v === '__manual__' ? '' : v)}>
          <SelectTrigger className="h-7 text-xs"><SelectValue placeholder="Artikel…" /></SelectTrigger>
          <SelectContent className="max-h-48">
            <SelectItem value="__manual__">– Manuell –</SelectItem>
            {articles.map(a => <SelectItem key={a.id} value={a.id}>{a.name}</SelectItem>)}
          </SelectContent>
        </Select>
        {!ing.articleId && (
          <Input className="h-6 text-xs mt-0.5" placeholder="Bezeichnung" value={ing.articleName}
            onChange={e => onChange({ articleName: e.target.value })} />
        )}
      </div>
      <Input type="number" min="0" step="0.001" className="h-7 text-xs text-right" value={ing.quantity || ''}
        onChange={e => onChange({ quantity: parseFloat(e.target.value) || 0 })} />
      <Input className="h-7 text-xs" placeholder="kg" value={ing.unit}
        onChange={e => onChange({ unit: e.target.value })} />
      <div className="text-right">
        <Input type="number" min="0" step="0.0001" className="h-7 text-xs text-right" value={ing.costPerUnit || ''}
          onChange={e => onChange({ costPerUnit: parseFloat(e.target.value) || 0 })} placeholder="0.00" />
        <div className="text-[9px] text-muted-foreground mt-0.5 pr-0.5">= {fmtChf2(lineCost)}</div>
      </div>
      <button onClick={onRemove} className="text-muted-foreground hover:text-destructive transition-colors self-start mt-1">
        <Trash2 className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}

// ── Basiskomponente bearbeiten / neu erstellen ─────────────────────────────────

interface EditorState {
  id: string | null;   // null = neu
  name: string;
  unit: string;
  note: string;
  ingredients: RecipeIngredient[];
}

function emptyEditor(): EditorState {
  return { id: null, name: '', unit: 'Portion', note: '', ingredients: [] };
}

function editorFromBc(bc: BaseComponent): EditorState {
  return { id: bc.id, name: bc.name, unit: bc.unit, note: bc.note, ingredients: [...bc.ingredients] };
}

function BcEditor({
  initial, articles, onSave, onCancel,
}: {
  initial: EditorState;
  articles: Artikel[];
  onSave: (e: EditorState) => void;
  onCancel: () => void;
}) {
  const [state, setState] = useState<EditorState>(initial);

  function set<K extends keyof EditorState>(k: K, v: EditorState[K]) {
    setState(s => ({ ...s, [k]: v }));
  }
  function addIng() {
    setState(s => ({ ...s, ingredients: [...s.ingredients, emptyIngredient()] }));
  }
  function updateIng(id: string, patch: Partial<RecipeIngredient>) {
    setState(s => ({ ...s, ingredients: s.ingredients.map(i => i.id === id ? { ...i, ...patch } : i) }));
  }
  function removeIng(id: string) {
    setState(s => ({ ...s, ingredients: s.ingredients.filter(i => i.id !== id) }));
  }
  const totalCost = state.ingredients.reduce((s, i) => s + i.quantity * i.costPerUnit, 0);

  function handleSave() {
    if (!state.name.trim()) { toast.error('Name der Basiskomponente fehlt'); return; }
    if (state.ingredients.length === 0) { toast.error('Mindestens eine Zutat erforderlich'); return; }
    onSave(state);
  }

  return (
    <div className="rounded-xl border border-primary/30 bg-card shadow-sm">
      <div className="flex items-center gap-2 px-4 py-3 border-b bg-primary/5">
        <Layers className="h-4 w-4 text-primary" />
        <span className="text-sm font-semibold">
          {state.id ? 'Basiskomponente bearbeiten' : 'Neue Basiskomponente'}
        </span>
        <button onClick={onCancel} className="ml-auto text-muted-foreground hover:text-foreground"><X className="h-4 w-4" /></button>
      </div>
      <div className="p-4 space-y-3">

        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-1">
            <Label className="text-xs">Name *</Label>
            <Input placeholder="z.B. Pasta Basis, Risotto Basis…" value={state.name}
              onChange={e => set('name', e.target.value)} />
          </div>
          <div className="space-y-1">
            <Label className="text-xs">Einheit pro Portion</Label>
            <Input placeholder="z.B. Portion, 100g, dl" value={state.unit}
              onChange={e => set('unit', e.target.value)} />
          </div>
        </div>

        <div className="space-y-1">
          <Label className="text-xs">Notiz / Verwendungshinweis</Label>
          <Input placeholder="z.B. Grundlage für alle Pasta-Gerichte, 1 Portion = 180g" value={state.note}
            onChange={e => set('note', e.target.value)} />
        </div>

        {/* Zutaten */}
        <div>
          <div className="flex items-center justify-between mb-1">
            <Label className="text-xs text-muted-foreground">Zutaten der Basiskomponente</Label>
            <span className="text-xs text-muted-foreground">Menge · Einheit · CHF/Einheit</span>
          </div>
          <div className="rounded-lg border bg-card">
            <div className="grid grid-cols-[1fr_72px_64px_84px_28px] gap-1.5 px-3 py-1.5 border-b bg-muted/40">
              <span className="text-[10px] text-muted-foreground font-medium">Artikel</span>
              <span className="text-[10px] text-muted-foreground font-medium text-right">Menge</span>
              <span className="text-[10px] text-muted-foreground font-medium">Einheit</span>
              <span className="text-[10px] text-muted-foreground font-medium text-right">CHF/Einheit</span>
              <span />
            </div>
            <div className="px-3">
              {state.ingredients.length === 0
                ? <p className="py-3 text-xs text-center text-muted-foreground">Noch keine Zutaten. Klicke «Zutat hinzufügen».</p>
                : state.ingredients.map(ing => (
                    <BcIngredientRow key={ing.id} ing={ing} articles={articles}
                      onChange={p => updateIng(ing.id, p)} onRemove={() => removeIng(ing.id)} />
                  ))
              }
            </div>
            {state.ingredients.length > 0 && (
              <div className="px-3 py-2 border-t bg-muted/30 flex items-center justify-between">
                <span className="text-xs text-muted-foreground">Kosten pro {state.unit || 'Portion'}</span>
                <span className="text-sm font-bold text-primary">{fmtChf2(totalCost)}</span>
              </div>
            )}
          </div>
          <Button variant="outline" size="sm" onClick={addIng} className="mt-2 w-full text-xs h-7">
            <Plus className="h-3.5 w-3.5 mr-1" /> Zutat hinzufügen
          </Button>
        </div>

        <div className="flex gap-2 pt-1">
          <Button onClick={handleSave} className="flex-1">
            <Check className="h-4 w-4 mr-1" />
            {state.id ? 'Änderungen speichern' : 'Basiskomponente erstellen'}
          </Button>
          <Button variant="outline" onClick={onCancel}>Abbrechen</Button>
        </div>
      </div>
    </div>
  );
}

// ── Propagations-Vorschau ──────────────────────────────────────────────────────

interface PropagationPreviewProps {
  bc: BaseComponent;
  newCost: number;
  recipes: RezepturenMap;
  costs: ProductCostEntry[];
  onConfirm: () => void;
  onCancel: () => void;
}

function PropagationPreview({ bc, newCost, recipes, costs, onConfirm, onCancel }: PropagationPreviewProps) {
  const linked = getLinkedRecipes(bc.id, recipes);

  const rows = linked.map(recipe => {
    const costEntry = costs.find(c =>
      c.name.toLowerCase() === recipe.productName.toLowerCase() && c.category === recipe.category,
    );
    const oldIngCost = recipe.ingredients.reduce((s, i) => s + i.quantity * i.costPerUnit, 0);
    // Wie viele Portionen der Basis werden verwendet?
    const portionsUsed = recipe.ingredients
      .filter(i => i.baseRecipeId === bc.id)
      .reduce((s, i) => s + i.quantity, 0);
    const oldBasisCost = recipe.ingredients
      .filter(i => i.baseRecipeId === bc.id)
      .reduce((s, i) => s + i.quantity * i.costPerUnit, 0);
    const newBasisCost = portionsUsed * newCost;
    const costDiff = newBasisCost - oldBasisCost;

    // neue Gesamtkosten schätzen
    const oldTotal = costEntry ? (computeRecipeCosts(recipe, costEntry.nettoPrice, costEntry.bruttoPrice).totalCost) : null;
    const newTotal = oldTotal !== null ? oldTotal + costDiff : null;

    return { recipe, portionsUsed, oldBasisCost, newBasisCost, costDiff, oldTotal, newTotal, costEntry };
  });

  return (
    <div className="rounded-xl border border-amber-200 dark:border-amber-800 bg-amber-50 dark:bg-amber-950/20">
      <div className="flex items-center gap-2 px-4 py-3 border-b border-amber-200 dark:border-amber-700">
        <AlertTriangle className="h-4 w-4 text-amber-600" />
        <span className="text-sm font-semibold text-amber-800 dark:text-amber-300">
          Änderung propagieren – Vorschau
        </span>
      </div>
      <div className="p-4 space-y-3">
        <p className="text-xs text-amber-700 dark:text-amber-400">
          <strong>«{bc.name}»</strong> wird geändert.
          Portionspreis: <span className="font-mono">{fmtChf2(computeBaseComponentCost(bc))}</span>
          {' '}→{' '}
          <span className="font-mono font-semibold">{fmtChf2(newCost)}</span>.
          {linked.length === 0
            ? ' Keine verlinkten Produkte.'
            : ` ${linked.length} Produkt${linked.length !== 1 ? 'e' : ''} wird${linked.length !== 1 ? 'en' : ''} aktualisiert:`}
        </p>

        {rows.length > 0 && (
          <div className="rounded-lg border border-amber-200 dark:border-amber-700 bg-white dark:bg-amber-950/10 divide-y divide-amber-100 dark:divide-amber-900 overflow-hidden">
            {rows.map(row => (
              <div key={row.recipe.id} className="flex items-center gap-3 px-3 py-2 text-xs">
                <Package className="h-3.5 w-3.5 text-amber-500 shrink-0" />
                <span className="font-medium flex-1 min-w-0 truncate">{row.recipe.productName}</span>
                <span className="text-muted-foreground font-mono whitespace-nowrap">
                  {row.portionsUsed}× Portion
                </span>
                <span className="font-mono text-muted-foreground line-through whitespace-nowrap">
                  {fmtChf2(row.oldBasisCost)}
                </span>
                <ArrowRight className="h-3 w-3 text-muted-foreground" />
                <span className={`font-mono font-semibold whitespace-nowrap ${
                  row.costDiff > 0 ? 'text-red-600 dark:text-red-400' : row.costDiff < 0 ? 'text-emerald-600 dark:text-emerald-400' : 'text-foreground'
                }`}>
                  {fmtChf2(row.newBasisCost)}
                  {row.costDiff !== 0 && (
                    <span className="ml-1 text-[10px]">
                      ({row.costDiff > 0 ? '+' : ''}{fmtChf2(row.costDiff)})
                    </span>
                  )}
                </span>
              </div>
            ))}
          </div>
        )}

        <div className="flex gap-2">
          <Button size="sm" onClick={onConfirm}
            className="bg-amber-600 hover:bg-amber-700 text-white text-xs">
            <Check className="h-3.5 w-3.5 mr-1" />
            Ja, {linked.length} Rezeptur{linked.length !== 1 ? 'en' : ''} aktualisieren
          </Button>
          <Button size="sm" variant="ghost" className="text-xs" onClick={onCancel}>Abbrechen</Button>
        </div>
      </div>
    </div>
  );
}

// ── Hauptkomponente ────────────────────────────────────────────────────────────

interface Props {
  baseComponents: BaseComponentMap;
  recipes: RezepturenMap;
  costs: ProductCostEntry[];
  onBaseComponentsChange: (map: BaseComponentMap) => void;
  onRecipesChange: (map: RezepturenMap, updatedCosts: ProductCostEntry[]) => void;
}

export default function BasiskomponentenManager({
  baseComponents, recipes, costs,
  onBaseComponentsChange, onRecipesChange,
}: Props) {
  const [open, setOpen]           = useState(false);
  const [articles, setArticles]   = useState<Artikel[]>([]);
  const [editing, setEditing]     = useState<EditorState | null>(null);
  const [expanded, setExpanded]   = useState<Set<string>>(new Set());
  const [propagate, setPropagateId] = useState<string | null>(null);
  const [pendingBc, setPendingBc] = useState<BaseComponent | null>(null);

  useEffect(() => {
    if (open && articles.length === 0) {
      loadArtikelFromDB().then(store => setArticles(store.articles.filter(a => a.active)));
    }
  }, [open]);

  const bcList = useMemo(
    () => Object.values(baseComponents).sort((a, b) => a.name.localeCompare(b.name, 'de')),
    [baseComponents],
  );

  function toggleExpand(id: string) {
    setExpanded(s => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });
  }

  // ── Speichern (neu / bearbeiten) ──────────────────────────────────────────

  function handleEditorSave(state: EditorState) {
    let bc: BaseComponent;
    if (state.id) {
      // Bearbeiten – erst Propagation anbieten
      const existing = baseComponents[state.id];
      const newCost  = state.ingredients.reduce((s, i) => s + i.quantity * i.costPerUnit, 0);
      const oldCost  = computeBaseComponentCost(existing);
      bc = {
        ...existing,
        name:        state.name,
        unit:        state.unit,
        note:        state.note,
        ingredients: state.ingredients,
        updatedAt:   new Date().toISOString(),
      };
      const linked = getLinkedRecipes(bc.id, recipes);
      if (linked.length > 0 && Math.abs(newCost - oldCost) > 0.0001) {
        // Vorschau zeigen
        setPendingBc(bc);
        setPropagateId(bc.id);
        // Basis schon mal speichern
        const newMap = { ...baseComponents, [bc.id]: bc };
        onBaseComponentsChange(newMap);
        saveBasiskomponentenToDB(newMap);
        setEditing(null);
        return;
      }
      // Keine verlinkten oder Kosten unverändert → direkt speichern
      const newMap = { ...baseComponents, [bc.id]: bc };
      onBaseComponentsChange(newMap);
      saveBasiskomponentenToDB(newMap);
      toast.success(`«${bc.name}» gespeichert`);
      setEditing(null);
    } else {
      // Neu
      bc = createBaseComponent(state.name, state.unit, state.note, state.ingredients);
      const newMap = { ...baseComponents, [bc.id]: bc };
      onBaseComponentsChange(newMap);
      saveBasiskomponentenToDB(newMap);
      toast.success(`«${bc.name}» erstellt`);
      setEditing(null);
    }
  }

  // ── Propagation bestätigen ────────────────────────────────────────────────

  function handlePropagateConfirm() {
    if (!pendingBc) return;
    const { updatedMap, affectedRecipeIds } = propagateBaseComponentChange(pendingBc, recipes);

    // WES in costs aktualisieren
    const updatedCosts = costs.map(c => {
      const recipeId = affectedRecipeIds.find(id => {
        const r = updatedMap[id];
        return r && r.productName.toLowerCase() === c.name.toLowerCase() && r.category === c.category;
      });
      if (!recipeId) return c;
      const r = updatedMap[recipeId];
      const newIngCost = r.ingredients.reduce((s, i) => s + i.quantity * i.costPerUnit, 0);
      // Behalte Marge-Berechnung einfach: WES = Ingredient-Kosten + manualCost
      const newTotalCost = r.costMode === 'pauschal' ? r.manualCost
        : r.costMode === 'rezeptur' ? newIngCost
        : newIngCost + r.manualCost;
      const refPrice = c.nettoPrice > 0 ? c.nettoPrice : c.bruttoPrice;
      const newWesQ  = refPrice > 0 ? (newTotalCost / refPrice) * 100 : c.wesQ;
      return { ...c, wes: newTotalCost, wesQ: newWesQ };
    });

    onRecipesChange(updatedMap, updatedCosts);
    saveRezepturenToDB(updatedMap);
    toast.success(`${affectedRecipeIds.length} Rezeptur${affectedRecipeIds.length !== 1 ? 'en' : ''} aktualisiert`);
    setPropagateId(null);
    setPendingBc(null);
  }

  // ── Löschen ───────────────────────────────────────────────────────────────

  function handleDelete(bc: BaseComponent) {
    const linked = getLinkedRecipes(bc.id, recipes).length;
    if (linked > 0) {
      toast.error(`«${bc.name}» wird noch in ${linked} Rezeptur${linked !== 1 ? 'en' : ''} verwendet. Bitte zuerst dort entfernen.`);
      return;
    }
    if (!confirm(`Basiskomponente «${bc.name}» wirklich löschen?`)) return;
    const newMap = { ...baseComponents };
    delete newMap[bc.id];
    onBaseComponentsChange(newMap);
    saveBasiskomponentenToDB(newMap);
    toast.success(`«${bc.name}» gelöscht`);
  }

  // ── Collapsed trigger ─────────────────────────────────────────────────────

  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        className="w-full flex items-center gap-2 px-4 py-3 text-sm text-left rounded-lg border border-dashed border-border hover:border-primary/40 hover:bg-primary/5 transition-colors"
      >
        <Layers className="h-4 w-4 text-muted-foreground" />
        <span className="font-medium">Basiskomponenten</span>
        <span className="text-muted-foreground text-xs ml-1">
          – {bcList.length === 0 ? 'Keine vorhanden' : `${bcList.length} Komponente${bcList.length !== 1 ? 'n' : ''}`}
        </span>
        {bcList.length > 0 && (
          <Badge variant="outline" className="ml-auto text-[10px]">{bcList.length}</Badge>
        )}
        <ChevronRight className="h-4 w-4 text-muted-foreground" />
      </button>
    );
  }

  // ── Vollansicht ────────────────────────────────────────────────────────────

  return (
    <div className="rounded-xl border border-border bg-card overflow-hidden">
      {/* Header */}
      <div className="flex items-center gap-2 px-4 py-3 border-b bg-muted/30">
        <Layers className="h-4 w-4 text-primary" />
        <span className="text-sm font-semibold">Basiskomponenten</span>
        <span className="text-xs text-muted-foreground">
          – Wiederverwendbare Basisrezepturen
        </span>
        <button
          onClick={() => { setOpen(false); setEditing(null); setPropagateId(null); }}
          className="ml-auto text-xs text-muted-foreground hover:text-foreground"
        >
          Schliessen
        </button>
      </div>

      <div className="p-4 space-y-3">

        {/* Propagations-Vorschau */}
        {propagate && pendingBc && (
          <PropagationPreview
            bc={pendingBc}
            newCost={computeBaseComponentCost(pendingBc)}
            recipes={recipes}
            costs={costs}
            onConfirm={handlePropagateConfirm}
            onCancel={() => { setPropagateId(null); setPendingBc(null); }}
          />
        )}

        {/* Editor */}
        {editing && !propagate && (
          <BcEditor
            initial={editing}
            articles={articles}
            onSave={handleEditorSave}
            onCancel={() => setEditing(null)}
          />
        )}

        {/* Liste */}
        {!editing && !propagate && (
          <>
            {bcList.length === 0 ? (
              <div className="text-center py-8 text-sm text-muted-foreground border border-dashed rounded-lg">
                <Layers className="h-6 w-6 mx-auto mb-2 opacity-30" />
                <p>Noch keine Basiskomponenten vorhanden.</p>
                <p className="text-xs mt-1">Erstelle z.B. «Pasta Basis», «Risotto Basis» oder «Tomatensauce».</p>
              </div>
            ) : (
              <div className="rounded-xl border border-border divide-y divide-border/50 overflow-hidden">
                {bcList.map(bc => {
                  const cost    = computeBaseComponentCost(bc);
                  const linked  = getLinkedRecipes(bc.id, recipes);
                  const isOpen  = expanded.has(bc.id);

                  return (
                    <div key={bc.id}>
                      {/* Zeile */}
                      <div className="flex items-center gap-2 px-3 py-2.5 hover:bg-muted/20 transition-colors">
                        <button onClick={() => toggleExpand(bc.id)} className="flex items-center gap-2 flex-1 min-w-0 text-left">
                          {isOpen
                            ? <ChevronDown className="h-4 w-4 text-muted-foreground shrink-0" />
                            : <ChevronRight className="h-4 w-4 text-muted-foreground shrink-0" />}
                          <span className="text-sm font-medium truncate">{bc.name}</span>
                          <span className="text-xs text-muted-foreground shrink-0">/ {bc.unit}</span>
                          <span className="text-xs font-mono text-primary font-semibold shrink-0">{fmtChf2(cost)}</span>
                        </button>

                        {/* Verlinkte Produkte Badge */}
                        {linked.length > 0 && (
                          <Badge variant="secondary" className="text-[10px] shrink-0">
                            {linked.length} Produkt{linked.length !== 1 ? 'e' : ''}
                          </Badge>
                        )}

                        {/* Aktionen */}
                        <button
                          onClick={() => setEditing(editorFromBc(bc))}
                          className="p-1 text-muted-foreground hover:text-foreground transition-colors"
                          title="Bearbeiten"
                        >
                          <Pencil className="h-3.5 w-3.5" />
                        </button>
                        <button
                          onClick={() => handleDelete(bc)}
                          className="p-1 text-muted-foreground hover:text-destructive transition-colors"
                          title="Löschen"
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </button>
                      </div>

                      {/* Aufgeklappt */}
                      {isOpen && (
                        <div className="border-t bg-muted/10 px-4 py-3 space-y-2.5">
                          {bc.note && (
                            <p className="text-xs text-muted-foreground italic">{bc.note}</p>
                          )}

                          {/* Zutaten */}
                          <div>
                            <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wide mb-1.5">
                              Zutaten
                            </p>
                            <div className="space-y-1">
                              {bc.ingredients.map(ing => (
                                <div key={ing.id} className="flex items-center gap-2 text-xs">
                                  <span className="flex-1 truncate">{ing.articleName || '–'}</span>
                                  <span className="font-mono text-muted-foreground">{ing.quantity} {ing.unit}</span>
                                  <span className="font-mono">= {fmtChf2(ing.quantity * ing.costPerUnit)}</span>
                                </div>
                              ))}
                              <div className="flex justify-end pt-1 border-t border-border/40">
                                <span className="text-xs font-bold text-primary">Σ {fmtChf2(cost)} / {bc.unit}</span>
                              </div>
                            </div>
                          </div>

                          {/* Verlinkte Produkte */}
                          {linked.length > 0 && (
                            <div>
                              <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wide mb-1.5">
                                Verwendet in
                              </p>
                              <div className="flex flex-wrap gap-1.5">
                                {linked.map(r => (
                                  <span key={r.id}
                                    className="inline-flex items-center gap-1 text-[11px] bg-violet-50 dark:bg-violet-950/30 text-violet-700 dark:text-violet-400 border border-violet-200 dark:border-violet-800 px-2 py-0.5 rounded-full">
                                    <Package className="h-3 w-3" />
                                    {r.productName}
                                  </span>
                                ))}
                              </div>
                            </div>
                          )}

                          {/* Propagation manuell anstoßen */}
                          {linked.length > 0 && (
                            <Button
                              variant="outline"
                              size="sm"
                              className="text-xs h-7 gap-1.5 border-violet-200 text-violet-700 hover:bg-violet-50 dark:border-violet-800 dark:text-violet-400 dark:hover:bg-violet-950/30"
                              onClick={() => { setPendingBc(bc); setPropagateId(bc.id); }}
                            >
                              <RefreshCw className="h-3 w-3" />
                              Verlinkungen neu berechnen
                            </Button>
                          )}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}

            <Button
              variant="outline"
              size="sm"
              className="w-full text-xs gap-1.5"
              onClick={() => setEditing(emptyEditor())}
            >
              <Plus className="h-3.5 w-3.5" />
              Neue Basiskomponente erstellen
            </Button>
          </>
        )}

        {/* Info-Panel */}
        {!editing && !propagate && (
          <div className="rounded-lg bg-violet-50/60 dark:bg-violet-950/20 border border-violet-100 dark:border-violet-900 px-3 py-2 text-[10px] text-violet-700 dark:text-violet-400 leading-relaxed space-y-0.5">
            <p className="font-semibold text-[11px]">Was ist eine Basiskomponente?</p>
            <p>Eine Basiskomponente ist eine vordefinierte Basis, die in mehreren Rezepturen verwendet wird. Beispiele: «Pasta Basis», «Risotto Basis», «Tomatensauce».</p>
            <p>Wenn du eine Basiskomponente änderst, werden <strong>alle verlinkten Produkte automatisch aktualisiert</strong> – WES, Kosten und Marge.</p>
            <p>Im Rezeptur-Dialog kannst du unter «Basiskomponente hinzufügen» eine Basis als Zutat einfügen.</p>
          </div>
        )}

      </div>
    </div>
  );
}

// ── Export: Hilfsfunktion für RezepturDialog ──────────────────────────────────
// Damit der RezepturDialog Basiskomponenten als Zutaten hinzufügen kann,
// exportieren wir makeBaseComponentIngredient direkt aus dem Store (re-export).
export { makeBaseComponentIngredient };
