import { useState, useEffect } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import { Textarea } from "@/components/ui/textarea";
import { toast } from "sonner";
import { Key, Copy, Trash2, Plus, RefreshCw, Eye, EyeOff, FileUp, Globe, Play, CheckCircle, XCircle, Loader2 } from "lucide-react";
import { format } from "date-fns";
import { de } from "date-fns/locale";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";

interface ApiKey {
  id: string;
  api_key: string;
  api_key_name: string;
  is_active: boolean;
  created_at: string;
  last_used_at: string | null;
  request_count: number;
}

interface ImportLog {
  id: string;
  source_system: string | null;
  import_type: string;
  reservations_count: number;
  success_count: number;
  error_count: number;
  created_at: string;
}

interface TestResult {
  success: boolean;
  status: number;
  message: string;
  details?: unknown;
}

// Generate a secure random API key
function generateApiKey(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let result = 'evt_';
  for (let i = 0; i < 32; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
}

// Generate example test payload
function generateTestPayload(): string {
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  const dateStr = tomorrow.toISOString().split('T')[0];
  
  return JSON.stringify({
    source_system: "API-Test",
    reservations: [
      {
        external_id: `TEST-${Date.now()}`,
        guest_name: "Test Reservierung",
        date: dateStr,
        time: "19:00",
        guest_count: 4,
        guest_email: "test@example.com",
        comment: "Dies ist eine Test-Reservierung",
        is_confirmed: true
      }
    ]
  }, null, 2);
}

export function ExternalApiSettings() {
  const [apiKeys, setApiKeys] = useState<ApiKey[]>([]);
  const [importLogs, setImportLogs] = useState<ImportLog[]>([]);
  const [loading, setLoading] = useState(true);
  const [showNewKeyDialog, setShowNewKeyDialog] = useState(false);
  const [newKeyName, setNewKeyName] = useState("");
  const [creatingKey, setCreatingKey] = useState(false);
  const [visibleKeys, setVisibleKeys] = useState<Set<string>>(new Set());
  
  // Test dialog state
  const [showTestDialog, setShowTestDialog] = useState(false);
  const [selectedTestKey, setSelectedTestKey] = useState<ApiKey | null>(null);
  const [testPayload, setTestPayload] = useState(generateTestPayload());
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<TestResult | null>(null);

  const fetchData = async () => {
    setLoading(true);
    try {
      const [keysRes, logsRes] = await Promise.all([
        supabase.from('external_api_settings').select('*').order('created_at', { ascending: false }),
        supabase.from('external_api_import_log').select('*').order('created_at', { ascending: false }).limit(50)
      ]);

      if (keysRes.data) setApiKeys(keysRes.data);
      if (logsRes.data) setImportLogs(logsRes.data);
    } catch (error) {
      console.error('Error fetching API settings:', error);
      toast.error('Fehler beim Laden der API-Einstellungen');
    }
    setLoading(false);
  };

  useEffect(() => {
    fetchData();
  }, []);

  const createApiKey = async () => {
    if (!newKeyName.trim()) {
      toast.error('Bitte einen Namen für den API-Key eingeben');
      return;
    }

    setCreatingKey(true);
    try {
      const newKey = generateApiKey();
      const { error } = await supabase
        .from('external_api_settings')
        .insert({
          api_key: newKey,
          api_key_name: newKeyName.trim()
        });

      if (error) throw error;

      toast.success('API-Key erstellt');
      setShowNewKeyDialog(false);
      setNewKeyName("");
      fetchData();
    } catch (error) {
      console.error('Error creating API key:', error);
      toast.error('Fehler beim Erstellen des API-Keys');
    }
    setCreatingKey(false);
  };

  const toggleKeyActive = async (id: string, isActive: boolean) => {
    try {
      const { error } = await supabase
        .from('external_api_settings')
        .update({ is_active: !isActive })
        .eq('id', id);

      if (error) throw error;
      
      setApiKeys(prev => prev.map(k => k.id === id ? { ...k, is_active: !isActive } : k));
      toast.success(isActive ? 'API-Key deaktiviert' : 'API-Key aktiviert');
    } catch (error) {
      toast.error('Fehler beim Aktualisieren');
    }
  };

  const deleteApiKey = async (id: string) => {
    if (!confirm('API-Key wirklich löschen? Bestehende Integrationen funktionieren dann nicht mehr.')) {
      return;
    }

    try {
      const { error } = await supabase
        .from('external_api_settings')
        .delete()
        .eq('id', id);

      if (error) throw error;
      
      setApiKeys(prev => prev.filter(k => k.id !== id));
      toast.success('API-Key gelöscht');
    } catch (error) {
      toast.error('Fehler beim Löschen');
    }
  };

  const copyToClipboard = (text: string) => {
    navigator.clipboard.writeText(text);
    toast.success('In Zwischenablage kopiert');
  };

  const toggleKeyVisibility = (id: string) => {
    setVisibleKeys(prev => {
      const newSet = new Set(prev);
      if (newSet.has(id)) {
        newSet.delete(id);
      } else {
        newSet.add(id);
      }
      return newSet;
    });
  };

  const maskApiKey = (key: string) => {
    return key.substring(0, 8) + '••••••••••••••••••••••••';
  };

  const openTestDialog = (key: ApiKey) => {
    setSelectedTestKey(key);
    setTestPayload(generateTestPayload());
    setTestResult(null);
    setShowTestDialog(true);
  };

  const runApiTest = async () => {
    if (!selectedTestKey) return;
    
    setTesting(true);
    setTestResult(null);
    
    try {
      // Validate JSON
      let parsedPayload;
      try {
        parsedPayload = JSON.parse(testPayload);
      } catch {
        setTestResult({
          success: false,
          status: 0,
          message: 'Ungültiges JSON-Format',
          details: 'Bitte überprüfen Sie die Syntax des Payloads.'
        });
        setTesting(false);
        return;
      }
      
      const response = await fetch(endpointUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': selectedTestKey.api_key
        },
        body: JSON.stringify(parsedPayload)
      });
      
      const data = await response.json();
      
      setTestResult({
        success: response.ok,
        status: response.status,
        message: response.ok ? 'API-Anfrage erfolgreich!' : `Fehler: ${data.error || 'Unbekannter Fehler'}`,
        details: data
      });
      
      if (response.ok) {
        // Refresh data to show new import log
        fetchData();
      }
    } catch (error) {
      setTestResult({
        success: false,
        status: 0,
        message: 'Netzwerkfehler',
        details: error instanceof Error ? error.message : 'Verbindung fehlgeschlagen'
      });
    }
    
    setTesting(false);
  };

  const projectUrl = import.meta.env.VITE_SUPABASE_URL?.replace('.supabase.co', '') || '';
  const endpointUrl = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/import-reservations`;

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Globe className="h-5 w-5" />
            Externe API-Schnittstelle
          </CardTitle>
          <CardDescription>
            Ermöglicht Drittanbietern, bestätigte Reservierungen per API zu importieren
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          {/* Endpoint Info */}
          <div className="rounded-lg border bg-muted/50 p-4 space-y-3">
            <h4 className="font-medium text-sm">API Endpoint</h4>
            <div className="flex items-center gap-2">
              <code className="flex-1 text-xs bg-background p-2 rounded border overflow-x-auto">
                POST {endpointUrl}
              </code>
              <Button
                variant="outline"
                size="icon"
                onClick={() => copyToClipboard(endpointUrl)}
              >
                <Copy className="h-4 w-4" />
              </Button>
            </div>
            
            <Accordion type="single" collapsible className="w-full">
              <AccordionItem value="docs" className="border-none">
                <AccordionTrigger className="text-sm py-2">
                  API Dokumentation anzeigen
                </AccordionTrigger>
                <AccordionContent>
                  <div className="space-y-4 text-sm">
                    <div>
                      <h5 className="font-medium mb-1">Header</h5>
                      <code className="block bg-background p-2 rounded border text-xs">
                        x-api-key: evt_xxxxxxxxxxxxxxxxxxxxxxxxxx
                      </code>
                    </div>
                    
                    <div>
                      <h5 className="font-medium mb-1">Request Body (JSON)</h5>
                      <pre className="bg-background p-2 rounded border text-xs overflow-x-auto">
{`{
  "source_system": "Restaurant-System XY",
  "reservations": [
    {
      "external_id": "RES-12345",
      "guest_name": "Max Mustermann",
      "date": "2026-02-15",
      "time": "19:00",
      "guest_count": 8,
      "guest_email": "max@example.com",
      "guest_phone": "+49 123 456789",
      "comment": "Fensterplatz gewünscht",
      "location": "Terrasse",
      "menu_selection": "Menü A",
      "is_confirmed": true
    }
  ]
}`}
                      </pre>
                    </div>

                    <div>
                      <h5 className="font-medium mb-1">Pflichtfelder</h5>
                      <ul className="list-disc list-inside text-muted-foreground">
                        <li><code>guest_name</code> - Name des Gastes</li>
                        <li><code>date</code> - Datum (YYYY-MM-DD)</li>
                        <li><code>time</code> - Uhrzeit (HH:MM)</li>
                        <li><code>guest_count</code> - Anzahl Gäste (1-500)</li>
                      </ul>
                    </div>

                    <div>
                      <h5 className="font-medium mb-1">Optionale Felder</h5>
                      <ul className="list-disc list-inside text-muted-foreground">
                        <li><code>external_id</code> - Eindeutige ID für Updates</li>
                        <li><code>guest_email</code>, <code>guest_phone</code> - Kontaktdaten</li>
                        <li><code>comment</code> - Bemerkungen</li>
                        <li><code>location</code> - Tisch/Bereich</li>
                        <li><code>menu_selection</code> - Menüauswahl</li>
                        <li><code>is_confirmed</code> - Bestätigt (default: true)</li>
                      </ul>
                    </div>
                  </div>
                </AccordionContent>
              </AccordionItem>
            </Accordion>
          </div>

          {/* API Keys */}
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <h4 className="font-medium flex items-center gap-2">
                <Key className="h-4 w-4" />
                API-Keys
              </h4>
              <Button size="sm" onClick={() => setShowNewKeyDialog(true)}>
                <Plus className="h-4 w-4 mr-1" />
                Neuer Key
              </Button>
            </div>

            {loading ? (
              <div className="text-center py-4 text-muted-foreground">Laden...</div>
            ) : apiKeys.length === 0 ? (
              <div className="text-center py-6 text-muted-foreground border rounded-lg">
                Noch keine API-Keys erstellt
              </div>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Name</TableHead>
                    <TableHead>Key</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Anfragen</TableHead>
                    <TableHead>Zuletzt verwendet</TableHead>
                    <TableHead className="w-[100px]"></TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {apiKeys.map(key => (
                    <TableRow key={key.id}>
                      <TableCell className="font-medium">{key.api_key_name}</TableCell>
                      <TableCell>
                        <div className="flex items-center gap-1">
                          <code className="text-xs">
                            {visibleKeys.has(key.id) ? key.api_key : maskApiKey(key.api_key)}
                          </code>
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-6 w-6"
                            onClick={() => toggleKeyVisibility(key.id)}
                          >
                            {visibleKeys.has(key.id) ? (
                              <EyeOff className="h-3 w-3" />
                            ) : (
                              <Eye className="h-3 w-3" />
                            )}
                          </Button>
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-6 w-6"
                            onClick={() => copyToClipboard(key.api_key)}
                          >
                            <Copy className="h-3 w-3" />
                          </Button>
                        </div>
                      </TableCell>
                      <TableCell>
                        <Switch
                          checked={key.is_active}
                          onCheckedChange={() => toggleKeyActive(key.id, key.is_active)}
                        />
                      </TableCell>
                      <TableCell>{key.request_count}</TableCell>
                      <TableCell>
                        {key.last_used_at 
                          ? format(new Date(key.last_used_at), 'dd.MM.yyyy HH:mm', { locale: de })
                          : '-'
                        }
                      </TableCell>
                        <TableCell>
                          <div className="flex items-center gap-1">
                            <Button
                              variant="ghost"
                              size="icon"
                              className="h-8 w-8"
                              onClick={() => openTestDialog(key)}
                              title="API testen"
                              disabled={!key.is_active}
                            >
                              <Play className="h-4 w-4" />
                            </Button>
                            <Button
                              variant="ghost"
                              size="icon"
                              className="h-8 w-8 text-destructive"
                              onClick={() => deleteApiKey(key.id)}
                            >
                              <Trash2 className="h-4 w-4" />
                            </Button>
                          </div>
                        </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </div>

          {/* Import Logs */}
          {importLogs.length > 0 && (
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <h4 className="font-medium flex items-center gap-2">
                  <FileUp className="h-4 w-4" />
                  Import-Protokoll
                </h4>
                <Button variant="ghost" size="sm" onClick={fetchData}>
                  <RefreshCw className="h-4 w-4" />
                </Button>
              </div>

              <div className="border rounded-lg max-h-[300px] overflow-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Zeitpunkt</TableHead>
                      <TableHead>Typ</TableHead>
                      <TableHead>Quelle</TableHead>
                      <TableHead>Gesamt</TableHead>
                      <TableHead>Erfolgreich</TableHead>
                      <TableHead>Fehler</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {importLogs.map(log => (
                      <TableRow key={log.id}>
                        <TableCell className="text-xs">
                          {format(new Date(log.created_at), 'dd.MM.yyyy HH:mm', { locale: de })}
                        </TableCell>
                        <TableCell>
                          <Badge variant={log.import_type === 'api' ? 'default' : 'secondary'}>
                            {log.import_type === 'api' ? 'API' : 'Datei'}
                          </Badge>
                        </TableCell>
                        <TableCell className="text-xs">{log.source_system || '-'}</TableCell>
                        <TableCell>{log.reservations_count}</TableCell>
                        <TableCell className="text-green-600">{log.success_count}</TableCell>
                        <TableCell className="text-red-600">{log.error_count}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      {/* New Key Dialog */}
      <Dialog open={showNewKeyDialog} onOpenChange={setShowNewKeyDialog}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Neuen API-Key erstellen</DialogTitle>
            <DialogDescription>
              Geben Sie einen Namen für den neuen API-Key ein, um ihn später identifizieren zu können.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <Label htmlFor="keyName">Name</Label>
              <Input
                id="keyName"
                placeholder="z.B. Restaurant-System, Booking-Tool"
                value={newKeyName}
                onChange={e => setNewKeyName(e.target.value)}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowNewKeyDialog(false)}>
              Abbrechen
            </Button>
            <Button onClick={createApiKey} disabled={creatingKey}>
              {creatingKey ? 'Erstelle...' : 'Erstellen'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Test API Dialog */}
      <Dialog open={showTestDialog} onOpenChange={setShowTestDialog}>
        <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Play className="h-5 w-5" />
              API-Test: {selectedTestKey?.api_key_name}
            </DialogTitle>
            <DialogDescription>
              Senden Sie eine Test-Anfrage an den API-Endpoint, um die Integration zu überprüfen.
            </DialogDescription>
          </DialogHeader>
          
          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <Label>Endpoint</Label>
              <div className="flex items-center gap-2">
                <code className="flex-1 text-xs bg-muted p-2 rounded border overflow-x-auto">
                  POST {endpointUrl}
                </code>
              </div>
            </div>
            
            <div className="space-y-2">
              <Label htmlFor="testPayload">Request Body (JSON)</Label>
              <Textarea
                id="testPayload"
                value={testPayload}
                onChange={e => setTestPayload(e.target.value)}
                className="font-mono text-xs min-h-[200px]"
                placeholder="JSON Payload eingeben..."
              />
              <Button 
                variant="outline" 
                size="sm"
                onClick={() => setTestPayload(generateTestPayload())}
              >
                <RefreshCw className="h-3 w-3 mr-1" />
                Beispiel-Payload generieren
              </Button>
            </div>
            
            {testResult && (
              <Alert variant={testResult.success ? "default" : "destructive"}>
                {testResult.success ? (
                  <CheckCircle className="h-4 w-4" />
                ) : (
                  <XCircle className="h-4 w-4" />
                )}
                <AlertTitle className="flex items-center gap-2">
                  {testResult.success ? 'Erfolgreich' : 'Fehlgeschlagen'}
                  <Badge variant={testResult.success ? "default" : "destructive"}>
                    Status: {testResult.status}
                  </Badge>
                </AlertTitle>
                <AlertDescription className="mt-2">
                  <p>{testResult.message}</p>
                  {testResult.details && (
                    <pre className="mt-2 text-xs bg-background/50 p-2 rounded overflow-x-auto max-h-[150px]">
                      {JSON.stringify(testResult.details, null, 2)}
                    </pre>
                  )}
                </AlertDescription>
              </Alert>
            )}
          </div>
          
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowTestDialog(false)}>
              Schließen
            </Button>
            <Button onClick={runApiTest} disabled={testing}>
              {testing ? (
                <>
                  <Loader2 className="h-4 w-4 mr-1 animate-spin" />
                  Teste...
                </>
              ) : (
                <>
                  <Play className="h-4 w-4 mr-1" />
                  Test ausführen
                </>
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
