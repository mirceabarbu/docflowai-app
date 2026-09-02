---
prompt: 164
titlu: "Integritatea legăturilor document↔flux la anulare și desfacere"
model_suggested: "Opus 5, efort high"
branch: develop
versiune_curenta: v3.9.817
versiune_tinta: v3.9.818
migratii: DA — UNA, pe funcția `alop_status_guard()` (fără atingerea datelor)
fisiere_din_public: NU  (⇒ fără CACHE_VERSION, fără bump `?v=`)
zona_no_touch_atinsa: NU
---

# ⚠️ BRANCH

Lucrezi **EXCLUSIV pe `develop`**. `main` = PRODUCȚIE, gestionat manual de Mircea.
Pasul final: `git push origin develop`.

---

## Context — trei incidente reale din 31.08.2026, aceeași cauză

Legătura document↔flux e ținută în patru locuri scrise de rute diferite, cu condiții
diferite: `formulare_*.flow_id`, `alop_instances.*_flow_id`, statusul-cache al formularului
și `flows.data`. Când ele divergă, dosarul se blochează. Cazurile, verificate pe producție:

**(1) ORD 46055.** Utilizatorul a lansat fluxul ORD de două ori. Garda #120
(`crud.mjs:485`) a refuzat corect ca al doilea flux să fure `formulare_ord.flow_id` — dar
`POST /api/alop/:id/link-ord-flow` (`alop.mjs:1540`) scrie `ord_flow_id` **necondiționat**,
deci pointerul ALOP a trecut pe al doilea flux. Semnarea s-a făcut pe al doilea; s-a anulat
primul; iar `cancel` (`lifecycle.mjs:~594`) a golit `ord_flow_id` cheiat pe **`ord_id`**, nu
pe „pointerul chiar arăta spre fluxul anulat" ⇒ a șters legătura către fluxul SEMNAT.
Dosarul a rămas blocat în `ordonantare` cu ORD-ul afișat „Completat" în loc de „Aprobat".

**(2) DF 46149.** După `admin-cancel` pe fluxul DF finalizat, `alop.df_flow_id` și
`df_completed_at` au rămas intacte. Cauza: `undoCompletedFlowLinks`
(`services/flow-undo.mjs:36`) resetează DF-ul cu predicatul `status='transmis_flux'`, dar pe
calea de semnare CLOUD statusul rămâne `completed` (vezi antetul lui
`services/df-aprobat-sql.mjs`). `UPDATE`-ul a prins 0 rânduri, iar curățarea pointerilor
ALOP stă **în interiorul** aceluiași `if (dfRows.length)` ⇒ a fost sărită complet.

**(3) Consecința lui (2).** ALOP-ul a rămas în `lichidare` pe baza unui DF a cărui aprobare
tocmai fusese desfăcută, deci `df_action` nu se mai calcula (`alop-capabilities.mjs:84`
îl calculează doar în `draft`/`angajare`) și fluxul DF nu mai putea fi relansat. Reparația a
cerut trei intervenții manuale pe producție, inclusiv coborârea temporară a porții ALOP din
`RAISE EXCEPTION` în `RAISE WARNING` — fiindcă `lichidare → angajare` nu e în matrice.

Acest prompt închide toate trei în cod. **NU** atinge stratul de afișare (expresiile laxe de
„DF aprobat" din `shared.mjs:538` și `df.mjs:578`) — acela e #165, cu matricea lui de teste
filtru↔badge.

---

## ETAPA 0 — ancore (READ-ONLY, obligatorie)

```bash
git branch --show-current                      # Așteptat: develop
node -p "require('./package.json').version"    # Așteptat: 3.9.817
git status --short                             # arbore fără modificări trackuite

grep -n "SET ord_flow_id=\$1, updated_at=NOW(), updated_by=\$4" server/routes/alop.mjs
# Așteptat: EXACT 1 linie (link-ord-flow)
grep -n "WHERE ord_id=\$1 AND cancelled_at IS NULL" server/routes/flows/lifecycle.mjs
# Așteptat: EXACT 1 linie (ramura ORD din `cancel`)
grep -n "WHERE df_id=\$1 AND cancelled_at IS NULL" server/routes/flows/lifecycle.mjs
# Așteptat: EXACT 1 linie (ramura DF din `cancel`)
grep -n "status='transmis_flux'" server/services/flow-undo.mjs
# Așteptat: EXACT 1 linie
grep -n "id: '1[0-9][0-9]_" server/db/index.mjs | tail -5
# NOTEAZĂ ultima migrație existentă. Migrația nouă primește următorul număr liber —
# ⛔ NU presupune că e 110; între 109 și azi pot exista altele.
```

⛔ Orice nepotrivire ⇒ **oprește-te și raportează**. Promptul e scris pe arhiva v3.9.814;
liniile pot fi deplasate, dar formele de mai sus trebuie să existe exact o dată.

---

## ETAPA A — `link-ord-flow` nu mai deturnează un pointer viu

`server/routes/alop.mjs`, ruta `POST /api/alop/:id/link-ord-flow`.

Înlocuiește `UPDATE`-ul cu varianta gardată. Predicatul e **același** cu cel din
`crud.mjs:485` (#120), ca să existe o singură definiție de „pointer liber sau mort":

`old_str`:

```js
    const { rows } = await pool.query(`
      UPDATE alop_instances
      SET ord_flow_id=$1, updated_at=NOW(), updated_by=$4
      WHERE id=$2 AND org_id=$3
      RETURNING *
    `, [flow_id, req.params.id, actor.orgId, actor.userId]);

    if (!rows[0]) return res.status(404).json({ error: 'not_found' });
```

`new_str`:

```js
    // #164 — gardă anti-deturnare, simetrică cu `crud.mjs` (#120) și cu flip-ul DF de mai
    // sus: pointerul ORD se mută DOAR dacă e liber, dacă e deja al acestui flux
    // (idempotent la retry/dublu-click), sau dacă fluxul pe care stă e MORT. Fără ea, al
    // doilea flux al aceluiași ORD fura pointerul de pe primul, iar anularea ulterioară a
    // unuia dintre ele rupea legătura către cel semnat (incidentul ORD 46055, 31.08.2026).
    const { rows } = await pool.query(`
      UPDATE alop_instances
      SET ord_flow_id=$1, updated_at=NOW(), updated_by=$4
      WHERE id=$2 AND org_id=$3
        AND (
          ord_flow_id IS NULL
          OR ord_flow_id = $1
          OR NOT EXISTS (
            SELECT 1 FROM flows f
             WHERE f.id::text = alop_instances.ord_flow_id
               AND f.deleted_at IS NULL
               AND f.data->>'status' IS DISTINCT FROM 'cancelled'
               AND f.data->>'status' IS DISTINCT FROM 'refused'
          )
        )
      RETURNING *
    `, [flow_id, req.params.id, actor.orgId, actor.userId]);

    // rowCount 0 NU înseamnă „ALOP inexistent" — existența lui a fost deja dovedită de
    // `alopRows` mai sus. Înseamnă că garda a blocat deturnarea. Răspundem 200 cu starea
    // reală (decizia de produs din #120: nu rupem fluxul apelantului), dar o logăm.
    let alopRow = rows[0] || null;
    if (!alopRow) {
      logger.warn({ alopId: req.params.id, flowId: flow_id },
        '[ALOP] link-ord-flow: pointer ORD deja pe un flux VIU — legare refuzata (posibil dublu-click)');
      const { rows: cur } = await pool.query(
        'SELECT * FROM alop_instances WHERE id=$1 AND org_id=$2',
        [req.params.id, actor.orgId]
      );
      alopRow = cur[0] || null;
      if (!alopRow) return res.status(404).json({ error: 'not_found' });
    }
```

Apoi, la finalul rutei, `res.json({ ok: true, alop: rows[0] })` devine
`res.json({ ok: true, alop: alopRow })`. Verifică prin grep că nu mai rămâne nicio
referință la `rows[0]` în această rută.

⛔ Nu schimba codul HTTP pe calea blocată și nu adăuga un cod de eroare nou: ar cere
modificări în `public/`, iar lotul acesta e strict backend.

---

## ETAPA B — `cancel` curăță DOAR pointerul care chiar arăta spre fluxul anulat

`server/routes/flows/lifecycle.mjs`, handlerul `POST /flows/:flowId/cancel`.

**B1 — ramura DF.** `old_str`:

```js
          `UPDATE alop_instances
           SET df_flow_id=NULL, df_completed_at=NULL, updated_at=NOW()
           WHERE df_id=$1 AND cancelled_at IS NULL`,
          [cancelledDf.id]
```

`new_str`:

```js
          // #164 — scoped pe fluxul ANULAT. Cheiat doar pe `df_id`, un al doilea flux al
          // aceluiași document ștergea pointerul către primul (incidentul ORD 46055).
          `UPDATE alop_instances
           SET df_flow_id=NULL, df_completed_at=NULL, updated_at=NOW()
           WHERE df_id=$1 AND cancelled_at IS NULL AND df_flow_id=$2`,
          [cancelledDf.id, flowId]
```

**B2 — ramura ORD.** `old_str`:

```js
          `UPDATE alop_instances
             SET ord_flow_id=NULL, ord_completed_at=NULL, updated_at=NOW()
           WHERE ord_id=$1 AND cancelled_at IS NULL`,
          [ordId]
```

`new_str`:

```js
          // #164 — scoped pe fluxul ANULAT (vezi B1).
          `UPDATE alop_instances
             SET ord_flow_id=NULL, ord_completed_at=NULL, updated_at=NOW()
           WHERE ord_id=$1 AND cancelled_at IS NULL AND ord_flow_id=$2`,
          [ordId, flowId]
```

⛔ Nu atinge `SELECT`-urile de deasupra și nu muta logurile.

---

## ETAPA C — `undoCompletedFlowLinks`: ramura DF completă

`server/services/flow-undo.mjs`. Blocul 1) se rescrie integral.

`old_str`:

```js
  // 1) DF: readuce DF-ul 'transmis_flux' la 'completed' și curăță pointerul DF pe ALOP.
  const { rows: dfRows } = await client.query(
    `UPDATE formulare_df SET status='completed', updated_at=NOW()
       WHERE flow_id=$1 AND status='transmis_flux'
       RETURNING id`,
    [flowId]
  );
  if (dfRows.length) {
    dfId = dfRows[0].id;
    const { rows: aRows } = await client.query(
      `UPDATE alop_instances
          SET df_flow_id=NULL, df_completed_at=NULL, updated_at=NOW()
        WHERE df_id=$1 AND cancelled_at IS NULL
        RETURNING id`,
      [dfId]
    );
    if (aRows.length) alopId = aRows[0].id;
  }
```

`new_str`:

```js
  // 1) DF — #164. DOUĂ corecții față de forma inițială, ambele dovedite pe producție
  //    (DF 46149, 31.08.2026):
  //    (a) predicatul `status='transmis_flux'` acoperea O SINGURĂ stare din trei. Pe calea
  //        de semnare CLOUD statusul rămâne 'completed' (vezi `services/df-aprobat-sql.mjs`),
  //        iar self-heal-ul din `alop-link.mjs` îl poate promova la 'aprobat'. Documentul se
  //        găsește după `flow_id`, iar statusul se resetează doar dacă e unul „pe flux".
  //    (b) curățarea pointerilor ALOP era ÎN INTERIORUL lui `if (dfRows.length)` ⇒ când
  //        predicatul nu prindea, ALOP-ul rămânea agățat de fluxul desfăcut. Acum e
  //        independentă și scoped pe fluxul curent.
  const { rows: dfFound } = await client.query(
    `SELECT id, status FROM formulare_df WHERE flow_id=$1 AND deleted_at IS NULL`,
    [flowId]
  );
  if (dfFound.length) {
    dfId = dfFound[0].id;
    if (['transmis_flux', 'aprobat'].includes(dfFound[0].status)) {
      await client.query(
        `UPDATE formulare_df SET status='completed', updated_at=NOW() WHERE id=$1`,
        [dfId]
      );
    }
    // ALOP: eliberează pointerul DF ȘI readu dosarul în faza de angajare, ca fluxul să
    // poată fi relansat. `lichidare → angajare` DOAR dacă lichidarea nu e confirmată —
    // altfel am rescrie un pas financiar deja făcut. Simetric cu `plata → ordonantare`
    // de la ramura ORD (legalizat în migrația 103; această tranziție e legalizată în
    // migrația introdusă de #164).
    const { rows: aRows } = await client.query(
      `UPDATE alop_instances
          SET df_flow_id=NULL, df_completed_at=NULL,
              status = CASE
                WHEN status='lichidare' AND lichidare_confirmed_at IS NULL AND ord_id IS NULL
                THEN 'angajare' ELSE status END,
              updated_at=NOW()
        WHERE df_id=$1 AND cancelled_at IS NULL AND df_flow_id=$2
        RETURNING id, status`,
      [dfId, flowId]
    );
    if (aRows.length) {
      alopId = aRows[0].id;
      if (aRows[0].status === 'angajare') statusChanged = true;
    }
  }
```

⛔ Nu atinge blocul 2) (ORD) și nu muta docblock-ul fișierului. Actualizează însă docblock-ul
cu o frază care spune că ramura DF resetează și statusul ALOP — altfel următorul cititor
crede că doar ORD-ul o face.

---

## ETAPA D — migrația: `lichidare → angajare` devine tranziție legală

În `server/db/index.mjs`, la finalul array-ului `MIGRATIONS`, o migrație nouă cu
**următorul id liber** identificat la Etapa 0 (sufix `_alop_matrix_undo_df`).

Conținut: `CREATE OR REPLACE FUNCTION alop_status_guard()` — corpul **identic** cu cel al
migrației 109 (deci `RAISE EXCEPTION ... USING ERRCODE = 'check_violation'`, poarta rămâne
în blocare), cu **o singură** modificare în matrice:

```
  WHEN 'lichidare'   THEN ARRAY['ordonantare','angajare','cancelled']
```

⚠️ Trei cerințe absolute:

1. **Poarta rămâne pe `RAISE EXCEPTION`.** O migrație care ar readuce `RAISE WARNING` ar
   dezarma tăcut singura apărare structurală a mașinii financiare. Testul
   `server/tests/db/alop-gate-enforcing.test.mjs` (cazul 7) asertează pe
   `pg_get_functiondef` că funcția conține `RAISE EXCEPTION` — trebuie să treacă neatins.
2. Păstrează comentariul de închidere care conține tokenul `alop_instances`, exact ca la
   109 — runner-ul îl folosește pentru deferral. ⛔ Nu-l șterge.
3. **Fără `DROP`/`CREATE TRIGGER`.** `CREATE OR REPLACE` păstrează legătura cu
   `trg_alop_status_guard`; tabela `alop_instances` nu se atinge.

Adaugă în comentariul migrației motivul: fără această tranziție, `admin-cancel` pe un flux
DF ar face `ROLLBACK` la întreaga tranzacție (poarta aruncă) și ar întoarce 500 — adică
Etapa C fără Etapa D e o regresie, nu o reparație.

---

## ETAPA E — teste

Fișier nou `server/tests/db/flow-undo-links.test.mjs` (PostgreSQL REAL), minim:

**A — link-ord-flow:**
1. ALOP fără pointer + flux viu ⇒ `ord_flow_id` se setează.
2. Pointer pe fluxul A **viu**, se cere legarea lui B ⇒ `ord_flow_id` rămâne **A**,
   răspuns 200, `alop` întors are pointerul A. ⭐ cazul incidentului.
3. Pointer pe fluxul A **anulat** (sau soft-șters) ⇒ legarea lui B **reușește**.
4. Legare repetată cu același flux ⇒ idempotent, fără eroare.

**B — cancel scoped:**
5. `formulare_ord.flow_id = A`, `alop.ord_flow_id = B`; se anulează **A** ⇒ `ord_flow_id`
   rămâne **B**. ⭐ Fără fix, devine NULL — exact ORD 46055.
6. Se anulează fluxul chiar pointat ⇒ pointerul se golește (comportamentul de azi, păstrat).
7. Aceleași două cazuri pe ramura DF.

**C+D — undoCompletedFlowLinks:**
8. DF în `completed` (calea cloud), ALOP în `lichidare` fără lichidare confirmată ⇒ după
   `admin-cancel`: `df_flow_id` NULL, `df_completed_at` NULL, status `angajare`. ⭐ DF 46149.
9. Același caz cu DF în `transmis_flux` ⇒ identic, plus statusul DF revine la `completed`.
10. Același caz cu DF în `aprobat` ⇒ identic.
11. ALOP cu `lichidare_confirmed_at` setat ⇒ pointerii se curăță, dar statusul **NU** se
    schimbă. ⭐ apără pasul financiar deja făcut.
12. ALOP cu `ord_id` setat ⇒ statusul nu se schimbă.
13. `admin-cancel` pe un flux DF **nu** întoarce 500 (dovada că D e prezentă și poarta
    acceptă tranziția) și lasă dosarul relansabil.

Nu slăbi niciun test existent ca să treacă lotul. Dacă `alop-gate-enforcing.test.mjs` cade,
migrația e greșită — nu testul.

---

## ETAPA F — verificări, versionare, push

```bash
node --check server/routes/alop.mjs
node --check server/routes/flows/lifecycle.mjs
node --check server/services/flow-undo.mjs
node --check server/db/index.mjs
npm run check                       # exit 0

grep -c "WHERE ord_id=\$1 AND cancelled_at IS NULL\"" server/routes/flows/lifecycle.mjs   # 0
grep -n "AND ord_flow_id=\$2" server/routes/flows/lifecycle.mjs                            # 1 linie
grep -n "AND df_flow_id=\$2"  server/routes/flows/lifecycle.mjs                            # 1 linie
grep -c "status='transmis_flux'" server/services/flow-undo.mjs                             # 0

npm test
npm run test:db                     # PG 17 efemer, port 55432. PASSED, nu SKIPPED.
```

Migrația se rulează de **două ori** pe instanța efemeră: a doua rulare trebuie să fie
inofensivă (`CREATE OR REPLACE`), iar poarta să rămână pe `RAISE EXCEPTION`.

```bash
# package.json: 3.9.817 → 3.9.818   ⛔ fără CACHE_VERSION, fără `?v=`
git add server/routes/alop.mjs server/routes/flows/lifecycle.mjs \
        server/services/flow-undo.mjs server/db/index.mjs \
        server/tests/db/flow-undo-links.test.mjs package.json
git status --short
git commit -m "#164: integritatea legaturilor document-flux la anulare si desfacere (v3.9.818)"
git push origin develop
```

---

## RAPORT FINAL

1. Rezultatul literal al ancorelor din Etapa 0, inclusiv **numărul migrației** ales și de ce.
2. Diff-ul pe fiecare fișier — vreau să văd că nu s-a atins nimic în afara celor 5 blocuri.
3. Confirmarea că funcția din migrație conține `RAISE EXCEPTION` și tokenul `alop_instances`.
4. Lista testelor și ce dovedește fiecare; explicit rezultatul cazurilor ⭐.
5. `npm test` / `npm run test:db` — fișiere/teste, PASSED nu SKIPPED. Orice test existent
   atins, cu justificare.
6. Hash-ul commitului + confirmarea push-ului pe `develop`.

## ⛔ CONSTRÂNGERI ABSOLUTE

- Zero fișiere din `public/`. Zero atingeri în zona NO-TOUCH.
- Nu atinge expresiile de „DF aprobat" din `formulare/shared.mjs` sau `formulare/df.mjs` —
  sunt #165, cu teste proprii de paritate filtru↔badge.
- Nu migra handlerul `cancel` pe `undoCompletedFlowLinks`. Duplicarea e conștientă
  (vezi docblock-ul din `flow-undo.mjs`); unificarea e alt lot, cu teste proprii.
- Nu adăuga coduri de eroare noi și nu schimba forma răspunsurilor existente.
- Migrația NU atinge date. Dacă ajungi să scrii `UPDATE`/`DELETE` în ea, te-ai abătut.
- ⚠️ Pe STAGING, înainte de merge, Mircea testează: anulare administrativă pe un flux DF
  finalizat ⇒ dosarul revine în `angajare` și fluxul poate fi relansat; plus o anulare
  obișnuită pe un flux ORD ⇒ pointerul celuilalt flux al aceluiași document rămâne intact.
- Orice verificare cu rezultat neașteptat ⇒ oprire și raport.
