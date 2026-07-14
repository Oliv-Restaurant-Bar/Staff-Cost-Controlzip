import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Clock, Calendar, CheckCircle, Info } from 'lucide-react';

interface CronJobConfig {
  name: string;
  schedule: string;
  description: string;
  details: string;
  active: boolean;
}

const parseSchedule = (schedule: string): string => {
  // Parse cron expression into human readable format
  const parts = schedule.split(' ');
  if (parts.length !== 5) return schedule;

  const [minute, hour, dayMonth, month, dayWeek] = parts;

  // Common patterns
  if (schedule === '* * * * *') return 'Jede Minute';
  if (schedule === '0 * * * *') return 'Stündlich';
  if (schedule === '0 0 * * *') return 'Täglich um Mitternacht';
  
  // Weekly on specific day
  if (dayWeek !== '*' && dayMonth === '*') {
    const days = ['Sonntag', 'Montag', 'Dienstag', 'Mittwoch', 'Donnerstag', 'Freitag', 'Samstag'];
    const dayName = days[parseInt(dayWeek)] || dayWeek;
    return `${dayName}s um ${hour}:${minute.padStart(2, '0')} Uhr`;
  }

  // Daily at specific time
  if (dayMonth === '*' && dayWeek === '*' && month === '*') {
    return `Täglich um ${hour}:${minute.padStart(2, '0')} Uhr`;
  }

  return schedule;
};

// Known cron jobs configured in the system
const configuredJobs: CronJobConfig[] = [
  {
    name: 'weekly-event-notifications',
    schedule: '0 7 * * 1',
    description: 'Wöchentliche Event-Benachrichtigungen',
    details: 'Sendet jeden Montag um 7:00 Uhr eine Übersicht aller Events der kommenden Woche an die konfigurierten E-Mail-Empfänger.',
    active: true
  }
];

export const CronJobOverview = () => {
  return (
    <Card>
      <CardHeader className="py-4">
        <CardTitle className="text-lg flex items-center gap-2">
          <Clock className="h-5 w-5" />
          Geplante Aufgaben (Cron-Jobs)
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="border rounded-lg overflow-hidden">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Aufgabe</TableHead>
                <TableHead>Zeitplan</TableHead>
                <TableHead className="text-center">Status</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {configuredJobs.map((job, index) => (
                <TableRow key={index}>
                  <TableCell>
                    <div>
                      <div className="font-medium">{job.description}</div>
                      <div className="text-xs text-muted-foreground mt-1 font-mono">
                        {job.name}
                      </div>
                    </div>
                  </TableCell>
                  <TableCell>
                    <div className="flex items-center gap-2">
                      <Calendar className="h-4 w-4 text-primary" />
                      <div>
                        <div className="font-medium">{parseSchedule(job.schedule)}</div>
                        <div className="text-xs text-muted-foreground font-mono">
                          {job.schedule}
                        </div>
                      </div>
                    </div>
                  </TableCell>
                  <TableCell className="text-center">
                    {job.active ? (
                      <Badge className="bg-green-500/10 text-green-600 border-green-500/20 gap-1">
                        <CheckCircle className="h-3 w-3" />
                        Aktiv
                      </Badge>
                    ) : (
                      <Badge variant="secondary" className="gap-1">
                        Inaktiv
                      </Badge>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>

        {/* Detailed info */}
        <div className="space-y-3">
          {configuredJobs.map((job, index) => (
            <div key={index} className="p-3 bg-muted/30 rounded-lg border text-sm">
              <div className="flex items-center gap-2 mb-2">
                <Info className="h-4 w-4 text-primary" />
                <span className="font-medium">{job.description}</span>
              </div>
              <p className="text-muted-foreground">{job.details}</p>
            </div>
          ))}
        </div>

        {/* Legend */}
        <div className="pt-4 border-t text-xs text-muted-foreground space-y-1">
          <p><strong>Cron-Syntax:</strong> Minute Stunde Tag Monat Wochentag</p>
          <p><strong>Beispiele:</strong></p>
          <ul className="list-disc list-inside pl-2 space-y-1">
            <li><code className="bg-muted px-1 rounded">0 7 * * 1</code> = Jeden Montag um 7:00 Uhr</li>
            <li><code className="bg-muted px-1 rounded">0 8 * * *</code> = Täglich um 8:00 Uhr</li>
            <li><code className="bg-muted px-1 rounded">*/30 * * * *</code> = Alle 30 Minuten</li>
          </ul>
        </div>
      </CardContent>
    </Card>
  );
};
