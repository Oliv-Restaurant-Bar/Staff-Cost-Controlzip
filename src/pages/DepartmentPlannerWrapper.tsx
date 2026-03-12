import { useState, useEffect } from 'react';
import { useSearchParams, useParams } from 'react-router-dom';
import { supabase } from '@/integrations/supabase/client';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { 
  Loader2, ShieldAlert, Building2, Home,
  Smartphone, Share, PlusSquare, MoreVertical, Monitor
} from 'lucide-react';
import { Link } from 'react-router-dom';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';

type TokenRole = 'admin' | 'department';

interface TokenInfo {
  name: string;
  department: string;
  role: TokenRole;
  isValid: boolean;
}

const DepartmentPlannerWrapper = () => {
  const { department } = useParams<{ department: string }>();
  const [searchParams] = useSearchParams();
  const token = searchParams.get('token');
  
  const [isValidating, setIsValidating] = useState(true);
  const [isAuthorized, setIsAuthorized] = useState(false);
  const [tokenInfo, setTokenInfo] = useState<TokenInfo | null>(null);
  const [showInstallGuide, setShowInstallGuide] = useState(false);
  const [installGuideDismissed, setInstallGuideDismissed] = useState(() => {
    return localStorage.getItem('pwa-install-dismissed') === 'true';
  });

  // Validate token on mount
  useEffect(() => {
    const validateToken = async () => {
      if (!token || !department) {
        setIsValidating(false);
        return;
      }

      try {
        const { data, error } = await supabase
          .from('department_access_tokens')
          .select('*')
          .eq('token', token)
          .eq('is_active', true)
          .maybeSingle();

        if (error || !data) {
          setIsAuthorized(false);
        } else {
          const isAdmin = data.role === 'admin';
          const departmentMatch = data.department === department || isAdmin;
          
          if (!departmentMatch) {
            setIsAuthorized(false);
          } else if (data.expires_at && new Date(data.expires_at) < new Date()) {
            setIsAuthorized(false);
          } else {
            setIsAuthorized(true);
            setTokenInfo({
              name: data.name,
              department: data.department,
              role: (data.role || 'department') as TokenRole,
              isValid: true,
            });
            
            // Store token info for SchedulePlanner to use
            localStorage.setItem('current-department-token', JSON.stringify({
              token,
              department,
              role: data.role || 'department',
              name: data.name,
            }));
            
            // Update last_used_at
            await supabase
              .from('department_access_tokens')
              .update({ last_used_at: new Date().toISOString() })
              .eq('id', data.id);
          }
        }
      } catch (err) {
        console.error('Token validation error:', err);
        setIsAuthorized(false);
      }
      
      setIsValidating(false);
    };

    validateToken();
  }, [token, department]);

  // Show install guide after successful auth
  useEffect(() => {
    if (isAuthorized && !installGuideDismissed) {
      const isStandalone = window.matchMedia('(display-mode: standalone)').matches;
      if (!isStandalone) {
        const timer = setTimeout(() => setShowInstallGuide(true), 2000);
        return () => clearTimeout(timer);
      }
    }
  }, [isAuthorized, installGuideDismissed]);

  const dismissInstallGuide = (permanent: boolean) => {
    setShowInstallGuide(false);
    if (permanent) {
      localStorage.setItem('pwa-install-dismissed', 'true');
      setInstallGuideDismissed(true);
    }
  };

  // Loading state
  if (isValidating) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center">
        <div className="text-center space-y-4">
          <Loader2 className="h-12 w-12 animate-spin mx-auto text-primary" />
          <p className="text-muted-foreground">Zugang wird überprüft...</p>
        </div>
      </div>
    );
  }

  // Unauthorized state
  if (!isAuthorized || !department) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center p-4">
        <Card className="max-w-md w-full">
          <CardHeader className="text-center">
            <ShieldAlert className="h-16 w-16 mx-auto text-destructive mb-4" />
            <CardTitle className="text-xl">Zugriff verweigert</CardTitle>
          </CardHeader>
          <CardContent className="text-center space-y-4">
            <p className="text-muted-foreground">
              Der Zugangslink ist ungültig, abgelaufen oder wurde deaktiviert.
            </p>
            <p className="text-sm text-muted-foreground">
              Bitte kontaktieren Sie die Verwaltung für einen neuen Zugangslink.
            </p>
            <Button asChild className="w-full">
              <Link to="/">Zur Startseite</Link>
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  const departmentLabel = department === 'service' ? 'Service' : 'Küche';
  const departmentColor = department === 'service' ? 'bg-blue-500' : 'bg-orange-500';

  // Redirect to full schedule planner with department filter
  // The SchedulePlanner will read the token from localStorage
  return (
    <div className="min-h-screen bg-background">
      {/* Token Info Header */}
      <div className="sticky top-0 z-50 bg-background border-b border-border px-4 py-2">
        <div className="container mx-auto flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className={`p-2 rounded-lg ${departmentColor}`}>
              <Building2 className="h-4 w-4 text-white" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <span className="font-semibold text-sm">{departmentLabel} Dienstplan</span>
                {tokenInfo?.role === 'admin' && (
                  <Badge variant="outline" className="text-xs">Admin</Badge>
                )}
              </div>
              <p className="text-xs text-muted-foreground">{tokenInfo?.name}</p>
            </div>
          </div>
          
          <div className="flex items-center gap-2">
            {!installGuideDismissed && (
              <Button 
                variant="ghost" 
                size="sm"
                onClick={() => setShowInstallGuide(true)}
                className="gap-1 text-xs"
              >
                <Smartphone className="h-3 w-3" />
                <span className="hidden sm:inline">Installieren</span>
              </Button>
            )}
            <Button variant="ghost" size="sm" asChild>
              <Link to="/" className="gap-1">
                <Home className="h-4 w-4" />
                <span className="hidden sm:inline">Übersicht</span>
              </Link>
            </Button>
          </div>
        </div>
      </div>

      {/* Main Content - Embed as iframe or redirect */}
      <div className="p-4">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Building2 className="h-5 w-5" />
              {departmentLabel} Dienstplan-Verwaltung
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <p className="text-muted-foreground">
              Du hast Zugriff auf den vollständigen Dienstplaner für die {departmentLabel}-Abteilung.
            </p>
            
            <div className="flex flex-col sm:flex-row gap-3">
              <Button asChild className="flex-1">
                <Link to={`/schedule-planner?dept=${department}&token=${token}`}>
                  Zum vollständigen Dienstplaner
                </Link>
              </Button>
              
              <Button asChild variant="outline" className="flex-1">
                <Link to={`/dienstplan/${department}?token=${token}`}>
                  Zur Schnellansicht
                </Link>
              </Button>
            </div>

            <div className="pt-4 border-t">
              <h4 className="font-medium mb-2">Verfügbare Funktionen:</h4>
              <ul className="text-sm text-muted-foreground space-y-1">
                <li>✓ Schichten bearbeiten (Früh/Spät)</li>
                <li>✓ Abwesenheiten eintragen (Ferien, Krank, Frei)</li>
                <li>✓ Woche kopieren</li>
                <li>✓ 8.5h Schnellplanung</li>
                <li>✓ PDF/Excel Export</li>
                <li>✓ Drucken</li>
                {tokenInfo?.role === 'admin' && (
                  <li>✓ Mitarbeiter verwalten (Admin)</li>
                )}
              </ul>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* PWA Install Guide Dialog */}
      <Dialog open={showInstallGuide} onOpenChange={setShowInstallGuide}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Smartphone className="h-5 w-5 text-primary" />
              App installieren
            </DialogTitle>
            <DialogDescription>
              Füge den Dienstplan zum Startbildschirm hinzu für schnellen Zugriff.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4">
            <div className="p-3 rounded-lg bg-muted/50 space-y-3">
              <div className="flex items-center gap-2 font-medium">
                <Monitor className="h-4 w-4" />
                <span>Desktop (Chrome/Edge)</span>
              </div>
              <ol className="space-y-2 text-sm pl-6">
                <li>1. Klicke auf das Install-Symbol in der Adressleiste</li>
                <li>2. Oder: Menü → "App installieren"</li>
              </ol>
            </div>

            <div className="p-3 rounded-lg bg-muted/50 space-y-3">
              <div className="flex items-center gap-2 font-medium">
                <span>🍎</span>
                <span>iPhone / iPad (Safari)</span>
              </div>
              <ol className="space-y-2 text-sm pl-6">
                <li>1. Tippe auf <Share className="inline h-4 w-4" /> (Teilen)</li>
                <li>2. Wähle <PlusSquare className="inline h-4 w-4" /> "Zum Home-Bildschirm"</li>
              </ol>
            </div>

            <div className="p-3 rounded-lg bg-muted/50 space-y-3">
              <div className="flex items-center gap-2 font-medium">
                <span>🤖</span>
                <span>Android (Chrome)</span>
              </div>
              <ol className="space-y-2 text-sm pl-6">
                <li>1. Tippe auf <MoreVertical className="inline h-4 w-4" /> (Menü)</li>
                <li>2. Wähle "Zum Startbildschirm hinzufügen"</li>
              </ol>
            </div>
          </div>

          <div className="flex gap-2 pt-2">
            <Button variant="outline" className="flex-1" onClick={() => dismissInstallGuide(false)}>
              Später
            </Button>
            <Button className="flex-1" onClick={() => dismissInstallGuide(true)}>
              Verstanden
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
};

export default DepartmentPlannerWrapper;
