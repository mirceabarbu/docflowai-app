---
title: "Facturi — F1 backend (modul + notificare CAB pe lichidare + endpoint centralizator)"
branch: develop
model_suggested: Opus 4.8   # zonă financiară/ALOP + authz + notificări → NU Sonnet
version_bump: 3.9.691 → 3.9.692
cache_bump: NU (backend-only; niciun fișier din PRECACHE_ASSETS nu e atins)
---

# ⚠️⚠️ BRANCH: develop ⚠️⚠️
`main` = PRODUCȚIE, gestionat MANUAL de Mircea. NU face checkout/merge/push pe `main`.
Toate commit-urile pe `develop`. Staging auto-deploy: docflowai-app-staging.up.railway.app

====================================================================
CONTEXT (verificat pe cod v3.9.691 — NU presupune, citește întâi)
====================================================================
Serviciul Buget (compartimentul CAB al organizației, `organizations.cab_compartiment`)
trebuie:
  (1) să fie NOTIFICAT când se lichidează o cheltuială într-un ciclu ALOP, cu nr+dată
      factură; notificarea deschide DF-ul de care e legată factura;
  (2) să vadă un CENTRALIZATOR read-only cu TOATE facturile completate în lichidare
      (curente + arhivate), fiecare legată de ALOP / DF / ORD.

Model de date (CONFIRMAT):
  • Factura CURENTĂ stă pe `alop_instances`:
      lichidare_nr_factura, lichidare_data_factura, lichidare_nr_pv, lichidare_data_pv,
      lichidare_notes, lichidare_confirmed_by, lichidare_confirmed_at
  • La `noua-lichidare` ciclul se ARHIVEAZĂ în `alop_ord_cicluri` cu aceleași câmpuri
      lichidare_* + ord_id + ciclu_nr. (Ciclul NU stochează df_id — DF-ul se ia din
      `alop_instances.df_id` al ALOP-ului părinte.)
  • DF-ul e mereu `alop.df_id`; ORD-ul e `alop.ord_id` (poate fi NULL la lichidare) sau
      `c.ord_id` pentru ciclul arhivat.

Helperi existenți de reutilizat (server/services/authz-formular.mjs):
  • `loadOrgCabComp(pool, orgId)` → string cab_compartiment (trimmed). EXPORTAT deja.
  • `buildAlopVisibilityWhere(actor, params)` din alop.mjs (privat, alias `a`) →
      '' pentru admin/org_admin/CAB, altfel restricție created_by/compartiment.

⛔ NO-TOUCH: server/signing/* (cloud-signing, bulk-signing, pades, java-pades-client,
   providers/STSCloudProvider). NU atinge fluxul de semnare.

====================================================================
PAS 1 — Migrație inline: cheia de modul `facturi` în module_catalog
====================================================================
Citește `server/db/index.mjs`. Găsește ULTIMA migrație (id-ul cel mai mare) și adaugă
DUPĂ ea o migrație inline nouă (NU fișier .sql separat). Verifică întâi ultimul id:

```bash
grep -oE "id: '[0-9]{3}_[a-z0-9_]+'" server/db/index.mjs | sort | tail -3
# Așteptat: ultimele 3 id-uri; folosește următorul număr liber (ex. 098_...)
```

Adaugă migrația (ajustează numărul la următorul liber):

```js
  {
    id: '098_module_facturi',
    sql: `
      INSERT INTO module_catalog
        (module_key, display_name, category, default_enabled, display_order)
      VALUES
        ('facturi', 'Facturi (centralizator lichidări)', 'alop', TRUE, 65)
      ON CONFLICT (module_key) DO NOTHING;
    `
  },
```

`display_order = 65` → apare între `clasa8` (60) și `verif-furnizor` (70) în lista din
Setări → Module & permisiuni. `default_enabled = TRUE` → moștenit activ, exact ca celelalte.

Verificare:
```bash
grep -n "098_module_facturi\|'facturi'" server/db/index.mjs
# Așteptat: migrația + rândul de catalog
```

====================================================================
PAS 2 — Notificare CAB la confirma-lichidare (server/routes/alop.mjs)
====================================================================
2.1 Importă `loadOrgCabComp`. Găsește linia de import authz-formular și extinde-o:

old_str:
```js
import { loadActorCompAndCab, isCabDept, canEditAlop, canDestroyOnly } from '../services/authz-formular.mjs';
```
new_str:
```js
import { loadActorCompAndCab, isCabDept, canEditAlop, canDestroyOnly, loadOrgCabComp } from '../services/authz-formular.mjs';
```
Verifică: `grep -n "loadOrgCabComp" server/services/authz-formular.mjs` → trebuie să fie EXPORTAT.

2.2 Importă helperul de notificare in-app. Verifică semnătura:
```bash
grep -n "export async function sendNotif" server/services/formular-shared.mjs
# Așteptat: sendNotif(userId, type, title, message, data)
```
Adaugă la importurile din alop.mjs (lângă celelalte din services):
```js
import { sendNotif } from '../services/formular-shared.mjs';
```
(Dacă un import din formular-shared există deja, doar adaugă `sendNotif` în lista lui.)

2.3 În handlerul `POST /api/alop/:id/confirma-lichidare` (în jur de linia 1069),
    ÎNAINTE de `res.json({ alop: rows[0] });` inserează blocul de notificare.

Context: la acel punct ai deja în scope:
  • `cur[0].status` = statusul ÎNAINTE de update (folosit ca gardă anti-dublare),
  • `rows[0]` = ALOP-ul actualizat (are `df_id`, `titlu`),
  • `nr_factura`, `data_factura` din body,
  • `actor.orgId`, `actor.userId`.

old_str:
```js
    if (!rows[0]) {
      logger.warn({ alopId: req.params.id, currentStatus: cur[0].status }, 'confirma-lichidare status_invalid — no row updated');
      return res.status(400).json({ error: 'status_invalid' });
    }
    res.json({ alop: rows[0] });
```
new_str:
```js
    if (!rows[0]) {
      logger.warn({ alopId: req.params.id, currentStatus: cur[0].status }, 'confirma-lichidare status_invalid — no row updated');
      return res.status(400).json({ error: 'status_invalid' });
    }

    // FEAT Facturi: notifică Serviciul Buget (compartimentul CAB al org-ului) la PRIMA
    // confirmare de lichidare cu factură. Gardă anti-dublare: doar când statusul anterior
    // era 'lichidare' (o re-salvare din 'ordonantare' nu re-notifică). Non-fatal.
    try {
      const firstConfirm = cur[0].status === 'lichidare';
      const nrFact = (nr_factura || '').toString().trim();
      if (firstConfirm && nrFact) {
        const cabComp = await loadOrgCabComp(pool, actor.orgId);
        if (cabComp) {
          const { rows: cabUsers } = await pool.query(
            `SELECT id FROM users
              WHERE org_id=$1 AND deleted_at IS NULL
                AND TRIM(compartiment) = $2 AND TRIM(compartiment) <> ''
                AND id <> $3`,
            [actor.orgId, cabComp, actor.userId]
          );
          const dfId = rows[0].df_id || null;
          const titlu = rows[0].titlu || 'ALOP';
          const dataFactTxt = data_factura
            ? ' din ' + new Date(data_factura).toLocaleDateString('ro-RO')
            : '';
          const notifData = {
            form_type: 'df',            // click-through → deschide DF-ul legat
            form_id: dfId,
            alop_id: req.params.id,
            nr_factura: nrFact,
            data_factura: data_factura || null,
          };
          for (const u of cabUsers) {
            await sendNotif(
              u.id,
              'alop_factura_lichidata',
              '🧾 Factură lichidată',
              `Factura nr. ${nrFact}${dataFactTxt} a fost lichidată — ALOP „${titlu}".`,
              notifData
            );
          }
        }
      }
    } catch (notifErr) {
      logger.warn({ err: notifErr, alopId: req.params.id }, '[Facturi] notificare CAB lichidare non-fatal');
    }

    res.json({ alop: rows[0] });
```

Note: DF-ul se deschide via `data.form_type='df'` + `data.form_id=df_id` — pattern-ul
EXISTENT de navigare formulare (public/js/notifications/notifications.js:154-158 →
`formular.html?form_type=df&form_id=<uuid>`). NU inventa un actionUrl nou.
Dacă `df_id` e NULL (rar — ALOP fără DF completat), notificarea tot pleacă; click-ul
va duce la formular.html fără doc (fallback existent). Acceptabil.

====================================================================
PAS 3 — Endpoint centralizator: GET /api/alop/facturi
====================================================================
Adaugă o rută nouă în alop.mjs, ÎNAINTE de `export default router;` (la finalul rutelor).
Read-only, scopat pe org + vizibilitatea ALOP (reutilizează `buildAlopVisibilityWhere`
printr-un CTE `visible_alop`, ca să NU dublezi logica de izolare).

```js
// ── GET /api/alop/facturi — centralizator read-only al facturilor din lichidări ──
// UNION: facturi CURENTE (alop_instances) + facturi ARHIVATE (alop_ord_cicluri).
// Vizibilitate: admin/org_admin/CAB văd tot org-ul; restul doar compartimentul lor
// (via buildAlopVisibilityWhere pe CTE-ul visible_alop, alias `a`).
router.get('/api/alop/facturi', async (req, res) => {
  if (requireDb(res)) return;
  const actor = requireAuth(req, res); if (!actor) return;
  try {
    const params = [actor.orgId];
    // CTE cu ALOP-urile vizibile actorului (aceeași regulă ca lista ALOP)
    const visWhere = await buildAlopVisibilityWhere(actor, params); // '' sau ' AND (...)'
    const sql = `
      WITH visible_alop AS (
        SELECT a.id
          FROM alop_instances a
         WHERE a.org_id = $1 AND a.cancelled_at IS NULL${visWhere}
      )
      SELECT * FROM (
        -- Facturi CURENTE (ciclul în lucru)
        SELECT
          a.id                     AS alop_id,
          a.titlu                  AS alop_titlu,
          a.df_id                  AS df_id,
          a.ord_id                 AS ord_id,
          a.lichidare_nr_factura   AS nr_factura,
          a.lichidare_data_factura AS data_factura,
          a.lichidare_nr_pv        AS nr_pv,
          a.lichidare_data_pv      AS data_pv,
          a.lichidare_notes        AS notes,
          a.lichidare_confirmed_at AS confirmed_at,
          ul.nume                  AS confirmed_by_name,
          COALESCE(a.ciclu_curent,1) AS ciclu_nr,
          'curent'                 AS sursa
        FROM alop_instances a
        JOIN visible_alop v ON v.id = a.id
        LEFT JOIN users ul ON ul.id = a.lichidare_confirmed_by
        WHERE a.lichidare_nr_factura IS NOT NULL
          AND TRIM(a.lichidare_nr_factura) <> ''

        UNION ALL

        -- Facturi ARHIVATE (cicluri închise) — DF din ALOP-ul părinte
        SELECT
          a.id                     AS alop_id,
          a.titlu                  AS alop_titlu,
          a.df_id                  AS df_id,
          c.ord_id                 AS ord_id,
          c.lichidare_nr_factura   AS nr_factura,
          c.lichidare_data_factura AS data_factura,
          c.lichidare_nr_pv        AS nr_pv,
          c.lichidare_data_pv      AS data_pv,
          c.lichidare_notes        AS notes,
          c.lichidare_confirmed_at AS confirmed_at,
          ul.nume                  AS confirmed_by_name,
          c.ciclu_nr               AS ciclu_nr,
          'ciclu'                  AS sursa
        FROM alop_ord_cicluri c
        JOIN visible_alop v ON v.id = c.alop_id
        JOIN alop_instances a ON a.id = c.alop_id
        LEFT JOIN users ul ON ul.id = c.lichidare_confirmed_by
        WHERE c.org_id = $1
          AND c.lichidare_nr_factura IS NOT NULL
          AND TRIM(c.lichidare_nr_factura) <> ''
      ) t
      ORDER BY t.data_factura DESC NULLS LAST, t.confirmed_at DESC NULLS LAST
    `;
    const { rows } = await pool.query(sql, params);
    res.set('Cache-Control', 'no-store');
    res.json({ ok: true, facturi: rows, total: rows.length });
  } catch (e) {
    logger.error({ err: e }, 'alop facturi centralizator error');
    res.status(500).json({ error: 'server_error' });
  }
});
```

⚠️ IMPORTANT — ordinea rutelor Express: `/api/alop/facturi` NU trebuie prinsă de
`/api/alop/:id`. Verifică unde e definit `GET /api/alop/:id` și, dacă e ÎNAINTEA
locului unde inserezi, mută ruta `facturi` DEASUPRA lui `:id` (Express match pe ordine).
```bash
grep -n "router.get('/api/alop/:id'\|router.get(\"/api/alop/:id\"\|router.get('/api/alop/facturi'" server/routes/alop.mjs
# Așteptat: 'facturi' apare ÎNAINTEA lui ':id' (număr de linie mai mic)
```
Dacă `:id` e mai sus → inserează `facturi` chiar înainte de definiția lui `:id` în loc de
înainte de `export default`.

====================================================================
PAS 4 — Version bump + teste
====================================================================
```bash
# package.json 3.9.691 → 3.9.692 (backend-only, FĂRĂ cache bump, FĂRĂ ?v= în HTML)
sed -i 's/"version": "3.9.691"/"version": "3.9.692"/' package.json
grep '"version"' package.json   # Așteptat: 3.9.692

npm test
# Așteptat: verde, fără regresii. Testul îl IMPORTĂ pe sendNotif/handler din producție,
# NU redeclară logica.
```
Dacă adaugi test nou pentru endpoint/notificare: importă din producție, folosește un al
doilea org DOAR cu `orgName` distinct (vezi alop-tranzitii-garzi.test.mjs pt. pattern —
`organizations_name_key` e UNIQUE, nu refolosi 'Org Test').

====================================================================
RAPORT FINAL (obligatoriu)
====================================================================
- id-ul migrației folosit + confirmarea că 'facturi' e în catalog
- diff-ul notificării (gardă firstConfirm + excludere actor + cabComp gol ⇒ no-op)
- confirmarea ordinii rutelor (facturi înainte de :id)
- rezultat `npm test` (număr passed / 0 fail)
- versiune package.json
- orice presupunere pe care a trebuit s-o faci

⛔ CONSTRÂNGERI ABSOLUTE
- develop ONLY. NU main.
- NU atinge server/signing/*.
- Migrații INLINE în server/db/index.mjs, NU fișiere .sql noi. Verifică tipul FK cu grep.
- Toate rutele API: `Cache-Control: no-store` (deja pus pe /facturi).
- Notificarea e non-fatal (try/catch) — o eroare de notificare NU rupe lichidarea.
- NU redeclara logica în teste; importă din producție.
