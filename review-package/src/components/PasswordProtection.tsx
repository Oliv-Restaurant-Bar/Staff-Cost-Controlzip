import { useState, useEffect, ReactNode } from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Lock, Eye, EyeOff } from 'lucide-react';
import { toast } from 'sonner';

interface PasswordProtectionProps {
  children: ReactNode;
  storageKey?: string;
  /** Set to true to enable password protection, false to bypass */
  enabled?: boolean;
  /** Title for the login screen */
  title?: string;
  /** Description for the login screen */
  description?: string;
  /** Whether this is the global site protection (bypasses settings page) */
  isGlobalProtection?: boolean;
}

// Default password - can be changed in localStorage under 'admin_password'
const DEFAULT_PASSWORD = 'admin123';

export const PASSWORD_PROTECTION_ENABLED_KEY = 'password_protection_enabled';
export const GLOBAL_SITE_PROTECTION_ENABLED_KEY = 'global_site_protection_enabled';

export const PasswordProtection = ({ 
  children, 
  storageKey = 'dashboard_unlocked',
  enabled,
  title = 'Geschützter Bereich',
  description = 'Diese Seite enthält vertrauliche Informationen wie Löhne und KPIs. Bitte geben Sie das Passwort ein, um fortzufahren.',
  isGlobalProtection = false
}: PasswordProtectionProps) => {
  // Check localStorage setting if enabled prop is not explicitly set
  const isProtectionEnabled = enabled ?? localStorage.getItem(PASSWORD_PROTECTION_ENABLED_KEY) === 'true';
  
  // If protection is disabled, just render children directly
  if (!isProtectionEnabled) {
    return <>{children}</>;
  }

  const [isUnlocked, setIsUnlocked] = useState(false);
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    // Check if already unlocked in this session
    const unlocked = sessionStorage.getItem(storageKey);
    if (unlocked === 'true') {
      setIsUnlocked(true);
    }
    setIsLoading(false);
  }, [storageKey]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    
    // Get the configured password or use default
    const configuredPassword = localStorage.getItem('admin_password') || DEFAULT_PASSWORD;
    
    if (password === configuredPassword) {
      sessionStorage.setItem(storageKey, 'true');
      // Also unlock salary columns when any protected area is unlocked
      sessionStorage.setItem('salary_columns_unlocked', 'true');
      setIsUnlocked(true);
      toast.success('Zugriff gewährt');
    } else {
      toast.error('Falsches Passwort');
      setPassword('');
    }
  };

  const handleLock = () => {
    sessionStorage.removeItem(storageKey);
    sessionStorage.removeItem('salary_columns_unlocked');
    setIsUnlocked(false);
    setPassword('');
  };

  if (isLoading) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center">
        <div className="animate-pulse">Laden...</div>
      </div>
    );
  }

  if (!isUnlocked) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center p-4">
        <Card className="w-full max-w-md">
          <CardHeader className="text-center">
            <div className="mx-auto mb-4 h-12 w-12 rounded-full bg-primary/10 flex items-center justify-center">
              <Lock className="h-6 w-6 text-primary" />
            </div>
            <CardTitle>{title}</CardTitle>
            <CardDescription>
              {description}
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
                Entsperren
              </Button>
            </form>
            <p className="text-xs text-muted-foreground text-center mt-4">
              Standard-Passwort: admin123
            </p>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="relative">
      {/* Lock button - fixed in corner (only show for non-global protection) */}
      {!isGlobalProtection && (
        <Button
          variant="ghost"
          size="icon"
          onClick={handleLock}
          className="fixed bottom-4 right-4 z-50 bg-background/80 backdrop-blur-sm border shadow-sm hover:bg-destructive hover:text-destructive-foreground"
          title="Seite sperren"
        >
          <Lock className="h-4 w-4" />
        </Button>
      )}
      {children}
    </div>
  );
};
