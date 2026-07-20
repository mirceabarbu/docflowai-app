---
fix: Transmiterea automată internă la finalizare nu înregistrează expeditorul → „Transmis de —". Se atribuie inițiatorul fluxului ca expeditor (transmitted_by), păstrând qualifier-ul „automat la finalizare".
target_branch: develop
model_suggested: Sonnet 4.6 (fix chirurgical: display + 1 migrație idempotentă; ZERO authz/financiar/semnare)
risk: MIC (aditiv, non-authz, non-financiar) — o valoare NULL devine id-ul inițiatorului, deja verificat server-side
version: 3.9.621 → 3.9.622
---

# ⚠️ BRANCH `develop` EXCLUSIV — NU atinge `main`
TOATE comenzile pe `develop`. NU `checkout` / `merge` / `push` pe `main`. `main` = producție, gestionată manual de owner. La final: `git push origin develop` și **STOP**.

# Simptom (owner)
La finalizarea unui flux cu transmitere automată internă către un compartiment, în tab-ul „📥 Primite" cardul arată **„Transmis de —"** (liniuță) — nu apare CINE a trimis. Vezi captura: „Transmis de — · … · compartiment Serviciul Buget".

# Cauză (confirmată în cod, NU presupusă)
Auto-transmit-ul la `COMPLETED` scrie expeditorul ca NULL:

- `server/index.mjs` (blocul auto-transmit din `notify()`, ~linia 1402): `transmitFlowTo(pool, { …, transmittedBy: null, source: 'auto' })` → `flow_recipients.transmitted_by = NULL`.
- `server/services/flow-transmit.mjs:167` — `listReceivedFor` face `LEFT JOIN users tb ON tb.id = fr.transmitted_by`; cu NULL → `transmitted_by_name` și `transmitted_by_email` sunt NULL.
- `public/js/notifications/notifications.js:210` — `const byWho = r.transmitted_by_name || r.transmitted_by_email || '—'` → afișează „—".
- Simetric, evenimentul `FLOW_TRANSMITTED` e pus cu `by: null` (`index.mjs` ~linia 1430), iar `public/js/flow/flow.js:250` afișează `ev.by ? resolveName(ev.by) : 'Transmis automat la finalizare'`.

# Decizie de domeniu (fixată, nu re-deschide)
La auto-transmit, **expeditorul = inițiatorul fluxului** (cel care a configurat `transmiteLaFinalizare` la creare). Fluxul are deja `data.initEmail`, verificat server-side (fix 29). Atribuim inițiatorul ca `transmitted_by`, dar **păstrăm** informația „automat la finalizare" (via `source:'auto'`), ca să nu pierdem distincția auto vs. manual. Dacă inițiatorul nu se rezolvă în `users` (email extern), rămâne NULL — comportament actual, fără regresie.

# Etapa 0 — caracterizare (rulează ÎNAINTE de orice modificare; raportează numerele reale de linie)
```bash
cd $(git rev-parse --show-toplevel)
git branch --show-current   # trebuie: develop

echo "=== blocul auto-transmit în notify() ==="
grep -n "transmittedBy: null\|source: 'auto'\|type: 'FLOW_TRANSMITTED'\|transmiteLaFinalizare" server/index.mjs

echo "=== byLabel timeline (Progres flux) ==="
grep -n "Transmis automat la finalizare\|resolveName(ev.by)" public/js/flow/flow.js

echo "=== ultima migrație inline ==="
grep -oE "id: '0[0-9]{2}_[a-z_]+'" server/db/index.mjs | tail -3
# Așteptat: …089_flow_recipient_acks, 090_flows_analyze_and_org_created_idx → a ta = 091

echo "=== testul de integrare al transmiterii ==="
ls server/tests/integration/flow-transmite-interna.test.mjs 2>/dev/null || echo "verifică numele exact al testului repartizării"
```

# Modificări

## 1. Backend — atribuie inițiatorul ca expeditor la auto-transmit
`server/index.mjs`, blocul `if (type === 'COMPLETED' && flowId)` din `notify()`.

**a.** ÎNAINTE de `transmitFlowTo`, rezolvă id-ul inițiatorului din `fdata.initEmail` (case-insensitive), non-fatal:
```js
let autoTransmittedBy = null;
if (fdata?.initEmail) {
  try {
    const { rows: initRows } = await pool.query(
      'SELECT id FROM users WHERE lower(email) = lower($1) LIMIT 1',
      [String(fdata.initEmail).trim()]
    );
    autoTransmittedBy = initRows[0]?.id ?? null;
  } catch { autoTransmittedBy = null; }
}
```

**b.** În apelul `transmitFlowTo`, înlocuiește `transmittedBy: null` cu `transmittedBy: autoTransmittedBy` (păstrează `source: 'auto'` neschimbat).

**c.** La construcția evenimentului `FLOW_TRANSMITTED` (`fdata.events.push({ … by: null … })`), înlocuiește `by: null` cu `by: fdata.initEmail || null` (păstrează `source: 'auto'`). Astfel `renderEvents`/`renderTimeline` rezolvă numele; `source:'auto'` păstrează qualifier-ul.

> NU schimba semnătura `transmitFlowTo`, `notify`, sau logica anti-dup. NU atinge notificarea `REPARTIZAT` către destinatari. Doar aceste 3 puncte.

## 2. Frontend — păstrează qualifier-ul „automat" ALĂTURI de nume în „Progres flux"
`public/js/flow/flow.js`, ~linia 250. Acum, dacă `ev.by` e setat, se pierde textul „automat la finalizare". Corectează astfel încât să afișeze ȘI numele, ȘI qualifier-ul când `source==='auto'`:
```js
const byLabel = (ev.by ? resolveName(ev.by) : '—')
  + (ev.source === 'auto' ? ' · automat la finalizare' : '');
```
(Secțiunea „Evenimente" din același fișier — `kind === 'FLOW_TRANSMITTED'`, ~linia 500 — deja adaugă „· automat la finalizare" din `e.source`, iar actorul „de cine" vine din `by`. Verifică doar că, cu `by` setat, actorul se rezolvă la numele inițiatorului; NU dubla qualifier-ul acolo.)

## 3. Migrație 091 — backfill idempotent pentru rândurile auto existente (rezolvă cardul din captură retroactiv)
`server/db/index.mjs`, imediat după `090_flows_analyze_and_org_created_idx`:
```js
{
  id: '091_flow_recipients_backfill_auto_initiator',
  sql: `
    UPDATE flow_recipients fr
       SET transmitted_by = u.id
      FROM flows f
      JOIN users u ON lower(u.email) = lower(f.data->>'initEmail')
     WHERE fr.flow_id = f.id
       AND fr.source = 'auto'
       AND fr.transmitted_by IS NULL
       AND f.data->>'initEmail' IS NOT NULL;
  `
}
```
Idempotentă (atinge doar `source='auto' AND transmitted_by IS NULL`; a doua rulare nu mai găsește nimic). NU rescrie evenimentele JSONB vechi (`by:null` istoric rămâne — pentru rândurile vechi timeline-ul „Progres flux" arată în continuare „Transmis automat la finalizare", ceea ce e corect și acceptabil; cardul din „Primite", sursa DB, se repară complet).

## 4. Test — extinde caracterizarea repartizării
În testul de integrare al transmiterii interne (din Etapa 0), adaugă un caz: flux cu `data.initEmail` = un user existent + `data.transmiteLaFinalizare` setat → apel `notify({type:'COMPLETED', flowId})` → asertează că rândul nou din `flow_recipients` are `transmitted_by = id-ul inițiatorului` (NU NULL). Caz secundar: inițiator cu email inexistent în `users` → `transmitted_by IS NULL` (fără eroare). Fără hardcodare de count.

# Verificare manuală (owner)
1. Creează flux cu auto-transmit către un compartiment, finalizează-l → în „📥 Primite", destinatarul vede **„Transmis de: {Nume inițiator}"**, nu „—".
2. Deschide fluxul → „Progres flux": „Transmis de {Nume} · automat la finalizare". „Evenimente": „📨 TRANSMIS INTERN … de {Nume} … · automat la finalizare".
3. Fluxul VECHI din captură (după deploy + migrația 091): cardul „Primite" arată acum inițiatorul.
4. Transmitere MANUALĂ (buton, dacă e testată) → expeditorul rămâne cel care a apăsat (neschimbat).

# Guardrails diff
`git diff --name-only` trebuie să atingă **EXCLUSIV**:
`server/db/index.mjs`, `server/index.mjs`, `public/js/flow/flow.js`, testul de integrare al repartizării, `public/*.html` (bump `?v=`), `public/sw.js`, `package.json`.
```bash
git diff --name-only | grep -E "cloud-signing|bulk-signing|signing\.mjs|pades|STSCloud|java-pades|alop\.mjs|flow-access\.mjs|flow-transmit\.mjs|crud\.mjs|transmit\.mjs" && echo "⛔ STOP: zonă interzisă/neatinsă atinsă!" || echo "✅ NO-TOUCH respectat (semnare + financiar + authz + serviciul transmit neatinse)"
git diff server/index.mjs | grep -n "async function notify" && echo "verifică: semnătura notify NESCHIMBATĂ; doar valorile transmittedBy/by în blocul COMPLETED"
```

# Cache busting + versiune
`package.json` 3.9.621 → 3.9.622. `CACHE_VERSION` în `public/sw.js`. `?v=3.9.622` DOAR pe `flow/flow.js` (singurul JS modificat) în HTML-urile care îl încarcă.

# La final
```bash
git add -A -- server/db/index.mjs server/index.mjs public/js/flow/flow.js server/tests/integration/flow-transmite-interna.test.mjs public/*.html public/sw.js package.json
git commit -m "fix(flows): auto-transmit intern înregistrează inițiatorul ca expeditor (nu mai apare „Transmis de —\") + backfill 091 (v3.9.622)"
git push origin develop
```
**STOP. NU merge/push pe `main`.** Raportează:
1. Guardrail NO-TOUCH: semnare + ALOP + `flow-access.mjs` + `flow-transmit.mjs` (serviciul) + `crud.mjs` neatinse; semnătura `notify` neschimbată.
2. Cele 3 puncte din `index.mjs` (rezolvare inițiator, `transmittedBy`, `by` eveniment); `source:'auto'` păstrat peste tot.
3. Migrația 091 rulează idempotent; câte rânduri auto a completat (raportează count-ul UPDATE-ului dacă e vizibil în log).
4. Testul nou: `transmitted_by` = inițiator la auto; NULL la email extern.
5. `npm test verde, fără regresii`; `npm run check` OK; v3.9.622.
