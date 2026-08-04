-- Personaleintritt: Dossier-PDF (Auftrag Punkt 10)
-- Ablagepfad des erzeugten Dossier-PDFs (Q&A aller Phasen + Anhänge)
-- im privaten Bucket mitarbeiter-dokumente/<tenant>/<id>/dossier.pdf.

alter table public.personaleintritt
  add column if not exists dossier_path text;

comment on column public.personaleintritt.dossier_path is
  'Bucket-Pfad des Personaleintritt-Dossiers (PDF mit Fragen/Antworten aller Phasen + eingebetteten Anhängen), Auftrag Punkt 10.';
