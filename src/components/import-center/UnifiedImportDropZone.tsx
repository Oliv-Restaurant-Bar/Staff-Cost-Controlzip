/**
 * UnifiedImportDropZone — one drop area for all imports on /import.
 * ================================================================
 * Recognises every dropped file (classifier) and hands it to the EXISTING import flow, which still shows its own
 * preview and asks for confirmation. This component never saves anything.
 *
 * The list lives in `queue-store` (module level) so it survives the route change when a flow is a separate page.
 * UI strings are German (client-visible); comments are English.
 */

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { useNavigate } from 'react-router-dom';
import { toast } from 'sonner';
import { AlertTriangle, CheckCircle2, FileQuestion, FileText, Loader2, ShieldOff, Upload, X, ArrowRight } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { cn } from '@/lib/utils';
import { usePermissions } from '@/hooks/usePermissions';
import { useTenant } from '@/contexts/TenantContext';
import { IMPORT_SECTION_OPEN_EVENT } from '@/components/import-center/ImportGroupCards';
import { classifyProbe } from '@/lib/unified-import/classify';
import { extensionOf, readFileProbe } from '@/lib/unified-import/probe';
import {
  SUPPORTED_EXTENSIONS, canUseHandler, getHandler, handlersForExtension,
} from '@/lib/unified-import/handlers';
import { clearAllPending, setPending } from '@/lib/unified-import/pending-files';
import { buildOpenGroups, filesForGroupButton } from '@/lib/unified-import/open-groups';
import {
  addEntries, clearQueue, getEntries, getListTenant, markHanded, removeEntry, setEntryType, subscribe, type QueueEntry,
} from '@/lib/unified-import/queue-store';
import { ISSUE_REASONS, REASON_TEXT, STATUS_LABEL } from '@/lib/unified-import/labels';
import { tr } from '@/lib/unified-import/strings';
import type { UnifiedImportTypeId } from '@/lib/unified-import/types';

const ACCEPT = SUPPORTED_EXTENSIONS.map(e => `.${e}`).join(',');

/** `embedded`: rendered inside the weekly card (no own frame; the card rows show the weekly coverage). */
export const UnifiedImportDropZone = ({ embedded = false }: { embedded?: boolean }) => {
  const navigate = useNavigate();
  const { tenantId, tenant } = useTenant();
  const { isAdmin, isBeaulieuManager, isBeaulieuViewer } = usePermissions();
  const entries = useSyncExternalStore(subscribe, getEntries, getEntries);
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragOver, setDragOver] = useState(false);
  const [busy, setBusy] = useState(false);

  /** May this role hand a file to the type? Inline /import sections exist for admins only. */
  const allowed = useCallback((id: UnifiedImportTypeId) => {
    const h = getHandler(id);
    if (h.target.kind === 'anchor' && !isAdmin) return false;
    return canUseHandler(id, { isAdmin, isBeaulieuManager, isBeaulieuViewer });
  }, [isAdmin, isBeaulieuManager, isBeaulieuViewer]);

  // Files must never reach a flow of another tenant: a tenant switch empties the list.
  const lastTenant = useRef(tenantId);
  useEffect(() => {
    // Also covers a tenant switched on ANOTHER page while a file was handed over: the list outlives this component.
    const listTenant = getListTenant();
    if (lastTenant.current !== tenantId || (listTenant !== null && listTenant !== tenantId)) {
      if (getEntries().length > 0) {
        toast.warning(tr('Mandant gewechselt — die Dateiliste wurde geleert.', 'Tenant switched — the file list was cleared.'));
      }
      clearQueue();
      clearAllPending();
      lastTenant.current = tenantId;
    }
  }, [tenantId]);

  const addFiles = useCallback(async (list: FileList | File[]) => {
    const files = Array.from(list);
    if (files.length === 0) return;
    setBusy(true);
    try {
      const items = [];
      for (const file of files) {
        const result = classifyProbe(await readFileProbe(file));
        items.push({ file, result });
      }
      const added = addEntries(tenantId, items);
      if (added < items.length) {
        toast.info(tr(`${items.length - added} Datei(en) waren bereits in der Liste und wurden nicht doppelt hinzugefügt.`, `${items.length - added} file(s) were already in the list and were not added twice.`));
      }
    } finally {
      setBusy(false);
    }
  }, [tenantId]);

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    void addFiles(e.dataTransfer.files);
  };

  /** Hand one group (same type) to its existing flow. */
  const handOver = (typeId: UnifiedImportTypeId, group: QueueEntry[], reopen = false) => {
    const h = getHandler(typeId);
    // Flows that take one file per run get the first; the others stay in the list for the next run.
    const taken = h.multiFile ? group : group.slice(0, 1);
    if (h.acceptsHandover) {
      setPending(typeId, taken.map(e => e.file));
    }
    markHanded(taken.map(e => e.id));
    if (h.target.kind === 'route') {
      navigate(h.target.path);
    } else {
      const anchor = h.target.id;
      window.dispatchEvent(new CustomEvent(IMPORT_SECTION_OPEN_EVENT, { detail: anchor }));
      requestAnimationFrame(() => {
        document.getElementById(anchor)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      });
    }
    if (!h.acceptsHandover) {
      toast.info(tr('Bereich geöffnet — bitte die Datei dort auswählen (der Import fragt zuerst nach dem Modus).', 'Section opened — please choose the file there (the import asks for the mode first).'));
    } else if (!reopen && !h.multiFile && group.length > 1) {
      toast.info(tr(`${group.length - 1} weitere Datei(en) dieses Typs warten in der Liste.`, `${group.length - 1} more file(s) of this type are waiting in the list.`));
    }
  };

  const openGroups = useMemo(() => buildOpenGroups(entries, allowed), [entries, allowed]);
  const readyCount = openGroups.reduce((n, g) => n + g.ready.length, 0);
  const handedCount = openGroups.reduce((n, g) => n + g.handed.length, 0);

  return (
    <Card className={embedded ? 'border-0 shadow-none bg-transparent' : 'border-dashed border-2'}>
      <CardContent className={embedded ? 'p-0 space-y-3' : 'p-4 space-y-3'}>
        {/* 1 · Drop area */}
        <div
          role="button"
          tabIndex={0}
          aria-label={tr('Dateien hier ablegen oder auswählen', 'Drop or choose files')}
          data-testid="unified-drop-area"
          onClick={() => inputRef.current?.click()}
          onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); inputRef.current?.click(); } }}
          onDragOver={e => { e.preventDefault(); setDragOver(true); }}
          onDragLeave={() => setDragOver(false)}
          onDrop={onDrop}
          className={cn(
            'group flex items-center gap-4 rounded-lg border-2 border-dashed px-4 py-4 cursor-pointer transition-colors',
            dragOver ? 'border-primary bg-primary/5' : 'border-border bg-muted/20 hover:border-primary/50 hover:bg-muted/40',
          )}
        >
          <span className={cn(
            'flex h-11 w-11 shrink-0 items-center justify-center rounded-full transition-colors',
            dragOver ? 'bg-primary text-primary-foreground' : 'bg-primary/10 text-primary',
          )}>
            {busy ? <Loader2 className="h-5 w-5 animate-spin" /> : <Upload className="h-5 w-5" />}
          </span>
          <div className="min-w-0 flex-1">
            <p className="text-sm font-semibold leading-tight">
              {tr('Dateien hier ablegen — alle Importe an einem Ort', 'Drop files here — all imports in one place')}
            </p>
            <p className="mt-0.5 text-xs text-muted-foreground">
              {tr('Mehrere Dateien gleichzeitig (Excel, CSV, TXT, PDF) · wird automatisch erkannt · Mandant:', 'Several files at once (Excel, CSV, TXT, PDF) · recognised automatically · Tenant:')} {tenant.shortName}
            </p>
          </div>
          <Button type="button" variant="outline" size="sm" className="hidden shrink-0 sm:inline-flex" tabIndex={-1}>
            {tr('Dateien wählen', 'Choose files')}
          </Button>
          <input
            ref={inputRef}
            type="file"
            multiple
            accept={ACCEPT}
            className="hidden"
            data-testid="unified-file-input"
            onChange={e => { if (e.target.files) void addFiles(e.target.files); e.target.value = ''; }}
          />
        </div>

        {entries.length > 0 && (
          <>
            {/* 2 · Recognised files */}
            <div className="flex items-center justify-between">
              <p className="text-xs font-medium text-muted-foreground">
                {tr('Dateien', 'Files')} · {entries.length}
              </p>
              <Button
                size="sm" variant="ghost" className="h-7 px-2 text-xs text-muted-foreground"
                onClick={() => { clearQueue(); clearAllPending(); }}
              >
                {tr('Liste leeren', 'Clear list')}
              </Button>
            </div>
            <ul className="space-y-2" data-testid="unified-list">
              {entries.map(e => (
                <EntryRow
                  key={e.id} entry={e} allowed={allowed}
                  // A per-file button only where a choice exists: several files of the same type wait in the list.
                  showOpen={!!e.typeId && entries.filter(o => o.typeId === e.typeId).length > 1}
                  onOpen={() => e.typeId && handOver(e.typeId, [e], e.state === 'handed')}
                />
              ))}
            </ul>

            {/* 3 · Open in the existing imports */}
            <div className="rounded-lg border bg-muted/30 p-3">
              <p className="mb-2 text-xs font-medium">
                {readyCount > 0
                  ? tr(`Bereit zum Öffnen · ${readyCount} Datei(en)`, `Ready to open · ${readyCount} file(s)`)
                  : handedCount > 0
                    ? tr('Bereits geöffnet — falls nötig erneut öffnen', 'Already opened — open again if needed')
                    : tr('Wähle für jede Datei einen Typ, um sie zu öffnen', 'Choose a type for each file to open it')}
              </p>
              {openGroups.length > 0 && (
                <div className="flex flex-wrap gap-2">
                  {openGroups.map(g => {
                    const h = getHandler(g.typeId);
                    const { files, reopen } = filesForGroupButton(g);
                    const shown = h.multiFile ? files.length : 1;
                    const label = h.label.replace(/\s*\(.*\)$/, '');
                    return (
                      <Button
                        key={g.typeId} size="sm" variant={reopen ? 'outline' : 'default'} className="h-8 gap-1.5 text-xs"
                        onClick={() => handOver(g.typeId, files, reopen)}
                      >
                        <span className="max-w-[16rem] truncate">{reopen ? tr(`${label} erneut öffnen`, `Open ${label} again`) : label}</span>
                        <span className={cn('rounded px-1.5 text-[10px]', reopen ? 'bg-muted' : 'bg-primary-foreground/20')}>
                          {shown}{shown < files.length ? `/${files.length}` : ''}
                        </span>
                        <ArrowRight className="h-3.5 w-3.5" />
                      </Button>
                    );
                  })}
                </div>
              )}
              <p className="mt-2 text-[11px] text-muted-foreground">
                {tr('Es wird nichts automatisch gespeichert: Im geöffneten Import siehst du zuerst die Vorschau und bestätigst selbst.', 'Nothing is saved automatically: the opened import shows a preview first and you confirm there.')}
              </p>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
};

const fmtSize = (n: number) => (n < 1024 * 1024 ? `${Math.max(1, Math.round(n / 1024))} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`);

const EntryRow = ({ entry, allowed, onOpen, showOpen }: { entry: QueueEntry; allowed: (id: UnifiedImportTypeId) => boolean; onOpen: () => void; showOpen: boolean }) => {
  const { file, result, typeId, state } = entry;
  const ext = extensionOf(file.name);
  const options = handlersForExtension(ext).filter(h => allowed(h.id));
  const forbidden = result.status === 'recognised' && result.typeId !== null && !allowed(result.typeId);
  const statusKey = state === 'handed' ? 'handed' : forbidden ? 'forbidden' : result.status;
  const issues = result.reasons.filter(r => ISSUE_REASONS.includes(r));
  const good = statusKey === 'recognised' || statusKey === 'handed';
  const warn = statusKey === 'confirm';
  const Icon = good ? CheckCircle2 : warn ? AlertTriangle : statusKey === 'forbidden' ? ShieldOff : FileQuestion;
  const canPick = result.status !== 'unsupported' && options.length > 0;
  const canOpen = showOpen && !!typeId && allowed(typeId);

  return (
    <li
      data-testid="unified-row"
      className={cn(
        'flex flex-col gap-3 rounded-lg border bg-card p-3 lg:flex-row lg:items-center',
        state === 'handed' && 'bg-muted/30',
      )}
    >
      {/* icon + name + status */}
      <div className="flex min-w-0 flex-1 items-start gap-3">
        <span className={cn(
          'mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full',
          good ? 'bg-emerald-100 text-emerald-700' : warn ? 'bg-amber-100 text-amber-700' : 'bg-red-100 text-red-700',
        )}>
          <Icon className="h-4 w-4" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <FileText className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
            <span className="truncate text-sm font-medium" title={file.name}>{file.name}</span>
            <span className="shrink-0 text-[11px] text-muted-foreground">{fmtSize(file.size)}</span>
          </div>
          <p className="mt-0.5 text-xs leading-snug text-muted-foreground">
            <span className={cn('font-medium', good ? 'text-emerald-700' : warn ? 'text-amber-700' : 'text-red-700')}>
              {STATUS_LABEL[statusKey]}
            </span>
            {issues.length > 0 && <> · {issues.map(r => REASON_TEXT[r]).join(' ')}</>}
          </p>
        </div>
      </div>

      {/* type picker · open · remove — fixed widths so nothing overlaps */}
      <div className="flex shrink-0 flex-wrap items-center gap-2 pl-11 lg:flex-nowrap lg:pl-0">
        {canPick ? (
          <Select
            value={typeId ?? undefined}
            onValueChange={v => setEntryType(entry.id, v as UnifiedImportTypeId)}
          >
            <SelectTrigger
              aria-label={tr(`Typ für ${file.name}`, `Type for ${file.name}`)}
              className="h-9 w-full min-w-0 basis-full text-xs lg:w-64 lg:basis-auto [&>span]:truncate [&>span]:text-left"
            >
              <SelectValue placeholder={tr('Typ wählen …', 'Choose type …')} />
            </SelectTrigger>
            <SelectContent className="max-w-[28rem]">
              {options.map(h => <SelectItem key={h.id} value={h.id} className="text-xs">{h.label}</SelectItem>)}
            </SelectContent>
          </Select>
        ) : (
          <span className="w-full basis-full truncate text-xs text-muted-foreground lg:w-64 lg:basis-auto">{typeId ? getHandler(typeId).label : ''}</span>
        )}
        {canOpen ? (
          <Button
            size="sm" variant="outline" className="h-8 w-[7.5rem] shrink-0 px-2 text-xs"
            data-testid="unified-row-open" onClick={onOpen}
            title={tr('Nur diese Datei öffnen', 'Open only this file')}
          >
            {state === 'handed' ? tr('Erneut öffnen', 'Open again') : tr('Nur diese öffnen', 'Open only this')}
          </Button>
        ) : null}
        <Button size="icon" variant="ghost" className="h-9 w-9 shrink-0" aria-label={tr(`${file.name} entfernen`, `Remove ${file.name}`)} onClick={() => removeEntry(entry.id)}>
          <X className="h-4 w-4" />
        </Button>
      </div>
    </li>
  );
};

export default UnifiedImportDropZone;
