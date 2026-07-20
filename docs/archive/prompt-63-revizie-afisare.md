---
prompt: 63
titlu: "fix(afișare): revizie DF în curs — badge listă ALOP „🔄 Revizie pe flux" + sub-text stepper din df_aprobat real (DOAR AFIȘARE)"
model_suggested: Opus 4.8
branch: develop
zona: afișare status ALOP/revizii · DERIVARE (zero funcțional)
---

# ⛔ BRANCH DISCIPLINE
> EXCLUSIV pe `develop`. NU merge/push/checkout pe `main`.

---

# ⚠️ REGULĂ ABSOLUTĂ: DOAR AFIȘARE
> Acest task **NU** are voie să schimbe funcționalitatea. Interzis: scrieri în DB, modificarea lui `a.status`, a tranzițiilor (`crud.mjs`/`lifecycle.mjs`/`signing.mjs`), a `revizuieste`, a capabilities, a WHERE/filtrelor, sau a flag-urilor `done`/`active` ale fazelor din stepper. Se ating **exclusiv**: coloane derivate noi în SELECT-uri (read-only) și textul etichetelor în `alop.js`. Dacă un pas ar atinge altceva → OPREȘTE-TE.

---

## Simptom (owner)
La un ALOP finalizat apoi **revizuit** (DF R1 pe fluxul de semnare, neaprobat încă):
- lista ALOP arată „Finalizat" în loc să semnaleze revizia în curs;
- stepper-ul arată „✅ DF aprobat · Revizia 1" deși R1 nu e aprobat.
Statusul persistat e corect funcțional — problema e **doar afișarea** stării reale la momentul vizualizării.

## Sursa adevărului (deja pe server)
- Detaliul (`alop.mjs`) expune `df_revizie_nr`, `df_este_revizie_an_urmator`, `df_aprobat` (din `f1`, fluxul curent, via `COALESCE(df.flow_id, a.df_flow_id)`).
- Lipsește doar `df_flow_active` (flux curent activ: nici completat, nici anulat, nici soft-șters).

„Revizie în curs" ≡ `df_revizie_nr > 0 && df_flow_active && !df_aprobat`.

## Modificări

### 1. Backend `server/routes/alop.mjs` — DETALIU (GET /api/alop/:id)
Adaugă coloana derivată `df_flow_active`, oglindind `df_aprobat` dar cu condiția de „activ" (folosește `f1`, deja în JOIN):
```sql
        CASE WHEN COALESCE(df.flow_id, a.df_flow_id) IS NOT NULL
                  AND f1.deleted_at IS NULL
                  AND (f1.data->>'completed') IS DISTINCT FROM 'true'
                  AND (f1.data->>'status')    IS DISTINCT FROM 'cancelled'
             THEN true ELSE false END AS df_flow_active,
```

### 2. Backend `server/routes/alop.mjs` — LISTĂ (GET /api/alop)
Lista are `LEFT JOIN formulare_df df` dar **nu** are flows. Adaugă coloane derivate ca **subquery-uri scalare** (fără JOIN nou, ca să nu atingi agregările existente):
```sql
        df.revizie_nr                AS df_revizie_nr,
        df.este_revizie_an_urmator   AS df_este_revizie_an_urmator,
        (SELECT CASE WHEN COALESCE(df.flow_id, a.df_flow_id) IS NOT NULL
                      AND fdf.deleted_at IS NULL
                      AND (fdf.data->>'completed') IS DISTINCT FROM 'true'
                      AND (fdf.data->>'status')    IS DISTINCT FROM 'cancelled'
                 THEN true ELSE false END
         FROM flows fdf WHERE fdf.id::text = COALESCE(df.flow_id, a.df_flow_id)) AS df_flow_active,
        (SELECT CASE WHEN (fdf.data->>'status')='completed' OR (fdf.data->>'completed')::boolean=true
                 THEN true ELSE false END
         FROM flows fdf WHERE fdf.id::text = COALESCE(df.flow_id, a.df_flow_id)) AS df_aprobat,
```
⛔ NU schimba `a.status`, WHERE-ul, agregările de valori, sau count-ul.

### 3. Frontend `public/js/formular/alop.js` — badge listă `_alopStatusBadge` (~linia 70-80)
Extinde funcția să primească rândul (`a`) și adaugă cazul „revizie în curs", **după** cazul `angajare && dfFlowId` (ca să aibă prioritate peste „Finalizat"/„Ordonanțare"):
```js
// semnătura: _alopStatusBadge(status, dfFlowId, a)
if(a && a.df_revizie_nr>0 && a.df_flow_active && !a.df_aprobat)
  s={icon:'ico-pen-tool', text:'Revizie pe flux', color:'#6366f1'};
```
Actualizează cele două apeluri (`~196` listă, `~618` detaliu) să paseze `a` ca al treilea argument: `_alopStatusBadge(a.status, a.df_flow_id, a)`.

### 4. Frontend `public/js/formular/alop.js` — stepper Angajare (~linia 480)
Adaugă o ramură **înaintea** celei de „✅ DF aprobat":
```js
        :(a.df_revizie_nr>0 && a.df_flow_active && !a.df_aprobat)?`🔄 Revizia ${a.df_revizie_nr} pe flux — în curs · ultima aprobată: Revizia ${a.df_revizie_nr-1}`
        :(['lichidare','ordonantare','plata','completed'].includes(a.status)||isCompleted)?`✅ DF aprobat${_dfRevTxt}`
```
⛔ NU atinge `done:`/`active:` ale fazelor (bifa verde Angajare rămâne — reflectă ciclul aprobat anterior). Doar `sub:` se schimbă.
> Notă: „ultima aprobată = Revizia N−1" e corect prin invariantul de business (revizie permisă doar după una aprobată).

## Ce rămâne corect automat
- Lista DF: R1 pe flux → „🔄 Trimis flux" (deja, din #61); R0 istoric → „Aprobat".
- Când R1 e aprobat: `df_aprobat=true` → stepper revine la „✅ DF aprobat · Revizia 1", badge listă revine la starea normală. Fără intervenție.

## Test (anti-regresie, read-only)
Adaugă în `server/tests/db/` un test care seedează un ALOP cu DF R1 pe flux activ (neaprobat) și verifică: `df_flow_active=true`, `df_aprobat=false`, `df_revizie_nr=1` în răspunsul listă și detaliu. `npm test verde, fără regresii`.

## Cache busting + versiune
- `public/formular.html`: bump `alop.js?v=` la versiunea nouă.
- `public/sw.js`: `CACHE_VERSION` → incrementează de la valoarea curentă.
- `package.json`: următorul patch. (`alop.mjs` server → fără `?v`.)

## Guardrails diff
Atinge EXCLUSIV: `server/routes/alop.mjs`, `public/js/formular/alop.js`, `public/formular.html`, `public/sw.js`, `package.json` (+ testul nou).
```bash
git diff server/routes/alop.mjs | grep -iE "UPDATE |INSERT |DELETE |SET status|df_completed_at|revizuieste" && echo "⛔ STOP: scriere/funcțional atins!" || echo "✅ doar SELECT derivat"
git diff public/js/formular/alop.js | grep -iE "done:|active:" && echo "⚠️ verifică: NU schimba done/active" || echo "✅ done/active neatinse"
```

## Verificare (owner, staging)
- ALOP finalizat apoi revizuit, R1 pe flux → listă „🔄 Revizie pe flux"; stepper Angajare bifă verde + „🔄 Revizia 1 pe flux — în curs · ultima aprobată: Revizia 0".
- ALOP nou (fără revizie) → neschimbat.
- R1 aprobat → revine la „DF aprobat · Revizia 1". **Nimic funcțional schimbat.**

## Final
```bash
git add server/routes/alop.mjs public/js/formular/alop.js public/formular.html public/sw.js package.json server/tests/db/
git commit -m "fix(afisare): revizie DF in curs — badge ALOP + sub-text stepper din df_aprobat/df_flow_active (display-only)"
git push origin develop
```
**STOP. NU merge/push pe `main`.**

## Raportează
- confirmarea că diff-ul nu conține scrieri/`done:`/`active:`;
- `npm test` verde, fără regresii;
- că lista DF (#61) și restul comportamentului sunt neatinse.
