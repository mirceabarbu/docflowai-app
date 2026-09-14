---
prompt: 185
titlu: "link-df recunoaște reviziile aceluiași dosar — eroarea falsă „legarea a eșuat: not_found\""
model_suggested: "Opus 5, efort high"
branch: develop
versiune_curenta: v3.9.839
versiune_tinta: v3.9.840
migratii: NU
fisiere_din_public: NU   (⇒ FĂRĂ bump `?v=`, FĂRĂ `CACHE_VERSION`)
zona_no_touch_atinsa: NU
---

# ⚠️ BRANCH

Lucrezi **EXCLUSIV pe `develop`**. `main` = PRODUCȚIE, gestionat manual de Mircea.
Nu propune și nu executa `checkout main`, `merge main`, `push main`.
Pasul final obligatoriu: **`git push origin develop`**.

---

## Simptomul

La salvarea unei **revizii** (R1) a unui DF care aparține unui dosar ALOP, utilizatorul vede
banda roșie:

> ❌ Documentul a fost salvat, dar legarea la dosarul ALOP a eșuat: not_found.
> Reîncercați salvarea sau legați documentul din dosarul ALOP.

Reprodus pe staging, pe un ALOP **completat** (ORD aprobat, lichidat, plătit), la salvarea lui R1.

## Cauza, urmărită până la capăt

`saveDoc` cheamă `_alopLinkDoc` la **fiecare** salvare (`public/js/formular/doc.js:1204` →
`public/js/formular/alop.js:30`), inclusiv pentru revizii, și trimite id-ul lui **R1**.

`POST /api/alop/:id/link-df` (`server/routes/alop.mjs:1144`) se termină cu:

```sql
WHERE id = $2 AND org_id = $3
  AND (df_id IS NULL OR df_id = $1)
```

`alop_instances.df_id` e id-ul lui **R0**. R1 e un rând nou, cu id nou ⇒ zero rânduri ⇒
`404 not_found`.

**Serverul are dreptate.** `server/routes/formulare/df.mjs:725`, comentariul lui #134f:

> POINTERUL NU SE MAI MUTĂ AICI. `alop_instances.df_id` înseamnă de acum „revizia ÎN VIGOARE"
> = ultima aprobată. Cât timp R(n+1) e în lucru sau pe flux, dosarul citește în continuare
> cifrele lui R(n). Mutarea se face EXCLUSIV la aprobare, prin `selfHealAlopDfLink`.

Deci frontendul cere o legare pe care regula o interzice deliberat, iar mesajul — adăugat la
v3.9.554 tocmai ca eșecul să nu mai fie tăcut — apare pe un caz perfect normal.

⚠️ **Partea periculoasă nu e mesajul, e sfatul din el.** Reîncercarea nu poate reuși niciodată.
Iar dacă utilizatorul chiar „leagă documentul din dosarul ALOP", mută pointerul de pe R0
**aprobat** pe R1 **în lucru** — exact ce #134f a interzis: dosarul ar începe să raporteze
cifrele unei revizii nevalidate de nimeni.

**Nu are legătură cu #183/#184.** `not_found` vine din corpul handlerului, deci cererea a trecut
de CSRF și de autentificare; codul serverului n-a fost atins de acele loturi. Bug-ul există de
la #134f.

---

## Reparația cerută

`link-df` recunoaște **reviziile aceluiași dosar**: dacă `UPDATE`-ul n-a atins niciun rând
pentru că ALOP-ul pointează deja spre o **altă revizie a aceluiași dosar**, ruta răspunde
**200, fără să modifice nimic**.

Trei lucruri care definesc reparația:

1. **Pointerul NU se mută.** Asta e întregul rost. Un răspuns 200 care ar muta pointerul ar
   reintroduce fix bug-ul pe care #134f l-a închis.
2. **Garda anti-deturnare rămâne intactă.** Dacă ALOP-ul pointează spre un DF din **alt dosar**,
   răspunsul rămâne `404 not_found`. Aceea e apărarea pusă la #120/#164 și nu se atinge.
3. **Calea de succes existentă rămâne bit-identică.** Noua logică se execută **numai** pe ramura
   care azi întoarce 404 — deci nu poate schimba comportamentul niciunui caz care merge azi.

### Cheia dosarului — folosește ce există

`server/services/df-dosar-key.mjs` (modul pur, #126) exportă `dosarKeyExpr(alias)` și
`dosarKeyOf(row)`. Cheia e `COALESCE(source_alop_id::text, nr_unic_inreg)`.

⛔ **Nu compara pe `nr_unic_inreg`.** În producție există numere duplicate între dosare
diferite (`docs/incidents/DF-NR-DUPLICAT.md`); comparația pe număr ar accepta drept „aceeași
serie" un DF din alt dosar, adică ar deschide exact gaura pe care garda o apără.

**Precedentul de urmat, caracter cu caracter:** `server/services/alop-link.mjs:56-66`
(`selfHealAlopDfLink`) face deja exact această comparație, cu `EXISTS` + `dosarKeyExpr`.
Citește-l înainte de a scrie și păstrează aceeași formă.

---

## ETAPA 0 — ancorele (READ-ONLY)

Raportează valorile **OBȚINUTE**. Orice nepotrivire ⇒ **OPREȘTE-TE**.

```bash
node -p "require('./package.json').version"          # Așteptat: 3.9.839

grep -n "if (!rows\[0\]) return res.status(404).json({ error: 'not_found' });" server/routes/alop.mjs
# Așteptat: mai multe potriviri în fișier — identifică-o pe CEA din interiorul lui
# POST /api/alop/:id/link-df (după UPDATE-ul cu RETURNING *), și raportează numărul ei de linie.
# ⚠️ Dacă tratezi greșit potrivirea, strici altă rută: extinde old_str cu contextul din jur
# până devine unic. NU folosi un old_str care se potrivește de mai multe ori.

grep -n "dosarKeyExpr\|dosarKeyOf" server/routes/alop.mjs
# Așteptat: raportează ce găsești — dacă modulul nu e deja importat acolo, îl adaugi.

grep -rn "link-df" server/tests/db/*.test.mjs server/tests/integration/*.test.mjs | wc -l
```

Citește integral, înainte de a scrie: ruta `link-df` (`alop.mjs:1144-1197`),
`services/alop-link.mjs:40-70`, `services/df-dosar-key.mjs`.

---

## ETAPA A — ramura nouă

În `POST /api/alop/:id/link-df`, transformă ramura de 404 de după `UPDATE`.

Forma cerută (adaptează la stilul din jur, păstrează semantica exact):

```js
    if (!rows[0]) {
      // #185 — UPDATE-ul n-a atins niciun rând. Două cauze posibile, cu verdicte diferite:
      //   (a) ALOP-ul pointează spre o ALTĂ REVIZIE A ACELUIAȘI DOSAR — caz NORMAL.
      //       #134f a decis că pointerul se mută EXCLUSIV la aprobare, prin
      //       selfHealAlopDfLink. Frontendul cheamă totuși link-df la fiecare salvare
      //       (doc.js → _alopLinkDoc), deci fiecare salvare a unei revizii producea o
      //       bandă roșie care sfătuia utilizatorul să relege manual — adică exact
      //       acțiunea care ar muta pointerul de pe revizia aprobată pe una în lucru.
      //       Răspundem 200 și NU atingem nimic.
      //   (b) ALOP-ul pointează spre un DF din ALT DOSAR — deturnare. Rămâne 404.
      const { rows: cur } = await pool.query(
        'SELECT * FROM alop_instances WHERE id=$1 AND org_id=$2',
        [req.params.id, actor.orgId]
      );
      const curDfId = cur[0]?.df_id || null;
      if (curDfId && curDfId !== df_id) {
        // Cheia e DOSARUL, nu numărul de înregistrare — în producție există
        // nr_unic_inreg duplicate între dosare diferite (docs/incidents/DF-NR-DUPLICAT.md).
        const { rows: same } = await pool.query(
          `SELECT EXISTS (
             SELECT 1
               FROM formulare_df fd_cur, formulare_df fd_new
              WHERE fd_cur.id = $1 AND fd_new.id = $2
                AND fd_cur.org_id = $3 AND fd_new.org_id = $3
                AND fd_cur.deleted_at IS NULL AND fd_new.deleted_at IS NULL
                AND ${dosarKeyExpr('fd_cur')} = ${dosarKeyExpr('fd_new')}
           ) AS same_dosar`,
          [curDfId, df_id, actor.orgId]
        );
        if (same[0]?.same_dosar) {
          logger.info({ alopId: req.params.id, curDfId, newDfId: df_id },
            '[ALOP] link-df: revizie a aceluiasi dosar — pointerul ramane pe revizia in vigoare (#134f)');
          return res.json({ ok: true, noop: 'revizie_in_lucru', alop: cur[0] });
        }
      }
      return res.status(404).json({ error: 'not_found' });
    }
```

⚠️ Verifică ce se întâmplă când `dosarKeyExpr` dă `NULL` pe una dintre laturi (DF legacy fără
`source_alop_id` și cu `nr_unic_inreg` gol): `NULL = NULL` e `NULL`, deci `EXISTS` e fals și
răspunsul rămâne 404. **Fail-closed, corect** — confirmă-l cu un test, nu doar prin raționament.

⛔ Nu atinge: verificarea de conflict `df_deja_legat` (409), `canEditAlop`, `df_not_found`,
`UPDATE`-ul însuși, sau ramura de succes.

---

## ETAPA B — testele

Fișier nou `server/tests/db/alop-link-df-revizie.test.mjs`, pe Postgres real:

1. ⭐ **Cazul raportat:** ALOP cu `df_id` = R0, `link-df` cu id-ul lui R1 (aceeași
   `source_alop_id`) ⇒ **200**, `ok:true`, `noop:'revizie_in_lucru'`.
2. ⭐ **Invariantul #134f:** după cazul 1, `alop_instances.df_id` citit **din DB** e în
   continuare R0. Plus `df_flow_id` și `df_completed_at` neschimbate. Ăsta e testul care
   contează cel mai mult — un 200 care mută pointerul ar fi mai rău decât eroarea pe care o
   reparăm.
3. ⭐ **Garda anti-deturnare:** ALOP cu `df_id` = un DF din **alt dosar**, `link-df` cu alt
   `df_id` ⇒ **404 `not_found`**, pointer neschimbat.
4. **Numerele duplicate nu păcălesc cheia:** două DF-uri din dosare DIFERITE cu **același**
   `nr_unic_inreg`, dar `source_alop_id` diferite ⇒ **404**. Testul care apără alegerea cheii.
5. **Legacy fail-closed:** `source_alop_id` NULL pe ambele și `nr_unic_inreg` egal ⇒ **200**
   (același dosar, prin fallback-ul documentat). Cu `nr_unic_inreg` NULL/gol ⇒ **404**.
6. **Nedeteriorare, calea normală:** ALOP cu `df_id` NULL ⇒ 200, pointer setat, `status`
   `draft` → `angajare`, exact ca înainte.
7. **Nedeteriorare, idempotență:** `link-df` cu ACELAȘI `df_id` deja legat ⇒ 200 pe calea veche
   (trece prin `UPDATE`), **nu** pe ramura nouă. Verifică prin absența lui `noop` din răspuns.
8. **Nedeteriorare, ALOP inexistent** ⇒ 404 `not_found` (ramura de dinaintea `UPDATE`-ului).
9. **ALOP completat:** cazul 1 pe un ALOP cu `status='completed'` ⇒ 200, pointer neschimbat.
   Exact configurația de pe staging.

⚠️ Trebuie să rămână verzi, **nemodificate**, cele două cazuri din
`server/tests/db/alop-df-relink-selfheal.test.mjs:249` și `:259` — „link-df pe DF deja legat la
un ALOP … → 409 `df_deja_legat` (guard nemodificat)". Ele se execută **înainte** de `UPDATE`,
deci ramura nouă nu le atinge. Confirmă asta explicit în raport.
La fel `alop-revizie-in-vigoare.test.mjs`, care fixează chiar invariantul #134f.

```bash
npm test
npm run test:db
```

`test:db` trebuie să ruleze **COMPLET, REAL** (rețeta din `CLAUDE.md`). **Skipped ≠ passed.**

---

## ETAPA C — versiune, lockfile, commit

```bash
npm version 3.9.840 --no-git-tag-version
npm install --package-lock-only
git diff --stat package-lock.json     # Așteptat: 2 linii de versiune
git status --short
```

`git add` **explicit**. **Niciodată `git add -A`.**

Commit:
```
fix(#185): link-df recunoaste reviziile aceluiasi dosar — v3.9.840

La salvarea unei revizii a unui DF legat la un dosar ALOP, utilizatorul primea
"legarea la dosarul ALOP a esuat: not_found". Cauza: frontendul cheama link-df
la fiecare salvare, cu id-ul reviziei noi, iar garda finala a UPDATE-ului cere
ca df_id sa fie NULL sau egal cu cel trimis. Pointerul ramane insa pe revizia
in vigoare prin decizia #134f — mutarea se face exclusiv la aprobare.

Ramura de 404 distinge acum doua cauze: pointer pe alta revizie a ACELUIASI
dosar (caz normal, 200 fara nicio modificare) si pointer pe un DF din alt dosar
(deturnare, 404 ca inainte). Cheia e dosarul, prin dosarKeyExpr — nu numarul de
inregistrare, care are duplicate intre dosare in productie.

Mesajul vechi era cosmetic, dar sfatul din el nu: "legati documentul din dosarul
ALOP" ar fi mutat pointerul de pe revizia aprobata pe una in lucru, adica exact
ce #134f a interzis.
```

```bash
git push origin develop
```

---

## RAPORT FINAL — obligatoriu

1. Ancorele din Etapa 0, cu valorile **OBȚINUTE**, inclusiv numărul de linie al ramurii de 404
   din `link-df` și cum ai făcut `old_str` unic.
2. Forma finală a ramurii noi, așa cum a rămas în cod.
3. Rezultatul fiecărui caz din Etapa B, în special **2, 3 și 4**.
4. Confirmare explicită că cele două cazuri de 409 din `alop-df-relink-selfheal.test.mjs` și
   testele din `alop-revizie-in-vigoare.test.mjs` au rămas verzi **nemodificate**.
5. Numerele reale `npm test` / `npm run test:db`; dacă `test:db` a rulat COMPLET.
6. Teste preexistente atinse. (Așteptat: **NICIUNUL**. Dacă pică vreunul, raportează ÎNAINTE
   de a-l modifica.)
7. Divergențe prompt↔cod — raportate, **NU** reparate tăcut.
8. Constatări colaterale. Mă interesează în mod special:
   - dacă `link-ord` are aceeași structură de gardă și dacă ORD are vreun mecanism de revizii
     care să producă simptomul simetric (eu cred că nu — ORD n-are `/revizuieste` — dar
     verifică, nu mă crede pe cuvânt);
   - dacă mai există alte rute care întorc `not_found` pe același tipar „pointerul e pe altă
     revizie".

---

## ⛔ CONSTRÂNGERI ABSOLUTE

- `develop` ONLY. Zero migrații. **Zero fișiere din `public/`** — frontendul rămâne neatins.
- **Pointerul NU se mută pe ramura nouă.** Zero `UPDATE` acolo.
- Garda `df_deja_legat` (409), `canEditAlop`, `df_not_found` și calea de succes: neatinse.
- Comparația se face pe `dosarKeyExpr`, niciodată pe `nr_unic_inreg` direct.
- `git add` explicit, niciodată `-A`.
- Orice `old_str` care nu se potrivește exact, sau care se potrivește de mai multe ori ⇒
  **OPREȘTE-TE și raportează**.
