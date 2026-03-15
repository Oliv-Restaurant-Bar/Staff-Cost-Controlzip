import { useState, useEffect, useRef } from 'react';
import { useParams } from 'react-router-dom';
import {
  findEmployeeByToken,
  markOnboardingInProgress,
  submitOnboardingData,
  uploadOnboardingFile,
  OnboardingPublicEmployee,
  OnboardingDoc,
} from '@/lib/supabase-db';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Badge } from '@/components/ui/badge';
import { Separator } from '@/components/ui/separator';
import {
  Loader2,
  CheckCircle2,
  AlertCircle,
  Upload,
  X,
  FileText,
  ImageIcon,
  User,
  Phone,
  MapPin,
  CreditCard,
  Paperclip,
} from 'lucide-react';

// ─── Types ───────────────────────────────────────────────────────────────────

interface PendingFile {
  id: string;
  file: File;
  docType: string;
  preview?: string;
  status: 'pending' | 'uploading' | 'done' | 'error';
  doc?: OnboardingDoc;
}

interface FormData {
  birthDate: string;
  nationality: string;
  phone: string;
  email: string;
  addressStreet: string;
  addressZip: string;
  addressCity: string;
  ahvNumber: string;
  iban: string;
}

const DOC_TYPES: { value: string; label: string }[] = [
  { value: 'id_card',      label: 'Personalausweis / Pass' },
  { value: 'permit',       label: 'Aufenthaltsbewilligung' },
  { value: 'ahv_card',     label: 'AHV-Ausweis' },
  { value: 'other',        label: 'Sonstiges Dokument' },
];

const CONTRACT_TYPE_LABELS: Record<string, string> = {
  festanstellung: 'Festanstellung',
  aushilfe:       'Aushilfe / Stundenlohn',
};

// ─── Component ───────────────────────────────────────────────────────────────

export default function OnboardingForm() {
  const { token } = useParams<{ token: string }>();

  const [phase, setPhase] = useState<'loading' | 'error' | 'form' | 'success' | 'already-done'>('loading');
  const [errorMsg, setErrorMsg] = useState('');
  const [employee, setEmployee] = useState<OnboardingPublicEmployee | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const [formData, setFormData] = useState<FormData>({
    birthDate: '', nationality: '', phone: '', email: '',
    addressStreet: '', addressZip: '', addressCity: '',
    ahvNumber: '', iban: '',
  });

  const [pendingFiles, setPendingFiles] = useState<PendingFile[]>([]);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // ── Load employee by token ──────────────────────────────────────────────
  useEffect(() => {
    if (!token) {
      setErrorMsg('Kein gültiger Onboarding-Link.');
      setPhase('error');
      return;
    }
    (async () => {
      const emp = await findEmployeeByToken(token);
      if (!emp) {
        setErrorMsg('Dieser Onboarding-Link ist ungültig oder existiert nicht mehr.');
        setPhase('error');
        return;
      }
      if (emp.onboardingStatus === 'completed') {
        setEmployee(emp);
        setPhase('already-done');
        return;
      }
      setEmployee(emp);
      setFormData({
        birthDate:     emp.birthDate     ?? '',
        nationality:   emp.nationality   ?? '',
        phone:         emp.phone         ?? '',
        email:         emp.email         ?? '',
        addressStreet: emp.addressStreet ?? '',
        addressZip:    emp.addressZip    ?? '',
        addressCity:   emp.addressCity   ?? '',
        ahvNumber:     emp.ahvNumber     ?? '',
        iban:          emp.iban          ?? '',
      });
      // Mark as in_progress (auto, silent)
      if (emp.onboardingStatus !== 'in_progress') {
        await markOnboardingInProgress(emp.id);
      }
      setPhase('form');
    })();
  }, [token]);

  // ── Field helper ───────────────────────────────────────────────────────
  const set = (field: keyof FormData) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setFormData(prev => ({ ...prev, [field]: e.target.value }));

  // ── File selection ─────────────────────────────────────────────────────
  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? []);
    const newItems: PendingFile[] = files.map(file => {
      const pf: PendingFile = {
        id:      crypto.randomUUID(),
        file,
        docType: 'other',
        status:  'pending',
      };
      if (file.type.startsWith('image/')) {
        pf.preview = URL.createObjectURL(file);
      }
      return pf;
    });
    setPendingFiles(prev => [...prev, ...newItems]);
    e.target.value = '';
  };

  const removeFile = (id: string) => {
    setPendingFiles(prev => {
      const found = prev.find(f => f.id === id);
      if (found?.preview) URL.revokeObjectURL(found.preview);
      return prev.filter(f => f.id !== id);
    });
  };

  const setDocType = (id: string, docType: string) =>
    setPendingFiles(prev => prev.map(f => f.id === id ? { ...f, docType } : f));

  // ── Submit ─────────────────────────────────────────────────────────────
  const handleSubmit = async () => {
    if (!employee) return;
    setSubmitting(true);

    // Upload all pending files
    const docs: OnboardingDoc[] = [];
    const updated: PendingFile[] = pendingFiles.map(f => ({ ...f }));

    for (const pf of updated) {
      pf.status = 'uploading';
      setPendingFiles([...updated]);
      const doc = await uploadOnboardingFile(employee.id, pf.file, pf.docType);
      if (doc) {
        pf.status = 'done';
        pf.doc = doc;
        docs.push(doc);
      } else {
        pf.status = 'error';
        // Still include a record without URL (storage not available)
        docs.push({
          type: pf.docType,
          name: pf.file.name,
          path: `${employee.id}/${pf.docType}_${Date.now()}`,
          uploadedAt: new Date().toISOString(),
        });
      }
      setPendingFiles([...updated]);
    }

    const ok = await submitOnboardingData(employee.id, formData, docs);
    setSubmitting(false);
    if (ok) {
      setPhase('success');
    } else {
      setErrorMsg('Beim Speichern ist ein Fehler aufgetreten. Bitte versuchen Sie es nochmals oder wenden Sie sich an Ihr Restaurant.');
    }
  };

  // ── Render states ──────────────────────────────────────────────────────
  if (phase === 'loading') return <LoadingScreen />;
  if (phase === 'error')   return <ErrorScreen message={errorMsg} />;
  if (phase === 'already-done') return <AlreadyDoneScreen name={employee?.name} />;
  if (phase === 'success') return <SuccessScreen name={employee?.name} />;

  // ── Main form ──────────────────────────────────────────────────────────
  return (
    <div className="min-h-screen bg-slate-50">
      {/* Header */}
      <div className="bg-white border-b shadow-sm">
        <div className="max-w-2xl mx-auto px-4 py-4 flex items-center justify-between">
          <div>
            <p className="text-xs font-semibold tracking-widest text-slate-400 uppercase">oLiv Restaurant & Bar</p>
            <h1 className="text-lg font-bold text-slate-800">Mitarbeiter-Onboarding</h1>
          </div>
          <Badge variant="outline" className="text-amber-700 border-amber-300 bg-amber-50 text-xs">
            Formular ausfüllen
          </Badge>
        </div>
      </div>

      <div className="max-w-2xl mx-auto px-4 py-6 space-y-6">

        {/* Welcome card */}
        <div className="bg-amber-50 border border-amber-200 rounded-xl p-4">
          <div className="flex items-start gap-3">
            <div className="mt-0.5 w-8 h-8 rounded-full bg-amber-200 flex items-center justify-center shrink-0">
              <span className="text-amber-800 font-bold text-sm">{employee?.name?.charAt(0) ?? '?'}</span>
            </div>
            <div>
              <p className="font-semibold text-amber-900">Willkommen, {employee?.name ?? 'neues Teammitglied'}!</p>
              <p className="text-sm text-amber-800 mt-0.5">
                Bitte füllen Sie das folgende Formular vollständig aus. Ihre Daten werden sicher gespeichert und direkt in unser HR-System übertragen.
              </p>
            </div>
          </div>
        </div>

        {/* Contract info (read-only) */}
        {(employee?.positionTitle || employee?.contractStart || employee?.contractType) && (
          <Section icon={<FileText className="w-4 h-4" />} title="Ihre Stelle" color="blue">
            <div className="grid grid-cols-2 gap-4 text-sm">
              {employee?.positionTitle && (
                <InfoRow label="Position" value={employee.positionTitle} />
              )}
              {employee?.contractType && (
                <InfoRow label="Vertragsart" value={CONTRACT_TYPE_LABELS[employee.contractType] ?? employee.contractType} />
              )}
              {employee?.contractStart && (
                <InfoRow label="Eintritt ab" value={fmtDate(employee.contractStart)} />
              )}
              <InfoRow label="Abteilung" value={employee.department === 'kueche' ? 'Küche' : 'Service'} />
            </div>
          </Section>
        )}

        {/* Personal data */}
        <Section icon={<User className="w-4 h-4" />} title="Persönliche Angaben" color="slate">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div className="space-y-1.5">
              <Label htmlFor="birthDate">Geburtsdatum</Label>
              <Input id="birthDate" type="date" value={formData.birthDate} onChange={set('birthDate')} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="nationality">Nationalität</Label>
              <Input id="nationality" placeholder="z.B. Schweiz, Deutschland" value={formData.nationality} onChange={set('nationality')} />
            </div>
          </div>
        </Section>

        {/* Contact */}
        <Section icon={<Phone className="w-4 h-4" />} title="Kontaktdaten" color="slate">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div className="space-y-1.5">
              <Label htmlFor="phone">Telefonnummer</Label>
              <Input id="phone" type="tel" placeholder="+41 79 123 45 67" value={formData.phone} onChange={set('phone')} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="email">E-Mail-Adresse</Label>
              <Input id="email" type="email" placeholder="vorname@mail.com" value={formData.email} onChange={set('email')} />
            </div>
          </div>
        </Section>

        {/* Address */}
        <Section icon={<MapPin className="w-4 h-4" />} title="Adresse" color="slate">
          <div className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="addressStreet">Strasse und Hausnummer</Label>
              <Input id="addressStreet" placeholder="Musterstrasse 12" value={formData.addressStreet} onChange={set('addressStreet')} />
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-1.5">
                <Label htmlFor="addressZip">PLZ</Label>
                <Input id="addressZip" placeholder="3011" value={formData.addressZip} onChange={set('addressZip')} />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="addressCity">Ort</Label>
                <Input id="addressCity" placeholder="Bern" value={formData.addressCity} onChange={set('addressCity')} />
              </div>
            </div>
          </div>
        </Section>

        {/* Bank & Social Insurance */}
        <Section icon={<CreditCard className="w-4 h-4" />} title="Bankdaten & Sozialversicherung" color="slate">
          <div className="bg-blue-50 border border-blue-200 rounded-lg p-3 mb-4">
            <p className="text-xs text-blue-800">
              Diese Angaben werden für die Lohnzahlung und die Sozialversicherungsanmeldung benötigt. Sie werden verschlüsselt gespeichert.
            </p>
          </div>
          <div className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="ahvNumber">AHV-Nummer</Label>
              <Input
                id="ahvNumber"
                placeholder="756.XXXX.XXXX.XX"
                value={formData.ahvNumber}
                onChange={set('ahvNumber')}
              />
              <p className="text-xs text-slate-500">13-stellige Nummer auf Ihrem AHV-Ausweis</p>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="iban">IBAN (Bankkonto für Lohnauszahlung)</Label>
              <Input
                id="iban"
                placeholder="CH56 0483 5012 3456 7800 9"
                value={formData.iban}
                onChange={set('iban')}
              />
              <p className="text-xs text-slate-500">Schweizer IBAN, 21 Zeichen</p>
            </div>
          </div>
        </Section>

        {/* Documents upload */}
        <Section icon={<Paperclip className="w-4 h-4" />} title="Dokumente hochladen" color="slate">
          <p className="text-sm text-slate-600 mb-4">
            Bitte laden Sie ein Bild oder Scan Ihres Ausweises / Passes hoch. Optional können Sie auch die Aufenthaltsbewilligung und weitere Dokumente beifügen.
          </p>

          {/* File list */}
          {pendingFiles.length > 0 && (
            <div className="space-y-2 mb-4">
              {pendingFiles.map(pf => (
                <div key={pf.id} className="flex items-center gap-3 p-3 bg-slate-50 border rounded-lg">
                  {/* Preview or icon */}
                  <div className="w-10 h-10 rounded flex items-center justify-center bg-white border shrink-0 overflow-hidden">
                    {pf.preview
                      ? <img src={pf.preview} alt="" className="w-10 h-10 object-cover" />
                      : <FileText className="w-5 h-5 text-slate-400" />
                    }
                  </div>
                  {/* Info */}
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium text-slate-700 truncate">{pf.file.name}</p>
                    <p className="text-xs text-slate-400">{(pf.file.size / 1024).toFixed(0)} KB</p>
                  </div>
                  {/* Type select */}
                  <Select value={pf.docType} onValueChange={(v) => setDocType(pf.id, v)}>
                    <SelectTrigger className="w-44 text-xs h-8">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {DOC_TYPES.map(dt => (
                        <SelectItem key={dt.value} value={dt.value} className="text-xs">{dt.label}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  {/* Status / remove */}
                  {pf.status === 'uploading' && <Loader2 className="w-4 h-4 animate-spin text-blue-500 shrink-0" />}
                  {pf.status === 'done'      && <CheckCircle2 className="w-4 h-4 text-green-500 shrink-0" />}
                  {pf.status === 'error'     && <AlertCircle  className="w-4 h-4 text-red-500 shrink-0" />}
                  {pf.status === 'pending'   && (
                    <button onClick={() => removeFile(pf.id)} className="text-slate-400 hover:text-red-500 shrink-0">
                      <X className="w-4 h-4" />
                    </button>
                  )}
                </div>
              ))}
            </div>
          )}

          {/* Upload button */}
          <input
            ref={fileInputRef}
            type="file"
            className="hidden"
            multiple
            accept="image/*,.pdf"
            onChange={handleFileSelect}
          />
          <Button
            type="button"
            variant="outline"
            onClick={() => fileInputRef.current?.click()}
            disabled={submitting}
            className="w-full border-dashed"
          >
            <Upload className="w-4 h-4 mr-2" />
            Datei(en) auswählen
          </Button>
          <p className="text-xs text-slate-400 mt-2 text-center">
            JPG, PNG, WEBP oder PDF — max. 10 MB pro Datei
          </p>
        </Section>

        {/* Error message */}
        {errorMsg && (
          <div className="flex items-start gap-2 p-4 bg-red-50 border border-red-200 rounded-xl text-red-800 text-sm">
            <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" />
            <span>{errorMsg}</span>
          </div>
        )}

        <Separator />

        {/* Submit */}
        <div className="pb-8">
          <Button
            size="lg"
            className="w-full bg-amber-600 hover:bg-amber-700 text-white"
            onClick={handleSubmit}
            disabled={submitting}
          >
            {submitting
              ? <><Loader2 className="w-4 h-4 mr-2 animate-spin" /> Wird gespeichert…</>
              : 'Daten absenden & Onboarding abschliessen'
            }
          </Button>
          <p className="text-xs text-slate-400 text-center mt-2">
            Durch das Absenden stimmen Sie der Verarbeitung Ihrer Daten für die Personalverwaltung zu.
          </p>
        </div>
      </div>
    </div>
  );
}

// ─── Sub-components ───────────────────────────────────────────────────────────

function Section({
  icon, title, color = 'slate', children,
}: {
  icon: React.ReactNode;
  title: string;
  color?: 'slate' | 'blue' | 'amber';
  children: React.ReactNode;
}) {
  const header: Record<string, string> = {
    slate: 'bg-slate-100 text-slate-700',
    blue:  'bg-blue-50 text-blue-700',
    amber: 'bg-amber-50 text-amber-700',
  };
  return (
    <div className="bg-white rounded-xl border shadow-sm overflow-hidden">
      <div className={`flex items-center gap-2 px-4 py-3 ${header[color]} font-semibold text-sm`}>
        {icon}
        {title}
      </div>
      <div className="p-4">{children}</div>
    </div>
  );
}

function InfoRow({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-xs text-slate-400">{label}</p>
      <p className="font-medium text-slate-800">{value}</p>
    </div>
  );
}

function LoadingScreen() {
  return (
    <div className="min-h-screen bg-slate-50 flex items-center justify-center">
      <div className="text-center space-y-3">
        <Loader2 className="w-8 h-8 animate-spin text-amber-500 mx-auto" />
        <p className="text-slate-600 text-sm">Onboarding-Daten werden geladen…</p>
      </div>
    </div>
  );
}

function ErrorScreen({ message }: { message: string }) {
  return (
    <div className="min-h-screen bg-slate-50 flex items-center justify-center px-4">
      <div className="bg-white rounded-2xl border shadow-sm p-8 max-w-md w-full text-center space-y-4">
        <div className="w-14 h-14 rounded-full bg-red-100 flex items-center justify-center mx-auto">
          <AlertCircle className="w-7 h-7 text-red-500" />
        </div>
        <div>
          <h2 className="text-lg font-bold text-slate-800">Link ungültig</h2>
          <p className="text-sm text-slate-500 mt-1">{message}</p>
        </div>
        <p className="text-xs text-slate-400">
          Falls Sie glauben, dass dies ein Fehler ist, wenden Sie sich bitte an oLiv Restaurant & Bar.
        </p>
      </div>
    </div>
  );
}

function AlreadyDoneScreen({ name }: { name?: string }) {
  return (
    <div className="min-h-screen bg-slate-50 flex items-center justify-center px-4">
      <div className="bg-white rounded-2xl border shadow-sm p-8 max-w-md w-full text-center space-y-4">
        <div className="w-14 h-14 rounded-full bg-green-100 flex items-center justify-center mx-auto">
          <CheckCircle2 className="w-7 h-7 text-green-500" />
        </div>
        <div>
          <h2 className="text-lg font-bold text-slate-800">Bereits abgeschlossen</h2>
          <p className="text-sm text-slate-500 mt-1">
            {name ? `${name}, Ihr Onboarding` : 'Das Onboarding'} wurde bereits erfolgreich abgeschlossen.
          </p>
        </div>
        <p className="text-xs text-slate-400">
          Wenn Sie Daten ändern möchten, wenden Sie sich an die Restaurantleitung.
        </p>
      </div>
    </div>
  );
}

function SuccessScreen({ name }: { name?: string }) {
  return (
    <div className="min-h-screen bg-slate-50 flex items-center justify-center px-4">
      <div className="bg-white rounded-2xl border shadow-sm p-8 max-w-md w-full text-center space-y-4">
        <div className="w-16 h-16 rounded-full bg-green-100 flex items-center justify-center mx-auto">
          <CheckCircle2 className="w-8 h-8 text-green-600" />
        </div>
        <div>
          <p className="text-xs font-semibold tracking-widest text-slate-400 uppercase mb-1">oLiv Restaurant & Bar</p>
          <h2 className="text-xl font-bold text-slate-800">Vielen Dank{name ? `, ${name}` : ''}!</h2>
          <p className="text-sm text-slate-500 mt-2">
            Ihre Angaben wurden erfolgreich übermittelt. Das Team von oLiv wird Ihre Unterlagen prüfen und sich bei Ihnen melden.
          </p>
        </div>
        <div className="bg-green-50 border border-green-200 rounded-lg p-3 text-xs text-green-800">
          Onboarding abgeschlossen — Sie können dieses Fenster schliessen.
        </div>
      </div>
    </div>
  );
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function fmtDate(iso?: string): string {
  if (!iso) return '';
  try {
    const [y, m, d] = iso.split('-');
    return `${d}.${m}.${y}`;
  } catch {
    return iso;
  }
}

// Prevent tree-shaking of ImageIcon (used in future)
void ImageIcon;
