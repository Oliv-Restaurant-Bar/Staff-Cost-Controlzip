import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { ChevronDown, FileDown, FileSpreadsheet, FileText } from 'lucide-react';

export type ExportActionKind = 'pdf' | 'excel' | 'csv';

export interface ExportAction {
  key: string;
  label: string;
  kind: ExportActionKind;
  onSelect: () => void;
  disabled?: boolean;
}

interface UnifiedExportButtonProps {
  actions: ExportAction[];
  size?: 'default' | 'sm';
  disabled?: boolean;
  className?: string;
  'data-testid'?: string;
}

const kindIcon = (kind: ExportActionKind) => {
  switch (kind) {
    case 'pdf':
      return <FileDown className="h-4 w-4" />;
    case 'excel':
      return <FileSpreadsheet className="h-4 w-4" />;
    case 'csv':
      return <FileText className="h-4 w-4" />;
  }
};

/**
 * Einheitlicher Export-Einstieg: EIN Button «Exportieren» + Dropdown mit den
 * real verfügbaren Formaten. Startet ausschliesslich übergebene, bestehende
 * Export-Handler bzw. Dialog-Öffner — keine eigene Export-Logik.
 */
export const UnifiedExportButton = ({
  actions,
  size = 'sm',
  disabled,
  className,
  'data-testid': testId,
}: UnifiedExportButtonProps) => {
  if (actions.length === 0) return null;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="outline"
          size={size}
          disabled={disabled}
          className={className ?? (size === 'sm' ? 'h-8 text-xs gap-1' : 'gap-2')}
          data-testid={testId ?? 'button-export'}
        >
          <FileDown className={size === 'sm' ? 'h-3.5 w-3.5' : 'h-4 w-4'} />
          Exportieren
          <ChevronDown className={size === 'sm' ? 'h-3 w-3 opacity-60' : 'h-3.5 w-3.5 opacity-60'} />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {actions.map((action) => (
          <DropdownMenuItem
            key={action.key}
            disabled={action.disabled}
            onClick={action.onSelect}
            className="gap-2 cursor-pointer"
            data-testid={`export-action-${action.key}`}
          >
            {kindIcon(action.kind)}
            {action.label}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
};
