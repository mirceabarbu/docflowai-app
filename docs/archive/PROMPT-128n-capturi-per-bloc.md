# PROMPT #128n — capturi de ecran per furnizor (ULTIMUL din seria #128)

> ## ⚠️ BRANCH: `develop`
> Toate commit-urile pe `develop`. **NU** propune și **NU** executa `checkout main`,
> `merge main`, `push origin main`. Deploy-ul în producție îl face Mircea manual.

**Model recomandat:** Opus 5 · **Target versiune:** `v3.9.774` (de la 3.9.773 — **citește
`package.json`**) · **Migrații:** ZERO (coloana `formulare_capturi.bloc_idx` există din #128m)

> ⚠️ Mesajul de commit: `git commit -m "subiect"`, o linie, **sintaxă bash**. ⛔ Fără here-string,
> fără `--amend`, fără `--force`.

---

## 1. Ce face și ce NU face

Seria #128 e completă în spate și în față: blocuri de furnizor (#128h), validări (#128i),
comportamente vii (#128j), paritate (#128k), fără pierdere de rânduri (#128l), atașamente per
furnizor (#128m). **Singurul lucru care lipsește: capturile de ecran.**

Gaura e concretă și TĂCUTĂ, verificată pe cod. `POST /api/formulare-capturi/:type/:id`
(`server/routes/formulare/shared.mjs`, ~74) face:

```sql
DELETE FROM formulare_capturi WHERE form_type=$1 AND form_id=$2 AND slot=$3
```

urmat de `INSERT`. Cheia e **doar slotul**. Cu doi furnizori, captura celui de-al doilea o
**șterge** pe a primului, fără nicio eroare, iar utilizatorul vede confirmarea de succes.

Lotul ăsta face capturile per bloc, cap-coadă: rută, markup, încărcare, reîncărcare, blocare,
PDF, teste.

**⛔ NU face:** nu atinge `blocuri JSONB` (cele 8 chei rămân EXACT cele 8 atribute XSD — o
captură nu e atribut de formular MF, e un BYTEA în `formulare_capturi`), nu atinge DF-ul
(mono-bloc), nu atinge exportul XML (XSD-ul n-are captură), nu salvează capturi în draft
(vezi §7.3).

---

## 2. O decizie pe care Mircea o poate schimba ÎNAINTE să rulezi

**AMBELE sloturi devin per bloc**, nu doar primul:

- slotul 1 = „Captură din sistemul de control al angajamentelor bugetare" — e captura tabelului
  de angajamente, iar fiecare bloc are tabelul lui ⇒ evident per furnizor;
- slotul 2 = „Informații complete contract" — cu doi furnizori sunt două contracte.

Simetria e și mai ieftină la implementare: `bloc_idx` e ortogonal pe `slot`, deci schimbarea de
rută e aceeași pentru amândouă. O asimetrie („doar slotul 1 per bloc") ar fi arbitrară și ar
cere explicații la fiecare citire ulterioară a codului.

Dacă găsești vreun motiv de cod care contrazice asta, **oprește-te și raportează**, nu decide singur.

---

## 3. NO-TOUCH

⛔ `server/signing/**`, `server/routes/flows/signing.mjs`, `cloud-signing.mjs`, `bulk-signing.mjs`
⛔ `server/services/ord-blocuri.mjs` — `BLOC_KEYS` rămâne la 8 chei, neatins
⛔ `server/services/alop-xml/**` — capturile nu intră în XML
⛔ `formulare_df` și toată calea DF — trebuie să rămână **byte-identică**
⛔ `public/js/formular/draft.js` — vezi §7.3
⛔ Nicio migrație, niciun index, niciun `NOT NULL`, niciun `DEFAULT`
⛔ Zero refactorizări în trecere

---

## 4. Etapa A — ruta (server/routes/formulare/shared.mjs)

Helperul `_blocIdx(req)` există deja (~138), pus la #128m. **Refolosește-l**, nu scrie altul.
⚠️ E declarat DUPĂ rutele de capturi în fișier — funcție declarată cu `function`, deci hoisted;
verifică asta cu ochii înainte să te bazezi pe ea și **spune în raport dacă nu e așa**.

### A.1 — POST captură

`old_str`:
```js
    // v3.9.499: ștergem doar captura din același slot (default 1 backward compat)
    const slotRaw = parseInt(req.query.slot || '1', 10);
    const slot = (slotRaw === 1 || slotRaw === 2) ? slotRaw : 1;
    await pool.query(
      'DELETE FROM formulare_capturi WHERE form_type=$1 AND form_id=$2 AND slot=$3',
      [type, id, slot]
    );

    const { rows: inserted } = await pool.query(`
      INSERT INTO formulare_capturi (form_type, form_id, uploaded_by, filename, mimetype, size_bytes, data, slot)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      RETURNING id, filename, mimetype, size_bytes, slot, created_at
    `, [type, id, actor.userId, filename, mimetype, data.length, data, slot]);

    logger.info({ type, id, slot, size: data.length, actor: actor.email }, 'formulare-captura upload');
```

`new_str`:
```js
    // v3.9.499: ștergem doar captura din același slot (default 1 backward compat)
    const slotRaw = parseInt(req.query.slot || '1', 10);
    const slot = (slotRaw === 1 || slotRaw === 2) ? slotRaw : 1;
    // #128n: blocul de furnizor (ORD multi-bloc), ortogonal pe slot — exact ca la atașamente.
    // ⚠️ Fără `bloc_idx` în cheia DELETE-ului, captura furnizorului 2 o ȘTERGE pe a
    // furnizorului 1, tăcut, iar utilizatorul vede confirmare de succes. Ăsta e bug-ul
    // pe care îl repară lotul; regula „o captură per slot" devine „per (slot, bloc)".
    // Rândurile legacy au `bloc_idx` NULL ⇒ `COALESCE(bloc_idx, 0)` le citește ca blocul 0.
    const blocIdx = _blocIdx(req);
    await pool.query(
      'DELETE FROM formulare_capturi WHERE form_type=$1 AND form_id=$2 AND slot=$3 AND COALESCE(bloc_idx, 0)=$4',
      [type, id, slot, blocIdx]
    );

    const { rows: inserted } = await pool.query(`
      INSERT INTO formulare_capturi (form_type, form_id, uploaded_by, filename, mimetype, size_bytes, data, slot, bloc_idx)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
      RETURNING id, filename, mimetype, size_bytes, slot, bloc_idx, created_at
    `, [type, id, actor.userId, filename, mimetype, data.length, data, slot, blocIdx]);

    logger.info({ type, id, slot, bloc: blocIdx, size: data.length, actor: actor.email }, 'formulare-captura upload');
```

### A.2 — GET captură

`old_str`:
```js
    // v3.9.499: filtrare pe slot (default 1 backward compat pentru DF + clienti vechi)
    const slotRaw = parseInt(req.query.slot || '1', 10);
    const slot = (slotRaw === 1 || slotRaw === 2) ? slotRaw : 1;
    const { rows } = await pool.query(
      'SELECT filename, mimetype, data FROM formulare_capturi WHERE form_type=$1 AND form_id=$2 AND slot=$3 ORDER BY created_at DESC LIMIT 1',
      [type, id, slot]
    );
```

`new_str`:
```js
    // v3.9.499: filtrare pe slot (default 1 backward compat pentru DF + clienti vechi)
    const slotRaw = parseInt(req.query.slot || '1', 10);
    const slot = (slotRaw === 1 || slotRaw === 2) ? slotRaw : 1;
    // #128n: cerere FĂRĂ `?bloc` ⇒ blocul 0 = exact captura pe care o vede clientul de azi.
    const blocIdx = _blocIdx(req);
    const { rows } = await pool.query(
      'SELECT filename, mimetype, data FROM formulare_capturi WHERE form_type=$1 AND form_id=$2 AND slot=$3 AND COALESCE(bloc_idx, 0)=$4 ORDER BY created_at DESC LIMIT 1',
      [type, id, slot, blocIdx]
    );
```

⚠️ Răspunsul 404 de la această rută este `{ error: 'no_captura', slot }` — **lasă-l așa**,
nu adăuga `bloc` în el fără să verifici că niciun client nu compară obiectul întreg.

---

## 5. Etapa B — zona de captură în șablonul de bloc (`public/js/formular/core.js`)

Șablonul `_sablonBloc(idx)` (~539) are azi un comentariu în capul secțiunii care spune explicit
că **NU** conține captură. Acel comentariu devine FALS ⇒ actualizează-l în același patch.

### B.1 — comentariul din capul secțiunii

Găsește, în blocul de comentariu `/* ── #128h — blocuri ORD … */`, linia:

```
 *   - șablonul NU conține secțiunea de CAPTURĂ: `captureImageBase64` / `_2` sunt câmpuri
 *     UNICE PE DOCUMENT în modelul nostru (`blocuri` are exact 8 chei). Divergență
 *     deliberată față de formularul MF, unde SubformCaptura e în blocul repetat.
```

înlocuiește-o cu:

```
 *   - #128n: șablonul conține ACUM secțiunea de captură, marcată prin `data-role="cap-*"`
 *     (⛔ niciun id). Datele NU trec prin harta globală `imgs{}` — ea rămâne la exact
 *     cele 3 chei istorice (`o-cimg`, `o-cimg2`, `n-cimg`). Pentru blocurile 2+ sursa de
 *     adevăr e `src`-ul elementului `<img data-role="cap-img">`, adică DOM-ul blocului.
 *     Motivul e concret: la ștergerea unui furnizor blocurile se RENUMEROTEAZĂ, iar o hartă
 *     cheiată pe index ar reatribui tăcut captura altui furnizor. Datele care călătoresc cu
 *     nodul DOM nu pot face asta — exact motivul pentru care atașamentele pending stau în
 *     `<input data-role="att-data">`, nu într-o hartă.
 *   - `blocuri` JSONB rămâne la exact 8 chei (atributele XSD): capturile sunt BYTEA în
 *     `formulare_capturi`, cheiate pe (form_type, form_id, slot, bloc_idx).
```

### B.2 — markup-ul

În `_sablonBloc`, în interiorul celui de-al doilea `df-block` (cel cu badge-ul **P2**, care
conține tabelul), **imediat după** `</table>` și `</div>`-ul care închide
`<div style="overflow-x:auto;margin-bottom:6px">`, înainte de `</div>` -ul lui
`df-block-body`, adaugă:

```html
    <!-- #128n — capturi per furnizor. Marcate EXCLUSIV prin data-role (⛔ niciun id — regula
         #128h). Handlerele NU sunt inline: se leagă prin delegare pe #ord-blocuri (list.js),
         ca blocurile adăugate manual sau recreate de renderOrdBlocuri să fie acoperite automat.
         `src`-ul lui <img data-role="cap-img"> ESTE sursa de adevăr a capturii blocului. -->
    <div class="cap-lbl">Captură imagine din sistemul de control al angajamentelor bugetare (anexă la ordonanțarea de plată)</div>
    <div class="cap-zone" data-role="cap-zone" data-cap-slot="1">
      <input type="file" accept="image/*" data-role="cap-input"/>
      <div class="cap-ph" data-role="cap-ph"><div class="ico">🖼</div><p>Clic sau trageți o captură de ecran</p><p style="font-size:10px;margin-top:1px">PNG · JPG · BMP</p></div>
      <img class="cap-img" data-role="cap-img"/>
    </div>
    <div class="cap-br"><button type="button" class="att-btn" data-role="cap-clr" data-cap-slot="1"><svg class="df-ic"><use href="/icons.svg?v=3.9.693#ico-x"/></svg>Șterge imaginea</button></div>
    <div class="cap-lbl" style="margin-top:10px">Captură "Informații complete contract" din sistemul de control al angajamentelor bugetare</div>
    <div class="cap-zone" data-role="cap-zone" data-cap-slot="2">
      <input type="file" accept="image/*" data-role="cap-input"/>
      <div class="cap-ph" data-role="cap-ph"><div class="ico">🖼</div><p>Clic sau trageți o captură de ecran</p><p style="font-size:10px;margin-top:1px">PNG · JPG · BMP</p></div>
      <img class="cap-img" data-role="cap-img"/>
    </div>
    <div class="cap-br"><button type="button" class="att-btn" data-role="cap-clr" data-cap-slot="2"><svg class="df-ic"><use href="/icons.svg?v=3.9.693#ico-x"/></svg>Șterge imaginea</button></div>
```

⚠️ Atenție la rezolvarea pe `data-role`: în bloc există **două** zone cu
`data-role="cap-zone"`. Discriminatorul e `data-cap-slot`. Orice `querySelector` care caută
`[data-role="cap-…"]` fără slot ia PRIMA — bug tăcut pe slotul 2. Selectorul canonic e
`[data-role="cap-zone"][data-cap-slot="N"]`, iar `cap-img`/`cap-ph`/`cap-input` se caută
**în interiorul zonei**, nu în bloc.

⚠️ CSS: `.cap-zone` / `.cap-ph` / `.cap-img` / `.cap-br` / `.cap-lbl` sunt reguli pe CLASĂ în
`public/css/formular/formular.css` (verificat: liniile ~113-122 și ~364-367, inclusiv varianta
`.df-block-body .cap-zone` pentru tema închisă) ⇒ **zero CSS nou**. Confirmă prin grep și
raportează dacă nu e așa.

### B.3 — helperii de rezolvare

Adaugă în `core.js`, imediat **după** funcțiile de atașamente (`attBlocOf`), pe același tipar:

```js
/* Capturi per bloc (#128n) — oglinda helperilor de atașamente de mai sus.
   Blocul 0 și DF-ul NU trec pe aici: ei rămân pe `imgs{}` + id-uri, byte-identic. */
function capZona(blocEl, slot){
  if(!blocEl)return null;
  const s=slot===2?2:1;
  return blocEl.querySelector(`[data-role="cap-zone"][data-cap-slot="${s}"]`);
}
// Data-URL-ul capturii unui bloc, citit din DOM. Întoarce null dacă nu e o captură reală.
function capSrcBloc(blocEl, slot){
  const img=capZona(blocEl,slot)?.querySelector('[data-role="cap-img"]');
  const src=img&&img.getAttribute('src');
  return (typeof src==='string'&&src.indexOf('data:image/')===0)?src:null;
}
function capSetBloc(blocEl, slot, dataUrl){
  const z=capZona(blocEl,slot);if(!z)return;
  const img=z.querySelector('[data-role="cap-img"]');
  const ph=z.querySelector('[data-role="cap-ph"]');
  if(!img)return;
  if(dataUrl){img.setAttribute('src',dataUrl);img.style.display='block';if(ph)ph.style.display='none';}
  else{img.removeAttribute('src');img.style.display='none';if(ph)ph.style.display='';}
}
// Captura blocului `i`, indiferent dacă e blocul 0 (hartă `imgs`) sau 2+ (DOM).
// SURSĂ UNICĂ: colO() și uploadCapturaBlocuri() citesc AMÂNDOUĂ de aici, ca să nu apară
// un al doilea adevăr între payload-ul de PDF și ce se urcă pe server.
function capturaBloc(i, slot){
  if(i===0)return imgs[slot===2?'o-cimg2':'o-cimg']||null;
  return capSrcBloc(blocEl(i), slot);
}
```

Expune la finalul fișierului, lângă `window.attEl`:

```js
  window.capZona            = capZona;         // #128n
  window.capSrcBloc         = capSrcBloc;      // #128n
  window.capSetBloc         = capSetBloc;      // #128n
  window.capturaBloc        = capturaBloc;     // #128n
```

⛔ `window.imgs` rămâne EXACT `{'o-cimg':null,'o-cimg2':null,'n-cimg':null}`.
⛔ `showImg` / `clrImg` / `fimg` / `dov` / `dlv` / `ddp` rămân **neatinse**.

---

## 6. Etapa C — payload-ul de PDF (`colO`) + randarea (server)

### C.1 — `colO()` în core.js

`old_str`:
```js
    captureImageBase64:imgs['o-cimg']||null,
    captureImageBase64_2:imgs['o-cimg2']||null,
```

`new_str`:
```js
    // #128n — cele două chei istorice rămân în payload (blocul 0), dar sunt derivate din
    // ACEEAȘI funcție ca restul blocurilor ⇒ o singură sursă, două proiecții. Serverul
    // preferă `capturiBlocuri` când există și cade pe ele când lipsește (client din cache).
    captureImageBase64:capturaBloc(0,1),
    captureImageBase64_2:capturaBloc(0,2),
    capturiBlocuri:blocEls().map((_,i)=>({c1:capturaBloc(i,1),c2:capturaBloc(i,2)})),
```

### C.2 — randarea în PDF (`server/routes/formulare.mjs`)

Astăzi capturile se randează **o singură dată, după TOT conținutul** (~956). Cu doi furnizori
ar rezulta patru imagini la coadă, fără să se știe a cui e fiecare. Trec în interiorul blocului.

⭐ **Paritate obligatorie:** pentru UN SINGUR bloc ordinea rezultată e IDENTICĂ cu cea de azi
(conținut bloc → captura 1 → captura 2 → footer), fiindcă azi `embedCapture` se apelează
imediat după ce `buildOrdnt()` s-a terminat, iar `buildOrdnt()` are un singur bloc. Dacă
constați altceva la citirea codului, **oprește-te și raportează**.

**C.2.a** — `buildOrdnt` devine `async` și așteaptă blocurile:

`old_str`:
```js
    const docs = Array.isArray(data.docFd) ? data.docFd : [data.docFd || {}];
    docs.forEach((df0, i) => {
```
`new_str`:
```js
    const docs = Array.isArray(data.docFd) ? data.docFd : [data.docFd || {}];
    for (let i = 0; i < docs.length; i++) {
      const df0 = docs[i];
```
— și închiderea `});` a acelui `forEach` devine `}`. ⚠️ Identifică închiderea corectă citind
codul, nu numărând acolade din prompt.

Semnătura devine `async function buildOrdnt() {`, iar în interiorul buclei, **după**
`buildOrdntBloc(df0 || {});`, adaugă:

```js
      // #128n — capturile blocului, imediat după conținutul lui. Un singur bloc ⇒ aceeași
      // ordine ca înainte de acest lot. `capturiBlocuri` lipsă (client vechi din cache) ⇒
      // blocul 0 cade pe cheile istorice, restul blocurilor rămân fără captură.
      const capB = Array.isArray(data.capturiBlocuri) ? (data.capturiBlocuri[i] || {}) : null;
      const c1 = capB ? capB.c1 : (i === 0 ? data.captureImageBase64   : null);
      const c2 = capB ? capB.c2 : (i === 0 ? data.captureImageBase64_2 : null);
      const sufix = docs.length > 1 ? ` — furnizorul ${i + 1}` : '';
      await embedCapture(c1, _capLabel1 + sufix);
      await embedCapture(c2, _capLabel2 + sufix);
```

**C.2.b** — cele două constante `_capLabel1` / `_capLabel2` sunt declarate azi **după**
`buildOrdnt()` (~954). Mută-le **înaintea** definiției lui `buildOrdnt`, byte-identic (sunt
`const` — altfel cad în TDZ la execuție). ⛔ Nu le schimba textul: pentru un singur bloc
`sufix` e `''`, deci eticheta e identică.

**C.2.c** — locul de apel:

`old_str`:
```js
  if (formType === 'notafd') buildNotafd(); else buildOrdnt();

  // ── Capturi imagine (după conținut, înainte de footer) ─────────────────────
  const _capLabel1 = 'Captură imagine din sistemul de control al angajamentelor bugetare';
  const _capLabel2 = 'Captură \u201eInformații complete contract\u201d din sistemul de control al angajamentelor bugetare';
  if (formType === 'ordnt') {
    await embedCapture(data.captureImageBase64,   _capLabel1);
    await embedCapture(data.captureImageBase64_2, _capLabel2);
  } else {
    await embedCapture(data.captureImageBase64, _capLabel1);
  }
```
`new_str`:
```js
  // #128n — la ORD capturile se randează ÎN buildOrdnt, per bloc (un singur bloc ⇒ ordine
  // identică cu cea de dinainte). Calea DF rămâne neschimbată.
  if (formType === 'notafd') { buildNotafd(); await embedCapture(data.captureImageBase64, _capLabel1); }
  else await buildOrdnt();
```

---

## 7. Etapa D — încărcare, reîncărcare, blocare (`public/js/formular/doc.js`)

### 7.1 Upload

`uploadCaptura(ft, slot)` (~1176) rămâne **neatinsă** (blocul 0 + DF). Adaugă lângă ea:

```js
// #128n — capturile blocurilor 2+ de furnizor. Blocul 0 rămâne pe uploadCaptura(ft,slot).
// Oglindește uploadAttachmentsBlocuri. Pentru DF întoarce imediat.
async function uploadCapturaBlocuri(ft){
  if(ft!=='ordnt'||!ST.docId[ft])return;
  const n=_ordBlocCount();
  for(let b=1;b<n;b++){
    const el=blocEl(b);if(!el)continue;
    for(const slot of [1,2]){
      const dataUrl=capSrcBloc(el,slot);if(!dataUrl)continue;
      try{
        const[header,b64]=dataUrl.split(',');
        const mime=header.match(/:(.*?);/)?.[1]||'image/png';
        const bin=atob(b64);const arr=new Uint8Array(bin.length);
        for(let i=0;i<bin.length;i++)arr[i]=bin.charCodeAt(i);
        const blob=new Blob([arr],{type:mime});
        await fetch(`/api/formulare-capturi/ord/${ST.docId[ft]}?slot=${slot}&bloc=${b}`,{
          method:'POST',credentials:'include',
          headers:{'Content-Type':mime,'X-CSRF-Token':df.getCsrf(),'X-Filename':`captura_ord_${slot}_bloc${b}.png`},
          body:blob,
        });
      }catch(_){}
    }
  }
}
```

Cablează-l în **exact cele 3 locuri** unde se apelează azi `uploadCaptura`, imediat după
perechea existentă (verifică-le pe cod; azi sunt `doc.js` ~1147-1148, `doc.js` ~1809-1810 și
`list.js` ~92-93 — dacă găsești altele, raportează):

```js
      if(ft==='ordnt') await uploadCapturaBlocuri(ft);
```

⚠️ `uploadCapturaBlocuri` reurcă la fiecare salvare captura deja urcată (ruta e
DELETE+INSERT, deci idempotentă pe conținut). E acceptat deliberat: e comportamentul de azi
al blocului 0, care reurcă și el `imgs['o-cimg']` la fiecare `saveDoc`. ⛔ Nu „optimiza" cu un
flag de dirty în lotul ăsta.

### 7.2 Reîncărcare

În `populateOrd`, după blocul care încarcă slotul 2 al documentului (`o-captura2-wrap` /
`o-cimg2`), adaugă un al treilea traseu, pe modelul lui `fetchAttachmentsBlocuri`:

```js
// #128n — capturile blocurilor 2+ la redeschidere. Blocurile există deja: renderOrdBlocuri()
// rulează SINCRON la începutul lui populateOrd, înaintea primului await.
async function fetchCapturiBlocuri(docId){
  const n=_ordBlocCount();
  for(let b=1;b<n;b++){
    const el=blocEl(b);if(!el)continue;
    for(const slot of [1,2]){
      capSetBloc(el,slot,null);
      try{
        const r=await fetch(`/api/formulare-capturi/ord/${docId}?slot=${slot}&bloc=${b}`,{credentials:'include'});
        if(!r.ok||!r.headers.get('content-type')?.startsWith('image'))continue;
        const blob=await r.blob();
        const dataUrl=await new Promise(res=>{const rd=new FileReader();rd.onload=e=>res(e.target.result);rd.onerror=()=>res(null);rd.readAsDataURL(blob);});
        if(dataUrl)capSetBloc(blocEl(b),slot,dataUrl);
      }catch(_){}
    }
  }
}
```

⚠️ Observă `blocEl(b)` recitit DUPĂ `await` la scriere — între timp DOM-ul poate fi
renumerotat. Nu înlocui cu `el` capturat înainte.

Apelează-l în `populateOrd` cu `await fetchCapturiBlocuri(doc.id||ST.docId.ordnt);`.

### 7.3 Draft — ⛔ NU

`_draftCollect` salvează azi `input[id]:not([type=file])` și textarea — deci captura blocului 0
(`o-cimg`) **nu e** în draft nici acum. Blocurile 2+ trebuie să se comporte identic:
`state.ordBlocuri[i]` colectează `[data-fld]`, iar `<img>` nu e `[data-fld]` ⇒ **`draft.js`
rămâne NEATINS**. Un data-URL de imagine salvat la fiecare 2 secunde ar sufoca cota de
localStorage și ar pierde draftul întreg, nu doar captura.

Confirmă în raport că `draft.js` nu apare în `git status --short`.

### 7.4 Blocare (`lockCaptureAndAttachments`)

`old_str`:
```js
  if(ft==='ordnt')document.querySelectorAll('#ord-blocuri .ord-bloc .att-inp').forEach(e=>e.disabled=lock);
```
`new_str`:
```js
  if(ft==='ordnt')document.querySelectorAll('#ord-blocuri .ord-bloc .att-inp').forEach(e=>e.disabled=lock);
  // #128n — zonele de captură ale blocurilor 2+ (blocul 0 e acoperit de `czId` mai sus).
  if(ft==='ordnt'){
    document.querySelectorAll('#ord-blocuri .ord-bloc [data-bloc]:not([data-bloc="0"]) [data-role="cap-zone"]').forEach(e=>e.style.pointerEvents=pe);
    document.querySelectorAll('#ord-blocuri .ord-bloc[data-bloc]:not([data-bloc="0"]) [data-role="cap-zone"]').forEach(e=>e.style.pointerEvents=pe);
    document.querySelectorAll('#ord-blocuri .ord-bloc [data-role="cap-clr"]').forEach(e=>e.disabled=lock);
  }
```
⚠️ Cele două `querySelectorAll` de mai sus sunt scrise defensiv fiindcă nu pot verifica din
prompt dacă `.ord-bloc` e el însuși purtătorul lui `data-bloc` sau un descendent.
**Citește markup-ul, păstrează UN SINGUR selector — cel corect — și șterge-l pe celălalt.
Spune în raport pe care l-ai păstrat și de ce.**

### 7.5 P2 (`setModeP2Ord`)

Azi deblochează `o-czone` și `o-czone2`. Adaugă, în același stil, deblocarea zonelor din
blocurile 2+ (P2 e cel care încarcă în mod normal capturile):

```js
  // #128n — și zonele de captură ale blocurilor 2+
  document.querySelectorAll('#ord-blocuri .ord-bloc:not([data-bloc="0"]) [data-role="cap-zone"]').forEach(z=>z.style.pointerEvents='');
```
(cu aceeași corecție de selector ca la 7.4, dacă e cazul).

---

## 8. Etapa E — delegarea (`public/js/formular/list.js`)

În IIFE-ul `_wireBenefDelegation`, lângă handlerele de atașamente de la #128m, adaugă
handlerele de captură. **⛔ Blocul 0 se SARE deliberat** — are handlere inline în
`formular.html`; fără gardă fiecare imagine ar fi procesată de două ori.

```js
  // #128n — capturi per furnizor: zonele blocurilor 2+ n-au handler inline (n-au nici id).
  // ⛔ Blocul 0 e SĂRIT: are onchange/ondrop inline în formular.html.
  const _capBloc=(el)=>{
    const b=el&&el.closest&&el.closest('.ord-bloc');
    if(!b)return null;
    return (b.getAttribute('data-bloc')||'0')==='0'?null:b;
  };
  host.addEventListener('change',e=>{
    const inp=e.target;
    if(!inp||!inp.matches||!inp.matches('[data-role="cap-input"]'))return;
    if(!_capBloc(inp))return;
    const zone=inp.closest('[data-role="cap-zone"]');
    const f=inp.files&&inp.files[0];if(!f||!zone)return;
    const rd=new FileReader();
    rd.onload=ev=>{
      const img=zone.querySelector('[data-role="cap-img"]');
      const ph=zone.querySelector('[data-role="cap-ph"]');
      if(img){img.setAttribute('src',ev.target.result);img.style.display='block';}
      if(ph)ph.style.display='none';
      window._scheduleAutoSaveDb?.('ordnt');
    };
    rd.readAsDataURL(f);
    inp.value='';
  });
  host.addEventListener('click',e=>{
    const btn=e.target&&e.target.closest&&e.target.closest('[data-role="cap-clr"]');
    if(!btn||!_capBloc(btn))return;
    const bloc=btn.closest('.ord-bloc');
    const slot=btn.getAttribute('data-cap-slot')==='2'?2:1;
    window.capSetBloc?.(bloc,slot,null);
    window._scheduleAutoSaveDb?.('ordnt');
  });
  host.addEventListener('dragover',e=>{
    const z=e.target&&e.target.closest&&e.target.closest('[data-role="cap-zone"]');
    if(!z||!_capBloc(z))return;
    e.preventDefault();z.classList.add('drag-ov');
  });
  host.addEventListener('dragleave',e=>{
    const z=e.target&&e.target.closest&&e.target.closest('[data-role="cap-zone"]');
    if(!z||!_capBloc(z))return;
    z.classList.remove('drag-ov');
  });
  host.addEventListener('drop',e=>{
    const z=e.target&&e.target.closest&&e.target.closest('[data-role="cap-zone"]');
    if(!z||!_capBloc(z))return;
    e.preventDefault();z.classList.remove('drag-ov');
    const f=e.dataTransfer&&e.dataTransfer.files&&e.dataTransfer.files[0];
    if(!f||!f.type.startsWith('image/'))return;
    const rd=new FileReader();
    rd.onload=ev=>{
      const img=z.querySelector('[data-role="cap-img"]');
      const ph=z.querySelector('[data-role="cap-ph"]');
      if(img){img.setAttribute('src',ev.target.result);img.style.display='block';}
      if(ph)ph.style.display='none';
      window._scheduleAutoSaveDb?.('ordnt');
    };
    rd.readAsDataURL(f);
  });
```

⚠️ Zona de captură are `input[type=file]` cu `position:absolute;inset:0;opacity:0` peste toată
suprafața (CSS existent) ⇒ **nu e nevoie de un handler de `click` care să declanșeze input-ul**,
spre deosebire de atașamente. Verifică asta pe CSS înainte să adaugi ceva în plus; dacă adaugi
și un `click` care face `inp.click()`, dialogul se va deschide de două ori.

---

## 9. Etapa F — teste

### 9.1 Server, DB real — fișier nou `server/tests/db/capturi-bloc-idx.test.mjs`

Modelul: `server/tests/db/atasamente-bloc-idx.test.mjs` (#128m).
⚠️ Ruta citește corpul brut din stream (`req.on('data')`), NU `express.json` ⇒ în supertest se
trimite `Buffer` cu `Content-Type: image/png` și numele în headerul `x-filename`.

1. ⭐ **Capcana lotului:** captură pe `?bloc=0`, apoi captură pe `?bloc=1` ⇒ **DOUĂ rânduri**
   în `formulare_capturi`, blocul 0 NEATINS (fără fix: 1 rând, primul șters).
2. Două capturi succesive pe **același** bloc și slot ⇒ **UN** rând (regula „ultima câștigă"
   pe slot rămâne, restrânsă la bloc).
3. `slot` și `bloc_idx` sunt ortogonale: `(slot=1,bloc=1)` și `(slot=2,bloc=1)` ⇒ două rânduri.
4. `GET ?slot=1&bloc=1` întoarce captura blocului 1, `GET ?slot=1` (fără `bloc`) o întoarce pe
   a blocului 0.
5. Rând legacy inserat direct în DB cu `bloc_idx` NULL ⇒ citit de `GET` fără `?bloc`.
6. DF: `POST`/`GET` fără `?bloc` ⇒ comportament identic cu înainte (un rând, regăsit).
7. Schemă: `formulare_capturi.bloc_idx` e `smallint`, **nullable**, fără default — și un
   `INSERT` minimal (fără coloană) o lasă NULL. Apără decizia „fără backfill" din #128m.

### 9.2 Frontend, happy-dom

Extinde `server/tests/unit/ord-atasamente-bloc.test.mjs` sau creează
`ord-capturi-bloc-frontend.test.mjs` (capcana de mediu: `dirname(fileURLToPath(import.meta.url))`,
⛔ **nu** `new URL('.', import.meta.url)` — aruncă sub happy-dom).

8. ⭐ Bloc nou din `_sablonBloc` ⇒ are **două** zone `[data-role="cap-zone"]`, cu
   `data-cap-slot` 1 și 2, și **ZERO** atribute `id`.
9. `capSrcBloc(el,1)` întoarce null pe un bloc proaspăt; după `capSetBloc(el,1,dataUrl)`
   întoarce exact acel data-URL, iar `capSetBloc(el,1,null)` îl întoarce la null.
10. ⭐ `capSetBloc(el,2,…)` **nu** atinge slotul 1 și invers (apără discriminatorul
    `data-cap-slot` — fără el, `querySelector` ar lua mereu prima zonă).
11. `capturaBloc(0,1)` citește din `imgs['o-cimg']`, nu din DOM-ul blocului.
12. ⭐ `colO().capturiBlocuri` are un element per bloc, în ordinea `bloc_idx`, iar
    `colO().captureImageBase64` e IDENTIC cu `capturiBlocuri[0].c1`.
13. `window.imgs` are exact 3 chei după crearea a două blocuri suplimentare.

### 9.3 Paritate — `server/tests/unit/ord-bloc-paritate.test.mjs`

Cele trei intrări marcate `#128n` din lista albă (`o-captura2-wrap`, `o-czone`, `o-czone2`) ies
din „lotul următor" și devin **`BLOCUL 0 — REZOLVAT la #128n`**, cu justificarea că zonele per
bloc se rezolvă prin `capZona()`/`data-role`, iar ce rămâne pe id e blocul 0.

⛔ **Nu presupune numerele de apariții.** Rulează testul, citește numărătorile REALE din eșec,
actualizează lista albă cu ele și **raportează diferența** față de valorile de azi (1/1/1),
cu explicația fiecărei creșteri. O creștere pe care nu o poți explica = semnal, nu ajustare.

---

## 10. Cache busting

Verifică pe cod, nu presupune:
```bash
grep -n "formular/core.js\|formular/doc.js\|formular/list.js" public/sw.js
# Așteptat: nicio linie (fișierele din public/js/formular/ NU sunt în PRECACHE_ASSETS)
```
Dacă e gol ⇒ **fără bump `CACHE_VERSION`**, doar `?v=3.9.774` ȚINTIT pe assetele chiar atinse.
`?v=` curent: `core.js` 3.9.773, `doc.js` 3.9.773, `list.js` 3.9.773, `draft.js` 3.9.768
(**draft.js NU se atinge, deci rămâne 3.9.768**).

Tiparul canonic, câte un `sed` per asset:
```bash
sed -i -E "s#(formular/core\.js\?v=)[0-9.]+#\13.9.774#g" public/*.html
```
⚠️ În `sed`, grupul se referă cu `\1`, **nu** cu `\g<1>`. După ORICE `sed` pe HTML, `grep` pe
linia atinsă: un `?v=` corupt nu pică niciun test și ajunge direct în producție cu pagina moartă.

---

## 11. Rulare, versionare, push

```bash
npm test
npm run test:db
```
⛔ „Skipped" NU e „passed". `test:db` e obligatoriu — e singura suită care lovește ruta reală.
Rețeta PG 17 efemer e în `CLAUDE.md` (⛔ „nu am Docker" nu e motiv de skip).

Bump la `3.9.774` în `package.json`;
`git commit -m "feat(#128n): capturi per furnizor (bloc_idx) - ultimul lot din seria 128"`;
`git push origin develop`.

---

## 12. Verificări de ieșire (verbatim în raport)

```bash
# 1 — ruta de capturi cheiată și pe bloc
grep -n "formulare_capturi" server/routes/formulare/shared.mjs
# Așteptat: DELETE, INSERT și SELECT conțin acum bloc_idx / COALESCE(bloc_idx, 0)

# 2 — harta globală NEATINSĂ
grep -n "window.imgs" public/js/formular/core.js
# Așteptat: o singură linie, cu EXACT cele 3 chei istorice

# 3 — helperii de captură sunt vizibili la handlerele delegate
grep -n "window.capSetBloc\|window.capturaBloc\|window.capSrcBloc\|window.capZona" public/js/formular/core.js

# 4 — șablonul de bloc nu a căpătat id-uri
grep -c "id=\"" public/js/formular/core.js
# Raportează valoarea și confirmă că e NESCHIMBATĂ față de înainte de patch

# 5 — capturile se randează per bloc, nu la coadă
grep -n "embedCapture" server/routes/formulare.mjs

# 6 — draft neatins + scopul lotului
git status --short
# Așteptat: draft.js ABSENT. ⚠️ working tree-ul are ~50 de fișiere netrackate din sesiuni
# vechi — confirmă EXPLICIT că ai stage-uit doar căile sarcinii

# 7 — zero migrații noi
grep -n "id: '10[0-9]_" server/db/index.mjs | tail -3
# Așteptat: se termină la 106_formulare_binare_bloc_idx

# 8 — ?v= țintit
grep -on "formular/\(core\|doc\|list\|draft\)\.js?v=[0-9.]*" public/formular.html
```

---

## 13. RAPORT FINAL

- commit hash + push confirmat; versiunea din `package.json`; `git log -1 --pretty=%s`
- `npm test` / `npm run test:db`: **numere REALE** (fișiere, passed, failed, skipped)
- ieșirea celor 8 verificări, **verbatim**
- ⭐ rezultatele cazurilor **1, 7, 8, 10 și 12**, menționate separat
- **care selector ai păstrat la §7.4/§7.5** (`.ord-bloc[data-bloc]` vs descendent) și de ce
- confirmarea că `showImg`/`clrImg`/`fimg`/`dov`/`dlv`/`ddp` și `uploadCaptura` sunt NEATINSE
- confirmarea că, la **un singur bloc**, ordinea în PDF e identică (conținut → captura 1 →
  captura 2 → footer) și că etichetele sunt byte-identice (`sufix` gol)
- confirmarea că `_capLabel1`/`_capLabel2` au fost MUTATE, nu redefinite (fără duplicat)
- lista albă din `ord-bloc-paritate.test.mjs`: numărătorile **noi reale** + explicația fiecărei
  creșteri
- confirmarea că `blocuri` JSONB și `BLOC_KEYS` au rămas la 8 chei
- dacă a fost nevoie de CSS nou (nu ar trebui — regulile sunt pe clasă)
- **orice abatere.** Dacă găsești o eroare în prompt, **spune-o, nu o repara tăcut**

---

## 14. ⛔ Constrângeri absolute

⛔ Branch `develop`. Fără `main`, fără `--amend`, fără `--force`.
⛔ Zero migrații, zero index, zero `NOT NULL`, zero `DEFAULT`.
⛔ `window.imgs` rămâne la 3 chei. `showImg`/`clrImg` rămân pe `getElementById`.
⛔ `blocuri` JSONB rămâne la cele 8 atribute XSD. Capturile NU intră acolo.
⛔ `draft.js` neatins. Capturile NU se salvează în localStorage.
⛔ Calea DF byte-identică. Zona NO-TOUCH de semnare neatinsă.
⛔ Blocul 0 rămâne pe handlerele inline; delegarea îl sare.
⛔ Zero refactorizări în trecere. Zero „îmbunătățiri" nemenționate aici.
