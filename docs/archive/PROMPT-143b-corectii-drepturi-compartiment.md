---
lot: "#143b — completarea lotului #143: lista DF/ORD, dedup-ul DF și invariantul de separare a atribuțiilor"
versiune_start: v3.9.800
versiune_tinta: v3.9.801
model_suggested: Sonnet 5 (efort medium)
migratii: 0
scriere_de_date: NU
fisiere_din_public: 0 (⇒ FĂRĂ CACHE_VERSION, FĂRĂ `?v=`)
---

# ⚠️ BRANCH: develop

`main` = PRODUCȚIE, gestionat MANUAL de Mircea. Fără `checkout`, `merge`, `push`
pe `main`. Nu se face merge pentru #143 până nu intră și lotul ăsta.

---

## CONTEXT

Lotul **#143** (v3.9.800, commit `4d78ac5`) a mutat „proprietarul unui dosar" de
la PERSOANĂ la COMPARTIMENT. Diagnosticul lui a fost corect și verificat:
`canEditAlop` accepta de mult rolul `comp` pe toate mutațiile, dar derivarea de
capabilities lucra pe `created_by` ⇒ colegul trecea de server și nu primea niciun
buton.

Au rămas **trei locuri** în care aceeași ruptură persistă. Toate au fost
verificate pe arhiva v3.9.800; niciuna nu e o gaură de securitate — sunt drepturi
pe care serverul le acordă deja și pe care interfața nu le arată, plus un
invariant nepinnat.

### C1 — lista DF/ORD n-a fost aliniată (lista ALOP a fost)

`server/routes/formulare/shared.mjs`, `GET /api/formulare/list`:

| Loc | Expresie de azi |
|---|---|
| `:647` (DF) | `${isOrgManager ? 'TRUE' : \`fd.created_by = $N\`} AND fd.flow_id IS NULL AND NOT EXISTS(...)` |
| `:811` (ORD) | `${isOrgManager ? 'TRUE' : \`fo.created_by = $N\`} AND fo.flow_id IS NULL` |

`public/js/formular/list.js:872` consumă `row.can_delete`. Iar ștergerea trece
prin `canDestroyOnly`, care de la #143 **acceptă colegul de compartiment**. Deci
azi: colegul vede rândul, serverul i-ar accepta ștergerea, butonul nu apare.

Exact tiparul reparat la lista ALOP în #143 (`alop.mjs:497-513`): SQL-ul întoarce
doar partea de STATUS, iar partea de PROPRIETATE se aplică în JS imediat după
query. Îl reproducem, nu inventăm altul.

⚠️ Cele două coloane de care avem nevoie sunt **deja proiectate** în ambele
interogări de listă:
- `isP1` = `(fd.created_by = $N)` — creatorul nominal;
- `initiator_comp` = `u1.compartiment` — compartimentul CURENT al creatorului.

DF și ORD **nu au** coloană proprie `compartiment` (verificat: doar
`p2_compartiment`, migrarea 108), deci a doua sursă din `isCreatorCompColleague`
— compartimentul creatorului — e singura aplicabilă aici, iar comparația e
identică (TRIM pe ambele părți, șirul gol nu se potrivește cu nimic).

### C2 — dedup-ul de la `POST /api/formulare-df` întoarce documentul altcuiva

`server/routes/formulare/df.mjs:297` (`dup[0]`) și `:333` (`won[0]`, ramura de
cursă `23505`) fac `computeDocCapabilities(doc, actor, 'notafd')` — fără
`actorComp`, fără `authzRole`.

Cheia de dedup la DF e `source_alop_id` **fără** `created_by`. Deci documentul
întors poate aparține unui COLEG: doi oameni din același serviciu apasă
„Completează DF" pe același dosar, al doilea primește DF-ul primului cu
capabilities de simplu vizitator ⇒ formular fără butoane.

⛔ **ORD-ul NU e afectat** — dedup-ul lui (`ord.mjs:296-304`) are
`AND created_by = $3` în cheie, deci întoarce întotdeauna documentul propriu al
actorului. Nu-l atinge.

⛔ `rows[0]` (documentul proaspăt INSERT-at, `df.mjs:342` / `ord.mjs:345`) rămâne
**neatins**: creatorul e chiar actorul, deci `deriveDocRole` întoarce deja `p1`.
Un apel de authz acolo ar fi două query-uri în plus pe calea caldă, degeaba.

### C3 — separarea atribuțiilor nu e pinnată de niciun test

#143 a lăsat corect `POST /api/alop/:id/confirma-plata` rezervat compartimentului
CAB. Dar într-un lot care tocmai a lărgit „proprietarul" de la persoană la
echipă, ăsta e fix invariantul care se pierde tăcut la următoarea refactorizare.
Îi punem un test.

### Ce NU face acest lot

- ⛔ **Nu atinge `isP1`** din listele DF/ORD. E `created_by`-only și rămâne așa:
  `grep -rn "isP1" public/` întoarce **0** (coloana nu e consumată în frontend),
  deci lărgirea ei ar schimba tăcut semantica unei coloane fără niciun beneficiu.
- ⛔ **Nu schimbă comparația de compartimente.** E `TRIM` + case-sensitive, fără
  normalizare de diacritice, pe toate straturile (vizibilitate, authz,
  capabilities). O schimbare acolo e authz și se face pe date, nu pe intuiție —
  Etapa E livrează interogările care spun dacă problema există.
- ⛔ Nu atinge `canEditAlop`, `canEditFormular`, `canDestroyOnly`,
  `isCreatorCompColleague`. Definiția e bună și rămâne unde e.
- ⛔ Nu atinge zona NO-TOUCH (`cloud-signing.mjs`, `bulk-signing.mjs`,
  `STSCloudProvider.mjs`, `pades.mjs`, `java-pades-client.mjs`).

---

## PASUL 0 — ancore

```bash
git branch --show-current                      # develop
grep '"version"' package.json                  # 3.9.800
grep -n "CACHE_VERSION = " public/sw.js        # docflowai-v302 (rămâne neschimbat)

grep -c "isCreatorCompColleague" server/services/authz-formular.mjs   # 3
grep -c "const { rows } = await pool.query(sql, params);" server/routes/formulare/shared.mjs   # 2
grep -n "AS can_delete," server/routes/formulare/shared.mjs           # 2 linii (~653, ~813)
grep -n "AS \"isP1\"" server/routes/formulare/shared.mjs              # 2 linii
grep -n "initiator_comp" server/routes/formulare/shared.mjs           # 2 linii
grep -rn "isP1" public/ | wc -l                                       # 0
```

Dacă vreo ancoră diferă: **OPREȘTE-TE și raportează.**

---

## ETAPA A — helper PUR, o singură definiție

Fișier: `server/services/formular-capabilities.mjs`. Se **adaugă** la finalul
fișierului (nu se modifică nimic existent):

```js
/**
 * #143b — restrânge `can_delete` din listele DF/ORD la mulțimea care poate CHIAR șterge.
 *
 * Interogarea de listă întoarce doar partea de STATUS (fără flux legat / fără ORD copil);
 * partea de PROPRIETATE se aplică aici, ca să oglindească EXACT `canDestroyOnly`:
 * creator + admin/org_admin + coleg de compartiment al creatorului (#143).
 * Fără ea, colegul vedea rândul fără buton de ștergere, deși serverul îi accepta cererea.
 *
 * Coloanele consumate sunt deja proiectate de ambele interogări de listă:
 *   isP1           = (created_by = actorul)   → creatorul nominal
 *   initiator_comp = u1.compartiment          → compartimentul CURENT al creatorului
 * DF/ORD nu au coloană proprie de compartiment, deci a doua sursă din
 * `isCreatorCompColleague` (compartimentul creatorului) e singura aplicabilă, iar
 * comparația e identică: TRIM pe ambele părți, șirul gol nu se potrivește cu nimic.
 *
 * Modifică tabloul în-place și îl întoarce (pentru înlănțuire).
 */
export function narrowCanDeleteRows(rows, opts = {}) {
  const isOrgManager = opts.isOrgManager === true;
  const ac = String(opts.actorComp || '').trim();
  for (const r of rows) {
    r.can_delete = r.can_delete === true && (
         isOrgManager
      || r.isP1 === true
      || (!!ac && String(r.initiator_comp || '').trim() === ac)
    );
  }
  return rows;
}
```

---

## ETAPA B — cablarea în `GET /api/formulare/list`

Fișier: `server/routes/formulare/shared.mjs`.

**B1 — import.**

**old_str**
```js
import { dosarKeyExpr } from '../../services/df-dosar-key.mjs';
```
**new_str**
```js
import { dosarKeyExpr } from '../../services/df-dosar-key.mjs';
import { narrowCanDeleteRows } from '../../services/formular-capabilities.mjs';
```

**B2 — variabila de handler.** Verifică întâi că perechea e unică:
`grep -c "const isOrgManager = isAdminOrOrgAdmin(actor);" server/routes/formulare/shared.mjs` ⇒ **1**.

**old_str**
```js
  const isPlatform   = isPlatformAdmin(actor);
  const isOrgManager = isAdminOrOrgAdmin(actor);
```
**new_str**
```js
  const isPlatform   = isPlatformAdmin(actor);
  const isOrgManager = isAdminOrOrgAdmin(actor);
  // #143b — compartimentul actorului, ridicat la nivel de handler: îl încarcă oricum
  // ramura de vizibilitate de mai jos, iar `narrowCanDeleteRows` are nevoie de el după
  // query. Rămâne '' pentru admin/org_admin (care oricum trec pe `isOrgManager`).
  let lstActorComp = '';
```

**B3 — captarea lui, în ramura DF.**

**old_str**
```js
          const { actorComp, cabComp } = await loadActorCompAndCab(pool, actor.userId, actor.orgId);
          if (!isCabDept(actorComp, cabComp)) {
            const u1 = params.push(actor.userId);
            const u2 = params.push(actor.userId);
            if (actorComp === '') {
              conds.push(`(fd.created_by=$${u1} OR fd.assigned_to=$${u2})`);
```
**new_str**
```js
          const { actorComp, cabComp } = await loadActorCompAndCab(pool, actor.userId, actor.orgId);
          lstActorComp = actorComp;   // #143b — înainte de orice return timpuriu pe ramura CAB
          if (!isCabDept(actorComp, cabComp)) {
            const u1 = params.push(actor.userId);
            const u2 = params.push(actor.userId);
            if (actorComp === '') {
              conds.push(`(fd.created_by=$${u1} OR fd.assigned_to=$${u2})`);
```

**B4 — idem, în ramura ORD** (același patch cu `fo.` în loc de `fd.`):

**old_str**
```js
          const { actorComp, cabComp } = await loadActorCompAndCab(pool, actor.userId, actor.orgId);
          if (!isCabDept(actorComp, cabComp)) {
            const u1 = params.push(actor.userId);
            const u2 = params.push(actor.userId);
            if (actorComp === '') {
              conds.push(`(fo.created_by=$${u1} OR fo.assigned_to=$${u2})`);
```
**new_str**
```js
          const { actorComp, cabComp } = await loadActorCompAndCab(pool, actor.userId, actor.orgId);
          lstActorComp = actorComp;   // #143b — vezi comentariul din ramura DF
          if (!isCabDept(actorComp, cabComp)) {
            const u1 = params.push(actor.userId);
            const u2 = params.push(actor.userId);
            if (actorComp === '') {
              conds.push(`(fo.created_by=$${u1} OR fo.assigned_to=$${u2})`);
```

**B5 — `can_delete` devine status-only, DF.**

⚠️ Patch-ul ELIMINĂ un `params.push(actor.userId)`. E sigur **doar** fiindcă
fiecare referință folosește indexul întors de propriul push (`$${params.push(...)}`,
`limIdx`, `offIdx`). **Verifică înainte de a aplica** că nu există niciun `$1`…`$9`
scris de mână în cele două interogări de listă; dacă există, OPREȘTE-TE.

**old_str**
```js
          (
            ${isOrgManager ? 'TRUE' : `fd.created_by = $${params.push(actor.userId)}`}
            AND fd.flow_id IS NULL
            AND NOT EXISTS (
              SELECT 1 FROM formulare_ord fo_chk
              WHERE fo_chk.df_id = fd.id AND fo_chk.deleted_at IS NULL
            )
          ) AS can_delete,
```
**new_str**
```js
          -- #143b — DOAR partea de stare. Proprietatea (creator / coleg de compartiment /
          -- admin) se aplica in JS imediat dupa query, prin helperul din
          -- services/formular-capabilities.mjs: expresia ar avea nevoie de un parametru nou
          -- pentru compartiment, iar ordinea din `params` e legata de push-urile de mai sus.
          -- Acelasi tipar ca la lista ALOP (#143, alop.mjs).
          (
            fd.flow_id IS NULL
            AND NOT EXISTS (
              SELECT 1 FROM formulare_ord fo_chk
              WHERE fo_chk.df_id = fd.id AND fo_chk.deleted_at IS NULL
            )
          ) AS can_delete,
```

**B6 — `can_delete` devine status-only, ORD.**

**old_str**
```js
          (
            ${isOrgManager ? 'TRUE' : `fo.created_by = $${params.push(actor.userId)}`}
            AND fo.flow_id IS NULL
          ) AS can_delete,
```
**new_str**
```js
          -- #143b — vezi comentariul din ramura DF: aici ramane doar starea.
          (fo.flow_id IS NULL) AS can_delete,
```

**B7 — aplicarea proprietății, DF.** (`old_str` include `ORDER BY fd.` fiindcă
liniile de sub el sunt identice în ambele ramuri.)

**old_str**
```js
        ORDER BY fd.updated_at DESC
        LIMIT $${limIdx} OFFSET $${offIdx}`;

      const { rows } = await pool.query(sql, params);
      const total = rows.length ? parseInt(rows[0].total) : 0;
```
**new_str**
```js
        ORDER BY fd.updated_at DESC
        LIMIT $${limIdx} OFFSET $${offIdx}`;

      const { rows } = await pool.query(sql, params);
      narrowCanDeleteRows(rows, { isOrgManager, actorComp: lstActorComp });
      const total = rows.length ? parseInt(rows[0].total) : 0;
```

**B8 — idem, ORD.** Singura diferență față de B7 e `fo.` în linia `ORDER BY`
(liniile de sub ea sunt identice în ambele ramuri, de aceea `ORDER BY` intră în
`old_str`). Linia de query rămâne neschimbată; se adaugă DOAR apelul.

**old_str**
```js
        ORDER BY fo.updated_at DESC
        LIMIT $${limIdx} OFFSET $${offIdx}`;

      const { rows } = await pool.query(sql, params);
      const total = rows.length ? parseInt(rows[0].total) : 0;
```
**new_str**
```js
        ORDER BY fo.updated_at DESC
        LIMIT $${limIdx} OFFSET $${offIdx}`;

      const { rows } = await pool.query(sql, params);
      narrowCanDeleteRows(rows, { isOrgManager, actorComp: lstActorComp });
      const total = rows.length ? parseInt(rows[0].total) : 0;
```

---

## ETAPA C — capabilities pe ramura de dedup a DF-ului

Fișier: `server/routes/formulare/df.mjs`. `loadActorCompAndCab` și
`canViewFormular` sunt **deja importate** (`:18`) — nu adăuga importuri.

**C1 — ramura `dup`.**

**old_str**
```js
      if (dup.length) {
        dup[0].capabilities = computeDocCapabilities(dup[0], actor, 'notafd');
        return res.json({ ok: true, document: dup[0] });
      }
```
**new_str**
```js
      if (dup.length) {
        // #143b — cheia de dedup e `source_alop_id` FĂRĂ `created_by` (spre deosebire de ORD),
        // deci documentul întors poate aparține unui COLEG de compartiment: cazul tipic e doi
        // oameni din același serviciu care apasă „Completează DF" pe același dosar. Fără rolul
        // de authz, al doilea primea documentul cu drepturi de simplu vizitator ⇒ formular fără
        // butoane. Se folosește EXACT lanțul din GET /api/formulare-df/:id, ca să nu apară o a
        // doua definiție a rolului.
        // ⛔ Rezultatul NU devine o poartă: dacă `canViewFormular` refuză, documentul se întoarce
        // ca și până acum (comportament neschimbat), doar capabilities rămân goale.
        const { actorComp, cabComp } = await loadActorCompAndCab(pool, actor.userId, actor.orgId);
        const view = await canViewFormular(pool, actor, dup[0], actorComp, { cabComp });
        dup[0].capabilities = computeDocCapabilities(dup[0], actor, 'notafd', actorComp,
          { authzRole: view.allowed ? (view.role || '') : '' });
        return res.json({ ok: true, document: dup[0] });
      }
```

**C2 — ramura `won` (cursa `23505`).**

**old_str**
```js
        if (won.length) {
          won[0].capabilities = computeDocCapabilities(won[0], actor, 'notafd');
          return res.json({ ok: true, document: won[0] });
        }
```
**new_str**
```js
        if (won.length) {
          // #143b — identic cu ramura `dup` de mai sus: câștigătorul cursei poate fi documentul
          // unui coleg de compartiment.
          const { actorComp: aC2, cabComp: cC2 } = await loadActorCompAndCab(pool, actor.userId, actor.orgId);
          const view2 = await canViewFormular(pool, actor, won[0], aC2, { cabComp: cC2 });
          won[0].capabilities = computeDocCapabilities(won[0], actor, 'notafd', aC2,
            { authzRole: view2.allowed ? (view2.role || '') : '' });
          return res.json({ ok: true, document: won[0] });
        }
```

---

## ETAPA D — teste

### D1 — unitar, fișier NOU `server/tests/unit/can-delete-lista.test.mjs`

Pur, fără DB, fără rețea. Pe `narrowCanDeleteRows`:

1. **⭐ colegul primește dreptul**: rând cu `can_delete:true`, `isP1:false`,
   `initiator_comp:'Serviciul Buget'`, `actorComp:'Serviciul Buget'` ⇒ `true`.
2. **⭐⭐ străinul NU**: același rând, `actorComp:'Serviciul Tehnic'` ⇒ `false`.
   Ăsta e testul care apără GRANIȚA — dacă pică, lotul a lărgit prea mult.
3. **starea are prioritate**: `can_delete:false` (document pe flux) + coleg ⇒
   rămâne `false`. Proprietatea nu poate resuscita un rând blocat de stare.
4. creatorul: `isP1:true`, `actorComp:''` ⇒ `true`.
5. `isOrgManager:true` ⇒ `true` chiar cu `isP1:false` și compartiment diferit.
6. `actorComp:''` (utilizator fără compartiment) ⇒ **nu** moștenește nimic:
   `isP1:false` ⇒ `false`. Fail-safe.
7. `initiator_comp:null` sau `undefined` ⇒ `false` (fără excepție aruncată).
8. spații: `initiator_comp:'  Serviciul Buget  '` vs `actorComp:'Serviciul Buget'`
   ⇒ `true` (TRIM pe ambele părți).

### D2 — structural, în ACELAȘI fișier

9. **⭐ `canDestroyOnly` e `await`-uit peste tot.** Citește cu `readFileSync`
   `server/routes/alop.mjs`, `server/routes/formulare/df.mjs`,
   `server/routes/formulare/ord.mjs`, `server/services/formular-shared.mjs`,
   extrage toate aparițiile numelui urmat de paranteză deschisă și asertează că
   **fiecare** e precedată de `await`, plus că numărul total e ≥ 4.
   Motivul, scris în test: funcția a devenit `async` la #143; un apel neașteptat
   întoarce o promisiune, `.allowed` iese `undefined`, iar ștergerea se închide
   tăcut **pentru toată lumea**, inclusiv pentru creator și admin.
   ⚠️ Nu include `authz-formular.mjs` în scanare (acolo e definiția).

### D3 — DB, fișier NOU `server/tests/db/df-lista-drepturi-compartiment.test.mjs`

Oglindește fixture-urile din `server/tests/db/alop-drepturi-compartiment.test.mjs`
(creator, coleg de compartiment, străin din alt compartiment). `afterAll` cu
`pool.end()` **doar în ultimul `describe`** din fișier.

1. **⭐ lista DF**: DF creat de creator, fără flux, fără ORD copil ⇒
   `GET /api/formulare/list?type=df` întors colegului conține rândul cu
   `can_delete === true`; străinului — sau nu vede rândul, sau îl vede cu
   `can_delete === false` (asertează explicit care dintre ele, în funcție de
   filtrul de vizibilitate).
2. **⭐ starea**: același DF cu `flow_id` setat ⇒ `can_delete === false` și pentru
   creator, și pentru coleg.
3. lista ORD: aceeași pereche coleg/străin.
4. **⭐⭐ dedup DF**: creatorul creează DF-ul pe un `source_alop_id`; colegul face
   `POST /api/formulare-df` cu ACELAȘI `source_alop_id` ⇒ primește 200 cu
   documentul existent ȘI `document.capabilities.can_save === true` (fără fix e
   `false`). Verifică și că **nu s-a creat** un al doilea DF.
5. **⭐⭐ SEPARAREA ATRIBUȚIILOR — invariantul lotului #143.** Un coleg de
   compartiment al creatorului, care **nu** e în compartimentul CAB al
   organizației, apelează `POST /api/alop/:id/confirma-plata` ⇒ **403**, și nimic
   scris în baza de date. Comentariu în test: dreptul de proprietar-echipă (#143)
   NU include confirmarea plății; dacă testul ăsta pică, s-a pierdut separarea
   dintre cel care ordonanțează și cel care confirmă plata.

```bash
npm test        # verde, fără regresii
npm run test:db # PASSED REAL — „skipped" NU e „passed"
```

⚠️ Dacă suita DB dă eșecuri în masă în fișiere neatinse de lot (coliziuni pe
`organizations_name_key`, deadlock-uri), **nu repara testele**: e semnul unei
instanțe efemere murdare. Oprește instanța, șterge `PGDATA`, repornește curat și
rulează o singură dată. Raportează dacă se repetă.

---

## ETAPA E — diagnostic read-only pentru producție (NU se rulează de agent)

Fișier NOU: `docs/audits/DIAGNOSTIC-143-compartimente.sql`. Doar `SELECT`-uri,
scrise pentru consola Railway (o interogare per execuție; consola adaugă automat
propriul `LIMIT`, deci fiecare bloc se termină într-un `SELECT`). Fără extensii
(`unaccent` poate lipsi) — normalizarea diacriticelor se face cu `translate`.

**Q1 — cât de mult atârnă totul de compartimentul creatorului.** Câte dosare ALOP
au `compartiment` gol/NULL, ca procent din total (dacă majoritatea sunt goale,
mutarea unui om la alt serviciu rescrie tăcut proprietarii colectivi ai dosarelor
lui vechi).

**Q2 — variante de scriere ale aceluiași compartiment.** Grupare pe cheie
normalizată (`lower` + spații colapsate + `translate` pe `ăâîșțĂÂÎȘȚşţŞŢ`), peste
`users.compartiment` (doar `deleted_at IS NULL`, doar valori nevide), cu
`HAVING COUNT(*) > 1`, întorcând variantele și numărul de utilizatori din fiecare.
Orice rând returnat = oameni care se cred în același compartiment dar nu sunt,
pentru toate cele trei straturi de comparație.

**Q3 — divergență pointer**: dosare ALOP unde `compartiment` declarat pe rând
diferă (după aceeași normalizare) de compartimentul curent al creatorului.

Fiecare bloc precedat de un comentariu care spune **ce înseamnă un rezultat
nevid**. ⛔ Nicio instrucțiune de scriere în fișier.

---

## PASUL FINAL

```bash
# package.json: 3.9.800 → 3.9.801

git status --short   # ⚠️ working tree-ul are ~50 fișiere netrackuite din sesiuni vechi;
                     # stage-uiește DOAR căile de mai jos, niciodată `git add -A`

git add server/services/formular-capabilities.mjs \
        server/routes/formulare/shared.mjs \
        server/routes/formulare/df.mjs \
        server/tests/unit/can-delete-lista.test.mjs \
        server/tests/db/df-lista-drepturi-compartiment.test.mjs \
        docs/audits/DIAGNOSTIC-143-compartimente.sql \
        package.json

git diff --cached --stat
git commit -m "fix(#143b): can_delete pe compartiment in listele DF/ORD + capabilities pe dedup-ul DF + invariant separare atributii (v3.9.801)"
git push origin develop
```

Verificări finale (asertate pe forma REZULTATĂ, nu pe intenție):

```bash
grep -c "narrowCanDeleteRows" server/routes/formulare/shared.mjs
# Așteptat: 3 (import + 2 apeluri)

grep -c "isOrgManager ? 'TRUE'" server/routes/formulare/shared.mjs
# Așteptat: 0 (ternarul a dispărut din ambele expresii can_delete)

grep -c 'AS "isP1"' server/routes/formulare/shared.mjs
# Așteptat: 2 (coloana isP1 rămâne exact cum era, în ambele liste)

git status --short -- server/routes/formulare/ord.mjs server/services/authz-formular.mjs \
                      server/services/alop-capabilities.mjs server/routes/alop.mjs
# Așteptat: GOL (cele patru fișiere sunt NEATINSE)

git diff --stat -- public/
# Așteptat: GOL (zero fișiere din public/ ⇒ fără CACHE_VERSION, fără ?v=)
```

---

## RAPORT FINAL

1. Branch la start și final.
2. Ancorele din PASUL 0 — exacte? Ce cifre au ieșit.
3. **Confirmarea că eliminarea celor două `params.push(actor.userId)` din
   expresiile `can_delete` nu a decalat niciun parametru** — cum ai verificat
   (arată că nu există `$N` scris de mână în cele două interogări).
4. Rezultatul cazurilor ⭐⭐ D1.2 (străinul), D3.4 (dedup) și D3.5 (separarea
   atribuțiilor), fiecare cu ce ar fi ieșit FĂRĂ fix.
5. Pentru D3.1: străinul nu vede deloc rândul, sau îl vede cu `can_delete=false`?
   (răspunsul contează — spune dacă vizibilitatea și ștergerea sunt aliniate).
6. `npm test` / `npm run test:db` — fișiere/teste, PASSED REAL.
7. Confirmarea că `ord.mjs`, `authz-formular.mjs`, `alop-capabilities.mjs` și
   `alop.mjs` sunt NEATINSE.
8. Commit hash, versiune, push confirmat pe `develop`.
9. Orice ai găsit pe drum și NU ai reparat.

---

## ⛔ CONSTRÂNGERI ABSOLUTE

- Doar `develop`. Zero migrații, zero scrieri de date, zero fișiere din `public/`
  ⇒ `CACHE_VERSION` rămâne `docflowai-v302`, niciun `?v=` nu se atinge.
- Nu modifica `isP1` în listele DF/ORD.
- Nu modifica `canDestroyOnly`, `canEditAlop`, `canEditFormular`,
  `isCreatorCompColleague` — definiția de la #143 e bună.
- Nu atinge dedup-ul ORD (`ord.mjs`): cheia lui conține deja `created_by`.
- Nu transforma `canViewFormular` din Etapa C într-o poartă: documentul se
  întoarce ca și până acum, indiferent de rezultat.
- `narrowCanDeleteRows` rămâne PURĂ: fără `pool`, fără `await`, fără import de DB.
- Zona NO-TOUCH neatinsă.
- Dacă un `old_str` nu se potrivește exact: OPREȘTE-TE și raportează.
