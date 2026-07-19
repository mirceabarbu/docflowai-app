---
prompt: 58
titlu: "feat(ALOP): titlu ALOP editabil oricând (fără cascadă — DF/ORD existente păstrează titlul, cele noi îl iau pe cel nou)"
model_suggested: Sonnet 4.6 (Default)
branch: develop
zona: ALOP · editare metadata titlu
---

# ⛔ BRANCH DISCIPLINE — CITEȘTE ÎNTÂI
> **EXCLUSIV pe `develop`.** NU face `merge` / `push` / `checkout` pe `main`.
> `main` = producție, gestionat manual de owner. Deploy staging = push pe `develop`.
> Dacă vreun pas te-ar duce spre `main`, **OPREȘTE-TE** și raportează.

---

## Cerință (owner)
Titlul unui ALOP trebuie să poată fi editat **oricând**, direct din detaliul ALOP. Semantica dorită, **fără cascadă**:
- DF/ORD **create înainte** de editare → rămân cu titlul lor (nu se ating).
- DF/ORD **create după** editare → iau titlul nou.

## De ce e simplu (mecanismul există deja)
La crearea unui DF în context ALOP, `public/js/formular/core.js:58-60` pre-completează `subtitlu_df` din `window._alopContext.titlu`, **doar dacă e gol**. Iar `_alopContext.titlu` e citit **live** din server (`alop.titlu`) la fiecare `alopDeschideDF/ORD` (`alop.js`). Deci „nou ia titlul nou, vechi păstrează vechiul" e **comportamentul natural** — NU adăuga nicio logică de cascadă în DF/ORD existente.

**Tot ce facem:** facem `alop_instances.titlu` editabil (endpoint + UI inline).

## Fix

### 1. Backend — `server/routes/alop.mjs`
Adaugă un endpoint nou, în stilul celorlalte mutații ALOP (`_csrf` + `canEditAlop`), lângă celelalte `POST /api/alop/:id/...`:

```js
// ── POST /api/alop/:id/titlu — editează titlul ALOP (metadata, oricând) ──────
router.post('/api/alop/:id/titlu', _csrf, async (req, res) => {
  if (requireDb(res)) return;
  const actor = requireAuth(req, res); if (!actor) return;
  try {
    const titlu = String(req.body?.titlu || '').trim();
    if (!titlu) return res.status(400).json({ error: 'titlu_obligatoriu' });
    if (titlu.length > 300) return res.status(400).json({ error: 'titlu_prea_lung' });

    const { rows: alopRows } = await pool.query(
      'SELECT created_by, compartiment, df_id, ord_id, df_semnatari, ord_semnatari FROM alop_instances WHERE id=$1 AND org_id=$2',
      [req.params.id, actor.orgId]
    );
    if (!alopRows[0]) return res.status(404).json({ error: 'not_found' });
    {
      const actorComp = await loadActorComp(pool, actor.userId);
      const authz = await canEditAlop(pool, actor, alopRows[0], actorComp);
      if (!authz.allowed) return res.status(403).json({ error: authz.reason });
    }

    const { rows } = await pool.query(
      `UPDATE alop_instances SET titlu=$1, updated_at=NOW(), updated_by=$4
       WHERE id=$2 AND org_id=$3 RETURNING id, titlu`,
      [titlu, req.params.id, actor.orgId, actor.userId]
    );
    res.json({ ok: true, alop: rows[0] });
  } catch (e) {
    logger.error({ err: e }, 'alop titlu update error');
    res.status(500).json({ error: 'server_error' });
  }
});
```

**Authz „oricând":** editarea titlului trebuie permisă indiferent de statusul ALOP (inclusiv finalizat) — titlul e metadata, nu atinge documentele emise. Dacă `canEditAlop` **blochează** pe stări avansate/finalizat, adaugă o excepție doar pentru acest endpoint: permite dacă actorul e **creatorul ALOP-ului sau admin/org_admin**, independent de status (NU relaxa `canEditAlop` pentru celelalte rute).

### 2. Frontend — `public/js/formular/alop.js`
În render-ul detaliului ALOP, titlul e la ~linia 579 (`<div ...>${esc(a.titlu||'ALOP')}</div>`). Adaugă o afordanță de editare inline: un creion mic lângă titlu → transformă titlul în `<input>` cu **Salvează / Anulează** → `POST /api/alop/:id/titlu` (cu `X-CSRF-Token` via `df.getCsrf()`) → la succes, re-încarcă detaliul ALOP (aceeași funcție care randează detaliul). Validare client: non-gol. Fără CSS nou dacă se poate (reutilizează `.df-action-btn`, clase existente).

Nu atinge lista ALOP / lista DF — ambele citesc `a.titlu` / `subtitlu_df` live, se reîmprospătează singure.

## Ce NU atingem
- ⛔ `core.js` (mecanismul de prefill e deja corect).
- ⛔ Nicio cascadă spre `formulare_df.subtitlu_df` / ORD.
- ⛔ Zonă semnare/STS/PAdES.

## Cache busting + versiune
- `public/formular.html`: `alop.js?v=3.9.600` → `?v=3.9.638`.
- `public/sw.js`: `CACHE_VERSION` `docflowai-v266` → `docflowai-v267`.
- `package.json`: `3.9.637` → `3.9.638`.

## Guardrails diff
`git diff --name-only` = EXCLUSIV: `server/routes/alop.mjs`, `public/js/formular/alop.js`, `public/formular.html`, `public/sw.js`, `package.json`.
```bash
git diff --name-only | grep -vE "^(server/routes/alop\.mjs|public/js/formular/alop\.js|public/formular\.html|public/sw\.js|package\.json)$" \
  && echo "⛔ STOP: fișier nepermis!" || echo "✅ ok"
git diff public/js/formular/core.js | grep . && echo "⛔ core.js NU trebuie atins!" || echo "✅ core.js neatins"
```

## Teste
`npm test verde, fără regresii`. Opțional: un test scurt pe endpoint (titlu gol → 400; titlu valid → 200 + persistă; authz creator/admin ok, alt user → 403).

## Verificare (owner, staging)
- Editez titlul unui ALOP finalizat → se salvează, se vede peste tot (listă ALOP, listă DF citește `subtitlu_df` vechi al DF-urilor existente — corect).
- Creez un DF nou pe acel ALOP → `subtitlu_df` = titlul NOU.
- DF-urile vechi rămân cu titlul vechi.

## Final
```bash
git add server/routes/alop.mjs public/js/formular/alop.js public/formular.html public/sw.js package.json
git commit -m "feat(alop): titlu ALOP editabil oricând, fără cascadă (v3.9.638)"
git push origin develop
```
**STOP. NU merge/push pe `main`.**
