---
prompt: 168
titlu: "Atributul „ÎNREGISTRAT CAB" + lista de atribute devine o singură sursă"
model_suggested: "Sonnet 5, efort mediu"
branch: develop
versiune_curenta: v3.9.821
versiune_tinta: v3.9.822
migratii: NU
fisiere_din_public: DA  (⇒ bump `?v=` țintit; CACHE_VERSION NU — vezi Etapa 0)
zona_no_touch_atinsa: NU
---

# ⚠️ BRANCH

Lucrezi **EXCLUSIV pe `develop`**. `main` = PRODUCȚIE, gestionat manual de Mircea.
Pasul final obligatoriu: `git push origin develop`.

---

## Context

Mircea cere un atribut nou de semnatar, **„ÎNREGISTRAT CAB"** — atribut NOU, care nu-l
înlocuiește pe „ÎNREGISTRAT", poziționat imediat după el, disponibil peste tot unde apare
lista de atribute.

Lista trăiește azi în **două copii**, ambele în frontend:

- `public/js/semdoc-initiator/main.js` (~613-632) — 19 elemente `<option>` scrise de mână
  într-un template literal (ecranul „Pornește flux");
- `public/js/templates/templates.js` (~10-15) — array-ul `ATRIBUTE`, randat prin
  `buildAtribOptions()` (ecranul „Șabloane").

**Verificat înainte de scrierea promptului: conținutul celor două e IDENTIC, în aceeași
ordine.** Diferă doar forma. Deci nu ai de reconciliat nimic — ai de extras o sursă unică
și de adăugat un element. Dacă adaugi elementul de două ori în loc să consolidezi, a treia
cerere de atribut va găsi listele divergente.

Ce NU e o problemă (verificat, ca să nu pierzi timp):

- Pe server nu există listă închisă de atribute. Rolul e text liber, iar „Alt atribut…"
  permite deja orice valoare. Singura logică legată de un atribut anume e garda de securitate
  pe `ÎNTOCMIT` (`server/routes/flows/crud.mjs:158`) — **nu o atingi**.
- Cartușul din PDF (`server/signing/pades.mjs:182`) desenează rolul cu `maxWidth: cellW-10`
  la corp 7. „LUAT LA CUNOȘTINȚĂ" (18 caractere) încape deja; „ÎNREGISTRAT CAB" are 15.
  Nicio schimbare acolo.
- Datele existente nu sunt afectate: atributul se stochează ca text în `signers[].rol`.

---

## ETAPA 0 — ancore (READ-ONLY, zero modificări)

```bash
cd $(git rev-parse --show-toplevel)
git rev-parse --abbrev-ref HEAD        # Așteptat: develop
git status --short
node -e "console.log(require('./package.json').version)"   # Așteptat: 3.9.821

# A0.1 — cele două copii ale listei
sed -n '610,635p' public/js/semdoc-initiator/main.js
sed -n '8,20p'    public/js/templates/templates.js

# A0.2 — toate folosirile array-ului în templates.js (sunt trei, le atingi pe toate)
grep -n "ATRIBUTE" public/js/templates/templates.js
# Așteptat: declarația (~10), buildAtribOptions (~50), garda isAlt (~100)

# A0.3 — modelul de script partajat pe care îl imiți
sed -n '1,20p' public/js/shared/pagin.js

# A0.4 — ordinea scripturilor în cele două pagini gazdă
grep -n "js/shared/\|semdoc-initiator/main.js" public/semdoc-initiator.html
grep -n "js/shared/\|templates/templates.js"    public/templates.html
# ⚠️ Observă: în semdoc-initiator.html scripturile au `defer`; în templates.html,
#    `templates.js` NU are `defer`. Ordinea de execuție se asigură diferit — vezi Etapa C.

# A0.5 — sw.js: niciunul din fișierele atinse nu e precacheuit
grep -n "semdoc-initiator\|templates/templates\|shared/" public/sw.js \
  || echo "OK: niciunul in PRECACHE_ASSETS ⇒ CACHE_VERSION NEATINS"
```

Dacă A0.1 arată liste cu **conținut diferit** (nu doar formă diferită), **oprește-te și
raportează** — premisa promptului cade și consolidarea ar pierde tăcut un atribut.

---

## ETAPA A — sursa unică (fișier NOU)

**Fișier nou:** `public/js/shared/atribute.js`

Script CLASIC (fără `type="module"`), în IIFE, expunând `window.DFAtribute` — exact tiparul
lui `public/js/shared/pagin.js`. Conținut:

```js
/**
 * public/js/shared/atribute.js
 *
 * Lista de ATRIBUTE ale semnatarilor — sursă unică pentru cele două ecrane care o
 * foloseau, fiecare cu propria copie: `semdoc-initiator/main.js` (opțiuni <option>
 * scrise de mână) și `templates/templates.js` (array + buildAtribOptions).
 *
 * La #168 conținutul celor două era încă identic. Consolidarea s-a făcut ATUNCI tocmai
 * ca a treia cerere de atribut să nu găsească liste divergente.
 *
 * Script CLASIC, încărcat explicit de fiecare pagină consumatoare ÎNAINTE de scriptul
 * care apelează DFAtribute. Expune window.DFAtribute.
 *
 * ⛔ `__alt__` NU e un atribut — e santinela pentru „Alt atribut…", care deschide inputul
 *    de text liber. Rămâne ULTIMA în listă și e singura cu etichetă diferită de valoare.
 * ⛔ Valorile sunt constante scrise aici, nu date de utilizator ⇒ nu se escapează (la fel
 *    ca în implementarea originală din templates.js).
 */
(function () {
  'use strict';

  var LIST = [
    'ÎNTOCMIT', 'VERIFICAT', 'VIZAT', 'AVIZAT', 'APROBAT',
    'VIZĂ CFPP', 'VIZĂ JURIDICĂ', 'VIZĂ TEHNICĂ', 'VIZĂ ECONOMICĂ',
    'CONTROLAT', 'CERTIFICAT', 'CONTRASEMNAT', 'ÎNSUȘIT', 'ASUMAT',
    'SEMNAT', 'LUAT LA CUNOȘTINȚĂ',
    'ÎNREGISTRAT',
    'ÎNREGISTRAT CAB',   // #168 — atribut NOU, imediat după ÎNREGISTRAT (cerere Mircea)
    'CONFIRMAT',
    '__alt__'
  ];

  function buildOptions(selected) {
    return LIST.map(function (a) {
      var label = a === '__alt__' ? 'Alt atribut...' : a;
      return '<option value="' + a + '"' + (a === selected ? ' selected' : '') + '>' + label + '</option>';
    }).join('');
  }

  function isKnown(value) {
    return LIST.indexOf(value) !== -1;
  }

  window.DFAtribute = { LIST: LIST, buildOptions: buildOptions, isKnown: isKnown };
})();
```

**Verificare imediată:** `node --check public/js/shared/atribute.js`

---

## ETAPA B — cei doi consumatori

### B.1 — `public/js/templates/templates.js`

Declarația locală dispare, iar `buildAtribOptions` delegă. Păstrezi numele funcției — e
apelată din mai multe locuri și nu vrei churn.

`old_str`:
```
const ATRIBUTE = [
  'ÎNTOCMIT','VERIFICAT','VIZAT','AVIZAT','APROBAT',
  'VIZĂ CFPP','VIZĂ JURIDICĂ','VIZĂ TEHNICĂ','VIZĂ ECONOMICĂ',
  'CONTROLAT','CERTIFICAT','CONTRASEMNAT','ÎNSUȘIT','ASUMAT',
  'SEMNAT','LUAT LA CUNOȘTINȚĂ','ÎNREGISTRAT','CONFIRMAT','__alt__'
];
```

`new_str`:
```
// #168 — lista s-a mutat în public/js/shared/atribute.js (sursă unică, partajată cu
// ecranul „Pornește flux"). templates.html o încarcă ÎNAINTE de acest fișier.
const ATRIBUTE = window.DFAtribute.LIST;
```

`old_str`:
```
function buildAtribOptions(selected) {
  return ATRIBUTE.map(a => {
    const label = a === '__alt__' ? 'Alt atribut...' : a;
    return `<option value="${a}"${a===selected?' selected':''}>${label}</option>`;
  }).join('');
}
```

`new_str`:
```
// #168 — randarea s-a mutat în sursa unică. Numele funcției rămâne: e apelată din mai
// multe locuri din acest fișier și nu are rost churn de call-site-uri.
function buildAtribOptions(selected) {
  return window.DFAtribute.buildOptions(selected);
}
```

⚠️ Garda `isAlt` de la ~linia 100 (`!ATRIBUTE.includes(selectedAtrib) || selectedAtrib === '__alt__'`)
**rămâne neschimbată** — `ATRIBUTE` arată acum spre lista partajată, deci se comportă identic.
Nu o rescrie cu `DFAtribute.isKnown` în acest lot; ar fi churn fără câștig.

### B.2 — `public/js/semdoc-initiator/main.js`

`old_str`:
```
            <select class="rol">
              <option value="ÎNTOCMIT">ÎNTOCMIT</option>
              <option value="VERIFICAT">VERIFICAT</option>
              <option value="VIZAT">VIZAT</option>
              <option value="AVIZAT">AVIZAT</option>
              <option value="APROBAT">APROBAT</option>
              <option value="VIZĂ CFPP">VIZĂ CFPP</option>
              <option value="VIZĂ JURIDICĂ">VIZĂ JURIDICĂ</option>
              <option value="VIZĂ TEHNICĂ">VIZĂ TEHNICĂ</option>
              <option value="VIZĂ ECONOMICĂ">VIZĂ ECONOMICĂ</option>
              <option value="CONTROLAT">CONTROLAT</option>
              <option value="CERTIFICAT">CERTIFICAT</option>
              <option value="CONTRASEMNAT">CONTRASEMNAT</option>
              <option value="ÎNSUȘIT">ÎNSUȘIT</option>
              <option value="ASUMAT">ASUMAT</option>
              <option value="SEMNAT">SEMNAT</option>
              <option value="LUAT LA CUNOȘTINȚĂ">LUAT LA CUNOȘTINȚĂ</option>
              <option value="ÎNREGISTRAT">ÎNREGISTRAT</option>
              <option value="CONFIRMAT">CONFIRMAT</option>
              <option value="__alt__">Alt atribut...</option>
            </select>
```

`new_str`:
```
            <select class="rol">
              ${window.DFAtribute.buildOptions()}
            </select>
```

⚠️ **Comportament de păstrat, verifică-l:** azi niciun `<option>` n-are atributul `selected`,
deci browserul selectează primul („ÎNTOCMIT"). `buildOptions()` fără argument nu emite niciun
`selected` ⇒ tot primul. **Nu** pasa `'ÎNTOCMIT'` ca argument — ar schimba markup-ul emis
fără să schimbe comportamentul, și ar ascunde faptul că default-ul e pozițional.

---

## ETAPA C — încărcarea scriptului în cele două pagini

Scriptul partajat trebuie să se execute ÎNAINTE de consumatorul lui. Cele două pagini
folosesc mecanisme diferite, deci **nu copia aceeași linie în amândouă**.

### C.1 — `public/semdoc-initiator.html`

Acolo scripturile au `defer` (ordinea de execuție = ordinea din document). Inserezi
noul script lângă celelalte din `js/shared/`, ÎNAINTE de `semdoc-initiator/main.js`:

`old_str`:
```
    <script src="/js/shared/pagin.js?v=3.9.724" defer></script>
    <script src="/js/semdoc-initiator/main.js?v=3.9.817" defer></script>
```

`new_str`:
```
    <script src="/js/shared/pagin.js?v=3.9.724" defer></script>
    <script src="/js/shared/atribute.js?v=3.9.822" defer></script>
    <script src="/js/semdoc-initiator/main.js?v=3.9.822" defer></script>
```

### C.2 — `public/templates.html`

Acolo `templates.js` **nu** are `defer` — se execută sincron, la parsare. Deci noul script
trebuie inserat imediat înaintea lui și **tot fără `defer`**; un `defer` l-ar amâna după
parsare, iar `templates.js` ar rula cu `window.DFAtribute` nedefinit.

`old_str`:
```
<script src="/js/templates/templates.js?v=3.9.739"></script>
```

`new_str`:
```
<script src="/js/shared/atribute.js?v=3.9.822"></script>
<script src="/js/templates/templates.js?v=3.9.822"></script>
```

⛔ Niciun alt `?v=` din cele două pagini nu se atinge. Nu „alinia" versiunile celorlalte
scripturi.

`sw.js`: niciunul din fișierele atinse nu e în `PRECACHE_ASSETS` (confirmat la A0.5)
⇒ **nu atinge `CACHE_VERSION`**.

---

## ETAPA D — teste

**Fișier nou:** `server/tests/unit/atribute-sursa-unica.test.mjs`

Model: `server/tests/unit/admin-cancel-ui.test.mjs` (citire de sursă) combinat cu
încărcarea codului real, ca în `ord-bloc-comportamente-vii.test.mjs` dacă ai nevoie de DOM.
Pentru lotul ăsta e suficient să evaluezi `atribute.js` peste un `window` minimal.

Cazuri OBLIGATORII:

1. ⭐ `DFAtribute.LIST` conține `'ÎNREGISTRAT CAB'`, iar indexul lui e **exact** indexul lui
   `'ÎNREGISTRAT'` + 1. (Poziția e cerința, nu doar prezența.)
2. `'ÎNREGISTRAT'` există în continuare, distinct de cel nou — nu a fost înlocuit.
3. `'__alt__'` e ULTIMUL element din listă.
4. Lista are 20 de elemente și nu conține duplicate.
5. ⭐ `buildOptions()` fără argument emite 20 de `<option>` și **niciun** ` selected`.
6. `buildOptions('APROBAT')` emite exact un ` selected`, pe valoarea corectă.
7. `buildOptions('CEVA INEXISTENT')` emite zero ` selected` (fără excepție).
8. Eticheta lui `__alt__` e `Alt atribut...`, iar `value` rămâne `__alt__`; pentru toate
   celelalte, eticheta e identică cu valoarea.
9. ⭐ **Analiză statică — nu mai există a doua copie:**
   - `public/js/templates/templates.js` NU mai conține literalul `'LUAT LA CUNOȘTINȚĂ'`;
   - `public/js/semdoc-initiator/main.js` NU mai conține `<option value="APROBAT"`;
   - fiecare din cele două fișiere referă `DFAtribute` cel puțin o dată.
10. ⭐ **Analiză statică — ordinea de încărcare:** în ambele fișiere HTML, poziția lui
    `shared/atribute.js` e strict înaintea consumatorului corespunzător; iar în
    `templates.html`, linia lui `shared/atribute.js` **nu** conține `defer`.

Dacă un test EXISTENT cade, analizează întâi dacă el codifica lista veche (atunci se
corectează, cu justificare explicită în raport) sau dacă e regresie reală (atunci te
oprești). **Nu scoate atributul nou ca să treacă un test.**

---

## ETAPA E — verificări, versionare, push

```bash
node --check public/js/shared/atribute.js
node --check public/js/templates/templates.js
node --check public/js/semdoc-initiator/main.js
npm run check                       # exit 0

grep -c "LUAT LA CUNOȘTINȚĂ" public/js/templates/templates.js        # Așteptat: 0
grep -c "option value=\"APROBAT\"" public/js/semdoc-initiator/main.js # Așteptat: 0
grep -c "ÎNREGISTRAT CAB" public/js/shared/atribute.js               # Așteptat: 1
grep -rn "ÎNREGISTRAT CAB" public/js | grep -v "shared/atribute.js"  # Așteptat: niciun rezultat
grep -n "shared/atribute.js" public/semdoc-initiator.html public/templates.html
grep -n "CACHE_VERSION" public/sw.js                                 # Așteptat: v302, neschimbat

npm test
npm run test:db                     # PG 17 efemer, port 55432. PASSED, nu SKIPPED.
```

```bash
# package.json: 3.9.821 → 3.9.822
git add public/js/shared/atribute.js \
        public/js/templates/templates.js \
        public/js/semdoc-initiator/main.js \
        public/templates.html public/semdoc-initiator.html \
        server/tests/unit/atribute-sursa-unica.test.mjs \
        package.json
git status --short
git commit -m "#168: atribut ÎNREGISTRAT CAB + lista de atribute pe sursa unica (v3.9.822)"
git push origin develop
```

---

## RAPORT FINAL

1. Ancorele din Etapa 0, **literal** — în special A0.1, cu dovada că cele două liste aveau
   conținut identic înainte de consolidare.
2. Diff-ul pe fiecare fișier.
3. Conținutul final al lui `DFAtribute.LIST`, copiat integral, cu indexul lui
   `'ÎNREGISTRAT'` și al lui `'ÎNREGISTRAT CAB'`.
4. Rezultatul explicit al fiecărui caz ⭐, în special (5) și (10).
5. Ieșirea fiecărei comenzi `grep` din Etapa E, cu numărul obținut.
6. Confirmarea că `CACHE_VERSION` și celelalte `?v=` din cele două pagini sunt neschimbate.
7. `npm test` / `npm run test:db` — rezultat real. Orice test existent atins, cu justificare.
8. **Constatare cerută explicit, fără reparație:** mai există în `public/js` alte liste
   duplicate de acest fel (roluri, statusuri, tipuri de document) scrise de mână în două sau
   mai multe fișiere? Enumeră-le cu fișier și linie. **Nu repara nimic.**
9. Hash-ul commitului + confirmarea push-ului pe `develop`.

## ⛔ CONSTRÂNGERI ABSOLUTE

- Zero fișiere din `server/` în afara testului nou. Zero migrații. Zona NO-TOUCH neatinsă.
- Nu atinge `server/routes/flows/crud.mjs` (garda pe `ÎNTOCMIT`) și nu adăuga validare de
  atribut pe server: rolul e text liber prin design, iar „Alt atribut…" depinde de asta.
- Nu redenumi `buildAtribOptions` și nu schimba garda `isAlt` din `templates.js`.
- Nu adăuga `defer` pe scriptul nou din `templates.html`.
- Nu bump-a `CACHE_VERSION` și nu atinge alte `?v=` decât cele două enumerate.
- Nu escapa valorile în `buildOptions` — sunt constante, iar implementarea originală nu
  escapa; o schimbare acolo ar fi o modificare de comportament strecurată într-un lot de
  conținut.
- ⚠️ Pe STAGING, înainte de merge, Mircea verifică: (1) „Pornește flux" — „ÎNREGISTRAT CAB"
  apare în dropdown imediat după „ÎNREGISTRAT", se poate selecta și se salvează pe flux;
  (2) „Șabloane" — același lucru, plus că un șablon vechi cu atribut personalizat se
  deschide în continuare pe „Alt atribut…" cu textul păstrat; (3) cartușul din PDF-ul
  semnat afișează „ÎNREGISTRAT CAB" întreg, netăiat.
- Orice verificare cu rezultat neașteptat ⇒ oprire și raport, fără improvizație.
