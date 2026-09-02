# PROMPT-158 — self-heal ALOP→DF: avansează pointerul și când df_id EXISTĂ dar e pe o revizie veche

⚠️ BRANCH: develop — NICIODATĂ main. `main` e producția, gestionată manual doar de Mircea.

**model_suggested:** Opus 5 (zonă financiară — `alop-link.mjs`/`alop.mjs`, tabelul care
alimentează plafoanele de ordonanțare; risc redus prin design defensiv, dar cere atenție
la nuanțe, nu Sonnet)
**cache_version_bump:** NU — strict backend
**migrations:** NU
**target:** citește `package.json` ÎNAINTE de orice modificare, incrementează patch-ul cu 1

## Context — cauza rădăcină, confirmată pe cod (nu se rediscută)

Pe producție s-au găsit 3 dosare ALOP unde `alop_instances.df_id` pointează la revizia
VECHE (R0) a DF-ului, deși există o revizie mai nouă (R1) deja APROBATĂ. Simptom: cardul
ALOP arată corect „DF în vigoare: R1" (derivat separat, #135) dar și un avertisment
„⚠ legătură DF de verificat" (`_revStare.incoerent` în `alop.js:669`), iar cifrele
financiare din antet (`df_valoare`, `credite_bugetare_an_curent`) — care SUNT citite prin
JOIN pe pointerul brut `a.df_id`, nu prin derivarea corectă — arată valorile R0, nu R1.
Reparate manual pe producție cele 3 găsite, dar cauza rămâne DESCHISĂ:

Există TREI mecanisme de auto-vindecare în `server/services/alop-link.mjs`:
1. `selfHealAlopDfLink(pool, flowId)` — SINGURUL care avansează efectiv pointerul între
   revizii ale ACELUIAȘI dosar (are gardă corectă: `df_id IS NULL OR (aceeași cheie de
   dosar)`). Dar e apelat DOAR din `signing.mjs`/`crud.mjs` (calea de upload LOCAL) — a
   fost scos din `cloud-signing.mjs` la #118 (curățarea zonei NO-TOUCH). Cum TOATE
   fluxurile din producție merg prin `sts-cloud` (confirmat separat, în ancheta P0-06),
   funcția asta nu se mai declanșează practic NICIODATĂ.
2. `selfHealAlopDfLinkByAlop(pool, alopId)` — lazy, apelată din `GET /api/alop/:id`.
   Gardată STRICT pe `df_id IS NULL` (linia cu `AND df_id IS NULL` din UPDATE) — recunoaște
   explicit în comentariul din cod că „df_id EXISTĂ" e un caz pe lângă care trece.
3. `backfillAlopFlowPointers` — completează DOAR `df_flow_id`/`df_completed_at` când
   lipsesc; documentat explicit „NU mută df_id". Rămâne complet neatinsă în acest lot —
   e un caz diferit (pointer CORECT dar sub-câmpuri goale).

Fixul: extinde #2 (`selfHealAlopDfLinkByAlop`) să avanseze și un `df_id` EXISTENT, când nu
mai e revizia cu numărul maxim aprobată a dosarului — cu o gardă de siguranță care nu
suprascrie o relegare manuală către un dosar diferit.

## Fișiere atinse (EXACT 3, plus test)

1. `server/services/alop-link.mjs` — extinde `selfHealAlopDfLinkByAlop`
2. `server/routes/alop.mjs` — lărgește condiția care declanșează self-heal-ul din
   `GET /api/alop/:id`
3. `package.json` — bump patch
4. Fișier de test (extins sau nou — vezi Etapa D)

═══════════════════════════════════════════════════════════════════
## PASUL 0 — verificări obligatorii
═══════════════════════════════════════════════════════════════════

```bash
git branch --show-current
# Așteptat: develop

git status --short
# Așteptat: gol sau doar fișiere netrackuite cunoscute

grep -rn "PROMPT-158" docs/archive/ 2>/dev/null
git log --all --oneline | grep -i "#158"
# Așteptat: ambele goale. Dacă #158 e deja folosit, OPREȘTE-TE — nu renumerota

grep '"version"' package.json
# Notează valoarea — folosește patch-ul + 1 consecvent mai jos

grep -c "export async function selfHealAlopDfLinkByAlop" server/services/alop-link.mjs
grep -c "if (!alop.df_id) {" server/routes/alop.mjs
# Așteptat: 1 și 1 — dacă nu, fișierele s-au schimbat față de premisa promptului, STOP
```

═══════════════════════════════════════════════════════════════════
## ETAPA A — `server/services/alop-link.mjs`
═══════════════════════════════════════════════════════════════════

### A1. JSDoc — actualizează descrierea funcției

```
old_str:
/**
 * selfHealAlopDfLinkByAlop — varianta LAZY, cheiată pe alopId, apelată din
 * GET /api/alop/:id. Rezolvă cazul „ALOP fără DF" fără a atinge calea de semnare:
 * caută documentul DF care revendică ALOP-ul prin `source_alop_id`, cu flux
 * FINALIZAT, și îl reataşează. Marchează și `status='aprobat'` (calea cloud nu o face).
 * Oglindește self-heal #1 pentru ORD din alop.mjs. Non-fatală și idempotentă.
 * Ambiguitatea (mai multe candidate cu revizia MAXIMĂ) se rezolvă prin SKIP + warn.
 */

new_str:
/**
 * selfHealAlopDfLinkByAlop — varianta LAZY, cheiată pe alopId, apelată din
 * GET /api/alop/:id. Rezolvă DOUĂ cazuri, fără a atinge calea de semnare:
 *  (1) „ALOP fără DF" — df_id NULL: caută documentul DF care revendică ALOP-ul
 *      prin `source_alop_id`, cu flux FINALIZAT, și îl reataşează.
 *  (2) #158 — „ALOP cu DF pe o revizie VECHE": df_id EXISTĂ dar nu (mai) e revizia
 *      cu numărul maxim aprobată a dosarului — tipic R0 legacy (fără source_alop_id),
 *      în timp ce R1 a fost aprobată separat prin calea CLOUD, care nu poate apela
 *      `selfHealAlopDfLink` din `signing.mjs` (zonă NO-TOUCH). Avansează pointerul.
 * Marchează și `status='aprobat'` (calea cloud nu o face). Oglindește self-heal #1
 * pentru ORD din alop.mjs. Non-fatală și idempotentă.
 * Ambiguitatea (mai multe candidate cu revizia MAXIMĂ) se rezolvă prin SKIP + warn.
 * Siguranță la (2): pointerul VECHI se suprascrie DOAR dacă documentul la care
 * pointează azi are ACELAȘI nr_unic_inreg ca revizia găsită — protejează o
 * relegare manuală deliberată către un DF dintr-un dosar complet diferit.
 */

```

### A2. Query candidați — adaugă `nr_unic_inreg` (necesar la garda de siguranță)

```
old_str:
    const { rows: cands } = await pool.query(`
      SELECT fd.id, fd.flow_id, fd.revizie_nr, fd.status,
             (f.data->>'completedAt') AS completed_at
        FROM formulare_df fd
        JOIN flows f ON f.id = fd.flow_id
       WHERE fd.source_alop_id = $1
         AND fd.deleted_at IS NULL
         AND ${dfAprobatSql('fd', 'f')}
       ORDER BY fd.revizie_nr DESC, fd.created_at DESC
    `, [alopId]);

new_str:
    const { rows: cands } = await pool.query(`
      SELECT fd.id, fd.flow_id, fd.revizie_nr, fd.status, fd.nr_unic_inreg,
             (f.data->>'completedAt') AS completed_at
        FROM formulare_df fd
        JOIN flows f ON f.id = fd.flow_id
       WHERE fd.source_alop_id = $1
         AND fd.deleted_at IS NULL
         AND ${dfAprobatSql('fd', 'f')}
       ORDER BY fd.revizie_nr DESC, fd.created_at DESC
    `, [alopId]);
```

### A3. UPDATE-ul de relegare — inima fixului

⚠️ Citește cu atenție cele DOUĂ ramuri din `CASE WHEN` — cazul vechi (`df_id IS NULL`)
păstrează EXACT semantica `COALESCE` de azi (zero schimbare de comportament pentru el);
doar cazul NOU (`df_id` există, revizie veche) suprascrie necondiționat, fiindcă
sub-câmpurile vechi aparțin revizei greșite și n-are sens să fie păstrate.

```
old_str:
    const { rows: linked } = await pool.query(`
      UPDATE alop_instances
         SET df_id = $1,
             df_flow_id = COALESCE(df_flow_id, $2),
             df_completed_at = COALESCE(df_completed_at, $3::timestamptz, NOW()),
             updated_at = NOW()
       WHERE id = $4
         AND df_id IS NULL
         AND cancelled_at IS NULL
      RETURNING id, df_id, df_flow_id, df_completed_at
    `, [cand.id, cand.flow_id, cand.completed_at || null, alopId]);

new_str:
    // #158 — pe lângă df_id NULL, avansăm și un pointer EXISTENT dar pe o revizie
    // veche (vezi JSDoc de mai sus). Siguranță: doar dacă documentul vechi are
    // ACELAȘI nr_unic_inreg ca revizia găsită (același dosar fizic) — altfel o
    // relegare manuală către alt dosar ar fi suprascrisă tăcut.
    const { rows: linked } = await pool.query(`
      UPDATE alop_instances a
         SET df_id = $1,
             df_flow_id = CASE WHEN a.df_id IS NULL THEN COALESCE(a.df_flow_id, $2) ELSE $2 END,
             df_completed_at = CASE WHEN a.df_id IS NULL
                                     THEN COALESCE(a.df_completed_at, $3::timestamptz, NOW())
                                     ELSE COALESCE($3::timestamptz, NOW()) END,
             updated_at = NOW()
       WHERE a.id = $4
         AND a.cancelled_at IS NULL
         AND a.df_id IS DISTINCT FROM $1
         AND (
           a.df_id IS NULL
           OR EXISTS (
             SELECT 1 FROM formulare_df fd_old
              WHERE fd_old.id = a.df_id AND fd_old.nr_unic_inreg = $5
           )
         )
      RETURNING id, df_id, df_flow_id, df_completed_at
    `, [cand.id, cand.flow_id, cand.completed_at || null, alopId, cand.nr_unic_inreg]);
```

Verificare:
```bash
grep -c "a.df_id IS DISTINCT FROM \$1" server/services/alop-link.mjs
# Așteptat: 1
grep -c "fd_old.nr_unic_inreg = \$5" server/services/alop-link.mjs
# Așteptat: 1
```

═══════════════════════════════════════════════════════════════════
## ETAPA B — `server/routes/alop.mjs`: lărgește condiția de declanșare
═══════════════════════════════════════════════════════════════════

```
old_str:
    if (!alop.df_id) {
      const healed = await selfHealAlopDfLinkByAlop(pool, req.params.id);
      if (healed) {
        alop.df_id           = healed.df_id;
        alop.df_flow_id      = healed.df_flow_id;
        alop.df_completed_at = healed.df_completed_at;
        alop.df_aprobat      = true;
      }
    }

new_str:
    // #158 — pe lângă „fără DF" (df_id NULL), și pointer EXISTENT dar pe o revizie
    // mai veche decât cea în vigoare (df_revizie_vigoare_nr, derivat pe dosar la
    // #135) — calea cloud nu poate avansa singură pointerul (vezi alop-link.mjs).
    if (!alop.df_id || (alop.df_revizie_vigoare_nr != null && alop.df_revizie_nr !== alop.df_revizie_vigoare_nr)) {
      const healed = await selfHealAlopDfLinkByAlop(pool, req.params.id);
      if (healed) {
        alop.df_id           = healed.df_id;
        alop.df_flow_id      = healed.df_flow_id;
        alop.df_completed_at = healed.df_completed_at;
        alop.df_aprobat      = true;
      }
    }
```

⚠️ NOTĂ IMPORTANTĂ, de raportat ca fapt cunoscut (NU de „reparat" în acest lot): după
heal, răspunsul ACESTEI cereri poate afișa în continuare cifrele financiare vechi
(`df_valoare`, `credite_bugetare_an_curent` etc.) — ele au fost deja citite din SQL cu
pointerul VECHI, înainte de heal, și codul patchează doar `df_id`/`df_flow_id`/
`df_completed_at`/`df_aprobat`, nu tot rândul. La a DOUA deschidere (reload), cifrele sunt
corecte. E exact comportamentul deja existent pentru cazul „fără DF" — nu introduci nimic
nou, doar îl moștenești.

Verificare:
```bash
grep -c "alop.df_revizie_vigoare_nr != null && alop.df_revizie_nr !== alop.df_revizie_vigoare_nr" server/routes/alop.mjs
# Așteptat: 1
```

═══════════════════════════════════════════════════════════════════
## ETAPA C — versionare
═══════════════════════════════════════════════════════════════════

- `package.json`: `"version"` → patch-ul curent + 1

═══════════════════════════════════════════════════════════════════
## ETAPA D — teste (obligatorii, nu opționale — zonă financiară)
═══════════════════════════════════════════════════════════════════

Verifică întâi dacă `server/tests/db/df-alop-link-resilienta.test.mjs` are deja fixturi
reutilizabile pentru `selfHealAlopDfLinkByAlop` (nume de tabel, helperi de creare
ALOP/DF/flux) — dacă da, extinde ACEL fișier cu un `describe` nou; dacă structura nu se
potrivește curat, creează `server/tests/db/alop-link-revizie-veche.test.mjs` nou, pe
același tipar (Postgres real, nu mock-uri pe `pool.query` — comportamentul e prea fin
pentru mock-uri, exact lecția #118 „mock-urile confirmă forma, nu comportamentul").

Cazuri OBLIGATORII, toate pe date reale (fixturi inserate direct, nu prin rute HTTP):

1. **Avansare corectă**: ALOP cu `df_id`→R0 (fără `source_alop_id`, `nr_unic_inreg='X'`);
   R1 (`source_alop_id`=alop.id, `nr_unic_inreg='X'`, `revizie_nr=1`) pe un flux APROBAT
   (`status='completed'` sau `completed=true`, `deleted_at IS NULL`, nu `cancelled`/
   `refused`) → după `selfHealAlopDfLinkByAlop`, `alop.df_id` devine R1, `df_flow_id`/
   `df_completed_at` reflectă R1 (NU mai sunt cele vechi ale lui R0, dacă R0 avea vreo
   valoare pe ele)
2. **Siguranță — nr_unic_inreg diferit**: `df_id` pointează la un DF cu `nr_unic_inreg`
   DIFERIT de cel al candidatului găsit (simulează o relegare manuală către alt dosar) →
   `selfHealAlopDfLinkByAlop` întoarce `null`, `df_id` RĂMÂNE neschimbat
3. **Idempotență**: rulează funcția A DOUA OARĂ imediat după cazul 1 → a doua rulare NU
   mai schimbă nimic (fie întoarce `null`, fie `linked[0]` egal cu starea deja setată —
   verifică ce se întâmplă REAL, nu presupune)
4. **Cazul vechi rămâne intact**: `df_id IS NULL` (fără nicio revizie anterioară) →
   comportament IDENTIC cu azi (regresie zero pe calea existentă)
5. **Cazul B rămas neatins**: `backfillAlopFlowPointers` — un test rapid care confirmă
   că funcția aia tot NU mută `df_id` (poate fi un `it` care doar re-rulează un test
   existent, dacă există, sau unul nou minimal)
6. **Ruta**: cel puțin un test la nivel de rută (`GET /api/alop/:id`) care confirmă că
   noua condiție din `alop.mjs` chiar declanșează `selfHealAlopDfLinkByAlop` pe cazul
   „df_id există, revizie veche" — nu doar funcția izolat

```bash
npm run test:db
# Așteptat: PASSED REAL pe Postgres (efemer sau Docker), inclusiv toate cazurile noi.
# NU accepta „skipped" ca dovadă — pe zona asta financiară, testul DB e obligatoriu,
# nu opțional (spre deosebire de loturi strict-frontend din alte prompturi)

npm test
# Așteptat: verde, 0 failed
```

═══════════════════════════════════════════════════════════════════
## RAPORT FINAL (obligatoriu în răspunsul tău)
═══════════════════════════════════════════════════════════════════

- Versiune veche → nouă
- Commit hash + `git diff --stat`
- Rezultat `npm test` ȘI `npm run test:db` — cu mențiune explicită PASSED REAL, nu skipped
- Pentru fiecare din cele 6 cazuri de test de mai sus: ce anume s-a verificat și rezultatul
- Confirmare, prin citire directă a codului: `selfHealAlopDfLink` (funcția principală,
  cheiată pe flowId) și `backfillAlopFlowPointers` NU au fost atinse deloc
- Orice abatere, cu motivul

═══════════════════════════════════════════════════════════════════
## ⛔ CONSTRÂNGERI ABSOLUTE
═══════════════════════════════════════════════════════════════════

- ⛔ NU atinge `selfHealAlopDfLink` (funcția principală, cheiată pe flowId) — rămâne
  exact cum e, e deja corectă, doar subfolosită
- ⛔ NU atinge `backfillAlopFlowPointers` — caz diferit, neatins
- ⛔ NU atinge nicio interogare de cifre financiare (`df_valoare`, `credite_bugetare_an_curent`,
  `ramas_an_curent` etc.) din `alop.mjs` — acest lot repară DOAR pointerul, nu recalculează
  nimic
- ⛔ NU atinge `server/signing/**`, `cloud-signing.mjs`, `bulk-signing.mjs` — zona NO-TOUCH,
  neafectată de acest lot
- ⛔ NU folosi mock-uri pe `pool.query` pentru testele noi — Postgres real, obligatoriu
- ⛔ NU propune niciodată merge/push/checkout pe `main`
- ⛔ Dacă `#158` e deja folosit, OPREȘTE-TE și raportează

Ultimul pas, obligatoriu:
```bash
git push origin develop
```
