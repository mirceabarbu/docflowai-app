---
prompt: 125 — URGENT (incident în producție)
titlu: Semnatari blocați definitiv în „Așteptăm aprobarea ta pe email / PUSH" — eroare STS clasificată ca „waiting" + butonul Anulează fără efect
model_suggested: Opus 4.8
branch: develop
version_bump: 3.9.753 → 3.9.754
migratii: NU
cache_version_bump: DA — se ating fișiere din PRECACHE_ASSETS (verifică pe fișier, nu presupune)
---

# ⚠️⚠️ BRANCH: `develop` — EXCLUSIV ⚠️⚠️
Pasul final OBLIGATORIU: `git push origin develop`. NICIODATĂ pe `main`.
```
git fetch origin && git status && git log --oneline --graph --all -6
```
Pe `develop`, curat, aliniat cu `origin/develop` (v3.9.753).

# 🔴 EXCEPȚIE DELIBERATĂ DE LA ZONA NO-TOUCH 🔴
În mod normal `server/signing/providers/STSCloudProvider.mjs` și `server/routes/flows/cloud-signing.mjs` sunt NO-TOUCH. **Acest prompt le atinge**, pentru că defectul e chiar în ele și blochează utilizatori în producție de 2 zile.
Reguli speciale pentru această excepție:
- **Diff minim.** Modifici DOAR ce e descris mai jos. Nicio refactorizare, nicio „îmbunătățire pe drum", nicio redenumire.
- ⛔ NU atingi criptografia: construcția CMS, `injectCms`, `javaFinalizePades`, ByteRange, construcția `client_assertion`, ordinea semnedAttrs. Nimic din calea care produce semnătura.
- ⛔ NU atingi ramura de succes (`pollResult.ready === true`) din `sts-poll`. Rămâne byte-identică.
- Dacă un pas te obligă să atingi altceva decât e listat, OPREȘTE-TE și raportează.

---

# CONTEXT — lanțul cauzal, verificat pe cod

1. `server/signing/providers/STSCloudProvider.mjs:258-260` — `pollSignatureResult` are
   `catch(e) { return { ready: false, message: e.message }; }` — **fără `error: true`**.
   Când STS răspunde cu corp gol / non-JSON, `await resp.json()` (linia 240) aruncă
   `SyntaxError: Unexpected end of JSON input`, care ajunge în `message`.
2. `server/routes/flows/cloud-signing.mjs:386-392` — `if (!pollResult.ready) { if (pollResult.error) {…} return res.json({ status:'waiting', message: pollResult.message }); }`
   ⇒ o eroare **permanentă** e raportată clientului ca „mai așteptăm".
3. `public/js/semdoc-signer/main.js:434` afișează `'⏳ ' + j.message` ⇒ pe ecranul
   utilizatorului apare textul brut „Unexpected end of JSON input".
4. `signers[idx].stsPending` rămâne `true` în DB — se pune `false` doar pe ramura de
   eroare sau de succes, la care nu se ajunge niciodată.
5. La refresh, `server/routes/flows/signer-status.mjs:48` întoarce
   `shouldResumePoll: signer.stsPending === true && !!signer.stsOpId`, iar
   `main.js:1282` repornește polling-ul ⇒ **bucla se reia la infinit, zile întregi**.
6. Butonul „Anulează" (`main.js:408` → `cancelStsPolling`, `main.js:473`) face DOAR
   `clearInterval` + `loadFlow()`. Dar `startStsPolling` a distrus conținutul original
   al lui `#signBox` (`main.js:390`, `signBox.innerHTML = …`), iar `loadFlow` nu-l
   reconstruiește niciodată (îi schimbă doar `opacity`/`display`) ⇒ ecranul rămâne
   identic, deci pare că butonul e mort. În plus **NU există nicio rută de server care
   să pună `stsPending=false`**, deci chiar și cu ecranul refăcut, refresh-ul reia bucla.

Fapte suplimentare verificate:
- NU există câmp `stsPendingAt`. `stsPending=true` se scrie la `cloud-signing.mjs:345`, iar în aceeași salvare se setează `data.updatedAt`.
- Clientul renunță după `STS_POLL_MAX = 60` × 3s = 3 minute (`main.js:383`).
- `cancelStsPolling` E funcție globală (depth 0) — inline `onclick` o găsește. ⛔ Nu „repara" scope-ul, nu e acolo problema.

⛔ ZONĂ NO-TOUCH care RĂMÂNE intactă: `bulk-signing.mjs`, `pades.mjs`, `java-pades-client.mjs`, `bulk-signer.js`.

===============================================================================
# ETAPA A — server: eroarea nu mai poate fi confundată cu așteptarea
===============================================================================

## Pas A1 — `STSCloudProvider.pollSignatureResult` (`:232-261`)

Două schimbări, ambele în interiorul acestei funcții:

**(a) Nu mai apela `resp.json()` orbește.** Citește întâi corpul ca text; dacă e gol sau nu se parsează, tratează-l explicit ca eșec de transport, nu ca excepție generică:
```js
const raw = await resp.text();
if (!raw || !raw.trim()) {
  logger.warn({ stsOpId, httpStatus: resp.status }, 'STS: corp gol la /callback');
  return { ready: false, transient: true,
    message: 'Serviciul STS nu a răspuns complet. Reîncercăm...' };
}
let json;
try { json = JSON.parse(raw); }
catch {
  logger.warn({ stsOpId, httpStatus: resp.status, bodyPreview: raw.slice(0, 200) },
    'STS: răspuns non-JSON la /callback');
  return { ready: false, transient: true,
    message: 'Răspuns invalid de la serviciul STS. Reîncercăm...' };
}
```
⛔ `bodyPreview` DOAR în log, niciodată în `message` (poate conține date sensibile).

**(b) `catch`-ul final marchează tranzitoriu ȘI nu mai scurge textul excepției:**
```js
} catch(e) {
  logger.warn({ err: e, stsOpId }, 'STS: poll error (se va reîncerca)');
  return { ready: false, transient: true,
    message: 'Eroare de comunicare cu STS. Reîncercăm...' };
}
```
⛔ NU pune `error: true` aici — o pană de rețea de o secundă chiar e tranzitorie. Distincția „tranzitoriu la nesfârșit ⇒ abandon" o face Pasul A2, pe vârstă.

## Pas A2 — `sts-poll`: abandon pe vârstă (`cloud-signing.mjs:386-392`)

Problema reală nu e un poll eșuat, ci că `stsPending` nu expiră NICIODATĂ. Adaugă o limită de vârstă, ÎNAINTE de a răspunde `waiting`:

- vârsta = `now - (signer.stsPendingAt || data.updatedAt)`; dacă niciuna nu se parsează, tratează ca 0 (fail-safe: nu abandona o semnare pe care n-o poți data).
- prag: **30 de minute** (clientul renunță la 3 minute; 30 lasă loc pentru aprobare întârziată pe email, dar nu lasă nimic blocat peste noapte). Constantă numită, comentată.
- la depășire: `signers[idx].stsPending = false`, `data.signers = signers`, `await saveFlow(...)`, apoi `return res.json({ status:'error', message: 'Sesiunea de semnare STS a expirat. Reîncearcă semnarea.' })`.
- ⛔ NU marca semnatarul ca `status:'error'` și NU scrie `signError*` — semnătura n-a eșuat criptografic, doar sesiunea a expirat; semnatarul trebuie să poată reîncerca normal.

## Pas A3 — `stsPendingAt` (`cloud-signing.mjs:345`)
Lângă `signers[signerIdx].stsPending = true;` adaugă `signers[signerIdx].stsPendingAt = new Date().toISOString();`.
Retrocompatibil: fluxurile vechi n-au câmpul, iar A2 cade pe `data.updatedAt`. ⛔ Fără migrație — e JSONB.

## Pas A4 — rută NOUĂ de anulare
`POST /flows/:flowId/sts-cancel` în `cloud-signing.mjs`, lângă `sts-poll`.
- autentificare **identică cu `sts-poll`**: `token` din query sau `x-signer-token`, apoi `signers.findIndex(s => s.token === signerToken)`; `-1` ⇒ 400 `invalid_token`. ⛔ Nu inventa alt model de autorizare, nu accepta index din body.
- efect: `signers[idx].stsPending = false`, `data.signers = signers`, `data.updatedAt`, `saveFlow`. Adaugă un event `{ type:'STS_CANCELLED', by: signer.email, order: signer.order, at, provider:'sts-cloud' }` în `data.events` (creează array-ul dacă lipsește — tiparul există în ramura `SIGN_FAILED`).
- idempotentă: dacă `stsPending` e deja `false` ⇒ `200 { ok:true, alreadyCancelled:true }`, NU eroare.
- ⛔ NU șterge `stsOpId`/`stsToken`/`stsCertPem` — sunt urmă de audit.
- ⛔ NU atinge `signer.status`.

===============================================================================
# ETAPA B — frontend: butonul chiar anulează, iar ecranul se reface
===============================================================================
Fișier: `public/js/semdoc-signer/main.js`.

## Pas B1 — salvează markup-ul original al lui `#signBox`
În `startStsPolling`, ÎNAINTE de `signBox.innerHTML = …`, memorează conținutul într-o variabilă la nivel de modul (ex. `_signBoxBackup`). Salvează o SINGURĂ dată (dacă e deja setată, n-o suprascrie — polling-ul poate reporni).

## Pas B2 — `cancelStsPolling` devine async și face trei lucruri
```js
async function cancelStsPolling() {
  if (_stsPollInterval) { clearInterval(_stsPollInterval); _stsPollInterval = null; }
  try {
    await _apiFetch(`/flows/${encodeURIComponent(flow)}/sts-cancel?token=${encodeURIComponent(token)}`,
      { method: 'POST', headers: { 'Content-Type': 'application/json' } });
  } catch (e) {
    console.warn('[STS] sts-cancel a eșuat:', e);   // continuăm oricum cu restaurarea UI
  }
  const signBox = $('signBox');
  if (signBox && _signBoxBackup) { signBox.innerHTML = _signBoxBackup; }
  await loadFlow();
}
```
⚠️ `cancelStsPolling` e apelată și din bucla de polling (`main.js:422` timeout, `:463` eroare) — verifică AMBELE apeluri după ce devine async. Dacă lăsarea lor fără `await` produce o cursă (ex. `showError` scrie în `#signBox` înainte ca restaurarea să se termine, și mesajul e pierdut), ordonează-le explicit. ⛔ Nu lăsa un `showError` să dispară — utilizatorul trebuie să vadă de ce s-a oprit.
⚠️ Butonul are `onclick="cancelStsPolling()"` inline; o funcție async e apelabilă așa, dar respingerea devine unhandled. Asigură-te că nimic din corp nu poate arunca (fetch-ul e deja în try).

## Pas B3 — feedback pe buton (previne exact dublările de la #124)
La click: `disabled = true` + text „Se anulează...", restaurat în `finally`. Oglindește tiparul din `alopDeschideDF` (`formular/alop.js:837`).

## Pas B4 — nu mai afișa niciodată text brut de excepție
`main.js:434` (ramura `waiting`) și `:463` (ramura `error`): mesajul de la server e deja prietenos după Etapa A, dar adaugă o plasă — dacă `j.message` conține „JSON", „undefined", „TypeError", „SyntaxError" sau e mai lung de 160 de caractere, afișează un text generic („Se verifică statusul semnării...", respectiv „Eroare la semnare. Reîncearcă.") și trimite originalul în `console.warn`.

===============================================================================
# ETAPA C — teste
===============================================================================
Importă din PRODUCȚIE, nu redeclara logica.

## Pas C1 — `server/tests/unit/sts-poll-clasificare.test.mjs` (NOU)
Cu `pollSignatureResult` mock-uit (⛔ zero apeluri reale către STS):
1. corp gol ⇒ `{ready:false, transient:true}`, iar `message` NU conține „JSON".
2. corp non-JSON („`<html>502 Bad Gateway</html>`") ⇒ idem.
3. excepție de rețea ⇒ `transient:true`, mesaj prietenos, fără textul excepției.
4. `errorCode === CLBK_WAIT` ⇒ `waiting` (comportamentul legitim NU s-a schimbat).
5. răspuns valid cu `signByte` ⇒ `ready:true` (ramura de succes intactă).

## Pas C2 — `server/tests/db/sts-poll-expirare.test.mjs` (NOU)
1. semnatar cu `stsPendingAt` acum ⇒ `sts-poll` întoarce `waiting`, `stsPending` rămâne `true`.
2. semnatar cu `stsPendingAt` acum − 31 min ⇒ `status:'error'`, iar în DB `stsPending === false`.
3. flux vechi FĂRĂ `stsPendingAt`, cu `data.updatedAt` acum − 31 min ⇒ același rezultat (retrocompatibilitate).
4. `POST /sts-cancel` cu token valid ⇒ 200, `stsPending===false` în DB, event `STS_CANCELLED` prezent.
5. `POST /sts-cancel` de două ori ⇒ a doua oară 200 `alreadyCancelled:true`.
6. `POST /sts-cancel` cu token străin ⇒ 400 `invalid_token`, `stsPending` NESCHIMBAT în DB.

## Pas C3 — structural pe frontend
`main.js` conține `_signBoxBackup`, apelul la `/sts-cancel`, și restaurarea `signBox.innerHTML`.

===============================================================================
# ETAPA D — versionare, cache, rulare, push
===============================================================================
- `package.json`: `3.9.753` → `3.9.754`.
- ⚠️ `public/js/semdoc-signer/main.js` — verifică în `public/sw.js` dacă e în `PRECACHE_ASSETS`. Dacă DA ⇒ **bump obligatoriu `CACHE_VERSION`** (citește valoarea curentă din fișier, nu presupune). Plus `?v=` țintit pe `semdoc-signer.html`. ⛔ Fără bulk-sed.
- `npm test` + `npm run test:db` (rețeta PG 17 efemeră) — ambele VERZI, `test:db` PASSED REAL.
```
git add -A
git commit -m "fix(#125): STS poll — eroare tranzitorie nu mai e raportată ca waiting, expirare stsPending la 30 min, rută sts-cancel + butonul Anulează restaurează UI — v3.9.754"
git push origin develop
```

===============================================================================
# RAPORT FINAL
===============================================================================
- Commit: ______ · push: ______
- `npm test`: ____ / ____ (verde?) · `npm run test:db`: ____ / ____ PASSED REAL?
- A1: mesajele întoarse spre client mai conțin vreodată textul excepției? ______
- A2: pragul ales și ce se întâmplă când NICIUN timestamp nu se poate parsa: ______
- A4: `sts-cancel` folosește EXACT modelul de autorizare din `sts-poll`? ______
- B2: cele două apeluri interne la `cancelStsPolling` (timeout + eroare) — s-a schimbat ceva după trecerea la async? A rămas vizibil `showError`? ______
- CACHE_VERSION: `semdoc-signer/main.js` e în PRECACHE? valoare veche → nouă: ______
- Ramura de succes (`pollResult.ready === true`) a rămas neatinsă? (arată `git diff` pe acel bloc) ______
- Abateri + motiv: ______

# ⛔ CONSTRÂNGERI
- ⛔ Diff minim în zona de semnare. Zero refactorizări. Ramura de succes intactă.
- ⛔ Nicio atingere a criptografiei (CMS, ByteRange, signedAttrs, client_assertion, Java finalize).
- ⛔ Fără migrații (`stsPendingAt` e JSONB).
- ⛔ Niciun apel real către STS în teste.
- ⛔ Textul excepțiilor rămâne în loguri, niciodată pe ecranul utilizatorului.
- ⛔ Citește fiecare fișier înainte de patch; `old_str` unic.
