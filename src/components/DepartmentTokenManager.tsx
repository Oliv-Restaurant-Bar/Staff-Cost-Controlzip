import { useState, useEffect } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Switch } from '@/components/ui/switch';
import { 
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow 
} from '@/components/ui/table';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription
} from '@/components/ui/dialog';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, 
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle
} from '@/components/ui/alert-dialog';
import { 
  Key, Plus, Trash2, Copy, ExternalLink, RefreshCw, Building2, 
  Clock, CheckCircle, XCircle, Loader2
} from 'lucide-react';
import { toast } from 'sonner';
import { format } from 'date-fns';
import { de } from 'date-fns/locale';

interface DepartmentToken {
  id: string;
  department: 'service' | 'kueche';
  token: string;
  name: string;
  is_active: boolean;
  created_at: string;
  expires_at: string | null;
  last_used_at: string | null;
  role: 'department' | 'admin';
}

const generateToken = () => {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let token = '';
  for (let i = 0; i < 32; i++) {
    token += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return token;
};

export const DepartmentTokenManager = () => {
  const [tokens, setTokens] = useState<DepartmentToken[]>([]);
  const [loading, setLoading] = useState(true);
  const [createDialogOpen, setCreateDialogOpen] = useState(false);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [tokenToDelete, setTokenToDelete] = useState<DepartmentToken | null>(null);
  
  // New token form
  const [newTokenName, setNewTokenName] = useState('');
  const [newTokenDepartment, setNewTokenDepartment] = useState<'service' | 'kueche'>('service');
  const [newTokenRole, setNewTokenRole] = useState<'department' | 'admin'>('department');
  const [newTokenExpires, setNewTokenExpires] = useState(false);
  const [newTokenExpiryDays, setNewTokenExpiryDays] = useState(30);
  const [creating, setCreating] = useState(false);

  const fetchTokens = async () => {
    try {
      const { data, error } = await supabase
        .from('department_access_tokens')
        .select('*')
        .order('created_at', { ascending: false });
      
      if (error) throw error;
      setTokens((data || []) as DepartmentToken[]);
    } catch (err) {
      console.error('Error fetching tokens:', err);
      toast.error('Fehler beim Laden der Zugangslinks');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchTokens();
  }, []);

  const createToken = async () => {
    if (!newTokenName.trim()) {
      toast.error('Bitte geben Sie einen Namen ein');
      return;
    }

    setCreating(true);
    try {
      const token = generateToken();
      const expiresAt = newTokenExpires 
        ? new Date(Date.now() + newTokenExpiryDays * 24 * 60 * 60 * 1000).toISOString()
        : null;

      const { error } = await supabase
        .from('department_access_tokens')
        .insert({
          department: newTokenDepartment,
          token,
          name: newTokenName.trim(),
          expires_at: expiresAt,
          role: newTokenRole,
        });

      if (error) throw error;

      toast.success('Zugangslink erstellt');
      setCreateDialogOpen(false);
      setNewTokenName('');
      setNewTokenRole('department');
      setNewTokenExpires(false);
      fetchTokens();
    } catch (err) {
      console.error('Error creating token:', err);
      toast.error('Fehler beim Erstellen des Zugangslinks');
    } finally {
      setCreating(false);
    }
  };

  const toggleTokenActive = async (token: DepartmentToken) => {
    try {
      const { error } = await supabase
        .from('department_access_tokens')
        .update({ is_active: !token.is_active })
        .eq('id', token.id);

      if (error) throw error;

      toast.success(token.is_active ? 'Link deaktiviert' : 'Link aktiviert');
      fetchTokens();
    } catch (err) {
      console.error('Error toggling token:', err);
      toast.error('Fehler beim Ändern des Status');
    }
  };

  const deleteToken = async () => {
    if (!tokenToDelete) return;

    try {
      const { error } = await supabase
        .from('department_access_tokens')
        .delete()
        .eq('id', tokenToDelete.id);

      if (error) throw error;

      toast.success('Zugangslink gelöscht');
      setDeleteDialogOpen(false);
      setTokenToDelete(null);
      fetchTokens();
    } catch (err) {
      console.error('Error deleting token:', err);
      toast.error('Fehler beim Löschen');
    }
  };

  const getQuickLink = (token: DepartmentToken) => {
    const baseUrl = window.location.origin;
    return `${baseUrl}/dienstplan/${token.department}?token=${token.token}`;
  };

  const getPlannerLink = (token: DepartmentToken) => {
    const baseUrl = window.location.origin;
    return `${baseUrl}/plan/${token.department}?token=${token.token}`;
  };

  // Default link is now the planner (full access)
  const getLink = getPlannerLink;

  const copyLink = (token: DepartmentToken, linkType: 'quick' | 'planner' = 'planner') => {
    const link = linkType === 'quick' ? getQuickLink(token) : getPlannerLink(token);
    navigator.clipboard.writeText(link);
    toast.success(`${linkType === 'quick' ? 'Schnell-' : 'Planer-'}Link kopiert`);
  };

  const openLink = (token: DepartmentToken, linkType: 'quick' | 'planner' = 'planner') => {
    const link = linkType === 'quick' ? getQuickLink(token) : getPlannerLink(token);
    window.location.href = link;
  };

  const getDepartmentLabel = (dept: string) => dept === 'service' ? 'Service' : 'Küche';
  const getDepartmentColor = (dept: string) => 
    dept === 'service' ? 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400' 
                       : 'bg-orange-100 text-orange-700 dark:bg-orange-900/30 dark:text-orange-400';
  const getRoleLabel = (role: string) => role === 'admin' ? 'Admin (alle Abteilungen)' : 'Abteilungsleiter';
  const getRoleColor = (role: string) => 
    role === 'admin' ? 'bg-purple-100 text-purple-700 dark:bg-purple-900/30 dark:text-purple-400' 
                     : 'bg-gray-100 text-gray-700 dark:bg-gray-900/30 dark:text-gray-400';

  if (loading) {
    return (
      <Card>
        <CardContent className="flex items-center justify-center py-8">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </CardContent>
      </Card>
    );
  }

  return (
    <>
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <Key className="h-5 w-5 text-primary" />
              <div>
                <CardTitle>Abteilungsleiter-Zugang</CardTitle>
                <CardDescription>
                  Erstellen Sie Direktlinks für Service- und Küchenleiter
                </CardDescription>
              </div>
            </div>
            <Button onClick={() => setCreateDialogOpen(true)} size="sm" className="gap-2">
              <Plus className="h-4 w-4" />
              Neuer Link
            </Button>
          </div>
        </CardHeader>
        <CardContent>
          {tokens.length === 0 ? (
            <div className="text-center py-8 text-muted-foreground">
              <Key className="h-12 w-12 mx-auto mb-4 opacity-50" />
              <p>Keine Zugangslinks vorhanden</p>
              <p className="text-sm">Erstellen Sie einen Link für Ihre Abteilungsleiter</p>
            </div>
          ) : (
            <>
              {/* Mobile-friendly list (actions are often off-screen in tables) */}
              <div className="space-y-3 md:hidden">
                {tokens.map((token) => {
                  const isExpired = token.expires_at && new Date(token.expires_at) < new Date();
                  const link = getLink(token);

                  return (
                    <Card key={token.id} className="p-3">
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <div className="font-medium truncate">{token.name}</div>
                          <div className="mt-1 flex flex-wrap items-center gap-2">
                            {token.role === 'admin' ? (
                              <Badge variant="outline" className={getRoleColor('admin')}>
                                <Key className="h-3 w-3 mr-1" />
                                Admin
                              </Badge>
                            ) : (
                              <Badge variant="outline" className={getDepartmentColor(token.department)}>
                                <Building2 className="h-3 w-3 mr-1" />
                                {getDepartmentLabel(token.department)}
                              </Badge>
                            )}
                            {isExpired ? (
                              <Badge variant="destructive" className="text-xs">Abgelaufen</Badge>
                            ) : token.is_active ? (
                              <Badge variant="outline" className="bg-green-50 text-green-700 dark:bg-green-900/20 dark:text-green-400 text-xs">
                                <CheckCircle className="h-3 w-3 mr-1" />
                                Aktiv
                              </Badge>
                            ) : (
                              <Badge variant="outline" className="text-xs">
                                <XCircle className="h-3 w-3 mr-1" />
                                Inaktiv
                              </Badge>
                            )}
                          </div>
                        </div>

                        <div className="flex items-center gap-2">
                          <Switch
                            checked={token.is_active && !isExpired}
                            onCheckedChange={() => toggleTokenActive(token)}
                            disabled={isExpired}
                          />
                        </div>
                      </div>

                      <div className="mt-3 space-y-3">
                        <div className="space-y-1">
                          <Label className="text-xs text-muted-foreground font-medium">📋 Vollständiger Planer (empfohlen)</Label>
                          <Input
                            readOnly
                            value={getPlannerLink(token)}
                            onFocus={(e) => e.currentTarget.select()}
                            className="text-xs"
                          />
                          <div className="grid grid-cols-2 gap-2">
                            <Button variant="outline" size="sm" onClick={() => copyLink(token, 'planner')} className="gap-1 text-xs">
                              <Copy className="h-3 w-3" />
                              Kopieren
                            </Button>
                            <Button size="sm" onClick={() => openLink(token, 'planner')} className="gap-1 text-xs">
                              <ExternalLink className="h-3 w-3" />
                              Öffnen
                            </Button>
                          </div>
                        </div>
                        
                        <div className="space-y-1 pt-2 border-t">
                          <Label className="text-xs text-muted-foreground">⚡ Schnellansicht</Label>
                          <div className="grid grid-cols-2 gap-2">
                            <Button variant="ghost" size="sm" onClick={() => copyLink(token, 'quick')} className="gap-1 text-xs h-7">
                              <Copy className="h-3 w-3" />
                              Schnell-Link
                            </Button>
                            <Button variant="ghost" size="sm" onClick={() => openLink(token, 'quick')} className="gap-1 text-xs h-7">
                              <ExternalLink className="h-3 w-3" />
                              Öffnen
                            </Button>
                          </div>
                        </div>

                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => { setTokenToDelete(token); setDeleteDialogOpen(true); }}
                          className="w-full text-destructive hover:text-destructive mt-2"
                        >
                          <Trash2 className="h-4 w-4 mr-2" />
                          Link löschen
                        </Button>
                      </div>
                    </Card>
                  );
                })}
              </div>

              {/* Desktop table */}
              <div className="hidden md:block">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Name</TableHead>
                      <TableHead>Abteilung</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead className="hidden md:table-cell">Zuletzt verwendet</TableHead>
                      <TableHead className="hidden md:table-cell">Gültig bis</TableHead>
                      <TableHead className="text-right">Aktionen</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {tokens.map(token => {
                      const isExpired = token.expires_at && new Date(token.expires_at) < new Date();
                      return (
                        <TableRow key={token.id}>
                          <TableCell className="font-medium">{token.name}</TableCell>
                          <TableCell>
                            {token.role === 'admin' ? (
                              <Badge variant="outline" className={getRoleColor('admin')}>
                                <Key className="h-3 w-3 mr-1" />
                                Admin
                              </Badge>
                            ) : (
                              <Badge variant="outline" className={getDepartmentColor(token.department)}>
                                <Building2 className="h-3 w-3 mr-1" />
                                {getDepartmentLabel(token.department)}
                              </Badge>
                            )}
                          </TableCell>
                          <TableCell>
                            <div className="flex items-center gap-2">
                              <Switch
                                checked={token.is_active && !isExpired}
                                onCheckedChange={() => toggleTokenActive(token)}
                                disabled={isExpired}
                              />
                              {isExpired ? (
                                <Badge variant="destructive" className="text-xs">Abgelaufen</Badge>
                              ) : token.is_active ? (
                                <Badge variant="outline" className="bg-green-50 text-green-700 dark:bg-green-900/20 dark:text-green-400 text-xs">
                                  <CheckCircle className="h-3 w-3 mr-1" />
                                  Aktiv
                                </Badge>
                              ) : (
                                <Badge variant="outline" className="text-xs">
                                  <XCircle className="h-3 w-3 mr-1" />
                                  Inaktiv
                                </Badge>
                              )}
                            </div>
                          </TableCell>
                          <TableCell className="hidden md:table-cell text-muted-foreground text-sm">
                            {token.last_used_at ? (
                              <span className="flex items-center gap-1">
                                <Clock className="h-3 w-3" />
                                {format(new Date(token.last_used_at), 'dd.MM.yy HH:mm', { locale: de })}
                              </span>
                            ) : (
                              <span className="text-muted-foreground/50">Nie</span>
                            )}
                          </TableCell>
                          <TableCell className="hidden md:table-cell text-muted-foreground text-sm">
                            {token.expires_at ? (
                              format(new Date(token.expires_at), 'dd.MM.yyyy', { locale: de })
                            ) : (
                              <span className="text-muted-foreground/50">Unbegrenzt</span>
                            )}
                          </TableCell>
                          <TableCell className="text-right">
                            <div className="flex items-center justify-end gap-1">
                              <Button
                                variant="ghost"
                                size="sm"
                                onClick={() => copyLink(token)}
                                title="Link kopieren"
                              >
                                <Copy className="h-4 w-4" />
                              </Button>
                              <Button
                                variant="ghost"
                                size="sm"
                                onClick={() => openLink(token)}
                                title="Link öffnen"
                              >
                                <ExternalLink className="h-4 w-4" />
                              </Button>
                              <Button
                                variant="ghost"
                                size="sm"
                                onClick={() => { setTokenToDelete(token); setDeleteDialogOpen(true); }}
                                className="text-destructive hover:text-destructive"
                                title="Löschen"
                              >
                                <Trash2 className="h-4 w-4" />
                              </Button>
                            </div>
                          </TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
              </div>
            </>
          )}
        </CardContent>
      </Card>

      {/* Create Token Dialog */}
      <Dialog open={createDialogOpen} onOpenChange={setCreateDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Neuen Zugangslink erstellen</DialogTitle>
            <DialogDescription>
              Erstellen Sie einen Direktlink für einen Abteilungsleiter.
            </DialogDescription>
          </DialogHeader>
          
          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <Label htmlFor="token-name">Name / Beschreibung</Label>
              <Input
                id="token-name"
                placeholder="z.B. Serviceleiter Max Mustermann"
                value={newTokenName}
                onChange={(e) => setNewTokenName(e.target.value)}
              />
            </div>

            <div className="space-y-2">
              <Label>Berechtigungsstufe</Label>
              <div className="flex gap-2">
                <Button
                  type="button"
                  variant={newTokenRole === 'department' ? 'default' : 'outline'}
                  onClick={() => setNewTokenRole('department')}
                  className="flex-1"
                >
                  <Building2 className="h-4 w-4 mr-2" />
                  Abteilung
                </Button>
                <Button
                  type="button"
                  variant={newTokenRole === 'admin' ? 'default' : 'outline'}
                  onClick={() => setNewTokenRole('admin')}
                  className="flex-1"
                >
                  <Key className="h-4 w-4 mr-2" />
                  Admin
                </Button>
              </div>
              <p className="text-xs text-muted-foreground">
                {newTokenRole === 'admin' 
                  ? 'Admin kann alle Abteilungen bearbeiten und Mitarbeiter verwalten'
                  : 'Nur die gewählte Abteilung bearbeiten'
                }
              </p>
            </div>

            {newTokenRole === 'department' && (
              <div className="space-y-2">
                <Label>Abteilung</Label>
                <div className="flex gap-2">
                  <Button
                    type="button"
                    variant={newTokenDepartment === 'service' ? 'default' : 'outline'}
                    onClick={() => setNewTokenDepartment('service')}
                    className="flex-1"
                  >
                    <Building2 className="h-4 w-4 mr-2" />
                    Service
                  </Button>
                  <Button
                    type="button"
                    variant={newTokenDepartment === 'kueche' ? 'default' : 'outline'}
                    onClick={() => setNewTokenDepartment('kueche')}
                    className="flex-1"
                  >
                    <Building2 className="h-4 w-4 mr-2" />
                    Küche
                  </Button>
                </div>
              </div>
            )}

            <div className="flex items-center justify-between">
              <div className="space-y-0.5">
                <Label>Ablaufdatum setzen</Label>
                <p className="text-xs text-muted-foreground">
                  Link läuft nach einer bestimmten Zeit ab
                </p>
              </div>
              <Switch
                checked={newTokenExpires}
                onCheckedChange={setNewTokenExpires}
              />
            </div>

            {newTokenExpires && (
              <div className="space-y-2">
                <Label htmlFor="expiry-days">Gültig für (Tage)</Label>
                <Input
                  id="expiry-days"
                  type="number"
                  min={1}
                  max={365}
                  value={newTokenExpiryDays}
                  onChange={(e) => setNewTokenExpiryDays(Number(e.target.value))}
                />
              </div>
            )}
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setCreateDialogOpen(false)}>
              Abbrechen
            </Button>
            <Button onClick={createToken} disabled={creating}>
              {creating && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
              Erstellen
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete Confirmation */}
      <AlertDialog open={deleteDialogOpen} onOpenChange={setDeleteDialogOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Zugangslink löschen?</AlertDialogTitle>
            <AlertDialogDescription>
              Der Link "{tokenToDelete?.name}" wird unwiderruflich gelöscht. 
              Der Abteilungsleiter verliert sofort den Zugang.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Abbrechen</AlertDialogCancel>
            <AlertDialogAction onClick={deleteToken} className="bg-destructive text-destructive-foreground">
              Löschen
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
};
