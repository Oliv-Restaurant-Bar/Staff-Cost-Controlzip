import { Employee } from '@/types/personnel';

// Storage key for saved name mappings
const NAME_MAPPINGS_KEY = 'employee-name-mappings';
const DEFAULT_MAPPINGS_INITIALIZED_KEY = 'default-mappings-initialized';

export interface SavedNameMapping {
  importedName: string;
  employeeId: string;
  employeeName: string;
  createdAt: string;
  isDefault?: boolean; // Marks if this is a built-in default mapping
}

// Default name mappings - these are automatically available
const DEFAULT_NAME_MAPPINGS: SavedNameMapping[] = [
  // Küche
  { importedName: "Bedzeti Mensur", employeeId: "971bd88d-daa0-440a-9185-930ea87d2e5c", employeeName: "Culi", createdAt: "2026-01-21T12:46:50.843Z", isDefault: true },
  { importedName: "de Jong Micky", employeeId: "53b667c7-64c7-4037-9d4e-38676a857593", employeeName: "Micky", createdAt: "2026-01-21T12:46:50.843Z", isDefault: true },
  { importedName: "Domi Sadete", employeeId: "17b5ebc5-facb-4700-b146-418c859b5a1e", employeeName: "Sadete", createdAt: "2026-01-21T12:46:50.843Z", isDefault: true },
  { importedName: "Hashmi Ali Zaib", employeeId: "9be837c5-38a5-4631-824c-1cbcd0cc40ca", employeeName: "Ali", createdAt: "2026-01-21T12:46:50.843Z", isDefault: true },
  { importedName: "Kolev Miroslav Nikolaev", employeeId: "9a6c2190-dbe9-4cd1-b789-1979b07e4842", employeeName: "Miro", createdAt: "2026-01-21T12:46:50.843Z", isDefault: true },
  { importedName: "Novak Karel", employeeId: "0f8a29e1-2794-4319-b354-eb6cab908ae5", employeeName: "Karel", createdAt: "2026-01-21T12:46:50.843Z", isDefault: true },
  { importedName: "Ramadani Asim", employeeId: "2d2578c8-6250-41ad-af8e-03333bf313a5", employeeName: "Asim", createdAt: "2026-01-21T12:46:50.843Z", isDefault: true },
  { importedName: "Ramadani Mejdi", employeeId: "2462dd08-92d4-4afc-8d75-bf5b6958e53d", employeeName: "Mejdi", createdAt: "2026-01-21T12:46:50.843Z", isDefault: true },
  // Service
  { importedName: "Blaku Artin", employeeId: "59e7c3d9-4c75-440d-ace0-2d0e33c194fd", employeeName: "Artin", createdAt: "2026-01-21T12:46:50.843Z", isDefault: true },
  { importedName: "Bolsinger Joana Jamina Alicia", employeeId: "1fa69f24-8e1c-468d-8614-7dc51b04a978", employeeName: "Joana", createdAt: "2026-01-21T12:46:50.843Z", isDefault: true },
  { importedName: "Collazo Marsal Carlos", employeeId: "441611d7-6ca9-4f57-961b-6230f9bb9da6", employeeName: "Carlos", createdAt: "2026-01-21T12:46:50.843Z", isDefault: true },
  { importedName: "Gimenez Nahuel Vargas", employeeId: "5bac27a1-9ab7-4392-a649-c3b27ad8b292", employeeName: "Nahuel", createdAt: "2026-01-21T12:46:50.843Z", isDefault: true },
  { importedName: "Goi Isabelle", employeeId: "bcfc4566-82e4-45b5-a109-4e11ed1c40ea", employeeName: "Isabel", createdAt: "2026-01-21T12:46:50.843Z", isDefault: true },
  { importedName: "Halvadzija Husein", employeeId: "8b51296c-561d-4552-ac2f-2da51b07aca7", employeeName: "Husein", createdAt: "2026-01-21T12:46:50.843Z", isDefault: true },
  { importedName: "Haxhiraj Arber", employeeId: "c530f7c9-560f-4091-afee-85a806467f87", employeeName: "Arber", createdAt: "2026-01-21T12:46:50.843Z", isDefault: true },
  { importedName: "Krauss Marion", employeeId: "387a87ea-e337-4f4f-a80d-67beb92b6d12", employeeName: "Marion", createdAt: "2026-01-21T12:46:50.843Z", isDefault: true },
  { importedName: "Markaj Eduard", employeeId: "1a177377-d91d-45f9-bd78-750e6648609c", employeeName: "Eduard", createdAt: "2026-01-21T12:46:50.843Z", isDefault: true },
  { importedName: "Mehdi Ben Omar Saad", employeeId: "f6776cd0-9f45-41e7-a975-f7c4b2a6b929", employeeName: "Saad", createdAt: "2026-01-21T12:46:50.843Z", isDefault: true },
  { importedName: "Szabo David", employeeId: "f0b4db73-8c91-49eb-bc40-5f1a20f5dda5", employeeName: "David", createdAt: "2026-01-21T12:46:50.843Z", isDefault: true },
  { importedName: "Gashi Mendim", employeeId: "48178c12-ef61-488e-b3bb-184ea60d578f", employeeName: "Mendim", createdAt: "2026-01-21T12:46:50.843Z", isDefault: true },
];

// Levenshtein distance calculation
export function levenshteinDistance(str1: string, str2: string): number {
  const s1 = str1.toLowerCase();
  const s2 = str2.toLowerCase();
  
  const matrix: number[][] = [];
  
  for (let i = 0; i <= s1.length; i++) {
    matrix[i] = [i];
  }
  
  for (let j = 0; j <= s2.length; j++) {
    matrix[0][j] = j;
  }
  
  for (let i = 1; i <= s1.length; i++) {
    for (let j = 1; j <= s2.length; j++) {
      if (s1[i - 1] === s2[j - 1]) {
        matrix[i][j] = matrix[i - 1][j - 1];
      } else {
        matrix[i][j] = Math.min(
          matrix[i - 1][j - 1] + 1, // substitution
          matrix[i][j - 1] + 1,     // insertion
          matrix[i - 1][j] + 1      // deletion
        );
      }
    }
  }
  
  return matrix[s1.length][s2.length];
}

// Calculate similarity score (0-1, higher is more similar)
export function calculateSimilarity(str1: string, str2: string): number {
  const maxLength = Math.max(str1.length, str2.length);
  if (maxLength === 0) return 1;
  const distance = levenshteinDistance(str1, str2);
  return 1 - distance / maxLength;
}

export interface NameSuggestion {
  employee: Employee;
  similarity: number;
  matchReason: 'exact' | 'firstName' | 'lastName' | 'similar' | 'saved';
}

// Find matching employee with similarity suggestions
export function findMatchingEmployeeWithSuggestions(
  importedName: string,
  employees: Employee[],
  savedMappings: SavedNameMapping[]
): {
  bestMatch: Employee | null;
  matchType: 'exact' | 'firstName' | 'saved' | 'new';
  suggestions: NameSuggestion[];
} {
  const normalizedImportedName = importedName.trim().toLowerCase();
  const importedFirstName = normalizedImportedName.split(/\s+/)[0];
  
  // Check saved mappings first
  const savedMapping = savedMappings.find(
    m => m.importedName.toLowerCase() === normalizedImportedName
  );
  
  if (savedMapping) {
    const savedEmployee = employees.find(e => e.id === savedMapping.employeeId);
    if (savedEmployee) {
      return {
        bestMatch: savedEmployee,
        matchType: 'saved',
        suggestions: [{
          employee: savedEmployee,
          similarity: 1,
          matchReason: 'saved'
        }]
      };
    }
  }
  
  // Check for exact match
  const exactMatch = employees.find(
    e => e.name.toLowerCase() === normalizedImportedName
  );
  
  if (exactMatch) {
    return {
      bestMatch: exactMatch,
      matchType: 'exact',
      suggestions: [{
        employee: exactMatch,
        similarity: 1,
        matchReason: 'exact'
      }]
    };
  }
  
  // Check for first name match
  const firstNameMatch = employees.find(e => {
    const empFirstName = e.name.split(/\s+/)[0].toLowerCase();
    return empFirstName === importedFirstName;
  });
  
  if (firstNameMatch) {
    const allSuggestions = calculateAllSuggestions(importedName, employees);
    return {
      bestMatch: firstNameMatch,
      matchType: 'firstName',
      suggestions: allSuggestions
    };
  }
  
  // Calculate similarity for all employees
  const allSuggestions = calculateAllSuggestions(importedName, employees);
  
  // If best suggestion has high similarity, suggest it
  if (allSuggestions.length > 0 && allSuggestions[0].similarity >= 0.5) {
    return {
      bestMatch: null,
      matchType: 'new',
      suggestions: allSuggestions
    };
  }
  
  return {
    bestMatch: null,
    matchType: 'new',
    suggestions: allSuggestions
  };
}

function calculateAllSuggestions(importedName: string, employees: Employee[]): NameSuggestion[] {
  const normalizedImportedName = importedName.trim().toLowerCase();
  const importedParts = normalizedImportedName.split(/\s+/);
  const importedFirstName = importedParts[0];
  const importedLastName = importedParts.slice(1).join(' ');
  
  // Also try reversed order (common in formal documents: "Lastname Firstname")
  const reversedName = [...importedParts].reverse().join(' ');
  const reversedFirstName = importedParts[importedParts.length - 1];
  
  const suggestions: NameSuggestion[] = employees.map(emp => {
    const empName = emp.name.toLowerCase();
    const empParts = empName.split(/\s+/);
    const empFirstName = empParts[0];
    const empLastName = empParts.slice(1).join(' ');
    
    // Calculate different similarity scores
    const fullNameSimilarity = calculateSimilarity(normalizedImportedName, empName);
    const firstNameSimilarity = calculateSimilarity(importedFirstName, empFirstName);
    const lastNameSimilarity = importedLastName && empLastName 
      ? calculateSimilarity(importedLastName, empLastName) 
      : 0;
    
    // Try reversed matching (imported name might be "Lastname Firstname")
    const reversedFullSimilarity = calculateSimilarity(reversedName, empName);
    const reversedFirstNameSimilarity = calculateSimilarity(reversedFirstName, empFirstName);
    
    // Check if any part of the imported name matches the employee's first name exactly
    const anyPartMatchesFirstName = importedParts.some(
      part => part.toLowerCase() === empFirstName.toLowerCase()
    );
    
    // Use the best matching approach
    let similarity = fullNameSimilarity;
    let matchReason: NameSuggestion['matchReason'] = 'similar';
    
    // If reversed name matches better, use that
    if (reversedFullSimilarity > similarity) {
      similarity = reversedFullSimilarity;
    }
    
    // Check first name in different positions
    if (firstNameSimilarity > similarity) {
      similarity = firstNameSimilarity * 0.85;
      matchReason = 'firstName';
    }
    
    if (reversedFirstNameSimilarity > similarity) {
      similarity = reversedFirstNameSimilarity * 0.85;
      matchReason = 'firstName';
    }
    
    // Strong boost if any part exactly matches first name
    if (anyPartMatchesFirstName) {
      similarity = Math.max(similarity, 0.9);
      matchReason = 'firstName';
    }
    
    if (lastNameSimilarity > similarity) {
      similarity = lastNameSimilarity * 0.8;
      matchReason = 'lastName';
    }
    
    // Boost if both first and last name have good similarity
    if (firstNameSimilarity > 0.7 && lastNameSimilarity > 0.7) {
      similarity = Math.max(similarity, (firstNameSimilarity + lastNameSimilarity) / 2);
    }
    
    return {
      employee: emp,
      similarity,
      matchReason
    };
  });
  
  // Sort by similarity descending and return top 5
  return suggestions
    .sort((a, b) => b.similarity - a.similarity)
    .slice(0, 5)
    .filter(s => s.similarity > 0.3);
}

// Smart detection result
export interface SmartDetectionResult {
  importedName: string;
  suggestedEmployee: Employee | null;
  confidence: number;
  matchReason: 'exact' | 'saved' | 'firstName' | 'lastName' | 'pattern' | 'similar' | 'none';
  allSuggestions: NameSuggestion[];
  isNewEmployee: boolean;
  patternDetected?: string;
}

// Detect patterns in imported names and suggest matches
export function detectNewEmployeesWithSuggestions(
  importedNames: string[],
  employees: Employee[],
  savedMappings?: SavedNameMapping[]
): SmartDetectionResult[] {
  const mappings = savedMappings || loadSavedNameMappings();
  const results: SmartDetectionResult[] = [];
  
  // Analyze name patterns in the import
  const detectNamePattern = (names: string[]): 'lastFirst' | 'firstLast' | 'unknown' => {
    let lastFirstScore = 0;
    let firstLastScore = 0;
    
    names.forEach(name => {
      const parts = name.trim().toLowerCase().split(/\s+/);
      if (parts.length < 2) return;
      
      const firstPart = parts[0];
      const lastPart = parts[parts.length - 1];
      
      // Check if any employee's first name matches the last part (suggesting "Lastname Firstname" format)
      employees.forEach(emp => {
        const empFirstName = emp.name.split(/\s+/)[0].toLowerCase();
        if (lastPart === empFirstName) lastFirstScore++;
        if (firstPart === empFirstName) firstLastScore++;
      });
    });
    
    if (lastFirstScore > firstLastScore && lastFirstScore > names.length * 0.3) {
      return 'lastFirst';
    }
    if (firstLastScore > lastFirstScore && firstLastScore > names.length * 0.3) {
      return 'firstLast';
    }
    return 'unknown';
  };
  
  const pattern = detectNamePattern(importedNames);
  
  importedNames.forEach(importedName => {
    const normalizedName = importedName.trim().toLowerCase();
    
    // Check saved mapping first
    const savedMapping = mappings.find(
      m => m.importedName.toLowerCase() === normalizedName
    );
    
    if (savedMapping) {
      const savedEmployee = employees.find(e => e.id === savedMapping.employeeId);
      if (savedEmployee) {
        results.push({
          importedName,
          suggestedEmployee: savedEmployee,
          confidence: 1,
          matchReason: 'saved',
          allSuggestions: [{ employee: savedEmployee, similarity: 1, matchReason: 'saved' }],
          isNewEmployee: false
        });
        return;
      }
    }
    
    // Check exact match
    const exactMatch = employees.find(
      e => e.name.toLowerCase() === normalizedName
    );
    
    if (exactMatch) {
      results.push({
        importedName,
        suggestedEmployee: exactMatch,
        confidence: 1,
        matchReason: 'exact',
        allSuggestions: [{ employee: exactMatch, similarity: 1, matchReason: 'exact' }],
        isNewEmployee: false
      });
      return;
    }
    
    // Get all suggestions
    const allSuggestions = calculateAllSuggestions(importedName, employees);
    
    // Apply pattern-based matching
    const parts = normalizedName.split(/\s+/);
    let patternMatch: Employee | null = null;
    let patternConfidence = 0;
    
    if (pattern === 'lastFirst' && parts.length >= 2) {
      // Try matching the last part (likely first name) to employee first names
      const likelyFirstName = parts[parts.length - 1];
      const match = employees.find(e => {
        const empFirstName = e.name.split(/\s+/)[0].toLowerCase();
        return empFirstName === likelyFirstName;
      });
      if (match) {
        patternMatch = match;
        patternConfidence = 0.95;
      }
    }
    
    // Check if any part of the imported name exactly matches an employee's first name
    if (!patternMatch) {
      for (const part of parts) {
        const match = employees.find(e => {
          const empFirstName = e.name.split(/\s+/)[0].toLowerCase();
          return empFirstName === part;
        });
        if (match) {
          patternMatch = match;
          patternConfidence = 0.9;
          break;
        }
      }
    }
    
    if (patternMatch && patternConfidence > 0) {
      results.push({
        importedName,
        suggestedEmployee: patternMatch,
        confidence: patternConfidence,
        matchReason: 'pattern',
        allSuggestions,
        isNewEmployee: false,
        patternDetected: pattern === 'lastFirst' ? 'Nachname Vorname' : 'Vorname Nachname'
      });
      return;
    }
    
    // Use best suggestion if confident enough
    if (allSuggestions.length > 0 && allSuggestions[0].similarity >= 0.7) {
      results.push({
        importedName,
        suggestedEmployee: allSuggestions[0].employee,
        confidence: allSuggestions[0].similarity,
        matchReason: allSuggestions[0].matchReason,
        allSuggestions,
        isNewEmployee: false
      });
      return;
    }
    
    // No good match found
    results.push({
      importedName,
      suggestedEmployee: allSuggestions.length > 0 ? allSuggestions[0].employee : null,
      confidence: allSuggestions.length > 0 ? allSuggestions[0].similarity : 0,
      matchReason: allSuggestions.length > 0 ? 'similar' : 'none',
      allSuggestions,
      isNewEmployee: true
    });
  });
  
  return results;
}

// Auto-apply high-confidence suggestions
export function getAutoApplicableSuggestions(
  detectionResults: SmartDetectionResult[],
  minConfidence: number = 0.85
): { autoApply: SmartDetectionResult[]; needsReview: SmartDetectionResult[] } {
  const autoApply = detectionResults.filter(
    r => r.confidence >= minConfidence && r.suggestedEmployee && !r.isNewEmployee
  );
  const needsReview = detectionResults.filter(
    r => r.confidence < minConfidence || r.isNewEmployee
  );
  
  return { autoApply, needsReview };
}

// Version key to force re-initialization when default mappings change
const DEFAULT_MAPPINGS_VERSION = 'v2-uuid-ids';

// Initialize default mappings if not already done
function initializeDefaultMappings(): void {
  const initialized = localStorage.getItem(DEFAULT_MAPPINGS_INITIALIZED_KEY);
  
  // Force re-initialization if version changed (e.g., IDs updated to UUIDs)
  if (initialized === DEFAULT_MAPPINGS_VERSION) return;
  
  try {
    const stored = localStorage.getItem(NAME_MAPPINGS_KEY);
    const existingMappings: SavedNameMapping[] = stored ? JSON.parse(stored) : [];
    
    // Remove old default mappings and add new ones
    const userMappings = existingMappings.filter(m => !m.isDefault);
    
    // Add all default mappings (with updated UUIDs)
    const updatedMappings = [...userMappings, ...DEFAULT_NAME_MAPPINGS];
    
    localStorage.setItem(NAME_MAPPINGS_KEY, JSON.stringify(updatedMappings));
    localStorage.setItem(DEFAULT_MAPPINGS_INITIALIZED_KEY, DEFAULT_MAPPINGS_VERSION);
  } catch (e) {
    console.error('Error initializing default mappings:', e);
  }
}

// Load saved name mappings from localStorage (includes defaults)
export function loadSavedNameMappings(): SavedNameMapping[] {
  // Ensure defaults are initialized
  initializeDefaultMappings();
  
  try {
    const stored = localStorage.getItem(NAME_MAPPINGS_KEY);
    if (stored) {
      const mappings: SavedNameMapping[] = JSON.parse(stored);
      // Mark default mappings
      return mappings.map(m => {
        const isDefault = DEFAULT_NAME_MAPPINGS.some(
          d => d.importedName.toLowerCase() === m.importedName.toLowerCase()
        );
        return { ...m, isDefault };
      });
    }
  } catch (e) {
    console.error('Error loading name mappings:', e);
  }
  return DEFAULT_NAME_MAPPINGS;
}

// Reset to default mappings
export function resetToDefaultMappings(): void {
  localStorage.setItem(NAME_MAPPINGS_KEY, JSON.stringify(DEFAULT_NAME_MAPPINGS));
  localStorage.setItem(DEFAULT_MAPPINGS_INITIALIZED_KEY, 'true');
}

// Save a name mapping
export function saveNameMapping(importedName: string, employee: Employee): void {
  const mappings = loadSavedNameMappings();
  
  // Remove existing mapping for this name if any
  const filtered = mappings.filter(
    m => m.importedName.toLowerCase() !== importedName.toLowerCase()
  );
  
  // Add new mapping
  filtered.push({
    importedName: importedName.trim(),
    employeeId: employee.id,
    employeeName: employee.name,
    createdAt: new Date().toISOString()
  });
  
  localStorage.setItem(NAME_MAPPINGS_KEY, JSON.stringify(filtered));
}

// Save multiple name mappings at once
export function saveNameMappings(mappings: { importedName: string; employee: Employee }[]): void {
  const existingMappings = loadSavedNameMappings();
  
  mappings.forEach(({ importedName, employee }) => {
    // Remove existing mapping for this name if any
    const idx = existingMappings.findIndex(
      m => m.importedName.toLowerCase() === importedName.toLowerCase()
    );
    if (idx >= 0) {
      existingMappings.splice(idx, 1);
    }
    
    // Add new mapping
    existingMappings.push({
      importedName: importedName.trim(),
      employeeId: employee.id,
      employeeName: employee.name,
      createdAt: new Date().toISOString()
    });
  });
  
  localStorage.setItem(NAME_MAPPINGS_KEY, JSON.stringify(existingMappings));
}

// Delete a saved name mapping
export function deleteNameMapping(importedName: string): void {
  const mappings = loadSavedNameMappings();
  const filtered = mappings.filter(
    m => m.importedName.toLowerCase() !== importedName.toLowerCase()
  );
  localStorage.setItem(NAME_MAPPINGS_KEY, JSON.stringify(filtered));
}

// Update a saved name mapping (change the target employee name)
export function updateNameMapping(importedName: string, newEmployeeName: string): void {
  const mappings = loadSavedNameMappings();
  const idx = mappings.findIndex(
    m => m.importedName.toLowerCase() === importedName.toLowerCase()
  );
  
  if (idx >= 0) {
    mappings[idx] = {
      ...mappings[idx],
      employeeName: newEmployeeName,
      createdAt: new Date().toISOString() // Update timestamp
    };
    localStorage.setItem(NAME_MAPPINGS_KEY, JSON.stringify(mappings));
  }
}

// Clear all saved name mappings
export function clearAllNameMappings(): void {
  localStorage.removeItem(NAME_MAPPINGS_KEY);
}

// Export name mappings as JSON
export function exportNameMappings(): string {
  const mappings = loadSavedNameMappings();
  return JSON.stringify(mappings, null, 2);
}

export interface ImportConflict {
  importedName: string;
  existing: SavedNameMapping;
  incoming: SavedNameMapping;
  resolution: 'keep' | 'replace' | 'skip';
}

export interface ParsedImportResult {
  success: boolean;
  newMappings: SavedNameMapping[];
  conflicts: ImportConflict[];
  errors: string[];
}

// Parse imported JSON and detect conflicts
export function parseImportedMappings(jsonString: string): ParsedImportResult {
  const errors: string[] = [];
  
  try {
    const parsed = JSON.parse(jsonString);
    
    if (!Array.isArray(parsed)) {
      return { success: false, newMappings: [], conflicts: [], errors: ['Ungültiges Format: Erwartet ein Array'] };
    }
    
    const validMappings: SavedNameMapping[] = [];
    
    parsed.forEach((item, index) => {
      if (
        typeof item.importedName === 'string' &&
        typeof item.employeeId === 'string' &&
        typeof item.employeeName === 'string'
      ) {
        validMappings.push({
          importedName: item.importedName.trim(),
          employeeId: item.employeeId,
          employeeName: item.employeeName,
          createdAt: item.createdAt || new Date().toISOString()
        });
      } else {
        errors.push(`Eintrag ${index + 1}: Ungültige Daten`);
      }
    });
    
    if (validMappings.length === 0) {
      return { success: false, newMappings: [], conflicts: [], errors: ['Keine gültigen Zuordnungen gefunden'] };
    }
    
    const existingMappings = loadSavedNameMappings();
    const newMappings: SavedNameMapping[] = [];
    const conflicts: ImportConflict[] = [];
    
    validMappings.forEach(incoming => {
      const existing = existingMappings.find(
        m => m.importedName.toLowerCase() === incoming.importedName.toLowerCase()
      );
      
      if (existing) {
        // Check if it's actually a conflict (different target)
        if (existing.employeeName.toLowerCase() !== incoming.employeeName.toLowerCase()) {
          conflicts.push({
            importedName: incoming.importedName,
            existing,
            incoming,
            resolution: 'keep' // Default to keeping existing
          });
        }
        // If same target, silently skip (no conflict)
      } else {
        newMappings.push(incoming);
      }
    });
    
    return { success: true, newMappings, conflicts, errors };
  } catch (e) {
    return { success: false, newMappings: [], conflicts: [], errors: ['JSON konnte nicht gelesen werden'] };
  }
}

// Apply import with resolved conflicts
export function applyImportWithConflicts(
  newMappings: SavedNameMapping[],
  conflicts: ImportConflict[]
): number {
  const existingMappings = loadSavedNameMappings();
  let imported = 0;
  
  // Add all new mappings
  newMappings.forEach(mapping => {
    existingMappings.push(mapping);
    imported++;
  });
  
  // Apply conflict resolutions
  conflicts.forEach(conflict => {
    if (conflict.resolution === 'replace') {
      const idx = existingMappings.findIndex(
        m => m.importedName.toLowerCase() === conflict.importedName.toLowerCase()
      );
      if (idx >= 0) {
        existingMappings[idx] = conflict.incoming;
        imported++;
      }
    }
    // 'keep' and 'skip' don't modify anything
  });
  
  localStorage.setItem(NAME_MAPPINGS_KEY, JSON.stringify(existingMappings));
  return imported;
}

// Import name mappings from JSON string (legacy simple import)
export function importNameMappings(jsonString: string, mode: 'replace' | 'merge' = 'merge'): { 
  success: boolean; 
  imported: number; 
  errors: string[] 
} {
  const parsed = parseImportedMappings(jsonString);
  
  if (!parsed.success) {
    return { success: false, imported: 0, errors: parsed.errors };
  }
  
  if (mode === 'replace') {
    localStorage.setItem(NAME_MAPPINGS_KEY, JSON.stringify([...parsed.newMappings, ...parsed.conflicts.map(c => c.incoming)]));
    return { success: true, imported: parsed.newMappings.length + parsed.conflicts.length, errors: parsed.errors };
  }
  
  // For merge, replace all conflicts by default
  const conflictsToReplace = parsed.conflicts.map(c => ({ ...c, resolution: 'replace' as const }));
  const imported = applyImportWithConflicts(parsed.newMappings, conflictsToReplace);
  
  return { success: true, imported, errors: parsed.errors };
}
