// factory-stats: Auswertung aller Factory-Läufe aus /var/lib/software-factory/metrics.jsonl
// Weil jede Aufgabe denselben Ablauf durchläuft, lässt sich messen, ob eine Änderung
// (Playbook, Skills, Modell) etwas bringt.
//
//   factory-stats                 alle Läufe
//   factory-stats --tage 7        nur die letzten 7 Tage
//   factory-stats --repo name     nur ein Repo (Teil des Namens reicht)
//   factory-stats --seit 2026-11-12 [--bis 2026-11-19]   Zeitraum, z. B. vor/nach einer Playbook-Änderung
//   factory-stats --json          Rohdaten zusammengefasst als JSON

import { existsSync, readFileSync } from "node:fs";

type Run = {
  t: string; repo: string; issue: number; phase: "check" | "build" | "accept"; mode?: string;
  status: string; seconds: number | null; turns: number | null; costUsd: number | null; model?: string;
};

const file = process.env.FACTORY_METRICS ?? "/var/lib/software-factory/metrics.jsonl";
const arg = (name: string) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : undefined; };
const days = Number(arg("--tage") ?? 0);
const repoFilter = arg("--repo");
const since = arg("--seit"), until = arg("--bis");

if (!existsSync(file)) { console.log(`Noch keine Daten (${file} fehlt).`); process.exit(0); }
let runs: Run[] = readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
if (days > 0) runs = runs.filter((r) => Date.now() - Date.parse(r.t) <= days * 86400000);
if (repoFilter) runs = runs.filter((r) => r.repo.includes(repoFilter));
if (since) runs = runs.filter((r) => r.t >= since);
if (until) runs = runs.filter((r) => r.t < until);
if (runs.length === 0) { console.log("Keine Läufe im gewählten Zeitraum."); process.exit(0); }

const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
const avg = (xs: number[]) => (xs.length ? sum(xs) / xs.length : 0);
const median = (xs: number[]) => { if (!xs.length) return 0; const s = [...xs].sort((a, b) => a - b); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const min = (sec: number) => `${(sec / 60).toFixed(1).replace(".", ",")} Min.`;
const pct = (a: number, b: number) => (b ? `${Math.round((a / b) * 100)} %` : "–");
const usd = (x: number) => `${x.toFixed(2).replace(".", ",")} $`;

const byPhase = (p: Run["phase"]) => runs.filter((r) => r.phase === p);
const checks = byPhase("check"), builds = byPhase("build"), accepts = byPhase("accept");

// Pro Aufgabe (Repo + Issue): reine Laufzeit aller Läufe, bis Review erreicht wurde
const tasks = new Map<string, Run[]>();
for (const r of runs) tasks.set(`${r.repo}#${r.issue}`, [...(tasks.get(`${r.repo}#${r.issue}`) ?? []), r]);
const finished = [...tasks.values()].filter((rs) => rs.some((r) => r.status === "review"));
const taskSeconds = finished.map((rs) => sum(rs.map((r) => r.seconds ?? 0)));

// Abnahme: beim ersten Versuch bestanden?
const firstAccept = [...tasks.values()].map((rs) => rs.find((r) => r.phase === "accept")).filter(Boolean) as Run[];
const firstPass = firstAccept.filter((r) => r.status === "review").length;

const summary = {
  laeufe: runs.length,
  aufgabenBisReview: finished.length,
  laufzeitProAufgabeMedianSek: median(taskSeconds),
  laufzeitProAufgabeSchnittSek: avg(taskSeconds),
  pruefung: { laeufe: checks.length, freigegeben: checks.filter((r) => r.status === "approved").length, rueckfrage: checks.filter((r) => r.status === "question").length, abgelehnt: checks.filter((r) => r.status === "rejected").length },
  entwicklung: { laeufe: builds.length, schnittSek: avg(builds.map((r) => r.seconds ?? 0)), schnittSchritte: avg(builds.map((r) => r.turns ?? 0)), aenderungswuensche: builds.filter((r) => r.mode === "change-request").length, rueckgabenAusAbnahme: builds.filter((r) => r.mode === "rework").length },
  abnahme: { laeufe: accepts.length, bestanden: accepts.filter((r) => r.status === "review").length, zurueckgegeben: accepts.filter((r) => r.status === "working").length, beimErstenMalBestanden: firstPass, mitAbnahme: firstAccept.length },
  fehlgeschlagen: runs.filter((r) => r.status === "failed").length,
  kostenGegenwertUsd: sum(runs.map((r) => r.costUsd ?? 0)),
};

if (process.argv.includes("--json")) { console.log(JSON.stringify(summary, null, 2)); process.exit(0); }

const zeitraum = since || until ? `${since ?? "Anfang"} bis ${until ?? "heute"}` : days > 0 ? `letzte ${days} Tage` : "gesamt";
console.log(`\nSoftware Factory · Auswertung (${zeitraum}${repoFilter ? `, Repo: ${repoFilter}` : ""})\n`);
console.log(`Läufe insgesamt              ${summary.laeufe}`);
console.log(`Aufgaben bis Review          ${summary.aufgabenBisReview}`);
console.log(`Laufzeit pro Aufgabe         Median ${min(summary.laufzeitProAufgabeMedianSek)} · Schnitt ${min(summary.laufzeitProAufgabeSchnittSek)}`);
console.log(`\nPrüfung                      ${checks.length} Läufe`);
console.log(`  freigegeben                ${summary.pruefung.freigegeben} (${pct(summary.pruefung.freigegeben, checks.length)})`);
console.log(`  Rückfrage                  ${summary.pruefung.rueckfrage} (${pct(summary.pruefung.rueckfrage, checks.length)})`);
console.log(`  abgelehnt                  ${summary.pruefung.abgelehnt} (${pct(summary.pruefung.abgelehnt, checks.length)})`);
console.log(`\nEntwicklung                  ${builds.length} Läufe · Schnitt ${min(summary.entwicklung.schnittSek)} · ${Math.round(summary.entwicklung.schnittSchritte)} Schritte`);
console.log(`  davon Änderungswünsche     ${summary.entwicklung.aenderungswuensche}`);
console.log(`  davon Rückgaben Abnahme    ${summary.entwicklung.rueckgabenAusAbnahme}`);
console.log(`\nAbnahme                      ${accepts.length} Läufe`);
console.log(`  beim ersten Mal bestanden  ${firstPass} von ${firstAccept.length} (${pct(firstPass, firstAccept.length)})`);
console.log(`  zurückgegeben              ${summary.abnahme.zurueckgegeben}`);
console.log(`\nFehlgeschlagen               ${summary.fehlgeschlagen}`);
console.log(`Kosten-Gegenwert (API-Preis) ${usd(summary.kostenGegenwertUsd)}  · läuft über dein Abo, zählt gegen dessen Limits\n`);
