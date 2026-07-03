---
fix: Upload atașament eșuează („rețea") la nume de fișier cu diacritice — encodare header X-Filename
target_branch: develop
model_suggested: Opus 4.8 (zonă sensibilă de atașamente — fix mic, dar guardrails stricte pe pipeline-ul fix 11)
risk: SCĂZUT — 2 linii (encode client + decode server) pe calea de upload direct; zero atingere a pipeline-ului de copiere
version: 3.9.591 → 3.9.592
---

# ⚠️ BRANCH `develop` EXCLUSIV
Toate comenzile pe `develop`. NU `checkout/merge/push` pe `main`. La final `git push origin develop` și STOP.

## NO-TOUCH semnare (standard)
`STSCloudProvider.mjs`, `cloud-signing.mjs`, `bulk-signing.mjs`, `pades.mjs`, `java-pades-client.mjs`. `git diff` curat.

## ⛔ NO-TOUCH — pipeline-ul de copiere atașamente (zona fix 11)
NU atinge: `server/services/formular-flow-attachments.mjs`, `linkFlowFormular` (`formular-shared.mjs`), `server/routes/flows/crud.mjs`, `server/routes/flows/lifecycle.mjs`. Acest fix e DOAR pe calea de upload direct al atașamentului (header X-Filename) — nu atinge copierea formular→flux.

## Context — cauză confirmată
La upload, `public/js/formular/doc.js:1013` pune numele fișierului crud în header HTTP: `'X-Filename': item.name`. Valorile de header HTTP trebuie să fie Latin-1 (ISO-8859-1). Diacriticele românești (ț U+021B, ă U+0103, î, ș, â) NU sunt în Latin-1 → `fetch()` aruncă sincron `TypeError` la construirea cererii → cade în `catch(e)` care etichetează generic `_err='rețea'` (`doc.js:~1031`). De aceea serverul nici nu vede cererea (nu e 4xx/5xx). Simptom: „Upload eșuat: rețea — se reîncearcă la următoarea salvare" pe orice fișier cu diacritice în nume (ex. „Plan de acțiune propus.pdf"). Fișierele ASCII trec.

Captura (`doc.js:971`, `X-Filename: captura_..._.png`) folosește nume ASCII auto-generat — **safe, NU se atinge**.

## Caracterizare-întâi (confirmă)
```bash
# Locul exact (client raw + server raw, zero encode)
grep -n "X-Filename" public/js/formular/doc.js server/routes/formulare/shared.mjs
# Confirmă că NU există deja encode/decode pe calea de upload atașament
grep -n "encodeURIComponent\|decodeURIComponent" public/js/formular/doc.js | grep -i "filename\|x-fil" || echo "(fără encode pe filename — confirmat)"
```

## Implementare (2 linii + test)

### 1. Client — `public/js/formular/doc.js` (~l.1013, în `uploadAttachments`)
Encodează numele înainte de a-l pune în header:
```js
'X-Filename': encodeURIComponent(item.name || 'atasament'),
```
`encodeURIComponent` produce doar ASCII → valid ca valoare de header. NU atinge linia capturii (971).

### 2. Server — `server/routes/formulare/shared.mjs` (~l.170, endpoint POST atașament)
Decodează defensiv (compatibil și cu valori vechi ne-encodate):
```js
let filename = req.headers['x-filename'] || '';
try { filename = decodeURIComponent(filename); } catch { /* valoare ne-encodată/legacy — lasă crud */ }
if (!filename) filename = `atasament_${Date.now()}`;
```
NU atinge endpoint-ul de captură (`shared.mjs:~68`) — capturile rămân ASCII ne-encodate.

### 3. Test — extinde testul de integrare existent
În `server/tests/integration/formulare-atasamente.test.mjs` (sau un test surori), adaugă un caz cu nume cu diacritice care **oglindește clientul** (trimite encodat, așteaptă stocat decodat):
```js
.set('X-Filename', encodeURIComponent('Plan de acțiune propus.pdf'))
// … așteaptă ca filename-ul stocat/returnat să fie exact 'Plan de acțiune propus.pdf'
```
Testele existente cu nume ASCII (`'factura.pdf'`) trebuie să rămână verzi (`decodeURIComponent('factura.pdf') === 'factura.pdf'`).

## Compatibilitate
Atașamentele vechi: cele ASCII sunt neschimbate; cele cu diacritice nu existau (upload-ul lor arunca, nu ajungeau în DB). Zero migrare. Decodarea defensivă (try/catch) tratează grațios orice valoare legacy ne-encodată.

## Guardrails diff
`git diff --name-only` atinge EXCLUSIV: `public/js/formular/doc.js`, `server/routes/formulare/shared.mjs`, testul de integrare, `public/formular.html` (cache-bust), `public/sw.js`, `package.json`.
```bash
git diff --name-only | grep -E "formular-flow-attachments|formular-shared|flows/crud|flows/lifecycle|STSCloud|cloud-signing|pades" && echo "⛔ STOP: zonă fix 11 / semnare atinsă!" || echo "✅ zone protejate intacte"
git diff public/js/formular/doc.js | grep -n "X-Filename" # confirmă: DOAR linia 1013 atinsă, NU 971 (captura)
```

## Teste
`npm test verde, fără regresii`. Cazul cu diacritice trece; cazurile ASCII existente neschimbate. `npm run check` OK.

## Cache busting + versiune
- bump `package.json`: `3.9.591` → `3.9.592`;
- `CACHE_VERSION` în `public/sw.js`;
- `?v=3.9.592` pe `doc.js` în `public/formular.html`.

## La final
```bash
git add public/js/formular/doc.js server/routes/formulare/shared.mjs server/tests/integration/formulare-atasamente.test.mjs public/formular.html public/sw.js package.json
git commit -m "fix(atasamente): encodare X-Filename pentru nume cu diacritice (upload nu mai eșuează cu 'rețea') (v3.9.592)"
git push origin develop
```
STOP. NU merge/push pe `main`. Raportează: guardrail-ul (zonă fix 11 intactă), că DOAR linia 1013 (nu 971) a fost atinsă, status teste. Confirmare owner pe staging: atașează un fișier cu diacritice în nume pe o ORD → se încarcă fără „rețea", numele stocat e corect (cu diacritice).
