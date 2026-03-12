import * as XLSX from 'xlsx';

export type ExcelFileType = 'planned-hours' | 'actual-hours' | 'revenue' | 'unknown';

export interface DetectionResult {
  type: ExcelFileType;
  confidence: number; // 0-100
  reason: string;
  sheetName?: string;
}

/**
 * Detects the type of data in an Excel file by analyzing its content
 */
export async function detectExcelType(file: File): Promise<DetectionResult> {
  const arrayBuffer = await file.arrayBuffer();
  const workbook = XLSX.read(arrayBuffer, { type: 'array' });
  
  let bestMatch: DetectionResult = { type: 'unknown', confidence: 0, reason: 'Keine bekannten Muster gefunden' };
  
  for (const sheetName of workbook.SheetNames) {
    const sheet = workbook.Sheets[sheetName];
    const jsonData = XLSX.utils.sheet_to_json(sheet, { header: 1 }) as unknown[][];
    
    if (jsonData.length < 2) continue;
    
    // Flatten all text content for pattern matching
    const allText = jsonData
      .slice(0, 20) // Check first 20 rows
      .flat()
      .filter(Boolean)
      .map(cell => String(cell).toLowerCase())
      .join(' ');
    
    // Check for Revenue patterns
    const revenueResult = checkRevenuePatterns(allText, jsonData, sheetName);
    if (revenueResult.confidence > bestMatch.confidence) {
      bestMatch = revenueResult;
    }
    
    // Check for Actual Hours (Ist-Stunden / Mirus) patterns
    const actualHoursResult = checkActualHoursPatterns(allText, jsonData, sheetName);
    if (actualHoursResult.confidence > bestMatch.confidence) {
      bestMatch = actualHoursResult;
    }
    
    // Check for Planned Hours (Arbeitsplan / Dienstplan) patterns
    const plannedHoursResult = checkPlannedHoursPatterns(allText, jsonData, sheetName);
    if (plannedHoursResult.confidence > bestMatch.confidence) {
      bestMatch = plannedHoursResult;
    }
  }
  
  return bestMatch;
}

function checkRevenuePatterns(allText: string, data: unknown[][], sheetName: string): DetectionResult {
  let score = 0;
  const reasons: string[] = [];
  
  // Strong indicators
  if (allText.includes('umsatz')) { score += 30; reasons.push('Umsatz'); }
  if (allText.includes('revenue')) { score += 25; reasons.push('Revenue'); }
  if (allText.includes('chf') || allText.includes('eur') || allText.includes('€')) { 
    score += 20; reasons.push('Währung'); 
  }
  if (allText.includes('netto') || allText.includes('brutto')) { score += 15; reasons.push('Netto/Brutto'); }
  if (allText.includes('speisen') || allText.includes('getränke')) { score += 25; reasons.push('Speisen/Getränke'); }
  if (allText.includes('food') || allText.includes('beverage')) { score += 20; reasons.push('Food/Beverage'); }
  if (allText.includes('tagesumsatz') || allText.includes('tagesabschluss')) { score += 30; reasons.push('Tagesumsatz'); }
  
  // Negative indicators (reduce score if hours-related)
  if (allText.includes('arbeitszeit') || allText.includes('stunden')) { score -= 20; }
  if (allText.includes('früh') && allText.includes('spät')) { score -= 30; }
  
  // Check for date columns with revenue-like numbers
  const hasDateColumns = data.some(row => 
    row.some(cell => /^\d{1,2}\.\d{1,2}\.?(\d{2,4})?$/.test(String(cell || '')))
  );
  if (hasDateColumns) { score += 10; reasons.push('Datumsspalten'); }
  
  // Check for large numbers (typical for revenue)
  const hasLargeNumbers = data.flat().some(cell => {
    const num = parseFloat(String(cell || '').replace(/[^\d.-]/g, ''));
    return !isNaN(num) && num > 500;
  });
  if (hasLargeNumbers) { score += 10; reasons.push('Umsatzzahlen'); }
  
  return {
    type: 'revenue',
    confidence: Math.min(100, Math.max(0, score)),
    reason: reasons.length > 0 ? `Erkannt: ${reasons.join(', ')}` : 'Keine Umsatz-Muster gefunden',
    sheetName
  };
}

function checkActualHoursPatterns(allText: string, data: unknown[][], sheetName: string): DetectionResult {
  let score = 0;
  const reasons: string[] = [];
  
  // Strong indicators for Mirus / Ist-Stunden
  if (allText.includes('tägliche stunden') || allText.includes('tägl. stunden')) { 
    score += 40; reasons.push('Tägliche Stunden'); 
  }
  if (allText.includes('mirus')) { score += 35; reasons.push('Mirus'); }
  if (allText.includes('ist-stunden') || allText.includes('ist stunden')) { 
    score += 35; reasons.push('Ist-Stunden'); 
  }
  if (allText.includes('actual') || allText.includes('geleistet')) { 
    score += 20; reasons.push('Actual/Geleistet'); 
  }
  if (allText.includes('arbeitszeit')) { score += 15; reasons.push('Arbeitszeit'); }
  
  // Check for employee names + date columns + hour values pattern
  const hasHourValues = data.flat().some(cell => {
    const num = parseFloat(String(cell || '').replace(',', '.'));
    return !isNaN(num) && num > 0 && num <= 24;
  });
  if (hasHourValues) { score += 10; reasons.push('Stundenwerte'); }
  
  // Negative indicators
  if (allText.includes('plan') && !allText.includes('ist')) { score -= 20; }
  if (allText.includes('früh') && allText.includes('spät')) { score -= 15; }
  if (allText.includes('umsatz') || allText.includes('revenue')) { score -= 25; }
  
  return {
    type: 'actual-hours',
    confidence: Math.min(100, Math.max(0, score)),
    reason: reasons.length > 0 ? `Erkannt: ${reasons.join(', ')}` : 'Keine Ist-Stunden-Muster gefunden',
    sheetName
  };
}

function checkPlannedHoursPatterns(allText: string, data: unknown[][], sheetName: string): DetectionResult {
  let score = 0;
  const reasons: string[] = [];
  
  // Strong indicators for Arbeitsplan / Dienstplan
  if (allText.includes('arbeitsplan') || allText.includes('dienstplan')) { 
    score += 40; reasons.push('Arbeitsplan/Dienstplan'); 
  }
  if (allText.includes('plan-stunden') || allText.includes('plan stunden')) { 
    score += 35; reasons.push('Plan-Stunden'); 
  }
  if (allText.includes('früh') && allText.includes('spät')) { 
    score += 30; reasons.push('Früh/Spät Schichten'); 
  }
  if (allText.includes('schicht')) { score += 20; reasons.push('Schicht'); }
  if (allText.includes('service') || allText.includes('küche')) { 
    score += 15; reasons.push('Service/Küche'); 
  }
  if (allText.includes('montag') || allText.includes('dienstag')) { 
    score += 15; reasons.push('Wochentage'); 
  }
  if (allText.includes('kw ') || /kw\s*\d+/i.test(allText)) { 
    score += 20; reasons.push('Kalenderwoche'); 
  }
  
  // Check for time patterns like "11:00" or "23:00"
  const hasTimePatterns = data.flat().some(cell => 
    /\d{1,2}:\d{2}/.test(String(cell || ''))
  );
  if (hasTimePatterns) { score += 15; reasons.push('Zeitangaben'); }
  
  // Check for shift codes (A, B, C, D, E, O1, F, FE, etc.)
  const shiftCodes = ['A', 'B', 'C', 'D', 'E', 'O1', 'F', 'FE', 'FW', 'KO'];
  const hasShiftCodes = data.flat().some(cell => 
    shiftCodes.includes(String(cell || '').toUpperCase().trim())
  );
  if (hasShiftCodes) { score += 20; reasons.push('Schichtcodes'); }
  
  // Negative indicators
  if (allText.includes('ist-stunden') || allText.includes('mirus')) { score -= 25; }
  if (allText.includes('umsatz') || allText.includes('revenue')) { score -= 25; }
  
  return {
    type: 'planned-hours',
    confidence: Math.min(100, Math.max(0, score)),
    reason: reasons.length > 0 ? `Erkannt: ${reasons.join(', ')}` : 'Keine Plan-Stunden-Muster gefunden',
    sheetName
  };
}

/**
 * Returns a user-friendly label for the detected type
 */
export function getTypeLabel(type: ExcelFileType): string {
  switch (type) {
    case 'planned-hours': return 'Plan-Stunden (Arbeitsplan)';
    case 'actual-hours': return 'Ist-Stunden (Mirus)';
    case 'revenue': return 'Umsatzdaten';
    default: return 'Unbekannt';
  }
}

/**
 * Returns the appropriate color for the type
 */
export function getTypeColor(type: ExcelFileType): string {
  switch (type) {
    case 'planned-hours': return 'text-primary';
    case 'actual-hours': return 'text-green-600';
    case 'revenue': return 'text-amber-600';
    default: return 'text-muted-foreground';
  }
}

/**
 * Returns the appropriate background color for the type
 */
export function getTypeBgColor(type: ExcelFileType): string {
  switch (type) {
    case 'planned-hours': return 'bg-primary/10 border-primary/30';
    case 'actual-hours': return 'bg-green-50 border-green-500/30 dark:bg-green-950/20';
    case 'revenue': return 'bg-amber-50 border-amber-500/30 dark:bg-amber-950/20';
    default: return 'bg-muted border-muted-foreground/30';
  }
}
