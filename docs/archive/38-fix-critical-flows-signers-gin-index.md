---
fix(crit): index GIN lipsă pe flows.data->'signers' — /my-flows timeout (statement timeout 30s, scanare completă tabelă)
target_branch: develop
model_suggested: Opus 4.8 (migrație de index pe tabelă cu date reale în producție/staging — precizie)
risk: MEDIU (CREATE INDEX blocant, nu CONCURRENTLY — vezi motiv arhitectural mai jos; impact scurt, dar pe tabelă activă)
version: 3.9.616 → 3.9.617
---

# ⚠️ BRANCH `develop` EXCLUSIV
TOATE comenzile pe `develop`. NU `checkout`/`merge`/`push` pe `main`. La final `git push origin develop` și **STOP**.

# 🎯 Problema (CONFIRMATĂ din logs — pagină centrală complet căzută)
```
Postgres: canceling statement due to statement timeout
STATEMENT: SELECT id, data, created_at, updated_at, COUNT(*) OVER() AS _total
  FROM flows WHERE (data->>'initEmail' = $1
    OR data->'signers' @> jsonb_build_array(jsonb_build_object('email',$1::text)))
    AND org_id = $2 AND deleted_at IS NULL
  ORDER BY created_at DESC LIMIT 50 OFFSET 0
```
`GET /my-flows` (pagina „Fluxurile mele") durează >30s și expiră (`statement_timeout`, cod
`57014`), întorcând 500. Cauza: există index pe `data->>'initEmail'` (`idx_flows_init_email`),
dar **NU există niciun index** care să susțină `data->'signers' @> ...` (containment JSONB).
Când o ramură a unui `OR` n-are index, Postgres nu poate folosi eficient nicio combinație de
indexuri pentru întreaga expresie și cade pe scanare secvențială completă a tabelei — care,
după acumularea de date din testele acestei sesiuni, a depășit pragul de 30s.

**De ce n-a prins niciun test:** suita de teste rulează pe seturi de date mici (fixture-uri de
câteva rânduri) — un index lipsă nu se manifestă ca lentoare la volum mic. E o categorie de bug
pe care testele de corectitudine, prin natura lor, n-o prind fără un test de volum/performanță
dedicat (pe care proiectul nu-l are azi). Nu e o eroare de proces, e un gol de acoperire cunoscut.

# 🎯 Scop
Adaugă indexul GIN lipsă, ca `EXPLAIN` să arate bitmap index scan (nu seq scan) pentru query-ul
de mai sus, indiferent de volumul de date viitor.

# ⚠️ Notă arhitecturală — DE CE nu `CREATE INDEX CONCURRENTLY`
`initDbOnce()` (server/db/index.mjs) rulează TOATE migrațiile inline într-o singură tranzacție
(`BEGIN` ... `runMigrations(client)` ... `COMMIT`). Postgres INTERZICE explicit
`CREATE INDEX CONCURRENTLY` în interiorul unei tranzacții. Deci migrația asta folosește
`CREATE INDEX IF NOT EXISTS` simplu (blocant) — ia un lock `SHARE` pe `flows` (blochează
scrieri, permite citiri) doar pentru durata construirii indexului. La volumul actual (mii de
rânduri, nu milioane), asta durează sub o secundă — câteva secunde cel mult. Compromis acceptabil
și necesar dat fiind arhitectura curentă de migrații; NU încerca să introduci `CONCURRENTLY`
fără să restructurezi întâi sistemul de migrații (scop separat, mult mai mare — NU acum).

# 🚫 NO-TOUCH
Query-ul din `server/routes/flows/crud.mjs` (`/my-flows`) — NU-l rescrie, doar adaugă indexul
care-l face rapid. Restul indexurilor existente pe `flows` — neatinse.

# Etapa 0 — caracterizare
```bash
grep -oE "id: '[0-9]{3}_[a-z_]+'" server/db/index.mjs | tail -3   # confirmă 089 ultima → 090 liberă
grep -n "idx_flows_init_email\|idx_flows_org\b\|idx_flows_org_updated\|idx_flows_deleted_at" server/db/index.mjs
sed -n '710,750p' server/routes/flows/crud.mjs   # confirmă query-ul exact din /my-flows
```

# Implementare — migrație inline `090_flows_signers_gin` în `server/db/index.mjs`
Adaugă în array-ul `MIGRATIONS`, după `089_flow_recipient_acks`:
```js
{
  id: '090_flows_signers_gin',
  sql: `
    -- FIX CRIT (2026-07-02): /my-flows făcea scanare completă pe flows — OR-ul dintre
    -- data->>'initEmail' (indexat) și data->'signers' @> ... (NEindexat) forța Postgres
    -- să renunțe la orice index pentru întreaga expresie. jsonb_path_ops susține operatorul
    -- @> folosit exact în acest query (containment), mai compact decât jsonb_ops implicit.
    CREATE INDEX IF NOT EXISTS idx_flows_signers_gin
      ON flows USING GIN ((data->'signers') jsonb_path_ops);
    -- Complementar, simetric cu idx_flows_org_updated existent — ajută sortarea
    -- ORDER BY created_at DESC filtrată pe org_id (folosită de /my-flows și alte liste).
    CREATE INDEX IF NOT EXISTS idx_flows_org_created
      ON flows(org_id, created_at DESC);
  `
},
```

# Verificare (CRITICĂ — e fix de performanță, nu de logică; testele automate NU îl acoperă)
Local/CI (dacă ai Postgres cu date de test), sau ideal DIRECT pe staging după deploy, rulează:
```sql
EXPLAIN ANALYZE
SELECT id, data, created_at, updated_at, COUNT(*) OVER() AS _total
FROM flows
WHERE (data->>'initEmail' = 'test@docflowai.ro'
   OR data->'signers' @> jsonb_build_array(jsonb_build_object('email','test@docflowai.ro'::text)))
  AND org_id = 1 AND deleted_at IS NULL
ORDER BY created_at DESC LIMIT 50 OFFSET 0;
```
Așteptat: planul arată `Bitmap Index Scan` pe `idx_flows_signers_gin`/`idx_flows_init_email`
(BitmapOr), NU `Seq Scan on flows`. Timp de execuție: milisecunde, nu secunde.

`npm test verde, fără regresii`. `npm run check` OK.

# Guardrails diff
`git diff --name-only` atinge EXCLUSIV: `server/db/index.mjs`, `package.json`.
```bash
git diff --name-only | grep -vE "^server/db/index\.mjs$|^package\.json$" && echo "⛔ STOP" || echo "✅ scope curat"
git diff server/db/index.mjs | grep -n "CONCURRENTLY" && echo "⛔ STOP: CONCURRENTLY nu poate rula în tranzacția migrațiilor!" || echo "✅ fără CONCURRENTLY"
```
Backend-only → fără `?v=`/`CACHE_VERSION`. Bump `package.json` 3.9.616 → 3.9.617.

# La final
```bash
git add server/db/index.mjs package.json
git commit -m "fix(crit): index GIN pe flows.data->signers — repară timeout /my-flows (v3.9.617)"
git push origin develop
```
**STOP. NU merge/push pe `main`.** Raportează:
1. Migrația 090 aplicată (confirmă în logs Railway: „Migrare: 090_flows_signers_gin..." +
   „Migrare aplicata cu succes").
2. Timpul de creare a indexului (din logs — cât a durat efectiv construirea, ca să știm
   impactul real asupra scrierilor concurente).
3. Status CI (`npm test` + `npm run check`); versiune 3.9.617.
4. **Verificare pe staging, imediat după deploy**: „Fluxurile mele" se încarcă normal (sub 1s),
   fără 500/timeout. Dacă ai acces la Postgres Query din Railway, rulează `EXPLAIN ANALYZE`
   de mai sus și confirmă planul (Bitmap Index Scan, nu Seq Scan).

# Notă pentru viitor (NU acum, doar semnalare)
Dacă tabela `flows` crește mult mai mult (zeci/sute de mii de rânduri), merită reconsiderat
sistemul de migrații ca să suporte `CREATE INDEX CONCURRENTLY` (migrații non-tranzacționale
separate pentru operații de indexare) — arhitectural mai sigur pe tabele mari cu trafic
concurent. Nu e nevoie acum; volumul actual face acest fix suficient.
