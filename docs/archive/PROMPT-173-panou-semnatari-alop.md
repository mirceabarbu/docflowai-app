---
prompt: 173
titlu: "Panoul de configurare a semnatarilor impliciți DF/ORD (Setări instituție)"
model_suggested: "Opus 5, efort high"
branch: develop
versiune_curenta: v3.9.827
versiune_tinta: v3.9.828
migratii: NU
fisiere_din_public: DA  (⇒ bump `?v=` ȚINTIT; CACHE_VERSION — vezi Etapa 0)
zona_no_touch_atinsa: NU
---

# ⚠️ BRANCH

Lucrezi **EXCLUSIV pe `develop`**. `main` = PRODUCȚIE, gestionat manual de Mircea.
Pasul final obligatoriu: `git push origin develop`.

---

## Context

`alop_sabloane` e **gol în producție**. Consecință: fiecare dosar ALOP nou se creează din
`DF_DEFAULT_SEMNATARI` (6 roluri) / `ORD_DEFAULT_SEMNATARI` (4 roluri), toate cu `user_id: null`,
iar `alop.mjs:557` ștampilează `user_id` doar pe rândul `initiator`. Rutele de configurare
EXISTĂ (`GET`/`POST /api/alop/sablon`), dar **niciun ecran nu le apelează** — au rămas fără UI
după ce butonul `alop-btn-sablon` a fost scos (funcția `_updateAlopSablonBtnVisibility` din
`public/js/formular/alop.js:128` caută un buton care nu mai există în niciun `.html`).

Efectul lanțului, după #172/#172b: prefill-ul aduce corect setul complet de roluri în tabelul
de semnatari, dar **fără persoane**, fiindcă nu există unde să fie configurate.

## Deciziile de produs (Mircea, 03.09.2026)

1. **Locul: „Setări" (`public/setari.html`)**, nu Organizații — șablonul e o setare de
   INSTITUȚIE, iar `POST /api/alop/sablon` e deja deschis pentru `org_admin`. Organizații e
   pagina de super-admin peste toate primăriile; dacă apare a doua primărie, `org_admin`-ul ei
   trebuie să-și poată configura singur semnatarii.
2. **Număr variabil de roluri** — 5 în loc de 6, 3 în loc de 4, orice combinație. Validarea
   de lungime fixă dispare.
3. **Rol cu etichetă liberă permis** — dar cu **atributul ales EXPLICIT** din lista de atribute.
   ⛔ Fără `SEMNAT` implicit: un rol nou fără atribut corespondent ar ajunge pe o ordonanțare de
   plată cu atributul „SEMNAT", cu persoana corectă și fără nicio eroare nicăieri.

---

## Fapte VERIFICATE pe cod — nu le redescoperi

- `GET /api/alop/sablon` (`alop.mjs:224-243`) întoarce pe gol
  `{signatari_angajare:[], signatari_lichidare:[], signatari_ordonantare:[], signatari_plata:[]}`
  — chei **LEGACY**, fără nicio legătură cu ce așteaptă POST-ul (`df_semnatari_sablon`,
  `ord_semnatari_sablon`, `lichidare_sablon`). Un ecran construit naiv pe răspunsul GET ar afișa
  gol și ar salva greșit. **Se corectează în Etapa A.**
- `POST /api/alop/sablon` (`alop.mjs:245-285`) e deja `admin`/`org_admin` + `_csrf`. Autorizarea
  NU se atinge.
- **Niciun consumator al lui `GET /api/alop/sablon` în `public/`** (verificat prin grep) ⇒
  schimbarea formei de gol nu poate rupe niciun ecran existent.
- `alop.mjs:557-562` ștampilează `user_id` pe `initiator` și pe `sef_compartiment` cu
  `same_as_initiator`. Funcționează pentru orice lungime a listei — **nu există nicăieri acces
  pozițional** la `df_semnatari[i]`, nici pe server, nici în frontend. Totul caută după `role`.
- Roluri **PORTANTE**, de protejat prin validare:
  - `initiator` — primește `user_id` la creare; `sef_compartiment.same_as_initiator` îl referă.
  - `responsabil_cab` — alimentează autorizarea P2 în trei locuri
    (`authz-formular.mjs:142`, `alop.mjs:329`, `alop.mjs:726`). Are alternativa pe `assigned_to`,
    deci scoaterea lui nu pierde acces — dar e o alegere, nu un accident.
- Lista de atribute trăiește azi DOAR în frontend: `public/js/shared/atribute.js`
  (`window.DFAtribute.LIST`, #168). Serverul nu o are ⇒ Etapa A îi dă o pereche, cu test de
  paritate între cele două (același tipar ca testul 3 de la #172).
- `public/setari.html` are deja tiparul de secțiune cu vizibilitate controlată din JS după
  `/auth/me` (`ent-section` + `js/setari/entitlements.js:48`, `u.role === 'admin'`).

---

## ⛔ Ce NU se atinge

- **NU** modifica `DF_DEFAULT_SEMNATARI` / `ORD_DEFAULT_SEMNATARI` (conținut sau poziție) —
  sunt folosite și de fallback-ul de la creare, și de `DEFAULT`-ul migrației `db/index.mjs:1068`.
- **NU** atinge autorizarea rutelor și nici `csrfMiddleware`.
- **NU** atinge `alop.mjs:557-562` (ștampilarea `user_id`).
- **NU** atinge `authz-formular.mjs`, `alop.mjs:329`, `alop.mjs:726`.
- **NU** atinge `_updateAlopSablonBtnVisibility` și nici `alop.js:787`. Curățarea codului mort
  e alt lot.
- **NU** atinge `public/js/semdoc-initiator/main.js` — #172/#172b sunt corecte acolo.
- **NU** aduce PERSOANA din șablon în tabelul de semnatari în acest lot. Vezi Etapa E.
- Zero migrații.

---

## ETAPA 0 — ancore (READ-ONLY)

```bash
cd "$(git rev-parse --show-toplevel)"
git branch --show-current                                   # Așteptat: develop
node -e "console.log(require('./package.json').version)"     # Așteptat: 3.9.827

grep -n "signatari_angajare" server/routes/alop.mjs          # Așteptat: 1 linie (forma de gol)
grep -rn "api/alop/sablon" public/                           # Așteptat: 0 linii (niciun consumator)
grep -n "df_semnatari_sablon trebuie" server/routes/alop.mjs # Așteptat: 1 linie
grep -n "formular/alop.js?v=" public/*.html                  # notează valoarea CURENTĂ
grep -n "js/formular/alop.js\|js/setari/" public/sw.js       # Așteptat: 0 ⇒ CACHE_VERSION neatins
ls server/services/alop-roluri.mjs 2>/dev/null               # Așteptat: „No such file"
```

Dacă vreo ancoră nu se potrivește, **OPREȘTE-TE** și raportează.

---

## ETAPA A — vocabularul ca sursă unică (modul PUR, ZERO consumatori)

Creează `server/services/alop-roluri.mjs`:

```js
/**
 * DocFlowAI — alop-roluri.mjs  (#173)
 * -------------------------------------------------------------------------
 * VOCABULARUL rolurilor din șablonul de semnatari al unui dosar ALOP —
 * sursă unică pentru cheie, etichetă și atributul de semnătură.
 *
 * De ce există: aceleași roluri erau scrise de mână în PATRU locuri —
 * `ROLE_LABEL` (public/js/formular/alop.js), `ALOP_ROL` (același fișier),
 * `DF_DEFAULT_SEMNATARI`/`ORD_DEFAULT_SEMNATARI` (routes/alop.mjs) și validarea
 * din POST /api/alop/sablon. Ecranul de configurare ar fi fost al cincilea.
 * Un rol adăugat într-un loc și uitat în celălalt ajunge pe document cu
 * atributul greșit, fără nicio eroare.
 *
 * ⛔ Modul PUR: zero DB, zero I/O, zero import din rute.
 * ⛔ `atribut` trebuie să existe în lista de atribute (services/atribute.mjs).
 *    Un rol fără atribut valid ar semna un document financiar cu „SEMNAT".
 */

export const ALOP_ROLURI = Object.freeze({
  initiator:         Object.freeze({ eticheta: 'Inițiator',              atribut: 'ÎNTOCMIT' }),
  sef_compartiment:  Object.freeze({ eticheta: 'Șef compartiment',       atribut: 'VIZAT' }),
  responsabil_cab:   Object.freeze({ eticheta: 'Responsabil CAB',        atribut: 'VERIFICAT' }),
  sef_cab:           Object.freeze({ eticheta: 'Șef compartiment CAB',   atribut: 'VIZAT' }),
  director_economic: Object.freeze({ eticheta: 'Director Economic',      atribut: 'VIZĂ ECONOMICĂ' }),
  ordonator_credite: Object.freeze({ eticheta: 'Ordonator de credite',   atribut: 'APROBAT' }),
  cfp_propriu:       Object.freeze({ eticheta: 'CFP Propriu',            atribut: 'VIZĂ CFPP' }),
});

/** Roluri fără de care mecanica dosarului se rupe — nu pot lipsi din șablon. */
export const ROLURI_OBLIGATORII = Object.freeze(['initiator']);

export const MAX_ROLURI_SABLON = 12;

export function esteRolCunoscut(role) {
  return typeof role === 'string' && Object.prototype.hasOwnProperty.call(ALOP_ROLURI, role);
}

export function atributImplicit(role) {
  return esteRolCunoscut(role) ? ALOP_ROLURI[role].atribut : null;
}
```

Creează `server/services/atribute.mjs` — perechea pe server a lui `public/js/shared/atribute.js`:

```js
/**
 * DocFlowAI — atribute.mjs  (#173)
 * -------------------------------------------------------------------------
 * Lista de ATRIBUTE de semnătură, pereche pe SERVER a lui
 * `public/js/shared/atribute.js` (window.DFAtribute, #168). Serverul are nevoie
 * de ea ca să valideze atributul ales pentru un rol cu etichetă liberă.
 *
 * ⛔ Cele două liste trebuie să rămână IDENTICE. Un test de paritate
 *    (`server/tests/unit/atribute-paritate.test.mjs`) parsează fișierul din
 *    `public/` și cade dacă diverg. NU „repara" divergența schimbând doar una.
 * ⛔ `__alt__` e santinela pentru „Alt atribut…", NU un atribut — de aceea
 *    `esteAtributValid` o respinge.
 */

export const ATRIBUTE = Object.freeze([
  'ÎNTOCMIT', 'VERIFICAT', 'VIZAT', 'AVIZAT', 'APROBAT',
  'VIZĂ CFPP', 'VIZĂ JURIDICĂ', 'VIZĂ TEHNICĂ', 'VIZĂ ECONOMICĂ',
  'CONTROLAT', 'CERTIFICAT', 'CONTRASEMNAT', 'ÎNSUȘIT', 'ASUMAT',
  'SEMNAT', 'LUAT LA CUNOȘTINȚĂ',
  'ÎNREGISTRAT', 'ÎNREGISTRAT CAB', 'CONFIRMAT',
]);

export function esteAtributValid(v) {
  return typeof v === 'string' && ATRIBUTE.includes(v.trim());
}
```

⚠️ Copiază lista **exact** din `public/js/shared/atribute.js`, fără `__alt__`. Dacă ordinea sau
conținutul diferă de ce ai scris mai sus, **sursa e fișierul din `public/`** — raportează
diferența, nu o rezolva după prompt.

### Test de Etapă A

`server/tests/unit/alop-roluri.test.mjs` + `server/tests/unit/atribute-paritate.test.mjs`:

1. Fiecare `atribut` din `ALOP_ROLURI` e valid după `esteAtributValid`.
2. Fiecare `role` din `DF_DEFAULT_SEMNATARI` și `ORD_DEFAULT_SEMNATARI` (parsate din
   `server/routes/alop.mjs`) e cunoscut de `ALOP_ROLURI`.
3. ⭐ **Paritate**: lista parsată din `public/js/shared/atribute.js`, minus `__alt__`, e
   IDENTICĂ (conținut și ordine) cu `ATRIBUTE`.
4. ⭐ Paritate cu frontendul ALOP: perechile din `ALOP_ROL` (`public/js/formular/alop.js`)
   coincid cu `atribut`-ul din `ALOP_ROLURI` pentru fiecare rol, iar `ROLE_LABEL` coincide cu
   `eticheta`. Testul cade dacă cineva schimbă doar una dintre copii.
5. `esteAtributValid('__alt__')` e `false`.
6. `ALOP_ROLURI` e înghețat.

**Poartă de Etapă A:** cele două module rămân neimportate de cod de producție.

```bash
grep -rn "alop-roluri.mjs\|services/atribute.mjs" server --include=*.mjs | grep -v "server/tests/" | grep -v "server/services/alop-roluri.mjs" | grep -v "server/services/atribute.mjs"
# Așteptat: 0 linii
npx vitest run server/tests/unit/alop-roluri.test.mjs server/tests/unit/atribute-paritate.test.mjs
```

---

## ETAPA B — validarea nouă + forma de gol corectă (`server/routes/alop.mjs`)

### B.1 — import

`old_str`
```js
import { loadActorCompAndCab, isCabDept, canEditAlop, canDestroyOnly, loadOrgCabComp } from '../services/authz-formular.mjs';
```

`new_str`
```js
import { loadActorCompAndCab, isCabDept, canEditAlop, canDestroyOnly, loadOrgCabComp } from '../services/authz-formular.mjs';
import { ALOP_ROLURI, ROLURI_OBLIGATORII, MAX_ROLURI_SABLON, esteRolCunoscut } from '../services/alop-roluri.mjs';
import { esteAtributValid } from '../services/atribute.mjs';
```

### B.2 — validatorul (funcție nouă, imediat după `ORD_DEFAULT_SEMNATARI`)

`old_str`
```js
const ORD_DEFAULT_SEMNATARI = [
  { order: 1, role: 'initiator',          user_id: null, name: '' },
  { order: 2, role: 'responsabil_cab',    user_id: null, name: '' },
  { order: 3, role: 'cfp_propriu',        user_id: null, name: '' },
  { order: 4, role: 'ordonator_credite',  user_id: null, name: '' },
];
```

`new_str`
```js
const ORD_DEFAULT_SEMNATARI = [
  { order: 1, role: 'initiator',          user_id: null, name: '' },
  { order: 2, role: 'responsabil_cab',    user_id: null, name: '' },
  { order: 3, role: 'cfp_propriu',        user_id: null, name: '' },
  { order: 4, role: 'ordonator_credite',  user_id: null, name: '' },
];

// #173 — validarea șablonului. A ÎNLOCUIT verificarea de LUNGIME FIXĂ (6 la DF, 4 la ORD),
// care apăra o formă, nu o regulă: nu există nicăieri acces pozițional la `df_semnatari[i]`,
// totul caută după `role`. Ce apărăm de fapt:
//   - `initiator` obligatoriu: primește `user_id` la crearea dosarului (vezi mai jos), iar
//     `sef_compartiment.same_as_initiator` îl referă;
//   - roluri unice: două rânduri cu același rol ar face ambiguă orice căutare după `role`;
//   - rol necunoscut ⇒ `atribut` OBLIGATORIU și valid. Fără asta, un rol cu etichetă liberă
//     ar ajunge pe o ordonanțare de plată cu atributul „SEMNAT", cu persoana corectă și fără
//     nicio eroare nicăieri.
// Întoarce `null` dacă e valid, altfel un mesaj pentru client.
function _validSablonSemnatari(lista, eticheta) {
  if (!Array.isArray(lista) || lista.length < 1) {
    return `${eticheta}: lista de roluri e obligatorie (minim 1 rol).`;
  }
  if (lista.length > MAX_ROLURI_SABLON) {
    return `${eticheta}: maximum ${MAX_ROLURI_SABLON} roluri.`;
  }
  const vazute = new Set();
  for (const s of lista) {
    if (!s || typeof s !== 'object' || Array.isArray(s)) {
      return `${eticheta}: fiecare rol trebuie să fie un obiect.`;
    }
    const role = typeof s.role === 'string' ? s.role.trim() : '';
    if (!role) return `${eticheta}: fiecare rol trebuie să aibă cheia "role".`;
    if (role.length > 64) return `${eticheta}: cheia rolului e prea lungă (max 64).`;
    if (vazute.has(role)) return `${eticheta}: rolul "${role}" apare de două ori.`;
    vazute.add(role);
    if (!esteRolCunoscut(role)) {
      if (!esteAtributValid(s.atribut)) {
        return `${eticheta}: rolul "${role}" e personalizat și cere un atribut de semnătură valid.`;
      }
      if (typeof s.eticheta !== 'string' || !s.eticheta.trim()) {
        return `${eticheta}: rolul "${role}" e personalizat și cere o denumire.`;
      }
      if (s.eticheta.length > 120) return `${eticheta}: denumirea rolului "${role}" e prea lungă.`;
    } else if (s.atribut !== undefined && !esteAtributValid(s.atribut)) {
      return `${eticheta}: atributul ales pentru "${role}" nu e valid.`;
    }
  }
  for (const oblig of ROLURI_OBLIGATORII) {
    if (!vazute.has(oblig)) {
      return `${eticheta}: rolul "${ALOP_ROLURI[oblig].eticheta}" nu poate lipsi din șablon.`;
    }
  }
  return null;
}
```

### B.3 — forma de gol de la GET

`old_str`
```js
    const defaultSablon = {
      signatari_angajare:    [],
      signatari_lichidare:   [],
      signatari_ordonantare: [],
      signatari_plata:       [],
    };
```

`new_str`
```js
    // #173 — forma de gol OGLINDEȘTE ce așteaptă POST-ul. Înainte întorcea chei LEGACY
    // (`signatari_angajare` etc.), fără nicio legătură cu `df_semnatari_sablon`, deci un
    // ecran construit pe răspunsul GET ar fi afișat gol și ar fi salvat greșit. Nu exista
    // niciun consumator în `public/` (verificat), deci schimbarea nu rupe nimic.
    const defaultSablon = {
      df_semnatari_sablon:  DF_DEFAULT_SEMNATARI,
      ord_semnatari_sablon: ORD_DEFAULT_SEMNATARI,
      lichidare_sablon:     {},
    };
```

### B.4 — validarea de lungime înlocuită

`old_str`
```js
    if (!Array.isArray(df_semnatari_sablon) || df_semnatari_sablon.length !== 6) {
      return res.status(400).json({ error: 'df_semnatari_sablon trebuie să conțină 6 roluri' });
    }
    if (!Array.isArray(ord_semnatari_sablon) || ord_semnatari_sablon.length !== 4) {
      return res.status(400).json({ error: 'ord_semnatari_sablon trebuie să conțină 4 roluri' });
    }
```

`new_str`
```js
    const _errDf = _validSablonSemnatari(df_semnatari_sablon, 'Document de Fundamentare');
    if (_errDf) return res.status(400).json({ error: 'sablon_invalid', message: _errDf });
    const _errOrd = _validSablonSemnatari(ord_semnatari_sablon, 'Ordonanțare de plată');
    if (_errOrd) return res.status(400).json({ error: 'sablon_invalid', message: _errOrd });
```

### Teste de Etapă B — `server/tests/db/alop-sablon-validare.test.mjs`

1. ⭐ 5 roluri la DF (fără `sef_cab`) ⇒ **200**, salvat. (Regula veche dădea 400.)
2. ⭐ 3 roluri la ORD ⇒ 200.
3. Fără `initiator` ⇒ 400 `sablon_invalid`, mesajul conține „Inițiator".
4. Două rânduri cu același `role` ⇒ 400.
5. Rol necunoscut FĂRĂ `atribut` ⇒ 400. Cu `atribut: 'SEMNAT'` invalid ca formă (ex. `'XYZ'`)
   ⇒ 400. Cu `atribut: 'AVIZAT'` + `eticheta` ⇒ 200.
6. Listă goală ⇒ 400; peste `MAX_ROLURI_SABLON` ⇒ 400.
7. Autorizare NESCHIMBATĂ: utilizator simplu ⇒ 403 (nu 400) — garda rămâne înaintea validării.
8. ⭐ `GET /api/alop/sablon` pe o organizație FĂRĂ rând în `alop_sabloane` întoarce
   `df_semnatari_sablon` cu 6 elemente și `ord_semnatari_sablon` cu 4, NU cheile legacy.
9. Round-trip: `POST` cu 5 roluri, apoi `GET` întoarce exact ce s-a salvat.

---

## ETAPA C — ecranul (`public/setari.html` + `public/js/setari/alop-semnatari.js`)

Secțiune nouă în `setari.html`, plasată **între** cardul „Concediu și delegare" și
`#ent-section`, cu `id="alop-sem-section"` și `style="display:none;"` — vizibilitatea o dă JS-ul
după `/auth/me`, pe tiparul din `js/setari/entitlements.js:48`, dar cu condiția
**`role === 'admin' || role === 'org_admin'`** (nu doar `admin`), fiindcă ruta acceptă ambele.

Scriptul nou `public/js/setari/alop-semnatari.js`, script CLASIC în IIFE cu `'use strict'`, pe
modelul `public/js/shared/pagin.js`. În `setari.html` se adaugă DOUĂ tag-uri, în ordinea asta:

```html
  <script src="/js/shared/atribute.js?v=3.9.828"></script>
  <script src="/js/setari/alop-semnatari.js?v=3.9.828" defer></script>
```

⚠️ `shared/atribute.js` **fără `defer`** (expune `window.DFAtribute` sincron), scriptul nou
**cu `defer`** — exact capcana tratată la #168 în `templates.html`.

Comportamentul ecranului:

- două tabele, „Semnatari impliciți — Document de Fundamentare" și „… — Ordonanțare de plată";
- fiecare rând: **Rol** (select cu cele 7 roluri + „Rol personalizat…"), **Atribut** (select din
  `DFAtribute.buildOptions()`, fără `__alt__`), **Persoană** (select din `/users`, opțional),
  buton „Șterge";
- la rol cunoscut, Atributul se pre-selectează din vocabular și rămâne editabil;
- la „Rol personalizat…" apar două câmpuri text — cheia (slug) și denumirea — iar Atributul
  devine **obligatoriu** (butonul Salvează dezactivat până e ales), oglindind validarea B.2;
- „Adaugă rând", reordonare prin drag & drop NU e necesară în acest lot — `order` se recalculează
  din poziția în tabel la salvare;
- Salvează ⇒ `POST /api/alop/sablon` cu `df_semnatari_sablon`, `ord_semnatari_sablon` **și**
  `lichidare_sablon` citit din GET și retrimis NESCHIMBAT.

⚠️ **`lichidare_sablon` face parte din același upsert.** Dacă ecranul salvează fără el, îl
ȘTERGE — iar `alop.mjs:568` îl folosește pentru `lichidare_confirmed_by` la crearea dosarului.
Se citește la încărcare și se retrimite ca atare.

⚠️ CSRF: folosește `_apiFetch` (shim-ul e deja încărcat în `setari.html`) sau `window.df.getCsrf`,
ca restul ecranelor. Ruta are `csrfMiddleware`.

### Teste de Etapă C — `server/tests/unit/setari-alop-semnatari.test.mjs` (analiză statică)

⚠️ Filtrează liniile de comentariu înainte de aserțiuni (lecția de la #124i, #172, #172b).

1. `setari.html` încarcă `shared/atribute.js` **fără** `defer` și `setari/alop-semnatari.js`
   **cu** `defer`, iar `atribute.js` apare ÎNAINTE.
2. Gate-ul de vizibilitate din `alop-semnatari.js` acceptă `admin` **și** `org_admin`.
3. Payload-ul de salvare conține `lichidare_sablon` — nu poate fi omis tăcut.
4. Scriptul nu conține `__alt__` în lista de atribute oferite (santinela nu e un atribut).

---

## ETAPA D — prefill-ul respectă atributul configurat (`public/js/formular/alop.js`)

Un rol personalizat n-are intrare în `ALOP_ROL` ⇒ ar ajunge pe document cu `SEMNAT`.

`old_str`
```js
            rol:ALOP_ROL[s.role]||'SEMNAT',
```

`new_str`
```js
            // #173 — atributul salvat pe rol are precădere: un rol PERSONALIZAT nu are
            // intrare în ALOP_ROL și ar cădea altfel pe „SEMNAT" pe un document financiar.
            rol:(s.atribut||ALOP_ROL[s.role]||'SEMNAT'),
```

Caz de test adăugat în `server/tests/unit/prefill-alop-roluri.test.mjs`? **NU** — acel fișier
rămâne neatins. Pune cazul în `setari-alop-semnatari.test.mjs`: `alop.js` conține
`s.atribut||ALOP_ROL[s.role]`.

---

## ETAPA E — de NOTAT, nu de implementat

Scrie în raport (și doar acolo): aducerea PERSOANEI din șablon în tabelul de semnatari **nu
funcționează încă** și nu e sarcina acestui lot. Motivul, verificat pe cod: `refreshAllDropdowns`
(`semdoc-initiator/main.js:507-529`) restaurează selecția după **email**, iar șablonul ține
`user_id` + `name`. Un rând de prefill are în `.name-select` doar opțiunea placeholder la creare,
deci `sel.value = s.name` nu prinde. Rezolvarea cere `user_id → email` din `window._dbUsers` și
selecție după email — lot separat.

---

## ETAPA F — verificări, versiune, commit

```bash
node --check server/services/alop-roluri.mjs
node --check server/services/atribute.mjs
node --check server/routes/alop.mjs
node --check public/js/setari/alop-semnatari.js
node --check public/js/formular/alop.js

grep -c "df_semnatari_sablon.length !== 6" server/routes/alop.mjs   # Așteptat: 0
grep -c "signatari_angajare" server/routes/alop.mjs                 # Așteptat: 0

npm test
npm run test:db
git status --short
```

1. `package.json`: `3.9.827` → `3.9.828`.
2. `CACHE_VERSION` **neatins** (confirmat în Etapa 0).
3. Bump `?v=` ȚINTIT — `formular/alop.js` (valoarea veche CITITĂ în Etapa 0) și cele două
   scripturi noi din `setari.html`, scrise direct la `3.9.828`:

```bash
NEW=3.9.828
sed -i -E "s#(js/formular/alop\.js\?v=)[0-9.]+#\1$NEW#g" public/*.html
grep -n "formular/alop.js?v=\|setari/alop-semnatari.js?v=\|shared/atribute.js?v=" public/*.html
grep -c "<script" public/setari.html public/formular.html
```

⛔ `\1`, nu `\g<1>`. ⛔ Fără bulk-sed.

4. `git add` explicit pe căile sarcinii. **Niciodată `git add -A`.**
5. Commit:
   ```
   feat(#173): panou de configurare a semnatarilor impliciti DF/ORD — v3.9.828

   alop_sabloane era gol si fara ecran: rutele existau, dar butonul care le
   chema fusese scos. Ecran nou in Setari (admin + org_admin, ca ruta).
   Validarea de lungime fixa (6/4) inlocuita cu reguli reale: roluri unice,
   initiator obligatoriu, rol personalizat doar cu atribut valid ales
   explicit. Vocabularul rolurilor si lista de atribute devin surse unice pe
   server, cu teste de paritate fata de copiile din public/.
   ```
6. `git push origin develop`

---

## RAPORT FINAL — obligatoriu

1. Ancorele din Etapa 0, cu valorile OBȚINUTE (inclusiv `?v=` vechi pentru `formular/alop.js`).
2. Etapa A: rezultatul porții „ZERO consumatori"; dacă lista din `atribute.mjs` a diferit de
   `public/js/shared/atribute.js`, CARE era diferența.
3. Etapa B: rezultatul fiecărui caz, cu accent pe 1, 2 și 8.
4. Etapa C: cum ai gardat vizibilitatea și cum ai gestionat `lichidare_sablon`.
5. Numerele reale `npm test` / `npm run test:db`; dacă `test:db` a rulat REAL.
6. Ieșirea `grep` de după `sed` — integritatea liniilor `<script>`.
7. Teste preexistente atinse: care, de ce, de ce nu e o slăbire. (Așteptat: NICIUNUL.)
8. Divergențe prompt↔cod — raportate, NU reparate tăcut.
9. Nota din Etapa E, reprodusă.

---

## ⛔ CONSTRÂNGERI ABSOLUTE

- `develop` ONLY. Zero migrații. `CACHE_VERSION` neatins.
- Autorizarea rutelor NESCHIMBATĂ.
- `DF_DEFAULT_SEMNATARI` / `ORD_DEFAULT_SEMNATARI` NEATINSE.
- `prefill-alop-roluri.test.mjs` și `prefill-alop-cursa.test.mjs` NEMODIFICATE.
- `git add` explicit.
- `old_str` care nu se potrivește exact ⇒ **OPREȘTE-TE și raportează**.
