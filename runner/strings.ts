// Feste Texte der Factory in Deutsch und Englisch.
// Projektsprache (`.factory/setup.json` → `language`): alles, was in Issues und PRs eines Projekts landet.
// Factory-Sprache (`language` in der Factory-Config): das gemeinsame Board und die Hinweise auf dem Server.
// Andere Sprachen: Der Agent schreibt in der gewählten Sprache, feste Texte kommen auf Englisch.

export type Lang = "de" | "en";

/** Sprache, wenn ein Projekt keine angibt. Bestehende Projekte waren alle deutsch. */
export const DEFAULT_LANGUAGE = "de";

/** Prüft einen BCP-47-Sprachcode (z. B. `de`, `en`, `pt-BR`). Alles andere: Standardsprache. */
export function normalizeLanguage(tag: unknown): string {
  if (typeof tag !== "string") return DEFAULT_LANGUAGE;
  const t = tag.trim();
  return /^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8}){0,3}$/.test(t) ? t : DEFAULT_LANGUAGE;
}

/** Sprache der festen Texte: Deutsch für `de-*`, sonst Englisch. */
export const textLang = (tag?: string): Lang => (normalizeLanguage(tag).split("-")[0].toLowerCase() === "de" ? "de" : "en");

/** Name der Sprache auf Englisch für den Prompt, z. B. `de` → "German". */
export function languageName(tag: string): string {
  try { return new Intl.DisplayNames(["en"], { type: "language" }).of(tag) ?? tag; } catch { return tag; }
}

// ---------- Factory-Sprache: Board und Server ----------

type BoardText = {
  status: Record<string, { name: string; description: string }>;
  steps: Record<string, string>;
  stepField: string;
  domainNotice: string;
};

export const BOARD: Record<Lang, BoardText> = {
  de: {
    status: {
      new: { name: "Neu", description: "Angelegt, die Factory hat es noch nicht geprüft" },
      checking: { name: "In Prüfung", description: "Die Factory prüft Spec bzw. Bug-Beschreibung" },
      question: { name: "Rückfrage", description: "Die Factory braucht eine Antwort von dir" },
      rejected: { name: "Abgelehnt", description: "So nicht baubar, die Spec muss überarbeitet werden" },
      approved: { name: "Freigegeben", description: "Prüfung bestanden, wartet auf einen freien Platz" },
      working: { name: "In Arbeit", description: "Architektur, Umsetzung, Tests" },
      accepting: { name: "Abnahme", description: "Ein unabhängiger Agent testet den Pull Request" },
      review: { name: "Review", description: "PR und Vorschau sind bereit, du bist dran" },
      done: { name: "Fertig", description: "Gemergt" },
      failed: { name: "Fehlgeschlagen", description: "Technisch hängen geblieben, Kommentar startet neuen Versuch" },
      paused: { name: "Pausiert", description: "Nutzungslimit erreicht, setzt nach dem Reset automatisch fort" },
    },
    steps: { architecture: "Architektur", implementing: "Umsetzung", verifying: "Tests" },
    stepField: "Schritt",
    domainNotice: "Software Factory: Vorschauen laufen auf eigenen Ports.",
  },
  en: {
    status: {
      new: { name: "New", description: "Created, the factory has not checked it yet" },
      checking: { name: "Checking", description: "The factory is checking the spec or bug report" },
      question: { name: "Question", description: "The factory needs an answer from you" },
      rejected: { name: "Rejected", description: "Not buildable like this, the spec needs revising" },
      approved: { name: "Approved", description: "Check passed, waiting for a free slot" },
      working: { name: "In progress", description: "Architecture, implementation, tests" },
      accepting: { name: "Acceptance", description: "An independent agent is testing the pull request" },
      review: { name: "Review", description: "PR and preview are ready, your turn" },
      done: { name: "Done", description: "Merged" },
      failed: { name: "Failed", description: "Technically stuck, a comment starts a new attempt" },
      paused: { name: "Paused", description: "Usage limit reached, resumes automatically after the reset" },
    },
    steps: { architecture: "Architecture", implementing: "Implementation", verifying: "Tests" },
    stepField: "Step",
    domainNotice: "Software Factory: previews run on their own ports.",
  },
};

// ---------- Projektsprache: Kommentare in Issues und PRs ----------

type ProjectText = {
  claimed: string;
  paused: (when: string, n: number, max: number) => string;
  failed: (problem: string, detail: string) => string;
  lost: string;
  preview: (link: string) => string;
  noVerify: string;
  notPushed: (branch: string) => string;
  shaMismatch: (ran: string, pushed: string) => string;
  specChanged: (spec: string) => string;
  noResult: string;
  cliError: (code: number) => string;
  limitExhausted: (max: number) => string;
  timeout: (minutes: number) => string;
};

export const TEXT: Record<Lang, ProjectText> = {
  de: {
    claimed: "🏭 Die Factory hat das Issue übernommen und prüft es jetzt. Den Fortschritt siehst du am Status (Label bzw. Board).",
    paused: (when, n, max) =>
      `### ⏸️ Nutzungslimit erreicht\n\nDer Lauf wurde vom Nutzungslimit von Claude Code unterbrochen. Die Factory setzt ihn **ab ${when}** automatisch fort, ` +
      `mit derselben Claude-Session und dem bisherigen Arbeitsstand (Fortsetzung ${n} von ${max}).\n\n` +
      `_Bis dahin startet die Factory auch für andere Issues keinen Lauf._`,
    failed: (problem, detail) =>
      `### ⚠️ Der Lauf wurde ohne gültiges Ergebnis beendet\n\n**Grund:** ${problem}\n\n` +
      (detail ? "Letzte Ausgabe:\n```\n" + detail + "\n```\n\n" : "") +
      `_Schreib einen Kommentar mit einem Hinweis, dann versucht die Factory es erneut._`,
    lost: `### ⚠️ Der Lauf ist wiederholt verloren gegangen\n\nDie Factory startet ihn nicht noch einmal automatisch, damit keine Endlosschleife entsteht.\n\n_Schreib einen Kommentar, dann versucht sie es erneut._`,
    preview: (link) =>
      `### 🔍 Vorschau zum Durchklicken\n\n${link}\n\nLogin: \`factory\` · Passwort: steht in \`/etc/software-factory/config.json\` auf dem Server.\n\n` +
      `_Die Vorschau braucht nach jedem neuen Stand 1–2 Minuten zum Starten. Nach Merge oder Schließen des PRs wird sie entfernt._`,
    noVerify: "Die Pflicht-Checks wurden nicht ausgeführt oder sind nicht grün (`factory-verify`).",
    notPushed: (branch) => `Der Branch \`${branch}\` wurde nicht gepusht.`,
    shaMismatch: (ran, pushed) => `Die Checks liefen auf \`${ran}\`, gepusht ist aber \`${pushed}\`. Nach dem letzten Commit muss \`factory-verify\` erneut laufen.`,
    specChanged: (spec) => `Der Pull Request ändert die Spec \`${spec}\`. Die Spec ist der Vertrag und darf nur vom Menschen geändert werden.`,
    noResult: "Der Lauf hat kein Ergebnis gemeldet.",
    cliError: (code) => `Claude Code wurde mit einem Fehler beendet (Exit-Code ${code}).`,
    limitExhausted: (max) => `Nutzungslimit erreicht, der Lauf wurde bereits ${max}-mal fortgesetzt.`,
    timeout: (minutes) => `Zeitlimit von ${minutes} Minuten überschritten.`,
  },
  en: {
    claimed: "🏭 The factory has picked up this issue and is checking it now. You can follow the progress via the status (label or board).",
    paused: (when, n, max) =>
      `### ⏸️ Usage limit reached\n\nThe run was interrupted by the Claude Code usage limit. The factory resumes it automatically **from ${when}**, ` +
      `with the same Claude session and the current working state (resume ${n} of ${max}).\n\n` +
      `_Until then the factory starts no runs for other issues either._`,
    failed: (problem, detail) =>
      `### ⚠️ The run ended without a valid result\n\n**Reason:** ${problem}\n\n` +
      (detail ? "Last output:\n```\n" + detail + "\n```\n\n" : "") +
      `_Write a comment with a hint and the factory will try again._`,
    lost: `### ⚠️ The run was lost repeatedly\n\nThe factory will not restart it automatically again, to avoid an endless loop.\n\n_Write a comment and it will try again._`,
    preview: (link) =>
      `### 🔍 Preview to click through\n\n${link}\n\nLogin: \`factory\` · Password: in \`/etc/software-factory/config.json\` on the server.\n\n` +
      `_After every new commit the preview needs 1–2 minutes to start. It is removed when the PR is merged or closed._`,
    noVerify: "The mandatory checks were not run or are not green (`factory-verify`).",
    notPushed: (branch) => `The branch \`${branch}\` was not pushed.`,
    shaMismatch: (ran, pushed) => `The checks ran on \`${ran}\`, but \`${pushed}\` is pushed. \`factory-verify\` must run again after the last commit.`,
    specChanged: (spec) => `The pull request changes the spec \`${spec}\`. The spec is the contract and may only be changed by a human.`,
    noResult: "The run did not report a result.",
    cliError: (code) => `Claude Code exited with an error (exit code ${code}).`,
    limitExhausted: (max) => `Usage limit reached, the run has already been resumed ${max} times.`,
    timeout: (minutes) => `Time limit of ${minutes} minutes exceeded.`,
  },
};
