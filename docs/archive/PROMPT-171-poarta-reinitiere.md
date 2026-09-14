---
prompt: 171
titlu: "Poarta la reinițiere — ultima cale prin care un document mai putea primi al doilea flux viu"
model_suggested: "Sonnet 5, efort high"
branch: develop
versiune_curenta: v3.9.824
versiune_tinta: v3.9.825
migratii: NU
fisiere_din_public: NU   (⇒ FĂRĂ bump `?v=`, FĂRĂ `CACHE_VERSION`)
zona_no_touch_atinsa: NU
---

# ⚠️ BRANCH

Lucrezi **EXCLUSIV pe `develop`**. `main` = PRODUCȚIE, gestionat manual de Mircea.
Nu propune și nu executa `checkout`/`merge`/`push` pe `main`.
Pasul final obligatoriu: `git push origin develop`.

---

## Context — de ce mai există o gaură după #170

#170 (v3.9.824, LIVE) a pus poarta de lansare în `routes/flows/crud.mjs:133-205`: un document
care are deja un flux VIU (`liveFlowSql` pe `data->'meta'->>'dfId'/'ordId'`) primește **409
`document_are_flux_viu`** și fluxul al doilea nu se mai creează deloc.

**Dar `POST /flows` nu e singura cale prin care se naște un flux.** În tot arborele există
EXACT DOUĂ locuri care creează un flux nou:

| loc | rută | trece prin poarta #170? |
|---|---|---|
| `routes/flows/crud.mjs:516` | `POST /flows` | **DA** (poarta e chiar deasupra) |
| `routes/flows/lifecycle.mjs:155` | `POST /flows/:flowId/reinitiate` | **NU** |

(`reinitiate-review` reinițiază **în același `flowId`** — nu creează nimic; `PUT /flows/:flowId`
suprascrie un flux existent; restul apelurilor `saveFlow` actualizează fluxuri deja existente.)

### Ce lasă să treacă garda actuală

Garda #114 din `lifecycle.mjs:91-92` cheiază pe **POINTER**:

```js
const { rows: linkedOrd } = await pool.query('SELECT id FROM formulare_ord WHERE flow_id=$1', [flowId]);
const { rows: linkedDf }  = await pool.query('SELECT id FROM formulare_df  WHERE flow_id=$1', [flowId]);
```

Un flux **ORFAN** — creat înainte de #170, care poartă `meta.dfId`/`meta.ordId` dar **n-a luat
niciodată pointerul** (îl ține alt flux, fiindcă blocul PASUL 3 din `crud.mjs` a refuzat mutarea)
— întoarce ZERO rânduri la ambele interogări. Garda îl lasă să treacă, iar `reinitiate` îi
construiește un copil prin `{ ...data }`, deci **cu același `meta` moștenit**. Rezultat: încă un
flux viu pe același document, exact starea pe care #170 o refuză la lansare.

Producția are astfel de orfani (cei 48 de documente cu 2+ fluxuri măsurați pe 02.09), deci gaura
nu e teoretică: e accesibilă din butonul „Reinițiază" al listei de fluxuri, pe orice orfan care
a fost refuzat de un semnatar.

### Decizia (Mircea, 03.09.2026)

> Cheia gărzii se lărgește de la POINTER la `meta` — **aceeași cheie cu poarta #170**.
> Un flux care revendică un DF sau un ORD nu se reinițiază, indiferent dacă a apucat pointerul.
> Relansarea rămâne prin ALOP.

Traseul utilizatorului rămâne funcțional și după strângere: la refuz, `signing.mjs:214-241`
curăță `alop_instances.df_flow_id` / `ord_flow_id`, iar `computeAlopCapabilities` reoferă
`df_action` / `genereaza_lanseaza_ord`. Un flux refuzat NU e „viu" după `liveFlowSql`, deci
poarta #170 lasă noua lansare să treacă. **Nimeni nu rămâne blocat.**

---

## ⛔ Ce NU se atinge în acest lot

- **NU** modifica `routes/flows/crud.mjs` (poarta #170) în Etapele A și B. Etapa C o atinge
  strict ca extragere fără schimbare de comportament, cu testul existent ca poartă.
- **NU** goli `formulare_df.flow_id` / `formulare_ord.flow_id` nicăieri. Pointerul e mânerul
  prin care desfacerea regăsește documentul (`services/flow-undo.mjs:9-18`).
- **NU** schimba codul de eroare `formular_linked_flow` și nici forma răspunsului 409 —
  frontendul actual (`semdoc-initiator/main.js:1382`, `flow/flow.js:993`) afișează `j.message`.
  Un cod nou ar apărea brut pe ecran (clasa de bug de la `admin-cancel`/`not_found`).
- **NU** muta garda înaintea verificării de autorizare (403 înainte de 409 — vezi cazul de test 4).
- **NU** atinge `reinitiate-review`, `delegate`, `cancel`, `admin-cancel`.
- **NU** crea migrații, indici, fișiere `.sql` noi.
- **NU** atinge niciun fișier din `public/`.

---

## ETAPA 0 — ancore (READ-ONLY, zero modificări)

```bash
cd "$(git rev-parse --show-toplevel)"
git branch --show-current                      # Așteptat: develop
node -e "console.log(require('./package.json').version)"   # Așteptat: 3.9.824

grep -n "formular_linked_flow" server/routes/flows/lifecycle.mjs
# Așteptat: exact 1 linie (în corpul gărzii #114)

grep -c "flow_id=\$1', \[flowId\])" server/routes/flows/lifecycle.mjs
# Așteptat: 2  (cele două interogări de pointer)

ls server/services/flow-doc-claim.mjs 2>/dev/null
# Așteptat: „No such file" — modulul NU există încă
```

Dacă vreo ancoră nu se potrivește, **OPREȘTE-TE** și raportează. Nu improviza alt anchor.

---

## ETAPA A — modul PUR nou, ZERO consumatori

Creează `server/services/flow-doc-claim.mjs` cu EXACT acest conținut:

```js
/**
 * DocFlowAI — flow-doc-claim.mjs  (#171)
 * -------------------------------------------------------------------------
 * CE DOCUMENTE REVENDICĂ UN FLUX — sursă unică pentru lista de tipuri (DF/ORD)
 * și pentru citirea lor din `data.meta`.
 *
 * De ce există: poarta de lansare (#170, routes/flows/crud.mjs) și garda de
 * reinițiere (#114/#171, routes/flows/lifecycle.mjs) răspund la ACEEAȘI
 * întrebare — „ce document revendică fluxul ăsta?" — dar o scriau separat.
 * Garda de reinițiere o scria pe POINTER (`formulare_X.flow_id`), iar poarta
 * pe `meta` ⇒ un flux ORFAN (are `meta.dfId`, n-a luat pointerul) trecea de
 * gardă și primea un copil, ocolind poarta. Două definiții ale aceleiași
 * noțiuni = drift garantat; aici e una singură.
 *
 * ⛔ ZERO acces la baza de date, zero I/O — funcție pură pe obiectul `data`
 *    al fluxului. Interogările rămân în rute.
 * ⛔ Numele de tabele NU se exportă de aici: rutele le scriu literal, ca să
 *    nu apară tentația de a le interpola în SQL.
 */

export const DOC_KINDS = Object.freeze([
  Object.freeze({ metaKey: 'dfId',  formType: 'df',  eticheta: 'Documentul de Fundamentare' }),
  Object.freeze({ metaKey: 'ordId', formType: 'ord', eticheta: 'Ordonanțarea de plată' }),
]);

/**
 * @param {object|null|undefined} data — blobul JSONB al fluxului
 * @returns {Array<{metaKey:string, formType:string, eticheta:string, docId:string}>}
 *          lista documentelor revendicate; [] dacă fluxul nu revendică niciunul.
 * Tratează ca „nerevendicat": lipsa lui `meta`, `null`, `undefined`, șirul gol
 * și șirul format doar din spații.
 */
export function documenteRevendicate(data) {
  const meta = (data && typeof data === 'object' && data.meta && typeof data.meta === 'object')
    ? data.meta : {};
  const out = [];
  for (const kind of DOC_KINDS) {
    const raw = meta[kind.metaKey];
    if (raw === null || raw === undefined) continue;
    const docId = String(raw).trim();
    if (!docId) continue;
    out.push({ ...kind, docId });
  }
  return out;
}

/** true dacă fluxul revendică vreun formular (DF sau ORD). */
export function revendicaFormular(data) {
  return documenteRevendicate(data).length > 0;
}
```

### Test unitar nou — `server/tests/unit/flow-doc-claim.test.mjs`

Cazuri obligatorii:

1. `data` cu `meta.dfId` ⇒ un element, `formType==='df'`, `docId` = valoarea ca string.
2. `data` cu `meta.ordId` ⇒ un element, `formType==='ord'`.
3. `data` cu AMBELE ⇒ două elemente, **în ordinea DF apoi ORD** (ordinea din `DOC_KINDS`).
4. `data` fără `meta` / cu `meta:null` / `data:null` / `data:undefined` ⇒ `[]` (nu aruncă).
5. `meta.dfId` = `''`, `'   '`, `null` ⇒ `[]`.
6. `meta.dfId` numeric (ex. `42`) ⇒ `docId === '42'` (string, nu number).
7. `meta` cu chei străine (`alopId`, `foo`) ⇒ ignorate, `[]`.
8. `DOC_KINDS` e înghețat: `Object.isFrozen(DOC_KINDS) === true` și o încercare de `push`
   aruncă în strict mode.

### Poartă obligatorie de Etapă A — ZERO consumatori

```bash
grep -rn "flow-doc-claim" server --include=*.mjs | grep -v "server/tests/" | grep -v "server/services/flow-doc-claim.mjs"
# Așteptat: 0 linii  (modulul stă inofensiv, cablarea vine în Etapa B)
npx vitest run server/tests/unit/flow-doc-claim.test.mjs
```

---

## ETAPA B — cablarea în `reinitiate` (ACESTA E FIXUL)

### B.1 — importul

În `server/routes/flows/lifecycle.mjs`, adaugă importul imediat DUPĂ linia existentă:

`old_str`
```js
import { sanitizeCancelledCompletion } from '../../services/flow-completion.mjs';
```

`new_str`
```js
import { sanitizeCancelledCompletion } from '../../services/flow-completion.mjs';
import { documenteRevendicate } from '../../services/flow-doc-claim.mjs';
```

### B.2 — lărgirea cheii gărzii

`old_str` (copiat EXACT din `lifecycle.mjs`, liniile 85-100):
```js
    // #114 (varianta B): blochează reinițierea pe fluxuri legate de un formular (DF/ORD).
    // Reinițierea NU relinkează formularul (nu atinge formulare_{ord,df}.flow_id), deci
    // fluxul nou ar fi orfan: semnarea lui n-ar actualiza formularul, iar anularea lui
    // n-ar curăța ALOP-ul. Traseul corect după refuz e prin ALOP („Generează + Lansează
    // flux ORD" / „Completează DF"), care leagă formularul corect. A duplica logica de
    // legare aici ar crea o a doua cale divergentă (tipar eliminat în #111a).
    const { rows: linkedOrd } = await pool.query('SELECT id FROM formulare_ord WHERE flow_id=$1', [flowId]);
    const { rows: linkedDf }  = await pool.query('SELECT id FROM formulare_df  WHERE flow_id=$1', [flowId]);
    if (linkedOrd.length || linkedDf.length) {
      return res.status(409).json({
        error: 'formular_linked_flow',
        message: linkedOrd.length
          ? 'Acest flux aparține unei Ordonanțări de Plată. Relansează-l din ALOP („Generează + Lansează flux ORD"), nu prin reinițiere.'
          : 'Acest flux aparține unui Document de Fundamentare. Relansează-l din ALOP („Completează DF"), nu prin reinițiere.'
      });
    }
```

`new_str`:
```js
    // #114 (varianta B): blochează reinițierea pe fluxuri legate de un formular (DF/ORD).
    // Reinițierea NU relinkează formularul (nu atinge formulare_{ord,df}.flow_id), deci
    // fluxul nou ar fi orfan: semnarea lui n-ar actualiza formularul, iar anularea lui
    // n-ar curăța ALOP-ul. Traseul corect după refuz e prin ALOP („Generează + Lansează
    // flux ORD" / „Completează DF"), care leagă formularul corect. A duplica logica de
    // legare aici ar crea o a doua cale divergentă (tipar eliminat în #111a).
    //
    // #171 — CHEIA S-A LĂRGIT DE LA POINTER LA `meta`. Garda întreba doar pointerul
    // (`formulare_X.flow_id = $1`). Un flux ORFAN — creat înainte de poarta de lansare
    // #170, care poartă `meta.dfId`/`meta.ordId` dar N-A LUAT pointerul (îl ține alt flux)
    // — trecea de ea și primea un copil construit prin `{ ...data }`, deci cu ACELAȘI
    // `meta` moștenit ⇒ al doilea flux viu pe același document, exact ce refuză poarta de
    // la lansare. `reinitiate` era ULTIMA cale prin care se mai putea crea unul.
    // Cheia e acum aceeași cu a porții #170; pointerul rămâne ca a doua condiție, pentru
    // fluxurile vechi care n-au `meta`. Fluxurile obișnuite (fără DF/ORD) NU sunt atinse.
    const revendicate = documenteRevendicate(data);
    const { rows: linkedOrd } = await pool.query('SELECT id FROM formulare_ord WHERE flow_id=$1', [flowId]);
    const { rows: linkedDf }  = await pool.query('SELECT id FROM formulare_df  WHERE flow_id=$1', [flowId]);
    const _areOrd = linkedOrd.length > 0 || revendicate.some(d => d.formType === 'ord');
    const _areDf  = linkedDf.length  > 0 || revendicate.some(d => d.formType === 'df');
    if (_areOrd || _areDf) {
      logger.warn({ flowId, areOrd: _areOrd, areDf: _areDf,
        prinPointer: linkedOrd.length + linkedDf.length, prinMeta: revendicate.length },
        '[flux] reinitiere refuzata: fluxul revendica un formular');
      return res.status(409).json({
        error: 'formular_linked_flow',
        message: _areOrd
          ? 'Acest flux aparține unei Ordonanțări de Plată. Relansează-l din ALOP („Generează + Lansează flux ORD"), nu prin reinițiere.'
          : 'Acest flux aparține unui Document de Fundamentare. Relansează-l din ALOP („Completează DF"), nu prin reinițiere.'
      });
    }
```

**Precedența mesajului rămâne ORD înaintea DF**, ca înainte (era `linkedOrd.length ? … : …`).

### B.3 — test DB nou: `server/tests/db/reinitiate-orfan-blocat.test.mjs`

Model de urmat: `server/tests/db/reinitiate-formular-block.test.mjs` (același harness, aceeași
construcție de flux, `afterAll(() => pool.end())` **doar în ultimul `describe` din fișier**).

Cazuri obligatorii:

1. ⭐ **Orfan DF**: flux cu `data.meta.dfId = <id DF real>`, un semnatar `refused`, iar
   `formulare_df.flow_id` setat pe **ALT flux** ⇒ `POST /reinitiate` întoarce **409
   `formular_linked_flow`**, mesajul conține „Document de Fundamentare", **și
   `SELECT COUNT(*) FROM flows` e NESCHIMBAT** înainte/după (nu doar codul de răspuns).
2. ⭐ **Orfan ORD**: același tipar cu `meta.ordId` ⇒ 409, mesaj cu „Ordonanțări de Plată".
3. ⭐⭐ **INVARIANT DE PRODUS — fluxul obișnuit NU e afectat**: flux FĂRĂ `meta.dfId`/`ordId`
   și fără pointer, cu un semnatar `refused` ⇒ reinițierea **REUȘEȘTE** (200, `newFlowId`
   diferit, `COUNT(*) FROM flows` +1). Dacă acest caz pică, fixul e prea larg — se corectează
   fixul, NU testul.
4. **Ordinea gărzilor**: actor care nu e nici inițiator, nici admin, pe un orfan DF ⇒ **403**,
   nu 409 (garda rămâne DUPĂ autorizare).
5. **Regresie #124f**: flux orfan DF care are deja `data.reinitiatedAs` către un copil VIU ⇒
   răspunsul idempotent 200 cu `alreadyReinitiated:true` rămâne (verificarea `reinitiatedAs`
   e ÎNAINTEA gărzii și așa rămâne), iar `COUNT(*) FROM flows` NESCHIMBAT.
6. **Ambele revendicate** (`meta.dfId` ȘI `meta.ordId` pe același flux, caz patologic) ⇒ 409
   cu mesajul de ORD (precedența).

Cele două cazuri existente din `reinitiate-formular-block.test.mjs` (7 și 8, pe POINTER) trebuie
să treacă **NEMODIFICATE**. Dacă vreunul cere modificare, oprește-te și raportează — înseamnă că
patch-ul a schimbat comportamentul pe calea veche.

---

## ETAPA C — extragerea listei de tipuri în poarta #170 (zero schimbare de comportament)

Scop: `crud.mjs` și `lifecycle.mjs` să nu mai țină fiecare propria listă „dfId/ordId + etichetă".

În `server/routes/flows/crud.mjs`, înlocuiește **doar literalul listei** din bucla porții:

`old_str`
```js
    for (const [metaKey, formType, eticheta] of [
      ['dfId',  'df',  'Documentul de Fundamentare'],
      ['ordId', 'ord', 'Ordonanțarea de plată'],
    ]) {
      const docId = body.meta?.[metaKey];
      if (!docId || !pool) continue;
```

`new_str`
```js
    // #171 — lista de tipuri vine din services/flow-doc-claim.mjs (sursă unică, partajată
    // cu garda de reinițiere din lifecycle.mjs). Comportamentul porții rămâne IDENTIC:
    // aceleași două tipuri, aceeași ordine, aceeași citire din `body.meta`.
    for (const { metaKey, formType, eticheta } of DOC_KINDS) {
      const docId = body.meta?.[metaKey];
      if (!docId || !pool) continue;
```

și adaugă importul:

`old_str`
```js
import { liveFlowSql } from '../../services/flow-provenance.mjs';
```

`new_str`
```js
import { liveFlowSql } from '../../services/flow-provenance.mjs';
import { DOC_KINDS } from '../../services/flow-doc-claim.mjs';
```

**Poarta acestei etape:** `server/tests/db/flux-poarta-lansare.test.mjs` trebuie să treacă
**NEMODIFICAT**. Dacă cere fie și o singură ajustare, **revine la varianta dinainte de Etapa C**
(`git checkout -- server/routes/flows/crud.mjs`), raportează, și livrează lotul doar cu A+B.
Etapa C e o curățenie, nu merită niciun risc pe poarta abia intrată în producție.

---

## ETAPA D — verificări

```bash
node --check server/services/flow-doc-claim.mjs
node --check server/routes/flows/lifecycle.mjs
node --check server/routes/flows/crud.mjs

grep -c "documenteRevendicate" server/routes/flows/lifecycle.mjs
# Așteptat: 2   (importul + apelul; comentariul dictat NU conține cuvântul)

grep -c "DOC_KINDS" server/routes/flows/crud.mjs
# Așteptat: 2   (importul + bucla)

grep -n "formular_linked_flow" server/routes/flows/lifecycle.mjs
# Așteptat: tot 1 linie — codul de eroare NU s-a schimbat

git status --short
# Așteptat: EXACT 5 căi ale sarcinii (2 rute + modulul nou + 2 fișiere de test) plus
# eventualele fișiere netracked vechi din rădăcină. CONFIRMĂ ÎN RAPORT că ai dat `git add`
# doar pe cele 5, niciodată `git add -A`.

npm test
npm run test:db      # PG 17 efemer, rețeta din CLAUDE.md (port 55432, oprit + curățat după)
```

`npm test` și `npm run test:db` trebuie să fie **verzi, fără regresii**. Nu raporta un număr
țintă de teste — raportează numerele obținute și diferența față de rulare.

---

## ETAPA E — versiune și commit

1. `package.json`: `3.9.824` → `3.9.825`. **Nimic altceva** — zero fișiere din `public/`,
   deci FĂRĂ `CACHE_VERSION` în `sw.js` și FĂRĂ bump `?v=`.
2. `git add` explicit pe cele 5 căi + `package.json`.
3. Commit:
   ```
   fix(#171): poarta de reinitiere cheiata pe meta, nu pe pointer — v3.9.825

   Un flux ORFAN (poarta meta.dfId/ordId fara sa detina formulare_X.flow_id)
   trecea de garda #114 si primea un copil cu acelasi meta, ocolind poarta de
   lansare #170. reinitiate era ultima cale prin care un document mai putea
   primi al doilea flux viu. Cheia gardii devine data.meta (aceeasi cu #170),
   pointerul ramane a doua conditie pentru fluxurile vechi fara meta.
   Fluxurile fara DF/ORD nu sunt afectate (caz de test dedicat).
   ```
4. `git push origin develop`

---

## RAPORT FINAL — obligatoriu

1. Ancorele din Etapa 0: valorile OBȚINUTE, nu cele așteptate.
2. Etapa A: rezultatul porții „ZERO consumatori" și al testului unitar.
3. Etapa B: rezultatul fiecăruia dintre cele 6 cazuri, cu accent pe **cazul 3** (fluxul
   obișnuit se reinițiază în continuare) — dacă a picat, ce ai schimbat.
4. Etapa C: a trecut `flux-poarta-lansare.test.mjs` nemodificat? Dacă nu, ai revenit?
5. Numerele reale de la `npm test` și `npm run test:db` (fișiere / teste / eșecuri), plus
   dacă `test:db` a rulat REAL pe PostgreSQL sau a fost sărit.
6. Orice test PREEXISTENT pe care a trebuit să-l atingi — care, de ce, și de ce nu e o
   slăbire a asertiunii.
7. Orice loc unde promptul meu NU s-a potrivit cu codul real. Nu „repara" tăcut divergența:
   raporteaz-o.
8. Constatări colaterale (lucruri văzute în trecere care par greșite) — **doar consemnate,
   NU reparate în acest lot**.

---

## ⛔ CONSTRÂNGERI ABSOLUTE

- `develop` ONLY. `main` nu se atinge sub nicio formă.
- Zero migrații, zero indici, zero fișiere `.sql` noi.
- Zero fișiere din `public/`.
- Zona NO-TOUCH neatinsă (`STSCloudProvider.mjs`, `routes/flows/cloud-signing.mjs`,
  `routes/flows/bulk-signing.mjs`, `signing/pades.mjs`, `signing/java-pades-client.mjs`).
- `git add` explicit pe căile sarcinii. **Niciodată `git add -A`** (rădăcina are fișiere
  netracked din sesiuni vechi).
- Dacă un `old_str` nu se potrivește exact: **OPREȘTE-TE și raportează**. Nu căuta un anchor
  „echivalent".
