---
prompt: 55
titlu: "fix(ALOP): DF pe fluxul de semnare rămâne „Completat" în lista DF — calea link-df-flow nu persistă status='transmis_flux'"
model_suggested: Opus 4.8
branch: develop
zona: ALOP · coerență status DF · integritate date
---

# ⛔ BRANCH DISCIPLINE — CITEȘTE ÎNTÂI
> **EXCLUSIV pe `develop`.** NU face `merge` / `push` / `checkout` pe `main`.
> `main` = producție, gestionat manual de owner. Deploy staging = push pe `develop`.
> Dacă vreun pas te-ar duce spre `main`, **OPREȘTE-TE** și raportează.

---

## Simptom (owner, producție/staging)
Un DF lansat pe fluxul de semnare **din ciclul ALOP** apare corect „**Pe flux — semnare**" în tab-ul ALOP, dar în **lista Document de Fundamentare** apare încă „**✅ Completat**" în loc de „**🔄 Trimis flux**". (Reproducere: cardul „Servicii iluminat public".)

## Cauză-rădăcină (confirmată în cod)
Asimetria DF↔ORD e **intenționată**: la DF, `transmis_flux` e **status REAL persistat** (nu derivat ca la ORD). Vezi `server/services/formular-shared.mjs` → `FORMULAR_TYPES.df.linkFlowSetsStatus = 'transmis_flux'` și testul `server/tests/db/formulare-status-display.test.mjs` (cazul DF „transmis_flux din status brut"). **NU uniformiza DF cu ORD.**

Există **două căi** de lansare a fluxului DF:
1. **Happy path** — `linkFlowFormular` (`formular-shared.mjs:483`), apelat din `POST /api/formulare-df/:id/link-flow`. Setează `flow_id` + `status='transmis_flux'` + sync `alop_instances.df_flow_id` + audit `transmis_flux`.
2. **Calea ALOP** — `POST /api/alop/:id/link-df-flow` (`server/routes/alop.mjs`, ~linia 891). Setează **doar** `alop_instances.df_flow_id` și copiază atașamentele DF→flux (necondiționat). **NU atinge `formulare_df`** → statusul DF rămâne `completed`.

Când fluxul e lansat pe calea ALOP (sau happy path-ul e sărit / dă 409 înghițit în frontend `public/js/semdoc-initiator/main.js:2256` — `catch(_){}`, fără check `_rLink.ok`), rezultatul e: ALOP știe („Pe flux"), dar lista DF nu („Completat").

## Fix (server-side, o singură zonă)
Fă `link-df-flow` **auto-suficient și pe status**, exact ca la atașamente (`server/services/formular-flow-attachments.mjs:21` codifică deja principiul: „calea ALOP necondiționată, fiindcă `linkFlowFormular` dă 409"). Oglindim `linkFlowFormular`, dar pe calea necondiționată ALOP.

### 1. `server/routes/alop.mjs` — în `POST /api/alop/:id/link-df-flow`
După UPDATE-ul care setează `df_flow_id` și lângă blocul de copiere atașamente (`if (alopRows[0].df_id) { ... copyFormularAttachmentsToFlow ... }`), adaugă persistarea statusului DF:

```js
// Persistă starea DF „pe flux" (ASIMETRIE DF: transmis_flux = status REAL, nu derivat).
// Mirror al linkFlowFormular, dar pe calea ALOP necondiționată (linkFlowFormular dă 409 aici).
// Idempotent: flip DOAR completed→transmis_flux. Gardă anti-deturnare: nu pe un flux DIFERIT.
if (alopRows[0].df_id) {
  try {
    const { rows: dfFlip } = await pool.query(
      `UPDATE formulare_df
         SET flow_id = $1,
             status  = 'transmis_flux',
             updated_at = NOW(), updated_by = $4
       WHERE id = $2 AND org_id = $3 AND deleted_at IS NULL
         AND status = 'completed'
         AND (flow_id IS NULL OR flow_id = $1)
       RETURNING id`,
      [flow_id, alopRows[0].df_id, actor.orgId, actor.userId]
    );
    if (dfFlip[0]) {
      await recordFormularAudit({
        orgId: actor.orgId, formType: 'df', formId: alopRows[0].df_id,
        actorId: actor.userId, actorEmail: actor.email,
        eventType: 'transmis_flux', fromStatus: 'completed', toStatus: 'transmis_flux',
        meta: { flow_id, via: 'alop_link_df_flow' },
      });
    }
  } catch (e) {
    logger.warn({ err: e, alopId: req.params.id }, '[ALOP] DF status→transmis_flux non-fatal');
  }
}
```

Import necesar în `alop.mjs` (dacă nu există deja):
```js
import { recordFormularAudit } from '../db/queries/formulare-audit.mjs';
```

**Note de corectitudine (respectă-le exact):**
- `status = 'completed'` în WHERE ⇒ **idempotent**: al doilea apel nu mai găsește rândul (status deja `transmis_flux`) → fără audit dublu, fără efect. NU folosi `CASE` fără filtru pe status (ar audita de două ori).
- `(flow_id IS NULL OR flow_id = $1)` ⇒ nu deturnăm un DF aflat pe un flux DIFERIT activ (oglindește garda 409 din happy path). Dacă e pe alt flux, DF-ul rămâne neatins (non-fatal, rar/zombi).
- **NU flipa** din `aprobat`/`returnat`/`de_revizuit`/`draft` — doar `completed→transmis_flux`.
- Cancel-ul resetează deja `transmis_flux→completed` (`crud.mjs:704`, `lifecycle.mjs:503`, `signing.mjs:122`) → simetria se închide corect.

### 2. ⛔ NU atinge calea ORD (`link-ord-flow`, ~linia 1090)
La ORD `transmis_flux` e **derivat în SQL** (`formulare/shared.mjs:577` COALESCE), NU persistat. Lasă `link-ord-flow` exact cum e. Asimetria e prin design.

### 3. Backfill (DATE — rulează pe staging; owner decide pentru prod)
DF-urile deja rupte (ex. „Iluminat public": `completed` + flux activ legat prin `df_flow_id`) nu se autorepară — le corectăm o singură dată, îngust și idempotent. **Scrie SQL-ul într-un fișier** `server/db/scripts/backfill-df-transmis-flux.sql` (NU îl rula automat pe prod — n-ai acces oricum; rulează-l pe staging după deploy pentru verificare owner):

```sql
-- Backfill idempotent: DF completed cu flux ACTIV legat prin ALOP → transmis_flux.
-- Îngust: doar rânduri cu flux real în curs (nici completed, nici cancelled).
UPDATE formulare_df fd
   SET status = 'transmis_flux', updated_at = NOW()
  FROM alop_instances a
  JOIN flows f ON f.id::text = a.df_flow_id
 WHERE a.df_id = fd.id
   AND a.df_flow_id IS NOT NULL
   AND a.cancelled_at IS NULL
   AND fd.status = 'completed'
   AND fd.deleted_at IS NULL
   AND (f.data->>'completed') IS DISTINCT FROM 'true'
   AND (f.data->>'status')    IS DISTINCT FROM 'cancelled';
```

## Plasă anti-regresie (test NOU)
Creează `server/tests/db/alop-link-df-flow-status.test.mjs` (oglindește stilul din `alop-link-flow-attachments.test.mjs` — același endpoint). Cazuri:
1. **DF completed + `link-df-flow` → `formulare_df.status='transmis_flux'`** și `GET /api/formulare/list?type=df` întoarce `badge_status='transmis_flux'` pentru rândul respectiv.
2. **Idempotență**: al doilea `link-df-flow` nu schimbă statusul și **nu** adaugă un al doilea eveniment de audit `transmis_flux`.
3. **Gardă anti-deturnare**: DF cu `flow_id` = alt flux ACTIV → `link-df-flow` cu flux nou NU-i schimbă statusul (rămâne neatins).
4. (opțional, simetrie) **ORD via `link-ord-flow` NU persistă `transmis_flux`** — `formulare_ord.status` rămâne `completed`, badge-ul vine din derivare.

`npm test verde, fără regresii`. Rulează și `npm run check`.

## Cache busting + versiune
- bump `package.json`: `3.9.635` → `3.9.636`.
- **Frontend neatins** (doar server + test) ⇒ **NU** e nevoie de `CACHE_VERSION` în `sw.js` și nici de `?v=` pe `list.js`. NU le modifica.

## Guardrails diff (rulează înainte de commit)
`git diff --name-only` trebuie să atingă **EXCLUSIV**:
`server/routes/alop.mjs`, `server/tests/db/alop-link-df-flow-status.test.mjs`, `server/db/scripts/backfill-df-transmis-flux.sql`, `package.json`.

```bash
git diff --name-only | grep -E "formulare/shared\.mjs|list\.js|formular-shared\.mjs|signing\.mjs|cloud-signing|pades|STSCloud|semdoc-initiator" \
  && echo "⛔ STOP: zonă interzisă atinsă!" || echo "✅ doar alop.mjs + test + backfill + package.json"
git diff server/routes/alop.mjs | grep -iE "link-ord-flow" \
  && echo "⚠️ verifică: NU trebuie modificată calea ORD!" || echo "✅ ORD neatins"
```

## La final
```bash
git add server/routes/alop.mjs server/tests/db/alop-link-df-flow-status.test.mjs server/db/scripts/backfill-df-transmis-flux.sql package.json
git commit -m "fix(alop): link-df-flow persistă status=transmis_flux pe DF (mirror linkFlowFormular, calea ALOP necondiționată) + backfill + test (v3.9.636)"
git push origin develop
```
**STOP. NU merge/push pe `main`.**

## Raportează
- confirmarea că testul nou e verde (4 cazuri) și suita rulează fără regresii;
- că `link-ord-flow` a rămas neatins (asimetria ORD păstrată);
- rezultatul backfill-ului pe staging (câte rânduri actualizate);
- confirmare owner pe staging: „Iluminat public" în lista DF → „🔄 Trimis flux", ALOP neschimbat („Pe flux — semnare").
