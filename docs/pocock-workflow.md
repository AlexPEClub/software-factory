# Optional: Matt Pococks Workflow in der Factory

Mit diesem Umbau arbeitet deine Factory nach dem Entwicklungsworkflow von **Matt Pocock** und nutzt seine Skills aus [mattpocock/skills](https://github.com/mattpocock/skills) (MIT-Lizenz). Der bisherige Workflow bleibt erhalten, du schaltest per Konfiguration zwischen beiden um.

> Das ist eine Integration von mir, Matt Pocock ist daran nicht beteiligt. Seine Skills entwickeln sich schnell weiter. Die Factory nutzt deshalb einen festen, getesteten Stand (siehe `image/Dockerfile`).

## So läuft es danach

- **Lokal mit dir:** `/grill-with-docs` (der Agent fragt dich aus, bis ihr dasselbe meint) und danach `/to-spec`. Die Spec landet als GitHub Issue und bekommt automatisch das Label `factory`. Das ist dein letzter Schritt.
- **Auf dem Server, ohne dich:**
  1. **Prüfung:** Ist die Spec vollständig, prüfbar und passt sie zum Stack? Bei Unklarheiten fragt die Factory im Issue nach.
  2. **`/to-tickets`:** zerlegt die Spec in Tickets (Sub-Issues mit Abhängigkeiten). Die Zerlegung entscheidet der Agent selbst und schreibt sie zur Info ins Issue.
  3. **`/implement-spec`:** setzt die Tickets mit Sub-Agents um, testgetrieben, mit `/code-review` am Ende, und öffnet einen Pull Request im Format von Matts Skill `pr`.
  4. **Abschluss:** Pflicht-Checks auf dem gepushten Stand, dann die **unabhängige Abnahme** durch einen zweiten Agent.
- **Am Ende wieder du:** Pull Request prüfen, mergen, danach `/retro` (oder der Verbesserungs-Lauf der Factory).

Voraussetzung: Deine Factory läuft bereits (siehe [hostinger-vps-setup.md](hostinger-vps-setup.md)), und auf deinem Rechner hast du Claude Code und die GitHub CLI (`gh`, ab Version 2.94).

---

## 1. Eigene Kopie der Factory

Für den Umbau brauchst du eine eigene Kopie, in die du pushen kannst.

1. Forke auf GitHub [AlexPEClub/software-factory](https://github.com/AlexPEClub/software-factory) in deinen Account.
2. Klone deinen Fork auf deinen Rechner:

   ```bash
   gh repo clone DEIN-GITHUB-NAME/software-factory
   cd software-factory
   ```

Hast du die Factory schon lokal geklont (z. B. für die lokalen Skills), kannst du stattdessen dort deinen Fork als `origin` eintragen: `git remote set-url origin https://github.com/DEIN-GITHUB-NAME/software-factory.git`.

## 2. Umbau per Prompt

Starte im Ordner deines Forks Claude Code und gib diesen Prompt ein. Den Rest erledigt Claude Code.

````text
Bau diese Software Factory auf Matt Pococks Entwicklungsworkflow um, nach der Anleitung docs/pocock-workflow.md aus github.com/AlexPEClub/software-factory.

1. Prüfe, dass du im Root eines Klons der Software Factory bist (runner/main.ts, image/entrypoint.sh, workflows/starter-kit/ existieren) und dass der Arbeitsstand sauber ist (git status). Wenn nicht: stopp und sag mir, was fehlt.
2. Lade den Umbau als Patch:
   curl -fsSL https://raw.githubusercontent.com/AlexPEClub/software-factory/main/docs/pocock/umbau.patch -o /tmp/pocock-umbau.patch
3. Wende ihn an: git apply --3way /tmp/pocock-umbau.patch
   Gibt es Konflikte, weil mein Stand vom Original abweicht, löse sie so, dass meine eigenen Änderungen erhalten bleiben und der Patch inhaltlich vollständig umgesetzt ist. Der Patch macht genau das:
   - Neuer Workflow workflows/pocock/ (workflow.md, playbook.md, steps/to-tickets.md, implement-spec.md, implement.md, finish.md).
   - image/Dockerfile installiert Matt Pococks Skills (github.com/mattpocock/skills, fester Commit) nach /home/pwuser/.claude/skills.
   - image/entrypoint.sh: Playbook pro Workflow; bei WORKFLOW=pocock und PHASE=build ruft er nacheinander /to-tickets (nur wenn das Issue noch keine Sub-Issues hat), /implement-spec und einen Abschluss-Schritt auf, bei Rückgabe/Änderungswunsch/Fehler stattdessen /implement; jeder Schritt ist ein eigener claude -p Aufruf, der mit dem /befehl beginnt; danach eine Gesamtzeile für Kosten und Dauer.
   - runner/main.ts: Sub-Issues (Feld parent) sind keine eigenen Aufgaben, MODE wird an den Container übergeben, Bau-Auftrag je nach Workflow.
4. Ändere die Standardwerte in factory.config.example.json nicht. Der bisherige Workflow bleibt Standard.
5. Prüfe: bash -n image/entrypoint.sh und node --test runner/main.test.ts (alle Tests grün). Schlägt etwas fehl, behebe es.
6. Ergänze in README.md direkt unter der Einleitung einen kurzen Hinweis: „Optional: Matt Pococks Workflow, siehe docs/pocock-workflow.md (Umbau aktiv in diesem Fork).“
7. Committe mit der Nachricht „Workflow pocock: Matt Pococks Skills in der Factory“ und pushe auf meinen Fork (origin). Pushe nie in AlexPEClub/software-factory.
8. Gib mir zum Schluss die nächsten Schritte für den Server und mein Projekt aus Abschnitt 3 und 4 der Anleitung aus, mit meinem GitHub-Namen eingesetzt.
````

## 3. Server umstellen

Auf dem Server (per SSH):

```bash
cd /opt/software-factory
gh auth setup-git
git remote set-url origin https://github.com/DEIN-GITHUB-NAME/software-factory.git
factory-rollout
```

`factory-rollout` holt deinen Fork, baut das Job-Image mit Matts Skills neu und startet die Factory neu. Das dauert ein paar Minuten.

Dann den Workflow umschalten. `/implement-spec` braucht etwas länger, deshalb gleich ein höheres Zeitlimit:

```bash
C=/etc/software-factory/config.json
cp $C $C.vorher
jq '.workflow = "pocock" | .jobTimeoutMinutes = 120' $C > /tmp/c && mv /tmp/c $C && chmod 600 $C
systemctl restart software-factory
```

Der Workflow gilt für alle angebundenen Repos.

## 4. Projekt einrichten (einmal pro Projekt)

Auf deinem Rechner:

1. **Matts Skills installieren** (einmal pro Rechner, aktualisiert sich selbst):

   ```bash
   claude plugin install mattpocock-skills@claude-plugins-official
   ```

   Hast du sie schon anders installiert (z. B. mit `npx skills`), bleib dabei, sonst hast du jeden Skill doppelt.

2. **Projekt wie gewohnt anlegen bzw. anbinden** (Schritt 8 der [Server-Anleitung](hostinger-vps-setup.md)): neues Projekt mit `new-project.sh` und `/init`, bestehendes mit `add-repo.sh` und `/init`. Die Factory braucht weiterhin `docs/stack.md` und `.factory/setup.json`.

3. **Im Projekt `/setup-matt-pocock-skills` ausführen** und so antworten:
   - **Issue-Tracker:** GitHub
   - **Triage-Labels:** Für `ready-for-agent` den Namen **`factory`** eintragen, die anderen kannst du so lassen. Damit setzt `/to-spec` das Factory-Label automatisch.
   - **Domänen-Doku:** Single-Context

   Das legt `docs/agents/` an und ergänzt deine `CLAUDE.md`. Committe und pushe das.

4. **Optional, aber empfohlen:** eine `CODING_STANDARDS.md` im Projekt. Die liest `/code-review`. Ohne sie prüft das Review nur Matts Grundausstattung an typischen Warnzeichen. Mit jeder `/retro` kommen neue Regeln dazu.

## 5. Benutzen

Im Projekt in Claude Code:

1. `/grill-with-docs` und beschreib, was du entwickeln willst, mit dem Warum. Beantworte die Fragen, bis ihr euch einig seid. Dabei entstehen `GLOSSARY.md` und bei harten Entscheidungen ADRs unter `docs/adr/`. Commit und push.
2. `/to-spec` in derselben Session (nicht vorher `/clear`, die Spec entsteht aus dem Gespräch). Die Spec landet als GitHub Issue mit dem Label `factory`.

Ab da arbeitet die Factory. Den Stand siehst du auf dem Board und im Issue. Am Ende bekommst du einen Pull Request mit Vorschau und Abnahmebericht. Prüfen, mergen, dann `/retro`.

Bugs gehen auch ohne Spec: Issue mit Label `factory`, beschreiben, was falsch ist und was du stattdessen erwartest.

## Zurück zum bisherigen Workflow

```bash
jq '.workflow = "starter-kit"' /etc/software-factory/config.json > /tmp/c && mv /tmp/c /etc/software-factory/config.json && chmod 600 /etc/software-factory/config.json
systemctl restart software-factory
```

Der Code des Umbaus bleibt drin, nur der Workflow wechselt.

## Gut zu wissen

- **Matts Skills, die nur Menschen starten dürfen** (`/to-tickets`, `/implement-spec`, `/implement`), startet die Factory selbst, jeweils mit eigenem Aufruf und frischem Kontext. Ein Agent kann sie nicht von sich aus aufrufen.
- **Die Zerlegung in Tickets fragt nicht nach.** In Matts Original segnest du sie im Chat ab. In der Factory entscheidet der Agent und schreibt die Zerlegung nur zur Info ins Issue.
- **Tickets bekommen kein Factory-Label.** Sie werden zusammen mit ihrer Spec in einem Lauf umgesetzt und beim Merge des Pull Requests geschlossen.
- **Limits:** Sub-Agents arbeiten parallel. Das geht schneller, verbraucht aber auch schneller deine Claude-Limits.
- **Getestet:** Ubuntu 24.04 auf einem Hostinger KVM 2, Next.js-Projekt, Spec mit einem Ticket. Größere Specs mit vielen Tickets sind vorgesehen, aber noch wenig erprobt.
