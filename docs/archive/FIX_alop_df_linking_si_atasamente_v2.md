# FIX dublu (v2 — CORECTAT): (A) legătura DF↔ALOP se pierde silențios · (B) atașamentele DF nu funcționează

> ⚠️ **ATENȚIE — BRANCH DISCIPLINE**
> Toate modificările se fac **EXCLUSIV pe branch-ul `develop`**.
> NU propune și NU executa merge/push/checkout către `main`. `main` = producție, gestionat manual.
> **ZONA NO-TOUCH:** `server/routes/flows/cloud-signing.mjs`, `server/routes/flows/bulk-signing.mjs`, `server/signing/pades.mjs`, `server/signing/java-pades-client.mjs`, `server/signing/providers/STSCloudProvider.mjs` — zero modificări.
> NOTĂ: `server/routes/flows/signing.mjs` NU e în zona NO-TOUCH.

> 🔒 **INVARIANT DE BUSINESS — NU MODIFICA:**
> Relink-ul de la crearea reviziei (`server/routes/formulare/df.mjs` ~468: `UPDATE alop_instances SET df_id=<revizia nouă>, df_flow_id=NULL, df_completed_at=NULL WHERE df_id=<revizia veche> AND cancelled_at IS NULL`) se aplică INTENȚIONAT și ALOP-urilor cu `status='completed'`. Acesta e mecanismul care permite fluxul: ALOP finalizat (plăți acoperă integral DF-ul) → revizuire DF (valoare mărită) → `noua-lichidare` recalculează `ramas` pe valoarea reviziei noi (via `alop.df_id`) → ALOP-ul se redeschide pentru un ciclu nou de ordonanțare. La fel, guard-ul de conflict din `link-df` (`alop.mjs` ~753) care include ALOP-urile finalizate e corect. NU adăuga filtre `completed_at IS NULL` pe aceste două query-uri.

---

## PARTEA A — Legătura DF↔ALOP se pierde silențios și nu se auto-repară

### Context verificat (caz real în staging)

ALOP „Servicii proba fix" finalizat afișează „Fără DF" / VALOARE DF „—", iar trasabilitatea DF-ului 12343 (R0 istoric + R1, ambele aprobate) nu găsește niciun ALOP. Diff v3.9.551→v3.9.553 pe fișierele de linking: identice — NU e regresie recentă. Concluzie verificată logic: `alop_instances.df_id` era deja NULL **înainte** de crearea reviziei R1 (altfel relink-ul de la revizie l-ar fi mutat pe R1 și trasabilitatea l-ar găsi). Consecință gravă în lanț: cu `df_id` NULL, ALOP-ul finalizat nu mai poate primi „nouă lichidare" după revizuirea DF-ului (`dfVal` din `noua-lichidare` se calculează pe `alop.df_id`).

### Căile de ruptură identificate (de fixat)

1. **Refuz R0 → eliberare fără re-legare la re-aprobare.** `signing.mjs` ~142: la refuzul fluxului DF R0, ALOP-ul e eliberat (`df_id=NULL`) — comportament corect în sine. Dar la re-aprobarea ulterioară a aceluiași DF (`crud.mjs` ~417 / `signing.mjs` ~388 setează doar `status='aprobat'`), **nimic nu re-leagă ALOP-ul**. Ruptură permanentă.
2. **Legarea inițială depinde exclusiv de frontend și eșuează silențios.** `link-df` e apelat din `alop.js` (`_alopLinkDoc`) și `semdoc-initiator/main.js`; orice 409/403/CSRF/rețea → doar `console.warn`, utilizatorul nu află.

### Etapa 0 — diagnostic (dacă există acces la DB-ul de staging; NU modifica date)

```sql
SELECT id, titlu, status, df_id, df_flow_id, df_completed_at, updated_at, updated_by, completed_at, cancelled_at
FROM alop_instances WHERE titlu ILIKE '%proba fix%';

SELECT event_type, from_status, to_status, created_at, actor_email, meta
FROM formulare_audit WHERE form_id IN (SELECT id FROM formulare_df WHERE nr_unic_inreg='12343')
ORDER BY created_at;
```
Raportează rezultatul. Indiferent de calea confirmată, implementează fix-urile de mai jos (defensive, acoperă toate căile).

### Implementare A

**A1. Proveniență persistentă: coloana `source_alop_id`.**
- Migrare nouă (pattern-ul din `server/db/index.mjs`, migrations array, idempotentă): `ALTER TABLE formulare_df ADD COLUMN IF NOT EXISTS source_alop_id UUID NULL;` + index parțial `WHERE source_alop_id IS NOT NULL`. Idem `formulare_ord` pentru simetrie.
- La crearea DF/ORD din context ALOP: frontend-ul trimite `source_alop_id` în body (din `window._alopContext.alopId` / parametrii existenți `alop_id`), backend-ul îl persistă la INSERT. La crearea unei REVIZII (`df.mjs` /revizuieste): copiază `source_alop_id` din părintele revizuit (în INSERT...SELECT). Backfill istoric nu e necesar.

**A2. Re-legare automată (self-healing) la aprobarea fluxului DF.**
- În `crud.mjs` (~417) și `signing.mjs` (~388), DUPĂ `UPDATE formulare_df SET status='aprobat'`: dacă DF-ul aprobat are `source_alop_id`, iar ALOP-ul respectiv este **necancelat** (`cancelled_at IS NULL` — ATENȚIE: include și ALOP-urile `completed`, conform invariantului de business de mai sus) și `df_id IS NULL` SAU `df_id` pointează la o revizie din același `nr_unic_inreg`, atunci re-leagă: `df_id=<dfAprobat>, df_flow_id=<flowId>, df_completed_at=NOW()`.
- Tranziția de status: aplică `angajare→lichidare` DOAR dacă `status IN ('draft','angajare')` (refolosește pattern-ul din `link-df-flow`). Pentru ALOP-uri în alte stadii (lichidare/ordonantare/plata/completed), actualizează DOAR câmpurile de legătură — nu atinge status/completed_at.
- Idempotent, non-fatal (try/catch + log `[ALOP] self-heal relink`). Extrage logica într-o funcție partajată (ex. `server/services/alop-link.mjs`) folosită de ambele call-site-uri — nu dubla codul.

**A3. Erorile de linking vizibile în UI.**
- `_alopLinkDoc` (alop.js) și blocul din `semdoc-initiator/main.js`: la răspuns ne-ok, afișează toast/banner cu mesajul concret (mecanismul de toast existent; respectă CSS scoping din CLAUDE.md). Păstrează și console.warn.

**A4. Teste.**
- **Caracterizare a invariantului (cea mai importantă):** crearea unei revizii pe un DF al cărui ALOP e `completed` RELEAGĂ ALOP-ul la revizia nouă (`df_id` actualizat, `df_flow_id`/`df_completed_at` resetate) — protejează fluxul noua-lichidare. Plus: `noua-lichidare` după revizie cu valoare mărită → `ramas` calculat pe valoarea reviziei noi → ciclu nou pornit, `completed_at=NULL`.
- Self-heal A2: scenariul refuz R0 → re-aprobare → ALOP re-legat automat; ALOP `completed` cu `df_id=NULL` (cazul real) → aprobarea R1 cu `source_alop_id` → re-legat, status neatins.
- Comportament neschimbat: refuz R1+ cu parent aprobat (restore existent în `signing.mjs`), ștergere revizie (relink existent în `formular-shared.mjs`), guard conflict `link-df` (409 rămâne pentru ALOP activ SAU finalizat).

---

## PARTEA B — Atașamentele DF nu funcționează

### Cauze identificate (audit static + 15/15 teste existente verzi pe router izolat)

1. **PRINCIPALĂ: authz ocolește sistemul centralizat.** Rutele `formulare-atasamente` (POST/GET listă/GET download/DELETE în `server/routes/formulare/shared.mjs` ~131+) folosesc verificarea veche `created_by === userId || assigned_to === userId || admin` în loc de `canEditFormular`/`canViewFormular` din `server/services/authz-formular.mjs`. Utilizatorii cu drepturi prin compartiment primesc 403 la TOT. Verifică și rutele `formulare-capturi` din același fișier — același pattern vechi.
2. **Eșecuri complet silențioase în frontend.** `uploadAttachments` (doc.js ~927): catch → `console.warn`, iar salvarea raportează „Salvat cu succes" chiar dacă upload-urile au eșuat. `fetchAttachments`: `if (!r.ok) return` — la 403 lista dispare fără niciun mesaj.
3. **Atașarea nu declanșează autosave.** `addAtt` (core.js ~94) modifică programatic input-ul ascuns (`n-fdad`) — nu emite `input`/`change`, deci `_scheduleAutoSaveDb` nu pornește. Fișier atașat + navigare fără alt edit = pierdut.

### Implementare B

**B1.** Aliniază authz-ul pe TOATE rutele `formulare-atasamente` și `formulare-capturi` la sistemul centralizat: upload/delete → `canEditFormular` (păstrează excepțiile de status existente: `document_locked` pe completed pentru non-admin rămâne); listă/download → `canViewFormular`. Încarcă `actorComp` cu `loadActorComp` ca în `df.mjs`. Comportamentul pentru creator/assigned/admin rămâne identic (test de caracterizare).

**B2.** Frontend: `uploadAttachments` returnează rezultatul per item; la eșec, chip-ul primește marcaj vizual de eroare (ex. clasă `att-chip-err` + title cu motivul) și `setS()` afișează avertisment concret („X atașamente nu au putut fi încărcate: <motiv>") în loc de „Salvat cu succes" necondiționat. `fetchAttachments`: la `!r.ok`, log + indicator discret de eroare în zona listei.

**B3.** `addAtt` (core.js): după actualizarea input-ului ascuns, apelează `window._scheduleAutoSaveDb?.(ft)` — derivă `ft` din `did` (`n-*` → notafd, `o-*` → ordnt), consecvent cu pattern-ul din `remAttServer`.

**B4. Test end-to-end prin lanțul real de middleware, nu router izolat.** Testele existente montează router-ul singur. Adaugă un test de integrare care exercită upload-ul binar (Content-Type non-JSON) printr-un app cu middleware-ul relevant (adaptive json, csrf cookie/header) pentru toate rolurile: creator (200), assigned (200), user cu drept prin compartiment (după B1 → 200), user fără drepturi (403).

**B5. Verificare manuală în staging (descrie în commit):** atașare pe DF nou + pe revizie, ca user creator ȘI ca user cu drepturi doar prin compartiment; reload → atașamentele persistă; Network tab fără 403.

---

## Criterii de acceptare (ambele părți)

- `npm test` verde, fără regresii. Teste noi pentru A4 și B4, inclusiv testul de caracterizare a invariantului relink-pe-ALOP-completed.
- Zona NO-TOUCH: `git diff` gol pe cele 5 fișiere.
- Query-urile din invariantul de business (relink revizie `df.mjs` ~468, guard conflict `alop.mjs` ~753): NEMODIFICATE (`git diff` pe ele să arate doar eventuala adăugare `source_alop_id` în INSERT-ul de revizie, nimic în WHERE-uri).
- Migrarea `source_alop_id`: pattern existent, id unic, idempotentă, `IF NOT EXISTS`.
- Cache-bust țintit pe asset-urile JS modificate, bump versiune `package.json`, CLAUDE.md actualizat (secțiune scurtă: „Linking DF↔ALOP: proveniență `source_alop_id` + self-heal la aprobare; relink-ul de revizie se aplică INTENȚIONAT și ALOP-urilor completed — necesar pentru noua-lichidare după revizuire. Authz atașamente/capturi: exclusiv prin authz-formular.mjs").
- Commit-uri mici, separate logic (A și B distinct), doar pe `develop`.
