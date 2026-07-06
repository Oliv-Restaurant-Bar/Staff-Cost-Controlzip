import { useState } from 'react';
import { Link, Navigate } from 'react-router-dom';
import { LayoutDashboard } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { AdyenAbgleichSection } from '@/components/umsatzabstimmung/AdyenAbgleichSection';
import { TagesabschlussSection } from '@/components/umsatzabstimmung/TagesabschlussSection';
import { useTenant } from '@/contexts/TenantContext';
import { usePermissions } from '@/hooks/usePermissions';

const currentYear = new Date().getFullYear();
const YEAR_OPTIONS = [currentYear, currentYear - 1, currentYear - 2];

/**
 * Tagesabschlüsse — tägliche Prüfung & Bestätigung pro Tag:
 * Tagesabschluss-Monatsübersicht (analog Excel „UMSATZ Oliv") und
 * Täglicher Abgleich Z-Bericht ↔ Adyen.
 * Die monatliche Umsatzabstimmung bleibt eine eigene Seite (/umsatzabstimmung).
 */
export default function TagesabschluessePage() {
  const { isAdmin, isBeaulieuManager } = usePermissions();
  const { tenantId } = useTenant();
  const [year, setYear] = useState(currentYear);

  if (isBeaulieuManager || !isAdmin) return <Navigate to="/" replace />;

  return (
    <div className="min-h-screen bg-background">
      <header className="sticky top-0 z-50 bg-card border-b border-border shadow-sm">
        <div className="max-w-full px-4 py-3 flex items-center justify-between gap-3 flex-wrap">
          <div className="flex items-center gap-2">
            <Link to="/">
              <Button variant="ghost" size="sm" className="h-8 px-2">
                <LayoutDashboard className="h-3.5 w-3.5 mr-1" />
                <span className="text-xs hidden sm:inline">Dashboard</span>
              </Button>
            </Link>
            <span className="text-muted-foreground text-xs">/</span>
            <h1 className="text-sm font-bold">Tagesabschlüsse</h1>
          </div>
          <Select value={String(year)} onValueChange={v => setYear(Number(v))}>
            <SelectTrigger className="h-8 w-24 text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {YEAR_OPTIONS.map(y => (
                <SelectItem key={y} value={String(y)} className="text-xs">{y}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </header>
      <main className="max-w-screen-xl mx-auto px-4 py-6">
        <p className="text-xs text-muted-foreground mb-4">
          Z-Bericht, Adyen-Abgleich, Barbestand, Barausgaben und manuelle Korrekturen pro Tag prüfen und bestätigen.
        </p>
        <TagesabschlussSection tenantId={tenantId} year={year} />
        <AdyenAbgleichSection tenantId={tenantId} year={year} />
      </main>
    </div>
  );
}
