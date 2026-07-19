---
fix: În raportul „Audit Log" al fluxului (JURNAL EVENIMENTE), evenimentele FLOW_TRANSMITTED și FLOW_ACKNOWLEDGED apar netraduse („FLOW TRANSMITTED"/„FLOW ACKNOWLEDGED") pentru că lipsesc din dicționarul EVENT_LABELS_RO. Se completează dicționarul + alte câteva chei din aceeași clasă care ar cădea pe fallback.
target_branch: develop
model_suggested: Sonnet 4.6 (Default) — adăugare de chei în dicționar, chirurgical; zero logică, zero frontend, zero semnare/ALOP
risk: MIC (aditiv, doar etichete de afișare la generarea PDF; nu atinge date, nu persistă nimic)
version: 3.9.627 → 3.9.628
---

# ⚠️ BRANCH `develop` EXCLUSIV — NU atinge `main`
TOATE comenzile pe `develop`. NU `checkout` / `merge` / `push` pe `main`. `main` = producție, gestionată manual de owner. La final: `git push origin develop` și **STOP**.

# Simptom (owner)
În raportul „Audit Log" al unui flux, secțiunea „JURNAL EVENIMENTE", două rânduri apar în engleză, majuscule cu spații: **FLOW TRANSMITTED** și **FLOW ACKNOWLEDGED**. Restul (FLUX CREAT, SEMNAT etc.) sunt corect în română.

# Cauză (confirmată în cod — NU e problemă de date/vechime flux)
`server/routes/admin/flows.mjs:530` — `EVENT_LABELS_RO` NU conține cheile `FLOW_TRANSMITTED` și `FLOW_ACKNOWLEDGED` (adăugate cu feature-ul de transmitere internă, dar neadăugate în dicționar). Fallback-ul `evLabel = (type) => EVENT_LABELS_RO[type] || (type||'').replace(/_/g, ' ')` (linia 539) le afișează brut. Traducerea se face la GENERARE, nu se persistă — deci fix-ul corectează retroactiv orice raport regenerat, inclusiv fluxurile vechi.

# Etapa 0 — caracterizare
```bash
cd $(git rev-parse --show-toplevel); git branch --show-current   # develop
echo "=== dictionarul + fallback ==="; sed -n '530,540p' server/routes/admin/flows.mjs
echo "=== tipuri de evenimente emise (ce ar mai putea cadea pe fallback) ==="; grep -rhoE "type: '[A-Z_]+'" server/index.mjs server/routes/flows/*.mjs | sort -u
echo "=== al doilea audit (formulare) — are aceeasi clasa de gol? ==="; grep -n "FORMULAR_AUDIT_LABELS\|FLOW_TRANSMITTED\|FLOW_ACKNOWLEDGED" server/routes/formulare/shared.mjs | head
```

# 🚫 REGULĂ ABSOLUTĂ — cheie tehnică ≠ etichetă de afișare
Tipurile de evenimente (`FLOW_TRANSMITTED`, `FLOW_ACKNOWLEDGED`, `SIGNED`, …) sunt **chei tehnice** care controlează funcționalitatea (notificări, timeline, filtre, comparații `e.type === '...'`) și apar în zeci de locuri (`index.mjs`, `flow.js`, servicii). **NU redenumi, NU „traduce", NU atinge NICIO cheie de eveniment nicăieri în cod.**
Se modifică EXCLUSIV **valorile** (textul din dreapta) din obiectul `EVENT_LABELS_RO` — adică eticheta afișată în PDF. Cheile din stânga (`'FLOW_TRANSMITTED':`) rămân byte-identice.
Interzis: orice `str_replace` / `sed` care schimbă string-ul `FLOW_TRANSMITTED` sau `FLOW_ACKNOWLEDGED` în afara poziției de CHEIE din acest dicționar. Dacă te trezești modificând un `e.type === 'FLOW_...'` sau un `type: 'FLOW_...'` — OPREȘTE, ai greșit fișierul/locul.

# Modificare — `server/routes/admin/flows.mjs`, `EVENT_LABELS_RO` (~530)
Adaugă cheile lipsă, în stilul existent (MAJUSCULE, text simplu fără emoji — fontul PDF n-are glyph-uri emoji; consecvent cu „FLUX CREAT"/„PDF SEMNAT INCARCAT"):
```js
'FLOW_TRANSMITTED': 'TRANSMIS INTERN',
'FLOW_ACKNOWLEDGED': 'CONFIRMAT PRIMIRE',
// aceeași clasă — chei care altfel cad pe fallback replace(/_/g,' ') dacă evenimentul se produce:
'AUTO_DELEGATED_LEAVE': 'DELEGAT AUTOMAT (CONCEDIU)',
'PRESIGNED_UPLOAD_DETECTED': 'PDF PRESEMNAT DETECTAT',
'TOKEN_REGENERATED': 'TOKEN REGENERAT',
```
> NU schimba fallback-ul (linia 539) — rămâne plasă pentru orice tip viitor neprevăzut. NU atinge logica de desenare, culorile, sortarea. Doar adaugi chei în obiect.

## Verificare al doilea raport (condiționată)
Dacă Etapa 0 arată că `server/routes/formulare/shared.mjs` (audit-ul de FORMULARE, `FORMULAR_AUDIT_LABELS`) chiar poate primi `FLOW_TRANSMITTED`/`FLOW_ACKNOWLEDGED` în `events`, adaugă acolo aceleași două etichete. Dacă audit-ul de formulare folosește ALTE tipuri de evenimente (tranziții de status DF/ORD) și NU aceste tipuri de flux → NU-l atinge (out of scope). Raportează care caz e.

# Verificare manuală (owner)
1. Regenerează „Audit Log" pentru fluxul din captură (`PT_2AABAE30F4`) → „JURNAL EVENIMENTE" arată acum „TRANSMIS INTERN" și „CONFIRMAT PRIMIRE" în loc de engleză.
2. Un flux fără transmitere internă → raportul e neschimbat (fără rânduri noi).
3. Restul etichetelor (FLUX CREAT, SEMNAT, PDF SEMNAT INCARCAT etc.) — neschimbate.

# Guardrails diff
EXCLUSIV: `server/routes/admin/flows.mjs` (+ opțional `server/routes/formulare/shared.mjs` dacă Etapa 0 confirmă), `package.json`. Fără frontend → fără `?v=`/`CACHE_VERSION`.
```bash
git diff --name-only | grep -E "cloud-signing|bulk-signing|signing\.mjs|pades|STSCloud|alop\.mjs|crud\.mjs|index\.mjs|flow-transmit\.mjs|\.html$|public/js" && echo "⛔ STOP: zonă interzisă/inutilă atinsă!" || echo "✅ doar generatorul de audit + package.json"
git diff server/routes/admin/flows.mjs | grep -nE "evLabel =|replace\(/_/g" && echo "verifică: fallback-ul NESCHIMBAT, doar chei adăugate în dict"
# GARDĂ cheie-tehnică: nicio cheie de eveniment redenumită nicăieri. Liniile ȘTERSE (-) nu trebuie să conțină un tip de eveniment
# (ar însemna că ai rescris o cheie/comparație, nu că ai adăugat o etichetă). Adăugările (+) în dict sunt OK.
git diff | grep -E "^-" | grep -E "FLOW_TRANSMITTED|FLOW_ACKNOWLEDGED|e\.type ===|type: '[A-Z_]+'" && echo "⛔ STOP: ai modificat/șters o CHEIE de eveniment, nu doar o etichetă!" || echo "✅ nicio cheie tehnică atinsă — doar valori adăugate în dict"
```

# Versiune
`package.json` 3.9.627 → 3.9.628. (Backend-only → fără bump `?v=`/`sw.js`.)

# La final
```bash
git add -A -- server/routes/admin/flows.mjs server/routes/formulare/shared.mjs package.json
git commit -m "fix(audit): traduceri RO pentru FLOW_TRANSMITTED/FLOW_ACKNOWLEDGED + alte chei din aceeași clasă în Audit Log (v3.9.628)"
git push origin develop
```
(Dacă `shared.mjs` n-a fost atins, scoate-l din `git add`.)
**STOP. NU merge/push pe `main`.** Raportează: (1) cele două chei din captură + cele 3 preventive adăugate; (2) fallback-ul neschimbat; (3) al doilea raport (formulare) — atins sau confirmat out-of-scope, cu motivul; (4) `npm test verde, fără regresii`, `npm run check` OK, v3.9.628.
