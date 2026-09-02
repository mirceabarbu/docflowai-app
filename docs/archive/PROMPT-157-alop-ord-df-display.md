# PROMPT-157 — ALOP: etapă „ORD aprobat" prematură + cursă la legarea DF pe ORD nou

⚠️ BRANCH: develop — NICIODATĂ main. `main` e producția, gestionată manual doar de Mircea.

**model_suggested:** Sonnet 5 (strict frontend, un singur fișier, zero migrații, zero
atingere de funcții/logică de business — Mircea a cerut explicit să nu umblăm la funcții
pentru bug-ul 1; bug-ul 2 e o cursă de timing, nu o decizie de arhitectură)
**cache_version_bump:** NU — `alop.js` nu e în `PRECACHE_ASSETS`
**migrations:** NU
**target:** citește `package.json` ÎNAINTE de orice modificare, incrementează patch-ul cu 1

## Context — DOUĂ bug-uri, ambele confirmate pe cod, un singur fișier atins

**Bug 1 (display, funcțiile rămân neatinse):** cutia de etapă „Ordonanțare" din
`renderAlopDetail` afișează „ORD aprobat" doar pe baza EXISTENȚEI `a.ord_id` (chiar dacă
ORD-ul e încă `draft`, netransmis pe flux). Serverul calculează deja corect
`ord_aprobat` (`server/routes/alop.mjs:774-777`, CASE pe fluxul autoritar +
`completed`/`status`), livrat în `GET /api/alop/:id` — dovadă că e activ folosit real: la
liniile 962/1032/1055 din același fișier decide tranziții de stare. Frontend-ul pur și
simplu nu-l consumă la acest sub-text. NU se atinge nimic pe backend.

**Bug 2 (cursă reală, nu doar vizuală):** două funcții din `alop.js`
(`alopDeschideORD`/`alopGoToORD`, ambele pornite din butoanele de generare/deschidere ORD
pe un ALOP) setează `#o-df-sel`.value printr-un `setTimeout(...,400)` orb, pariind că lista
de opțiuni a select-ului (populată o SINGURĂ dată, la încărcarea inițială a paginii, de
`loadDfAprobate()` în `list.js`) a apucat deja să se încarce. Dacă fetch-ul inițial n-a
terminat până la cei 400ms, `.value=alop.df_id` nu găsește nicio opțiune care să se
potrivească — select-ul rămâne pe „— selectare DF aprobat —" ȘI câmpul ascuns `#o-df-id`
(cel care chiar se salvează) rămâne gol. Consecință: ORD-ul se salvează cu `df_id=NULL`,
legătura DF↔ORD lipsește permanent din document (nu doar din ecran) — exact simptomul
raportat: trasabilitatea arată corect legătura la ALOP (vine din altă sursă), dar DF-ul nu
apare, fiindcă n-a fost niciodată scris pe `formulare_ord.df_id`.

## Fișiere atinse (EXACT 2)

1. `public/js/formular/alop.js` — trei modificări, toate mai jos
2. `package.json` — bump patch

═══════════════════════════════════════════════════════════════════
## PASUL 0 — verificări obligatorii
═══════════════════════════════════════════════════════════════════

```bash
git branch --show-current
# Așteptat: develop

git status --short
# Așteptat: gol sau doar fișiere netrackuite cunoscute

grep -rn "PROMPT-157" docs/archive/ 2>/dev/null
git log --all --oneline | grep -i "#157"
# Așteptat: ambele goale. Dacă #157 e deja folosit, OPREȘTE-TE — nu renumerota

grep '"version"' package.json
# Notează valoarea — folosește patch-ul + 1 consecvent mai jos
```

═══════════════════════════════════════════════════════════════════
## ETAPA A (bug 1) — sub-textul etapei „Ordonanțare"
═══════════════════════════════════════════════════════════════════

```bash
grep -c "sub:a.ord_id?'ORD aprobat':'Fără ORD'}," public/js/formular/alop.js
# Așteptat: 1 — dacă nu, fișierul s-a schimbat față de premisa promptului, STOP
```

```
old_str:
    {label:'Ordonanțare',icon:'💰',color:'#8b5cf6',
     done:!!a.ord_completed_at||isCompleted,
     active:a.status==='ordonantare',
     sub:a.ord_id?'ORD aprobat':'Fără ORD'},

new_str:
    {label:'Ordonanțare',icon:'💰',color:'#8b5cf6',
     done:!!a.ord_completed_at||isCompleted,
     active:a.status==='ordonantare',
     // #157 — a.ord_id doar confirmă că EXISTĂ un rând ORD (poate fi draft, netrimis
     // pe flux). a.ord_aprobat e derivat server-side din fluxul autoritar (alop.mjs)
     // și e deja folosit real pentru tranziții — aici doar îl CONSUMĂM pentru afișare.
     sub:!a.ord_id?'Fără ORD':a.ord_aprobat?'ORD aprobat':'ORD în lucru'},
```

Verificare:
```bash
grep -c "sub:!a.ord_id?'Fără ORD':a.ord_aprobat?'ORD aprobat':'ORD în lucru'}," public/js/formular/alop.js
# Așteptat: 1
```

═══════════════════════════════════════════════════════════════════
## ETAPA B (bug 2) — `alopDeschideORD`: elimină cursa de timing
═══════════════════════════════════════════════════════════════════

```bash
grep -c "if(alop.df_id)setTimeout(()=>{" public/js/formular/alop.js
# Așteptat: 1
```

```
old_str:
      newDocFromList();
      if(alop.df_id)setTimeout(()=>{
        const s=document.getElementById('o-df-sel');
        if(!s)return;
        s.value=alop.df_id;
        // dispatch 'change' ca să trigger-uim onchange="selectDfAprobat()" — set
        // programatic .value NU declanșează handler-ul, ceea ce împiedica
        // auto-popularea rândurilor din DF la prima deschidere.
        s.dispatchEvent(new Event('change'));
      },400);

new_str:
      newDocFromList();
      if(alop.df_id){
        // #157 — era un setTimeout(400) orb, pariind că #o-df-sel are deja opțiunile
        // încărcate din pasul inițial de pagină (loadDfAprobate, o singură dată la load).
        // Dacă acel fetch nu apucase să termine (sau DF-ul era prea nou în sesiune),
        // .value nu prindea nicio opțiune și legătura DF↔ORD se pierdea la salvare —
        // nu doar vizual, #o-df-id (câmpul care chiar se salvează) rămânea gol. Reîncarcă
        // explicit lista (idempotent, garantează și prospețime) și abia apoi setează.
        await loadDfAprobate();
        const s=document.getElementById('o-df-sel');
        if(s){
          s.value=alop.df_id;
          // dispatch 'change' ca să trigger-uim onchange="selectDfAprobat()" — set
          // programatic .value NU declanșează handler-ul, ceea ce împiedica
          // auto-popularea rândurilor din DF la prima deschidere.
          s.dispatchEvent(new Event('change'));
        }
      }
```

⚠️ `await loadDfAprobate()` cere ca funcția-container (`alopDeschideORD`) să fie `async` —
verifică (e deja `async function alopDeschideORD(alopId,btn){`, confirmat pe cod la scrierea
promptului) și, dacă din orice motiv nu mai e, oprește-te și raportează.

Verificare:
```bash
grep -c "await loadDfAprobate();" public/js/formular/alop.js
# Așteptat: ≥1 (vezi și Etapa C — poate ajunge la 2)
```

═══════════════════════════════════════════════════════════════════
## ETAPA C (bug 2, a doua apariție) — `alopGoToORD`: același fix
═══════════════════════════════════════════════════════════════════

⚠️ Tipar IDENTIC, funcție diferită — dacă nu se repară și aici, bug-ul rămâne pe jumătate
deschis (userii care ajung la ORD prin acest buton tot îl pot lovi).

```bash
grep -c "function alopGoToORD(alopId,dfId){" public/js/formular/alop.js
# Așteptat: 1
```

```
old_str:
function alopGoToORD(alopId,dfId){
  document.getElementById('section-list').style.display='';
  document.getElementById('section-form').style.display='none';
  document.getElementById('ltab-ord').click();
  try{history.replaceState({},'',`${location.pathname}?tip=ord&alop_id=${encodeURIComponent(alopId)}`);}catch(_){}
  setTimeout(()=>{
    newDocFromList();
    if(dfId)setTimeout(()=>{
      const s=document.getElementById('o-df-sel');
      if(!s)return;
      s.value=dfId;
      s.dispatchEvent(new Event('change'));
    },400);
  },100);
}

new_str:
async function alopGoToORD(alopId,dfId){
  document.getElementById('section-list').style.display='';
  document.getElementById('section-form').style.display='none';
  document.getElementById('ltab-ord').click();
  try{history.replaceState({},'',`${location.pathname}?tip=ord&alop_id=${encodeURIComponent(alopId)}`);}catch(_){}
  await new Promise(res=>setTimeout(res,100));
  newDocFromList();
  // #157 — aceeași reparație ca în alopDeschideORD: elimină setTimeout(400) orb,
  // reîncarcă explicit lista înainte de a seta valoarea.
  if(dfId){
    await loadDfAprobate();
    const s=document.getElementById('o-df-sel');
    if(s){
      s.value=dfId;
      s.dispatchEvent(new Event('change'));
    }
  }
}
```

⚠️ Funcția devine `async` — verifică TOATE apelurile ei (`grep -n "alopGoToORD("`) ca să
confirmi că niciunul nu depinde de o valoare de întoarcere sincronă (azi nu întoarce nimic,
deci schimbarea la `async` e sigură prin construcție, dar verifică oricum).

Verificare:
```bash
grep -c "async function alopGoToORD(alopId,dfId){" public/js/formular/alop.js
# Așteptat: 1
grep -c "await loadDfAprobate();" public/js/formular/alop.js
# Așteptat: 2
```

═══════════════════════════════════════════════════════════════════
## ETAPA D — versionare
═══════════════════════════════════════════════════════════════════

- `package.json`: `"version"` → patch-ul curent + 1
- Fără `?v=` de bumpat pe `alop.js` în `formular.html` DOAR dacă fișierul e deja încărcat
  cu `?v=` dinamic per-versiune curentă a proiectului — verifică cum e încărcat azi
  (`grep -n "formular/alop.js" public/formular.html`) și bump-uiește dacă are `?v=` fix,
  la fel ca la #154.

Verificare:
```bash
grep -n "formular/alop.js" public/formular.html
# dacă apare cu ?v=X.Y.Z, bump-uiește la versiunea nouă; dacă nu are ?v=, nu adăuga unul
```

═══════════════════════════════════════════════════════════════════
## ETAPA E — teste
═══════════════════════════════════════════════════════════════════

`alop.js` e script clasic mare, fără infrastructură de test comportamental pentru funcțiile
astea azi. Adaugă un test STATIC minimal (`readFileSync` + regex, modelul
`admin-cancel-ui.test.mjs`) care verifică:

1. `sub:a.ord_id?'ORD aprobat':'Fără ORD'` NU mai apare (forma veche, dispărută)
2. `sub:!a.ord_id?'Fără ORD':a.ord_aprobat?'ORD aprobat':'ORD în lucru'` apare
3. `if(alop.df_id)setTimeout(()=>{` NU mai apare (forma veche, dispărută)
4. `if(dfId)setTimeout(()=>{` NU mai apare (forma veche, dispărută)
5. `async function alopGoToORD(alopId,dfId){` apare (confirmă conversia la async)

```bash
npm test
# Așteptat: verde, 0 failed (NU hardcoda numărul total de teste)
```

═══════════════════════════════════════════════════════════════════
## RAPORT FINAL (obligatoriu în răspunsul tău)
═══════════════════════════════════════════════════════════════════

- Versiune veche → nouă
- Commit hash + `git diff --stat` (2 fișiere + testul nou = 3)
- Rezultat `npm test`
- Confirmare, prin citire directă a codului: `alopDeschideORD` ȘI `alopGoToORD` sunt
  amândouă `async`, amândouă apelează `await loadDfAprobate()` înainte de a seta
  `#o-df-sel.value`, și NICIUN `setTimeout` cu valoare de întârziere `400` nu mai există
  legat de `o-df-sel` în fișier
- Orice abatere, cu motivul

═══════════════════════════════════════════════════════════════════
## ⛔ CONSTRÂNGERI ABSOLUTE
═══════════════════════════════════════════════════════════════════

- ⛔ NU atinge `server/routes/alop.mjs` — `ord_aprobat` există deja, corect calculat;
  acest lot e strict frontend
- ⛔ NU atinge cardul CICLURI de jos (`_renderAlopCicluri`) — Mircea a confirmat explicit
  că acela afișează corect
- ⛔ NU schimba comportamentul lui `loadDfAprobate()` însuși (`list.js`) — doar îl apelezi
  mai des, dintr-un loc nou
- ⛔ NU propune niciodată merge/push/checkout pe `main`
- ⛔ Dacă `#157` e deja folosit, OPREȘTE-TE și raportează

Ultimul pas, obligatoriu:
```bash
git push origin develop
```
