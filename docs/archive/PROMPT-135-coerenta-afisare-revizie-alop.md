---
lot: "#135 — coerența afișării reviziilor pe cardul ALOP"
versiune_start: v3.9.792
versiune_tinta: v3.9.793
model_suggested: Sonnet 5 (efort medium)
migratii: 0
scriere_de_date: NU (lot pur de citire/afișare)
cache_version_sw: NESCHIMBAT (alop.js nu e în PRECACHE_ASSETS)
---

# ⚠️ BRANCH: develop

`main` = PRODUCȚIE și e gestionat MANUAL de Mircea. Nu faci `checkout`, `merge`
sau `push` pe `main`. Toate commit-urile și push-ul final merg pe `develop`.

---

## CONTEXT — de ce există acest lot

După #134f, `alop_instances.df_id` înseamnă **revizia ÎN VIGOARE** a dosarului;
pointerul se mută doar la aprobare. Dar rândurile scrise ÎNAINTE de #134f au
rămas cu pointerul pe o revizie neaprobată. Rezultatul, văzut în producție pe un
dosar real:

> DF în vigoare: **R2** · Revizie în lucru: **R2**

Un document nu poate fi simultan în vigoare și în lucru. Contradicția e afișabilă
azi pentru că cele două cifre vin din **surse diferite**:

- „DF în vigoare" = `df.revizie_nr` prin `LEFT JOIN formulare_df df ON df.id = a.df_id`
  → **pointerul**;
- „Revizie în lucru" = `df_revizie_lucru_nr` → **derivat pe dosar** (#134e).

Rândurile stricate se repară separat, cu un `UPDATE` țintit. **Acest lot nu
repară date** — face ca starea auto-contradictorie să nu mai fie afișabilă
NICIODATĂ, indiferent cât de stricat e pointerul. Plasă de siguranță, nu fix.

### Ce NU face acest lot (limite ferme)

- ⛔ Nu mută niciun pointer, nu scrie în nicio tabelă.
- ⛔ Nu schimbă sursa cifrelor financiare. `df_valoare`, `df_buget_an_curent`,
  `credite_bugetare_an_curent`, `ramas_an_curent` rămân citite prin pointer.
  Motivul e important: plafonul din `POST /api/alop/:id/noua-lichidare` se
  calculează tot pe pointer — dacă am rederiva banii doar pe card, cardul și
  plafonul ar începe să se contrazică, ceea ce e mai rău decât o cifră stricată
  vizibil semnalată. Când pointerul e incoerent, cifrele se **marchează**, nu se
  rescriu.
- ⛔ Nu atinge zona NO-TOUCH (`STSCloudProvider.mjs`, `routes/flows/cloud-signing.mjs`,
  `routes/flows/bulk-signing.mjs`, `signing/pades.mjs`, `signing/java-pades-client.mjs`).

---

## PASUL 0 — branch și punct de plecare

```bash
git branch --show-current
# Așteptat: develop     (dacă NU: git checkout develop && git pull --ff-only)

grep '"version"' package.json
# Așteptat: "version": "3.9.792",
```

---

## PASUL 1 — ancore (read-only, confirmă înainte de orice patch)

```bash
grep -n "sqlRevizieInLucruId\|sqlRevizieInLucruNr" server/services/alop-dosar-sql.mjs
# Așteptat: 2 linii de export + apariții în corpul modulului

grep -c "SQL_ALOP_REVIZIE_LUCRU_NR" server/routes/alop.mjs
# Așteptat: 3   (1 definire + 2 utilizări: lista și detaliul)

grep -n "df_revizie_nr\|df_revizie_lucru_nr" public/js/formular/alop.js
# Așteptat: EXACT liniile 656, 663, 665, 666, 819 — toate în renderAlopDetail

grep -n "alop.js?v=" public/formular.html
# Așteptat: o singură linie, cu ?v=3.9.790
```

Dacă vreo ancoră lipsește sau numărul diferă: **OPREȘTE-TE și raportează**, nu
improviza alt punct de inserție.

---

## ETAPA A — derivarea „revizia ÎN VIGOARE" (modul pur)

Fișier: `server/services/alop-dosar-sql.mjs`

Adaugi complementara exactă a lui `revizieInLucru`: ultima revizie **aprobată** a
dosarului. Aceleași reguli ca în restul modulului: corelat STRICT pe `a.*`, fără
nicio referință la aliasul `df` sau la vreun JOIN (WHERE-ul de COUNT din
`GET /api/alop` nu are joinuri — #121), fără backtick-uri și fără diacritice în
șirurile SQL returnate (#134b).

**old_str** (ultimele linii ale fișierului):

```js
/** Id-ul reviziei in lucru a dosarului, sau NULL. */
export const sqlRevizieInLucruId = (a = 'a') => revizieInLucru('fdrl.id', a);

/** Numarul (revizie_nr) reviziei in lucru a dosarului, sau NULL. */
export const sqlRevizieInLucruNr = (a = 'a') => revizieInLucru('fdrl.revizie_nr', a);
```

**new_str**:

```js
/** Id-ul reviziei in lucru a dosarului, sau NULL. */
export const sqlRevizieInLucruId = (a = 'a') => revizieInLucru('fdrl.id', a);

/** Numarul (revizie_nr) reviziei in lucru a dosarului, sau NULL. */
export const sqlRevizieInLucruNr = (a = 'a') => revizieInLucru('fdrl.revizie_nr', a);

/**
 * Subinterogare interna: revizia IN VIGOARE a dosarului = revizia cu revizie_nr
 * MAXIM care ESTE aprobata. Complementara exacta a lui revizieInLucru.
 *
 * ⚠️ DECIZII EXPLICITE (nu sunt scapari):
 *  1. FARA conditia revizie_nr > 0 — un R0 aprobat ESTE documentul in vigoare.
 *  2. Se deriva pe DOSAR, deci ramane corecta chiar daca a.df_id a ramas pe o
 *     revizie neaprobata (pointer scris inainte de #134f).
 *  3. Poate intoarce NULL desi df_aprobat e true: ramura de compatibilitate din
 *     sqlDosarAreAprobat (aprobare prin a.df_flow_id, cand DF-ul pointat n-are
 *     flow_id propriu) nu produce un revizie_nr. Consumatorul cade inapoi pe
 *     pointer in acel caz — vezi ETAPA C.
 */
const revizieInVigoare = (col, a) => `(
    SELECT ${col} FROM formulare_df fdrv
     WHERE ${sqlFdInDosar('fdrv', a)}
       AND EXISTS (
         SELECT 1 FROM flows frv
          WHERE frv.id::text = fdrv.flow_id
            AND ${dfAprobatSql('fdrv', 'frv')}
       )
     ORDER BY COALESCE(fdrv.revizie_nr, 0) DESC, fdrv.created_at DESC
     LIMIT 1
  )`;

/** Id-ul reviziei in vigoare a dosarului, sau NULL. */
export const sqlRevizieInVigoareId = (a = 'a') => revizieInVigoare('fdrv.id', a);

/** Numarul (revizie_nr) reviziei in vigoare a dosarului, sau NULL. */
export const sqlRevizieInVigoareNr = (a = 'a') =>
  revizieInVigoare('COALESCE(fdrv.revizie_nr, 0)', a);
```

Verificare:

```bash
node -e "import('./server/services/alop-dosar-sql.mjs').then(m=>{const s=m.sqlRevizieInVigoareNr();if(s.includes('\`'))throw new Error('BACKTICK in SQL');if(!/a\./.test(s))throw new Error('necorelat pe a.');if(/\bdf\./.test(s))throw new Error('referinta la aliasul df');console.log('OK',s.length,'caractere');})"
# Așteptat: OK <n> caractere
```

---

## ETAPA B — expunerea coloanei (fără schimbare de comportament)

Fișier: `server/routes/alop.mjs`

**B1** — importul. Adaugi `sqlRevizieInVigoareNr` în importul existent din
`alop-dosar-sql.mjs` (nu creezi un al doilea import din același modul).

**B2** — constanta, lângă cele existente:

**old_str**
```js
const SQL_ALOP_REVIZIE_LUCRU_NR = sqlRevizieInLucruNr('a');
```
**new_str**
```js
const SQL_ALOP_REVIZIE_LUCRU_NR = sqlRevizieInLucruNr('a');
// #135 — revizia ÎN VIGOARE, derivată pe DOSAR. Expusă ca să nu mai fie nevoie
// ca frontend-ul să deducă „în vigoare" din pointer (df.revizie_nr) — singura
// sursă din care se putea naște contradicția „în vigoare Rn / în lucru Rn".
const SQL_ALOP_REVIZIE_VIGOARE_NR = sqlRevizieInVigoareNr('a');
```

**B3** — în SELECT-ul din `GET /api/alop` (lista):

**old_str**
```js
        ${SQL_ALOP_REVIZIE_LUCRU_ID} AS df_revizie_lucru_id,
        ${SQL_ALOP_REVIZIE_LUCRU_NR} AS df_revizie_lucru_nr,
        (SELECT COALESCE(SUM((r->>'valt_actualiz')::numeric),0)
```
**new_str**
```js
        ${SQL_ALOP_REVIZIE_LUCRU_ID} AS df_revizie_lucru_id,
        ${SQL_ALOP_REVIZIE_LUCRU_NR} AS df_revizie_lucru_nr,
        ${SQL_ALOP_REVIZIE_VIGOARE_NR} AS df_revizie_vigoare_nr,
        (SELECT COALESCE(SUM((r->>'valt_actualiz')::numeric),0)
```

**B4** — în SELECT-ul din `GET /api/alop/:id` (detaliu):

**old_str**
```js
        ${SQL_ALOP_REVIZIE_LUCRU_ID} AS df_revizie_lucru_id,
        ${SQL_ALOP_REVIZIE_LUCRU_NR} AS df_revizie_lucru_nr,
        CASE WHEN COALESCE(fo.flow_id, a.ord_flow_id) IS NOT NULL AND (
```
**new_str**
```js
        ${SQL_ALOP_REVIZIE_LUCRU_ID} AS df_revizie_lucru_id,
        ${SQL_ALOP_REVIZIE_LUCRU_NR} AS df_revizie_lucru_nr,
        ${SQL_ALOP_REVIZIE_VIGOARE_NR} AS df_revizie_vigoare_nr,
        CASE WHEN COALESCE(fo.flow_id, a.ord_flow_id) IS NOT NULL AND (
```

⛔ Nu adaugi fragmentul în WHERE-ul de COUNT și nu-l bagi în `SQL_ALOP_BADGE`.
E doar o coloană de citire.

Verificare:

```bash
grep -c "SQL_ALOP_REVIZIE_VIGOARE_NR" server/routes/alop.mjs
# Așteptat: 3   (1 definire + 2 utilizări)
grep -c "AS df_revizie_vigoare_nr" server/routes/alop.mjs
# Așteptat: 2
```

---

## ETAPA C — afișarea (public/js/formular/alop.js, doar în renderAlopDetail)

**C1 — starea reviziilor, calculată o singură dată.**

**old_str** (linia 656, integral):

```js
  const _dfRevTxt=a.df_id?(()=>{const _n=a.df_revizie_nr||0;const _a=a.df_este_revizie_an_urmator?' · an următor':'';return _n>0?` · Revizia ${_n}${_a}`:` · Revizia 0${_a}`;})():'';
```

**new_str**:

```js
  // #135 — starea reviziilor se citește din DERIVĂRILE PE DOSAR, nu din pointer.
  // `vigoare` = ultima revizie aprobată a dosarului; `lucru` se afișează DOAR dacă
  // e un alt număr decât cea în vigoare (altfel cardul s-ar contrazice singur);
  // `incoerent` = pointerul ALOP→DF nu arată spre revizia în vigoare, deci cifrele
  // financiare din antet provin din alt document decât cel afișat ca fiind în vigoare.
  const _revStare=(()=>{
    if(!a.df_id) return {vigoare:null,lucru:null,incoerent:false};
    const _ptr=a.df_revizie_nr||0;
    const _vig=(a.df_revizie_vigoare_nr!=null)?a.df_revizie_vigoare_nr:(a.df_aprobat?_ptr:null);
    const _luc=(a.df_revizie_lucru_nr!=null)?a.df_revizie_lucru_nr:null;
    return {vigoare:_vig,lucru:(_luc!=null&&_luc!==_vig)?_luc:null,incoerent:(_vig!=null&&_ptr!==_vig)};
  })();
  const _dfRevTxt=a.df_id?(()=>{const _n=(_revStare.vigoare!=null)?_revStare.vigoare:(a.df_revizie_nr||0);const _a=a.df_este_revizie_an_urmator?' · an următor':'';return _n>0?` · Revizia ${_n}${_a}`:` · Revizia 0${_a}`;})():'';
```

**C2 — cardul de fază „Angajare": revizia în vigoare nu se mai deduce scăzând 1.**

**old_str** (liniile 663–666):

```js
        // #134e — revizia „în lucru" se derivă pe DOSAR (df_revizie_lucru_nr), nu pe pointerul
        // df_id. Se aprinde ACUM și pentru o revizie în DRAFT, nu doar pentru una pe flux.
        :(a.df_revizie_lucru_nr>0 && a.df_flow_active)?`🔄 Revizia ${a.df_revizie_lucru_nr} pe flux — în curs · în vigoare rămâne Revizia ${a.df_revizie_lucru_nr-1}`
        :(a.df_revizie_lucru_nr>0)?`🔄 Revizia ${a.df_revizie_lucru_nr} în lucru — în vigoare rămâne Revizia ${a.df_revizie_lucru_nr-1}`
```

**new_str**:

```js
        // #134e — revizia „în lucru" se derivă pe DOSAR, nu pe pointerul df_id.
        // #135 — revizia în vigoare se ia din derivare, nu prin scădere aritmetică:
        // un dosar poate sări numere de revizie, iar cu pointerul stricat scăderea
        // dădea o cifră care nu corespundea niciunui document real.
        :(_revStare.lucru>0 && a.df_flow_active)?`🔄 Revizia ${_revStare.lucru} pe flux — în curs · ${_revStare.vigoare!=null?`în vigoare rămâne Revizia ${_revStare.vigoare}`:'nicio revizie aprobată încă'}`
        :(_revStare.lucru>0)?`🔄 Revizia ${_revStare.lucru} în lucru — ${_revStare.vigoare!=null?`în vigoare rămâne Revizia ${_revStare.vigoare}`:'nicio revizie aprobată încă'}`
```

**C3 — linia „DF în vigoare" din antet (linia ~819, o singură linie lungă).**

**old_str** — linia integrală care începe cu `          ${a.df_id?` și conține
`DF în vigoare:` (copiaz-o EXACT din fișier, cu tot cu indentarea de 10 spații).

**new_str** — aceeași structură, cu trei schimbări: cifra vine din `_revStare.vigoare`,
chip-ul „Revizie în lucru" apare doar când există un număr DIFERIT, iar incoerența
pointerului devine vizibilă în loc să fie tăcută:

```js
          ${a.df_id?`<div style="font-size:.78rem;color:var(--df-text-3);margin-top:4px;display:flex;align-items:center;gap:6px;flex-wrap:wrap">${_revStare.vigoare!=null?`DF în vigoare: <span class="df-revizie-badge${_revStare.vigoare>0?' revizie-activa':''}">R${_revStare.vigoare}</span>${_revStare.vigoare>0?`<span>Revizia ${_revStare.vigoare}</span>`:`<span>Revizia inițială</span>`}`:`<span style="color:#fbbf24;font-weight:600">Fără revizie aprobată</span>`}${a.df_nr?`<span style="color:var(--df-text-2);font-weight:600">· Nr. ${a.df_nr}</span>`:''}${a.df_este_revizie_an_urmator?`<span style="color:#fbbf24;font-size:.72rem">· an următor</span>`:''}${_revStare.lucru!=null?`<span style="color:#fbbf24;font-weight:600" title="Revizie derivată pe dosarul ALOP: există o revizie neaprobată cu număr mai mare decât cea în vigoare.">· Revizie în lucru: R${_revStare.lucru}</span>`:''}${_revStare.incoerent?`<span style="color:#f87171;font-weight:600" title="Legătura ALOP→DF indică R${a.df_revizie_nr||0}, care nu este revizia în vigoare. Cifrele DF din antet provin din R${a.df_revizie_nr||0} și trebuie verificate.">⚠ legătură DF de verificat</span>`:''}</div>`:''}
```

**C4 — tooltipul valorii din antet.** Eticheta vizibilă „DF actual" **rămâne
neschimbată** (o păzește `server/tests/unit/alop-header-df-actual.test.mjs`, care
caută literalii `DF actual`, `estimat` și marcajul `v3.9.503` — nu le atinge).
Se schimbă doar textul din `title`:

**old_str**
```js
title="Valoare din DF activ (cea mai recentă revizie)"
```
**new_str**
```js
title="Valoare din DF-ul în vigoare (revizia aprobată a dosarului)"
```

**C5 — cache busting ȚINTIT** (doar `alop.js`, doar în `public/formular.html`):

```bash
sed -i -E "s#(alop\.js\?v=)[0-9.]+#\13.9.793#g" public/formular.html
grep -n "alop.js?v=" public/formular.html
# Așteptat: o singură linie, ?v=3.9.793, tag-ul <script ... defer></script> INTACT
```

⛔ Nu atingi alte `?v=` (driftul față de `package.json` e intenționat) și nu
modifici `CACHE_VERSION` din `public/sw.js` — `alop.js` nu e în `PRECACHE_ASSETS`.

---

## ETAPA D — teste

**D1 — structural pe modulul SQL.** Extinzi
`server/tests/unit/alop-dosar-sql.test.mjs`: adaugi cele două exporturi noi în
obiectul `TOATE()` (ca să treacă prin toate porțile existente: nevid, corelat pe
`a.`, alias personalizat propagat, fără backtick) și adaugi o aserție că
`sqlRevizieInVigoareNr()` conține `EXISTS (` iar `sqlRevizieInLucruNr()` conține
`NOT EXISTS (` — complementaritatea e contractul lotului.

**D2 — comportament real pe DB.** Extinzi
`server/tests/db/alop-dosar-derivari.test.mjs`. Fixture-ul existent lasă
pointerul pe ULTIMA revizie creată, adică exact regimul de pointer stricat — nu-l
schimba, ăsta e testul. Adaugi un `it(...)` nou:

- **D2 (R0 aprobat + R1 draft, pointer pe R1)** → `df_revizie_vigoare_nr === 0`,
  `df_revizie_lucru_nr === 1`. Se verifică pe AMBELE căi: `rand(D2)` și `detaliu(D2)`.
- **D3 (R0 aprobat + R1 pe flux activ, pointer pe R1)** → `df_revizie_vigoare_nr === 0`,
  `df_revizie_lucru_nr === 1`.
- **D1 (R0 aprobat, fără revizii)** → `df_revizie_vigoare_nr === 0`,
  `df_revizie_lucru_nr === null` — cazul în care cele două NU se pot contrazice.
- Aserția centrală, scrisă explicit: pentru fiecare dosar,
  `df_revizie_vigoare_nr !== df_revizie_lucru_nr` sau una dintre ele e `null`.

**D3 — structural pe afișare.** Fișier NOU
`server/tests/unit/alop-revizie-coerenta.test.mjs`, pe tiparul lui
`alop-header-df-actual.test.mjs` (citește sursa cu `readFileSync` și verifică
forma). Aserții, formulate pe textul REZULTAT după patch:

1. sursa conține `df_revizie_vigoare_nr`;
2. sursa conține `incoerent:` și `_revStare`;
3. `renderAlopDetail` NU mai conține scăderea aritmetică — caută expresia
   `df_revizie_lucru_nr-1` și așteaptă **0 apariții**;
4. chip-ul „Revizie în lucru" e condiționat pe `_revStare.lucru!=null`, nu pe
   `a.df_revizie_lucru_nr!=null`.

⛔ Aserția (3) e valabilă doar dacă NICIUN comentariu pe care îl scrii nu conține
literalul `df_revizie_lucru_nr-1`. Verifică textul propriu înainte de a-l scrie —
e greșeala repetată de la #121/#124f/#124i.

Rulare:

```bash
npm test
# Așteptat: verde, fără regresii (raportează numărul de fișiere/teste)

npm run test:db
# Așteptat: PASSED REAL pe instanța PG 17 efemeră, conform rețetei din CLAUDE.md.
# „Skipped" NU înseamnă „passed" — dacă suita se sare, oprește-te și raportează.
```

---

## PASUL FINAL — versiune, commit, push

```bash
# package.json: 3.9.792 → 3.9.793

git status --short
# Așteptat: exact fișierele de mai jos (arborele are ~50 netrackuite — de-aia NU git add -A)

git add server/services/alop-dosar-sql.mjs \
        server/routes/alop.mjs \
        public/js/formular/alop.js \
        public/formular.html \
        server/tests/unit/alop-dosar-sql.test.mjs \
        server/tests/unit/alop-revizie-coerenta.test.mjs \
        server/tests/db/alop-dosar-derivari.test.mjs \
        package.json

git diff --cached --stat
git commit -m "fix(#135): cardul ALOP nu mai poate afisa simultan aceeasi revizie ca fiind in vigoare si in lucru (v3.9.793)"
git push origin develop
```

---

## RAPORT FINAL (obligatoriu, în acest format)

1. Branch la start și la final.
2. Ancorele din PASUL 1 — găsite exact? Ce a diferit, dacă a diferit.
3. Patch-urile aplicate, pe etape, cu eventualele devieri și motivul lor.
4. `npm test` — fișiere/teste, verde sau nu.
5. `npm run test:db` — PASSED REAL, cu numărul de fișiere/teste. Dacă a fost
   skipped, spune-o explicit.
6. Rezultatul aserțiunii centrale D2: valorile efective ale lui
   `df_revizie_vigoare_nr` / `df_revizie_lucru_nr` pe D1, D2, D3.
7. `?v=` final pentru `alop.js` și confirmarea că tag-ul `<script>` e intact.
8. Commit hash, versiunea din `package.json`, confirmarea push-ului pe `develop`.
9. Orice ai găsit pe drum și NU ai reparat (nu repara tăcut nimic în afara lotului).

---

## ⛔ CONSTRÂNGERI ABSOLUTE

- Doar `develop`. Fără `main`, fără merge, fără tag-uri.
- Zero migrații. Zero scrieri de date. Zero `UPDATE`/`INSERT` în afara testelor.
- Zona NO-TOUCH (STS/PAdES) rămâne neatinsă.
- Fără backtick-uri și fără diacritice în șirurile SQL din `alop-dosar-sql.mjs`.
- Fragmentele SQL rămân corelate STRICT pe `a.*` — nicio referință la aliasul `df`
  sau la vreun JOIN.
- Nu bulk-sed pe `?v=`; doar `alop.js`, doar în `public/formular.html`.
- `CACHE_VERSION` din `sw.js` rămâne `docflowai-v300`.
- Dacă o ancoră `old_str` nu se potrivește exact: OPREȘTE-TE și raportează. Nu
  cauți alt loc, nu rescrii funcția.
- Dacă ai nevoie să deviezi de la structura de mai sus, oprește-te și cere
  escaladarea la Opus 5 în loc să improvizezi.
