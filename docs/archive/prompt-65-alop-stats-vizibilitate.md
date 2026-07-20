---
prompt: 65
titlu: "fix(ALOP): cardurile (stats) folosesc același filtru de vizibilitate ca lista — helper partajat"
model_suggested: Opus 4.8
branch: develop
zona: ALOP vizibilitate/authz · coerență carduri↔listă
---

# ⛔ BRANCH DISCIPLINE
> EXCLUSIV pe `develop`. NU merge/push/checkout pe `main`.

---

## Simptom (owner)
Cardurile ALOP (Total/Finalizate/În progres/Draft) arată centralizarea pe **toată instituția** (ex. 6), deși userul are **1** în listă. Trebuie să reflecte ce vede userul: user obișnuit → doar ALOP-urile lui; **admin / super-admin (`admin`) și admin instituție (`org_admin`) → tot org-ul.**

## Cauză (confirmată)
- Lista `GET /api/alop` (alop.mjs ~270-325) aplică filtrul de vizibilitate per-user (creator / semnatar pe flux DF/ORD / același compartiment), sărit pentru `admin`/`org_admin`.
- Cardurile `GET /api/alop/stats` (alop.mjs 238-258) numără cu doar `WHERE org_id=$1 AND cancelled_at IS NULL` — **fără** acel filtru.

## Fix (opțiunea A — helper partajat, DRY)
Extrage clauza de vizibilitate într-o funcție folosită de **ambele** endpoint-uri, ca să nu mai poată diverge niciodată.

### 1. `server/routes/alop.mjs` — helper nou
Extrage **verbatim** SQL-ul din blocul inline al listei (`if (actor.role !== 'admin' && actor.role !== 'org_admin') { ... }`, ~270-325) într-o funcție:
```js
// Clauză de vizibilitate ALOP (per-user), goală pentru admin/org_admin.
// Mutează `params` (push) și întoarce fragmentul ` AND (...)`. SQL păstrat 1:1.
async function buildAlopVisibilityWhere(actor, params) {
  if (actor.role === 'admin' || actor.role === 'org_admin') return '';
  const actorCompRes = await pool.query('SELECT compartiment FROM users WHERE id=$1', [actor.userId]);
  const actorComp = (actorCompRes.rows[0]?.compartiment || '').trim();
  params.push(actor.userId);
  const userIdx = params.length;
  let compClause = '';
  if (actorComp !== '') {
    params.push(actorComp);
    const compIdx = params.length;
    compClause = /* … sub-clauzele de compartiment, verbatim, folosind $${compIdx} … */;
  }
  return ` AND (
    a.created_by = $${userIdx}
    OR EXISTS (SELECT 1 FROM flows fl1 WHERE fl1.id = a.df_flow_id AND fl1.data->'signers' @> jsonb_build_array(jsonb_build_object('userId', $${userIdx}::text)))
    OR EXISTS (SELECT 1 FROM flows fl2 WHERE fl2.id = a.ord_flow_id AND fl2.data->'signers' @> jsonb_build_array(jsonb_build_object('userId', $${userIdx}::text)))${compClause}
  )`;
}
```
**Important:** păstrează SQL-ul de compartiment **exact** ca în original (aceleași sub-EXISTS, același `$${compIdx}`). Nu rescrie logica — doar mut-o.

### 2. Lista `GET /api/alop`
Înlocuiește blocul inline de vizibilitate cu:
```js
where += await buildAlopVisibilityWhere(actor, params);
```
(Restul query-ului neschimbat.)

### 3. Cardurile `GET /api/alop/stats`
Aliniază la aceeași sursă:
```js
const params = [actor.orgId];
let where = 'a.org_id=$1 AND a.cancelled_at IS NULL';
where += await buildAlopVisibilityWhere(actor, params);
const { rows } = await pool.query(`
  SELECT
    COUNT(*)::int AS total,
    COUNT(*) FILTER (WHERE a.status='completed')::int AS completate,
    COUNT(*) FILTER (WHERE a.status IN ('angajare','lichidare','ordonantare','plata'))::int AS in_progres,
    COUNT(*) FILTER (WHERE a.status='draft')::int AS draft
  FROM alop_instances a
  WHERE ${where}
`, params);
```
(Notează: `FROM alop_instances a` cu alias `a`, ca fragmentul helper-ului să se potrivească.)

## Ce NU atingem
- ⛔ Nicio scriere, nicio tranziție, niciun alt endpoint. Doar cele 3 modificări de mai sus.
- Comportamentul pentru admin/org_admin rămâne „tot org-ul" (helper întoarce '').

## Test
Adaugă un test DB: user obișnuit cu 1 ALOP propriu într-un org cu mai multe ALOP → `/api/alop/stats` întoarce `total=1` (nu tot org-ul), iar `/api/alop` întoarce aceeași mulțime. Admin/org_admin → numără tot org-ul. `npm test verde, fără regresii`. `npm run check` OK.

## Cache busting + versiune
Doar server + test ⇒ fără `sw.js`/`?v=`. Bump `package.json` la următorul patch.

## Guardrails diff
EXCLUSIV: `server/routes/alop.mjs`, testul, `package.json`.
```bash
git diff server/routes/alop.mjs | grep -iE "UPDATE|INSERT|DELETE|SET status" && echo "⛔ STOP: scriere!" || echo "✅ doar SELECT/vizibilitate"
```

## Verificare (owner, staging)
- User obișnuit: cardurile = câte ALOP vede în listă (ex. 1/1).
- Admin / org_admin: cardurile = tot org-ul.

## Final
```bash
git add server/routes/alop.mjs server/tests package.json
git commit -m "fix(alop): stats cards folosesc helperul partajat de vizibilitate (carduri=lista)"
git push origin develop
```
**STOP. NU merge/push pe `main`.**
