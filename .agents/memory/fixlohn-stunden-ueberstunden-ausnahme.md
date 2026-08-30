---
name: Fixlohn-Stunden trotz Überstunden-Ausnahme
description: Fachliche Trennung von geleisteten Stunden, Fixlohnkosten und Ausnahme vom Überstunden-Konto.
---

Mitarbeiter mit «kein ÜStd-Konto» bleiben nur in der Überstundenrechnung ausgenommen. Ihre vollen Ist-Dienstplanstunden zählen weiterhin in Tages-, Wochen- und Monatssummen, Besatzung, Produktivität und PKQ.

**Why:** Lokaj Mendim und Ramadani Mejdi sind Fixlohn-Mitarbeiter. Eine frühere Vermischung von Überstunden-Ausnahme und Zusatzkosten-Markierungen reduzierte sichtbare Ist-Stunden und erzeugte bei Mejdi fälschlich stundenbasierte Kosten.

**How to apply:** Stunden und Kosten immer getrennt aggregieren. Fixlohnstunden zählen aus `actual_hours`; Fixlohnkosten kommen aus dem Monatslohn und dürfen sich bei geänderten Ist-Stunden nicht verändern. Nur das dedizierte Überstunden-Konto darf die Ausnahme-Map auswerten.