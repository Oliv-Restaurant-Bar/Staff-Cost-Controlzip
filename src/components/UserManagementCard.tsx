/**
 * UserManagementCard – Benutzer und Rollen verwalten
 * ====================================================
 * Zeigt alle Benutzer aus user_profiles und erlaubt
 * dem Admin, Rollen zu ändern.
 *
 * Für das Anlegen neuer Benutzer: Anleitung im Tab "Neuer Benutzer".
 */

import { useState, useEffect, useCallback } from 'react';
import { ShieldCheck, Utensils, ChefHat, Loader2, RefreshCw, Edit2, Check, X, Copy, UserPlus, AlertTriangle } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/hooks/useAuth';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';

type UserRole = 'admin' | 'service_manager' | 'kueche_manager';

interface UserProfile {
  id: string;
  email: string | null;
  role: UserRole;
  created_at: string;
  isSelf?: boolean;
}

const ROLE_CONFIG: Record<UserRole, { label: string; color: string; Icon: React.FC<{ className?: string }> }> = {
  admin: {
    label: 'Administrator',
    color: 'bg-purple-100 text-purple-700 border-purple-200',
    Icon: ShieldCheck,
  },
  service_manager: {
    label: 'Service-Manager',
    color: 'bg-blue-100 text-blue-700 border-blue-200',
    Icon: Utensils,
  },
  kueche_manager: {
    label: 'Küchen-Manager',
    color: 'bg-orange-100 text-orange-700 border-orange-200',
    Icon: ChefHat,
  },
};

const SQL_MIGRATION = `-- Im Supabase SQL-Editor ausführen (einmalig):
-- Inhalt der Datei supabase/user_management.sql`;

const SQL_NEW_ADMIN = `-- Schritt 1: Supabase Dashboard → Authentication → Users
--             → "Add user" → "Create new user"
--             E-Mail + Passwort eingeben → "Create User"
--
-- Schritt 2: Im SQL-Editor ausführen:
SELECT set_user_role('admin2@olivbern.ch', 'admin');`;

export function UserManagementCard() {
  const { user } = useAuth();
  const [users, setUsers]         = useState<UserProfile[]>([]);
  const [loading, setLoading]     = useState(true);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editRole, setEditRole]   = useState<UserRole>('admin');
  const [saving, setSaving]       = useState(false);
  const [migrationNeeded, setMigrationNeeded] = useState(false);

  const loadUsers = useCallback(async () => {
    setLoading(true);
    try {
      // Try to load with email column first
      const { data, error } = await (supabase as any)
        .from('user_profiles')
        .select('id, email, role, created_at')
        .order('created_at', { ascending: true });

      if (error) {
        console.error('[UserMgmt] Fehler beim Laden:', error.message);
        setUsers([]);
        setLoading(false);
        return;
      }

      // Check if email column exists (migration done)
      const hasMigration = data && data.length > 0 && 'email' in data[0];
      if (!hasMigration && data && data.length > 0 && !('email' in data[0])) {
        setMigrationNeeded(true);
      }

      const profiles: UserProfile[] = (data || []).map((row: any) => ({
        id:         row.id,
        email:      row.email ?? null,
        role:       row.role as UserRole,
        created_at: row.created_at,
        isSelf:     row.id === user?.id,
      }));

      setUsers(profiles);
    } catch (err) {
      console.error('[UserMgmt] Unerwarteter Fehler:', err);
      setUsers([]);
    } finally {
      setLoading(false);
    }
  }, [user?.id]);

  useEffect(() => { loadUsers(); }, [loadUsers]);

  const startEdit = (u: UserProfile) => {
    setEditingId(u.id);
    setEditRole(u.role);
  };

  const cancelEdit = () => {
    setEditingId(null);
  };

  const saveRole = async (profileId: string) => {
    setSaving(true);
    try {
      const { error } = await (supabase as any)
        .from('user_profiles')
        .update({ role: editRole })
        .eq('id', profileId);

      if (error) throw error;

      setUsers(prev => prev.map(u =>
        u.id === profileId ? { ...u, role: editRole } : u,
      ));
      setEditingId(null);
      toast.success('Rolle gespeichert');
    } catch (err: any) {
      toast.error('Fehler beim Speichern: ' + (err?.message ?? 'Unbekannt'));
    } finally {
      setSaving(false);
    }
  };

  const copyToClipboard = (text: string) => {
    navigator.clipboard.writeText(text).then(() => toast.success('In Zwischenablage kopiert'));
  };

  const adminCount = users.filter(u => u.role === 'admin').length;

  return (
    <Card>
      <CardHeader className="flex flex-row items-start justify-between gap-4 pb-4">
        <div>
          <CardTitle className="flex items-center gap-2 text-base">
            <ShieldCheck className="h-4 w-4" />
            Benutzer-Verwaltung
          </CardTitle>
          <CardDescription className="mt-1">
            Rollen aller eingeloggten Benutzer anzeigen und ändern.
            {adminCount > 0 && (
              <span className="ml-1 font-medium text-foreground">
                {adminCount} Admin{adminCount > 1 ? 's' : ''} aktiv.
              </span>
            )}
          </CardDescription>
        </div>
        <Button variant="outline" size="sm" onClick={loadUsers} disabled={loading}>
          <RefreshCw className={cn('h-3.5 w-3.5', loading && 'animate-spin')} />
        </Button>
      </CardHeader>

      <CardContent className="space-y-4">

        {/* Migration-Hinweis */}
        {migrationNeeded && (
          <div className="rounded-md border border-amber-200 bg-amber-50 dark:bg-amber-950/20 p-3 flex gap-2 text-sm text-amber-800 dark:text-amber-300">
            <AlertTriangle className="h-4 w-4 flex-shrink-0 mt-0.5" />
            <div>
              <p className="font-semibold">Migration erforderlich</p>
              <p className="text-xs mt-0.5">
                Führe <code className="bg-amber-100 dark:bg-amber-900/40 px-1 rounded">supabase/user_management.sql</code> im Supabase SQL-Editor aus,
                um E-Mail-Anzeige und automatische Rollenvergabe zu aktivieren.
              </p>
            </div>
          </div>
        )}

        {/* Benutzerliste */}
        {loading ? (
          <div className="flex items-center gap-2 py-4 text-muted-foreground text-sm">
            <Loader2 className="h-4 w-4 animate-spin" />
            Benutzer werden geladen …
          </div>
        ) : users.length === 0 ? (
          <p className="text-sm text-muted-foreground py-2">
            Keine Benutzer in user_profiles gefunden. Führe zuerst <code>supabase/user_management.sql</code> aus.
          </p>
        ) : (
          <div className="divide-y divide-border rounded-md border overflow-hidden">
            {users.map(u => {
              const cfg = ROLE_CONFIG[u.role];
              const Icon = cfg.Icon;
              const isEditing = editingId === u.id;

              return (
                <div
                  key={u.id}
                  className={cn(
                    'flex items-center gap-3 px-3 py-2.5 bg-card',
                    u.isSelf && 'bg-muted/30',
                  )}
                >
                  {/* E-Mail */}
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium truncate">
                      {u.email ?? <span className="text-muted-foreground italic">E-Mail unbekannt</span>}
                      {u.isSelf && (
                        <span className="ml-1.5 text-[10px] text-muted-foreground font-normal">(du)</span>
                      )}
                    </p>
                    <p className="text-[10px] text-muted-foreground font-mono">
                      {u.id.slice(0, 8)}…
                    </p>
                  </div>

                  {/* Rolle anzeigen oder bearbeiten */}
                  {isEditing ? (
                    <div className="flex items-center gap-1.5">
                      <Select
                        value={editRole}
                        onValueChange={v => setEditRole(v as UserRole)}
                      >
                        <SelectTrigger className="h-7 text-xs w-[160px]">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="admin">Administrator</SelectItem>
                          <SelectItem value="service_manager">Service-Manager</SelectItem>
                          <SelectItem value="kueche_manager">Küchen-Manager</SelectItem>
                        </SelectContent>
                      </Select>
                      <Button
                        size="sm"
                        className="h-7 w-7 p-0"
                        onClick={() => saveRole(u.id)}
                        disabled={saving}
                      >
                        {saving ? <Loader2 className="h-3 w-3 animate-spin" /> : <Check className="h-3 w-3" />}
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        className="h-7 w-7 p-0"
                        onClick={cancelEdit}
                        disabled={saving}
                      >
                        <X className="h-3 w-3" />
                      </Button>
                    </div>
                  ) : (
                    <div className="flex items-center gap-1.5">
                      <Badge
                        variant="outline"
                        className={cn('text-[11px] gap-1 px-1.5 py-0.5 font-medium', cfg.color)}
                      >
                        <Icon className="h-2.5 w-2.5" />
                        {cfg.label}
                      </Badge>
                      {!u.isSelf && (
                        <Button
                          size="sm"
                          variant="ghost"
                          className="h-6 w-6 p-0 opacity-50 hover:opacity-100"
                          onClick={() => startEdit(u)}
                          title="Rolle ändern"
                        >
                          <Edit2 className="h-3 w-3" />
                        </Button>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}

        {/* Anleitung neuer Benutzer */}
        <div className="rounded-md border border-border bg-muted/30 p-3 space-y-2">
          <div className="flex items-center gap-1.5 text-sm font-semibold">
            <UserPlus className="h-3.5 w-3.5" />
            Neuen Admin-Benutzer anlegen
          </div>
          <ol className="text-xs text-muted-foreground space-y-1 list-decimal list-inside">
            <li>
              <strong>Supabase Dashboard</strong> →{' '}
              <span className="font-mono bg-muted px-1 rounded">Authentication</span> →{' '}
              <span className="font-mono bg-muted px-1 rounded">Users</span> →{' '}
              <span className="font-mono bg-muted px-1 rounded">Add user</span> →{' '}
              <span className="font-mono bg-muted px-1 rounded">Create new user</span>
              <br />
              E-Mail + Passwort eingeben → "Create User"
            </li>
            <li>
              Im Supabase <strong>SQL-Editor</strong> ausführen:
            </li>
          </ol>
          <div className="relative">
            <pre className="text-[10px] bg-background rounded border p-2 overflow-x-auto font-mono">
              {`SELECT set_user_role('admin2@olivbern.ch', 'admin');`}
            </pre>
            <Button
              size="sm"
              variant="ghost"
              className="absolute top-1 right-1 h-5 w-5 p-0 opacity-60 hover:opacity-100"
              onClick={() => copyToClipboard(`SELECT set_user_role('admin2@olivbern.ch', 'admin');`)}
              title="SQL kopieren"
            >
              <Copy className="h-2.5 w-2.5" />
            </Button>
          </div>
          <p className="text-[10px] text-muted-foreground">
            Ersetze <code className="bg-muted px-0.5 rounded">admin2@olivbern.ch</code> durch die gewünschte E-Mail.
            Mögliche Rollen: <code className="bg-muted px-0.5 rounded">admin</code>,{' '}
            <code className="bg-muted px-0.5 rounded">service_manager</code>,{' '}
            <code className="bg-muted px-0.5 rounded">kueche_manager</code>
          </p>
        </div>

      </CardContent>
    </Card>
  );
}
