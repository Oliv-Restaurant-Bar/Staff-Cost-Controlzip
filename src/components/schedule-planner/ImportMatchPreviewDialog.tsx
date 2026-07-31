import { useState, useEffect, useMemo } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Check, UserPlus, Link2, AlertTriangle, RefreshCw, X, Ban, Sparkles, Save, History, Zap, Lightbulb, Inbox } from 'lucide-react';
import { Employee } from '@/types/personnel';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue, SelectGroup, SelectLabel } from '@/components/ui/select';
import { cn } from '@/lib/utils';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { 
  NameSuggestion, 
  loadSavedNameMappings, 
  saveNameMappings, 
  calculateSimilarity,
  SavedNameMapping,
  detectNewEmployeesWithSuggestions,
  getAutoApplicableSuggestions,
  SmartDetectionResult
} from '@/lib/name-matching';
import { Badge } from '@/components/ui/badge';
import { toast } from 'sonner';

// Generic NameMatchInfo interface that works with both schedule and employee imports
export interface NameMatchInfo {
  importedName: string;
  matchedEmployee: Employee | null;
  matchType: 'exact' | 'firstName' | 'saved' | 'new';
  isNew?: boolean;
  suggestions?: NameSuggestion[];
}

export interface NameMatchOverride {
  importedName: string;
  selectedEmployeeId: string | 'new' | 'skip' | 'park';
}

interface ImportMatchPreviewDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  nameMatches: NameMatchInfo[];
  existingEmployees: Employee[];
  onConfirm: (overrides: NameMatchOverride[]) => void;
  onCancel: () => void;
  /** Option «Als offene Stunden parken» anbieten (nur MIRUS-Reconcile-Import). */
  allowPark?: boolean;
}

export function ImportMatchPreviewDialog({
  open,
  onOpenChange,
  nameMatches,
  existingEmployees,
  onConfirm,
  onCancel,
  allowPark = false,
}: ImportMatchPreviewDialogProps) {
  // Track manual overrides
  const [overrides, setOverrides] = useState<Record<string, string>>({});
  const [savedMappings, setSavedMappings] = useState<SavedNameMapping[]>([]);

  // Load saved mappings on mount
  useEffect(() => {
    setSavedMappings(loadSavedNameMappings());
  }, []);

  // Smart detection for unmatched names
  const smartDetection = useMemo(() => {
    const unmatchedNames = nameMatches
      .filter(m => m.matchType === 'new')
      .map(m => m.importedName);
    
    if (unmatchedNames.length === 0) return null;
    
    const results = detectNewEmployeesWithSuggestions(unmatchedNames, existingEmployees, savedMappings);
    return getAutoApplicableSuggestions(results);
  }, [nameMatches, existingEmployees, savedMappings]);

  // Calculate suggestions for each unmatched name (enhanced with smart detection)
  const suggestionsMap = useMemo(() => {
    const map: Record<string, { suggestions: NameSuggestion[]; smartResult?: SmartDetectionResult }> = {};
    
    nameMatches.forEach(match => {
      if (match.matchType === 'new') {
        // Check if there's a saved mapping
        const savedMapping = savedMappings.find(
          m => m.importedName.toLowerCase() === match.importedName.toLowerCase()
        );
        
        // Get smart detection result
        const smartResult = smartDetection?.autoApply.find(r => r.importedName === match.importedName) 
          || smartDetection?.needsReview.find(r => r.importedName === match.importedName);
        
        if (savedMapping) {
          const savedEmployee = existingEmployees.find(e => e.id === savedMapping.employeeId);
          if (savedEmployee) {
            map[match.importedName] = {
              suggestions: [{
                employee: savedEmployee,
                similarity: 1,
                matchReason: 'saved'
              }],
              smartResult
            };
            return;
          }
        }

        // Use smart detection suggestions or fall back to basic similarity
        if (smartResult && smartResult.allSuggestions.length > 0) {
          map[match.importedName] = {
            suggestions: smartResult.allSuggestions,
            smartResult
          };
        } else {
          // Calculate Levenshtein-based suggestions as fallback
          const suggestions: NameSuggestion[] = existingEmployees
            .map(emp => ({
              employee: emp,
              similarity: calculateSimilarity(match.importedName, emp.name),
              matchReason: 'similar' as const
            }))
            .filter(s => s.similarity > 0.3)
            .sort((a, b) => b.similarity - a.similarity)
            .slice(0, 5);
          
          map[match.importedName] = { suggestions, smartResult };
        }
      }
    });
    
    return map;
  }, [nameMatches, existingEmployees, savedMappings, smartDetection]);

  // Reset overrides when dialog opens with new data
  useEffect(() => {
    if (open) {
      const initialOverrides: Record<string, string> = {};
      nameMatches.forEach(match => {
        // Check for saved mapping first
        const savedMapping = savedMappings.find(
          m => m.importedName.toLowerCase() === match.importedName.toLowerCase()
        );
        
        if (savedMapping && existingEmployees.find(e => e.id === savedMapping.employeeId)) {
          initialOverrides[match.importedName] = savedMapping.employeeId;
        } else if (match.matchType === 'new') {
          initialOverrides[match.importedName] = 'new';
        } else if (match.matchedEmployee) {
          initialOverrides[match.importedName] = match.matchedEmployee.id;
        }
      });
      setOverrides(initialOverrides);
    }
  }, [open, nameMatches, savedMappings, existingEmployees]);

  const handleOverrideChange = (importedName: string, value: string) => {
    setOverrides(prev => ({ ...prev, [importedName]: value }));
  };

  const handleConfirm = () => {
    // Save manual mappings for future imports
    const mappingsToSave: { importedName: string; employee: Employee }[] = [];
    
    nameMatches.forEach(match => {
      const selectedId = overrides[match.importedName];
      // Only save if user manually selected an existing employee (not 'new' or 'skip')
      if (selectedId && selectedId !== 'new' && selectedId !== 'skip') {
        const employee = existingEmployees.find(e => e.id === selectedId);
        if (employee) {
          // Check if this is a new manual mapping (not exact match)
          const wasExactMatch = match.matchType === 'exact' && match.matchedEmployee?.id === selectedId;
          if (!wasExactMatch) {
            mappingsToSave.push({ importedName: match.importedName, employee });
          }
        }
      }
    });

    if (mappingsToSave.length > 0) {
      saveNameMappings(mappingsToSave);
      toast.success(`${mappingsToSave.length} Zuordnung(en) für zukünftige Imports gespeichert`);
    }

    const overrideList: NameMatchOverride[] = nameMatches.map(match => ({
      importedName: match.importedName,
      selectedEmployeeId: overrides[match.importedName] || (match.matchedEmployee?.id || 'new')
    }));
    onConfirm(overrideList);
  };

  const exactMatches = nameMatches.filter(m => m.matchType === 'exact');
  const firstNameMatches = nameMatches.filter(m => m.matchType === 'firstName');
  const savedMatches = nameMatches.filter(m => m.matchType === 'saved');
  const newEmployees = nameMatches.filter(m => m.matchType === 'new');

  // Count current selections
  const currentOverrides = Object.entries(overrides);
  const skippedCount = currentOverrides.filter(([_, v]) => v === 'skip').length;
  const newCount = currentOverrides.filter(([_, v]) => v === 'new').length;
  const parkedCount = currentOverrides.filter(([_, v]) => v === 'park').length;
  const matchedCount = currentOverrides.filter(([_, v]) => v !== 'skip' && v !== 'new' && v !== 'park').length;

  // Check how many new employees are using saved suggestions
  const usingSavedCount = newEmployees.filter(m => {
    const savedMapping = savedMappings.find(
      sm => sm.importedName.toLowerCase() === m.importedName.toLowerCase()
    );
    return savedMapping && overrides[m.importedName] === savedMapping.employeeId;
  }).length;

  // Check if there are unresolved new employees (not yet assigned or skipped)
  const unresolvedNewEmployees = newEmployees.filter(m => {
    const value = overrides[m.importedName];
    return value === 'new'; // Still set to "new" - needs attention
  });

  const hasUnresolvedIssues = unresolvedNewEmployees.length > 0;

  // Skip all unmatched names
  const handleSkipAllUnmatched = () => {
    const newOverrides = { ...overrides };
    newEmployees.forEach(match => {
      newOverrides[match.importedName] = 'skip';
    });
    setOverrides(newOverrides);
  };

  // Assign all unmatched to new employees
  const handleCreateAllUnmatched = () => {
    const newOverrides = { ...overrides };
    newEmployees.forEach(match => {
      newOverrides[match.importedName] = 'new';
    });
    setOverrides(newOverrides);
  };

  // Apply all saved suggestions
  const handleApplyAllSavedSuggestions = () => {
    const newOverrides = { ...overrides };
    newEmployees.forEach(match => {
      const savedMapping = savedMappings.find(
        sm => sm.importedName.toLowerCase() === match.importedName.toLowerCase()
      );
      if (savedMapping && existingEmployees.find(e => e.id === savedMapping.employeeId)) {
        newOverrides[match.importedName] = savedMapping.employeeId;
      }
    });
    setOverrides(newOverrides);
  };

  // Apply all smart suggestions automatically
  const handleApplySmartSuggestions = () => {
    if (!smartDetection) return;
    
    const newOverrides = { ...overrides };
    let appliedCount = 0;
    
    // Apply auto-applicable suggestions
    smartDetection.autoApply.forEach(result => {
      if (result.suggestedEmployee) {
        newOverrides[result.importedName] = result.suggestedEmployee.id;
        appliedCount++;
      }
    });
    
    // Also apply high-confidence needsReview items
    smartDetection.needsReview.forEach(result => {
      if (result.suggestedEmployee && result.confidence >= 0.7) {
        newOverrides[result.importedName] = result.suggestedEmployee.id;
        appliedCount++;
      }
    });
    
    setOverrides(newOverrides);
    if (appliedCount > 0) {
      toast.success(`${appliedCount} intelligente Zuordnung${appliedCount !== 1 ? 'en' : ''} angewendet`);
    }
  };

  // Check if there are applicable saved suggestions
  const hasSavedSuggestions = newEmployees.some(m => {
    const savedMapping = savedMappings.find(
      sm => sm.importedName.toLowerCase() === m.importedName.toLowerCase()
    );
    return savedMapping && existingEmployees.find(e => e.id === savedMapping.employeeId);
  });

  // Check if there are smart suggestions available
  const hasSmartSuggestions = smartDetection && (
    smartDetection.autoApply.length > 0 || 
    smartDetection.needsReview.filter(r => r.confidence >= 0.7).length > 0
  );
  
  const smartSuggestionCount = smartDetection ? (
    smartDetection.autoApply.length + 
    smartDetection.needsReview.filter(r => r.confidence >= 0.7).length
  ) : 0;

  const renderMatchRow = (match: NameMatchInfo, bgClass: string, isError: boolean = false) => {
    const currentValue = overrides[match.importedName] || (match.matchedEmployee?.id || 'new');
    const isOverridden = match.matchedEmployee && currentValue !== match.matchedEmployee.id;
    const isSkipped = currentValue === 'skip';
    const isParked = currentValue === 'park';
    const isAssignedToExisting = currentValue !== 'skip' && currentValue !== 'new' && currentValue !== 'park';
    const isResolved = isSkipped || isParked || isAssignedToExisting;
    
    // Get suggestions for this name
    const suggestionData = suggestionsMap[match.importedName];
    const suggestions = suggestionData?.suggestions || [];
    const smartResult = suggestionData?.smartResult;
    const savedSuggestion = suggestions.find(s => s.matchReason === 'saved');
    const similarSuggestions = suggestions.filter(s => s.matchReason !== 'saved');
    
    // Check if using a saved mapping
    const isUsingSaved = savedSuggestion && currentValue === savedSuggestion.employee.id;
    
    // Check if using a smart suggestion
    const isUsingSmartSuggestion = smartResult?.suggestedEmployee && 
      currentValue === smartResult.suggestedEmployee.id && 
      smartResult.matchReason === 'pattern';

    return (
      <div 
        key={match.importedName} 
        className={cn(
          "flex flex-col gap-2 text-sm px-3 py-2 rounded border",
          isSkipped ? "bg-muted/50 opacity-60 border-transparent" : bgClass,
          isOverridden && !isSkipped && "ring-2 ring-primary/50",
          isError && !isResolved && "border-destructive/50 bg-destructive/10 dark:bg-destructive/20",
          isError && isResolved && "border-green-500/50 bg-green-50 dark:bg-green-900/20"
        )}
      >
        <div className="flex items-center gap-2">
          {isError && !isResolved && (
            <AlertTriangle className="h-4 w-4 text-destructive shrink-0" />
          )}
          {isError && isResolved && (
            <Check className="h-4 w-4 text-green-600 shrink-0" />
          )}
          {isUsingSaved && (
            <History className="h-4 w-4 text-purple-600 shrink-0" />
          )}
          <span className={cn(
            "font-medium min-w-[100px] truncate",
            isError && !isResolved && "text-destructive"
          )}>
            {match.importedName}
          </span>
          {isUsingSaved && (
            <Badge variant="outline" className="text-xs bg-purple-50 dark:bg-purple-900/30 border-purple-200 dark:border-purple-800">
              <Save className="h-2.5 w-2.5 mr-1" />
              Gespeichert
            </Badge>
          )}
          {isUsingSmartSuggestion && smartResult?.patternDetected && (
            <Badge variant="outline" className="text-xs bg-blue-50 dark:bg-blue-900/30 border-blue-200 dark:border-blue-800">
              <Zap className="h-2.5 w-2.5 mr-1" />
              {smartResult.patternDetected}
            </Badge>
          )}
          {smartResult && smartResult.confidence >= 0.85 && !isUsingSaved && !isUsingSmartSuggestion && smartResult.suggestedEmployee && currentValue !== smartResult.suggestedEmployee.id && (
            <Badge variant="outline" className="text-xs bg-amber-50 dark:bg-amber-900/30 border-amber-200 dark:border-amber-800 animate-pulse">
              <Lightbulb className="h-2.5 w-2.5 mr-1" />
              Vorschlag: {smartResult.suggestedEmployee.name}
            </Badge>
          )}
          <span className="text-muted-foreground">→</span>
          <Select 
            value={currentValue} 
            onValueChange={(v) => handleOverrideChange(match.importedName, v)}
          >
            <SelectTrigger className={cn(
              "h-8 flex-1 min-w-[180px]",
              isError && !isResolved && "border-destructive"
            )}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="skip" className="text-muted-foreground">
                <span className="flex items-center gap-2">
                  <X className="h-3 w-3" />
                  Überspringen
                </span>
              </SelectItem>
              <SelectItem value="new" className="text-amber-600">
                <span className="flex items-center gap-2">
                  <UserPlus className="h-3 w-3" />
                  Neu erstellen
                </span>
              </SelectItem>
              {allowPark && (
                <SelectItem value="park" className="text-sky-700">
                  <span className="flex items-center gap-2">
                    <Inbox className="h-3 w-3" />
                    Als offene Stunden parken (später zuweisen)
                  </span>
                </SelectItem>
              )}
              
              {/* Saved suggestion */}
              {savedSuggestion && (
                <SelectGroup>
                  <SelectLabel className="text-purple-600 flex items-center gap-1">
                    <History className="h-3 w-3" />
                    Gespeicherte Zuordnung
                  </SelectLabel>
                  <SelectItem value={savedSuggestion.employee.id} className="text-purple-600">
                    <span className="flex items-center gap-2">
                      <Save className="h-3 w-3" />
                      {savedSuggestion.employee.name} ({savedSuggestion.employee.department})
                    </span>
                  </SelectItem>
                </SelectGroup>
              )}
              
              {/* Similar suggestions */}
              {similarSuggestions.length > 0 && (
                <SelectGroup>
                  <SelectLabel className="text-blue-600 flex items-center gap-1">
                    <Sparkles className="h-3 w-3" />
                    Ähnliche Namen ({Math.round(similarSuggestions[0].similarity * 100)}% Übereinstimmung)
                  </SelectLabel>
                  {similarSuggestions.map(suggestion => (
                    <SelectItem key={suggestion.employee.id} value={suggestion.employee.id}>
                      <span className="flex items-center gap-2">
                        <span className="text-xs text-muted-foreground">
                          {Math.round(suggestion.similarity * 100)}%
                        </span>
                        {suggestion.employee.name} ({suggestion.employee.department})
                      </span>
                    </SelectItem>
                  ))}
                </SelectGroup>
              )}
              
              {/* All employees */}
              <SelectGroup>
                <SelectLabel>Alle Mitarbeiter</SelectLabel>
                {existingEmployees.map(emp => (
                  <SelectItem key={emp.id} value={emp.id}>
                    {emp.name} ({emp.department})
                  </SelectItem>
                ))}
              </SelectGroup>
            </SelectContent>
          </Select>
          {isOverridden && !isSkipped && (
            <Button 
              variant="ghost" 
              size="sm" 
              className="h-6 w-6 p-0"
              onClick={() => handleOverrideChange(match.importedName, match.matchedEmployee?.id || 'new')}
            >
              <RefreshCw className="h-3 w-3" />
            </Button>
          )}
        </div>
      </div>
    );
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl max-h-[85vh] overflow-hidden flex flex-col">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Link2 className="h-5 w-5" />
            Name-Matching Vorschau
          </DialogTitle>
        </DialogHeader>
        
        <div className="flex-1 overflow-auto space-y-4 py-2">
          {/* Error Alert for unmatched names */}
          {newEmployees.length > 0 && (
            <Alert variant="destructive" className="border-destructive/50">
              <AlertTriangle className="h-4 w-4" />
              <AlertTitle>
                {unresolvedNewEmployees.length > 0 
                  ? `${unresolvedNewEmployees.length} Namen nicht gefunden!`
                  : 'Alle nicht gefundenen Namen wurden zugeordnet'}
              </AlertTitle>
              <AlertDescription className="mt-2">
                {unresolvedNewEmployees.length > 0 ? (
                  <>
                    <p className="mb-3 text-sm">
                      Die folgenden Namen konnten keinem Mitarbeiter zugeordnet werden. 
                      Bitte ordne sie manuell zu oder überspringe sie.
                      {hasSavedSuggestions && ' Es gibt gespeicherte Zuordnungen von früheren Imports.'}
                    </p>
                    <div className="flex flex-wrap gap-2">
                      {hasSmartSuggestions && (
                        <Button 
                          variant="outline" 
                          size="sm"
                          onClick={handleApplySmartSuggestions}
                          className="border-blue-500/50 hover:bg-blue-500/10 text-blue-700 dark:text-blue-400"
                        >
                          <Zap className="h-3 w-3 mr-1" />
                          Auto-Zuordnung ({smartSuggestionCount})
                        </Button>
                      )}
                      {hasSavedSuggestions && (
                        <Button 
                          variant="outline" 
                          size="sm"
                          onClick={handleApplyAllSavedSuggestions}
                          className="border-purple-500/50 hover:bg-purple-500/10 text-purple-700 dark:text-purple-400"
                        >
                          <History className="h-3 w-3 mr-1" />
                          Gespeicherte anwenden
                        </Button>
                      )}
                      <Button 
                        variant="outline" 
                        size="sm"
                        onClick={handleSkipAllUnmatched}
                        className="border-destructive/50 hover:bg-destructive/10"
                      >
                        <Ban className="h-3 w-3 mr-1" />
                        Alle überspringen
                      </Button>
                      <Button 
                        variant="outline" 
                        size="sm"
                        onClick={handleCreateAllUnmatched}
                        className="border-amber-500/50 hover:bg-amber-500/10 text-amber-700 dark:text-amber-400"
                      >
                        <UserPlus className="h-3 w-3 mr-1" />
                        Alle neu erstellen
                      </Button>
                    </div>
                  </>
                ) : (
                  <p className="text-sm text-green-700 dark:text-green-400">
                    ✓ Alle nicht gefundenen Namen wurden einem bestehenden Mitarbeiter zugeordnet oder übersprungen.
                  </p>
                )}
              </AlertDescription>
            </Alert>
          )}

          {/* Summary */}
          <div className="grid grid-cols-3 gap-2 text-sm">
            <div className="bg-green-100 dark:bg-green-900/30 rounded-lg p-3 text-center">
              <div className="text-2xl font-bold text-green-700 dark:text-green-400">
                {matchedCount}
              </div>
              <div className="text-xs text-muted-foreground">Zugeordnet</div>
              {usingSavedCount > 0 && (
                <div className="text-xs text-purple-600 mt-1">
                  ({usingSavedCount} gespeichert)
                </div>
              )}
            </div>
            <div className={cn(
              "rounded-lg p-3 text-center",
              hasUnresolvedIssues 
                ? "bg-destructive/10 dark:bg-destructive/20" 
                : "bg-amber-100 dark:bg-amber-900/30"
            )}>
              <div className={cn(
                "text-2xl font-bold",
                hasUnresolvedIssues 
                  ? "text-destructive" 
                  : "text-amber-700 dark:text-amber-400"
              )}>
                {newCount}
              </div>
              <div className="text-xs text-muted-foreground">
                {hasUnresolvedIssues ? 'Nicht zugeordnet!' : 'Neu erstellen'}
              </div>
            </div>
            <div className="bg-muted rounded-lg p-3 text-center">
              <div className="text-2xl font-bold text-muted-foreground">
                {skippedCount}
              </div>
              <div className="text-xs text-muted-foreground">Übersprungen</div>
            </div>
          </div>

          {allowPark && parkedCount > 0 && (
            <Alert className="border-sky-300 bg-sky-50 dark:border-sky-800 dark:bg-sky-950/30">
              <Inbox className="h-4 w-4 text-sky-700" />
              <AlertDescription className="text-sm">
                <span className="font-medium">{parkedCount} Name(n) werden als «Offene Stunden» geparkt.</span>{' '}
                Die Stunden gehen nicht verloren, werden aber NICHT in die Ist-Werte geschrieben —
                sie lassen sich später im Import-Center unter «Offene Stunden» einem Mitarbeiter zuweisen.
              </AlertDescription>
            </Alert>
          )}

          <p className="text-xs text-muted-foreground">
            Klicke auf den Dropdown um die Zuordnung anzupassen. Manuelle Zuordnungen werden für zukünftige Imports gespeichert.
          </p>

          {/* Unmatched employees - shown first as errors */}
          {newEmployees.length > 0 && (
            <div>
              <h4 className="text-sm font-medium flex items-center gap-2 mb-2 text-destructive">
                <AlertTriangle className="h-4 w-4" />
                Nicht gefunden - Manuelle Zuordnung erforderlich ({newEmployees.length})
              </h4>
              <div className="space-y-1">
                {newEmployees.map(match => renderMatchRow(match, "bg-amber-50 dark:bg-amber-900/20", true))}
              </div>
            </div>
          )}

          {/* Saved matches */}
          {savedMatches.length > 0 && (
            <div>
              <h4 className="text-sm font-medium flex items-center gap-2 mb-2 text-purple-700 dark:text-purple-400">
                <History className="h-4 w-4" />
                Gespeicherte Zuordnung ({savedMatches.length})
              </h4>
              <div className="space-y-1">
                {savedMatches.map(match => renderMatchRow(match, "bg-purple-50 dark:bg-purple-900/20 border-transparent"))}
              </div>
            </div>
          )}

          {/* Exact matches */}
          {exactMatches.length > 0 && (
            <div>
              <h4 className="text-sm font-medium flex items-center gap-2 mb-2 text-green-700 dark:text-green-400">
                <Check className="h-4 w-4" />
                Exakt gematcht ({exactMatches.length})
              </h4>
              <div className="space-y-1">
                {exactMatches.map(match => renderMatchRow(match, "bg-green-50 dark:bg-green-900/20 border-transparent"))}
              </div>
            </div>
          )}

          {/* First name matches */}
          {firstNameMatches.length > 0 && (
            <div>
              <h4 className="text-sm font-medium flex items-center gap-2 mb-2 text-blue-700 dark:text-blue-400">
                <Link2 className="h-4 w-4" />
                Vorname gematcht ({firstNameMatches.length})
              </h4>
              <div className="space-y-1">
                {firstNameMatches.map(match => renderMatchRow(match, "bg-blue-50 dark:bg-blue-900/20 border-transparent"))}
              </div>
            </div>
          )}
        </div>

        <DialogFooter className="gap-2">
          <Button variant="outline" onClick={onCancel}>
            Abbrechen
          </Button>
          <Button onClick={handleConfirm}>
            <Save className="h-4 w-4 mr-1" />
            Import bestätigen ({matchedCount + newCount} Namen)
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
