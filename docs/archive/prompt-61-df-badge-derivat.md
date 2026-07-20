---
prompt: 61
titlu: "fix(listă DF): badge-ul derivă „transmis_flux" din fluxul activ (ca ORD & ca detaliul), nu din statusul persistat"
model_suggested: Opus 4.8
branch: develop
zona: afișare status DF/ORD · coerență listă↔detaliu (DOAR afișare)
---

# ⛔ BRANCH DISCIPLINE
> EXCLUSIV pe `develop`. NU merge/push/checkout pe `main`.

---

## Simptom (owner)
Un DF pe fluxul de semnare apare corect „🔄 Trimis flux" în ALOP și „Document pe fluxul de semnare" în **detaliul** DF, dar în **lista DF** apare „✅ Completat". #56 (flip `status='transmis_flux'` pe `link-df-flow`) nu acoperă toate căile de lansare, deci uneori `fd.status` rămâne `completed`.

## Idee (owner, corectă)
Detaliul DF **nu** se bazează pe statusul persistat — derivă `flow_active` din `fd.flow_id` + flux activ (`df.mjs:136-141`). Lista trebuie să afișeze din **aceeași sursă**, nu din `fd.status`. ORD face deja exact asta în listă; DF e singurul rămas pe status persistat. **DOAR afișare — nu schimbăm nimic funcțional.**

## Fix (o singură expresie SQL)
`server/routes/formulare/shared.mjs` — ramura **DF** (`badge_status`, ~liniile 479-480). Înlocuiește:

```sql
          CASE WHEN fd.flow_id IS NOT NULL AND (f.data->>'status' = 'completed' OR (f.data->>'completed')::boolean = true)
               THEN 'aprobat' ELSE fd.status END AS badge_status,
```
cu (**identic cu ramura ORD**, `fd` în loc de `fo`):
```sql
          COALESCE(
            CASE WHEN fd.status = 'completed'
                      AND fd.flow_id IS NOT NULL
                      AND f.deleted_at IS NULL
                      AND (f.data->>'completed') IS DISTINCT FROM 'true'
                      AND (f.data->>'status')    IS DISTINCT FROM 'cancelled'
                 THEN 'transmis_flux' END,
            CASE WHEN fd.flow_id IS NOT NULL
                      AND (f.data->>'status' = 'completed' OR (f.data->>'completed')::boolean = true)
                 THEN 'aprobat' ELSE fd.status END
          ) AS badge_status,
```

**Corectitudine (verifică):**
- Adaugă DOAR cazul „completed + flux activ → transmis_flux". Restul rămâne: fără flux → `fd.status`; flux completat → `aprobat`; `transmis_flux` persistat → ramura ELSE îl întoarce oricum.
- Frontend-ul (`list.js _stBadge`) mapează deja `transmis_flux → 🔄 Trimis flux` — nimic de schimbat în FE.
- ⛔ NU atinge #56 (flip-ul rămâne — statusul persistat e valid, coexistă). NU atinge ramura ORD. NU atinge capabilities/detaliul.

## Test de caracterizare — `server/tests/db/formulare-status-display.test.mjs`
Asimetria DF↔ORD **nu mai e valabilă** (a fost sursa recurentă de bug-uri). Actualizează:
- **Elimină/inversează** aserția care spunea „DF NU derivă transmis_flux (asimetrie intenționată)".
- **Adaugă** cazul DF: `status='completed'` + flux activ (flux nici completed, nici cancelled) → `badge_status='transmis_flux'`.
- **Păstrează** verzi: DF `completed` fără flux → `completed`; DF flux completat → `aprobat`; DF `transmis_flux` persistat → `transmis_flux`.
- Actualizează comentariul din antet: DF și ORD derivă acum **identic** badge-ul din fluxul activ.

`npm test verde, fără regresii`. `npm run check` OK.

## Notă (efect secundar bun)
Cu derivarea din flux, **backfill-ul #56 devine inutil** pentru afișare (lista arată corect indiferent de `fd.status`). Nu-l rula decât dacă vrei și datele „curate".

## Cache busting + versiune
Doar server + test (fără FE) ⇒ **fără** bump `sw.js` / `?v=`. Bump `package.json` la următorul patch de la valoarea reală curentă.

## Guardrails diff
`git diff --name-only` = EXCLUSIV: `server/routes/formulare/shared.mjs`, `server/tests/db/formulare-status-display.test.mjs`, `package.json`.
```bash
git diff server/routes/formulare/shared.mjs | grep -iE "fo\.status|ORD|formulare_ord" && echo "⚠️ verifică: ramura ORD NU trebuie modificată" || echo "✅ doar ramura DF"
```

## Verificare (owner, staging)
- DF pe flux (imaginea „Servicii IT") în lista DF → „🔄 Trimis flux"; detaliu neschimbat; ALOP neschimbat.
- DF aprobat → „Aprobat"; DF completat fără flux → „Completat".

## Final
```bash
git add server/routes/formulare/shared.mjs server/tests/db/formulare-status-display.test.mjs package.json
git commit -m "fix(lista-df): badge_status derivă transmis_flux din flux activ (paritate cu ORD & detaliu)"
git push origin develop
```
**STOP. NU merge/push pe `main`.**
