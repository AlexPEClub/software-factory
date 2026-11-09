# Stack-Pack: Supabase (Postgres, Auth, Storage)

Gilt, wenn `docs/stack.md` unter „Stack-Packs" `supabase` nennt.

## Datenbank
- Schema-Änderungen **nur als Migrations-Datei** in `supabase/migrations/<zeitstempel>_<name>.sql`. Nie SQL von Hand gegen eine echte Datenbank ausführen. Die Factory hat keinen Zugriff auf Produktionsdaten und braucht ihn nicht.
- **Row Level Security auf jeder neuen Tabelle**, Policies für select, insert, update, delete. Standardmuster für Nutzerdaten: `auth.uid() = user_id`.
- Indizes auf Spalten, nach denen gefiltert oder sortiert wird. Fremdschlüssel mit bewusstem `ON DELETE`.
- Listen-Abfragen immer mit `.limit()`. Keine N+1-Abfragen, Joins über Supabase-Selects.

## Zugriff aus der App
- Client über `@supabase/supabase-js` bzw. `@supabase/ssr`. Schlüssel nur aus Umgebungsvariablen (`NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`), nie im Code.
- Der Service-Role-Key gehört nie in Client-Code.

## Tests in der Factory
- Kein echtes Supabase im Job. Supabase-Client in Tests mocken, Migrationen als Datei prüfen (Syntax, RLS vorhanden).
- Im PR vermerken, welche Migrationen beim Merge angewendet werden müssen.

## Login
- Supabase Auth. Nach dem Signup ein Profil per Trigger anlegen, wenn das Datenmodell Profile vorsieht.
