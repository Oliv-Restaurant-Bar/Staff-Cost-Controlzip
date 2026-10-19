import { useState, useEffect } from 'react';
import { format, parseISO } from 'date-fns';
import { de } from 'date-fns/locale';
import { supabase } from '@/integrations/supabase/client';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Separator } from '@/components/ui/separator';
import { toast } from 'sonner';
import { 
  Mail, 
  Users, 
  Calendar, 
  Clock, 
  Phone, 
  AtSign,
  MessageSquare,
  CheckCircle2,
  XCircle,
  UserPlus,
  AlertTriangle,
  Bell,
  Trash2,
  RefreshCw,
  Loader2,
  Archive,
  ChevronDown
} from 'lucide-react';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { cn } from '@/lib/utils';

interface EmailImportedReservation {
  id: string;
  reservation_number: string | null;
  guest_name: string;
  guest_email: string | null;
  guest_phone: string | null;
  date: string;
  time: string;
  guest_count: number;
  comment: string | null;
  location: string | null;
  source: string;
  is_processed: boolean;
  needs_review: boolean;
  converted_to_group_id: string | null;
  created_at: string;
}

interface EmailImportNotificationsProps {
  onConvertToGroup?: (reservation: EmailImportedReservation) => void;
  onRefresh?: () => void;
}

export const EmailImportNotifications = ({ onConvertToGroup, onRefresh }: EmailImportNotificationsProps) => {
  const [reservations, setReservations] = useState<EmailImportedReservation[]>([]);
  const [processedReservations, setProcessedReservations] = useState<EmailImportedReservation[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [selectedReservation, setSelectedReservation] = useState<EmailImportedReservation | null>(null);
  const [isDetailOpen, setIsDetailOpen] = useState(false);
  const [reImportingId, setReImportingId] = useState<string | null>(null);
  const [showProcessed, setShowProcessed] = useState(false);

  useEffect(() => {
    fetchReservations();
    
    // Subscribe to realtime updates
    const channel = supabase
      .channel('email-imports')
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'email_imported_reservations'
        },
        (payload) => {
          console.log('Realtime update:', payload);
          fetchReservations();
        }
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, []);

  const fetchReservations = async () => {
    try {
      const [unprocessed, processed] = await Promise.all([
        supabase
          .from('email_imported_reservations')
          .select('*')
          .eq('is_processed', false)
          .order('created_at', { ascending: false }),
        supabase
          .from('email_imported_reservations')
          .select('*')
          .eq('is_processed', true)
          .is('converted_to_group_id', null)
          .order('created_at', { ascending: false })
          .limit(20)
      ]);

      if (unprocessed.error) throw unprocessed.error;
      if (processed.error) throw processed.error;

      setReservations((unprocessed.data || []) as EmailImportedReservation[]);
      setProcessedReservations((processed.data || []) as EmailImportedReservation[]);
    } catch (error) {
      console.error('Error fetching email imports:', error);
    } finally {
      setIsLoading(false);
    }
  };

  const markAsProcessed = async (id: string) => {
    try {
      const { error } = await supabase
        .from('email_imported_reservations')
        .update({ is_processed: true })
        .eq('id', id);

      if (error) throw error;

      setReservations(prev => prev.filter(r => r.id !== id));
      toast.success('Reservation als verarbeitet markiert');
      onRefresh?.();
    } catch (error) {
      console.error('Error marking as processed:', error);
      toast.error('Fehler beim Aktualisieren');
    }
  };

  const deleteReservation = async (id: string) => {
    try {
      const { error } = await supabase
        .from('email_imported_reservations')
        .delete()
        .eq('id', id);

      if (error) throw error;

      setReservations(prev => prev.filter(r => r.id !== id));
      toast.success('Reservation gelöscht');
    } catch (error) {
      console.error('Error deleting reservation:', error);
      toast.error('Fehler beim Löschen');
    }
  };

  const handleConvertToGroup = async (reservation: EmailImportedReservation) => {
    onConvertToGroup?.(reservation);
    setIsDetailOpen(false);
  };

  // Re-import/re-parse an email reservation
  const handleReImport = async (reservation: EmailImportedReservation) => {
    setReImportingId(reservation.id);
    try {
      // Fetch the full reservation with raw_email_content
      const { data: fullReservation, error: fetchError } = await supabase
        .from('email_imported_reservations')
        .select('*')
        .eq('id', reservation.id)
        .single();
      
      if (fetchError || !fullReservation) {
        throw new Error('Reservierung nicht gefunden');
      }
      
      if (!fullReservation.raw_email_content) {
        toast.error('Kein E-Mail-Inhalt zum erneuten Parsen vorhanden');
        return;
      }
      
      // Call the parse function with the stored email content
      const { data: parseResult, error: parseError } = await supabase.functions.invoke('parse-reservation-email', {
        body: {
          'body-plain': fullReservation.raw_email_content,
          subject: 'Re-Import',
          from: 'reimport@internal'
        }
      });
      
      if (parseError) throw parseError;
      
      if (parseResult?.parsed) {
        const parsed = parseResult.parsed;
        
        // Update the existing reservation with newly parsed data
        const { error: updateError } = await supabase
          .from('email_imported_reservations')
          .update({
            guest_name: parsed.guest_name,
            guest_count: parsed.guest_count,
            guest_email: parsed.guest_email,
            guest_phone: parsed.guest_phone,
            date: parsed.date,
            time: parsed.time,
            comment: parsed.comment,
            location: parsed.location,
            needs_review: parsed.guest_count >= 10,
            is_processed: false
          })
          .eq('id', reservation.id);
        
        if (updateError) throw updateError;
        
        toast.success(`Reservierung aktualisiert: ${parsed.guest_count} Gäste`);
        fetchReservations();
        onRefresh?.();
      } else {
        toast.error('E-Mail konnte nicht erneut geparst werden');
      }
      
    } catch (error) {
      console.error('Error re-importing:', error);
      toast.error('Fehler beim erneuten Import');
    } finally {
      setReImportingId(null);
    }
  };

  // Determine shift based on time
  const getShift = (time: string): 'mittag' | 'abend' => {
    const hours = parseInt(time.split(':')[0], 10);
    return hours < 15 ? 'mittag' : 'abend';
  };

  const needsReviewCount = reservations.filter(r => r.needs_review).length;
  const normalCount = reservations.filter(r => !r.needs_review).length;

  if (isLoading) {
    return null;
  }

  if (reservations.length === 0) {
    return null;
  }

  return (
    <>
      <Card className="border-amber-200 bg-amber-50/50">
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-base">
            <Bell className="h-4 w-4 text-amber-600" />
            <span>Neue Email-Reservationen</span>
            <Badge variant="secondary" className="ml-auto">
              {reservations.length}
            </Badge>
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          {needsReviewCount > 0 && (
            <div className="flex items-center gap-2 text-sm text-amber-700 bg-amber-100 rounded-md px-3 py-2">
              <AlertTriangle className="h-4 w-4" />
              <span>
                <strong>{needsReviewCount}</strong> Reservation(en) mit 10+ Gästen – als Gruppe qualifizieren?
              </span>
            </div>
          )}

          <ScrollArea className={cn("pr-4", reservations.length > 3 ? "h-[200px]" : "")}>
            <div className="space-y-2">
              {reservations.map(reservation => (
                <div
                  key={reservation.id}
                  className={cn(
                    "flex items-center justify-between gap-3 p-3 rounded-lg border bg-background cursor-pointer hover:bg-muted/50 transition-colors",
                    reservation.needs_review && "border-amber-300 bg-amber-50/50"
                  )}
                  onClick={() => {
                    setSelectedReservation(reservation);
                    setIsDetailOpen(true);
                  }}
                >
                  <div className="flex items-center gap-3 min-w-0 flex-1">
                    <div className={cn(
                      "p-2 rounded-full",
                      reservation.needs_review ? "bg-amber-100" : "bg-muted"
                    )}>
                      <Mail className={cn(
                        "h-4 w-4",
                        reservation.needs_review ? "text-amber-600" : "text-muted-foreground"
                      )} />
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="font-medium truncate">{reservation.guest_name}</span>
                        {reservation.needs_review && (
                          <Badge variant="outline" className="text-amber-700 border-amber-300 bg-amber-50 text-xs">
                            10+ Gäste
                          </Badge>
                        )}
                      </div>
                      <div className="flex items-center gap-2 text-xs text-muted-foreground">
                        <span>{format(parseISO(reservation.date), 'EEE, d. MMM', { locale: de })}</span>
                        <span>•</span>
                        <span>{reservation.time}</span>
                        <span>•</span>
                        <span>{reservation.guest_count} Gäste</span>
                      </div>
                    </div>
                  </div>
                  <div className="flex items-center gap-1">
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-8 w-8"
                      onClick={(e) => {
                        e.stopPropagation();
                        handleReImport(reservation);
                      }}
                      title="Erneut parsen"
                      disabled={reImportingId === reservation.id}
                    >
                      {reImportingId === reservation.id ? (
                        <Loader2 className="h-4 w-4 animate-spin text-blue-500" />
                      ) : (
                        <RefreshCw className="h-4 w-4 text-blue-500" />
                      )}
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-8 w-8"
                      onClick={(e) => {
                        e.stopPropagation();
                        markAsProcessed(reservation.id);
                      }}
                      title="Als verarbeitet markieren"
                    >
                      <CheckCircle2 className="h-4 w-4 text-emerald-500" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-8 w-8"
                      onClick={(e) => {
                        e.stopPropagation();
                        deleteReservation(reservation.id);
                      }}
                      title="Löschen"
                    >
                      <Trash2 className="h-4 w-4 text-destructive" />
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          </ScrollArea>

          {/* Processed Reservations Section */}
          {processedReservations.length > 0 && (
            <Collapsible open={showProcessed} onOpenChange={setShowProcessed} className="mt-4">
              <CollapsibleTrigger className="flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground transition-colors w-full">
                <Archive className="h-4 w-4" />
                <span>Verarbeitete Reservierungen ({processedReservations.length})</span>
                <ChevronDown className={cn("h-4 w-4 ml-auto transition-transform", showProcessed && "rotate-180")} />
              </CollapsibleTrigger>
              <CollapsibleContent className="pt-2">
                <div className="space-y-2">
                  {processedReservations.map(reservation => (
                    <div
                      key={reservation.id}
                      className="flex items-center justify-between gap-3 p-2 rounded-lg border border-muted bg-muted/30"
                    >
                      <div className="flex items-center gap-2 min-w-0 flex-1">
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-2 text-sm">
                            <span className="truncate">{reservation.guest_name}</span>
                            <Badge variant="outline" className="text-xs text-muted-foreground">
                              {reservation.guest_count} Gäste
                            </Badge>
                          </div>
                          <div className="text-xs text-muted-foreground">
                            {format(parseISO(reservation.date), 'EEE, d. MMM', { locale: de })} • {reservation.time}
                          </div>
                        </div>
                      </div>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-7 gap-1 text-blue-600 hover:text-blue-700 hover:bg-blue-100"
                        onClick={() => handleReImport(reservation)}
                        disabled={reImportingId === reservation.id}
                        title="Erneut parsen und wiederherstellen"
                      >
                        {reImportingId === reservation.id ? (
                          <Loader2 className="h-3 w-3 animate-spin" />
                        ) : (
                          <RefreshCw className="h-3 w-3" />
                        )}
                        <span className="text-xs">Re-Import</span>
                      </Button>
                    </div>
                  ))}
                </div>
              </CollapsibleContent>
            </Collapsible>
          )}
        </CardContent>
      </Card>

      {/* Detail Dialog */}
      <Dialog open={isDetailOpen} onOpenChange={setIsDetailOpen}>
        <DialogContent className="max-w-md">
          {selectedReservation && (
            <>
              <DialogHeader>
                <DialogTitle className="flex items-center gap-2">
                  <Mail className="h-5 w-5" />
                  Email-Reservation
                  {selectedReservation.needs_review && (
                    <Badge variant="outline" className="text-amber-700 border-amber-300 bg-amber-50 ml-2">
                      10+ Gäste
                    </Badge>
                  )}
                </DialogTitle>
              </DialogHeader>

              <div className="space-y-4">
                {/* Guest Info */}
                <div className="space-y-3">
                  <div className="flex items-center gap-3">
                    <Users className="h-4 w-4 text-muted-foreground" />
                    <div>
                      <div className="font-medium">{selectedReservation.guest_name}</div>
                      <div className="text-sm text-muted-foreground">
                        {selectedReservation.guest_count} Gäste
                      </div>
                    </div>
                  </div>

                  <div className="flex items-center gap-3">
                    <Calendar className="h-4 w-4 text-muted-foreground" />
                    <span>
                      {format(parseISO(selectedReservation.date), 'EEEE, d. MMMM yyyy', { locale: de })}
                    </span>
                  </div>

                  <div className="flex items-center gap-3">
                    <Clock className="h-4 w-4 text-muted-foreground" />
                    <span>
                      {selectedReservation.time} Uhr
                      <Badge variant="outline" className="ml-2 text-xs">
                        {getShift(selectedReservation.time) === 'mittag' ? 'Mittag' : 'Abend'}
                      </Badge>
                    </span>
                  </div>

                  {selectedReservation.guest_email && (
                    <div className="flex items-center gap-3">
                      <AtSign className="h-4 w-4 text-muted-foreground" />
                      <span className="text-sm">{selectedReservation.guest_email}</span>
                    </div>
                  )}

                  {selectedReservation.guest_phone && (
                    <div className="flex items-center gap-3">
                      <Phone className="h-4 w-4 text-muted-foreground" />
                      <span className="text-sm">{selectedReservation.guest_phone}</span>
                    </div>
                  )}

                  {selectedReservation.reservation_number && (
                    <div className="flex items-center gap-3 text-sm text-muted-foreground">
                      <span>Buchungsnr:</span>
                      <span className="font-mono">{selectedReservation.reservation_number}</span>
                    </div>
                  )}
                </div>

                {selectedReservation.comment && (
                  <>
                    <Separator />
                    <div className="space-y-2">
                      <div className="flex items-center gap-2 text-sm font-medium">
                        <MessageSquare className="h-4 w-4" />
                        Kommentar
                      </div>
                      <p className="text-sm text-muted-foreground bg-muted/50 p-3 rounded-md">
                        {selectedReservation.comment}
                      </p>
                    </div>
                  </>
                )}

                {selectedReservation.needs_review && (
                  <>
                    <Separator />
                    <div className="p-3 bg-amber-50 border border-amber-200 rounded-md">
                      <div className="flex items-start gap-2">
                        <AlertTriangle className="h-4 w-4 text-amber-600 mt-0.5" />
                        <div className="text-sm">
                          <p className="font-medium text-amber-800">Grosse Gruppe erkannt</p>
                          <p className="text-amber-700 mt-1">
                            Diese Reservation hat {selectedReservation.guest_count} Gäste. 
                            Möchten Sie diese als Gruppenreservation (Laufzettel) anlegen?
                          </p>
                        </div>
                      </div>
                    </div>
                  </>
                )}
              </div>

              <DialogFooter className="flex gap-2 sm:gap-0">
                <Button
                  variant="outline"
                  onClick={() => {
                    markAsProcessed(selectedReservation.id);
                    setIsDetailOpen(false);
                  }}
                >
                  <CheckCircle2 className="h-4 w-4 mr-2" />
                  Nur bestätigen
                </Button>
                {selectedReservation.needs_review && (
                  <Button
                    onClick={() => handleConvertToGroup(selectedReservation)}
                  >
                    <UserPlus className="h-4 w-4 mr-2" />
                    Als Gruppe anlegen
                  </Button>
                )}
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
};
