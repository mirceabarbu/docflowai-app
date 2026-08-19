---
task: "#114 — self-heal nu mai învie fluxuri moarte + reinițierea blocată pe fluxuri de formular"
branch: develop
model_suggested: Opus 4.8   # ALOP + mașină de stări + migrație de vindecare pe date de producție
target_version: v3.9.743
migrations: DA — inline, vindecare de date (următorul id liber; 103 e ocupat de #113a)
cache_version_bump: NO   # doar backend
---

# ⚠️ BRANCH: develop

## PASUL 0 — CONFIRMĂ BRANCH-UL ÎNAINTE DE ORICE
```
git branch --show-current      # Așteptat: develop
git fetch origin && git status
```

===============================================================================
## CONTEXT — DOUĂ bug-uri care se compun
===============================================================================

Scenariu real din producție (ORD 41011, 23.07): flux lansat → **refuzat** de un
semnatar → **reinițiat** → **anulat**. ALOP-ul a rămas blocat, fără posibilitatea de a
relansa ORD-ul.

### Bug 1 — self-heal #2 învie fluxurile REFUZATE
`server/routes/alop.mjs:842`. Handlerul de refuz (#77) curăță corect
`alop.ord_flow_id` + `ord_completed_at`, dar `formulare_ord.flow_id` rămâne setat
(paritate deliberată cu DF). Self-heal #2 se declanșează exact pe starea rămasă
(`status='ordonantare' && ord_id && !ord_flow_id`) și repopulează `ord_flow_id` din
`formulare_ord.flow_id`.

Garda lui verifică DOAR anularea:
```js
(f.data->>'status' = 'cancelled') AS flow_cancelled
...
if (fo[0]?.flow_id && !fo[0].flow_cancelled) { /* repopulează */ }
```
Un flux **refuzat** trece nestingherit ⇒ pointerul mort e resuscitat la prima deschidere
a ALOP-ului, iar capabilitatea revine la „Marchează ORD semnat complet" în loc de
„Generează + Lansează flux ORD". Practic **#77 repară, self-heal-ul strică înapoi**.

A treia gaură în aceeași gardă: `LEFT JOIN flows f ON f.id::text = fo.flow_id` NU
verifică `f.deleted_at` ⇒ ar învia și un flux soft-șters (relevant după #113a, care
face soft-delete).

⚠️ Verificat: NU există self-heal echivalent pentru DF (`alop.mjs:1054` e o legare, nu
o resuscitare), iar `df_flow_active` verifică deja `refused`. **Bug-ul e strict pe ORD** —
⛔ nu „repara" simetric partea DF, nu are ce.

### Bug 2 — reinițierea nu relinkează formularul
`POST /flows/:flowId/reinitiate` (`lifecycle.mjs:40`) creează fluxul nou și setează
`data.reinitiatedAs`, dar **nu atinge nici `formulare_ord`, nici `formulare_df`**.
(Liniile 181/335 aparțin lui `request-review` / `reinitiate-review`, alte handlere.)
Deci fluxul nou e orfan: semnarea lui n-ar actualiza ORD-ul, iar anularea lui nu curăță
ALOP-ul, fiindcă `SELECT id FROM formulare_ord WHERE flow_id=<flux nou>` nu găsește nimic.

**DECIZIA OWNERULUI: varianta B — blocăm reinițierea pe fluxurile legate de formular.**
Motiv: după refuz, ALOP-ul oferă DEJA traseul corect („Generează + Lansează flux ORD"
pentru ORD, „Completează DF" pentru DF). A duplica logica de legare în reinitiate ar
crea a doua cale care poate diverge — exact tiparul eliminat în #111a.

===============================================================================
## PASUL 1 — Bug 1: garda self-heal #2
===============================================================================

`server/routes/alop.mjs`, blocul de la ~linia 842.

Extinde interogarea ca să marcheze fluxul ca MORT dacă e anulat, refuzat SAU soft-șters,
și folosește acel flag în locul lui `flow_cancelled`. Sugestie de formă (adapteaz-o la
codul real, nu o copia orbește):

```sql
SELECT fo.flow_id,
  (   f.id IS NULL
   OR f.deleted_at IS NOT NULL
   OR f.data->>'status' = 'cancelled'
   OR f.data->>'status' = 'refused' ) AS flow_dead,
  CASE WHEN fo.flow_id IS NOT NULL AND (
    f.data->>'status' = 'completed' OR (f.data->>'completed')::boolean = true
  ) THEN true ELSE false END AS aprobat
FROM formulare_ord fo
LEFT JOIN flows f ON f.id::text = fo.flow_id
WHERE fo.id=$1 AND fo.org_id=$2 AND fo.deleted_at IS NULL
```
apoi `if (fo[0]?.flow_id && !fo[0].flow_dead) { … }`.

⚠️ `f.id IS NULL` acoperă cazul în care `formulare_ord.flow_id` arată spre un flux
inexistent (șters fizic cândva) — azi ar da `flow_cancelled=false` și ar repopula un
pointer către neant.

Actualizează comentariul de deasupra (cel care explică „fix 9") ca să reflecte toate
cele patru condiții, nu doar anularea.

⛔ NU schimba condiția de intrare în self-heal (`status==='ordonantare' && ord_id && !ord_flow_id`).
⛔ NU atinge self-heal #1 (orphan ORD auto-link).
⛔ NU atinge calculul `aprobat` / auto-tranziția lazy de la `alop.mjs:901`.

===============================================================================
## PASUL 2 — Bug 2: blochează reinițierea pe fluxuri de formular
===============================================================================

`server/routes/flows/lifecycle.mjs`, handlerul `reinitiate` (linia 40), ÎNAINTE de
crearea fluxului nou (`_newFlowId`) și înainte de orice scriere:

```js
const { rows: linkedOrd } = await pool.query('SELECT id FROM formulare_ord WHERE flow_id=$1', [flowId]);
const { rows: linkedDf }  = await pool.query('SELECT id FROM formulare_df  WHERE flow_id=$1', [flowId]);
if (linkedOrd.length || linkedDf.length) {
  return res.status(409).json({
    error: 'formular_linked_flow',
    message: linkedOrd.length
      ? 'Acest flux aparține unei Ordonanțări de Plată. Relansează-l din ALOP („Generează + Lansează flux ORD"), nu prin reinițiere.'
      : 'Acest flux aparține unui Document de Fundamentare. Relansează-l din ALOP („Completează DF"), nu prin reinițiere.'
  });
}
```

⛔ NU atinge `reinitiate-review` (linia 215) — acela e traseul de revizuire, care ARE
deja tratament de formular (linia 335) și e legitim.
⛔ NU atinge `request-review`.

### Frontend
`public/js/flow/flow.js` — butonul de reinițiere (`btnRei`, poarta la ~linia 694).
Afișează mesajul din răspuns la 409, nu un text generic. Dacă poarta de vizibilitate
poate afla ieftin că fluxul e legat de formular, ascunde butonul; dacă nu, lasă-l vizibil
și tratează 409 curat — ⛔ nu introduce un fetch suplimentar pe încărcarea paginii doar
pentru asta.

===============================================================================
## PASUL 3 — Migrație de VINDECARE (fără schemă)
===============================================================================

Listează întâi ID-urile existente — ⛔ NU presupune (103 e ocupat de #113a):
```
grep -n "id: '1[0-9][0-9]_" server/db/index.mjs
```

Migrație nouă `<următorul>_alop_clear_dead_ord_pointers`, DOAR date, idempotentă prin
propriul WHERE:

```sql
DO $g$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.tables
    WHERE table_schema='public' AND table_name='alop_instances') THEN RETURN; END IF;

  UPDATE alop_instances a
     SET ord_flow_id = NULL, ord_completed_at = NULL, updated_at = NOW()
    FROM flows f
   WHERE f.id::text = a.ord_flow_id
     AND a.status = 'ordonantare'
     AND a.cancelled_at IS NULL
     AND ( f.deleted_at IS NOT NULL
        OR f.data->>'status' = 'cancelled'
        OR f.data->>'status' = 'refused' );
END $g$;
```

Ce face: eliberează ALOP-urile în care `ord_flow_id` arată spre un flux mort — inclusiv
ORD 41011 din producție. ⛔ NU atinge `formulare_ord.flow_id` (rămâne ca proveniență
istorică, prin paritate cu DF; după fixul de la Pasul 1 self-heal-ul nu-l mai învie).
⛔ NU atinge ALOP-uri cu `status <> 'ordonantare'`.
⛔ Zero ștergeri de rânduri.

Comentariul migrației trebuie să spună explicit că e vindecarea unică a bug-ului de la
Pasul 1, nu o operație recurentă.

===============================================================================
## PASUL 4 — Teste
===============================================================================

### 4a. DB — `server/tests/db/alop-selfheal-dead-flow.test.mjs` (PG real)
1. ALOP `ordonantare`, `ord_flow_id` NULL, `formulare_ord.flow_id` → flux **refuzat**:
   GET ALOP ⇒ `ord_flow_id` rămâne **NULL** (nu se învie). ← cazul central
2. Idem cu flux **anulat** ⇒ NULL (non-regresie a gărzii vechi).
3. Idem cu flux **soft-șters** ⇒ NULL.
4. Idem cu `flow_id` către un id INEXISTENT ⇒ NULL.
5. Flux **activ, nefinalizat** ⇒ `ord_flow_id` SE repopulează (self-heal-ul funcționează
   în continuare pentru scopul lui real).
6. Flux **completat** ⇒ se repopulează ȘI trece la `plata` (comportamentul existent, neatins).

### 4b. DB — reinițiere blocată
7. `POST /flows/:id/reinitiate` pe flux legat de ORD ⇒ **409 `formular_linked_flow`**,
   și verifică în bază că NU s-a creat niciun flux nou.
8. Idem pe flux legat de DF ⇒ 409.
9. Flux NElegat (standalone) ⇒ reinițierea funcționează ca înainte (non-regresie).

### 4c. Migrația
10. Seed: ALOP `ordonantare` cu `ord_flow_id` → flux refuzat; rulează migrațiile;
    verifică `ord_flow_id` NULL. Un ALOP cu flux ACTIV rămâne neatins.

===============================================================================
## PASUL 5 — Porți
===============================================================================
```
npm test            # baseline la intrare: 109 fișiere / 1405 teste
npm run test:db     # OBLIGATORIU — baseline 77 fișiere / 515
```
⛔ „Docker absent" NU e motiv de skip: PG 17 efemer, port 55432, rețeta din CLAUDE.md.
**Rulează migrațiile de DOUĂ ori** și confirmă că a doua e no-op.

===============================================================================
## PASUL 6 — Commit + PUSH
===============================================================================
```
git status    # verifică lista; ⛔ NU `git add -A` (repo-ul are clutter netrackuit preexistent)
git add <doar fișierele task-ului>
git commit -m "fix(alop): self-heal nu mai învie fluxuri moarte (refuzat/anulat/șters) + reinițiere blocată pe fluxuri de formular — v3.9.743"
git push origin develop
```

===============================================================================
## RAPORT FINAL
===============================================================================
- Commit + versiune; `npm test` / `test:db` reale (dacă test:db n-a rulat, spune-o).
- Ce id de migrație ai folosit + dovada listării.
- Rezultatul rulării DUBLE a migrațiilor.
- Câte rânduri a atins vindecarea pe baza de test (și confirmă că a doua rulare atinge 0).
- Confirmă: self-heal #1 neatins; auto-tranziția lazy neatinsă; `reinitiate-review` neatins;
  partea DF a self-heal-ului NEmodificată (nu există).
- Orice abatere + justificare.

===============================================================================
## ⛔ CONSTRÂNGERI
===============================================================================
- ⛔ BRANCH develop; PASUL 0 obligatoriu.
- ⛔ NU modifica `formulare_ord.flow_id` nicăieri (proveniență istorică, paritate DF).
- ⛔ NU atinge self-heal #1, auto-tranziția lazy, `reinitiate-review`, `request-review`.
- ⛔ Vindecarea atinge DOAR ALOP-uri `status='ordonantare'` cu flux mort.
- ⛔ NO-TOUCH: `server/signing/*`.
- ⛔ `git push origin develop`. Pe `main` niciodată.
