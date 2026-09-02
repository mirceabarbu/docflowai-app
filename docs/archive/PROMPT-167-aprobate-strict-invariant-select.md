---
prompt: 167
titlu: "DF aprobate: ruta devine strictă, iar selectul de pe ORD nu mai poate pierde tăcut legătura"
model_suggested: "Opus 5, efort high"
branch: develop
versiune_curenta: v3.9.820
versiune_tinta: v3.9.821
migratii: NU
fisiere_din_public: DA  (⇒ bump `?v=` pe cele TREI scripturi atinse; CACHE_VERSION NU — vezi Etapa 0)
zona_no_touch_atinsa: NU
---

# ⚠️ BRANCH

Lucrezi **EXCLUSIV pe `develop`**. `main` = PRODUCȚIE, gestionat manual de Mircea.
Pasul final obligatoriu: `git push origin develop`.

---

# ⛔ CITEȘTE ASTA ÎNAINTE DE ORICE

**Există DOUĂ funcții diferite, cu nume care nu seamănă, și NU sunt interschimbabile:**

| funcție | modul | ce afirmă | conține `flow_id IS NOT NULL`? |
|---|---|---|---|
| `docAprobatSql(fd, f)` (alias `dfAprobatSql`) | `services/df-aprobat-sql.mjs` | **DOCUMENTUL** e aprobat: are pointer către un flux, iar fluxul e viu și finalizat | **DA** |
| `validSignedFlowSql(alias)` | `services/flow-provenance.mjs` | **FLUXUL** e valid semnat. Nu știe nimic despre vreun document sau pointer | **NU** |

În acest lot folosești **exclusiv `dfAprobatSql`**. Nu importa `validSignedFlowSql`, nu-l
menționa în cod, nu încerca să le unifici. Faptul că predicatele se suprapun e cunoscut și
**e subiectul lotului #168**, cu testele lui. Dacă amesteci aici, produci exact regresia pe
care lotul o previne: un `EXISTS` fără garda de pointer se evaluează pe fluxul greșit.

---

## Context — de ce a fost scos din #166

`GET /api/formulare-df/aprobate` (`df.mjs`, în jur de linia 134 după #166) e ultimul loc din
familia „document aprobat" rămas cu forma laxă:

```
AND (f.data->>'status' = 'completed' OR (f.data->>'completed')::boolean = true)
```

Nu verifică `deleted_at`, nici `cancelled`, nici `refused`. Un flux anulat păstrează
`completed:true` în JSONB ⇒ **un DF cu aprobarea desfăcută apare în continuare în lista din
care se alege DF-ul unei ordonanțări noi.** Ăsta e defectul de reparat.

L-am scos din #166 fiindcă ruta **nu e doar afișare**: alimentează `<select id="o-df-sel">`
prin `loadDfAprobate()` (`public/js/formular/list.js:137`), iar din select se derivă legătura
DF↔ORD. Dacă strângi doar predicatul, produci trei regresii, toate tăcute:

**R1 — ORD existent, la deschidere.** `populateOrd` (`doc.js`) face
`dfSel.value = doc.df_id`. Dacă DF-ul nu mai e în listă, `.value` devine `''`.
Salvarea NU se strică (`doc.js:150` citește hidden-ul `#o-df-id`, nu selectul), dar:
validarea de la `doc.js` (~1628) și pre-check-ul din `showP2Modal` (~1680) citesc
**selectul** ⇒ „Selectați un Document de Fundamentare aprobat" pe un ORD care are DF.
Utilizatorul nu poate finaliza documentul și nu are ce selecta.

**R2 — ORD nou din ALOP.** `alopDeschideORD` / `alopGoToORD` (`alop.js`) fac
`await loadDfAprobate()` apoi `s.value = alop.df_id` + `dispatchEvent('change')`. Opțiune
lipsă ⇒ `.value` rămâne `''` ⇒ `selectDfAprobat()` intră pe ramura `if(!id)` și
**golește `#o-df-id`**. Se salvează `formulare_ord.df_id = NULL`, tăcut. Exact clasa de bug
reparată la #157.

**R3 — cursă de încărcare, care există DEJA azi.** La `doc.js` (~2186), init-ul face
`loadDfAprobate()` **fără `await`**. Dacă `populateOrd` rulează înainte ca fetch-ul să
termine, `dfSel.value` nu prinde nicio opțiune; iar dacă termină după, `sel.innerHTML=…`
rescrie lista și **șterge selecția deja pusă**. Nu e introdusă de acest lot — dar lotul o
închide, fiindcă altfel n-am ști dacă un raport de teren e R1 sau R3.

---

## Decizia de arhitectură — un INVARIANT, nu trei petice

Nu adăugăm un parametru `?include=` pe rută (ar muta o problemă de afișare pe server) și nu
peticim fiecare apelant. Introducem un singur invariant, ținut într-un singur loc:

> **După ORICE randare a lui `#o-df-sel`: dacă `#o-df-id` are valoare, selectul conține o
> opțiune cu acea valoare și acea opțiune e cea selectată.**

`#o-df-id` (hidden) rămâne **singura sursă de adevăr** pentru ce se salvează — nu se schimbă
nimic acolo. Selectul devine o oglindă a lui.

Consecințele deciziei, explicit:

- **ORD existent** cu DF a cărui aprobare s-a desfăcut ⇒ opțiunea „lipicioasă" apare, marcată
  vizibil, selectul rămâne blocat (`lockDfSelectIfLinked` îl dezactivează deja când hidden are
  valoare). Legătura istorică nu se pierde niciodată. R1 și R3 dispar.
- **ORD nou din ALOP** cu `alop.df_id` neaprobat ⇒ **NU inventăm opțiunea**. Nu există fapt
  istoric de protejat, iar o legare tăcută ar crea o ordonanțare pe un DF neaprobat. Oprim
  explicit, cu mesaj. R2 devine vizibilă în loc de tăcută.

Diferența dintre cele două ramuri e „există sau nu `#o-df-id` la momentul randării". De asta
invariantul e formulat pe hidden și nu pe altceva.

---

## ETAPA 0 — ancore (READ-ONLY, zero modificări)

```bash
cd $(git rev-parse --show-toplevel)
git rev-parse --abbrev-ref HEAD        # Așteptat: develop
git status --short
node -e "console.log(require('./package.json').version)"   # Așteptat: 3.9.820

# A0.1 — ruta, cu numărul ei REAL de linie după #166
grep -n "formulare-df/aprobate" -A 20 server/routes/formulare/df.mjs | head -30

# A0.2 — forma laxă rămasă în df.mjs. Așteptat: EXACT 2 linii (ruta /aprobate + PUT-ul
# deja strict de la ~403). Dacă apar 3, oprește-te.
grep -n "completed')::boolean" server/routes/formulare/df.mjs

# A0.3 — toți consumatorii selectului și ai hidden-ului
grep -rn "o-df-sel\|o-df-id\|loadDfAprobate" public/js public/formular.html

# A0.4 — sw.js NU precacheuiește /js/formular/* ⇒ NU se atinge CACHE_VERSION
grep -n "js/formular" public/sw.js || echo "OK: niciun /js/formular in PRECACHE_ASSETS"

# A0.5 — versiunile ?v= actuale ale scripturilor
grep -n "formular/list.js\|formular/doc.js\|formular/alop.js\|formular/core.js" public/formular.html

# A0.6 — tiparul de test happy-dom pe cod frontend REAL (îl refolosești la Etapa E)
sed -n '1,40p' server/tests/unit/ord-bloc-comportamente-vii.test.mjs
```

Dacă A0.2 sau A0.4 dau altceva decât e scris mai sus, **oprește-te și raportează**.

---

## ETAPA A — ruta devine strictă (backend, o singură schimbare)

**Fișier:** `server/routes/formulare/df.mjs` (importul `dfAprobatSql` există deja, `:28`)

`old_str`:
```
      WHERE fd.org_id = $1
        AND fd.deleted_at IS NULL
        AND fd.flow_id IS NOT NULL
        AND (f.data->>'status' = 'completed' OR (f.data->>'completed')::boolean = true)
      ORDER BY ${dosarKeyExpr('fd')}, fd.revizie_nr DESC
```

`new_str`:
```
      WHERE fd.org_id = $1
        AND fd.deleted_at IS NULL
        -- #167 — sursa unica. Forma veche nu verifica nici fluxul soft-sters, nici anulat,
        -- nici refuzat, iar un flux anulat pastreaza cheia de finalizare in JSONB: un DF cu
        -- aprobarea DESFACUTA ramanea in lista din care se alege DF-ul unei ordonantari noi.
        -- Garda de pointer non-NULL e inclusa in helper, de aceea a disparut de aici.
        -- ⛔ helper de DOCUMENT (cere pointerul), NU predicatul de FLUX din flow-provenance.
        AND ${dfAprobatSql('fd', 'f')}
      ORDER BY ${dosarKeyExpr('fd')}, fd.revizie_nr DESC
```

⚠️ **Zero backtick-uri în comentariile de mai sus** — se interpolează într-un template literal.
Docblock-ul din `df-aprobat-sql.mjs` avertizează explicit, iar promptul #166 a călcat pe asta.
Dacă adaugi vreun backtick în SQL, `node --check` va pica și te-ai abătut.

**Efect secundar INTENȚIONAT de confirmat în raport:** `DISTINCT ON (dosarKey) … ORDER BY
revizie_nr DESC` filtrează acum ÎNAINTE de deduplicare. Dacă R2 are fluxul anulat și R1 e
aprobată, dropdown-ul oferă R1 (înainte oferea R2, marcată fals ca aprobată). Ăsta e
comportamentul corect; scrie-l explicit, nu-l trata ca pe un accident.

**Nu atinge:** `df.mjs:403` (deja strict), niciun alt fișier de pe server, `clasa8.mjs`,
`alop.mjs`.

---

## ETAPA B — invariantul, într-un singur loc (`public/js/formular/list.js`)

Azi `loadDfAprobate` scrie direct `sel.innerHTML`. Extragi randarea într-o funcție separată,
care e SINGURUL loc din care se scrie conținutul selectului.

`old_str`:
```
    _dfAprobate=j.documents||[];
    const sel=document.getElementById('o-df-sel');
    if(!sel)return;
    sel.innerHTML='<option value="" style="background:#0d1630;color:#e8eeff">— selectare DF aprobat —</option>'
      +_dfAprobate.map(d=>{
        const nr=d.nr_unic_inreg?`DF ${esc(d.nr_unic_inreg)}`:'DF fără număr';
        const sub=d.subtitlu_df?` — ${esc(d.subtitlu_df.slice(0,50))}`:'';
        const rev=(d.revizie_nr>0)?` (R${d.revizie_nr})`:'';
        return`<option value="${esc(d.id)}" style="background:#0d1630;color:#e8eeff">${nr}${sub}${rev}</option>`;
      }).join('');
  }catch(_){}
}
```

`new_str`:
```
    _dfAprobate=j.documents||[];
    _renderDfSelect();
  }catch(_){}
}

// #167 — INVARIANT: după orice randare a lui #o-df-sel, dacă #o-df-id are valoare, selectul
// conține o opțiune cu acea valoare ȘI acea opțiune e selectată.
//
// De ce e nevoie: din #167 ruta /api/formulare-df/aprobate întoarce DOAR DF-uri cu aprobarea
// VIE. Un ORD deja salvat poate purta un df_id a cărui aprobare s-a desfăcut ulterior (flux
// anulat, refuzat sau șters) — legătura aia e un FAPT ISTORIC și nu se pierde. Fără opțiunea
// „lipicioasă", selectul ar rămâne gol, iar validarea de la completare (care citește SELECTUL,
// nu hidden-ul) ar bloca fals documentul.
//
// Închide și cursa preexistentă: init-ul apelează loadDfAprobate() FĂRĂ await, deci randarea
// poate sosi DUPĂ populateOrd și îi rescria selecția. Acum orice randare o restaurează.
//
// ⛔ #o-df-id rămâne SINGURA sursă de adevăr pentru ce se salvează. Funcția asta NU scrie
//    niciodată în hidden — doar citește din el.
let _dfStickyLabel='';
function _renderDfSelect(stickyLabel){
  if(typeof stickyLabel==='string')_dfStickyLabel=stickyLabel;
  const sel=document.getElementById('o-df-sel');
  if(!sel)return;
  const linkedId=(document.getElementById('o-df-id')?.value||'').trim();
  sel.innerHTML='<option value="" style="background:#0d1630;color:#e8eeff">— selectare DF aprobat —</option>'
    +_dfAprobate.map(d=>{
      const nr=d.nr_unic_inreg?`DF ${esc(d.nr_unic_inreg)}`:'DF fără număr';
      const sub=d.subtitlu_df?` — ${esc(d.subtitlu_df.slice(0,50))}`:'';
      const rev=(d.revizie_nr>0)?` (R${d.revizie_nr})`:'';
      return`<option value="${esc(d.id)}" style="background:#0d1630;color:#e8eeff">${nr}${sub}${rev}</option>`;
    }).join('');
  if(linkedId&&![...sel.options].some(o=>o.value===linkedId)){
    const o=document.createElement('option');
    o.value=linkedId;
    o.textContent=(_dfStickyLabel||'DF legat')+' — aprobare desfăcută';
    o.dataset.aprobat='0';
    o.style.background='#0d1630';o.style.color='#ffb37a';
    sel.appendChild(o);
  }
  if(linkedId)sel.value=linkedId;
}
```

Și expui funcția lângă celelalte, în blocul de exporturi de la finalul fișierului (~1089):

`old_str`:
```
  window.loadDfAprobate         = loadDfAprobate;
```

`new_str`:
```
  window.loadDfAprobate         = loadDfAprobate;
  window._renderDfSelect        = _renderDfSelect;   // #167 — invariant select⟷hidden
```

⚠️ Verifică la Etapa 0 că `esc` e în scope în `list.js` la locul noii funcții (e folosit deja
în corpul mutat). Dacă nu e, **oprește-te** — nu-l redefini local.

---

## ETAPA C — apelanții din `public/js/formular/doc.js`

### C.1 — `populateOrd`: hidden ÎNTÂI, apoi randarea

`old_str`:
```
  const dfSel=document.getElementById('o-df-sel');if(dfSel)dfSel.value=doc.df_id||'';
  const dfId=document.getElementById('o-df-id');if(dfId)dfId.value=doc.df_id||'';
  lockDfSelectIfLinked(); // ORD legat de DF → referința DF needitabilă (ciclu ALOP)
```

`new_str`:
```
  // #167 — ORDINEA CONTEAZĂ: hidden-ul se scrie PRIMUL, fiindcă _renderDfSelect citește din el
  // ca să decidă dacă are nevoie de opțiunea „lipicioasă". Eticheta vine din nr_unic_inreg-ul
  // ORD-ului (copia numărului de DF), ca opțiunea să fie recognoscibilă chiar dacă DF-ul nu mai
  // e în lista de aprobate.
  const dfId=document.getElementById('o-df-id');if(dfId)dfId.value=doc.df_id||'';
  _renderDfSelect(doc.nr_unic_inreg?('DF '+doc.nr_unic_inreg):'DF legat');
  lockDfSelectIfLinked(); // ORD legat de DF → referința DF needitabilă (ciclu ALOP)
```

### C.2 — resetul la document NOU

`old_str`:
```
    const dfSel=document.getElementById('o-df-sel');if(dfSel)dfSel.value='';
    const dfId=document.getElementById('o-df-id');if(dfId)dfId.value='';
    lockDfSelectIfLinked(); // ORD nou fără DF → select-ul rămâne selectabil (enabled)
```

`new_str`:
```
    // #167 — hidden gol ⇒ _renderDfSelect nu adaugă nicio opțiune lipicioasă și resetează și
    // eticheta reținută de la documentul precedent (SPA — nu se reîncarcă pagina).
    const dfId=document.getElementById('o-df-id');if(dfId)dfId.value='';
    _renderDfSelect('');
    lockDfSelectIfLinked(); // ORD nou fără DF → select-ul rămâne selectabil (enabled)
```

**Nu atinge** `doc.js:150` (`df_id` din hidden la salvare), validarea de la ~1628,
pre-check-ul din `showP2Modal`, `lockDfSelectIfLinked`, `lockOrdIdentityCols` sau
`loadDfAprobate()` de la init.

---

## ETAPA D — apelanții din `public/js/formular/alop.js` (ORD NOU — fără opțiune inventată)

Ambele locuri primesc aceeași gardă. **NU** folosi `_renderDfSelect` aici: hidden-ul e gol,
deci n-ar face nimic — iar dacă l-ai forța, ai lega tăcut o ordonanțare nouă de un DF
neaprobat, adică exact defectul pe care lotul îl repară.

### D.1 — `alopDeschideORD`

`old_str`:
```
        await loadDfAprobate();
        const s=document.getElementById('o-df-sel');
        if(s){
          s.value=alop.df_id;
```

`new_str`:
```
        await loadDfAprobate();
        const s=document.getElementById('o-df-sel');
        // #167 — lista conține acum DOAR DF-uri cu aprobarea VIE. Dacă DF-ul dosarului lipsește,
        // aprobarea lui a fost desfăcută. ORD-ul e NOU: nu există fapt istoric de protejat, deci
        // nu inventăm opțiunea (asta ar crea o ordonanțare pe un DF neaprobat). Înainte, .value
        // rămânea gol, selectDfAprobat golea #o-df-id și se salva df_id NULL — tăcut.
        if(s&&![...s.options].some(o=>o.value===alop.df_id)){
          alert('Documentul de Fundamentare al dosarului nu mai figurează ca aprobat '
              + '(fluxul de semnare a fost anulat, refuzat sau șters). '
              + 'Reluați semnarea DF-ului înainte de a crea ordonanțarea.');
        }else if(s){
          s.value=alop.df_id;
```

### D.2 — `alopGoToORD`

`old_str`:
```
    await loadDfAprobate();
    const s=document.getElementById('o-df-sel');
    if(s){
      s.value=dfId;
```

`new_str`:
```
    await loadDfAprobate();
    const s=document.getElementById('o-df-sel');
    // #167 — aceeași gardă ca în alopDeschideORD (vezi comentariul de acolo).
    if(s&&![...s.options].some(o=>o.value===dfId)){
      alert('Documentul de Fundamentare al dosarului nu mai figurează ca aprobat '
          + '(fluxul de semnare a fost anulat, refuzat sau șters). '
          + 'Reluați semnarea DF-ului înainte de a crea ordonanțarea.');
    }else if(s){
      s.value=dfId;
```

⚠️ Ambele `old_str` se termină în mijlocul unui bloc `if(s){ … }`. Verifică prin `sed` că
acoladele rămân echilibrate după patch (`if(...){…}else if(s){ s.value=…; s.dispatchEvent(…); }`)
și rulează `node --check` pe fișier. Dacă structura nu se închide curat, **oprește-te** — nu
rescrie funcția din memorie.

---

## ETAPA E — teste

### E.1 — DB, ruta (extinde fișierul existent, nu crea unul nou)

Fișierul `server/tests/db/anti-shadowing-df-aprobate.test.mjs` acoperă deja ruta.
Adaugă acolo un `describe` nou, `#167 — /aprobate întoarce doar aprobări vii`:

1. DF cu flux viu finalizat ⇒ **prezent**.
2. ⭐ DF cu flux **anulat administrativ** (soft-șters + `cancelled` + cheia de finalizare
   păstrată) ⇒ **absent**.
3. ⭐ DF cu flux anulat **obișnuit** (`cancelled`, fără soft-delete) ⇒ **absent**.
4. ⭐ DF cu flux **refuzat** purtând finalizarea ⇒ **absent**.
5. DF fără flux ⇒ absent (neschimbat).
6. ⭐ **Deduplicarea**: același dosar cu R1 aprobată și R2 cu flux anulat ⇒ ruta întoarce
   **exact un rând**, iar acela e **R1**. Verifică `revizie_nr`, nu doar numărul de rânduri.
7. Testul de anti-shadowing existent trebuie să rămână verde, neatins.

### E.2 — happy-dom, invariantul (fișier nou)

`server/tests/unit/ord-df-select-sticky.test.mjs`, cu `// @vitest-environment happy-dom`.
Model: `server/tests/unit/ord-bloc-comportamente-vii.test.mjs` — încarci codul REAL din
`public/js/formular/list.js`, nu o reimplementare.

Cazuri:

1. ⭐ `#o-df-id` are valoare, iar lista întoarsă NU conține acel id ⇒ după `_renderDfSelect()`
   selectul conține o opțiune cu acel `value`, e cea selectată, are `dataset.aprobat === '0'`
   și textul conține „aprobare desfăcută".
2. ⭐ **Idempotență**: două randări succesive ⇒ **o singură** opțiune lipicioasă (nu două).
3. ⭐ **Cursa R3**: se setează hidden, se randează, apoi soseşte o a doua randare (simulează
   `loadDfAprobate` întârziat) ⇒ `sel.value` e tot valoarea din hidden.
4. `#o-df-id` gol ⇒ nicio opțiune lipicioasă, `sel.value === ''`, iar numărul de opțiuni e
   exact `1 + lungimea listei`.
5. ⭐ `#o-df-id` are valoare ȘI DF-ul E în listă ⇒ **nicio** opțiune lipicioasă (fără dublură),
   iar opțiunea normală e selectată.
6. ⭐ Hidden-ul **nu se modifică niciodată** de `_renderDfSelect`: compară valoarea înainte și
   după în toate cazurile de mai sus.
7. Eticheta reținută se resetează: `_renderDfSelect('DF 123')`, apoi hidden golit +
   `_renderDfSelect('')` ⇒ nicio opțiune lipicioasă la o randare ulterioară cu alt hidden gol.

### E.3 — analiză statică, garda din `alop.js` (fișier nou sau extindere)

Tiparul din `admin-cancel-ui.test.mjs` (citire de sursă, fără DOM):

1. `alop.js` conține de **exact două ori** verificarea de prezență a opțiunii înainte de
   `s.value=` (câte una în `alopDeschideORD` și `alopGoToORD`).
2. `alop.js` **nu** apelează `_renderDfSelect` nicăieri.
3. `doc.js` apelează `_renderDfSelect` de **exact două ori**, iar în ambele locuri linia care
   scrie `#o-df-id` apare ÎNAINTEA apelului.
4. `list.js` conține `sel.innerHTML=` de **exact o dată** în tot fișierul, în interiorul lui
   `_renderDfSelect` (dovada că randarea are un singur loc).

Dacă un test existent cade, analizează întâi dacă el codifica comportamentul lax. **Nu slăbi
predicatul și nu scoate garda ca să treacă un test.**

---

## ETAPA F — cache-busting, verificări, versionare, push

`sw.js` NU precacheuiește `/js/formular/*` (confirmat la A0.4) ⇒ **nu atinge `CACHE_VERSION`**.
Bump `?v=` DOAR pe cele trei scripturi modificate, în `public/formular.html`:

- `/js/formular/alop.js?v=3.9.813` → `?v=3.9.821`
- `/js/formular/list.js?v=3.9.811` → `?v=3.9.821`
- `/js/formular/doc.js?v=3.9.811`  → `?v=3.9.821`

⛔ **`core.js` nu se modifică** ⇒ `?v=` rămâne `3.9.798`. Nu-l „alinia".

```bash
node --check server/routes/formulare/df.mjs
node --check public/js/formular/list.js
node --check public/js/formular/doc.js
node --check public/js/formular/alop.js
npm run check                       # exit 0

grep -c "completed')::boolean" server/routes/formulare/df.mjs   # Așteptat: 1 (doar PUT-ul ~403)
grep -c "sel.innerHTML=" public/js/formular/list.js             # Așteptat: 1
grep -c "_renderDfSelect" public/js/formular/doc.js             # Așteptat: 2
grep -c "_renderDfSelect" public/js/formular/alop.js            # Așteptat: 0
grep -rn "validSignedFlowSql" server/routes/formulare/          # Așteptat: NICIUN rezultat
grep -n "formular/core.js" public/formular.html                 # Așteptat: ?v=3.9.798 neschimbat

npm test
npm run test:db                     # PG 17 efemer, port 55432. PASSED, nu SKIPPED.
```

```bash
# package.json: 3.9.820 → 3.9.821
git add server/routes/formulare/df.mjs \
        public/js/formular/list.js public/js/formular/doc.js public/js/formular/alop.js \
        public/formular.html \
        server/tests/db/anti-shadowing-df-aprobate.test.mjs \
        server/tests/unit/ord-df-select-sticky.test.mjs \
        package.json
# + fișierul de test static din E.3, dacă l-ai creat separat — enumeră-l explicit, nu `git add -A`
git status --short
git commit -m "#167: /aprobate strict + invariant select-hidden pe referinta DF din ORD (v3.9.821)"
git push origin develop
```

---

## RAPORT FINAL

1. Ancorele din Etapa 0, **literal** — mai ales A0.2 și A0.4, înainte de orice modificare.
2. Diff-ul pe fiecare fișier.
3. SQL-ul FINAL generat pentru `/aprobate`, copiat integral.
4. Confirmarea efectului asupra deduplicării `DISTINCT ON` (cazul R1 aprobată / R2 anulată),
   cu rezultatul testului E.1 (6).
5. Rezultatul explicit al fiecărui caz ⭐ din E.1, E.2 și E.3.
6. Ieșirea fiecărei comenzi `grep` din Etapa F, cu numărul obținut.
7. Confirmarea că `#o-df-id` nu e scris de `_renderDfSelect` (testul E.2 caz 6) și că
   `doc.js:150` (sursa de adevăr la salvare) e neatins.
8. `npm test` / `npm run test:db` — rezultat real. Orice test existent atins, cu justificare.
9. **Constatare cerută explicit, fără reparație:** `loadDfAprobate()` de la init-ul din `doc.js`
   (~2186) e apelat fără `await`. După acest lot, cursa nu mai produce efect vizibil — dar
   apelul rămâne fire-and-forget. Merită `await`, sau invariantul e suficient? Argumentează
   scurt. **Nu-l modifica.**
10. Hash-ul commitului + confirmarea push-ului pe `develop`.

## ⛔ CONSTRÂNGERI ABSOLUTE

- **Nu importa și nu folosi `validSignedFlowSql` nicăieri în acest lot.** Vezi tabelul de la
  începutul promptului. Unificarea celor două predicate e #168.
- Zero migrații. Zero atingeri în zona NO-TOUCH. Zero modificări în `clasa8.mjs` sau `alop.mjs`
  (serverul).
- `#o-df-id` rămâne singura sursă de adevăr la salvare. Nicio linie nouă nu scrie în el.
- Nu modifica `selectDfAprobat`, `onDfSelect`, `lockDfSelectIfLinked`, `lockOrdIdentityCols`,
  validarea din `doc.js` (~1628) sau pre-check-ul din `showP2Modal`.
- Fără backtick-uri în comentariile care ajung în SQL.
- Nu bump-a `CACHE_VERSION` din `sw.js` și nu atinge `?v=` pe `core.js`.
- ⚠️ Pe STAGING, înainte de merge, Mircea testează TREI scenarii:
  1. ORD existent legat de un DF cu fluxul anulat ⇒ referința DF se vede în select (marcată
     „aprobare desfăcută"), documentul se poate completa și salva, iar `df_id` rămâne intact
     după salvare;
  2. ALOP → „Creează ORD" cu DF aprobat normal ⇒ neschimbat, rândurile se prefill-ează;
  3. ALOP → „Creează ORD" cu DF a cărui aprobare a fost desfăcută ⇒ mesaj explicit, fără
     legare tăcută.
- Orice verificare cu rezultat neașteptat ⇒ oprire și raport, fără improvizație.
