---
prompt: 178
titlu: "Vizibilitatea ALOP pe sursă unică — detaliul cheamă helperul, nu-și mai ține copia"
model_suggested: "Opus 5, efort high"
branch: develop
versiune_curenta: v3.9.832
versiune_tinta: v3.9.833
migratii: NU
fisiere_din_public: NU   (⇒ FĂRĂ bump `?v=`, FĂRĂ `CACHE_VERSION`)
zona_no_touch_atinsa: NU
---

# ⚠️ BRANCH

Lucrezi **EXCLUSIV pe `develop`**. `main` = PRODUCȚIE, gestionat manual de Mircea.
Pasul final obligatoriu: `git push origin develop`.

---

## Context — bug REPRODUS în producție (04.09.2026, v3.9.831)

Un utilizator din compartimentul **CAB** (`organizations.cab_compartiment`, la Primăria Zărnești
„Serviciul Buget") vede toate cele 153 de dosare în listă, dar la deschidere primește
**„Eroare: not_found"** pe o parte dintre ele — aparent aleatoriu. De pe contul de `admin` merge
tot. Nu e cache, nu e rețea: cele `304` din loguri sunt răspunsuri condiționale normale.

### Cauza — aceeași regulă scrisă în DOUĂ locuri, divergente printr-o singură linie

Vizibilitatea unui dosar pentru un utilizator non-admin trăiește în:

| loc | folosit de |
|---|---|
| `buildAlopVisibilityWhere` (`server/routes/alop.mjs:346`) | lista `GET /api/alop` (`:446`), `GET /api/alop/stats` (`:410`), CTE-ul `visible_alop` (`:655`) |
| **copie INLINE** (`server/routes/alop.mjs:741-799`) | detaliul `GET /api/alop/:id` |

Predicatele sunt identice caracter cu caracter, inclusiv comentariile — cu o excepție. Helperul
are, la `:353`:

```js
if (isCabDept(actorComp, cabComp)) return '';
```

**Copia inline NU o are.** Deci membrul CAB trece de listă (unde regula i se aplică), dar cade la
detaliu (unde nu). Copia a fost făcută înainte ca linia CAB să fie adăugată în helper, iar de
atunci au divergat tăcut.

## Decizia (Mircea, 04.09.2026)

> **Serviciul Buget (compartimentul CAB) vede ȘI deschide tot ALOP-ul instituției.**
> Lista are dreptate; detaliul se aliniază la ea. Copia inline dispare — ruta de detaliu
> cheamă același helper.

---

## Fapte VERIFICATE pe codul v3.9.832

- `buildAlopVisibilityWhere(actor, params, out)` calculează indicii `$n` din `params.length`
  **după** `push` ⇒ se adaptează singur la orice listă de parametri. În listă `params` începe cu
  `[orgId]` ⇒ userId devine `$2`; în detaliu `detailParams` începe cu `[id, orgId]` ⇒ userId
  devine `$3`. **Nu e nimic de ajustat manual** — asta era singurul risc real al lotului.
- Parametrul `out` se completează la `:352`, **ÎNAINTE** de ieșirea devreme pe CAB (`:353`)
  ⇒ `actorComp`/`cabComp` sunt disponibile și pentru membrii CAB.
- Pentru `admin`/`org_admin` helperul iese la `:347` **fără** să apeleze `loadActorCompAndCab`
  ⇒ `out` rămâne gol, iar `actorComp`/`cabComp` rămân `''`. Identic cu comportamentul de azi al
  rutei de detaliu, care sare deliberat acel apel pentru admin („păstrează numărul de query-uri
  identic cu înainte pe calea admin — contract al mock-urilor de test existente").
- Numărul de runde la bază rămâne **NESCHIMBAT** pe ambele căi: azi detaliul apelează
  `loadActorCompAndCab` o dată pentru non-admin; după schimbare îl apelează helperul, tot o dată.
- `actorComp` și `cabComp` sunt consumate mai jos de `computeAlopCapabilities` ⇒ trebuie
  extrase din `out`, nu lăsate nedefinite.

---

## ⛔ Ce NU se atinge

- **NU** modifica `buildAlopVisibilityWhere`. Helperul e sursa corectă — nu se ajustează ca să
  semene cu copia.
- **NU** atinge celelalte trei apeluri ale helperului (`:410`, `:446`, `:655`).
- **NU** schimba interogarea de detaliu în afara clauzei `extraWhere` (`SELECT`, `JOIN`-uri,
  `WHERE a.id = $1 AND a.org_id = $2 AND a.cancelled_at IS NULL`).
- **NU** atinge blocurile de self-heal de mai jos din rută (DF/ORD, `alop.mjs:893+`) și nici
  `computeAlopCapabilities`.
- **NU** atinge `isCabDept`, `loadActorCompAndCab`, `authz-formular.mjs`.
- Zero migrații, zero fișiere din `public/`.

---

## ETAPA 0 — ancore (READ-ONLY)

```bash
cd "$(git rev-parse --show-toplevel)"
git branch --show-current                                   # Așteptat: develop
node -e "console.log(require('./package.json').version)"     # Așteptat: 3.9.832

grep -c "buildAlopVisibilityWhere" server/routes/alop.mjs
# Așteptat: 5 (definiția + 3 apeluri + 1 mențiune în comentariul de la :647)

grep -c "isCabDept" server/routes/alop.mjs                  # Așteptat: 1 (doar în helper)
grep -c "let extraWhere = '';" server/routes/alop.mjs       # Așteptat: 1
grep -c "compClause" server/routes/alop.mjs                 # Așteptat: 6 (3 în helper, 3 în copie)
```

⚠️ Ultimele două contoare sunt derivate din citirea fișierului la scrierea promptului. Dacă nu se
potrivesc, **OPREȘTE-TE și raportează valorile reale** — nu ajusta patch-ul ca să treacă.

---

## ETAPA A — copia inline dispare

`old_str` (începutul blocului — de la declarația lui `extraWhere` până la deschiderea ramurii):
```js
    const detailParams = [req.params.id, actor.orgId];
    let extraWhere = '';
    // #130: aceeași rundă DB (loadActorComp existentă) extinsă cu cab_compartiment-ul org-ului —
    // folosită mai jos atât pentru filtrul de vizibilitate CÂT ȘI pentru computeAlopCapabilities,
    // ca interfața și garda #126 B1 să folosească EXACT aceleași valori. Sărită pentru admin/
    // org_admin (is_owner e deja true pentru ei, is_cab n-are efect) — păstrează numărul de
    // query-uri identic cu înainte pe calea admin (contract mock-urilor de test existente).
    let actorComp = '', cabComp = '';
    if (actor.role !== 'admin' && actor.role !== 'org_admin') {
      ({ actorComp, cabComp } = await loadActorCompAndCab(pool, actor.userId, actor.orgId));
      detailParams.push(actor.userId);
      const userIdx = detailParams.length;
      let compClause = '';
      if (actorComp !== '') {
        detailParams.push(actorComp);
        const compIdx = detailParams.length;
        compClause = `
          OR (TRIM(a.compartiment) = $${compIdx} AND TRIM(a.compartiment) <> '')
          OR EXISTS (
            SELECT 1 FROM users uc
            WHERE uc.id = a.created_by
              AND TRIM(uc.compartiment) = $${compIdx}
              AND TRIM(uc.compartiment) <> ''
          )
          OR EXISTS (
            SELECT 1 FROM users u_p2
            WHERE TRIM(u_p2.compartiment) = $${compIdx}
              AND TRIM(u_p2.compartiment) <> ''
              AND (
                u_p2.id IN (
                  SELECT fd.assigned_to FROM formulare_df fd WHERE fd.id = a.df_id AND fd.assigned_to IS NOT NULL
                  UNION ALL
                  SELECT fo.assigned_to FROM formulare_ord fo WHERE fo.id = a.ord_id AND fo.assigned_to IS NOT NULL
                )
                OR u_p2.id::text IN (
                  SELECT s->>'user_id' FROM jsonb_array_elements(COALESCE(a.df_semnatari,'[]'::jsonb)) s
                    WHERE s->>'role' = 'responsabil_cab' AND s->>'user_id' IS NOT NULL
                  UNION ALL
                  SELECT s->>'user_id' FROM jsonb_array_elements(COALESCE(a.ord_semnatari,'[]'::jsonb)) s
                    WHERE s->>'role' = 'responsabil_cab' AND s->>'user_id' IS NOT NULL
                )
              )
          )`;
      }
      extraWhere = ` AND (
        a.created_by = $${userIdx}
        OR EXISTS (
          SELECT 1 FROM flows fl1
          WHERE fl1.id = a.df_flow_id
            AND fl1.data->'signers' @> jsonb_build_array(jsonb_build_object('userId', $${userIdx}::text))
        )
        OR EXISTS (
          SELECT 1 FROM flows fl2
          WHERE fl2.id = a.ord_flow_id
            AND fl2.data->'signers' @> jsonb_build_array(jsonb_build_object('userId', $${userIdx}::text))
        )${compClause}
      )`;
    }
```

`new_str`
```js
    const detailParams = [req.params.id, actor.orgId];
    // #178 — SURSA UNICĂ. Aici trăia o COPIE inline a lui `buildAlopVisibilityWhere`,
    // identică caracter cu caracter — mai puțin ieșirea devreme pe CAB, adăugată ulterior
    // DOAR în helper. Consecința, reprodusă în producție: un utilizator din compartimentul
    // CAB vedea toate dosarele în listă (unde regula i se aplica) și primea 404 `not_found`
    // la deschidere (unde nu). De aici înainte lista și detaliul răspund din același loc.
    //
    // Indicii `$n` se calculează în helper din `params.length` DUPĂ push ⇒ se adaptează
    // singuri: în listă userId iese `$2`, aici `$3`. Nimic de ajustat manual.
    // `out` se completează ÎNAINTE de ieșirea pe CAB, deci `actorComp`/`cabComp` rămân
    // disponibile pentru `computeAlopCapabilities` de mai jos, ca înainte. Pentru admin/
    // org_admin helperul iese fără să atingă baza ⇒ ambele rămân '' și numărul de query-uri
    // pe calea admin nu se schimbă (contract al mock-urilor de test existente).
    const _vis = {};
    const extraWhere = await buildAlopVisibilityWhere(actor, detailParams, _vis);
    const actorComp = _vis.actorComp || '';
    const cabComp   = _vis.cabComp   || '';
```

⚠️ După înlocuire, `loadActorCompAndCab` s-ar putea să rămână importat fără a mai fi folosit în
`alop.mjs`. **Verifică** cu `grep -c "loadActorCompAndCab" server/routes/alop.mjs`: dacă rămâne
doar linia de import, scoate-o din import — dar **numai** dacă niciun alt loc din fișier nu o
folosește. Dacă mai are consumatori, lasă importul neatins și spune asta în raport.

---

## ETAPA B — teste

Fișier NOU: `server/tests/db/alop-vizibilitate-paritate.test.mjs`, pe modelul testelor DB
existente (`server/tests/db/df-aprobat-derivat.test.mjs` e un model bun pentru paritate pe
mulțimi de id-uri).

Cazuri obligatorii:

1. ⭐⭐ **PARITATE listă↔detaliu, exhaustivă**: pentru un utilizator dat, mulțimea de id-uri
   întoarsă de `GET /api/alop` este **exact** mulțimea de id-uri pentru care `GET /api/alop/:id`
   întoarce 200. Zero id în listă care dă 404; zero id vizibil la detaliu care lipsește din
   listă. Rulează asta pentru **patru** actori: `admin`, `org_admin`, membru CAB, utilizator
   obișnuit dintr-un compartiment fără legătură cu dosarele. Ăsta e testul care ar fi prins
   bugul din prima zi.
2. ⭐ **Regresia raportată**: utilizator din compartimentul CAB al org-ului (`cab_compartiment`
   setat) + un dosar creat de ALTCINEVA, din ALT compartiment, fără el ca semnatar ⇒
   `GET /api/alop/:id` întoarce **200** (înainte: 404).
3. **Nu s-a lărgit peste organizație**: utilizator CAB din org A ⇒ dosar din org B rămâne
   **404**. Izolarea între instituții e neatinsă.
4. **Utilizatorul obișnuit NU s-a lărgit**: un dosar creat de altcineva, din alt compartiment,
   fără el ca semnatar ⇒ tot **404**. Fixul e strict pentru CAB.
5. **Căile care trebuie să rămână permise** pentru utilizatorul obișnuit: dosar creat de el ⇒
   200; dosar unde e semnatar pe `df_flow_id` ⇒ 200; dosar al compartimentului lui ⇒ 200.
6. **`cab_compartiment` gol pe organizație** ⇒ `isCabDept` fals ⇒ niciun utilizator nu primește
   relaxarea (fail-safe). Verifică explicit acest caz.
7. **Capabilities intacte**: pentru un membru CAB, răspunsul de la `GET /api/alop/:id` conține
   `capabilities` cu aceleași valori ca înainte pentru un dosar la care avea deja acces —
   `actorComp`/`cabComp` chiar ajung în `computeAlopCapabilities`, nu goale.
8. Dosar `cancelled_at IS NOT NULL` ⇒ **404** pentru oricine, inclusiv admin. Neschimbat.

```bash
node --check server/routes/alop.mjs
npx vitest run server/tests/db/alop-vizibilitate-paritate.test.mjs
npm test
npm run test:db
```

⚠️ **Testul `server/tests/db/flow-received-ack.test.mjs > (4) corelare exactă` e INSTABIL în
suita completă** (id-uri fixe `seedFlow('flow-r*')` + audit scris *fire-and-forget* după
răspuns). A picat și la #177, pe un lot care n-a atins niciun fișier de server. Dacă pică și
acum, **raportează-l separat ca preexistent și NU-l repara** — e în lotul de igienă. Dacă pică
**altceva**, oprește-te.

---

## ETAPA C — versiune și commit

1. `package.json`: `3.9.832` → `3.9.833`.
2. **`package-lock.json` în ACELAȘI commit**: `npm install --package-lock-only`, apoi
   verificare:
```bash
node -e "const p=require('./package.json'),l=require('./package-lock.json');if(p.version!==l.version||l.packages[''].version!==p.version)throw new Error('lockfile desincronizat: '+l.version);console.log('lock OK',l.version)"
```
   (Driftul dintre ele a picat `npm audit` cu „Invalid package tree" la merge-ul lui 831, iar
   jobul de teste are `needs: audit` ⇒ suita nu mai rulează deloc când auditul e roșu.)
3. Zero fișiere din `public/` ⇒ **FĂRĂ** bump `?v=`, **FĂRĂ** `CACHE_VERSION`.
4. `git add` explicit: `server/routes/alop.mjs`, testul nou, `package.json`,
   `package-lock.json`. **Niciodată `git add -A`.**
5. Commit:
   ```
   fix(#178): vizibilitatea ALOP pe sursa unica — detaliul cheama helperul — v3.9.833

   GET /api/alop/:id avea o COPIE inline a lui buildAlopVisibilityWhere,
   identica in afara iesirii devreme pe CAB, adaugata ulterior doar in helper.
   Un utilizator din compartimentul CAB vedea toate dosarele in lista si
   primea 404 not_found la deschidere, pe sarite. Copia dispare; lista si
   detaliul raspund din acelasi loc. Test de paritate exhaustiva pe multimi
   de id-uri, pentru patru tipuri de actor.
   ```
6. `git push origin develop`

---

## RAPORT FINAL — obligatoriu

1. Ancorele din Etapa 0, cu valorile OBȚINUTE. Dacă vreun contor a diferit, care și cât.
2. `loadActorCompAndCab` — a rămas cu consumatori în `alop.mjs`? Ce ai făcut cu importul.
3. Rezultatul fiecărui caz din Etapa B, cu accent pe 1, 2, 3 și 6.
4. Numărul de runde la bază pe calea de detaliu, înainte și după (așteptat: identic).
5. Numerele reale `npm test` / `npm run test:db`; dacă `test:db` a rulat REAL; dacă
   `flow-received-ack` a picat din nou.
6. Rezultatul verificării de sincronizare a lockfile-ului.
7. Teste preexistente atinse. (Așteptat: NICIUNUL.)
8. Divergențe prompt↔cod — raportate, NU reparate tăcut.
9. Constatări colaterale — consemnate, nereparate. În special: dacă mai găsești ALTE copii
   inline ale unui predicat care există deja ca helper, listează-le fără să le atingi.

---

## ⛔ CONSTRÂNGERI ABSOLUTE

- `develop` ONLY. UN SINGUR fișier de producție: `server/routes/alop.mjs`.
- Zero migrații, zero `public/`.
- `buildAlopVisibilityWhere` NEMODIFICAT.
- Izolarea între organizații NEATINSĂ (cazul 3 o verifică).
- `package-lock.json` sincronizat în același commit.
- `git add` explicit.
- `old_str` care nu se potrivește exact ⇒ **OPREȘTE-TE și raportează**.
