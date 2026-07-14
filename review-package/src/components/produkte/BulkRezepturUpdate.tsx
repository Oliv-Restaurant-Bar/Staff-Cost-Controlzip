/**
 * BulkRezepturUpdate
 * ==================
 * Erlaubt es, eine Rezeptur-Zutat (z.B. "Pasta Basis") in einem Schritt
 * bei mehreren Produkten zu aktualisieren.
 *
 * Ablauf:
 *   1. Zutat wählen (Dropdown aller bekannten Zutaten)
 *   2. Produkte auswählen (alle oder manuell)
 *   3. Neue Menge eingeben
 *   4. Vorschau bestätigen → alle Rezepturen auf einmal speichern
 */

import { useState, useMemo } from 'react';
import {
  ChevronsUpDown, RefreshCw, CheckSquare, Square, ChevronRight, AlertTriangle, Check,
} from 'lucide-react';
import { Button }  from '@/components/ui/button';
import { Input }   from '@/components/ui/input';
import { Label }   from '@/components/ui/label';
import { Badge }   from '@/components/ui/badge';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import type { RezepturenMap, ProductRecipe } from '@/lib/rezeptur-store';

interface Props {
  recipes: RezepturenMap;
  onSave: (newMap: RezepturenMap) => void;
}

interface AffectedRow {
  recipe: ProductRecipe;
  ingredientIdx: number;
  currentQty: number;
  unit: string;
}

export default function BulkRezepturUpdate({ recipes, onSave }: Props) {
  const [open, setOpen] = useState(false);

  // Schritt 1 – Zutat wählen
  const [selectedIngredientName, setSelectedIngredientName] = useState('');
  // Schritt 2 – Produktauswahl
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  // Schritt 3 – neue Menge
  const [newQtyStr, setNewQtyStr] = useState('');
  // Vorschau / Bestätigung
  const [confirming, setConfirming] = useState(false);
  const [done, setDone] = useState(false);

  // Alle einzigartigen Zutaten-Namen aus allen Rezepturen
  const allIngredientNames = useMemo(() => {
    const names = new Set<string>();
    for (const r of Object.values(recipes)) {
      for (const ing of r.ingredients) {
        if (ing.articleName.trim()) names.add(ing.articleName.trim());
      }
    }
    return [...names].sort((a, b) => a.localeCompare(b, 'de'));
  }, [recipes]);

  // Betroffene Produkte für die gewählte Zutat
  const affected = useMemo((): AffectedRow[] => {
    if (!selectedIngredientName) return [];
    const rows: AffectedRow[] = [];
    for (const r of Object.values(recipes)) {
      const idx = r.ingredients.findIndex(
        i => i.articleName.trim().toLowerCase() === selectedIngredientName.toLowerCase(),
      );
      if (idx >= 0) {
        rows.push({
          recipe: r,
          ingredientIdx: idx,
          currentQty: r.ingredients[idx].quantity,
          unit: r.ingredients[idx].unit,
        });
      }
    }
    return rows.sort((a, b) => a.recipe.productName.localeCompare(b.recipe.productName, 'de'));
  }, [recipes, selectedIngredientName]);

  // Wenn Zutat geändert → alle auswählen
  function handleIngredientChange(name: string) {
    setSelectedIngredientName(name);
    setNewQtyStr('');
    setConfirming(false);
    setDone(false);
    // Alle betroffenen Produkte vorausgewählt
    const all = new Set<string>();
    for (const r of Object.values(recipes)) {
      const hasIt = r.ingredients.some(
        i => i.articleName.trim().toLowerCase() === name.toLowerCase(),
      );
      if (hasIt) all.add(r.id);
    }
    setSelectedIds(all);
  }

  function toggleAll() {
    if (selectedIds.size === affected.length) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(affected.map(a => a.recipe.id)));
    }
  }

  function toggleRow(id: string) {
    const next = new Set(selectedIds);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setSelectedIds(next);
  }

  const newQty = parseFloat(newQtyStr.replace(',', '.'));
  const isValid = !isNaN(newQty) && newQty > 0 && selectedIds.size > 0;
  const selectedRows = affected.filter(r => selectedIds.has(r.recipe.id));

  function handleApply() {
    if (!isValid) return;
    const updated: RezepturenMap = { ...recipes };
    for (const row of selectedRows) {
      const oldRecipe = row.recipe;
      const newIngredients = oldRecipe.ingredients.map((ing, idx) =>
        idx === row.ingredientIdx ? { ...ing, quantity: newQty } : ing,
      );
      updated[oldRecipe.id] = {
        ...oldRecipe,
        ingredients: newIngredients,
        updatedAt: new Date().toISOString(),
      };
    }
    onSave(updated);
    setDone(true);
    setConfirming(false);
    setTimeout(() => {
      setDone(false);
      setSelectedIngredientName('');
      setNewQtyStr('');
      setSelectedIds(new Set());
      setOpen(false);
    }, 2200);
  }

  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        className="w-full flex items-center gap-2 px-4 py-3 text-sm text-left rounded-lg border border-dashed border-border hover:border-primary/40 hover:bg-primary/5 transition-colors"
      >
        <RefreshCw className="h-4 w-4 text-muted-foreground" />
        <span className="font-medium">Massen-Update Rezeptur-Zutat</span>
        <span className="text-muted-foreground text-xs ml-1">– Eine Zutat bei mehreren Produkten auf einmal anpassen</span>
        <ChevronRight className="h-4 w-4 ml-auto text-muted-foreground" />
      </button>
    );
  }

  return (
    <div className="rounded-xl border border-border bg-card overflow-hidden">
      {/* Header */}
      <div className="flex items-center gap-2 px-4 py-3 border-b bg-muted/30">
        <RefreshCw className="h-4 w-4 text-primary" />
        <span className="text-sm font-semibold">Massen-Update: Rezeptur-Zutat</span>
        <button
          onClick={() => { setOpen(false); setConfirming(false); setDone(false); }}
          className="ml-auto text-xs text-muted-foreground hover:text-foreground"
        >
          Schliessen
        </button>
      </div>

      <div className="p-4 space-y-5">

        {/* Schritt 1 – Zutat */}
        <div className="space-y-1.5">
          <Label className="text-xs font-medium">
            <span className="inline-flex items-center gap-1.5">
              <span className="w-5 h-5 rounded-full bg-primary text-primary-foreground text-[10px] font-bold flex items-center justify-center">1</span>
              Welche Zutat möchtest du aktualisieren?
            </span>
          </Label>
          <Select value={selectedIngredientName} onValueChange={handleIngredientChange}>
            <SelectTrigger className="text-sm">
              <SelectValue placeholder="Zutat wählen…" />
            </SelectTrigger>
            <SelectContent className="max-h-60">
              {allIngredientNames.length === 0 ? (
                <div className="px-3 py-2 text-xs text-muted-foreground">
                  Keine Zutaten gefunden – bitte zuerst Rezepturen anlegen.
                </div>
              ) : (
                allIngredientNames.map(n => (
                  <SelectItem key={n} value={n}>{n}</SelectItem>
                ))
              )}
            </SelectContent>
          </Select>
        </div>

        {/* Schritt 2 – Produkte */}
        {selectedIngredientName && (
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <Label className="text-xs font-medium">
                <span className="inline-flex items-center gap-1.5">
                  <span className="w-5 h-5 rounded-full bg-primary text-primary-foreground text-[10px] font-bold flex items-center justify-center">2</span>
                  Welche Produkte sollen aktualisiert werden?
                </span>
              </Label>
              <button
                onClick={toggleAll}
                className="text-[10px] text-primary hover:underline"
              >
                {selectedIds.size === affected.length ? 'Alle abwählen' : 'Alle auswählen'}
              </button>
            </div>

            {affected.length === 0 ? (
              <p className="text-xs text-muted-foreground py-2">
                Keine Produkte gefunden, die «{selectedIngredientName}» als Zutat haben.
              </p>
            ) : (
              <div className="border border-border rounded-lg divide-y divide-border/50 overflow-hidden">
                {affected.map(row => {
                  const checked = selectedIds.has(row.recipe.id);
                  return (
                    <button
                      key={row.recipe.id}
                      onClick={() => toggleRow(row.recipe.id)}
                      className={`w-full flex items-center gap-3 px-3 py-2 text-left transition-colors hover:bg-muted/40 ${checked ? 'bg-primary/5' : ''}`}
                    >
                      {checked
                        ? <CheckSquare className="h-4 w-4 text-primary shrink-0" />
                        : <Square className="h-4 w-4 text-muted-foreground shrink-0" />
                      }
                      <span className="text-xs font-medium flex-1">{row.recipe.productName}</span>
                      <Badge variant="outline" className="text-[10px] font-mono">
                        {row.currentQty} {row.unit}
                      </Badge>
                      <span className="text-[10px] text-muted-foreground capitalize">
                        {row.recipe.category}
                      </span>
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        )}

        {/* Schritt 3 – Neue Menge */}
        {selectedIngredientName && affected.length > 0 && (
          <div className="space-y-1.5">
            <Label className="text-xs font-medium">
              <span className="inline-flex items-center gap-1.5">
                <span className="w-5 h-5 rounded-full bg-primary text-primary-foreground text-[10px] font-bold flex items-center justify-center">3</span>
                Neue Menge für «{selectedIngredientName}»
                {affected[0]?.unit && (
                  <span className="text-muted-foreground font-normal">({affected[0].unit})</span>
                )}
              </span>
            </Label>
            <div className="flex items-center gap-2">
              <Input
                type="number"
                min="0.001"
                step="0.001"
                placeholder="z.B. 200"
                value={newQtyStr}
                onChange={e => { setNewQtyStr(e.target.value); setConfirming(false); setDone(false); }}
                className="max-w-[160px]"
              />
              {newQtyStr && !isNaN(newQty) && newQty > 0 && selectedIds.size > 0 && !confirming && !done && (
                <Button size="sm" variant="outline" onClick={() => setConfirming(true)}>
                  Vorschau anzeigen →
                </Button>
              )}
            </div>
          </div>
        )}

        {/* Vorschau / Bestätigung */}
        {confirming && isValid && (
          <div className="rounded-lg border border-amber-200 dark:border-amber-800 bg-amber-50 dark:bg-amber-950/30 p-3 space-y-2">
            <p className="text-xs font-semibold text-amber-800 dark:text-amber-300 flex items-center gap-1.5">
              <AlertTriangle className="h-3.5 w-3.5" />
              Vorschau – bitte bestätigen
            </p>
            <p className="text-[11px] text-amber-700 dark:text-amber-400">
              Zutat «<strong>{selectedIngredientName}</strong>» wird bei{' '}
              <strong>{selectedRows.length}</strong> Produkt
              {selectedRows.length !== 1 ? 'en' : ''} von der bisherigen Menge auf{' '}
              <strong>{newQty} {affected[0]?.unit}</strong> geändert:
            </p>
            <div className="space-y-1 max-h-40 overflow-auto">
              {selectedRows.map(row => (
                <div key={row.recipe.id}
                  className="flex items-center gap-2 text-[11px] text-amber-800 dark:text-amber-200">
                  <ChevronsUpDown className="h-3 w-3 shrink-0 text-amber-500" />
                  <span className="font-medium flex-1">{row.recipe.productName}</span>
                  <span className="font-mono line-through opacity-60">{row.currentQty} {row.unit}</span>
                  <span className="font-mono text-emerald-700 dark:text-emerald-400 font-semibold">→ {newQty} {row.unit}</span>
                </div>
              ))}
            </div>
            <div className="flex gap-2 pt-1">
              <Button size="sm" onClick={handleApply} className="bg-amber-600 hover:bg-amber-700 text-white text-xs">
                Ja, alle {selectedRows.length} Rezeptur{selectedRows.length !== 1 ? 'en' : ''} aktualisieren
              </Button>
              <Button size="sm" variant="ghost" className="text-xs" onClick={() => setConfirming(false)}>
                Abbrechen
              </Button>
            </div>
          </div>
        )}

        {/* Erfolgsmeldung */}
        {done && (
          <div className="rounded-lg border border-emerald-200 dark:border-emerald-800 bg-emerald-50 dark:bg-emerald-950/30 p-3 flex items-center gap-2 text-emerald-700 dark:text-emerald-400">
            <Check className="h-4 w-4" />
            <span className="text-xs font-medium">
              {selectedRows.length} Rezeptur{selectedRows.length !== 1 ? 'en' : ''} wurden erfolgreich aktualisiert.
            </span>
          </div>
        )}

      </div>
    </div>
  );
}
