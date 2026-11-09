# Stack-Pack: Next.js (App Router) + Tailwind + shadcn/ui

Gilt, wenn `docs/stack.md` unter „Stack-Packs" `nextjs` nennt.

## Struktur
- Seiten und Layouts in `src/app/`, Route Handlers in `src/app/api/<name>/route.ts`
- Komponenten in `src/components/`, shadcn/ui-Bausteine in `src/components/ui/`
- Logik ohne UI in `src/lib/`, Hooks in `src/hooks/`
- Next.js ändert sich schnell: Liegt `AGENTS.md` oder `node_modules/next/dist/docs/` vor, dort nachlesen, bevor du neue APIs nutzt. Typen für Layouts/Seiten erzeugt `next typegen`.

## Oberfläche
- Für Standard-Elemente **immer shadcn/ui**. Erst `src/components/ui/` prüfen, fehlende mit `npx shadcn@latest add <name> --yes` installieren. Eigene Komponenten nur als Zusammensetzung aus shadcn-Bausteinen.
- Styling ausschließlich mit Tailwind, keine Inline-Styles, keine CSS-Module.
- Client-Komponenten (`"use client"`) nur, wo Interaktion oder Browser-APIs nötig sind.
- Browser-APIs (z. B. `localStorage`) erst im Browser lesen (Effect), nicht beim Server-Rendering.

## Backend in Next.js
- Eingaben in Route Handlers und Server Actions mit **Zod** prüfen.
- Auth-Prüfung in jedem geschützten Handler, nicht nur im Client.

## Tests
- Unit-/Integrationstests mit Vitest, direkt neben der Quelldatei (`*.test.ts`).
- E2E mit Playwright unter `tests/`, falls eingerichtet.

## Befehle (Standard, siehe `.factory/setup.json`)
- install `npm ci` · dev `npm run dev -- -p $PORT` · preview `npm run build && npm run start -- -p $PORT -H 0.0.0.0`
- checks: `npm run lint`, `npx next typegen && npx tsc --noEmit`, `npm test`, `npm run build`
