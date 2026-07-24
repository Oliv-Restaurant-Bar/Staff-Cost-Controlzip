-- Personaleintritt v2 (Auftrag Punkt 9): Ablage-Pfad des gefüllten
-- SEM-Meldeformulars (privater Bucket mitarbeiter-dokumente).
-- Additiv + idempotent; RLS der Tabelle bleibt unverändert.

alter table public.personaleintritt
  add column if not exists sem_formular_path text;

comment on column public.personaleintritt.sem_formular_path is
  'Storage-Pfad des gefüllten SEM-Meldeformulars (editierbare Variante), Bucket mitarbeiter-dokumente';
