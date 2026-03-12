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
