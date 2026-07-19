---
fix: Plasă anti-regresie — test parametrizat care blochează TOATE stările de status afișate, DF + ORD
target_branch: develop
model_suggested: Sonnet 4.6 (matrice parametrizată DF+ORD; doar test, zero cod de producție)
risk: FOARTE SCĂZUT — doar fișier de test + bump versiune
version: 3.9.596 → 3.9.597
---

# ⚠️ BRANCH `develop` EXCLUSIV
Toate comenzile pe `develop`. NU `checkout/merge/push` pe `main`. La final `git push origin develop` și STOP.

## NO-TOUCH
TOT codul de producție. Atinge EXCLUSIV fișierul de test + `package.json`. `git diff --name-only` nu trebuie să arate `.mjs` din `server/routes/`, `server/services/`, `public/`.

## Scop
Statusul afișat e compus din `display_status` + `aprobat` + `status` (server) → badge (frontend). Saga ORD a regresat de mai multe ori fiindcă testele asertau câmpuri intermediare, nu badge-ul final. Construim o plasă unică: un test parametrizat care asertează **badge-ul final afișat** pe TOATE stările, pentru **ambele tipuri (DF + ORD)**, prin endpoint-ul real `/api/formulare/list`, cu fixture-uri realiste de flux.

**Diferența DF/ORD pe care testul o blochează explicit:**
- **DF**: `transmis_flux` e status REAL persistat (ramura DF din `/api/formulare/list` NU are `display_status`). Badge din status brut.
- **ORD**: `transmis_flux` e DERIVAT prin `display_status` (status brut rămâne `completed`; asimetria din `formular-shared.mjs`).

## Etapa 0 — caracterizare
```bash
cat server/tests/db/ord-display-status-list.test.mjs   # seedere de reutilizat
grep -n "display_status\|aprobat ?\|_stBadge\|row.status" public/js/formular/list.js   # formula badge-ului
# confirmă: ramura DF NU are display_status; ramura ORD are
grep -n "display_status\|AS aprobat" server/routes/formulare/shared.mjs
```
Confirmă formula EXACTĂ a badge-ului din `list.js` (așteptat `row.display_status || (row.aprobat ? 'aprobat' : row.status)`). Oglindește forma reală în helper.

## Implementare — `server/tests/db/formulare-status-display.test.mjs` (redenumit/extins din ord-display-status-list)
Reutilizează seederele existente (org, user, DF, flux, ORD; same actors pentru ambele tipuri). Helper care oglindește frontend-ul:
```js
// OGLINDEȘTE public/js/formular/list.js — ține-le sincron. (Pas viitor: sursă unică server-side.)
const effectiveBadge = (row) => row.display_status || (row.aprobat ? 'aprobat' : row.status);
```
Structurează ca matrice parametrizată cu dimensiunea `type` (`df`/`ord`). Fiecare caz: seedează → `GET /api/formulare/list?type=<t>` (autentificat) → găsește rândul în `body.rows` → `expect(effectiveBadge(row)).toBe(<așteptat>)` + aserții diagnostice.

### Matrice ORD (8 cazuri)
| ORD.status | flux (data / deleted_at) | badge | aserții diagnostice |
|---|---|---|---|
| `draft` | fără flux | `draft` | display_status==null |
| `pending_p2` | fără flux | `pending_p2` | display_status==null |
| `completed` | fără flux | `completed` | display_status==null, aprobat===false |
| `completed` | `{status:'pending'}` (FĂRĂ `completed`) | `transmis_flux` | display_status==='transmis_flux' |
| `completed` | `{completed:true}` | `aprobat` | display_status==null, aprobat===true |
| `aprobat` | `{completed:true}` | `aprobat` | (aprobat persistat — ciclul 1) |
| `completed` | `{status:'cancelled'}` | `completed` | display_status==null |
| `completed` | `{status:'pending'}` + `deleted_at` | `completed` | display_status==null |

### Matrice DF (6 cazuri)
| DF.status | flux (data / deleted_at) | badge | aserții diagnostice |
|---|---|---|---|
| `draft` | fără flux | `draft` | **display_status absent** (ramura DF nu-l are) |
| `pending_p2` | fără flux | `pending_p2` | display_status absent |
| `completed` | fără flux | `completed` | display_status absent, aprobat===false |
| `transmis_flux` | `{status:'pending'}` | `transmis_flux` | **din status brut** (NU din display_status) |
| `completed` | `{completed:true}` | `aprobat` | aprobat===true |
| `returnat` | flux refuzat/șters | `returnat` | display_status absent |

Note pentru fixture-uri (astea au lăsat regresiile să treacă):
- Flux „activ" → seedat **fără** cheia `completed` în `data` (NU `completed:false`) — cazul NULL prinde capcana `IS DISTINCT FROM`.
- ORD „aprobat persistat" (`status='aprobat'`) → verifică cazul ciclului 1.
- DF „pe flux" → seedat cu `status='transmis_flux'` (real) — și aserția că badge-ul vine din status brut, NU dintr-un `display_status` (care la DF trebuie să lipsească). Asta blochează introducerea accidentală a unei derivări la DF care ar strica cazul simetric.

## Teste
`npm test verde, fără regresii` (`node_modules` instalat, `xmllint-wasm` prezent). DB auto-skip local; autoritativ în CI. `npm run check` OK.

## Guardrails diff
```bash
git diff --name-only | grep -vE "tests/db/(formulare-status-display|ord-display-status-list)|package\.json" && echo "⛔ STOP: cod de producție atins!" || echo "✅ doar test + versiune"
```

## Versiune
- bump `package.json`: `3.9.596` → `3.9.597`.

## La final
```bash
git add server/tests/db/ package.json
git commit -m "test(status): matrice parametrizată DF+ORD — blochează toate stările badge-ului (anti-regresie) (v3.9.597)"
git push origin develop
```
STOP. NU merge/push pe `main`. Raportează: cele 14 cazuri (8 ORD + 6 DF), toate verzi în CI, helper-ul oglindește `list.js`, și confirmarea că DF nu expune `display_status` iar ORD da. (Reamintire: dacă badge-ul din `list.js` se schimbă, actualizează helper-ul — duplicarea o eliminăm la pasul de consolidare propus separat.)
