---
prompt: 159
titlu: "P0 — material criptografic STS scurs prin DTO-ul fluxului"
model_suggested: "Opus 5, efort high"
branch: develop
versiune_curenta: v3.9.814
versiune_tinta: v3.9.815
migratii: NU
fisiere_din_public: NU  (⇒ fără CACHE_VERSION, fără bump `?v=`)
zona_no_touch_atinsa: NU
---

# ⚠️ BRANCH

Lucrezi **EXCLUSIV pe `develop`**.
`main` = PRODUCȚIE și e gestionat **manual** de Mircea.
Nu propune și nu executa `checkout main`, `merge main`, `push origin main`.
Pasul final al acestui prompt este `git push origin develop`.

# ⛔ ZONA NO-TOUCH (CLAUDE.md, liniile 71–79)

Nu atingi, în niciun fel, în acest prompt:

- `server/signing/providers/STSCloudProvider.mjs`
- `server/routes/flows/cloud-signing.mjs`
- `server/routes/flows/bulk-signing.mjs`
- `server/signing/pades.mjs`
- `server/signing/java-pades-client.mjs`

Reparația de față este **etanșarea IEȘIRII**, nu oprirea la sursă. Oprirea persistenței
cheii (care ar cere `cloud-signing.mjs` + `STSCloudProvider.mjs`) este o decizie separată
a lui Mircea și **nu face parte** din acest prompt. Dacă ajungi într-un punct în care crezi
că trebuie atinsă zona NO-TOUCH ca să închei sarcina: **OPREȘTE-TE și raportează**.

---

## Contextul problemei (fapte verificate pe arhiva v3.9.814)

1. `server/signing/providers/STSCloudProvider.mjs:78` — `initiateSession()` întoarce
   `providerData` care conține `privateKeyPem` (cheia privată RSA a INSTITUȚIEI),
   `codeVerifier` (PKCE), `state`, `nonce`, `clientId`, `kid`.
2. `server/routes/flows/cloud-signing.mjs:817` — `signers[idx].stsProviderData = session.providerData`,
   urmat de `saveFlow()` ⇒ materialul ajunge în JSONB-ul fluxului. **Nu se șterge niciodată.**
   La fel `signers[i].stsToken` (access token OAuth), păstrat deliberat „ca urmă de audit"
   (`cloud-signing.mjs:634`).
3. `server/index.mjs:937` — `stripSensitive()` elimină **doar** `pdfB64`, `signedPdfB64`
   și tokenurile celorlalți semnatari. `stsProviderData`, `stsToken` și cheile
   `_rawPdf_<idx>` **trec** în răspuns.
4. `server/routes/flows/crud.mjs:719` — `GET /flows/:flowId` întoarce `_stripSensitive(...)`
   și e accesibil **cu token de semnatar** (semnatar extern, fără cont).
5. `server/routes/flows/signing.mjs:83` — `POST /flows/:flowId/sign` întoarce
   `flow: _stripPdfB64(data)`, iar `stripPdfB64` scoate **numai** cele două PDF-uri ⇒
   scurge `stsProviderData` **și tokenurile TUTUROR celorlalți semnatari**.
   Verificat: frontendul (`public/js/semdoc-signer/main.js:782-788`) citește doar
   `rSign.ok` și **ignoră complet** `jSign.flow` ⇒ se poate strânge fără regresie de UI.

Cauza structurală: cei doi serializatori sunt definiți **inline în `server/index.mjs`**,
unde nu pot fi testați unitar fără să pornească serverul. De aceea nu există niciun test
care să prindă un câmp-secret nou. Fixul mută serializarea într-un modul pur și adaugă
o poartă de regresie **recursivă** (cade pe orice cheie-secret, oriunde în DTO, nu doar
pe cele două pe care le știm azi).

---

## ETAPA 0 — verificarea ancorelor (READ-ONLY, obligatorie)

Rulează exact:

```bash
git branch --show-current                      # Așteptat: develop
git status --short                             # Așteptat: arbore curat (fără modificări)
node -p "require('./package.json').version"    # Așteptat: 3.9.814

grep -n "function stripSensitive" server/index.mjs        # Așteptat: 1 linie (937)
grep -n "function stripPdfB64" server/index.mjs           # Așteptat: 1 linie (932)
grep -rn "_stripPdfB64(" server/routes --include=*.mjs | grep -v "= d\."
# Așteptat: EXACT 1 linie — server/routes/flows/signing.mjs:83
grep -rn "_stripSensitive(" server/routes --include=*.mjs | grep -v "= d\."
# Așteptat: EXACT 1 linie — server/routes/flows/crud.mjs:719
ls server/services/flow-dto.mjs 2>/dev/null                # Așteptat: nu există
```

⛔ Dacă ORICARE dintre aserțiuni nu se potrivește (alt număr de apariții, alt fișier,
arbore murdar), **OPREȘTE-TE și raportează** fără să modifici nimic. Arhiva pe care s-a
scris promptul poate să nu fie identică cu repo-ul tău.

---

## ETAPA A — modul pur nou + testul adversarial (FĂRĂ cablare)

În această etapă **nu modifici niciun fișier existent**. Creezi exact două fișiere noi.

### A1. `server/services/flow-dto.mjs`

Conținut integral:

```js
/**
 * DocFlowAI — serializarea publică a fluxului (DTO)
 *
 * #159 (P0, audit extern v3.9.814). Sesiunea de semnare cloud persistă în
 * `signers[].stsProviderData` material criptografic al INSTITUȚIEI (cheia privată
 * PEM, `codeVerifier` PKCE, `state`/`nonce`, `clientId`, `kid`), iar în
 * `signers[].stsToken` access tokenul OAuth. Obiectul fluxului este citit și de
 * semnatarul EXTERN, pe bază de token opac — nu de sesiune autentificată. Deci
 * orice câmp lăsat în DTO părăsește serverul.
 *
 * Acesta este SINGURUL loc care decide ce iese. Funcțiile erau definite inline în
 * `server/index.mjs`, unde nu puteau fi testate fără să pornească serverul — exact
 * motivul pentru care scurgerea a trecut neobservată.
 *
 * ⚠️ Reparația de aici etanșează IEȘIREA. Oprirea persistenței (zona NO-TOUCH)
 * este o decizie separată. Până atunci, materialul rămâne în DB și se purjează
 * printr-un pas SQL manual.
 */

/** Câmpuri de sesiune cloud care nu au voie să iasă — nici la nivel de semnatar,
 *  nici la nivel de flux. */
export const SIGNER_SECRET_KEYS = Object.freeze(['stsProviderData', 'stsToken']);

/** Nume de chei care nu au voie să apară NICĂIERI în DTO-ul public, la nicio
 *  adâncime. Consumat de testul de regresie — dacă cineva adaugă mâine un câmp
 *  nou cu unul dintre aceste nume, testul cade înainte de deploy. */
export const FORBIDDEN_DTO_KEYS = Object.freeze([
  'privateKeyPem', 'privateKey', 'codeVerifier', 'codeChallenge',
  'clientSecret', 'clientAssertion', 'accessToken', 'refreshToken',
  'stsToken', 'stsProviderData',
]);

/** Elimină secretele de la nivelul fluxului: câmpurile `_rawPdf_<idx>` (PDF-ul
 *  brut pregătit pentru semnare, salvat temporar la inițierea sesiunii) și orice
 *  cheie din SIGNER_SECRET_KEYS ajunsă din greșeală la rădăcină. */
function _dropFlowSecrets(rest) {
  const out = { ...rest };
  for (const k of Object.keys(out)) {
    if (k.startsWith('_rawPdf_') || SIGNER_SECRET_KEYS.includes(k)) delete out[k];
  }
  return out;
}

/** Elimină secretele de sesiune de pe un semnatar. NU atinge `token` — decizia
 *  despre token aparține apelantului. */
function _dropSignerSecrets(s) {
  if (!s || typeof s !== 'object') return s;
  const out = { ...s };
  for (const k of SIGNER_SECRET_KEYS) delete out[k];
  return out;
}

/**
 * Variantă „ușoară": scoate doar PDF-urile (+ secretele). Păstrează tokenurile
 * semnatarilor — apelantul trebuie să știe ce face.
 */
export function stripPdfB64(data) {
  if (!data || typeof data !== 'object') return data;
  const { pdfB64, signedPdfB64, ...rest } = data;
  const out = { ..._dropFlowSecrets(rest), hasPdf: !!pdfB64, hasSignedPdf: !!signedPdfB64 };
  if (Array.isArray(data.signers)) out.signers = data.signers.map(_dropSignerSecrets);
  return out;
}

/**
 * Serializatorul public al fluxului. Scoate PDF-urile, secretele de sesiune cloud
 * și tokenurile semnatarilor — cu excepția tokenului apelantului însuși, de care
 * ecranul de semnare are nevoie.
 */
export function stripSensitive(data, callerSignerToken = null) {
  if (!data || typeof data !== 'object') return data;
  const { pdfB64, signedPdfB64, ...rest } = data;
  return {
    ..._dropFlowSecrets(rest),
    hasPdf: !!pdfB64,
    hasSignedPdf: !!(signedPdfB64 || (data.storage === 'drive' && (data.driveFileLinkFinal || data.driveFileIdFinal))),
    signers: (data.signers || []).map(s => {
      const { token, ...signerRest } = _dropSignerSecrets(s) || {};
      return callerSignerToken && s?.token === callerSignerToken
        ? { ...signerRest, token }
        : signerRest;
    }),
  };
}
```

### A2. `server/tests/unit/flow-dto-no-secrets.test.mjs`

Testul **importă din producție** (`server/services/flow-dto.mjs`) — nu redeclară logica.

Cerințe de conținut (scrie-l tu, respectând stilul suitei existente; minim aceste cazuri):

1. **Scaner recursiv, nu punctual.** O funcție locală de test care parcurge întreg
   obiectul serializat (obiecte + array-uri, orice adâncime) și întoarce lista cheilor
   găsite din `FORBIDDEN_DTO_KEYS`. Aserțiunea: listă goală.
2. **Scaner pe VALORI.** Aceeași parcurgere colectează valorile `string` și verifică
   să nu conțină un marker de cheie privată PEM. Construiește markerul prin
   concatenare la runtime (ex. `'BEGIN' + ' RSA PRIVATE KEY'`), ca fixtura să nu
   conțină un literal care să deranjeze grep-urile ulterioare.
3. **Fixtură realistă**, construită din structura reală: flux cu `pdfB64`,
   `signedPdfB64`, `_rawPdf_0`, `_rawPdf_1`, și doi semnatari, fiecare cu `token`,
   `stsProviderData: { privateKeyPem, codeVerifier, state, nonce, clientId, kid }`
   și `stsToken`.
4. `stripSensitive(flow, tokenSemnatar1)` — semnatarul 1 **își primește** tokenul,
   semnatarul 2 **nu**; niciunul nu primește `stsProviderData`/`stsToken`.
5. `stripSensitive(flow, null)` — niciun token în DTO.
6. `stripPdfB64(flow)` — secretele dispar, dar tokenurile **rămân** (comportament
   deliberat diferit; documentează-l în test).
7. **Caracterizare, ca să dovedim că nu am schimbat altceva**: `hasPdf`/`hasSignedPdf`
   se calculează ca înainte, inclusiv ramura Drive
   (`storage: 'drive'` + `driveFileLinkFinal` ⇒ `hasSignedPdf === true` chiar fără
   `signedPdfB64`), iar câmpurile normale ale fluxului (`flowId`, `docName`, `status`,
   `events`) sunt neatinse.
8. Intrări degenerate: `null`, `undefined`, string, flux fără `signers`.

### A3. Poarta obligatorie a Etapei A

```bash
git status --short
# Așteptat: EXACT 2 linii, ambele cu prefix "??":
#   ?? server/services/flow-dto.mjs
#   ?? server/tests/unit/flow-dto-no-secrets.test.mjs
node --check server/services/flow-dto.mjs
npx vitest run server/tests/unit/flow-dto-no-secrets.test.mjs   # Așteptat: toate verzi
```

⚠️ Poarta e pe `git status --short`, **nu** pe `git diff --stat` — acesta din urmă nu
vede fișierele netrackuite (lecția #124f).

⛔ Dacă apare a treia linie în `git status --short`, ai atins un fișier existent:
**oprește-te și raportează**.

---

## ETAPA B — cablarea

### B1. `server/index.mjs` — importă din modul, șterge definițiile locale

Adaugă importul lângă celelalte importuri de servicii (după linia 528,
`import { needsLargeBody } from './services/body-limit.mjs';`):

```js
import { stripSensitive, stripPdfB64 } from './services/flow-dto.mjs';
```

Apoi **șterge integral** cele două definiții locale.

`old_str`:

```js
function stripPdfB64(data) {
  if (!data || typeof data !== 'object') return data;
  const { pdfB64, signedPdfB64, ...rest } = data;
  return { ...rest, hasPdf: !!pdfB64, hasSignedPdf: !!signedPdfB64 };
}
function stripSensitive(data, callerSignerToken = null) {
  if (!data || typeof data !== 'object') return data;
  const { pdfB64, signedPdfB64, ...rest } = data;
  return {
    ...rest, hasPdf: !!pdfB64,
    hasSignedPdf: !!(signedPdfB64 || (data.storage === 'drive' && (data.driveFileLinkFinal || data.driveFileIdFinal))),
    signers: (data.signers || []).map(s => {
      const { token, ...signerRest } = s;
      return callerSignerToken && s.token === callerSignerToken ? { ...signerRest, token } : signerRest;
    }),
  };
}
```

`new_str`:

```js
// #159 — `stripPdfB64` / `stripSensitive` au fost mutate în
// `server/services/flow-dto.mjs` (modul pur, testabil fără să pornească serverul).
// Importate mai sus. `injectFlowDeps` le pasează mai departe, neschimbat.
```

⚠️ Verifică înainte că textul din `old_str` se potrivește **caracter cu caracter** cu
fișierul (inclusiv spațierea). Dacă nu, oprește-te — nu improviza un `old_str` mai larg.

Nu atinge apelul `injectFlowDeps({ ... stripSensitive, stripPdfB64 ... })` de la linia
~1594: numele importate satisfac shorthand-ul exact ca funcțiile locale.

### B2. `server/routes/flows/signing.mjs` — al doilea canal

Linia 83, în handlerul `POST /flows/:flowId/sign`.

`old_str`:

```js
awaitingUpload: true, flow: _stripPdfB64(data) });
```

`new_str`:

```js
awaitingUpload: true, flow: _stripSensitive(data, token) });
```

Motivul, de pus ca un comentariu de o linie deasupra apelului `return res.json(...)`:
răspunsul la semnare mergea cu tokenurile celorlalți semnatari în el; frontendul
(`semdoc-signer/main.js:788`) nu citește câmpul `flow`.

### B3. Verificări

```bash
node --check server/index.mjs
node --check server/routes/flows/signing.mjs
grep -c "function stripSensitive" server/index.mjs   # Așteptat: 0
grep -c "function stripPdfB64"    server/index.mjs   # Așteptat: 0
grep -n "from './services/flow-dto.mjs'" server/index.mjs   # Așteptat: 1 linie
grep -n "flow: _stripSensitive(data, token)" server/routes/flows/signing.mjs  # Așteptat: 1 linie
npm run check                                        # Așteptat: exit 0
```

### B4. Suitele complete

```bash
npm test
npm run test:db      # PostgreSQL 17 EFEMER, rețeta din CLAUDE.md (port 55432)
```

Poartă: `test:db` trebuie să fie **PASSED**, nu SKIPPED. „Skipped ≠ passed."

Dacă vreun test existent cade, **nu slăbi niciodată garda nouă ca să treacă testul**.
Analizează: dacă testul verifica prezența unui câmp-secret în răspuns, testul codifica
permisivitatea și se corectează (ca la #122); dacă verifică altceva, e regresie reală și
te oprești. Raportează fiecare test atins, cu justificarea, în RAPORT FINAL.

---

## ETAPA C — versionare și push

```bash
# package.json: 3.9.814 → 3.9.815
# ⛔ NU atinge CACHE_VERSION și NU face bump de `?v=` — niciun fișier din public/ nu e modificat.
git add server/services/flow-dto.mjs server/tests/unit/flow-dto-no-secrets.test.mjs \
        server/index.mjs server/routes/flows/signing.mjs package.json package-lock.json
git status --short          # verifică: doar fișierele sarcinii sunt stagiate
git commit -m "#159 P0: material criptografic STS nu mai iese prin DTO-ul fluxului (v3.9.815)"
git push origin develop
```

`git push origin develop` declanșează auto-deploy pe staging. **Fără push, commit-ul
rămâne local.** Pe `main` — niciodată.

---

## RAPORT FINAL (obligatoriu)

1. Rezultatul literal al fiecărei aserțiuni din Etapa 0 (ancorele s-au confirmat sau nu).
2. Poarta Etapei A: ieșirea exactă a lui `git status --short`.
3. Lista cazurilor de test scrise, cu ce dovedește fiecare.
4. Numărul de fișiere/teste la `npm test` și la `npm run test:db` (PASSED, nu SKIPPED).
5. Orice test existent atins: care, de ce, și de ce modificarea NU slăbește o gardă.
6. Hash-ul commitului și confirmarea push-ului pe `develop`.
7. **Constatări colaterale**: dacă ai găsit alt loc din care obiectul fluxului părăsește
   serverul fără să treacă prin `stripSensitive` (rută, WebSocket, webhook, email, export),
   îl RAPORTEZI — **nu-l repari** în acest prompt.

---

## ⛔ CONSTRÂNGERI ABSOLUTE

- Zero fișiere din zona NO-TOUCH. Zero fișiere din `public/`. Zero migrații.
- Nu atinge `server/routes/flows/crud.mjs` — apelul de la `:719` e deja corect prin
  `_stripSensitive`; devine sigur automat prin noua implementare.
- Nu converti serializarea semnatarilor la **allowlist** în acest prompt. E direcția
  corectă pe termen lung, dar cere inventarul câmpurilor consumate de frontend
  (`semdoc-signer`, `semdoc-initiator`, `flow`, `admin`) și e prompt separat. Aici
  reparăm scurgerea fără să riscăm regresie de UI.
- Nu șterge și nu modifica date din baza de date. Purjarea materialului deja persistat
  se face manual de Mircea, cu SQL separat, DUPĂ deploy.
- Nu redenumi chei tehnice de eveniment din audit.
- Dacă o verificare nu dă rezultatul așteptat: oprește-te și raportează. Un „Așteptat"
  care nu se potrivește înseamnă că premisa promptului e greșită, nu că trebuie forțat.
