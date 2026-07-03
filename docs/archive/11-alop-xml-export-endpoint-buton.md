---
fix: Export XML oficial (DF + ORD) — endpoint + buton, validat XSD înainte de servire (Etapa 3/3)
target_branch: develop
model_suggested: Opus 4.8 (servire artefact financiar oficial; validare strictă înainte de export)
risk: SCĂZUT-MEDIU — endpoint nou + buton UI; read-only serialize+serve, zero logică financiară/semnare
version: 3.9.590 → 3.9.591
---

# ⚠️ BRANCH `develop` EXCLUSIV
Toate comenzile pe `develop`. NU `checkout/merge/push` pe `main`. La final `git push origin develop` și STOP.

## NO-TOUCH
- Lista de semnare (`STSCloudProvider.mjs`, `cloud-signing.mjs`, `bulk-signing.mjs`, `pades.mjs`, `java-pades-client.mjs`).
- **Sistemul de atașamente formular (zona fix 11):** `formulare_atasamente`, `formular-flow-attachments.mjs`, `linkFlowFormular`, `flows/crud.mjs`, `flows/lifecycle.mjs`. `git diff` curat.
- **Serializerii și schemele (Etapele 1–2):** `notafd-serializer.mjs`, `ordnt-serializer.mjs`, `format.mjs`, `schemas/*.xsd` — le REFOLOSEȘTI, NU le modifici. Testele NOTAFD/ORDNT existente trebuie să rămână verzi.
- Zero atingere a logicii financiare (calcule, plafoane, mașini de stare).

## Context
Etapele 1–2 au livrat serializerii puri DF (`serializeNotafd`) și ORD (`serializeOrdnt`), validați contra XSD pe exemplele MF. Acum îi expunem: endpoint care servește XML-ul + buton „Export XML" în detaliul DF/ORD. Documentul se încarcă deja XSD-shaped (`GET /api/formulare-df/:id` → `data` cu `Cif/…/sectiuneaA/sectiuneaB`; echivalent ORD).

## Decizii owner (confirmate)
1. **Validare înainte de servire:** endpoint-ul validează XML-ul contra XSD și **blochează (422)** cu mesaj clar dacă e invalid. Nu se exportă niciodată XML neconform. (Reviziile cu influențe negative — limitarea v0 — vor primi 422 cu motivul explicit; corect și transparent.)
2. **Gate:** export permis când documentul e **validat (Secțiunea A+B complete)** — pe draft validat ȘI pe finalizat (util pentru verificare înainte de semnare). Gate prin `computeFormularCapabilities`.
3. **Download** fișier `.xml` cu nume în stil MF.

## Etapa 0 — caracterizare
```bash
# 1. Încărcarea DF/ORD pe id + forma 'data' (XSD-shaped) + authz existent
sed -n '119,140p' server/routes/formulare/df.mjs
grep -n "router.get('/api/formulare-ord/:id'\|canViewFormular\|\.data\b" server/routes/formulare/ord.mjs server/routes/formulare/df.mjs | head
# 2. Unde se randează acțiunile în detaliul DF/ORD (lângă 'PDF semnat'/'Raport conformitate')
grep -rn "Raport conformitate\|PDF semnat\|renderActions\|df-action-btn\|caps\.\|capabilities" public/js/formular/doc.js public/js/formular/core.js | grep -iE "raport confor|pdf semnat|renderActions|caps\." | head
# 3. computeFormularCapabilities — unde adaug can_export_xml + ce flag indică 'validat A+B'
sed -n '1,60p' server/services/formular-capabilities.mjs
# 4. xmllint-wasm e devDependency (de mutat în dependencies)
grep -n "xmllint-wasm" package.json
```
Dacă forma diferă → OPREȘTE și raportează.

## Implementare

### 1. `package.json` — mută `xmllint-wasm` din `devDependencies` în `dependencies`
Validarea rulează acum la runtime (în endpoint), nu doar în teste. Păstrează aceeași versiune.

### 2. `server/services/alop-xml/validate.mjs` (NOU) — validator partajat
`async validateXml(xmlString, schemaName) -> { valid: boolean, errors: string[] }`. Încarcă XSD-ul din `schemas/${schemaName}` (`notafd_v0.xsd`/`ordnt_v0.xsd`), validează cu `xmllint-wasm`. Cache-uiește conținutul XSD în memorie (citire o singură dată). Pur, fără Express.

### 3. Endpoint-uri (în `df.mjs` și `ord.mjs`, lângă rutele existente)
`GET /api/formulare-df/:id/xml` și `GET /api/formulare-ord/:id/xml`:
- Authz: **același** ca `GET /api/formulare-df/:id` (`canViewFormular` sau echivalentul folosit). Nu slăbi authz-ul.
- Încarcă documentul; verifică gate-ul de capabilitate (`can_export_xml`). Dacă nu e exportabil → `409` cu mesaj („documentul nu este validat").
- Serializează (`serializeNotafd`/`serializeOrdnt`) → `validateXml`. 
  - valid → `200`, `Content-Type: application/xml; charset=utf-8`, `Content-Disposition: attachment; filename="<nume MF>.xml"`, corpul = XML.
  - invalid → `422` JSON `{ error: 'xml_invalid', details: errors }` (mesaj clar, ex. influențe negative neacceptate de schema v0).
- Dacă serializarea aruncă (ex. `strClamp` overflow, CIF invalid) → `422` cu mesajul erorii.
- **Nume fișier MF:** DF → `DocumentFundamentare_{YYYY}_{MM}_{DD}_{NrUnicInreg}.xml`; ORD → `OrdonantareDePlata_{YYYY}_{MM}_{DD}_{NrOrdonantPl}.xml` (data din `DataRevizuirii`/`DataOrdontPl`). Sanitizează componentele pentru numele de fișier.

### 4. `server/services/formular-capabilities.mjs` — `can_export_xml`
Adaugă `can_export_xml: false` în obiectul de capabilități și setează-l `true` când documentul are **Secțiunea A+B validate/complete** (folosește flagurile de stare existente care indică validarea — NU inventa stări noi). Permis pe draft validat și pe finalizat.

### 5. UI — buton „Export XML" în detaliul DF/ORD
- În zona de acțiuni a detaliului (lângă „PDF semnat"/„Raport conformitate"), randează butonul DOAR când `caps.can_export_xml`:
  ```
  <button class="df-action-btn sm" onclick="exportFormularXml('${type}','${esc(id)}')">Export XML</button>
  ```
  (`type` = `df`|`ord`; pattern identic cu butoanele existente, CSP-safe — fără date utilizator în handler dincolo de id-ul esc).
- Funcție globală `exportFormularXml(type,id)`: `fetch` la `/api/formulare-${type}/${id}/xml`. Pe `200` → descarcă blob-ul ca fișier (folosește numele din `Content-Disposition`). Pe `422`/`409` → afișează mesajul de eroare clar utilizatorului (ex. „Export blocat: …") — NU descărca. Tratează erorile fără a lăsa UI-ul într-o stare ambiguă.

## Teste
Adaugă `server/tests/...` pentru endpoint:
- DF validat → `200`, content-type XML, `Content-Disposition` cu nume MF, corp validează XSD.
- DF ne-validat (draft incomplet) → `409`.
- (dacă fezabil) DF cu influență negativă pe revizie → `422` (limitarea v0).
- ORD validat (exemplul Cap.IV) → `200`.
`npm test verde, fără regresii`. Testele serializer Etapele 1–2 neatinse, verzi. `npm run check` OK.

## Guardrails diff
`git diff --name-only` atinge EXCLUSIV: `package.json` (+ lock), `server/services/alop-xml/validate.mjs` (nou), `server/routes/formulare/df.mjs`, `server/routes/formulare/ord.mjs`, `server/services/formular-capabilities.mjs`, fișierul/fișierele JS de detaliu DF/ORD (buton + handler), `public/formular.html` (cache-bust), `public/sw.js`, plus testele noi.
```bash
git diff --name-only | grep -E "notafd-serializer|ordnt-serializer|alop-xml/format\.mjs|schemas/|formulare_atasamente|formular-flow-attachments|flows/crud|flows/lifecycle|STSCloud|cloud-signing|pades" && echo "⛔ STOP: zonă interzisă atinsă!" || echo "✅ zone protejate intacte"
```

## Cache busting + versiune
- bump `package.json`: `3.9.590` → `3.9.591`;
- `CACHE_VERSION` în `public/sw.js`;
- `?v=3.9.591` pe fișierele JS de detaliu modificate, în `public/formular.html`.

## La final
```bash
git add -A   # verifică întâi git diff --name-only contra listei de guardrails de mai sus
git commit -m "feat(alop-xml): export XML oficial DF+ORD (endpoint validat XSD + buton) (v3.9.591)"
git push origin develop
```
STOP. NU merge/push pe `main`. Raportează: output-ul guardrail-ului (zone protejate intacte), statusul testelor, și confirmă pe staging (owner): buton „Export XML" apare pe DF/ORD validat → descarcă `.xml` cu nume MF; pe document ne-validat butonul lipsește; un XML exportat validează manual contra schemei. Cu asta, funcția XML e end-to-end — generare → validare → export, gata pentru încărcare în Forexebug.
