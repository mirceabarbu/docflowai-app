---
model_suggested: Opus 4.8
tip: ARHITECTURĂ + AUDIT — mașina de stări a banului public. Prompt mare, citește-l întreg întâi.
---

# ⚠️ BRANCH: develop — NU `main`. NU push/merge/checkout pe main.
> `main` = PRODUCȚIE, gestionat manual, exclusiv de Mircea.

> **NO-TOUCH (doar citire, niciodată editare):**
> `server/routes/flows/signing.mjs`, `server/routes/flows/cloud-signing.mjs`,
> `server/routes/flows/bulk-signing.mjs`, `server/signing/pades.mjs`,
> `server/signing/java-pades-client.mjs`, `server/signing/providers/STSCloudProvider.mjs`

---

## ⛔ CITEȘTE ASTA ÎNAINTE DE ORICE

**Modulul ALOP funcționează corect.** Comportamentul a fost validat în producție împotriva
OMF 1140/2025 (modificat prin OMF 2037/2025). **Codul este specificația.**

Acest prompt **NU schimbă niciun comportament**. Nu rescrie niciun handler. Nu atinge niciunul
dintre cele 19 situri care scriu `status`. **Zero linii în `server/routes/flows/`.**

Ce face: pune o **plasă de siguranță în Postgres**, sub tot codul — o tabelă de audit append-only
și un trigger de validare care, **în faza asta, doar observă**. Comportamentul aplicației după
acest prompt trebuie să fie **bit-identic** cu cel de dinainte.

Citește întâi `docs/audits/ALOP-STATE-MATRIX.md` (commit 02468e0). E matricea autoritativă,
extrasă din cod la #91.

> 📌 **Notă de numerotare:** `ALOP-STATE-MATRIX.md` se referă la promptul de poartă ca „#92".
> Între timp #92 a devenit altceva (NODE_ENV). **Poarta este acest prompt, #95.** Nu renumerota
> documentul.

---

## De ce în DB și nu în aplicație

O poartă în JS ar fi fost ocolită de:
- `tools/repair-alop-status.mjs:28` — script standalone, în afara aplicației
- orice `UPDATE` rulat manual din consola Railway
- orice sit nou adăugat de un prompt viitor care „uită" să cheme poarta

Un trigger nu poate fi ocolit de nimic care trece prin Postgres. Iar auditul devine **atomic
prin construcție** — rulează în aceeași tranzacție cu `UPDATE`-ul, mereu, fără excepție.
`writeAuditEvent` de azi (`db/index.mjs:2249`) folosește `pool.query` propriu și înghite eroarea
în `catch` — deci o tranziție poate face commit fără urmă de audit. Trigger-ul rezolvă asta
pentru ALOP, definitiv.

---

## PAS 0 — Verificări obligatorii înainte de a scrie o linie

```bash
ls server/db/migrations/*.sql | sort | tail -3
grep -n "id: '0" server/db/index.mjs | tail -2
# Așteptat: ultima migrare inline = 092_org_cab_compartiment
# → următoarele: 093, 094

grep -rn "updated_by" server/db/index.mjs | grep -i alop | head -2
# Așteptat: coloana updated_by EXISTĂ pe alop_instances (index la ~linia 1280).
# Dacă NU există, OPREȘTE-TE și raportează.

grep -rn "CREATE TRIGGER" server/db/migrations/015_formulare_oficiale.sql
# Așteptat: există deja triggere în schemă — tiparul nu e străin codebase-ului.
```

**Migrațiile se scriu INLINE în `server/db/index.mjs`. NU crea fișiere `.sql` noi.**
Fiecare migrare trebuie să fie **idempotentă** (`IF NOT EXISTS`, `DO $$ ... IF NOT FOUND`).
Reamintire: incidentul din 19.04.2026 — o migrare care pică la boot ⇒ `markDbFailed()` ⇒
`DB_READY=false` ⇒ 503 pe toate rutele DB. Citește `docs/incidents/2026-04-19-db-init-failure.md`.

---

## PAS 1 — Migrarea `093_alop_state_gate`

Trei obiecte, într-o singură migrare inline.

### 1a. `CHECK` pe `status`

```sql
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'alop_status_valid') THEN
    ALTER TABLE alop_instances ADD CONSTRAINT alop_status_valid
      CHECK (status IN ('draft','angajare','lichidare','ordonantare','plata','completed','cancelled'));
  END IF;
END $$;
```

✅ **Verificat pe producție (13.07.2026):** `angajare` 25, `cancelled` 8, `lichidare` 3.
Zero orfani, zero `NULL`. Constrângerea **nu poate pica**. Nu schimba lista.

### 1b. Tabela `alop_status_log` — append-only

```sql
CREATE TABLE IF NOT EXISTS alop_status_log (
  id           BIGSERIAL PRIMARY KEY,
  alop_id      INTEGER     NOT NULL,          -- verifică tipul real al alop_instances.id!
  org_id       INTEGER,
  from_status  TEXT,
  to_status    TEXT        NOT NULL,
  changed_by   INTEGER,                        -- NEW.updated_by; NULL = cale automată (semnare)
  violation    BOOLEAN     NOT NULL DEFAULT FALSE,
  changed_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_alop_status_log_alop ON alop_status_log(alop_id, changed_at DESC);
CREATE INDEX IF NOT EXISTS idx_alop_status_log_viol ON alop_status_log(violation) WHERE violation = TRUE;
```

⚠️ **Verifică tipul real al `alop_instances.id`** (`INTEGER`? `BIGINT`? `UUID`?) și al
`users.id` pentru `changed_by`, **cu grep în migrații**, înainte de a scrie FK-urile.
Regula casei: tipurile FK se verifică, nu se presupun.

Fără FK cu `ON DELETE CASCADE` pe `alop_id` — **logul de audit trebuie să supraviețuiască
ștergerii ALOP-ului.** Un audit care dispare odată cu obiectul auditat e inutil.

### 1c. Trigger-ul de audit — `AFTER UPDATE`, loghează ORICE schimbare

```sql
CREATE OR REPLACE FUNCTION alop_status_audit() RETURNS TRIGGER AS $$
BEGIN
  IF NEW.status IS DISTINCT FROM OLD.status THEN
    INSERT INTO alop_status_log (alop_id, org_id, from_status, to_status, changed_by)
    VALUES (NEW.id, NEW.org_id, OLD.status, NEW.status, NEW.updated_by);
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_alop_status_audit ON alop_instances;
CREATE TRIGGER trg_alop_status_audit
  AFTER UPDATE ON alop_instances
  FOR EACH ROW EXECUTE FUNCTION alop_status_audit();
```

`IS DISTINCT FROM` ⇒ self-loop-urile (`ordonantare→ordonantare`) **nu** produc intrări. Corect:
nu sunt tranziții, sunt reaplicări idempotente.

`FOR EACH ROW` ⇒ update-ul bulk din `repair-status` (S2) produce **o intrare per rând**. Corect.

---

## PAS 2 — Migrarea `094_alop_state_guard` — trigger de validare, **MOD OBSERVARE**

Matricea reală, din `ALOP-STATE-MATRIX.md`. **Nu o modifica. Nu o „corecta".**

```
draft       → angajare | lichidare | cancelled
angajare    → lichidare | plata     | cancelled     -- angajare→plata vine din repair-status (S2)
lichidare   → ordonantare | cancelled
ordonantare → plata | cancelled
plata       → completed | cancelled
completed   → lichidare                              -- noua-lichidare: reluare ciclu ORD. CORECT.
cancelled   → (terminal)
```

```sql
CREATE OR REPLACE FUNCTION alop_status_guard() RETURNS TRIGGER AS $$
DECLARE
  allowed TEXT[];
BEGIN
  IF NEW.status IS NOT DISTINCT FROM OLD.status THEN
    RETURN NEW;                                   -- self-loop: nu e tranziție
  END IF;

  allowed := CASE OLD.status
    WHEN 'draft'       THEN ARRAY['angajare','lichidare','cancelled']
    WHEN 'angajare'    THEN ARRAY['lichidare','plata','cancelled']
    WHEN 'lichidare'   THEN ARRAY['ordonantare','cancelled']
    WHEN 'ordonantare' THEN ARRAY['plata','cancelled']
    WHEN 'plata'       THEN ARRAY['completed','cancelled']
    WHEN 'completed'   THEN ARRAY['lichidare']
    WHEN 'cancelled'   THEN ARRAY[]::TEXT[]
    ELSE ARRAY[]::TEXT[]
  END;

  IF NOT (NEW.status = ANY(allowed)) THEN
    -- ⚠️ FAZA 1 — MOD OBSERVARE. NU BLOCA.
    RAISE WARNING 'ALOP transition violation: % → % (alop_id=%)', OLD.status, NEW.status, NEW.id;
    INSERT INTO alop_status_log (alop_id, org_id, from_status, to_status, changed_by, violation)
    VALUES (NEW.id, NEW.org_id, OLD.status, NEW.status, NEW.updated_by, TRUE);
  END IF;

  RETURN NEW;                                     -- ← permite ORICE. Faza 1 nu blochează nimic.
END $$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_alop_status_guard ON alop_instances;
CREATE TRIGGER trg_alop_status_guard
  BEFORE UPDATE ON alop_instances
  FOR EACH ROW EXECUTE FUNCTION alop_status_guard();
```

⛔ **NU pune `RAISE EXCEPTION`. NU pune `RETURN NULL`. NU bloca nimic.**
Faza 1 **trebuie** să fie inofensivă. Dacă blochezi ceva și recon-ul a ratat o tranziție, oprești
semnarea în producție. Flipul spre `RAISE EXCEPTION` e o migrare separată, de o linie, **abia
după 7 zile cu zero violări pe producție**.

⚠️ **Dubla înregistrare:** o violare produce **două** rânduri în `alop_status_log` — unul de la
guard (`violation=TRUE`, `BEFORE`) și unul de la audit (`violation=FALSE`, `AFTER`). E acceptabil
și chiar util (vezi și că tranziția a fost aplicată). **Nu încerca să le deduplici** — ar cere
comunicare între triggere și ar complica inutil. Documentează comportamentul într-un comentariu.

---

## PAS 3 — Șterge codul mort

`server/routes/alop.mjs`:
- `VALID_TRANSITIONS` (linia ~159) — **zero apelanți**, și era **greșită** (îi lipseau trei
  tranziții reale). Șterge-o.
- `canTransition()` (linia ~168) — **zero apelanți**. Șterge-o.

`server/tests/unit/alop-state.test.mjs` — **ȘTERGE FIȘIERUL.** Își redeclară propria copie a
funcției la linia 31 (singurul lui import e `vitest`), deci testează o oglindă, nu producția.
E verde de luni de zile fără să verifice nimic. Îl înlocuiesc testele DB de la PAS 5, care
exercită trigger-ul real pe Postgres real.

```bash
grep -rn "canTransition\|VALID_TRANSITIONS" server/ public/
# Așteptat după ștergere: ZERO rezultate. Dacă apare ceva, OPREȘTE-TE.
```

---

## PAS 4 — Cardul de pe dashboard (ca să NU uităm de flip)

**Ăsta e motivul pentru care faza 2 se va întâmpla.** Fără el, trigger-ul rămâne în mod
observare la nesfârșit.

### Backend — extinde `GET /admin/alop/stats`

`server/routes/admin/flows.mjs:83`. Adaugă în răspuns un obiect `gate`:

```js
gate: {
  total_transitions: <COUNT(*) din alop_status_log>,
  violations:        <COUNT(*) FILTER (WHERE violation)>,
  observing_since:   <MIN(changed_at)>,      // NULL dacă tabela e goală
  days_observed:     <întregi, din NOW() - MIN(changed_at)>
}
```

⚠️ **Scope pe `org_id`?** Nu — e o metrică de sănătate a platformei, nu date de tenant. Ruta e
deja sub `/admin/`. Dar **verifică cine are acces la `/admin/alop/stats`** (`requireAdmin`?
`org_admin`?) și **nu lărgi accesul**. Dacă un `org_admin` o poate accesa, filtrează `gate`
pe `org_id`, sau expune `gate` doar pentru `role='admin'`. Raportează ce ai decis.

### Frontend — al 5-lea card

`public/js/admin/audit.js` (linia ~96 consumă deja `/admin/alop/stats`, ~123 randează cardurile).

Adaugă un card:

| Condiție | Afișare |
|---|---|
| `violations > 0` | 🔴 **roșu** — `„⚠️ N violări — NU activa poarta"` |
| `violations = 0` și `days_observed < 7` | 🟡 galben — `„Mod observare · 0 violări · ziua N/7"` |
| `violations = 0` și `days_observed >= 7` | 🟢 **verde** — `„✅ GATA DE ACTIVARE — flipează trigger-ul"` |
| `total_transitions = 0` | ⚪ gri — `„Mod observare · nicio tranziție încă"` |

⚠️ **Randează cu `textContent`/DOM API, nu `innerHTML` cu interpolare.** Am reparat un XSS
la #93 — nu introducem altul. Datele sunt numerice și vin de la server, dar tiparul rămâne.

⚠️ Folosește clasele de card existente din dashboard. **Nu inventa CSS nou.** Dacă ai nevoie de
o culoare, folosește token-ii din `tokens.css`.

### Cache

`public/js/admin/audit.js` **ESTE** în `PRECACHE_ASSETS` (`sw.js:28`).
- `?v=3.9.679` pe `audit.js` în `admin.html`
- `CACHE_VERSION`: `'docflowai-v288'` → `'docflowai-v289'`

Fără bump, adminii cu SW activ nu văd niciodată cardul. **Reminderul n-ar exista.**

---

## PAS 5 — `CLAUDE.md` (al doilea mecanism anti-uitare)

Adaugă o secțiune **la început**, sus, unde se vede:

```md
## ⏳ ÎN AȘTEPTARE — activarea porții ALOP

Trigger-ul `alop_status_guard` rulează în **mod observare** (RAISE WARNING) din 13.07.2026.
Nu blochează nimic — doar înregistrează în `alop_status_log`.

**De verificat după 21.07.2026** (sau când cardul „Poartă ALOP" din dashboard-ul admin
devine VERDE):

    SELECT COUNT(*) AS total,
           COUNT(*) FILTER (WHERE violation) AS violari,
           MIN(changed_at)::date AS din
    FROM alop_status_log;

- `violari = 0` și fereastră > 7 zile ⇒ **flip**: migrare nouă, `RAISE WARNING` →
  `RAISE EXCEPTION` + `RETURN NULL` în `alop_status_guard()`.
- `violari > 0` ⇒ **NU flipa.** Analizează tranziția, adaug-o în matrice dacă e legitimă
  (recon-ul #91 a ratat-o), repornește fereastra.

⛔ NU șterge această secțiune până nu e făcut flipul.
```

---

## PAS 6 — Teste DB (nu mock)

Fișier nou: `server/tests/db/alop-state-gate.test.mjs`. **Postgres real.**
`npm test` NU rulează suita DB — verificarea autoritară e CI.

1. **`CHECK`:** `UPDATE alop_instances SET status='inexistent'` ⇒ eroare de constrângere.
2. **Fiecare tranziție validă** din matrice ⇒ reușește **și** produce exact 1 rând în
   `alop_status_log` cu `violation=FALSE`, `from_status`/`to_status` corecte.
   (Parametrizează — sunt 13 tranziții valide. Nu le scrie de 13 ori manual.)
3. **Tranziție invalidă** (ex. `draft → completed`) ⇒ **REUȘEȘTE** (faza 1 nu blochează!) și
   produce un rând cu `violation=TRUE`. **Ăsta e testul-cheie al fazei 1** — dovedește
   simultan că observăm și că **nu blocăm**.
4. **Self-loop** (`angajare → angajare`) ⇒ **zero** rânduri în log.
5. **Update fără schimbare de status** (ex. doar `titlu`) ⇒ **zero** rânduri în log.
6. **`changed_by`** e populat din `updated_by` când e setat; `NULL` când nu (calea de semnare).
7. **Bulk** (`UPDATE ... WHERE org_id=X` pe 3 rânduri) ⇒ **3** rânduri în log.
8. **Atomicitate:** într-o tranzacție, `UPDATE` + `ROLLBACK` ⇒ **zero** rânduri în log.
   Ăsta demonstrează ce `writeAuditEvent` nu poate: auditul moare odată cu tranzacția.

⛔ **Testele exercită trigger-ul REAL în Postgres.** Nu redeclara matricea în JS. Nu simula
trigger-ul. Avem deja trei teste care își testează propria oglindă — pe unul tocmai îl ștergi.

---

## PAS 7 — Versiune și verificare

`package.json` → **v3.9.679** · `sw.js` `CACHE_VERSION` → `docflowai-v289` · `?v=3.9.679` pe `audit.js`.

```bash
git diff --name-only server/routes/flows/
# Așteptat: GOL. ZERO. Nu atingem niciun handler ALOP.

grep -rn "canTransition\|VALID_TRANSITIONS" server/ public/
# Așteptat: ZERO

ls server/tests/unit/alop-state.test.mjs
# Așteptat: No such file (șters)

grep -rn "RAISE EXCEPTION" server/db/index.mjs | grep -i alop
# Așteptat: ZERO — faza 1 nu blochează

grep -n "CACHE_VERSION" public/sw.js | head -1     # docflowai-v289
grep -rn "audit.js?v=" public/*.html | grep -v 3.9.679   # GOL

npm run check    # verde
npm test         # verde
npm run test:db  # rulează EXPLICIT — npm test NU-l acoperă
```

Commit:
```
feat(alop): poartă de stări în Postgres — CHECK, log append-only, trigger în mod observare (v3.9.679)
```

---

## RAPORT FINAL

1. **`git diff --name-only server/routes/flows/` — GOL?** Confirmă. (Dacă nu e gol, ai încălcat premisa promptului.)
2. Ce tip are `alop_instances.id`? Dar `users.id`? Cum ai tipat `alop_id` și `changed_by`?
3. Trigger-ul de validare — **`RAISE WARNING`, nu `EXCEPTION`**? `RETURN NEW` pe toate căile? Confirmă că **nu blochează nimic**.
4. Testul #3 (tranziție invalidă) — chiar **REUȘEȘTE** și produce `violation=TRUE`? Ăsta e testul care dovedește că faza 1 e inofensivă.
5. Testul #8 (ROLLBACK) — zero rânduri în log? Auditul e atomic?
6. Self-loop și update fără schimbare de status ⇒ zero rânduri? Confirmă.
7. Bulk pe 3 rânduri ⇒ 3 rânduri în log?
8. `VALID_TRANSITIONS` + `canTransition()` + `alop-state.test.mjs` — toate șterse? Grep gol?
9. Cine are acces la `/admin/alop/stats`? Ai filtrat `gate` pe rol/org sau nu? Ce ai decis și de ce?
10. Cardul: randat cu `textContent`/DOM API (nu `innerHTML`)? Ai atins CSS? `CACHE_VERSION` v289? `?v=3.9.679`?
11. Secțiunea „⏳ ÎN AȘTEPTARE" e în `CLAUDE.md`, sus?
12. `npm test` **și** `npm run test:db` — raportate **separat**. Ambele verzi?

---

## ⛔ CONSTRÂNGERI ABSOLUTE

- ⛔ **ZERO modificări în `server/routes/flows/`.** Niciun handler. `signing.mjs` nici măcar deschis pentru editare.
- ⛔ **Trigger-ul NU blochează.** `RAISE WARNING`, `RETURN NEW`. Fără `EXCEPTION`, fără `RETURN NULL`. Faza 1 e inofensivă prin construcție.
- ⛔ **NU „corecta" matricea.** `completed → lichidare` (înapoi) și `draft → lichidare` (salt) sunt **corecte și conforme legii**. Codul e specificația.
- ⛔ **NU crea fișiere `.sql` noi.** Migrațiile sunt inline în `db/index.mjs`, idempotente.
- ⛔ **NU presupune tipuri FK.** Verifică cu grep în migrații.
- ⛔ **NU pune FK cu `ON DELETE CASCADE`** pe `alop_status_log.alop_id`. Auditul supraviețuiește obiectului.
- ⛔ **NU folosi `innerHTML` cu interpolare** în card. Am reparat un XSS la #93.
- ⛔ **NU uita `CACHE_VERSION`.** Fără el, cardul nu ajunge la admini și mecanismul anti-uitare nu există.
- ⛔ **NU redeclara logica în teste.** Testele exercită Postgres real.
- ⛔ Zonele NO-TOUCH: doar citire. **NU atinge `main`.**
- ⛔ Dacă un grep nu dă `# Așteptat:`, **oprește-te și raportează.** Nu improviza.
