import { useState, useEffect, useRef } from 'react';
import { useParams } from 'react-router-dom';
import {
  findEmployeeByToken,
  markOnboardingInProgress,
  submitOnboardingData,
  uploadOnboardingFile,
  createPendingEmployee,
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
  User,
  Phone,
  MapPin,
  CreditCard,
  Paperclip,
  Briefcase,
  Shield,
  Info,
  Heart,
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

/** Shared fields for both modes */
interface SharedFormData {
  birthDate: string;
  nationality: string;
  permitType: string;   // 'swiss' | 'C' | 'B' | 'L' | 'G' | 'other' | ''
  maritalStatus: string; // 'single' | 'married' | 'divorced' | 'widowed' | ''
  spouseEmployed: string;            // 'yes' | 'no' | ''
  spouseLivesInSwitzerland: string;  // 'yes' | 'no' | ''
  phone: string;
  email: string;
  addressStreet: string;
  addressZip: string;
  addressCity: string;
  ahvNumber: string;
  iban: string;
}

/** Extra fields only for NEW employee self-registration */
interface NewEmployeeExtras {
  firstName: string;
  lastName: string;
  desiredPosition: string;
  desiredStartDate: string;
  preferredEmploymentType: string;
}

const DOC_TYPES: { value: string; label: string }[] = [
  { value: 'id_card',  label: 'Personalausweis / Pass' },
  { value: 'permit',   label: 'Aufenthaltsbewilligung' },
  { value: 'ahv_card', label: 'AHV-Ausweis' },
  { value: 'other',    label: 'Sonstiges Dokument' },
];

const CONTRACT_TYPE_LABELS: Record<string, string> = {
  festanstellung: 'Festanstellung',
  aushilfe:       'Aushilfe / Stundenlohn',
};

// ─── Main Component ───────────────────────────────────────────────────────────

export default function OnboardingForm() {
  const { token } = useParams<{ token: string }>();
  const isNewMode = token === 'new'; // Generic self-registration link

  type Phase = 'loading' | 'error' | 'form' | 'success' | 'already-done';
  const [phase, setPhase]       = useState<Phase>(isNewMode ? 'form' : 'loading');
  const [errorMsg, setErrorMsg] = useState('');
  const [employee, setEmployee] = useState<OnboardingPublicEmployee | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const [formData, setFormData] = useState<SharedFormData>({
    birthDate: '', nationality: '', permitType: '', maritalStatus: '',
    spouseEmployed: '', spouseLivesInSwitzerland: '',
    phone: '', email: '',
    addressStreet: '', addressZip: '', addressCity: '',
    ahvNumber: '', iban: '',
  });

  const [newExtras, setNewExtras] = useState<NewEmployeeExtras>({
    firstName: '', lastName: '',
    desiredPosition: '', desiredStartDate: '',
    preferredEmploymentType: 'aushilfe',
  });

  const [pendingFiles, setPendingFiles] = useState<PendingFile[]>([]);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // ── Load existing employee by token ──────────────────────────────────────
  useEffect(() => {
    if (isNewMode) return; // no DB lookup for new mode
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
        birthDate:               emp.birthDate     ?? '',
        nationality:             emp.nationality   ?? '',
        permitType:              emp.permitType    ?? '',
        maritalStatus:           emp.maritalStatus ?? '',
        spouseEmployed:          emp.spouseEmployed === true ? 'yes' : emp.spouseEmployed === false ? 'no' : '',
        spouseLivesInSwitzerland: emp.spouseLivesInSwitzerland === true ? 'yes' : emp.spouseLivesInSwitzerland === false ? 'no' : '',
        phone:                   emp.phone         ?? '',
        email:                   emp.email         ?? '',
        addressStreet:           emp.addressStreet ?? '',
        addressZip:              emp.addressZip    ?? '',
        addressCity:             emp.addressCity   ?? '',
        ahvNumber:               emp.ahvNumber     ?? '',
        iban:                    emp.iban          ?? '',
      });
      if (emp.onboardingStatus !== 'in_progress') {
        await markOnboardingInProgress(emp.id);
      }
      setPhase('form');
    })();
  }, [token, isNewMode]);

  // ── Field helpers ─────────────────────────────────────────────────────────
  const setField = (field: keyof SharedFormData) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setFormData(prev => ({ ...prev, [field]: e.target.value }));

  const setExtra = (field: keyof NewEmployeeExtras) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setNewExtras(prev => ({ ...prev, [field]: e.target.value }));

  // ── File selection ────────────────────────────────────────────────────────
  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? []);
    const items: PendingFile[] = files.map(file => ({
      id:      crypto.randomUUID(),
      file,
      docType: 'other',
      status:  'pending' as const,
      preview: file.type.startsWith('image/') ? URL.createObjectURL(file) : undefined,
    }));
    setPendingFiles(prev => [...prev, ...items]);
    e.target.value = '';
  };

  const removeFile = (id: string) => {
    setPendingFiles(prev => {
      prev.find(f => f.id === id)?.preview && URL.revokeObjectURL(prev.find(f => f.id === id)!.preview!);
      return prev.filter(f => f.id !== id);
    });
  };

  const setDocType = (id: string, docType: string) =>
    setPendingFiles(prev => prev.map(f => f.id === id ? { ...f, docType } : f));

  // ── Upload files helper ───────────────────────────────────────────────────
  const uploadFiles = async (employeeId: string): Promise<OnboardingDoc[]> => {
    const docs: OnboardingDoc[] = [];
    const updated = pendingFiles.map(f => ({ ...f }));
    for (const pf of updated) {
      pf.status = 'uploading';
      setPendingFiles([...updated]);
      const doc = await uploadOnboardingFile(employeeId, pf.file, pf.docType);
      pf.status = doc ? 'done' : 'error';
      if (doc) { pf.doc = doc; docs.push(doc); }
      else {
        docs.push({ type: pf.docType, name: pf.file.name,
          path: `${employeeId}/${pf.docType}_${Date.now()}`, uploadedAt: new Date().toISOString() });
      }
      setPendingFiles([...updated]);
    }
    return docs;
  };

  // ── Helper: convert 'yes'/'no'/'' to boolean|null ─────────────────────────
  const toBool = (v: string): boolean | null =>
    v === 'yes' ? true : v === 'no' ? false : null;

  // ── Submit: NEW employee registration ─────────────────────────────────────
  const handleSubmitNew = async () => {
    const fullName = `${newExtras.firstName.trim()} ${newExtras.lastName.trim()}`.trim();
    if (!fullName) {
      setErrorMsg('Bitte geben Sie Ihren Vor- und Nachnamen ein.');
      return;
    }
    setSubmitting(true);
    setErrorMsg('');

    const tempId = crypto.randomUUID();
    const docs = await uploadFiles(tempId);

    const newId = await createPendingEmployee({
      name:                    fullName,
      employmentType:          newExtras.preferredEmploymentType || 'aushilfe',
      positionTitle:           newExtras.desiredPosition         || undefined,
      contractStart:           newExtras.desiredStartDate        || undefined,
      birthDate:               formData.birthDate                || undefined,
      nationality:             formData.nationality              || undefined,
      permitType:              formData.permitType               || undefined,
      maritalStatus:           formData.maritalStatus            || undefined,
      spouseEmployed:          toBool(formData.spouseEmployed),
      spouseLivesInSwitzerland: toBool(formData.spouseLivesInSwitzerland),
      phone:                   formData.phone                    || undefined,
      email:                   formData.email                    || undefined,
      addressStreet:           formData.addressStreet            || undefined,
      addressZip:              formData.addressZip               || undefined,
      addressCity:             formData.addressCity              || undefined,
      ahvNumber:               formData.ahvNumber                || undefined,
      iban:                    formData.iban                     || undefined,
      documents:               docs,
    });

    setSubmitting(false);
    if (newId) {
      setPhase('success');
    } else {
      setErrorMsg('Ihre Anmeldung konnte nicht gespeichert werden. Bitte versuchen Sie es erneut.');
    }
  };

  // ── Submit: EXISTING employee onboarding ──────────────────────────────────
  const handleSubmitExisting = async () => {
    if (!employee) return;
    setSubmitting(true);
    setErrorMsg('');
    const docs = await uploadFiles(employee.id);
    const ok = await submitOnboardingData(employee.id, {
      ...formData,
      spouseEmployed:           toBool(formData.spouseEmployed),
      spouseLivesInSwitzerland: toBool(formData.spouseLivesInSwitzerland),
    }, docs);
    setSubmitting(false);
    if (ok) {
      setPhase('success');
    } else {
      setErrorMsg('Beim Speichern ist ein Fehler aufgetreten. Bitte versuchen Sie es nochmals.');
    }
  };

  // ── Render ────────────────────────────────────────────────────────────────
  if (phase === 'loading')    return <LoadingScreen />;
  if (phase === 'error')      return <ErrorScreen message={errorMsg} />;
  if (phase === 'already-done') return <AlreadyDoneScreen name={employee?.name} />;
  if (phase === 'success') {
    return isNewMode
      ? <RegistrationSuccessScreen />
      : <SuccessScreen name={employee?.name} />;
  }

  const handleSubmit = isNewMode ? handleSubmitNew : handleSubmitExisting;
  const submitLabel = isNewMode ? 'Anmeldung absenden' : 'Daten absenden & Onboarding abschliessen';

  return (
    <div className="min-h-screen bg-slate-50">
      {/* ── Header ── */}
      <div className="bg-white border-b shadow-sm sticky top-0 z-10">
        <div className="max-w-2xl mx-auto px-4 py-4 flex items-center justify-between">
          <div>
            <p className="text-xs font-semibold tracking-widest text-slate-400 uppercase">oLiv Restaurant & Bar</p>
            <h1 className="text-lg font-bold text-slate-800">
              {isNewMode ? 'Neue Stelle – Anmeldung' : 'Mitarbeiter-Onboarding'}
            </h1>
          </div>
          <Badge variant="outline" className="text-amber-700 border-amber-300 bg-amber-50 text-xs">
            {isNewMode ? 'Selbst-Registrierung' : 'Formular ausfüllen'}
          </Badge>
        </div>
      </div>

      <div className="max-w-2xl mx-auto px-4 py-6 space-y-6">

        {/* ── Welcome banner ── */}
        <div className="bg-amber-50 border border-amber-200 rounded-xl p-4">
          <div className="flex items-start gap-3">
            <div className="mt-0.5 w-8 h-8 rounded-full bg-amber-200 flex items-center justify-center shrink-0 text-amber-800 font-bold text-sm">
              {isNewMode ? '+' : (employee?.name?.charAt(0) ?? '?')}
            </div>
            <div>
              {isNewMode ? (
                <>
                  <p className="font-semibold text-amber-900">Herzlich willkommen bei oLiv!</p>
                  <p className="text-sm text-amber-800 mt-0.5">
                    Füllen Sie dieses Formular aus, um sich für eine Stelle zu bewerben oder zu registrieren.
                    Ihre Angaben werden direkt an die Restaurantleitung übermittelt.
                  </p>
                </>
              ) : (
                <>
                  <p className="font-semibold text-amber-900">Willkommen, {employee?.name}!</p>
                  <p className="text-sm text-amber-800 mt-0.5">
                    Bitte füllen Sie das Formular vollständig aus. Ihre Daten werden sicher gespeichert und direkt in unser HR-System übertragen.
                  </p>
                </>
              )}
            </div>
          </div>
        </div>

        {/* ── Contract info (existing employees only) ── */}
        {!isNewMode && (employee?.positionTitle || employee?.contractStart || employee?.contractType) && (
          <Section icon={<FileText className="w-4 h-4" />} title="Ihre Stelle" color="blue">
            <div className="grid grid-cols-2 gap-4 text-sm">
              {employee?.positionTitle && <InfoRow label="Position" value={employee.positionTitle} />}
              {employee?.contractType  && <InfoRow label="Vertragsart" value={CONTRACT_TYPE_LABELS[employee.contractType] ?? employee.contractType} />}
              {employee?.contractStart && <InfoRow label="Eintritt ab" value={fmtDate(employee.contractStart)} />}
              <InfoRow label="Abteilung" value={employee?.department === 'kueche' ? 'Küche' : 'Service'} />
            </div>
          </Section>
        )}

        {/* ── NEW MODE: Identification + Position ── */}
        {isNewMode && (
          <>
            <Section icon={<User className="w-4 h-4" />} title="Ihr Name" color="amber">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div className="space-y-1.5">
                  <Label htmlFor="firstName">Vorname <span className="text-red-500">*</span></Label>
                  <Input id="firstName" placeholder="Vorname" value={newExtras.firstName} onChange={setExtra('firstName')} />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="lastName">Nachname <span className="text-red-500">*</span></Label>
                  <Input id="lastName" placeholder="Nachname" value={newExtras.lastName} onChange={setExtra('lastName')} />
                </div>
              </div>
            </Section>

            <Section icon={<Briefcase className="w-4 h-4" />} title="Stellenwunsch" color="blue">
              <div className="space-y-4">
                <div className="space-y-1.5">
                  <Label htmlFor="desiredPosition">Gewünschte Position / Stelle</Label>
                  <Input id="desiredPosition" placeholder="z.B. Servicemitarbeiterin, Koch, Barista"
                    value={newExtras.desiredPosition} onChange={setExtra('desiredPosition')} />
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <div className="space-y-1.5">
                    <Label htmlFor="desiredStartDate">Frühestmöglicher Eintrittstermin</Label>
                    <Input id="desiredStartDate" type="date"
                      value={newExtras.desiredStartDate} onChange={setExtra('desiredStartDate')} />
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="preferredEmploymentType">Beschäftigungsart</Label>
                    <Select value={newExtras.preferredEmploymentType}
                      onValueChange={v => setNewExtras(prev => ({ ...prev, preferredEmploymentType: v }))}>
                      <SelectTrigger id="preferredEmploymentType"><SelectValue /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="vollzeit">Vollzeit</SelectItem>
                        <SelectItem value="teilzeit">Teilzeit</SelectItem>
                        <SelectItem value="aushilfe">Aushilfe / Stundenlohn</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                </div>
              </div>
            </Section>
          </>
        )}

        {/* ── Persönliche Angaben ── */}
        <Section icon={<User className="w-4 h-4" />} title="Persönliche Angaben" color="slate">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div className="space-y-1.5">
              <Label htmlFor="birthDate">Geburtsdatum</Label>
              <Input id="birthDate" type="date" value={formData.birthDate} onChange={setField('birthDate')} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="nationality">Nationalität</Label>
              <Input id="nationality" placeholder="z.B. Schweiz, Deutschland"
                value={formData.nationality} onChange={setField('nationality')} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="permitType">Aufenthaltsstatus <span className="text-red-500">*</span></Label>
              <Select value={formData.permitType}
                onValueChange={v => setFormData(prev => ({ ...prev, permitType: v }))}>
                <SelectTrigger id="permitType"><SelectValue placeholder="Bitte wählen…" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="swiss">Schweizer Bürger/in</SelectItem>
                  <SelectItem value="C">Ausweis C – Niederlassungsbewilligung</SelectItem>
                  <SelectItem value="B">Ausweis B – Aufenthaltsbewilligung</SelectItem>
                  <SelectItem value="L">Ausweis L – Kurzaufenthaltsbewilligung</SelectItem>
                  <SelectItem value="G">Ausweis G – Grenzgängerbewilligung</SelectItem>
                  <SelectItem value="other">Andere / Sonstiges</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="maritalStatus">Zivilstand</Label>
              <Select value={formData.maritalStatus}
                onValueChange={v => setFormData(prev => ({ ...prev, maritalStatus: v }))}>
                <SelectTrigger id="maritalStatus"><SelectValue placeholder="Bitte wählen…" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="single">Ledig</SelectItem>
                  <SelectItem value="married">Verheiratet</SelectItem>
                  <SelectItem value="divorced">Geschieden</SelectItem>
                  <SelectItem value="widowed">Verwitwet</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
        </Section>

        {/* ── Quellensteuer-relevante Angaben (nur wenn B/L/G/other) ── */}
        {(() => {
          const isSwissOrC = formData.permitType === 'swiss' || formData.permitType === 'C';
          if (!formData.permitType || isSwissOrC) return null;
          const showSpouse = formData.maritalStatus === 'married';
          return (
            <Section icon={<Shield className="w-4 h-4" />} title="Quellensteuer-relevante Angaben" color="amber">
              <div className="bg-amber-50 border border-amber-200 rounded-lg p-3 mb-4">
                <div className="flex items-start gap-2">
                  <Info className="w-4 h-4 text-amber-700 mt-0.5 shrink-0" />
                  <p className="text-xs text-amber-800">
                    Als Person ohne Schweizer Bürgerrecht oder Niederlassungsbewilligung C unterliegen Sie in der Schweiz der <strong>Quellensteuer</strong> (direkt vom Lohn abgezogen).
                    Die folgenden Angaben werden für die Ermittlung des korrekten Quellensteuertarifs benötigt.
                  </p>
                </div>
              </div>

              {showSpouse && (
                <div className="space-y-4">
                  <div className="flex items-center gap-2 mb-2">
                    <Heart className="w-3.5 h-3.5 text-rose-500" />
                    <p className="text-xs font-semibold text-slate-700">Angaben zum Ehepartner / zur Ehepartnerin</p>
                  </div>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                    <div className="space-y-1.5">
                      <Label htmlFor="spouseEmployed">Ist Ihr/e Partner/in erwerbstätig?</Label>
                      <Select value={formData.spouseEmployed}
                        onValueChange={v => setFormData(prev => ({ ...prev, spouseEmployed: v }))}>
                        <SelectTrigger id="spouseEmployed"><SelectValue placeholder="Bitte wählen…" /></SelectTrigger>
                        <SelectContent>
                          <SelectItem value="yes">Ja, erwerbstätig</SelectItem>
                          <SelectItem value="no">Nein, nicht erwerbstätig</SelectItem>
                        </SelectContent>
                      </Select>
                      <p className="text-xs text-slate-500">Relevant für den Tarif (C1 vs. C2)</p>
                    </div>
                    <div className="space-y-1.5">
                      <Label htmlFor="spouseLivesInSwitzerland">Wohnt Ihr/e Partner/in in der Schweiz?</Label>
                      <Select value={formData.spouseLivesInSwitzerland}
                        onValueChange={v => setFormData(prev => ({ ...prev, spouseLivesInSwitzerland: v }))}>
                        <SelectTrigger id="spouseLivesInSwitzerland"><SelectValue placeholder="Bitte wählen…" /></SelectTrigger>
                        <SelectContent>
                          <SelectItem value="yes">Ja, Wohnsitz in der Schweiz</SelectItem>
                          <SelectItem value="no">Nein, Wohnsitz im Ausland</SelectItem>
                        </SelectContent>
                      </Select>
                      <p className="text-xs text-slate-500">Relevant für Tarifgruppe und Abzüge</p>
                    </div>
                  </div>
                </div>
              )}

              {!showSpouse && (
                <p className="text-xs text-slate-500">
                  Keine weiteren Angaben nötig. Bei einer zukünftigen Heirat bitte das HR-Team informieren.
                </p>
              )}
            </Section>
          );
        })()}

        {/* ── Kontaktdaten ── */}
        <Section icon={<Phone className="w-4 h-4" />} title="Kontaktdaten" color="slate">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div className="space-y-1.5">
              <Label htmlFor="phone">Telefonnummer</Label>
              <Input id="phone" type="tel" placeholder="+41 79 123 45 67"
                value={formData.phone} onChange={setField('phone')} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="email">E-Mail-Adresse</Label>
              <Input id="email" type="email" placeholder="vorname@mail.com"
                value={formData.email} onChange={setField('email')} />
            </div>
          </div>
        </Section>

        {/* ── Adresse ── */}
        <Section icon={<MapPin className="w-4 h-4" />} title="Adresse" color="slate">
          <div className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="addressStreet">Strasse und Hausnummer</Label>
              <Input id="addressStreet" placeholder="Musterstrasse 12"
                value={formData.addressStreet} onChange={setField('addressStreet')} />
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-1.5">
                <Label htmlFor="addressZip">PLZ</Label>
                <Input id="addressZip" placeholder="3011"
                  value={formData.addressZip} onChange={setField('addressZip')} />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="addressCity">Ort</Label>
                <Input id="addressCity" placeholder="Bern"
                  value={formData.addressCity} onChange={setField('addressCity')} />
              </div>
            </div>
          </div>
        </Section>

        {/* ── Bankdaten & AHV ── */}
        <Section icon={<CreditCard className="w-4 h-4" />} title="Bankdaten & Sozialversicherung" color="slate">
          <div className="bg-blue-50 border border-blue-200 rounded-lg p-3 mb-4">
            <p className="text-xs text-blue-800">
              Diese Angaben werden für die Lohnzahlung und Sozialversicherungsanmeldung benötigt. Sie werden sicher gespeichert.
            </p>
          </div>
          <div className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="ahvNumber">AHV-Nummer</Label>
              <Input id="ahvNumber" placeholder="756.XXXX.XXXX.XX"
                value={formData.ahvNumber} onChange={setField('ahvNumber')} />
              <p className="text-xs text-slate-500">13-stellige Nummer auf Ihrem AHV-Ausweis</p>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="iban">IBAN (Bankkonto für Lohnauszahlung)</Label>
              <Input id="iban" placeholder="CH56 0483 5012 3456 7800 9"
                value={formData.iban} onChange={setField('iban')} />
              <p className="text-xs text-slate-500">Schweizer IBAN, 21 Zeichen</p>
            </div>
          </div>
        </Section>

        {/* ── Dokumente ── */}
        <Section icon={<Paperclip className="w-4 h-4" />} title="Dokumente hochladen" color="slate">
          <p className="text-sm text-slate-600 mb-3">
            Bitte laden Sie ein Bild oder Scan Ihres Ausweises / Passes hoch.
          </p>
          {formData.permitType && formData.permitType !== 'swiss' && (
            <div className="bg-blue-50 border border-blue-200 rounded-lg p-3 mb-3 flex items-start gap-2">
              <Info className="w-4 h-4 text-blue-600 mt-0.5 shrink-0" />
              <p className="text-xs text-blue-800">
                <strong>Hinweis:</strong> Da Sie einen{' '}
                {formData.permitType === 'C' ? 'Ausweis C' :
                 formData.permitType === 'B' ? 'Ausweis B' :
                 formData.permitType === 'L' ? 'Ausweis L' :
                 formData.permitType === 'G' ? 'Ausweis G' : 'anderen Aufenthaltstitel'} besitzen,
                laden Sie bitte auch diesen Aufenthaltstitel hoch (Vorder- und Rückseite).
              </p>
            </div>
          )}
          {(!formData.permitType || formData.permitType === 'swiss') && (
            <p className="text-xs text-slate-500 mb-3">
              Optional können Sie auch weitere Dokumente beifügen.
            </p>
          )}
          <FileUploadArea
            files={pendingFiles}
            onSelect={handleFileSelect}
            onRemove={removeFile}
            onTypeChange={setDocType}
            disabled={submitting}
            fileInputRef={fileInputRef}
          />
        </Section>

        {/* ── Error ── */}
        {errorMsg && (
          <div className="flex items-start gap-2 p-4 bg-red-50 border border-red-200 rounded-xl text-red-800 text-sm">
            <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" />
            <span>{errorMsg}</span>
          </div>
        )}

        <Separator />

        {/* ── Submit ── */}
        <div className="pb-8">
          <Button size="lg" className="w-full bg-amber-600 hover:bg-amber-700 text-white"
            onClick={handleSubmit} disabled={submitting}>
            {submitting
              ? <><Loader2 className="w-4 h-4 mr-2 animate-spin" /> Wird gespeichert…</>
              : submitLabel
            }
          </Button>
          <p className="text-xs text-slate-400 text-center mt-2">
            Durch das Absenden stimmen Sie der Verarbeitung Ihrer Daten für Personalverwaltungszwecke zu.
          </p>
        </div>

      </div>
    </div>
  );
}

// ─── FileUploadArea ───────────────────────────────────────────────────────────

function FileUploadArea({
  files, onSelect, onRemove, onTypeChange, disabled, fileInputRef,
}: {
  files: PendingFile[];
  onSelect: (e: React.ChangeEvent<HTMLInputElement>) => void;
  onRemove: (id: string) => void;
  onTypeChange: (id: string, type: string) => void;
  disabled: boolean;
  fileInputRef: React.RefObject<HTMLInputElement>;
}) {
  return (
    <>
      {files.length > 0 && (
        <div className="space-y-2 mb-4">
          {files.map(pf => (
            <div key={pf.id} className="flex items-center gap-3 p-3 bg-slate-50 border rounded-lg">
              <div className="w-10 h-10 rounded flex items-center justify-center bg-white border shrink-0 overflow-hidden">
                {pf.preview
                  ? <img src={pf.preview} alt="" className="w-10 h-10 object-cover" />
                  : <FileText className="w-5 h-5 text-slate-400" />
                }
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium text-slate-700 truncate">{pf.file.name}</p>
                <p className="text-xs text-slate-400">{(pf.file.size / 1024).toFixed(0)} KB</p>
              </div>
              <Select value={pf.docType} onValueChange={v => onTypeChange(pf.id, v)}>
                <SelectTrigger className="w-44 text-xs h-8"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {DOC_TYPES.map(dt => (
                    <SelectItem key={dt.value} value={dt.value} className="text-xs">{dt.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {pf.status === 'uploading' && <Loader2 className="w-4 h-4 animate-spin text-blue-500 shrink-0" />}
              {pf.status === 'done'      && <CheckCircle2 className="w-4 h-4 text-green-500 shrink-0" />}
              {pf.status === 'error'     && <AlertCircle  className="w-4 h-4 text-red-500 shrink-0" />}
              {pf.status === 'pending'   && (
                <button onClick={() => onRemove(pf.id)} className="text-slate-400 hover:text-red-500 shrink-0">
                  <X className="w-4 h-4" />
                </button>
              )}
            </div>
          ))}
        </div>
      )}
      <input ref={fileInputRef} type="file" className="hidden" multiple accept="image/*,.pdf" onChange={onSelect} />
      <Button type="button" variant="outline" className="w-full border-dashed"
        onClick={() => fileInputRef.current?.click()} disabled={disabled}>
        <Upload className="w-4 h-4 mr-2" />
        Datei(en) auswählen
      </Button>
      <p className="text-xs text-slate-400 mt-2 text-center">JPG, PNG, WEBP oder PDF — max. 10 MB pro Datei</p>
    </>
  );
}

// ─── Section ─────────────────────────────────────────────────────────────────

function Section({
  icon, title, color = 'slate', children,
}: {
  icon: React.ReactNode;
  title: string;
  color?: 'slate' | 'blue' | 'amber';
  children: React.ReactNode;
}) {
  const cls: Record<string, string> = {
    slate: 'bg-slate-100 text-slate-700',
    blue:  'bg-blue-50 text-blue-700',
    amber: 'bg-amber-50 text-amber-700',
  };
  return (
    <div className="bg-white rounded-xl border shadow-sm overflow-hidden">
      <div className={`flex items-center gap-2 px-4 py-3 ${cls[color]} font-semibold text-sm`}>
        {icon}{title}
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

// ─── Status Screens ───────────────────────────────────────────────────────────

function LoadingScreen() {
  return (
    <div className="min-h-screen bg-slate-50 flex items-center justify-center">
      <div className="text-center space-y-3">
        <Loader2 className="w-8 h-8 animate-spin text-amber-500 mx-auto" />
        <p className="text-slate-600 text-sm">Daten werden geladen…</p>
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
          Wenden Sie sich bitte an oLiv Restaurant & Bar.
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

function RegistrationSuccessScreen() {
  return (
    <div className="min-h-screen bg-slate-50 flex items-center justify-center px-4">
      <div className="bg-white rounded-2xl border shadow-sm p-8 max-w-md w-full text-center space-y-4">
        <div className="w-16 h-16 rounded-full bg-amber-100 flex items-center justify-center mx-auto">
          <CheckCircle2 className="w-8 h-8 text-amber-600" />
        </div>
        <div>
          <p className="text-xs font-semibold tracking-widest text-slate-400 uppercase mb-1">oLiv Restaurant & Bar</p>
          <h2 className="text-xl font-bold text-slate-800">Anmeldung eingereicht!</h2>
          <p className="text-sm text-slate-500 mt-2">
            Vielen Dank für Ihre Anmeldung. Die Restaurantleitung wird Ihre Angaben prüfen und sich in Kürze bei Ihnen melden.
          </p>
        </div>
        <div className="bg-amber-50 border border-amber-200 rounded-lg p-3 text-xs text-amber-800">
          Ihre Daten wurden gespeichert. Bitte beachten Sie, dass keine Anstellungszusage gemacht wird, bis Sie von uns kontaktiert werden.
        </div>
        <p className="text-xs text-slate-400">Sie können dieses Fenster jetzt schliessen.</p>
      </div>
    </div>
  );
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function fmtDate(iso?: string): string {
  if (!iso) return '';
  try { const [y, m, d] = iso.split('-'); return `${d}.${m}.${y}`; }
  catch { return iso; }
}
