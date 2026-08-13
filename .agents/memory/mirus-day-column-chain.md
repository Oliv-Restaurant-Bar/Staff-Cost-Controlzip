---
name: MIRUS Tagesspalten-Kette
description: Tageszahl-Kopfzeile im «Tägliche Stunden»-Parser — dichteste aufsteigende Kette statt erste Fundstelle, sonst fällt Tag 1 still aus der Referenz
---

Regel: `resolveDayNumberColumns` wählt die Tagesspalten als beste STRENG aufsteigende Kette (DP: max. Länge, Tie-Break kleinste Spaltenspanne — echte Mirus-Kopfzeilen liegen in Nachbarspalten). Wache: deckt die Kette nicht alle verschiedenen Tageszahlen der Zeile ab → Zeile verwerfen (fail-closed). `cellToIntDay` akzeptiert auch Wochentags-Labels («Sa 1», «1 Sa»).

**Why:** 08/2026 Beaulieu «01.–12.08.»: eine Streuzahl «1» in einer Vorspalte stahl per «erste Fundstelle gewinnt» die Tag-1-Spalte (Samstag 01.08.). Die Tag-1-Stunden fehlten still in Datei-Referenz/Toast/Gegenprüfung → Fehlalarme «Gegenprüfung fehlgeschlagen» bei korrekten gespeicherten Werten; Fehldiagnose «wegen behalten-Entscheidungen».

**How to apply:** Bei Änderungen an der Spaltenauflösung beide Regressionsfälle in mirus-parser.test.ts intakt halten (Streuzahl vor den Tagesspalten; Kopfzelle «Sa 1»). Span-Tie-Break oder Distinct-Days-Wache nur mit neuer echter Fixture lockern.
