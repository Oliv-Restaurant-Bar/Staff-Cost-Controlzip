---
name: Lieferantenidentität MWST-first
description: Fachliche Identitäts- und Sicherheitsregeln für Lieferanten-Aliasse, Monatsrechnungen und Dublettenbereinigung.
---

Lieferanten werden primär über die normalisierte MWST-Nummer identifiziert. Sind auf beiden Seiten MWST-Nummern vorhanden und verschieden, dürfen die Datensätze niemals matchen, sich ersetzen oder gemeinsam zur Bereinigung angeboten werden. Fehlt mindestens eine Nummer bei Legacy-Daten, gilt der kanonische Name als Fallback; dabei werden Schreibweise, Leerraum, Rechtsformen und Klammerzusätze ignoriert.

**Why:** Namensvarianten desselben Lieferanten sollen keine doppelten Kreditoren oder doppelt zählenden Monatsbelege erzeugen. Umgekehrt darf ein gleicher Handelsname bei unterschiedlichen bekannten MWST-Nummern nie zu einer destruktiven Fehlzusammenführung führen.

**How to apply:** Dieselbe Identitätsregel muss in Importvorschau, Schreibkern, Monatsrechnungs-Ersetzung, Kreditorenabgleich und Dublettenbereinigung gelten. Bereinigungen bleiben mandantengekeyt; der beim Öffnen gewählte Mandant wird für die Aktion eingefroren und ein zwischenzeitlicher Wechsel bricht den Schreibvorgang ab.