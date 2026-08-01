/**
 * CsvPasteBox — «CSV einfügen»-Alternative zum Datei-Dialog.
 *
 * Hintergrund: In der eingebetteten Vorschau (Iframe) kann der native
 * Datei-Dialog blockiert sein. Dieses Feld nimmt den kopierten CSV-Inhalt
 * per Strg/Cmd+V entgegen und reicht ihn 1:1 an den bestehenden Parser
 * weiter («Vorschau»-Button). Zusätzlich akzeptiert das Textfeld auch eine
 * hineingezogene .csv-Datei (Drag & Drop auf das Feld).
 *
 * Fehlerdisziplin: leerer Text ⇒ sichtbare Meldung, nie stilles Nichtstun.
 */
import { useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { ClipboardPaste, Loader2 } from 'lucide-react';

export function CsvPasteBox({
  onText,
  disabled,
  placeholder = 'CSV-Inhalt hier einfügen (Strg/Cmd+V) — oder .csv-Datei auf dieses Feld ziehen …',
  testIdPrefix = 'csv-paste',
}: {
  /** Erhält den rohen CSV-Text; Fehler bitte dort sichtbar melden. */
  onText: (text: string, sourceLabel: string) => void | Promise<void>;
  disabled?: boolean;
  placeholder?: string;
  testIdPrefix?: string;
}) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [hint, setHint] = useState<string | null>(null);
  // Fallback-Quelle: Sollte der kontrollierte State je leer wirken (z.B. durch
  // Autofill/Extension-Einfügen ohne React-onChange), lesen wir den echten
  // DOM-Wert aus dem Ref, BEVOR «Kein Inhalt» gemeldet wird.
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  async function submit(raw: string, sourceLabel: string) {
    if (!raw.trim()) {
      const domValue = textareaRef.current?.value ?? '';
      if (domValue.trim()) {
        setText(domValue); // State nachziehen
        raw = domValue;
      }
    }
    if (!raw.trim()) {
      setHint('Kein Inhalt: bitte zuerst den CSV-Text einfügen oder eine Datei auf das Feld ziehen.');
      return;
    }
    setHint(null);
    setBusy(true);
    try {
      await onText(raw, sourceLabel);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-2">
      <Textarea
        ref={textareaRef}
        value={text}
        onChange={e => { setText(e.target.value); if (hint) setHint(null); }}
        onDrop={e => {
          const f = e.dataTransfer?.files?.[0];
          if (!f) return; // Text-Drop: Standardverhalten (fügt in Textarea ein)
          e.preventDefault();
          void f.text()
            .then(t => submit(t, f.name))
            .catch(err => setHint('Datei konnte nicht gelesen werden: ' + (err instanceof Error ? err.message : String(err))));
        }}
        onDragOver={e => { if (e.dataTransfer?.types?.includes('Files')) e.preventDefault(); }}
        placeholder={placeholder}
        rows={5}
        disabled={disabled || busy}
        className="font-mono text-xs"
        data-testid={`${testIdPrefix}-textarea`}
      />
      <div className="flex items-center gap-3">
        <Button
          size="sm"
          type="button"
          onClick={() => void submit(text, 'Eingefügter CSV-Text')}
          disabled={disabled || busy}
          data-testid={`${testIdPrefix}-submit`}
        >
          {busy
            ? <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />
            : <ClipboardPaste className="h-3.5 w-3.5 mr-1.5" />}
          Vorschau
        </Button>
        {hint && <span className="text-xs text-destructive" data-testid={`${testIdPrefix}-hint`}>{hint}</span>}
      </div>
    </div>
  );
}
