---
feat: Transmitere internă (repartizare) a documentului aprobat către utilizator SAU compartiment — motor + auto-transmit la finalizare (Etapa 1/2, BACKEND)
target_branch: develop
model_suggested: Opus 4.8 (atinge authz de flux + pipeline de notificare — rigoare pe acces și idempotență)
risk: MEDIU (authz nou pe vizualizare flux + cârlig în notify) — dar ADITIV, izolat, NO-TOUCH pe semnare integral
version: 3.9.600 → 3.9.601
---

# ⚠️ BRANCH `develop` EXCLUSIV
TOATE comenzile pe `develop`. NU `checkout` / `merge` / `push` pe `main`. `main` = producție, gestionată manual de owner. La final: `git push origin develop` și **STOP**.

# 🎯 Scop
După ce un flux e finalizat (semnat de toți), documentul semnat + atașamentele fluxului trebuie să ajungă, **prin aplicație**, la un **utilizator anume SAU la un compartiment întreg** care **nu a fost neapărat semnatar** — cu o **rezoluție** opțională. În Etapa 1 construim **motorul**: tabel + serviciu + acces + auto-transmit la finalizare + notificare. Configurarea destinatarilor se acceptă prin API (câmp nou pe creare flux); **UI-ul de alegere e Etapa 2** (prompt separat).

Terminologie domeniu: „repartizare / transmitere internă". Sursa de adevăr a accesului = tabelul nou `flow_recipients`.

# 🚫 NO-TOUCH (absolut)
Semnare: `server/signing/providers/STSCloudProvider.mjs`, `server/routes/flows/cloud-signing.mjs`, `server/routes/flows/bulk-signing.mjs`, `server/signing/pades.mjs`, `server/services/java-pades-client.mjs`, `server/routes/flows/signing.mjs`. **NU** adăuga cârlige în căile de finalizare — auto-transmit-ul trăiește EXCLUSIV în `notify()` din `server/index.mjs`, pe care toate le apelează.
Calcule financiare ALOP: neatinse (irelevante aici).
`_stripSensitive`, `getFlowData`, `saveFlow`, `canActorReadFlow` (semnătura publică) — le **refolosești**, nu le rescrii.

# Etapa 0 — caracterizare (OBLIGATORIU înainte de cod)
```bash
grep -n "function canActorReadFlow\|getFlowHandler\|_stripSensitive(enriched" server/routes/flows/crud.mjs
grep -n "async function notify(" server/index.mjs
sed -n '/async function notify(/,/^}/p' server/index.mjs | grep -n "ONCE_PER_FLOW_TYPES\|needsInApp\|INSERT INTO notifications\|return;" | head
grep -oE "id: '[0-9]{3}_[a-z_]+'" server/db/index.mjs | tail -3   # confirmă că 087 e ultima, 088 e liberă
grep -n "loadActorComp\|_userIsInComp" server/services/authz-formular.mjs
# Confirmă forma createFlow + unde se persistă flow.data:
grep -n "const createFlow\|body.docName\|body.signers\|saveFlow(" server/routes/flows/crud.mjs | head
```
Raportează pe scurt ce ai găsit (numele exact al handlerului GET, dacă anti-dup COMPLETED face `return;` devreme, id-ul ultimei migrații). Dacă 088 e ocupată, folosește următoarea liberă.

# Implementare

## 1. Migrație inline `088_flow_recipients` în `server/db/index.mjs`
Adaugă în array-ul de migrații inline (pattern `id: 'NNN_descriere'`, SQL idempotent, după 087):
```sql
CREATE TABLE IF NOT EXISTS flow_recipients (
  id                     BIGSERIAL   PRIMARY KEY,
  flow_id                TEXT        NOT NULL REFERENCES flows(id),
  org_id                 INTEGER     REFERENCES organizations(id),
  recipient_user_id      INTEGER     REFERENCES users(id),
  recipient_compartiment TEXT,
  rezolutie              TEXT,
  source                 TEXT        NOT NULL DEFAULT 'auto',   -- 'auto' | 'manual'
  transmitted_by         INTEGER     REFERENCES users(id),
  transmitted_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  acknowledged_at        TIMESTAMPTZ,
  CONSTRAINT flow_recipients_target_chk
    CHECK ( (recipient_user_id IS NOT NULL)::int + (NULLIF(TRIM(recipient_compartiment),'') IS NOT NULL)::int = 1 )
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_flow_recipient_user
  ON flow_recipients(flow_id, recipient_user_id) WHERE recipient_user_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_flow_recipient_comp
  ON flow_recipients(flow_id, TRIM(recipient_compartiment)) WHERE NULLIF(TRIM(recipient_compartiment),'') IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_flow_recipient_user ON flow_recipients(recipient_user_id, acknowledged_at);
CREATE INDEX IF NOT EXISTS idx_flow_recipient_comp ON flow_recipients(TRIM(recipient_compartiment)) WHERE NULLIF(TRIM(recipient_compartiment),'') IS NOT NULL;
```
CHECK-ul garantează **exact una** dintre țintă (user XOR compartiment). Unicitatea parțială → insert idempotent per (flux, țintă).

## 2. Serviciu nou `server/services/flow-transmit.mjs` (PUR de logică, fără UI)
Import `pool` din `../db/index.mjs`. Fără dependență de fișiere de semnare.

- `normalizeRecipients(raw)` → validează un array `[{ type:'user'|'comp', value, rezolutie? }]`:
  - `type:'user'` → `value` numeric (userId); `type:'comp'` → `value` string ne-gol (nume compartiment).
  - respinge intrări invalide; taie `rezolutie` la 2000 caractere; dedup pe (type,value). Max 20 destinatari. Întoarce lista curată (sau `[]`).
- `async transmitFlowTo(pool, { flowId, orgId, recipients, transmittedBy, source })`:
  - pentru fiecare destinatar: `INSERT ... ON CONFLICT DO NOTHING RETURNING id, recipient_user_id, recipient_compartiment`.
  - întoarce **doar rândurile nou inserate** (`newlyAdded[]`) — pe astea se trimit notificări (idempotent: re-rularea COMPLETED nu re-notifică).
  - `source` ∈ `{'auto','manual'}`.
- `async isFlowRecipient(pool, flowId, actor)` → `boolean`:
  - `true` dacă EXISTĂ rând cu `recipient_user_id = actor.userId`
  - SAU rând cu `TRIM(recipient_compartiment) = <compartimentul actorului>` (ne-gol). Compartimentul actorului: `loadActorComp(pool, actor.userId)` (din `authz-formular.mjs`) — refolosește, nu rescrie.
- `async resolveRecipientEmails(pool, newlyAdded)` → listă de `{ email }` pentru notificat:
  - user → email-ul userului; compartiment → toți userii cu acel `compartiment` (ne-șterși) din org. Dedup pe email lowercase.

Fără `console.log`; erorile se aruncă pentru handler/caller.

## 3. `server/routes/flows/crud.mjs`
### 3a. `createFlow` — acceptă + persistă `transmiteLaFinalizare` (config auto)
Citește `body.transmiteLaFinalizare`, trece prin `normalizeRecipients(...)`. Dacă rezultă listă ne-goală, salveaz-o în `flow.data.transmiteLaFinalizare` (același obiect `data` care se dă la `saveFlow`). Dacă lipsește/invalid → pur și simplu nu se setează (feature opt-in, back-compat total). **Nu** schimba nimic altceva din createFlow.

### 3b. GET flow handler — ramură de acces „destinatar"
În handlerul GET (`getFlowHandler`), în locul unde azi se face:
```js
if (!canActorReadFlow(actor, data, signerToken)) return res.status(403).json({ error: 'forbidden' });
```
înlocuiește cu un fallback async care păstrează comportamentul existent și adaugă doar destinatarii:
```js
if (!canActorReadFlow(actor, data, signerToken)) {
  const isRecipient = actor && await isFlowRecipient(pool, req.params.flowId, actor);
  if (!isRecipient) return res.status(403).json({ error: 'forbidden' });
}
```
Restul handlerului neschimbat — răspunsul trece deja prin `_stripSensitive(enriched, signerToken)` (destinatarul, fără token, primește vederea „curată": document + atașamente, fără tokenele semnatarilor). Fără regresie pentru init/semnatari/admin (aceștia trec deja prin `canActorReadFlow`).

## 4. `server/index.mjs` — auto-transmit în `notify()` la COMPLETED
Import sus: `import { transmitFlowTo, resolveRecipientEmails } from './services/flow-transmit.mjs';`

În `notify()`, **DUPĂ** garda anti-duplicat COMPLETED (deci rulează o singură dată, pe primul COMPLETED real) și fără să blocheze fluxul principal, adaugă un bloc protejat:
```js
// Auto-transmitere internă (repartizare) la finalizare — o singură dată.
// Rulează DUPĂ anti-dup COMPLETED; idempotent și prin ON CONFLICT în flow_recipients.
if (type === 'COMPLETED' && flowId) {
  try {
    const fdata = await getFlowData(flowId);
    const cfg = Array.isArray(fdata?.transmiteLaFinalizare) ? fdata.transmiteLaFinalizare : [];
    if (cfg.length) {
      const newly = await transmitFlowTo(pool, {
        flowId, orgId: fdata.orgId || null, recipients: cfg,
        transmittedBy: null, source: 'auto',
      });
      const targets = await resolveRecipientEmails(pool, newly);
      for (const t of targets) {
        if (!t.email) continue;
        // notificare dedicată destinatarului (tip REPARTIZAT ≠ COMPLETED → fără recursie/anti-dup COMPLETED)
        await notify({
          userEmail: t.email, flowId, type: 'REPARTIZAT',
          title: '📨 Document repartizat',
          message: `Documentul „${fdata.docName || 'document'}" v-a fost transmis spre luare la cunoștință.`,
        });
      }
    }
  } catch (e) {
    logger.warn({ err: e, flowId }, 'auto-transmitere internă eșuată (non-fatală)');
  }
}
```
IMPORTANT:
- Blocul e **non-fatal** (try/catch) — o eroare de transmitere NU trebuie să rupă notificarea COMPLETED către inițiator.
- `REPARTIZAT` e tip nou; `notify()` îl tratează prin ramura generică (in-app + WS + push). NU adăuga un template de email dedicat în Etapa 1 (dacă `notify` are un fallback de email generic, e ok; dacă nu, `REPARTIZAT` rămâne in-app/push — acceptabil pentru MVP).
- Recursia e sigură: apelul intern `notify(type:'REPARTIZAT')` nu intră în blocul COMPLETED.

# Teste (`server/tests/...`, DB autoritativ în CI)
Fișier nou `server/tests/unit/flow-transmit.test.mjs` (logică pură, fără DB unde se poate):
- `normalizeRecipients`: acceptă user+comp valide; respinge value gol/negativ; dedup; taie rezoluția; cap 20.

Fișier nou `server/tests/integration/flow-transmite-interna.test.mjs` (cu DB CI):
- `transmitFlowTo` de două ori pe aceeași țintă → a doua oară `newlyAdded=[]` (idempotent, ON CONFLICT).
- CHECK-ul respinge un rând cu ambele ținte NULL și unul cu ambele setate.
- `isFlowRecipient`: user destinatar → true; user din compartimentul destinatar → true; user străin → false.
- **Auto la COMPLETED**: creezi flux cu `data.transmiteLaFinalizare=[{type:'user',value:<id>}]`, apelezi `notify({type:'COMPLETED', flowId})`, verifici că apare un rând în `flow_recipients` ȘI o notificare `REPARTIZAT` pentru destinatar. Al doilea apel COMPLETED → NU dublează (anti-dup + ON CONFLICT).
- **Acces**: destinatarul ne-semnatar primește `200` pe `GET /flows/:id` (înainte de feature ar fi primit `403`); un user complet străin rămâne `403`.

`npm test verde, fără regresii` (suite-ul crește; nu hardcoda numărul). `npm run check` OK.

# Guardrails diff
`git diff --name-only` trebuie să atingă **EXCLUSIV**:
`server/db/index.mjs`, `server/services/flow-transmit.mjs` (nou), `server/routes/flows/crud.mjs`, `server/index.mjs`, `server/tests/unit/flow-transmit.test.mjs` (nou), `server/tests/integration/flow-transmite-interna.test.mjs` (nou), `package.json`.
```bash
git diff --name-only | grep -E "cloud-signing|bulk-signing|signing\.mjs|pades|STSCloud|java-pades|alop\.mjs|sqlRamas|sqlCrediteBugetareCol10" && echo "⛔ STOP: zonă interzisă atinsă!" || echo "✅ NO-TOUCH respectat"
git diff server/index.mjs | grep -n "async function notify" && echo "verifică: doar bloc adăugat în notify, semnătura neschimbată"
```
FĂRĂ frontend în Etapa 1 → **fără** `?v=` / `CACHE_VERSION` în `sw.js`. Doar bump `package.json` (3.9.600 → 3.9.601).

# La final
```bash
git add server/db/index.mjs server/services/flow-transmit.mjs server/routes/flows/crud.mjs server/index.mjs server/tests/unit/flow-transmit.test.mjs server/tests/integration/flow-transmite-interna.test.mjs package.json
git commit -m "feat(flows): motor transmitere internă (repartizare) + auto-transmit la finalizare către user/compartiment cu rezoluție (v3.9.601)"
git push origin develop
```
**STOP. NU merge/push pe `main`.** Raportează:
1. Guardrail NO-TOUCH (fișiere de semnare + calcule financiare neatinse).
2. Migrația 088 rulează idempotent; CHECK-ul „exact o țintă" activ.
3. `isFlowRecipient` acordă acces pe user ȘI pe compartiment; străinul rămâne 403.
4. Auto-transmit fires o singură dată pe COMPLETED (anti-dup + ON CONFLICT); notificarea COMPLETED către inițiator NU e afectată de eșecuri de transmitere.
5. Status CI (`npm test` verde, `npm run check` OK).

# Ce urmează (Etapa 2, prompt separat — NU o face acum)
UI în `semdoc-initiator`: selector destinatar (utilizator din org / compartiment) + câmp rezoluție, care trimite `transmiteLaFinalizare` în body-ul de creare flux. Opțional: tab „Primite / Repartizate mie" + buton „Confirm luare la cunoștință" (`acknowledged_at`) + rută manuală `POST /flows/:id/transmit` pentru repartizare ad-hoc pe fluxuri deja finalizate.
