---
fix: În Audit Log, secțiunea „ACCESURI ÎNREGISTRATE", etichetele lungi de eveniment (EMAIL_OPENED + cele 2 de reinițiere) depășesc lățimea coloanei „Eveniment" (115px) și se rup pe mai multe rânduri care calcă peste rândul următor. Se dau etichete COMPACTE proprii acestei secțiuni, fără a atinge dicționarul partajat (JURNAL rămâne descriptiv) și fără a atinge nicio cheie de eveniment.
target_branch: develop
model_suggested: Sonnet 4.6 (Default) — mapare de etichete locale secțiunii; zero logică, zero backend nou
risk: FOARTE MIC (doar text afișat într-o secțiune de raport)
version: 3.9.629 → 3.9.630
---

# ⚠️ BRANCH `develop` EXCLUSIV — NU atinge `main`
TOATE comenzile pe `develop`. NU `checkout` / `merge` / `push` pe `main`. La final: `git push origin develop` și **STOP**.

# 🚫 REGULĂ ABSOLUTĂ (ca la 48) — cheie tehnică ≠ etichetă
NU redenumi, NU „traduce", NU atinge NICIO cheie de eveniment (`EMAIL_OPENED`, `FLOW_REINITIATED`, …) nicăieri în cod — controlează funcționalitatea. Se schimbă EXCLUSIV **textul afișat**. NU atinge dicționarul partajat `EVENT_LABELS_RO` (l-ar strica în „JURNAL EVENIMENTE").

# Simptom (owner, captură)
În „ACCESURI ÎNREGISTRATE", rândul cu „EMAIL DESCHIS DE DESTINATAR" se rupe pe 3 rânduri; ultimul („DESTINATAR") coboară și dă peste cap alinierea coloanelor.

# Cauză (confirmată în cod)
`server/routes/admin/flows.mjs`, secțiunea ACCESURI (~linia 878-895): coloana „Eveniment" e desenată cu `maxWidth:115` (linia ~892), iar rândul avansează fix `y -= 13` (un singur rând). Etichete peste ~19 caractere se rup și se suprapun. Offenderi în lista de tipuri afișate aici (`IN (...)`, ~linia 858):
- `EMAIL_OPENED` → „EMAIL DESCHIS DE DESTINATAR" (27) — cel din captură
- `FLOW_REINITIATED` → „FLUX REINITIAT DUPA REFUZ" (25) — latent (flux reinițiat)
- `FLOW_REINITIATED_AFTER_REVIEW` → „FLUX REINITIAT DUPA REVIZUIRE" (29) — latent
(„PDF SEMNAT INCARCAT" / „EMAIL EXTERN TRIMIS" = 19 car. încap — sunt limita practică.)
> „JURNAL EVENIMENTE" NU are bug: acolo eticheta se desenează FĂRĂ `maxWidth` (linia ~810), deci nu se rupe. De aceea NU atingem dicționarul partajat.

# Etapa 0 — caracterizare
```bash
cd $(git rev-parse --show-toplevel); git branch --show-current   # develop
echo "=== randul ACCESURI (maxWidth 115) ==="; sed -n '878,895p' server/routes/admin/flows.mjs
echo "=== tipurile afisate in ACCESURI ==="; sed -n '855,862p' server/routes/admin/flows.mjs
echo "=== JURNAL deseneaza fara maxWidth (nu-l atingem) ==="; sed -n '808,812p' server/routes/admin/flows.mjs
```

# Modificare — `server/routes/admin/flows.mjs`, DOAR secțiunea ACCESURI
Chiar înainte de bucla `for (const ar of accessRows)` (sau imediat după, înainte de `const evType = ...`), adaugă o mapare compactă LOCALĂ secțiunii și folosește-o cu fallback pe `evLabel`:
```js
// Etichete compacte DOAR pentru tabelul ACCESURI (coloana „Eveniment" = 115px).
// Dicționarul partajat EVENT_LABELS_RO rămâne descriptiv pentru JURNAL EVENIMENTE.
const ACCESS_SHORT_LABELS = {
  EMAIL_OPENED: 'EMAIL DESCHIS',
  FLOW_REINITIATED: 'FLUX REINITIAT',
  FLOW_REINITIATED_AFTER_REVIEW: 'REINITIAT REVIZUIRE',
};
```
În buclă, înlocuiește:
```js
const evType = evLabel(ar.event_type || '');
```
cu:
```js
const evType = ACCESS_SHORT_LABELS[ar.event_type] || evLabel(ar.event_type || '');
```
> Atât. NU schimba `maxWidth`, NU muta coloanele, NU atinge `evLabel`, `EVENT_LABELS_RO`, JURNAL, sau culorile pe rând (`rowColor`). „DE DESTINATAR" e redundant — coloana „Actor" arată deja cine a deschis.

# Verificare manuală (owner)
1. Regenerează Audit Log pentru un flux cu email deschis (ca în captură) → „ACCESURI" arată „EMAIL DESCHIS" pe UN rând; coloanele Actor/IP aliniate.
2. Regenerează Audit Log pentru un flux **reinițiat** → „FLUX REINITIAT" / „REINITIAT REVIZUIRE" pe un rând, fără wrap.
3. „JURNAL EVENIMENTE" (aceleași evenimente) → etichetele DESCRIPTIVE rămân neschimbate (ex. „EMAIL DESCHIS DE DESTINATAR" acolo unde încap).

# Guardrails diff
EXCLUSIV: `server/routes/admin/flows.mjs`, `package.json`. Fără frontend → fără `?v=`/`CACHE_VERSION`.
```bash
git diff --name-only | grep -vE "server/routes/admin/flows\.mjs|package\.json" | grep . && echo "⛔ STOP: alt fișier atins!" || echo "✅ doar admin/flows.mjs + package.json"
git diff | grep -E "^-" | grep -E "EMAIL_OPENED:|FLOW_REINITIATED|e\.type ===|event_type ===|EVENT_LABELS_RO" && echo "⛔ STOP: ai atins o CHEIE / dicționarul partajat / o comparație!" || echo "✅ nicio cheie/comparație/dicționar partajat atins — doar mapare locală adăugată"
```

# Versiune
`package.json` 3.9.629 → 3.9.630. (Backend-only → fără `?v=`/`sw.js`.)

# La final
```bash
git add -A -- server/routes/admin/flows.mjs package.json
git commit -m "fix(audit): etichete compacte în ACCESURI ÎNREGISTRATE (email deschis + reinițiere) ca să nu se rupă pe coloane; dicționarul JURNAL neatins (v3.9.630)"
git push origin develop
```
**STOP. NU merge/push pe `main`.** Raportează: (1) mapare locală adăugată în secțiunea ACCESURI, cele 3 etichete lungi compactate; (2) dicționarul partajat `EVENT_LABELS_RO` + JURNAL + cheile neatinse; (3) `maxWidth`/coloane neschimbate; (4) `npm test verde, fără regresii`, `npm run check` OK, v3.9.630.
