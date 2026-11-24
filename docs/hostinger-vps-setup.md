# Software Factory auf einem Hostinger VPS einrichten

Schritt für Schritt vom leeren Server bis zum ersten Pull Request, den die Factory für dich entwickelt.

> 🚧 **Erste Version, nicht production-ready.** Die Factory ist ein funktionierender Startpunkt zum Ausprobieren und Weiterentwickeln. Lass sie zuerst auf Test-Projekten laufen, bevor du ihr echte Kundenprojekte gibst.

**Dauer:** etwa 30–45 Minuten, davon viel Warten auf Installationen.

**Du brauchst:**

- einen Hostinger VPS (empfohlen: **KVM 2** mit 2 CPU-Kernen und 8 GB RAM)
- ein Claude-Abo (Pro, Max, Team oder Enterprise) **oder** einen Anthropic-API-Key
- einen GitHub-Account
- auf deinem Rechner: [Claude Code](https://code.claude.com), `git` und die [GitHub CLI](https://cli.github.com) (`gh`)

---

## 1. Den Server bestellen

1. Geh auf **[hostinger.com/alexclaude](https://hostinger.com/alexclaude)** und wähl den **KVM 2**.
2. Wähl die Laufzeit. Ich empfehle mindestens 12 Monate; mit 24 Monaten sparst du am meisten. Bei Jahresplänen bekommst du außerdem eine Domain gratis dazu.
3. Gib im Warenkorb den Code **`ALEXCLAUDE`** ein. Damit sparst du noch einmal 10 % auf den aktuellen Preis.
4. Bei der Einrichtung im hPanel wählst du als Betriebssystem die Vorlage **Ubuntu 24.04 mit Claude Code**. Lege dabei ein sicheres **Root-Passwort** fest (oder hinterlege direkt deinen SSH-Key).

Hostinger hat eine 30-Tage-Geld-zurück-Garantie. Falls ein eigener Server doch nichts für dich ist, kannst du ihn innerhalb dieser Zeit zurückgeben.

> Du kannst auch einen anderen Ubuntu-24.04-Server nehmen. Die Anleitung ist auf Hostinger getestet; dort ist Claude Code durch die Vorlage schon installiert.

## 2. Mit dem Server verbinden

Die IP-Adresse deines Servers findest du im hPanel in der Übersicht deines VPS. Öffne auf deinem Rechner ein Terminal:

```bash
ssh root@DEINE-SERVER-IP
```

- Beim ersten Mal fragt das Terminal, ob du dem Server vertraust. Bestätige mit `yes`.
- Dann gibst du das Root-Passwort ein. Beim Tippen siehst du nichts, das ist normal. Hast du einen SSH-Key hinterlegt, fragt dein Rechner stattdessen nach dessen Passphrase (oder gar nicht, wenn er sie gespeichert hat).

Kein Terminal zur Hand? Im hPanel gibt es auch ein **Browser-Terminal**, damit geht alles Folgende direkt im Browser.

Alle Befehle in den Schritten 3 bis 6 führst du **auf dem Server** aus.

## 3. Die Factory installieren

```bash
git clone https://github.com/AlexPEClub/software-factory.git /opt/software-factory
cd /opt/software-factory
./setup.sh
```

Das Skript installiert Docker, die GitHub CLI und Bun, legt die Konfiguration unter `/etc/software-factory/` an, baut das Image für die Agent-Container und richtet den Runner als Systemdienst ein. Beim ersten Mal dauert das ein paar Minuten.

> **Tipp:** Willst du später die Verbesserungs-Vorschläge der Factory nutzen (Schritt 11), forke das Repo vorher auf GitHub und klone deinen Fork statt `AlexPEClub/software-factory`. Die Factory erkennt das automatisch.

Am Ende listet es auf, was noch fehlt. Das sind die nächsten drei Schritte. Du kannst `./setup.sh` jederzeit erneut ausführen; schon Installiertes wird übersprungen.

## 4. Claude anmelden

Die Factory nutzt die offizielle Claude Code CLI mit deinem eigenen Login.

**Variante A: dein Claude-Abo.** Führe **auf deinem Rechner** (nicht auf dem Server) aus:

```bash
claude setup-token
```

Du meldest dich im Browser an und bekommst einen langen Token, der mit `sk-ant-oat` beginnt. Diesen Weg dokumentiert Anthropic für Skripte und Automatisierung.

Dann **auf dem Server** speichern, ohne dass der Token im Verlauf landet. Füge den Token ein, drück **Enter** und dann **Strg+D**:

```bash
stty -echo; printf "Token einfügen, dann Enter und Strg+D: "; T=$(cat | tr -d '[:space:]'); stty echo; echo; printf 'CLAUDE_CODE_OAUTH_TOKEN=%s\n' "$T" > /etc/software-factory/secrets.env && chmod 600 /etc/software-factory/secrets.env && unset T && awk -F= '{print length($2) " Zeichen"}' /etc/software-factory/secrets.env
```

Der Befehl zeigt am Ende die Länge des Tokens. Sie sollte deutlich über 100 Zeichen liegen. Das Terminal bricht den langen Token oft auf zwei Zeilen um; der Befehl liest deshalb bis Strg+D und entfernt Zeilenumbrüche. Ist die Zahl trotzdem viel kleiner, wiederhol ihn einfach.

**Wichtig zu den Limits:** Die Factory verbraucht dieselben Nutzungslimits wie deine normale Arbeit mit Claude. Wenn sie nachts entwickelt, hast du morgens entsprechend weniger übrig.

**Variante B: API-Key.** Für Teams oder wenn du die Factory als Dienst für andere betreibst, nimm einen Anthropic-API-Key aus der [Console](https://console.anthropic.com). Abgerechnet wird dann nach Verbrauch:

```bash
stty -echo; printf "API-Key einfügen, dann Enter und Strg+D: "; K=$(cat | tr -d '[:space:]'); stty echo; echo; printf 'ANTHROPIC_API_KEY=%s\n' "$K" > /etc/software-factory/secrets.env && chmod 600 /etc/software-factory/secrets.env && unset K && echo "gespeichert"
```

Mehr dazu: [Authentication](https://code.claude.com/docs/en/authentication) und [Legal and Compliance](https://code.claude.com/docs/en/legal-and-compliance) in der Claude-Code-Doku. Anthropic kann die Regeln ändern; prüf die Doku, bevor du startest.

## 5. GitHub anmelden

```bash
gh auth login -s project
```

Wähle **GitHub.com**, **HTTPS** und die Anmeldung über den Browser. Du bekommst einen Code angezeigt, den du auf deinem Rechner unter github.com/login/device eingibst.

`-s project` gibt der Factory zusätzlich das Recht, dein Kanban-Board (GitHub Projects) zu bearbeiten. Ohne diese Berechtigung kann sie die Karten nicht verschieben.

## 6. Die Factory starten

```bash
systemctl restart software-factory
journalctl -u software-factory -f
```

In den Logs solltest du `runner:started` sehen. Mit `Strg+C` beendest du die Anzeige, die Factory läuft weiter. Nur die neuesten Einträge zeigt `journalctl -u software-factory -f --since "5 min ago"`.

Noch hat die Factory kein Projekt. Bis du in Schritt 8 eins anbindest, meldet sie jede Minute einen `repo:error` für das Platzhalter-Repo `DEIN-GITHUB-NAME/dein-repo`. Das ist normal.

## 6b. Vorschau mit HTTPS (empfohlen)

Für jeden fertigen Pull Request startet die Factory eine Vorschau der App, mit Passwort geschützt. Damit das Passwort verschlüsselt übertragen wird und der Link auch auf dem Handy ohne Warnung aufgeht, braucht die Vorschau eine Domain. Bei Jahresplänen von Hostinger ist eine Domain gratis dabei; eine Subdomain einer vorhandenen Domain reicht aber auch.

1. Leg bei deinem Domain-Anbieter einen **A-Eintrag** an: z. B. `vorschau.deine-domain.de` → IP deines Servers. Bei Hostinger geht das im hPanel unter **Domains → DNS**.
2. Trag die Subdomain auf dem Server ein und starte die Factory neu:

   ```bash
   jq '.preview.domain = "vorschau.deine-domain.de"' /etc/software-factory/config.json > /tmp/c && mv /tmp/c /etc/software-factory/config.json && chmod 600 /etc/software-factory/config.json
   systemctl restart software-factory
   ```

3. Kurz testen (das kann beim ersten Mal eine Minute dauern, bis das Zertifikat da ist):

   ```bash
   curl -sI https://vorschau.deine-domain.de | head -1
   ```

Die Zertifikate holt sich der Webserver Caddy automatisch von Let's Encrypt. Dafür müssen die Ports 80 und 443 erreichbar sein (siehe Firewall in Schritt 13).

Ohne Domain funktioniert die Vorschau auch, dann aber nur über einfaches HTTP mit der IP-Adresse.

### Weitere Dienste auf demselben Server (optional)

Caddy der Factory (`sf-caddy`) belegt die Ports 80 und 443. Die Datei `/etc/software-factory/Caddyfile` gehört allein der Factory: Sie schreibt sie bei jeder Vorschau-Änderung komplett neu. **Nicht von Hand ändern.** Soll ein anderer Dienst auf diesem Server (z. B. die Staging-Umgebung deiner App) über Caddy erreichbar sein, leg seine Site-Blöcke als eigene Datei ab:

```
/etc/software-factory/sites.d/<dienst>.caddy      # z. B. meine-app.caddy, Eigentümer root, 644
```

- Die Factory bindet alle `*.caddy`-Dateien dort per `import` ein und merkt Änderungen innerhalb einer Minute (`pollSeconds`). Änderungen an einer schon eingebundenen Datei sofort übernehmen: `docker exec sf-caddy caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile` (eine ganz neue Datei bindet erst die Factory ein).
- Vorher prüft sie die gesamte Konfiguration mit `caddy validate`. Ist sie mit den Site-Dateien ungültig, lässt sie sie weg, damit die Vorschauen weiterlaufen, und meldet `caddy:sites-invalid` im Log (`journalctl -u software-factory`).
- Soll der Dienst **die Vorschau-Domain selbst** auf Port 443 bedienen (z. B. `vorschau.deine-domain.de` als Staging), schalte den Hinweis-Block der Factory ab, sonst wäre die Domain doppelt vergeben: `preview.domainBlock` auf `false` setzen und die Factory neu starten. Die Vorschauen auf den Ports 4001 ff. laufen unverändert weiter.

```bash
jq '.preview.domainBlock = false' /etc/software-factory/config.json > /tmp/c && mv /tmp/c /etc/software-factory/config.json && chmod 600 /etc/software-factory/config.json
systemctl restart software-factory
```

## 6c. Monitoring und Alarme (optional)

Für Projekte, die die Factory bis in staging und production bringt (Betriebskonventionen, `docs/proposals/betriebskonventionen.md`), gibt es drei Bausteine. Du kannst sie einzeln einschalten:

- **Observability-Stack:** Grafana, Loki und Prometheus auf diesem Server. Alle Hosts schicken ihre Logs und Metriken hierher, je Projekt gibt es ein fertiges Dashboard. Technische Details: [`ops/observability/README.md`](../ops/observability/README.md).
- **Incident-Intake:** Der Runner fragt bei jedem Durchlauf healthchecks.io und Grafana nach aktiven Alarmen und öffnet je Alarm genau ein Issue mit Label `incident` im Repo des Projekts. Ist der Alarm vorbei, kommentiert und schließt er es.
- **Heartbeat der Factory:** Der Runner meldet sich nach jedem Durchlauf bei healthchecks.io. Fällt der Server aus, schreibt dir healthchecks.io eine E-Mail. Ein Issue kann ein ausgefallener Server nicht mehr anlegen.

> **Arbeitsspeicher:** Der Stack braucht bis zu 1,4 GB. Auf dem KVM 2 (8 GB) reicht das neben zwei Agent-Läufen (je 3 GB) und einer Vorschau nicht. Setz dann `maxParallel` auf `1` oder nimm einen größeren Server (KVM 4).

### Observability-Stack

Voraussetzung ist die Vorschau mit HTTPS (Schritt 6b): Der Stack läuft hinter dem Caddy der Factory, und der holt Zertifikate nur, wenn `preview.domain` gesetzt ist.

1. Leg einen weiteren **A-Eintrag** an, z. B. `grafana.deine-domain.de` → IP deines Servers.
2. Domain eintragen und den Stack einrichten:

   ```bash
   jq '.observability.domain = "grafana.deine-domain.de"' /etc/software-factory/config.json > /tmp/c && mv /tmp/c /etc/software-factory/config.json && chmod 600 /etc/software-factory/config.json
   cd /opt/software-factory && ./setup.sh
   ```

   `setup.sh` startet den Stack, sobald `observability.domain` gesetzt ist (sonst überspringt es ihn). Später genügt `factory-obs install`. Dabei entstehen das Admin-Passwort für Grafana und ein Lese-Token für den Runner, beide in `/etc/software-factory/secrets.env`.
3. Nach etwa einer Minute ist Grafana unter `https://grafana.deine-domain.de` erreichbar. Login `admin`, das Passwort zeigt:

   ```bash
   grep ^GRAFANA_ADMIN_PASSWORD= /etc/software-factory/secrets.env | cut -d= -f2
   ```

4. Für jeden Host, der Logs und Metriken schicken soll (je Projekt und Umgebung), einen Zugang anlegen:

   ```bash
   factory-obs ingest-user meine-app-staging
   ```

   Die vier ausgegebenen Werte (`OBS_LOGS_URL`, `OBS_METRICS_URL`, `OBS_USER`, `OBS_PASSWORD`) trägst du als Secrets der Umgebung in Infisical ein. Das Passwort wird nur dieses eine Mal angezeigt. Auf dem Host sammelt Grafana Alloy die Daten, die Vorlage dafür ist `ops/observability/alloy/host.alloy`.

Das Dashboard findest du in Grafana unter **Dashboards → Factory → Projekt**. Logs und Metriken bleiben 30 Tage. Weitere Befehle: `factory-obs compose ps`, `factory-obs compose logs loki`, `factory-obs ingest-remove NAME`.

### Alarme als Issues

1. **healthchecks.io:** Leg ein Konto an (Free-Tarif „Hobbyist“: 20 Checks). Die Checks der Projekte heißen `<projekt>-<umgebung>` für den Heartbeat, `<projekt>-<umgebung>-backup` und `<projekt>-<umgebung>-restore-test`, alternativ trägt ein Check den Projektnamen als Tag. Daran erkennt der Runner das Projekt.
2. Unter **Settings → API Access** einen **nur lesenden** API-Schlüssel erzeugen und auf dem Server speichern (der Schlüssel landet nicht im Verlauf):

   ```bash
   stty -echo; printf "API-Schlüssel einfügen, dann Enter und Strg+D: "; K=$(cat | tr -d '[:space:]'); stty echo; echo; grep -v '^HEALTHCHECKS_API_KEY=' /etc/software-factory/secrets.env > /tmp/s; printf 'HEALTHCHECKS_API_KEY=%s\n' "$K" >> /tmp/s; install -m 600 /tmp/s /etc/software-factory/secrets.env; rm /tmp/s; unset K; echo gespeichert
   ```

3. Projekte den Repos zuordnen und den Intake einschalten. Der Projektname ist derselbe wie `project` in der `.factory/delivery.json` des Projekts:

   ```bash
   jq '.incidents.enabled = true | .incidents.projects = {"meine-app": "dein-name/meine-app"} | .incidents.fallbackRepo = "dein-name/software-factory"' /etc/software-factory/config.json > /tmp/c && mv /tmp/c /etc/software-factory/config.json && chmod 600 /etc/software-factory/config.json
   systemctl restart software-factory
   ```

   `fallbackRepo` (optional) bekommt Alarme, die keinem Projekt zugeordnet sind, z. B. die des Factory-Servers selbst (Projekt `factory`). Ohne `fallbackRepo` stehen sie nur im Log (`incident:unmapped`).

Was der Runner tut:

- Je Alarm genau ein offenes Issue mit Label `incident`. Hält der Alarm an, kommt kein zweites dazu. Ein Check zählt als Alarm, sobald healthchecks.io ihn auf **down** setzt (nach Ablauf der Karenzzeit).
- Ist der Alarm vorbei, kommentiert er das Issue und schließt es. Ist healthchecks.io oder Grafana gerade nicht erreichbar, schließt er nichts.
- Schließt du ein Issue, solange der Alarm noch läuft, öffnet er kein neues. Erst ein neuer Alarm nach der Erholung bekommt wieder ein Issue.
- Issues mit `incident` oder `deploy-failed` (die öffnet die Pipeline bei einem fehlgeschlagenen Deploy) bearbeitet die Factory **nie**, auch nicht, wenn jemand das Label `factory` dazusetzt. Soll sie sich um einen Incident kümmern, leg ein eigenes Issue mit Label `factory` an und verweis darauf.

### Heartbeat der Factory

1. In healthchecks.io einen Check `factory-runner` anlegen: Zeitraum 1 Minute (wie `pollSeconds`), Karenzzeit 10 Minuten, Benachrichtigung per E-Mail.
2. Seine Ping-URL eintragen:

   ```bash
   jq '.heartbeatUrl = "https://hc-ping.com/DEINE-UUID"' /etc/software-factory/config.json > /tmp/c && mv /tmp/c /etc/software-factory/config.json && chmod 600 /etc/software-factory/config.json
   systemctl restart software-factory
   ```

Der Runner pingt nach jedem Durchlauf, auch wenn einzelne Repos Fehler melden. Bleibt der Ping aus, läuft der Runner nicht mehr oder Docker hängt.

## 7. Deinen Rechner vorbereiten

Ab hier arbeitest du **auf deinem Rechner**. Die Specs schreibst du lokal mit Claude Code; die Factory bekommt nur das fertige Ergebnis.

Klone das Factory-Repo auch lokal und installiere die drei lokalen Skills:

```bash
git clone https://github.com/AlexPEClub/software-factory.git
cd software-factory
./scripts/install-local-skills.sh
```

Danach hast du in jedem Projekt diese Befehle in Claude Code (eine laufende Claude-Code-Sitzung vorher neu starten):

- `/init`: richtet ein Projekt ein (Produktbeschreibung, Stack, Design, Feature-Liste)
- `/write-spec`: erarbeitet mit dir im Interview die Spezifikation für ein Feature
- `/to-factory`: übergibt eine fertige Spec als GitHub Issue an die Factory

Die Skills sind Verknüpfungen auf diesen Ordner. Updates holst du dir mit `git pull` darin. **Verschieb oder lösch den Ordner danach nicht**, sonst findet Claude Code die Skills nicht mehr. Hast du ihn doch verschoben, führ `./scripts/install-local-skills.sh` am neuen Ort einfach noch einmal aus.

## 8. Ein Projekt anbinden

Die Factory arbeitet nur in Repos, die du ihr ausdrücklich gibst. Dabei legt sie die Status-Labels und die Labels `incident` und `deploy-failed` im Repo an, dazu die GitHub-Umgebungen `staging` und `production` für Deploys (nur Branch `main`, production zusätzlich mit deiner Freigabe), trägt es in ihre Konfiguration ein und erstellt beim ersten Mal das Kanban-Board „Software Factory“ in deinem GitHub-Account.

### Neues Projekt (empfohlen)

Der schnellste Weg ist die Projekt-Vorlage. Wechsle auf deinem Rechner in den Ordner, in dem das Projekt liegen soll (z. B. `~/Projects`), und sag dem Skript, wo dein Server ist. Einen Projektordner musst du nicht vorher anlegen, das Skript erstellt ihn selbst:

```bash
export FACTORY_SERVER=root@DEINE-SERVER-IP
~/software-factory/scripts/new-project.sh mein-projekt
```

(Den Pfad zum Skript passt du an den Ort an, an den du die Factory in Schritt 7 geklont hast.)

Das Skript erledigt drei Dinge auf einmal:

1. Es legt auf GitHub ein privates Repo aus der Vorlage an. Mit `--public` am Ende wird es öffentlich.
2. Es klont das Repo in den aktuellen Ordner.
3. Es bindet das Repo per SSH an deine Factory an, inklusive Labels und Board. Den Link zum Board zeigt es am Ende an.

Dann im neuen Projektordner:

1. Leg eine kurze Projektbeschreibung als `docs/briefing.md` ab: Was soll entstehen, für wen, was ist wichtig?
2. Starte Claude Code und führe `/init` aus. Claude stellt dir Fragen und legt daraus Produktbeschreibung, Stack, Design-Vorgaben und die Feature-Liste an, inklusive `.factory/setup.json` mit den Befehlen für Installation, Start und Prüfungen.
3. Prüf das Ergebnis und push es.

### Bestehendes Repo

Ein Repo, das es schon gibt, bindest du **auf dem Server** an:

```bash
cd /opt/software-factory
./scripts/add-repo.sh dein-github-name/dein-repo
```

Führ danach im Projekt auf deinem Rechner ebenfalls `/init` aus, damit die Factory Stack und Prüfbefehle kennt.

Für jedes weitere Projekt wiederholst du einfach einen der beiden Wege. Alle Repos landen auf demselben Board; einen Neustart der Factory brauchst du nicht.

## 9. Die erste Aufgabe übergeben

1. In Claude Code: `/write-spec`. Claude arbeitet die Spec im Interview mit dir aus und legt sie unter `features/PROJ-1-name/spec.md` ab.
2. Lies die Spec durch. **Die Spec ist der Vertrag:** Die Factory entwickelt genau das, was drinsteht, und ändert sie nie.
3. Commit und push.
4. `/to-factory`. Das legt ein GitHub Issue mit dem Label `factory` an, das auf die Spec zeigt.

Innerhalb einer Minute übernimmt die Factory. Den Fortschritt siehst du auf dem Board:

| Status | Was passiert | Was du tust |
|---|---|---|
| **Neu** | Issue wurde angelegt | – |
| **In Prüfung** | Ein Agent prüft, ob die Spec testbar und widerspruchsfrei ist, und schreibt Testszenarien | – |
| **Rückfrage** | Etwas ist unklar | Im Issue antworten |
| **Abgelehnt** | So nicht umsetzbar | Spec überarbeiten, pushen, im Issue kommentieren |
| **Freigegeben** | Wartet auf einen freien Platz | – |
| **In Arbeit** | Ein zweiter Agent entwickelt: Architektur, Umsetzung, Tests | – |
| **Abnahme** | Ein dritter, unabhängiger Agent testet die Szenarien im Browser. Der Entwickler-Agent hat sie nie gesehen. Findet er Fehler, geht es zurück in die Arbeit (höchstens zweimal). Ist es danach immer noch nicht bestanden, landet der PR mit dem deutlichen Hinweis „Abnahme nicht bestanden“ bei dir | – |
| **Review** | Pull Request mit Belegen und Vorschau ist fertig | Prüfen und mergen |
| **Fertig** | Gemergt | – |
| **Fehlgeschlagen** | Technisch hängen geblieben | Im Issue kommentieren, dann versucht die Factory es erneut |
| **Pausiert** | Nutzungslimit von Claude Code erreicht. Bis zum Reset startet die Factory für kein Issue einen Lauf. Danach setzt sie den Lauf automatisch fort, mit derselben Session und demselben Arbeitsstand (höchstens fünfmal) | – |

Bei jeder Rückfrage, Ablehnung oder Fehlermeldung genügt ein Kommentar im Issue. Die Factory sieht ihn beim nächsten Durchlauf und macht weiter.

**Bugs** brauchen keine Spec: Leg ein Issue mit dem Label `factory` an und beschreib, was falsch ist und was du stattdessen erwartest.

## 10. Ergebnis prüfen und mergen

Im Pull Request findest du, was umgesetzt wurde, jedes Akzeptanzkriterium mit Ergebnis, die Annahmen der Factory, die Ergebnisse der Prüfungen, Screenshots und den Bericht der Abnahme. Ganz unten steht eine Einschätzung: „Sicher“ oder „Bitte genau prüfen“.

**Vorschau:** Für jeden Pull Request startet die Factory die App auf deinem Server. Den Link postet sie als Kommentar, z. B. `https://vorschau.deine-domain.de:4001` (mit Domain, siehe Schritt 6b) oder `http://DEINE-SERVER-IP:4001` (ohne). Login: Nutzer `factory`, das Passwort steht auf dem Server:

```bash
jq -r .preview.password /etc/software-factory/config.json
```

Standardmäßig läuft eine Vorschau gleichzeitig (`preview.max`). Nach Merge oder Schließen des Pull Requests wird sie entfernt. Die Vorschau bekommt keine Zugangsdaten: Der Code der App kann weder auf GitHub noch auf Claude zugreifen.

> Ohne Domain läuft die Vorschau über einfaches HTTP. Das Passwort hält Zufallsbesucher fern, wird aber unverschlüsselt übertragen. Richte deshalb am besten HTTPS ein (Schritt 6b) und zeig über die Vorschau keine echten Kundendaten.

Gefällt dir etwas nicht, schreib es ins Issue. Die Factory arbeitet dann am selben Pull Request weiter. Passt alles, mergst du. **Gemergt wird immer von dir, nie von der Factory.**

## 11. Messen und verbessern

Jeder Lauf wird mit Dauer, Schritten und Ergebnis gespeichert. Auswertung auf dem Server:

```bash
factory-stats                          # alles
factory-stats --tage 7                 # letzte Woche
factory-stats --seit 2026-11-20        # ab einem Datum, z. B. seit einer Änderung
```

Du siehst unter anderem die Laufzeit pro Aufgabe, wie oft die Prüfung zurückfragt und wie oft die Abnahme beim ersten Mal besteht.

**Verbesserungs-Lauf:** Die Factory kann ihre eigenen Läufe auswerten und konkrete Änderungen an Playbook und Skills vorschlagen:

```bash
factory-improve
```

Ein Agent schaut sich Metriken, Rückfragen, Abnahme-Befunde und deine Änderungswünsche an. Findet er ein Muster mit mindestens zwei Belegen, öffnet er einen Pull Request in **deiner Kopie** des Factory-Repos (`factoryRepo` in der Konfiguration). Sonst legt er ein Issue mit der Auswertung an. Sinnvoll wird das ab etwa 20 Läufen.

Hast du einen Verbesserungs-PR gemergt, holst du die neue Version auf den Server:

```bash
factory-rollout
```

> Damit Verbesserungs-PRs bei dir landen, brauchst du eine eigene Kopie: Hast du auf dem Server deinen Fork geklont (Tipp in Schritt 3), trägt `add-repo.sh` ihn automatisch als `factoryRepo` ein. Sonst kannst du ihn später in `/etc/software-factory/config.json` eintragen.

## 12. Einstellungen

Die Konfiguration liegt in `/etc/software-factory/config.json`. Die wichtigsten Werte:

| Feld | Standard | Bedeutung |
|---|---|---|
| `maxParallel` | `2` | Wie viele Agent-Läufe gleichzeitig laufen (Prüfung, Entwicklung, Abnahme, Verbesserung), über alle Repos zusammen |
| `model` | `opus` | Modell für alle Agents |
| `language` | `de` | Factory-Sprache: Spalten des gemeinsamen Boards und Hinweise auf dem Server (`de` oder `en`). Die Sprache der Ausgaben in einem Projekt (Issues, PRs, Dokumente) steht in dessen `.factory/setup.json` → `language`, siehe README |
| `jobTimeoutMinutes` | `90` | Danach wird ein Lauf abgebrochen |
| `containerMemory` | `3g` | Arbeitsspeicher pro Agent-Container |
| `preview.max` | `1` | Gleichzeitige Vorschauen |
| `preview.domain` | leer | Subdomain für HTTPS-Vorschauen (Schritt 6b) |
| `preview.domainBlock` | `true` | `false`: Die Factory bedient die Vorschau-Domain auf Port 443 nicht selbst, weil ein anderer Dienst sie über `sites.d` bedient (Schritt 6b) |
| `allowedUsers` | `[]` | Weitere GitHub-Nutzer, deren Antworten und Änderungswünsche die Factory annimmt. Dein eigener Login zählt immer |
| `improve.everyDays` | `0` (aus) | Automatischer Verbesserungs-Lauf alle X Tage. Sonst nur mit `factory-improve` |
| `heartbeatUrl` | leer (aus) | Ping-URL eines healthchecks.io-Checks, der Runner meldet sich nach jedem Durchlauf (Schritt 6c) |
| `observability.domain` | leer (aus) | Domain für Grafana und den Log- und Metrik-Empfang; gesetzt richtet `setup.sh` den Observability-Stack ein (Schritt 6c) |
| `incidents.enabled` | `false` | Alarme von healthchecks.io und Grafana als Issues mit Label `incident` (Schritt 6c) |
| `incidents.projects` | – | Projektname → Repo, z. B. `{"meine-app": "dein-name/meine-app"}` |
| `incidents.fallbackRepo` | leer | Repo für Alarme ohne zugeordnetes Projekt |

Nach Änderungen: `systemctl restart software-factory`.

Der Standard `maxParallel: 2` passt zum KVM 2: zwei Läufe mit je bis zu 3 GB plus eine Vorschau. Mehr Parallelität braucht mehr Arbeitsspeicher und verbraucht vor allem schneller deine Claude-Limits. Mit einem Pro-Abo ist `1` die sicherere Wahl.

## 13. Absichern

- **Firewall:** Erlaube nur SSH und die Vorschau-Ports:

  ```bash
  ufw allow OpenSSH
  ufw allow 80,443/tcp      # nur nötig mit HTTPS-Vorschau (Zertifikat)
  ufw allow 4001:4003/tcp
  ufw enable
  ```

  Alternativ geht das auch über die Firewall im hPanel.
- **SSH-Key statt Passwort:** Hinterlege im hPanel deinen SSH-Key und schalte danach die Passwort-Anmeldung ab.
- **Zugangsdaten:** Token und Vorschau-Passwort liegen nur in `/etc/software-factory/` (nur für root lesbar). Teil diese Dateien nie und häng sie nie an ein Issue.
- **Wer darf mitreden:** Die Factory nimmt Antworten und Änderungswünsche nur von dir an (und von Personen unter `allowedUsers`). Kommentare anderer ignoriert sie und zeigt sie dem Agent nicht. Aufgaben einstellen kann jeder, der im Repo Labels setzen darf. Bind trotzdem zuerst private Repos an.
- **Freigabe für production:** `add-repo.sh` trägt den Besitzer des Repos als Pflicht-Prüfer der Umgebung `production` ein. Läuft die Factory auf dem Server unter deinem eigenen GitHub-Login, könnte ein Agent mit diesem Token Deploys theoretisch selbst freigeben. Sicherer ist ein eigener GitHub-Account für die Factory (dann `allowedUsers` mit deinem Login). In privaten Repos ohne GitHub Pro/Team legt `add-repo.sh` production ohne Pflicht-Freigabe an und sagt das; starte production-Deploys dann nur von Hand.
- **Observability:** Grafana hat einen eigenen Login, Logs und Metriken nimmt der Server nur mit dem Zugang je Host an (`factory-obs ingest-user`). Die Zugänge liegen wie alles andere unter `/etc/software-factory/`.

## 14. Wenn etwas hakt

| Problem | Lösung |
|---|---|
| Nichts passiert nach `/to-factory` | `journalctl -u software-factory -f` ansehen. Hat das Issue das Label `factory`? Ist das Repo mit `add-repo.sh` angebunden? |
| `config:error … Weder CLAUDE_CODE_OAUTH_TOKEN noch ANTHROPIC_API_KEY` | Schritt 4 wiederholen, dann `systemctl restart software-factory` |
| Beim Token-Einfügen landet ein Teil als Befehl in der Shell | Der Token wurde umgebrochen. `history -c` ausführen (löscht den Rest aus dem Verlauf), dann Schritt 4 mit Strg+D wiederholen |
| `board:error` in den Logs | `gh auth refresh -s project`, dann `systemctl restart software-factory` |
| Status **Fehlgeschlagen** | Der Fehler steht als Kommentar im Issue. Ursache beheben, dann im Issue kommentieren |
| Vorschau lädt nicht | Nach jedem neuen Stand braucht sie 1–2 Minuten. Ist schon eine Vorschau aktiv (`preview.max`), bekommt der PR keine weitere. Mit Domain: Zeigt die Subdomain auf den Server und sind Port 80 und 443 offen? |
| Claude-Limit erreicht | Das Issue steht auf **Pausiert**, die Factory macht nach dem Reset von selbst weiter. Früher fortsetzen: `/var/lib/software-factory/limit.json` löschen und im Issue kommentieren. Passiert es oft: `maxParallel` senken oder auf API-Key umsteigen |
| Neue Version der Factory holen | `factory-rollout` |
| Grafana nicht erreichbar | Zeigt die Domain auf den Server, ist `preview.domain` gesetzt (Schritt 6b)? `factory-obs compose ps` zeigt, ob der Stack läuft. `caddy:sites-invalid` im Log: `factory-obs site` schreibt die Caddy-Site neu |
| Kein Issue bei einem Alarm | `journalctl -u software-factory | grep incident`: `incident:unmapped` = Projekt fehlt in `incidents.projects`, `incident:source-error` = Schlüssel falsch oder Dienst nicht erreichbar. Nach Änderungen an `secrets.env` den Runner neu starten |
| Incident-Issue wurde nicht neu geöffnet | Absicht: Hast du es geschlossen, solange der Alarm lief, öffnet erst der nächste Alarm wieder eins |

## Was die Factory nie tut

- Sie ändert nie deine Spec.
- Sie mergt nie selbst.
- Sie rät nicht bei Unklarheiten, sondern fragt im Issue nach.
- Sie meldet nie „bestanden“, wenn die Checks nicht grün sind oder ein Testszenario durchfällt.
- Sie arbeitet nur in Repos, die du mit `add-repo.sh` angebunden hast.
