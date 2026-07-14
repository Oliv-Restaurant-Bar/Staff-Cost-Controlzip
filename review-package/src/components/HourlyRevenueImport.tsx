import { useState, useRef } from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Progress } from '@/components/ui/progress';
import { Badge } from '@/components/ui/badge';
import { parseHourlyRevenueExcel, parseFoodBeverageExcel, analyzeHourlyRevenue, HourlyRevenueParseResult, RevenueOptimizationAnalysis, DailyFoodBeverageResult } from '@/lib/revenue-parser';
import { formatCurrency } from '@/lib/personnel-utils';
import { toast } from 'sonner';
import { Upload, Clock, TrendingUp, TrendingDown, AlertTriangle, CheckCircle, BarChart3, Utensils, Wine } from 'lucide-react';
import { cn } from '@/lib/utils';
import { format, parse } from 'date-fns';
import { de } from 'date-fns/locale';
import { DailyBudget, HourlyRevenue } from '@/types/personnel';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';

interface HourlyRevenueImportProps {
  onImport: (date: string, hourlyRevenue: HourlyRevenue[], totalRevenue: number, totalFood?: number, totalBeverage?: number) => void;
  dailyBudgets: {[key: string]: DailyBudget};
}

export const HourlyRevenueImport = ({ onImport, dailyBudgets }: HourlyRevenueImportProps) => {
  const [isProcessing, setIsProcessing] = useState(false);
  const [result, setResult] = useState<HourlyRevenueParseResult | null>(null);
  const [dailyResults, setDailyResults] = useState<DailyFoodBeverageResult[] | null>(null);
  const [analysis, setAnalysis] = useState<RevenueOptimizationAnalysis | null>(null);
  const [selectedDate, setSelectedDate] = useState<string>(new Date().toISOString().split('T')[0]);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setIsProcessing(true);
    setResult(null);
    setDailyResults(null);
    setAnalysis(null);

    try {
      // First try to parse as Food/Beverage daily format
      const dailyData = await parseFoodBeverageExcel(file);
      
      if (dailyData && dailyData.length > 0) {
        // Successfully parsed Food/Beverage format
        setDailyResults(dailyData);
        
        toast.success('Umsatzdaten importiert', {
          description: `${dailyData.length} Tage mit Food/Beverage-Daten erkannt`,
        });
      } else {
        // Try hourly format as fallback
        const parsed = await parseHourlyRevenueExcel(file);
        
        if (!parsed || parsed.hourlyBreakdown.length === 0) {
          toast.error('Keine Umsatzdaten gefunden', {
            description: 'Die Datei enthält keine erkennbaren Umsatzdaten.',
          });
          setIsProcessing(false);
          return;
        }

        setResult(parsed);
        setSelectedDate(parsed.date);
        
        // Run analysis
        const analysisResult = analyzeHourlyRevenue(parsed);
        setAnalysis(analysisResult);

        toast.success('Stundenumsatz importiert', {
          description: `${parsed.hourlyBreakdown.length} Stunden erkannt, Total: ${formatCurrency(parsed.totalRevenue)}`,
        });
      }
    } catch (error) {
      console.error('Import error:', error);
      toast.error('Import fehlgeschlagen', {
        description: 'Die Datei konnte nicht verarbeitet werden.',
      });
    } finally {
      setIsProcessing(false);
      if (fileInputRef.current) {
        fileInputRef.current.value = '';
      }
    }
  };

  const handleSave = () => {
    if (!result) return;

    const hourlyRevenue: HourlyRevenue[] = result.hourlyBreakdown.map(h => ({
      hour: h.hour,
      revenue: h.revenue,
      food: h.food,
      beverage: h.beverage,
    }));

    onImport(selectedDate, hourlyRevenue, result.totalRevenue, result.totalFood, result.totalBeverage);
    
    toast.success('Stündlicher Umsatz gespeichert', {
      description: `Daten für ${format(new Date(selectedDate), 'dd.MM.yyyy', { locale: de })} wurden übernommen.`,
    });

    setResult(null);
    setAnalysis(null);
  };

  const handleSaveDaily = () => {
    if (!dailyResults) return;

    let savedCount = 0;
    dailyResults.forEach(day => {
      // Create hourly revenue entries with food/beverage split
      // Since this is daily data, we distribute evenly across typical restaurant hours (11-22)
      const hours = [11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22];
      const hourlyRevenue: HourlyRevenue[] = hours.map(hour => ({
        hour,
        revenue: day.totalRevenue / hours.length,
        food: day.food / hours.length,
        beverage: day.beverage / hours.length,
      }));

      onImport(day.date, hourlyRevenue, day.totalRevenue, day.food, day.beverage);
      savedCount++;
    });
    
    toast.success('Umsatzdaten gespeichert', {
      description: `${savedCount} Tage mit Food/Beverage-Daten übernommen.`,
    });

    setDailyResults(null);
  };

  const formatTime = (hour: number): string => {
    return `${String(hour).padStart(2, '0')}:00`;
  };

  const getHourColor = (percentage: number): string => {
    if (percentage >= 15) return 'bg-green-500';
    if (percentage >= 8) return 'bg-blue-500';
    if (percentage >= 3) return 'bg-yellow-500';
    return 'bg-gray-300';
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <BarChart3 className="h-5 w-5" />
          Stündlicher Tagesumsatz
        </CardTitle>
        <CardDescription>
          Importiere den Umsatz pro Stunde für die Analyse der optimalen Personalbesetzung
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* File Upload */}
        <div className="flex items-center gap-3">
          <Input
            ref={fileInputRef}
            type="file"
            accept=".xlsx,.xls"
            onChange={handleFileChange}
            disabled={isProcessing}
            className="flex-1"
          />
          <Button
            variant="outline"
            size="icon"
            disabled={isProcessing}
            onClick={() => fileInputRef.current?.click()}
          >
            <Upload className="h-4 w-4" />
          </Button>
        </div>

        {isProcessing && (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-primary" />
            Verarbeite Datei...
          </div>
        )}

        {/* Daily Food/Beverage Results */}
        {dailyResults && dailyResults.length > 0 && (
          <div className="space-y-4">
            <div className="flex items-center gap-2 text-sm">
              <Badge variant="outline" className="gap-1">
                <Utensils className="h-3 w-3" /> Food = Küche
              </Badge>
              <Badge variant="outline" className="gap-1">
                <Wine className="h-3 w-3" /> Beverage = Service
              </Badge>
            </div>

            {/* Summary */}
            <div className="grid grid-cols-3 gap-3">
              <div className="p-3 rounded-lg bg-muted/50">
                <p className="text-xs text-muted-foreground">Gesamt</p>
                <p className="text-lg font-bold">{formatCurrency(dailyResults.reduce((sum, d) => sum + d.totalRevenue, 0))}</p>
                <p className="text-xs text-muted-foreground">{dailyResults.length} Tage</p>
              </div>
              <div className="p-3 rounded-lg bg-amber-50 dark:bg-amber-950/30">
                <div className="flex items-center gap-1 text-xs text-amber-700 dark:text-amber-400">
                  <Utensils className="h-3 w-3" /> Food (Küche)
                </div>
                <p className="text-lg font-bold text-amber-700 dark:text-amber-400">
                  {formatCurrency(dailyResults.reduce((sum, d) => sum + d.food, 0))}
                </p>
              </div>
              <div className="p-3 rounded-lg bg-blue-50 dark:bg-blue-950/30">
                <div className="flex items-center gap-1 text-xs text-blue-700 dark:text-blue-400">
                  <Wine className="h-3 w-3" /> Beverage (Service)
                </div>
                <p className="text-lg font-bold text-blue-700 dark:text-blue-400">
                  {formatCurrency(dailyResults.reduce((sum, d) => sum + d.beverage, 0))}
                </p>
              </div>
            </div>

            {/* Daily breakdown table */}
            <div className="border rounded-lg overflow-hidden">
              <table className="w-full text-sm">
                <thead className="bg-muted">
                  <tr>
                    <th className="px-3 py-2 text-left">Datum</th>
                    <th className="px-3 py-2 text-right">Gesamt</th>
                    <th className="px-3 py-2 text-right">
                      <span className="flex items-center justify-end gap-1">
                        <Utensils className="h-3 w-3" /> Food
                      </span>
                    </th>
                    <th className="px-3 py-2 text-right">
                      <span className="flex items-center justify-end gap-1">
                        <Wine className="h-3 w-3" /> Beverage
                      </span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {dailyResults.map((day) => (
                    <tr key={day.date} className="border-t">
                      <td className="px-3 py-2 font-medium">
                        {format(new Date(day.date), 'EEE dd.MM.', { locale: de })}
                      </td>
                      <td className="px-3 py-2 text-right font-mono">
                        {formatCurrency(day.totalRevenue)}
                      </td>
                      <td className="px-3 py-2 text-right font-mono text-amber-600">
                        {formatCurrency(day.food)}
                      </td>
                      <td className="px-3 py-2 text-right font-mono text-blue-600">
                        {formatCurrency(day.beverage)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {/* Save Button */}
            <Button onClick={handleSaveDaily} className="w-full">
              <CheckCircle className="h-4 w-4 mr-2" />
              Alle {dailyResults.length} Tage übernehmen
            </Button>
          </div>
        )}

        {/* Hourly Results */}
        {result && analysis && (
          <div className="space-y-4">
            {/* Date Selection */}
            <div className="flex items-center gap-3">
              <Label htmlFor="import-date">Datum:</Label>
              <Input
                id="import-date"
                type="date"
                value={selectedDate}
                onChange={(e) => setSelectedDate(e.target.value)}
                className="w-auto"
              />
            </div>

            {/* Summary Cards with Food/Beverage */}
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              <div className="p-3 rounded-lg bg-muted/50">
                <p className="text-xs text-muted-foreground">Total</p>
                <p className="text-lg font-bold">{formatCurrency(result.totalRevenue)}</p>
              </div>
              {result.totalFood > 0 && (
                <div className="p-3 rounded-lg bg-amber-50 dark:bg-amber-950/30">
                  <div className="flex items-center gap-1 text-xs text-amber-700 dark:text-amber-400">
                    <Utensils className="h-3 w-3" /> Food (Küche)
                  </div>
                  <p className="text-lg font-bold text-amber-700 dark:text-amber-400">
                    {formatCurrency(result.totalFood)}
                  </p>
                </div>
              )}
              {result.totalBeverage > 0 && (
                <div className="p-3 rounded-lg bg-blue-50 dark:bg-blue-950/30">
                  <div className="flex items-center gap-1 text-xs text-blue-700 dark:text-blue-400">
                    <Wine className="h-3 w-3" /> Beverage (Service)
                  </div>
                  <p className="text-lg font-bold text-blue-700 dark:text-blue-400">
                    {formatCurrency(result.totalBeverage)}
                  </p>
                </div>
              )}
              <div className="p-3 rounded-lg bg-muted/50">
                <p className="text-xs text-muted-foreground">Peak Stunde</p>
                <p className="text-lg font-bold">{formatTime(analysis.peakHour)}</p>
              </div>
            </div>

            {/* Hourly Breakdown Visual */}
            <div className="space-y-2">
              <Label>Umsatzverteilung pro Stunde</Label>
              <div className="flex gap-0.5 h-20 items-end">
                {analysis.hourlyAnalysis
                  .filter(h => h.hour >= 10 && h.hour <= 24)
                  .map((h) => {
                    const maxRevenue = Math.max(...analysis.hourlyAnalysis.map(x => x.revenue));
                    const height = maxRevenue > 0 ? (h.revenue / maxRevenue) * 100 : 0;
                    
                    return (
                      <div
                        key={h.hour}
                        className="flex-1 flex flex-col items-center gap-0.5"
                      >
                        <div
                          className={cn(
                            'w-full rounded-t transition-all',
                            getHourColor(h.percentageOfTotal)
                          )}
                          style={{ height: `${Math.max(height, 2)}%` }}
                          title={`${formatTime(h.hour)}: ${formatCurrency(h.revenue)} (${h.percentageOfTotal.toFixed(1)}%)`}
                        />
                        <span className="text-[10px] text-muted-foreground">
                          {h.hour}
                        </span>
                      </div>
                    );
                  })}
              </div>
              <div className="flex gap-4 text-xs text-muted-foreground">
                <span className="flex items-center gap-1">
                  <div className="w-3 h-3 rounded bg-green-500" /> &gt;15%
                </span>
                <span className="flex items-center gap-1">
                  <div className="w-3 h-3 rounded bg-blue-500" /> 8-15%
                </span>
                <span className="flex items-center gap-1">
                  <div className="w-3 h-3 rounded bg-yellow-500" /> 3-8%
                </span>
                <span className="flex items-center gap-1">
                  <div className="w-3 h-3 rounded bg-gray-300" /> &lt;3%
                </span>
              </div>
            </div>

            {/* Top Hours Table */}
            <div className="space-y-2">
              <Label>Top Stunden</Label>
              <div className="border rounded-lg overflow-hidden">
                <table className="w-full text-sm">
                  <thead className="bg-muted">
                    <tr>
                      <th className="px-3 py-2 text-left">Stunde</th>
                      <th className="px-3 py-2 text-right">Umsatz</th>
                      <th className="px-3 py-2 text-right">Anteil</th>
                      <th className="px-3 py-2 text-right">Kumuliert</th>
                    </tr>
                  </thead>
                  <tbody>
                    {[...analysis.hourlyAnalysis]
                      .filter(h => h.revenue > 0)
                      .sort((a, b) => b.revenue - a.revenue)
                      .slice(0, 5)
                      .map((h) => (
                        <tr key={h.hour} className="border-t">
                          <td className="px-3 py-2 font-medium">{formatTime(h.hour)}</td>
                          <td className="px-3 py-2 text-right font-mono">{formatCurrency(h.revenue)}</td>
                          <td className="px-3 py-2 text-right">
                            <Badge variant={h.percentageOfTotal >= 10 ? 'default' : 'secondary'}>
                              {h.percentageOfTotal.toFixed(1)}%
                            </Badge>
                          </td>
                          <td className="px-3 py-2 text-right font-mono text-muted-foreground">
                            {formatCurrency(h.cumulativeRevenue)}
                          </td>
                        </tr>
                      ))}
                  </tbody>
                </table>
              </div>
            </div>

            {/* Recommendations */}
            {analysis.recommendations.length > 0 && (
              <div className="space-y-2">
                <Label className="flex items-center gap-2">
                  <AlertTriangle className="h-4 w-4 text-amber-500" />
                  Empfehlungen für Personalplanung
                </Label>
                <div className="space-y-2">
                  {analysis.recommendations.map((rec, i) => (
                    <div
                      key={i}
                      className="flex items-start gap-2 p-2 rounded-lg bg-amber-50 dark:bg-amber-950/30 text-sm"
                    >
                      <CheckCircle className="h-4 w-4 text-amber-600 mt-0.5 flex-shrink-0" />
                      <span>{rec}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Save Button */}
            <Button onClick={handleSave} className="w-full">
              <CheckCircle className="h-4 w-4 mr-2" />
              Stundenumsatz übernehmen
            </Button>
          </div>
        )}

        {/* Existing hourly data */}
        {!result && Object.entries(dailyBudgets).some(([, b]) => b.hourlyRevenue && b.hourlyRevenue.length > 0) && (
          <div className="space-y-2">
            <Label className="text-muted-foreground">Vorhandene Stundendaten</Label>
            <div className="flex flex-wrap gap-2">
              {Object.entries(dailyBudgets)
                .filter(([, b]) => b.hourlyRevenue && b.hourlyRevenue.length > 0)
                .slice(0, 5)
                .map(([date, budget]) => (
                  <Badge key={date} variant="outline">
                    {format(new Date(date), 'dd.MM.', { locale: de })} - {formatCurrency(budget.actualRevenue)}
                  </Badge>
                ))}
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
};
