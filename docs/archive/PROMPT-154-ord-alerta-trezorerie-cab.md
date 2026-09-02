# PROMPT-154 — Avertizare „cont NU e de trezorerie" pentru Responsabilul CAB (ORD)

⚠️ BRANCH: develop — NICIODATĂ main. `main` e producția, gestionată manual doar de Mircea.

**model_suggested:** Sonnet 5 (fix chirurgical, strict frontend, zero backend, zero migrații)
**cache_version_bump:** NU — nici `list.js`, nici `doc.js`, nici `formular.html` nu sunt în
`PRECACHE_ASSETS` din `public/sw.js` (verificat: lista conține doar `notif-widget.js`,
`df-utils.js`, `df-entitlements.js` și fișierele `admin/*.js`)
**migrations:** NU
**target:** citește `package.json` ÎNAINTE de orice modificare și incrementează patch-ul cu
1; folosește acea valoare consecvent peste tot mai jos — NU presupune „3.9.811"

## Context

Responsabilul CAB deschide un ORD trimis de P1 (`status==='pending_p2'`, `role==='p2'`). În
acel moment `lockAll('ordnt', true)` (`doc.js`) dezactivează TOATE inputurile, inclusiv
câmpul IBAN beneficiar — deci evenimentul `focusout` care declanșează azi verificarea IBAN
(`_lookupByIban` din `public/js/formular/list.js`, legat prin delegare pe `focusout` în
`_wireBenefDelegation`) nu se mai produce NICIODATĂ pentru CAB. Ruta `/api/verify/iban`
(`server/services/verify/ibanValidator.mjs`, calcul local, fără rețea externă) întoarce deja
`isTreasury: boolean`, dar azi acest flag e folosit DOAR ca să adauge orașul/județul la
eticheta verde ("✓ IBAN valid · Trezoreria operativă X, jud. Y") — nu există niciun
avertisment separat când contul NU e de trezorerie.

Cerința lui Mircea: când Responsabilul CAB deschide documentul pentru
completare/verificare, platforma verifică automat contul (fără să aștepte interacțiune) și,
dacă NU e cont de trezorerie, afișează un banner de avertizare lângă câmpul IBAN.

Arhitectura ORD e multi-bloc (#128, un furnizor = un bloc `[data-bloc]`) — verificarea
trebuie să ruleze pe TOATE blocurile documentului, nu doar pe primul.

**Efect colateral asumat, de confirmat cu Mircea dacă nu e dorit:** fiindcă avertizarea se
adaugă în interiorul lui `_lookupByIban` (funcție PARTAJATĂ), ea va apărea și la P1, live,
la blur pe câmpul IBAN — nu doar la deschiderea de către CAB. Tratat ca beneficiu (P1 prinde
problema mai devreme), nu ca bug — dar semnalat explicit, fiindcă nu a fost cerut literal.

**Scop asumat:** verificarea de trezorerie se aplică doar IBAN-urilor RO (ramura `country
!== 'RO'` a funcției `_lookupByIban` rămâne neatinsă — un IBAN străin nu are cum să fie
trezorerie, deci un avertisment acolo ar fi zgomot, nu informație).

## Fișiere atinse (EXACT 4)

1. `public/js/formular/list.js` — extinde `_lookupByIban`, adaugă `_recheckAllOrdIbanuri`
2. `public/js/formular/doc.js` — declanșează verificarea la deschiderea de către CAB
3. `public/formular.html` — bump `?v=` țintit pe cele două fișiere de mai sus
4. `package.json` — bump patch

═══════════════════════════════════════════════════════════════════
## PASUL 0 — verificări obligatorii înainte de orice modificare
═══════════════════════════════════════════════════════════════════

```bash
git branch --show-current
# Așteptat: develop — dacă nu, STOP și treci pe develop înainte de orice altceva

git status --short
# Așteptat: gol, sau doar fișiere netrackuite deja cunoscute din sesiuni vechi —
# NICIUN fișier dintre cele 4 de mai sus (nu există încă modificări pe ele)

grep -rn "PROMPT-154" docs/archive/ 2>/dev/null
git log --all --oneline | grep -i "#154"
# Așteptat: ambele goale. Dacă #154 e deja folosit, OPREȘTE-TE și raportează —
# NU renumerota, ia următorul număr liber (regula de numerotare din CLAUDE.md)

grep '"version"' package.json
# Notează valoarea. Noua versiune = patch-ul curent + 1. Folosește-o consecvent
# în tot restul acestui prompt.
```

═══════════════════════════════════════════════════════════════════
## ETAPA A — extinde `_lookupByIban` cu avertizarea de trezorerie
═══════════════════════════════════════════════════════════════════

Fișier: `public/js/formular/list.js`

### A1. Patch pe corpul funcției (ramura RO, după verificarea de nume bancă)

```
old_str:
    const bankaEl=_bFld(bloc,'banca_beneficiar');
    const bankName=d.bankName||'';
    const declared=(bankaEl&&bankaEl.value||'').trim();
    if(!declared){
      if(bankaEl&&bankName)bankaEl.value=bankName;
      let extra='';
      if(d.isTreasury&&(d.treasuryCity||d.treasuryCounty)){
        extra=' · '+[d.treasuryCity,d.treasuryCounty].filter(Boolean).map(esc).join(', ');
      }
      _renderIbanStatusBadge(`<span style="${green}">✓ IBAN valid · ${esc(bankName)}${extra}</span>`,bloc);
    } else if(_normBankName(declared)===_normBankName(bankName)){
      _renderIbanStatusBadge(`<span style="${green}">✓ IBAN valid · ${esc(bankName)}</span>`,bloc);
    } else {
      _renderIbanStatusBadge(`<span style="${amber}">⚠ IBAN valid · derivat din IBAN: ${esc(bankName)} — banca declarată diferă</span>`,bloc);
    }

new_str:
    const bankaEl=_bFld(bloc,'banca_beneficiar');
    const bankName=d.bankName||'';
    const declared=(bankaEl&&bankaEl.value||'').trim();
    let mainHtml;
    if(!declared){
      if(bankaEl&&bankName)bankaEl.value=bankName;
      let extra='';
      if(d.isTreasury&&(d.treasuryCity||d.treasuryCounty)){
        extra=' · '+[d.treasuryCity,d.treasuryCounty].filter(Boolean).map(esc).join(', ');
      }
      mainHtml=`<span style="${green}">✓ IBAN valid · ${esc(bankName)}${extra}</span>`;
    } else if(_normBankName(declared)===_normBankName(bankName)){
      mainHtml=`<span style="${green}">✓ IBAN valid · ${esc(bankName)}</span>`;
    } else {
      mainHtml=`<span style="${amber}">⚠ IBAN valid · derivat din IBAN: ${esc(bankName)} — banca declarată diferă</span>`;
    }
    // #154 — avertizare INDEPENDENTĂ de potrivirea numelui băncii de mai sus: se poate
    // afișa ȘI alături de un status verde (bancă declarată corect, dar cont NU e trezorerie).
    const treasuryHtml=d.isTreasury?'':`<div style="${amber}margin-top:4px;">⚠ Cont NU este de trezorerie — verificați cu Serviciul Buget înainte de a continua.</div>`;
    _renderIbanStatusBadge(mainHtml+treasuryHtml,bloc);
```

Verificare:
```bash
grep -c "let mainHtml;" public/js/formular/list.js
# Așteptat: 1
grep -c "Cont NU este de trezorerie" public/js/formular/list.js
# Așteptat: 1
```

### A2. Funcție nouă — rulează verificarea pe TOATE blocurile, fără interacțiune

```
old_str:
  }finally{
    showSpin(false);
  }
}
window._lookupByIban=_lookupByIban;

new_str:
  }finally{
    showSpin(false);
  }
}
window._lookupByIban=_lookupByIban;

// #154 — Responsabil CAB: la deschiderea documentului (doc.js/openDoc), verifică automat
// TOATE conturile IBAN completate de P1, pe toate blocurile (#128). Nu așteaptă focusout —
// la P2 câmpurile sunt disabled prin lockAll(true), deci focusout nu se mai produce.
// Secvențial (nu Promise.all): /api/verify/iban e calcul local sincron server-side, costul
// e neglijabil chiar și pe multe blocuri, iar secvențial evită orice cursă pe DOM.
async function _recheckAllOrdIbanuri(){
  for(const bloc of _blocList()){
    const ibanEl=_bFld(bloc,'iban_beneficiar');
    if(ibanEl && (ibanEl.value||'').trim()) await _lookupByIban(ibanEl);
  }
}
window._recheckAllOrdIbanuri=_recheckAllOrdIbanuri;
```

Verificare:
```bash
grep -c "function _recheckAllOrdIbanuri" public/js/formular/list.js
# Așteptat: 1
grep -c "window._recheckAllOrdIbanuri=_recheckAllOrdIbanuri;" public/js/formular/list.js
# Așteptat: 1
```

═══════════════════════════════════════════════════════════════════
## ETAPA B — declanșează verificarea la deschiderea de către CAB
═══════════════════════════════════════════════════════════════════

Fișier: `public/js/formular/doc.js`

⚠️ Textul `status==='pending_p2'&&role==='p2'` apare DE DOUĂ ORI în fișier (o dată la
~linia 661, într-o altă funcție; o dată la ~linia 936, în `openDoc` — cea vizată aici).
Ancora de mai jos e mai lungă tocmai ca să fie unică; verifică oricum înainte de patch.

```bash
grep -c "if(ft==='ordnt')setModeP2Ord();else setModeP2Df();" public/js/formular/doc.js
# Așteptat: 1 — dacă nu, STOP, fișierul s-a schimbat față de premisa promptului
```

```
old_str:
    }else if(status==='pending_p2'&&role==='p2'){
      if(ft==='ordnt')setModeP2Ord();else setModeP2Df();
      setLockedBar(ft,'Completați câmpurile dvs. (marcate) și apăsați Finalizez.','info');

new_str:
    }else if(status==='pending_p2'&&role==='p2'){
      if(ft==='ordnt'){
        setModeP2Ord();
        // #154 — non-blocant: bannerele de trezorerie apar progresiv (ca și spinnerul
        // existent la verificarea IBAN), nu se așteaptă înainte de a continua randarea.
        if(typeof _recheckAllOrdIbanuri==='function')_recheckAllOrdIbanuri();
      }else setModeP2Df();
      setLockedBar(ft,'Completați câmpurile dvs. (marcate) și apăsați Finalizez.','info');
```

Verificare:
```bash
grep -c "_recheckAllOrdIbanuri()" public/js/formular/doc.js
# Așteptat: 1
```

═══════════════════════════════════════════════════════════════════
## ETAPA C — versionare + cache-bust
═══════════════════════════════════════════════════════════════════

- `package.json`: `"version"` → patch-ul curent + 1 (valoarea notată la Pasul 0)
- `public/formular.html`: bump `?v=` DOAR pe cele două linii de mai jos (⛔ NU bulk-sed pe
  alte scripturi — regula din CLAUDE.md §Cache busting; `?v=` țintit per asset atins):
  - `formular/list.js?v=3.9.798` → noua versiune
  - `formular/doc.js?v=3.9.809` → noua versiune
- `public/sw.js` / `CACHE_VERSION` — NU se atinge (niciunul din cele 3 fișiere nu e în
  `PRECACHE_ASSETS`)

Verificare:
```bash
grep -n "formular/list.js?v=\|formular/doc.js?v=" public/formular.html
# Așteptat: ambele linii cu noua versiune, identică între ele
```

═══════════════════════════════════════════════════════════════════
## ETAPA D — teste
═══════════════════════════════════════════════════════════════════

`list.js`/`doc.js` sunt scripturi clasice mari, fără infrastructură de test comportamental
azi (același motiv ca la #113b: comportamentul relevant — flag-ul `isTreasury` — e deja
acoperit de `server/services/verify/__tests__/ibanValidator.test.mjs` și
`server/tests/unit/iban-validator.test.mjs`; ce se adaugă azi e strict orchestrare DOM).
NU inventa un test happy-dom pentru asta. Adaugă în schimb un test STATIC minimal (pe
modelul analizei prin `readFileSync` + regex, ca `admin-cancel-ui.test.mjs`), care verifică:

1. `list.js` conține `Cont NU este de trezorerie`
2. `list.js` conține `function _recheckAllOrdIbanuri`
3. `doc.js` conține `_recheckAllOrdIbanuri()`
4. `doc.js` conține apelul respectiv ÎN VECINĂTATEA imediată a lui
   `status==='pending_p2'&&role==='p2'` — nu doar prezența separată a celor două șiruri

```bash
npm test
# Așteptat: verde, 0 failed (NU hardcoda numărul total de teste — suita crește)
```

═══════════════════════════════════════════════════════════════════
## RAPORT FINAL (obligatoriu în răspunsul tău)
═══════════════════════════════════════════════════════════════════

- Versiune veche → nouă (`package.json`)
- Commit hash + mesaj de commit
- `git diff --stat` (confirmă EXACT 4 fișiere: `list.js`, `doc.js`, `formular.html`,
  `package.json`, plus testul nou)
- Rezultat `npm test` (fișiere/teste, 0 failed)
- Confirmare explicită, prin citire directă a codului (nu presupunere): apelul
  `_recheckAllOrdIbanuri()` rulează STRICT în ramura P2/`pending_p2` din `openDoc` — și NU
  în ramura P1/`pending_p2`, nici în ramura `completed`/`aprobat`
- Orice abatere de la prompt, cu motivul

═══════════════════════════════════════════════════════════════════
## ⛔ CONSTRÂNGERI ABSOLUTE
═══════════════════════════════════════════════════════════════════

- ⛔ NU atinge `server/services/verify/ibanValidator.mjs` sau ruta `/api/verify/iban` —
  `isTreasury` există deja și e corect calculat; acest lot e strict frontend
- ⛔ NU atinge DF (`notafd`) — ORD e singurul formular cu câmpuri de beneficiar/IBAN;
  cerința lui Mircea e explicit scopată la ORD
- ⛔ NU bulk-sed toate `?v=` din `formular.html` — doar cele două linii numite la Etapa C
- ⛔ NU atinge `CACHE_VERSION` din `sw.js`
- ⛔ NU propune niciodată merge/push/checkout pe `main` — doar Mircea face asta, manual
- ⛔ Dacă `#154` e deja folosit (Pasul 0), OPREȘTE-TE și raportează — nu renumerota

Ultimul pas, obligatoriu:
```bash
git push origin develop
```
