import { useState, useEffect, ReactNode } from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Lock, Eye, EyeOff, LogOut } from 'lucide-react';
import { toast } from 'sonner';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip';

interface GlobalSiteProtectionProps {
  children: ReactNode;
}

// Default password - can be changed in localStorage under 'admin_password'
const DEFAULT_PASSWORD = 'admin123';

export const GLOBAL_SITE_PROTECTION_ENABLED_KEY = 'global_site_protection_enabled';
const SESSION_STORAGE_KEY = 'global_site_unlocked';

export const GlobalSiteProtection = ({ children }: GlobalSiteProtectionProps) => {
  const [isUnlocked, setIsUnlocked] = useState(false);
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [isEnabled, setIsEnabled] = useState(false);

  useEffect(() => {
    // Check if global protection is enabled
    const protectionEnabled = localStorage.getItem(GLOBAL_SITE_PROTECTION_ENABLED_KEY) === 'true';
    setIsEnabled(protectionEnabled);
    
    if (!protectionEnabled) {
      setIsUnlocked(true);
      setIsLoading(false);
      return;
    }
    
    // Check if already unlocked in this session
    const unlocked = sessionStorage.getItem(SESSION_STORAGE_KEY);
    if (unlocked === 'true') {
      setIsUnlocked(true);
    }
    setIsLoading(false);
  }, []);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    
    // Get the configured password or use default
    const configuredPassword = localStorage.getItem('admin_password') || DEFAULT_PASSWORD;
    
    if (password === configuredPassword) {
      sessionStorage.setItem(SESSION_STORAGE_KEY, 'true');
      // Also unlock other protected areas
      sessionStorage.setItem('dashboard_unlocked', 'true');
      sessionStorage.setItem('settings_unlocked', 'true');
      sessionStorage.setItem('salary_columns_unlocked', 'true');
      setIsUnlocked(true);
      toast.success('Zugriff gewährt');
    } else {
      toast.error('Falsches Passwort');
      setPassword('');
    }
  };

  if (isLoading) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center">
        <div className="animate-pulse">Laden...</div>
      </div>
    );
  }

  const handleLogout = () => {
    sessionStorage.removeItem(SESSION_STORAGE_KEY);
    sessionStorage.removeItem('dashboard_unlocked');
    sessionStorage.removeItem('settings_unlocked');
    sessionStorage.removeItem('salary_columns_unlocked');
    setIsUnlocked(false);
    toast.success('Erfolgreich abgemeldet');
  };

  // If protection is disabled or already unlocked, render children with logout button
  if (!isEnabled || isUnlocked) {
    return (
      <>
        {children}
        {isEnabled && isUnlocked && (
          <TooltipProvider>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="outline"
                  size="icon"
                  onClick={handleLogout}
                  className="fixed bottom-4 right-4 z-50 h-10 w-10 rounded-full shadow-lg bg-background border-destructive/50 hover:bg-destructive/10 hover:border-destructive"
                >
                  <LogOut className="h-4 w-4 text-destructive" />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="left">
                <p>Abmelden</p>
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>
        )}
      </>
    );
  }

  return (
    <div className="min-h-screen bg-background flex items-center justify-center p-4">
      <Card className="w-full max-w-md">
        <CardHeader className="text-center">
          <div className="mx-auto mb-4 h-12 w-12 rounded-full bg-primary/10 flex items-center justify-center">
            <Lock className="h-6 w-6 text-primary" />
          </div>
          <CardTitle>Anmeldung erforderlich</CardTitle>
          <CardDescription>
            Diese Anwendung ist passwortgeschützt. Bitte geben Sie das Passwort ein, um fortzufahren.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="relative">
              <Input
                type={showPassword ? 'text' : 'password'}
                placeholder="Passwort eingeben"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="pr-10"
                autoFocus
              />
              <button
                type="button"
                onClick={() => setShowPassword(!showPassword)}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
              >
                {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
              </button>
            </div>
            <Button type="submit" className="w-full">
              <Lock className="h-4 w-4 mr-2" />
              Anmelden
            </Button>
          </form>
          <p className="text-xs text-muted-foreground text-center mt-4">
            Standard-Passwort: admin123
          </p>
        </CardContent>
      </Card>
    </div>
  );
};
