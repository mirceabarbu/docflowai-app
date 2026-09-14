---
prompt: 179
titlu: "Vocabularul de audit al documentului pe sursă unică (server + client) + cele trei etichete lipsă"
model_suggested: "Opus 5, efort high"
branch: develop
versiune_curenta: v3.9.833
versiune_tinta: v3.9.834
migratii: NU
fisiere_din_public: DA  (⇒ bump `?v=` ȚINTIT; CACHE_VERSION — vezi Etapa 0)
zona_no_touch_atinsa: NU
---

# ⚠️ BRANCH

Lucrezi **EXCLUSIV pe `develop`**. `main` = PRODUCȚIE, gestionat manual de Mircea.
Pasul final obligatoriu: `git push origin develop`.

---

## Context — bug VĂZUT în producție (04.09.2026)

În modalul „Audit document" al unui DF apare rândul brut **`FLOW_ADMIN_CANCELLED`**, în loc de o
denumire în română. Linia care îl produce e `doc.js:2156`:

```js
const lbl=_AUDIT_LABELS[e.event_type]||e.event_type;
```

### Enumerare COMPLETĂ (verificată pe cod, fereastră de 12 linii pe `recordFormularAudit`)

În jurnalul documentului intră **10** tipuri de evenimente:

`creat`, `trimis_p2`, `completat`, `legat_alop`, `returnat`, `transmis_flux`, `revizuit`,
`sters`, `flux_refuzat`, `neaprobat`, `FLOW_ADMIN_CANCELLED`

⚠️ (Sunt 11 nume, dar `neaprobat` și `flux_refuzat` sunt scrise din `signing.mjs`, iar
`FLOW_ADMIN_CANCELLED` din `lifecycle.mjs` — verifică tu lista finală în Etapa 0 și
raportează dacă diferă de a mea.)

### Aceeași noțiune, PATRU vocabulare — cu aceleași trei goluri în cele două care contează

| vocabular | consumator | acoperire |
|---|---|---|
| `_AUDIT_LABELS` (`public/js/formular/doc.js:2125`) | modalul văzut de utilizatori | **7/10** |
| `FORMULAR_AUDIT_LABELS` (`server/routes/formulare/shared.mjs:872`) | **exportul CSV și PDF** | **7/10** |
| `EVENT_LABELS` (`public/js/admin/audit.js:22`) | ecranul de audit admin | complet |
| `EVENT_LABELS` (`public/js/admin/activity.js:25`) | activitate admin | complet |

Lipsesc, identic în primele două: **`FLOW_ADMIN_CANCELLED`, `flux_refuzat`, `neaprobat`**.

Gravitatea reală nu e modalul, ci `FORMULAR_AUDIT_LABELS`: el alimentează **documentul de audit
exportat în CSV și PDF** pentru o instituție publică. Trei tipuri de evenimente apar acolo cu
identificator tehnic — inclusiv anularea administrativă a unui flux finalizat, exact evenimentul
pe care un control l-ar căuta.

## Deciziile lui Mircea (04.09.2026) — formulările finale

| eveniment | etichetă |
|---|---|
| `FLOW_ADMIN_CANCELLED` | **Flux finalizat anulat administrativ** |
| `flux_refuzat` | **Flux refuzat** |
| `neaprobat` | **Neaprobat** |

⚠️ Două dintre ele **schimbă și textul din ecranele de admin**, unde azi scrie „Flux finalizat
**desfăcut** administrativ" și „Neaprobat **de semnatar**". E intenționat: sursă unică înseamnă
formulare unică. Consemnează în raport că ai făcut schimbarea.

> Se adaugă **o singură sursă**, folosită de server și de client. NU se adaugă trei linii în
> patru fișiere — exact asta a produs situația: patru copii, fiecare corectă în ziua ei.

---

## Fapte VERIFICATE pe codul v3.9.833

- `FORMULAR_AUDIT_LABELS` folosește **MAJUSCULE** (`'TRIMIS LA RESPONSABIL CAB'`), iar
  `_AUDIT_LABELS` forma normală (`'Trimis la Responsabil CAB'`). Pentru toate cele 7 chei comune,
  varianta de server e **exact** `.toUpperCase()` a celei de client (verificat cheie cu cheie,
  inclusiv diacriticele: `Șters`→`ȘTERS`, `Transmis în flux`→`TRANSMIS ÎN FLUX`). ⇒ sursa unică
  ține forma normală, iar serverul aplică `.toUpperCase()`. Exportul rămâne **byte-identic**.
- `public/admin.html:1623` încarcă deja `shared/pagin.js` cu `defer`, înaintea lui
  `admin/audit.js` (`:1627`) și `admin/activity.js` (`:1628`) ⇒ e locul unde se inserează
  scriptul nou.
- `public/formular.html:1522` încarcă `shared/alop-roluri.js` **fără `defer`**, iar `doc.js` la
  `:1531` cu `defer`.
- `trimis_p2` **NU e cheie moartă** — se scrie la `formular-shared.mjs:494` și `:522`.
  (Nota mea anterioară era greșită, dintr-un grep cu fereastră prea îngustă.)
- `EVENT_LABELS` din cele două fișiere de admin sunt **supermulțimi** — conțin și `FLOW_*`,
  `YOUR_TURN`, `DELEGATE` etc., care NU apar în jurnalul documentului. Sursa unică acoperă
  **doar** vocabularul documentului; restul rămâne local.

---

## ⛔ Ce NU se atinge

- **NU** modifica ruta `GET /api/formulare-audit/:type/:id` în afara hărții de etichete.
- **NU** atinge `recordFormularAudit` sau vreun loc care SCRIE evenimente.
- **NU** atinge hărțile de culori/emoji din `admin/activity.js` (`:102`, `:116`) și
  `admin/audit.js` (`:332`) — sunt alt vocabular, legitim separat.
- **NU** muta chei din `EVENT_LABELS` care nu sunt în lista celor 10.
- Zero migrații.

---

## ETAPA 0 — ancore (READ-ONLY)

```bash
cd "$(git rev-parse --show-toplevel)"
git branch --show-current                                   # Așteptat: develop
node -e "console.log(require('./package.json').version)"     # Așteptat: 3.9.833

# ⭐ Enumerarea INDEPENDENTĂ a evenimentelor — nu te baza pe lista mea:
grep -rn -A12 "recordFormularAudit({" server/ --include=*.mjs \
  | grep -v "server/tests" | grep -oE "eventType: *'[A-Za-z_]+'" | sort -u
# Raportează lista OBȚINUTĂ. Dacă diferă de cele 10 din prompt, OPREȘTE-TE.

grep -c "_AUDIT_LABELS" public/js/formular/doc.js            # Așteptat: 2
grep -n "FORMULAR_AUDIT_LABELS" server/routes/formulare/shared.mjs
grep -n "formular/doc.js?v=\|admin/audit.js?v=\|admin/activity.js?v=" public/*.html
grep -n "js/formular/doc.js\|js/admin/\|js/shared/" public/sw.js   # Așteptat: 0
ls public/js/shared/audit-labels.js 2>/dev/null              # Așteptat: „No such file"
```

---

## ETAPA A — sursa unică, în două exemplare care se verifică reciproc

### A.1 — server: `server/services/audit-labels.mjs`

```js
/**
 * DocFlowAI — audit-labels.mjs  (#179)
 * -------------------------------------------------------------------------
 * VOCABULARUL evenimentelor din jurnalul unui formular (DF/ORD) — sursă unică.
 *
 * De ce există: aceleași etichete erau scrise în PATRU locuri, iar cele două
 * care ajung la utilizator (modalul din doc.js și exportul CSV/PDF din
 * routes/formulare/shared.mjs) rataseră amândouă exact aceleași trei
 * evenimente ⇒ în documentul de audit al unei instituții publice apăreau
 * identificatori tehnici în loc de denumiri.
 *
 * ⛔ Perechea din client e `public/js/shared/audit-labels.js`. Un test de
 *    paritate le compară și cade dacă diverg — NU repara divergența
 *    schimbând doar una.
 * ⛔ Exportul CSV/PDF folosea MAJUSCULE. Se păstrează prin `.toUpperCase()`
 *    aplicat aici, nu prin a doua listă.
 */

export const AUDIT_LABELS = Object.freeze({
  creat:                 'Creat',
  trimis_p2:             'Trimis la Responsabil CAB',
  completat:             'Completat de Responsabil CAB',
  legat_alop:            'Legat de ALOP',
  returnat:              'Returnat',
  transmis_flux:         'Transmis în flux',
  revizuit:              'Revizuit',
  sters:                 'Șters',
  flux_refuzat:          'Flux refuzat',
  neaprobat:             'Neaprobat',
  FLOW_ADMIN_CANCELLED:  'Flux finalizat anulat administrativ',
});

/** Eticheta unui eveniment; `upper` pentru CSV/PDF. Necunoscutele se întorc ca atare. */
export function etichetaAudit(eventType, { upper = false } = {}) {
  const raw = AUDIT_LABELS[eventType] || String(eventType || '');
  return upper ? raw.toUpperCase() : raw;
}
```

### A.2 — client: `public/js/shared/audit-labels.js`

Script CLASIC, IIFE, `'use strict'`, pe modelul `public/js/shared/alop-roluri.js` (#175):
expune `window.DFAuditLabels = { LABELS, eticheta(eventType) }`, cu **exact aceleași 11 perechi**.

### A.3 — poartă de Etapă A: ZERO consumatori

```bash
grep -rn "audit-labels" server --include=*.mjs | grep -v "server/tests" | grep -v "server/services/audit-labels.mjs"
grep -rn "DFAuditLabels" public/js | grep -v "public/js/shared/audit-labels.js"
# Așteptat: 0 linii la ambele
```

---

## ETAPA B — serverul folosește sursa unică (exportul CSV/PDF)

În `server/routes/formulare/shared.mjs`, înlocuiește harta locală cu un import și păstrează
numele `FORMULAR_AUDIT_LABELS` **doar dacă** are mai mulți consumatori; altfel folosește direct
`etichetaAudit(..., { upper: true })` în locurile unde harta era citită.

⚠️ **Verifică întâi câți consumatori are** (`grep -n "FORMULAR_AUDIT_LABELS"`) și raportează.
Comportamentul trebuie să rămână identic pentru cele 7 chei existente și să adauge etichetă
pentru cele 3 care lipseau. Nu schimba `||`-ul de rezervă: un eveniment necunoscut se afișează
în continuare ca atare.

---

## ETAPA C — clientul: modalul documentului

`old_str`
```js
const _AUDIT_LABELS={creat:'Creat',trimis_p2:'Trimis la Responsabil CAB',completat:'Completat de Responsabil CAB',legat_alop:'Legat de ALOP',returnat:'Returnat',transmis_flux:'Transmis în flux',revizuit:'Revizuit',sters:'Șters'};
```

`new_str`
```js
// #179 — vocabularul vine din sursa unică partajată (public/js/shared/audit-labels.js).
// Harta locală acoperea 7 din cele 10 evenimente care ajung în jurnal, iar cele 3 lipsă
// (anularea administrativă, refuzul în flux, trecerea în neaprobat) se afișau ca
// identificator tehnic. Rezerva pe numele brut rămâne, pentru un eveniment viitor.
const _AUDIT_LABELS = (window.DFAuditLabels && window.DFAuditLabels.LABELS) || {};
```

Și adaugă scriptul în `public/formular.html`, **fără `defer`**, imediat înaintea celorlalte
scripturi partajate (lângă `shared/alop-roluri.js` de la `:1522`).

⚠️ `doc.js` are `defer`, scriptul partajat nu ⇒ ordinea e garantată. Capcana de la #168.

---

## ETAPA D — ecranele de admin

În `public/js/admin/audit.js` și `public/js/admin/activity.js`:

1. **Șterge** din `EVENT_LABELS` cele 11 chei ale vocabularului documentului.
2. Construiește harta pornind de la sursa unică:
   ```js
   const EVENT_LABELS = Object.assign({}, (window.DFAuditLabels && window.DFAuditLabels.LABELS) || {}, {
     /* … restul cheilor, cele care NU sunt în vocabularul documentului … */
   });
   ```
3. Adaugă scriptul partajat în `public/admin.html`, cu `defer`, **înaintea** lui
   `admin/audit.js` (`:1627`) — lângă `shared/pagin.js` (`:1623`).

⚠️ Efect vizibil intenționat: în ecranele de admin, `FLOW_ADMIN_CANCELLED` devine
„Flux finalizat **anulat** administrativ" (era „desfăcut"), iar `neaprobat` devine „Neaprobat"
(era „Neaprobat de semnatar"). Decizia lui Mircea. **NU** păstra variantele vechi ca excepții
locale — ar reintroduce exact divergența pe care lotul o elimină.

---

## ETAPA E — teste

### E.1 — `server/tests/unit/audit-labels-acoperire.test.mjs` ⭐ testul care contează

1. ⭐⭐ **Acoperire derivată din COD, nu dintr-o listă scrisă de mână**: parcurge fișierele din
   `server/` (exclus `server/tests/`), extrage toate valorile `eventType` trimise către
   `recordFormularAudit` și asertează că **fiecare** are intrare în `AUDIT_LABELS`. Testul
   cade automat când cineva adaugă un eveniment nou fără etichetă. Ăsta e singurul motiv
   serios al lotului — fără el, peste o lună apare al patrulea eveniment brut.
2. ⭐ **Paritate server↔client**: cheile și valorile din `public/js/shared/audit-labels.js`
   (parsate din fișier) sunt IDENTICE cu `AUDIT_LABELS`.
3. `etichetaAudit(k, { upper: true })` e `AUDIT_LABELS[k].toUpperCase()` pentru toate cheile.
4. **Non-regresie pe export**: pentru cele 7 chei care existau, `etichetaAudit(k,{upper:true})`
   întoarce EXACT șirul din vechiul `FORMULAR_AUDIT_LABELS` (scrie-le literal în test, ca
   valori așteptate — asta fixează exportul CSV/PDF byte cu byte).
5. Eveniment necunoscut ⇒ se întoarce numele brut, nu `undefined`.
6. `AUDIT_LABELS` e înghețat.

### E.2 — `server/tests/unit/audit-labels-consumatori.test.mjs` (analiză statică)

⚠️ Elimină liniile de comentariu înainte de aserțiuni (lecția de la #124i, #172, #172b, #173,
#175, #179).

7. `doc.js` nu mai conține harta literală (`creat:'Creat'` a dispărut) și citește
   `window.DFAuditLabels`.
8. `admin/audit.js` și `admin/activity.js` nu mai conțin niciuna dintre cele 11 chei ca literal
   în `EVENT_LABELS` și pornesc din sursa unică.
9. `formular.html` și `admin.html` încarcă `shared/audit-labels.js` **înaintea** consumatorilor.
10. Hărțile de culori/emoji din admin sunt **neatinse** (contorul lor de chei e neschimbat).

```bash
node --check server/services/audit-labels.mjs
node --check public/js/shared/audit-labels.js
node --check public/js/formular/doc.js
node --check public/js/admin/audit.js
node --check public/js/admin/activity.js
npx vitest run server/tests/unit/audit-labels-acoperire.test.mjs server/tests/unit/audit-labels-consumatori.test.mjs
npm test
npm run test:db
```

⚠️ `server/tests/db/flow-received-ack.test.mjs > (4)` e **instabil** în suita completă (id-uri
fixe + audit scris *fire-and-forget* după răspuns). Dacă pică doar el, raportează-l ca
preexistent și NU-l repara. Dacă pică altceva, oprește-te.

---

## ETAPA F — versiune, lockfile (EXPERIMENT), cache busting

1. `package.json`: `3.9.833` → `3.9.834`.
2. ⭐ **EXPERIMENT cerut explicit**: regenerează lockfile-ul **complet** cu
   `npm install --package-lock-only` (NU edita manual cele două linii de versiune, cum s-a
   făcut la #177 și #178). Motivul: `npm audit` din CI pică cu 400 „Invalid package tree" de la
   #177 încoace, iar singurul commit verde recent (`ebd7010`) e chiar cel care a REGENERAT
   lockfile-ul complet. Vrem să știm dacă regenerarea repară auditul.
   - Raportează **numărul de linii** din `git diff --stat -- package-lock.json`.
   - Dacă procesul e întrerupt sau depășește timpul alocat, **raportează-l ca EȘEC**, nu ca
     succes validat pe fișier. (La #177 a fost întrerupt și raportat ca reușit.)
3. `CACHE_VERSION` **NEATINS** (niciun fișier atins nu e în `PRECACHE_ASSETS` — confirmat în
   Etapa 0).
4. Bump `?v=` ȚINTIT pe assetele atinse; fișierul nou direct la `3.9.834`:

```bash
NEW=3.9.834
sed -i -E "s#(js/formular/doc\.js\?v=)[0-9.]+#\1$NEW#g" public/*.html
sed -i -E "s#(js/admin/audit\.js\?v=)[0-9.]+#\1$NEW#g" public/*.html
sed -i -E "s#(js/admin/activity\.js\?v=)[0-9.]+#\1$NEW#g" public/*.html
grep -n "formular/doc.js?v=\|admin/audit.js?v=\|admin/activity.js?v=\|shared/audit-labels.js?v=" public/*.html
grep -c "<script" public/formular.html public/admin.html
```

⛔ `\1`, nu `\g<1>`. ⛔ Fără bulk-sed.

5. `git add` explicit pe căile sarcinii + `package.json` + `package-lock.json`.
   **Niciodată `git add -A`.**
6. Commit:
   ```
   fix(#179): vocabularul de audit al documentului pe sursa unica — v3.9.834

   Zece tipuri de evenimente ajung in jurnalul unui formular, dar cele doua
   harti care ajung la utilizator — modalul din doc.js si exportul CSV/PDF —
   acopereau doar sapte, ratand exact aceleasi trei: anularea administrativa,
   refuzul in flux si trecerea in neaprobat. In documentul de audit exportat
   apareau identificatori tehnici. Vocabularul devine sursa unica (server +
   client, cu test de paritate), iar un test de acoperire extrage din cod
   toate valorile eventType si cade daca vreuna n-are eticheta.
   Formulari noi decise de Mircea; ecranele de admin se aliniaza la ele.
   ```
7. `git push origin develop`

---

## RAPORT FINAL — obligatoriu

1. Ancorele din Etapa 0. ⭐ **Lista de `eventType` obținută independent** — dacă diferă de cele
   10/11 din prompt, care și cum.
2. Câți consumatori avea `FORMULAR_AUDIT_LABELS` și ce ai făcut cu numele.
3. Rezultatul fiecărui caz din Etapa E, cu accent pe 1, 2 și 4.
4. ⭐ **EXPERIMENTUL pe lockfile**: câte linii a schimbat regenerarea completă. Dacă procesul a
   fost întrerupt, spune-o direct.
5. Numerele reale `npm test` / `npm run test:db`; dacă `test:db` a rulat REAL; dacă
   `flow-received-ack` a picat.
6. Ieșirea `grep` de după `sed`.
7. Teste preexistente atinse. (Așteptat: NICIUNUL.)
8. Divergențe prompt↔cod — raportate, NU reparate tăcut.
9. Constatări colaterale — consemnate, nereparate.

---

## ⛔ CONSTRÂNGERI ABSOLUTE

- `develop` ONLY. Zero migrații, `CACHE_VERSION` neatins.
- Exportul CSV/PDF rămâne byte-identic pentru cele 7 chei existente (cazul 4 îl fixează).
- Hărțile de culori/emoji din admin NEATINSE.
- `package-lock.json` regenerat COMPLET, în același commit.
- `git add` explicit.
- `old_str` care nu se potrivește exact ⇒ **OPREȘTE-TE și raportează**.
