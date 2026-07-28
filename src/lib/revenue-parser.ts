import * as XLSX from 'xlsx';

export interface RevenueEntry {
  date: string; // yyyy-MM-dd format
  revenue: number;
}

export interface HourlyRevenueEntry {
  hour: number; // 0-23
  revenue: number;
  food?: number; // Revenue from food (Speisen) - relevant for Küche
  beverage?: number; // Revenue from beverages (Getränke) - relevant for Service
}

export interface DailyRevenueWithHourly {
  date: string;
  totalRevenue: number;
  hourlyBreakdown: HourlyRevenueEntry[];
}

export interface RevenueParseResult {
  entries: RevenueEntry[];
  currency: 'CHF' | 'EUR';
  dateRange: string[];
}

export interface HourlyRevenueParseResult {
  date: string;
  totalRevenue: number;
  totalFood: number;
  totalBeverage: number;
  hourlyBreakdown: HourlyRevenueEntry[];
  currency: 'CHF' | 'EUR';
  peakHour: number;
  lastSignificantHour: number; // Last hour with significant revenue (>5% of total)
}

/**
 * Parse revenue value from string like "CHF 5016,20" or "22331,80"
 */
const parseRevenueValue = (value: string | number): { amount: number; currency: 'CHF' | 'EUR' } => {
  if (typeof value === 'number') {
    return { amount: value, currency: 'CHF' };
  }
  
  const str = String(value).trim();
  if (!str) return { amount: 0, currency: 'CHF' };
  
  const currency: 'CHF' | 'EUR' = str.includes('EUR') || str.includes('€') ? 'EUR' : 'CHF';
  
  // Remove currency symbols and whitespace
  const cleanedStr = str
    .replace(/CHF/gi, '')
    .replace(/EUR/gi, '')
    .replace(/€/g, '')
    .replace(/\s/g, '')
    .trim();
  
  // Handle European number format (1.234,56 -> 1234.56)
  const normalizedStr = cleanedStr.replace(/\./g, '').replace(',', '.');
  
  const amount = parseFloat(normalizedStr);
  return { amount: isNaN(amount) ? 0 : amount, currency };
};

/**
 * Parse date from column header like "12.01." or "12.01.2026"
 */
const parseDateFromHeader = (header: string, year?: number): string | null => {
  const str = String(header).trim();
  
  // Match patterns like "12.01." or "12.01.2026"
  const match = str.match(/^(\d{1,2})\.(\d{1,2})\.?(\d{4})?$/);
  if (!match) return null;
  
  const day = parseInt(match[1], 10);
  const month = parseInt(match[2], 10);
  const parsedYear = match[3] ? parseInt(match[3], 10) : (year || new Date().getFullYear());
  
  if (day < 1 || day > 31 || month < 1 || month > 12) return null;
  
  return `${parsedYear}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
};

/**
 * Parse hour from column header like "04:00", "11:00", etc.
 */
const parseHourFromHeader = (header: string | number): number | null => {
  const str = String(header).trim();
  
  // Match patterns like "04:00", "11:00", or just "04", "11"
  const match = str.match(/^(\d{1,2})(?::00)?$/);
  if (!match) return null;
  
  const hour = parseInt(match[1], 10);
  if (hour < 0 || hour > 23) return null;
  
  return hour;
};

/**
 * Parse daily revenue with Food/Beverage breakdown from Excel file
 * Format: Rows with "Food (Speisen)", "Beverage (Getränke)", columns with dates like "12.01."
 * This format provides daily totals per category, not hourly breakdown
 */
export interface DailyFoodBeverageResult {
  date: string;
  totalRevenue: number;
  food: number;
  beverage: number;
  currency: 'CHF' | 'EUR';
}

export const parseFoodBeverageExcel = async (file: File): Promise<DailyFoodBeverageResult[] | null> => {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    
    reader.onload = (e) => {
      try {
        const data = e.target?.result;
        const workbook = XLSX.read(data, { type: 'array' });
        const firstSheet = workbook.Sheets[workbook.SheetNames[0]];
        const jsonData = XLSX.utils.sheet_to_json(firstSheet, { header: 1 }) as (string | number)[][];
        
        let detectedCurrency: 'CHF' | 'EUR' = 'CHF';
        const results: DailyFoodBeverageResult[] = [];
        const currentYear = new Date().getFullYear();
        
        // Find header row with date columns (12.01., 13.01., etc.)
        let headerRowIndex = -1;
        const dateColumns: { index: number; date: string }[] = [];
        
        for (let i = 0; i < jsonData.length && i < 5; i++) {
          const row = jsonData[i];
          if (!row) continue;
          
          const potentialDates: { index: number; date: string }[] = [];
          
          for (let j = 0; j < row.length; j++) {
            const cell = row[j];
            if (cell !== undefined && cell !== null) {
              const date = parseDateFromHeader(String(cell), currentYear);
              if (date) {
                potentialDates.push({ index: j, date });
              }
            }
          }
          
          // Need at least 2 date columns to be valid
          if (potentialDates.length >= 2) {
            headerRowIndex = i;
            potentialDates.forEach(d => dateColumns.push(d));
            break;
          }
        }
        
        if (headerRowIndex === -1 || dateColumns.length === 0) {
          console.log('Could not find date headers in the file');
          resolve(null);
          return;
        }
        
        // Initialize results for each date
        dateColumns.forEach(({ date }) => {
          results.push({
            date,
            totalRevenue: 0,
            food: 0,
            beverage: 0,
            currency: 'CHF',
          });
        });
        
        // Find rows for Gesamt, Food, Beverage
        for (let i = headerRowIndex + 1; i < jsonData.length; i++) {
          const row = jsonData[i];
          if (!row) continue;
          
          const firstCell = String(row[0] || '').toLowerCase();
          
          // Check for different row types
          const isGesamt = firstCell.includes('gesamt') || firstCell.includes('total');
          const isFood = firstCell.includes('food') || firstCell.includes('speisen');
          const isBeverage = firstCell.includes('beverage') || firstCell.includes('getränke');
          
          if (isGesamt || isFood || isBeverage) {
            for (let j = 0; j < dateColumns.length; j++) {
              const { index, date } = dateColumns[j];
              const cell = row[index];
              
              if (cell !== undefined && cell !== null) {
                const { amount, currency } = parseRevenueValue(cell);
                detectedCurrency = currency;
                
                const resultEntry = results.find(r => r.date === date);
                if (resultEntry) {
                  resultEntry.currency = currency;
                  
                  if (isGesamt) {
                    resultEntry.totalRevenue = amount;
                  } else if (isFood) {
                    resultEntry.food = amount;
                  } else if (isBeverage) {
                    resultEntry.beverage = amount;
                  }
                }
              }
            }
          }
        }
        
        // Calculate total if not explicitly found (food + beverage)
        results.forEach(r => {
          if (r.totalRevenue === 0 && (r.food > 0 || r.beverage > 0)) {
            r.totalRevenue = r.food + r.beverage;
          }
        });
        
        // Filter out entries with no data
        const validResults = results.filter(r => r.totalRevenue > 0 || r.food > 0 || r.beverage > 0);
        
        resolve(validResults.length > 0 ? validResults : null);
      } catch (error) {
        console.error('Error parsing Food/Beverage Excel:', error);
        reject(error);
      }
    };
    
    reader.onerror = () => reject(new Error('Failed to read file'));
    reader.readAsArrayBuffer(file);
  });
};

/**
 * Parse daily revenue with hourly breakdown from Excel file
 * Format: Rows with times (04:00, 05:00...), columns with hourly revenue values
 */
export const parseHourlyRevenueExcel = async (file: File): Promise<HourlyRevenueParseResult | null> => {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    
    reader.onload = (e) => {
      try {
        const data = e.target?.result;
        const workbook = XLSX.read(data, { type: 'array' });
        const firstSheet = workbook.Sheets[workbook.SheetNames[0]];
        const jsonData = XLSX.utils.sheet_to_json(firstSheet, { header: 1 }) as (string | number)[][];
        
        let detectedCurrency: 'CHF' | 'EUR' = 'CHF';
        const hourlyBreakdown: HourlyRevenueEntry[] = [];
        let totalRevenue = 0;
        let totalFood = 0;
        let totalBeverage = 0;
        let date = new Date().toISOString().split('T')[0]; // Default to today
        
        // Find header row with hour columns (04:00, 05:00, etc.)
        let headerRowIndex = -1;
        const hourColumns: { index: number; hour: number }[] = [];
        
        for (let i = 0; i < jsonData.length && i < 5; i++) {
          const row = jsonData[i];
          if (!row) continue;
          
          const potentialHours: { index: number; hour: number }[] = [];
          
          for (let j = 0; j < row.length; j++) {
            const cell = row[j];
            if (cell !== undefined && cell !== null) {
              const hour = parseHourFromHeader(cell);
              if (hour !== null) {
                potentialHours.push({ index: j, hour });
              }
            }
          }
          
          // Need at least 5 hour columns to be valid
          if (potentialHours.length >= 5) {
            headerRowIndex = i;
            potentialHours.forEach(h => hourColumns.push(h));
            break;
          }
        }
        
        if (headerRowIndex === -1 || hourColumns.length === 0) {
          console.log('Could not find hour headers in the file');
          resolve(null);
          return;
        }
        
        // Sort hour columns by hour
        hourColumns.sort((a, b) => a.hour - b.hour);
        
        // Try to extract date from "Zeitraum" column or filename
        for (let i = 0; i <= headerRowIndex; i++) {
          const row = jsonData[i];
          if (!row) continue;
          
          for (let j = 0; j < row.length; j++) {
            const cell = row[j];
            if (cell) {
              const cellStr = String(cell);
              // Look for date patterns
              const dateMatch = cellStr.match(/(\d{1,2})\.(\d{1,2})\.(\d{4})/);
              if (dateMatch) {
                const day = parseInt(dateMatch[1], 10);
                const month = parseInt(dateMatch[2], 10);
                const year = parseInt(dateMatch[3], 10);
                if (day >= 1 && day <= 31 && month >= 1 && month <= 12) {
                  date = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
                }
              }
            }
          }
        }
        
        // Initialize hourly breakdown with zeros
        hourColumns.forEach(({ hour }) => {
          hourlyBreakdown.push({ hour, revenue: 0, food: 0, beverage: 0 });
        });
        
        // Find rows for Gesamt, Food, Beverage
        for (let i = headerRowIndex + 1; i < jsonData.length; i++) {
          const row = jsonData[i];
          if (!row) continue;
          
          const firstCell = String(row[0] || '').toLowerCase();
          
          const isGesamt = firstCell.includes('gesamt') || firstCell.includes('total');
          const isFood = firstCell.includes('food') || firstCell.includes('speisen');
          const isBeverage = firstCell.includes('beverage') || firstCell.includes('getränke');
          
          if (isGesamt || isFood || isBeverage) {
            // Extract total from "Zeitraum" column if present
            for (let j = 0; j < Math.min(row.length, 3); j++) {
              const cell = row[j];
              if (cell) {
                const { amount, currency } = parseRevenueValue(cell);
                if (amount > 100) {
                  detectedCurrency = currency;
                  if (isGesamt) totalRevenue = amount;
                  else if (isFood) totalFood = amount;
                  else if (isBeverage) totalBeverage = amount;
                }
              }
            }
            
            // Extract hourly values
            for (let k = 0; k < hourColumns.length; k++) {
              const { index, hour } = hourColumns[k];
              const cell = row[index];
              
              if (cell !== undefined && cell !== null) {
                const { amount, currency } = parseRevenueValue(cell);
                detectedCurrency = currency;
                
                const hourEntry = hourlyBreakdown.find(h => h.hour === hour);
                if (hourEntry) {
                  if (isGesamt) {
                    hourEntry.revenue = amount;
                  } else if (isFood) {
                    hourEntry.food = amount;
                  } else if (isBeverage) {
                    hourEntry.beverage = amount;
                  }
                }
              }
            }
          }
        }
        
        // Calculate totals from hourly breakdown if not found
        if (totalRevenue === 0) {
          totalRevenue = hourlyBreakdown.reduce((sum, h) => sum + h.revenue, 0);
        }
        if (totalFood === 0) {
          totalFood = hourlyBreakdown.reduce((sum, h) => sum + (h.food || 0), 0);
        }
        if (totalBeverage === 0) {
          totalBeverage = hourlyBreakdown.reduce((sum, h) => sum + (h.beverage || 0), 0);
        }
        
        // If only total revenue found, try to split based on typical ratio (70% food, 30% beverage)
        if (totalRevenue > 0 && totalFood === 0 && totalBeverage === 0) {
          hourlyBreakdown.forEach(h => {
            if (h.revenue > 0) {
              h.food = h.revenue * 0.7;
              h.beverage = h.revenue * 0.3;
            }
          });
          totalFood = totalRevenue * 0.7;
          totalBeverage = totalRevenue * 0.3;
        }
        
        // Find peak hour and last significant hour
        let peakHour = 0;
        let peakRevenue = 0;
        let lastSignificantHour = 0;
        const significantThreshold = totalRevenue * 0.03; // 3% of total
        
        hourlyBreakdown.forEach(({ hour, revenue }) => {
          if (revenue > peakRevenue) {
            peakRevenue = revenue;
            peakHour = hour;
          }
          if (revenue >= significantThreshold) {
            lastSignificantHour = Math.max(lastSignificantHour, hour);
          }
        });
        
        resolve({
          date,
          totalRevenue,
          totalFood,
          totalBeverage,
          hourlyBreakdown,
          currency: detectedCurrency,
          peakHour,
          lastSignificantHour,
        });
      } catch (error) {
        console.error('Error parsing hourly revenue Excel:', error);
        reject(error);
      }
    };
    
    reader.onerror = () => reject(new Error('Failed to read file'));
    reader.readAsArrayBuffer(file);
  });
};

/**
 * Parse revenue data from Excel file
 */
export const parseRevenueExcel = async (file: File): Promise<RevenueParseResult> => {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    
    reader.onload = (e) => {
      try {
        const data = e.target?.result;
        const workbook = XLSX.read(data, { type: 'array' });
        const firstSheet = workbook.Sheets[workbook.SheetNames[0]];
        const jsonData = XLSX.utils.sheet_to_json(firstSheet, { header: 1 }) as (string | number)[][];
        
        const entries: RevenueEntry[] = [];
        let detectedCurrency: 'CHF' | 'EUR' = 'CHF';
        const dateRange: string[] = [];
        
        // Current year for dates without year
        const currentYear = new Date().getFullYear();
        
        // Find header row (the one with date columns)
        let headerRowIndex = -1;
        let dateColumns: { index: number; date: string }[] = [];
        
        for (let i = 0; i < jsonData.length && i < 10; i++) {
          const row = jsonData[i];
          if (!row) continue;
          
          const potentialDates: { index: number; date: string }[] = [];
          
          for (let j = 0; j < row.length; j++) {
            const cell = row[j];
            if (cell) {
              const date = parseDateFromHeader(String(cell), currentYear);
              if (date) {
                potentialDates.push({ index: j, date });
              }
            }
          }
          
          if (potentialDates.length >= 2) {
            headerRowIndex = i;
            dateColumns = potentialDates;
            break;
          }
        }
        
        if (headerRowIndex === -1 || dateColumns.length === 0) {
          // Try alternative format: dates might be in first column
          resolve({ entries: [], currency: 'CHF', dateRange: [] });
          return;
        }
        
        // Find the "Gesamt" row (total revenue)
        for (let i = headerRowIndex + 1; i < jsonData.length; i++) {
          const row = jsonData[i];
          if (!row) continue;
          
          const firstCell = String(row[0] || '').toLowerCase();
          if (firstCell.includes('gesamt') || firstCell.includes('total')) {
            // This is the totals row - extract revenue for each date column
            for (const { index, date } of dateColumns) {
              const cell = row[index];
              if (cell) {
                const { amount, currency } = parseRevenueValue(cell);
                if (amount > 0) {
                  entries.push({ date, revenue: amount });
                  dateRange.push(date);
                  detectedCurrency = currency;
                }
              }
            }
            break;
          }
        }
        
        // Sort entries by date
        entries.sort((a, b) => a.date.localeCompare(b.date));
        dateRange.sort();
        
        resolve({
          entries,
          currency: detectedCurrency,
          dateRange,
        });
      } catch (error) {
        console.error('Error parsing revenue Excel:', error);
        reject(error);
      }
    };
    
    reader.onerror = () => reject(new Error('Failed to read file'));
    reader.readAsArrayBuffer(file);
  });
};

/**
 * Parse revenue data from text (e.g., copied from PDF)
 */
export const parseRevenueText = (text: string): RevenueParseResult => {
  const entries: RevenueEntry[] = [];
  let detectedCurrency: 'CHF' | 'EUR' = 'CHF';
  const dateRange: string[] = [];
  const currentYear = new Date().getFullYear();
  
  const lines = text.split('\n').filter(line => line.trim());
  
  // Look for patterns like "12.01. CHF 5016,20" or date-value pairs
  for (const line of lines) {
    // Try to find date and value in the same line
    const dateMatch = line.match(/(\d{1,2})\.(\d{1,2})\.?\s*/);
    const valueMatch = line.match(/(CHF|EUR|€)?\s*([\d.,]+)/i);
    
    if (dateMatch && valueMatch) {
      const day = parseInt(dateMatch[1], 10);
      const month = parseInt(dateMatch[2], 10);
      
      if (day >= 1 && day <= 31 && month >= 1 && month <= 12) {
        const date = `${currentYear}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
        const { amount, currency } = parseRevenueValue(valueMatch[0]);
        
        if (amount > 0) {
          entries.push({ date, revenue: amount });
          dateRange.push(date);
          detectedCurrency = currency;
        }
      }
    }
  }
  
  // Alternative: Parse table format where dates are in header
  if (entries.length === 0) {
    // Look for a line with multiple dates
    const allDates: { date: string; position: number }[] = [];
    
    for (const line of lines) {
      const parts = line.split(/\s+/);
      for (let i = 0; i < parts.length; i++) {
        const date = parseDateFromHeader(parts[i], currentYear);
        if (date) {
          allDates.push({ date, position: i });
        }
      }
      if (allDates.length >= 2) break;
    }
    
    // Look for "Gesamt" line with values
    for (const line of lines) {
      if (line.toLowerCase().includes('gesamt') || line.toLowerCase().includes('total')) {
        const parts = line.split(/\s+/);
        for (let i = 0; i < parts.length; i++) {
          const { amount, currency } = parseRevenueValue(parts[i]);
          if (amount > 0) {
            // Try to match with a date position
            const dateEntry = allDates.find(d => Math.abs(d.position - i) <= 1);
            if (dateEntry) {
              entries.push({ date: dateEntry.date, revenue: amount });
              dateRange.push(dateEntry.date);
              detectedCurrency = currency;
            }
          }
        }
      }
    }
  }
  
  entries.sort((a, b) => a.date.localeCompare(b.date));
  dateRange.sort();
  
  return { entries, currency: detectedCurrency, dateRange };
};

/**
 * Parse revenue data from PDF (requires text extraction first)
 * This is a wrapper that works with pre-extracted text
 */
export const parseRevenuePDFText = (text: string): RevenueParseResult => {
  return parseRevenueText(text);
};

/**
 * Analyze hourly revenue data to suggest optimization opportunities
 */
export interface RevenueOptimizationAnalysis {
  date: string;
  totalRevenue: number;
  peakHour: number;
  peakHourRevenue: number;
  lastSignificantHour: number;
  suggestedClosingHour: number;
  revenueLostIfClosedEarlier: number;
  percentageOfRevenueAfterPeak: number;
  hourlyAnalysis: {
    hour: number;
    revenue: number;
    cumulativeRevenue: number;
    percentageOfTotal: number;
    revenuePerMinute: number;
  }[];
  recommendations: string[];
}

export const analyzeHourlyRevenue = (data: HourlyRevenueParseResult): RevenueOptimizationAnalysis => {
  const { date, totalRevenue, hourlyBreakdown, peakHour } = data;
  
  // Sort by hour
  const sortedHours = [...hourlyBreakdown].sort((a, b) => a.hour - b.hour);
  
  // Calculate cumulative revenue
  let cumulative = 0;
  const hourlyAnalysis = sortedHours.map(({ hour, revenue }) => {
    cumulative += revenue;
    return {
      hour,
      revenue,
      cumulativeRevenue: cumulative,
      percentageOfTotal: totalRevenue > 0 ? (revenue / totalRevenue) * 100 : 0,
      revenuePerMinute: revenue / 60,
    };
  });
  
  // Find last significant hour (>3% of daily revenue)
  const significantThreshold = totalRevenue * 0.03;
  let lastSignificantHour = 0;
  hourlyBreakdown.forEach(({ hour, revenue }) => {
    if (revenue >= significantThreshold) {
      lastSignificantHour = Math.max(lastSignificantHour, hour);
    }
  });
  
  // Suggest closing hour (hour after last significant activity)
  const suggestedClosingHour = Math.min(lastSignificantHour + 1, 23);
  
  // Calculate revenue that would be lost if closed earlier
  let revenueLostIfClosedEarlier = 0;
  let revenueAfterPeak = 0;
  let foundPeak = false;
  
  hourlyBreakdown.forEach(({ hour, revenue }) => {
    if (hour > lastSignificantHour) {
      revenueLostIfClosedEarlier += revenue;
    }
    if (foundPeak || hour === peakHour) {
      foundPeak = true;
      if (hour > peakHour) {
        revenueAfterPeak += revenue;
      }
    }
  });
  
  const percentageOfRevenueAfterPeak = totalRevenue > 0 ? (revenueAfterPeak / totalRevenue) * 100 : 0;
  
  // Find peak hour revenue
  const peakHourData = hourlyBreakdown.find(h => h.hour === peakHour);
  const peakHourRevenue = peakHourData?.revenue || 0;
  
  // Generate recommendations
  const recommendations: string[] = [];
  
  if (lastSignificantHour < 21) {
    recommendations.push(`Umsatz nach ${lastSignificantHour}:00 Uhr minimal - Schichtende für Aushilfen prüfen.`);
  }
  
  if (percentageOfRevenueAfterPeak > 40) {
    recommendations.push(`${percentageOfRevenueAfterPeak.toFixed(0)}% des Umsatzes nach Peak (${peakHour}:00) - Personal für Abendgeschäft wichtig.`);
  } else if (percentageOfRevenueAfterPeak < 20) {
    recommendations.push(`Nur ${percentageOfRevenueAfterPeak.toFixed(0)}% nach Peak - Abendbesetzung reduzieren.`);
  }
  
  // Check for low-activity periods
  const lowActivityHours = hourlyAnalysis.filter(h => h.revenue > 0 && h.percentageOfTotal < 2);
  if (lowActivityHours.length > 3) {
    const hours = lowActivityHours.map(h => `${h.hour}:00`).slice(0, 3).join(', ');
    recommendations.push(`Schwache Stunden: ${hours} - Kernbesetzung ausreichend.`);
  }
  
  return {
    date,
    totalRevenue,
    peakHour,
    peakHourRevenue,
    lastSignificantHour,
    suggestedClosingHour,
    revenueLostIfClosedEarlier,
    percentageOfRevenueAfterPeak,
    hourlyAnalysis,
    recommendations,
  };
};

// ─── Gastronovi Multi-Day Import ──────────────────────────────────────────────

export interface GastronoviDayResult {
  date: string;        // yyyy-MM-dd
  food: number;
  beverage: number;
  /** Voller Tagesumsatz brutto aus der «Gesamt»-Zeile (inkl. Take Away, nach
   *  Rabatten). Fallback: Summe der Kategoriezeilen, wenn keine Gesamt-Zeile. */
  total: number;
  /** Take-Away-Anteil brutto aus der separaten «Take Away»-Zeile (Teil von total). */
  takeAway: number;
  currency: 'CHF' | 'EUR';
}

/**
 * Parse Gastronovi daily-revenue Excel export.
 *
 * Row layout:
 *   col 0  = Bezeichnung (row label)
 *   col 1  = Zeitraum / period total
 *   col 2+ = one column per calendar day ("01.01.", "02.01.", …)
 *
 * Category rules:
 *   "Food (Speisen)"      → 100 % Food
 *   "Beverage (Getränke)" → 100 % Beverage
 *   everything else       → 70 % Food + 30 % Beverage
 *   "Gesamt"              → ignored (we recompute from Food + Bev + Other)
 *
 * @param file  The .xlsx file from the user
 * @param year  The calendar year of the data (required because column headers
 *              only contain "DD.MM." without year)
 */
export const parseGastronoviExcel = async (
  file: File,
  year: number,
): Promise<GastronoviDayResult[] | null> => {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();

    reader.onerror = () => reject(new Error('Datei konnte nicht gelesen werden'));

    reader.onload = (e) => {
      try {
        const data = e.target?.result;
        const workbook = XLSX.read(data, { type: 'array' });
        const firstSheet = workbook.Sheets[workbook.SheetNames[0]];
        const rows = XLSX.utils.sheet_to_json(firstSheet, {
          header: 1,
          defval: '',
        }) as (string | number)[][];

        if (!rows.length) { resolve(null); return; }

        // ── 1. Find the header row (the row whose cells 2+ look like dates) ──
        let headerRowIdx = -1;
        const dateColumns: { colIdx: number; date: string }[] = [];

        for (let r = 0; r < Math.min(rows.length, 5); r++) {
          const row = rows[r];
          const found: { colIdx: number; date: string }[] = [];
          for (let c = 2; c < row.length; c++) {
            const cell = String(row[c] ?? '').trim();
            if (!cell) continue;
            const d = parseDateFromHeader(cell, year);
            if (d) found.push({ colIdx: c, date: d });
          }
          if (found.length >= 2) {
            headerRowIdx = r;
            found.forEach(f => dateColumns.push(f));
            break;
          }
        }

        if (headerRowIdx === -1 || !dateColumns.length) {
          resolve(null);
          return;
        }

        // ── 2. Per-day accumulators ──
        const foodMap: Record<string, number>      = {};
        const beverageMap: Record<string, number>  = {};
        const otherMap: Record<string, number>     = {};
        const gesamtMap: Record<string, number>    = {};
        const takeAwayMap: Record<string, number>  = {};
        const currencyMap: Record<string, 'CHF' | 'EUR'> = {};
        // «Zeitraum»-Spalte (Spalte 1) = MASSGEBLICHES Perioden-Total pro Zeile.
        // Die Tageszellen des Exports summieren NICHT immer exakt auf dieses
        // Total — die Tageswerte werden deshalb proportional darauf abgeglichen.
        let zGesamt = 0, zTakeAway = 0, zFood = 0, zBeverage = 0;

        dateColumns.forEach(({ date }) => {
          foodMap[date]      = 0;
          beverageMap[date]  = 0;
          otherMap[date]     = 0;
          gesamtMap[date]    = 0;
          takeAwayMap[date]  = 0;
          currencyMap[date]  = 'CHF';
        });

        // ── 3. Walk data rows ──
        for (let r = headerRowIdx + 1; r < rows.length; r++) {
          const row = rows[r];
          if (!row || !row[0]) continue;

          const label = String(row[0]).trim().toLowerCase();
          const isTakeAway = label.includes('take away') || label.includes('take-away')
            || label.includes('takeaway') || label.includes('ausser haus') || label.includes('außer haus');
          const isGesamt   = !isTakeAway && (label.includes('gesamt') || label.includes('total'));
          const isFood     = label.includes('food') || label.includes('speisen');
          const isBeverage = label.includes('beverage') || label.includes('getränke');

          // Perioden-Total aus der «Zeitraum»-Spalte (Spalte 1)
          const zeitraum = parseRevenueValue(row[1] ?? '').amount;
          if (zeitraum !== 0) {
            if (isGesamt)        zGesamt   += zeitraum;
            else if (isTakeAway) zTakeAway += zeitraum;
            else if (isFood)     zFood     += zeitraum;
            else if (isBeverage) zBeverage += zeitraum;
          }

          for (const { colIdx, date } of dateColumns) {
            const cell = row[colIdx];
            if (cell === '' || cell === undefined || cell === null) continue;
            const { amount, currency } = parseRevenueValue(cell);
            if (amount === 0) continue;

            currencyMap[date] = currency;

            if (isGesamt) {
              // «Gesamt»-Zeile = voller Tagesumsatz (inkl. Take Away, nach Rabatten)
              gesamtMap[date] += amount;
            } else if (isTakeAway) {
              // Separate «Take Away»-Zeile: Teilmenge des Gesamtumsatzes,
              // NICHT zusätzlich in Food/Beverage/Other zählen.
              takeAwayMap[date] += amount;
            } else if (isFood)  foodMap[date]     += amount;
            else if (isBeverage) beverageMap[date] += amount;
            else                 otherMap[date]    += amount;
          }
        }

        // ── 4. Build results ──
        // Mit Gesamt-Zeile: food/beverage = REINE Kategoriezeilen (keine
        // 70/30-Umlage der übrigen Zeilen) — der Küche/Bar-Split folgt dem
        // rohen Food/Beverage-Verhältnis; übrige Zeilen stecken im Gesamt.
        // Ohne Gesamt-Zeile (Legacy-Fallback): total = Food+Bev+übrige (70/30).
        const hasGesamt = zGesamt > 0
          || dateColumns.some(({ date }) => (gesamtMap[date] ?? 0) > 0);

        const results: GastronoviDayResult[] = dateColumns.map(({ date }) => {
          const other    = otherMap[date] ?? 0;
          const foodRaw  = foodMap[date] ?? 0;
          const bevRaw   = beverageMap[date] ?? 0;
          const food     = hasGesamt ? foodRaw : foodRaw + other * 0.70;
          const beverage = hasGesamt ? bevRaw  : bevRaw  + other * 0.30;
          const katSumme = Math.round((foodRaw + bevRaw + other) * 100) / 100;
          const gesamt   = Math.round((gesamtMap[date] ?? 0) * 100) / 100;
          // Gesamt-Zeile ist massgeblich (voller Tagesumsatz) — PRO TAG:
          // fehlt der Gesamt-Wert an einem Tag, Fallback auf die Kategoriesumme.
          const total    = gesamt > 0 ? gesamt : katSumme;
          return {
            date,
            food:     Math.round(food     * 100) / 100,
            beverage: Math.round(beverage * 100) / 100,
            total,
            takeAway: Math.round((takeAwayMap[date] ?? 0) * 100) / 100,
            currency: currencyMap[date] ?? 'CHF',
          };
        }).filter(r => r.total !== 0);

        // ── 5. Abgleich auf die «Zeitraum»-Totale (massgeblich) ──
        // Die Tageszellen des Gastronovi-Exports summieren nicht immer exakt
        // auf das Perioden-Total. Jede Serie wird proportional skaliert und
        // der Rundungsrest auf den letzten Tag mit Wert gelegt, damit die
        // Monatssummen EXAKT den Zeitraum-Werten entsprechen.
        const adjustSeries = (
          get: (r: GastronoviDayResult) => number,
          set: (r: GastronoviDayResult, v: number) => void,
          target: number,
        ) => {
          if (target === 0 || results.length === 0) return;
          const sum = results.reduce((s, r) => s + get(r), 0);
          if (Math.abs(sum - target) < 0.05) return;
          let lastIdx = results.length - 1;
          results.forEach((r, i) => { if (get(r) !== 0) lastIdx = i; });
          if (sum !== 0 && Math.sign(sum) === Math.sign(target)) {
            // Proportional skalieren, Rundungsrest auf letzten Tag mit Wert.
            const factor = target / sum;
            let acc = 0;
            results.forEach(r => {
              const v = Math.round(get(r) * factor * 100) / 100;
              set(r, v); acc += v;
            });
            const rest = Math.round((target - acc) * 100) / 100;
            set(results[lastIdx], Math.round((get(results[lastIdx]) + rest) * 100) / 100);
          } else {
            // Keine skalierbare Basis (Summe 0 oder Vorzeichenwechsel):
            // gesamte Differenz auf den letzten Tag mit Wert legen.
            const rest = Math.round((target - sum) * 100) / 100;
            set(results[lastIdx], Math.round((get(results[lastIdx]) + rest) * 100) / 100);
          }
        };
        adjustSeries(r => r.total,    (r, v) => { r.total    = v; }, zGesamt);
        adjustSeries(r => r.takeAway, (r, v) => { r.takeAway = v; }, zTakeAway);
        adjustSeries(r => r.food,     (r, v) => { r.food     = v; }, zFood);
        adjustSeries(r => r.beverage, (r, v) => { r.beverage = v; }, zBeverage);

        // Datenqualitäts-Guard: Take Away ist Teilmenge von Gesamt.
        for (const r of results) r.takeAway = Math.min(r.takeAway, r.total);

        resolve(results);
      } catch (err) {
        reject(err);
      }
    };

    reader.readAsArrayBuffer(file);
  });
};
