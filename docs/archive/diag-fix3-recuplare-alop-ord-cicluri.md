---
DIAGNOSTIC READ-ONLY — fix 3 copiază 0: cuplat la `flows.form_type`/`meta.ordId` (goale) în loc de `alop_ord_cicluri`
target_branch: develop (doar inspecție — NU se modifică nimic)
model_suggested: Opus 4.8 (trasare cale ALOP, fără fix)
risk: ZERO — read-only, fără edit, fără commit
---

# ⚠️ READ-ONLY — NU MODIFICA NIMIC
Doar diagnostic. NU edita, NU migra, NU commit, NU push. Output = raport + locul propus al fix-ului. Fixul vine în prompt separat.

# Branch `develop` doar pentru inspecție. NU atinge `main`.

## Fapte confirmate în DB producție (nu presupuneri)
1. ORD `fd2e00e3-bc4a-40bb-b67c-546900468736` are 2 atașamente reale în `formulare_atasamente` (`form_type='ord'`, `deleted_at IS NULL`).
2. Ciclul ORD respectiv are flux legat: `alop_ord_cicluri.ord_flow_id = 'PT_A698690EC0'`, `status='completed'`.
3. `flow_attachments` pentru `flow_id='PT_A698690EC0'` = **0 rânduri** (nimic copiat).
4. **TOATE** cele 378 de fluxuri au `flows.form_type = 'none'`; coloana `flows.form_instance_id` nu e populată cu ORD-ul.
5. Concluzie: fix 3 (`copyFormularAttachmentsToFlow`) e cuplat la `flows.form_type='ord'` + `body.meta.ordId`, dar legătura reală flux↔ORD se ține în **`alop_ord_cicluri` (`ord_id` → `ord_flow_id`)**. Helper-ul de copiere e corect intern (testele DB îl apelau direct cu pereche validă), dar pe calea reală nu primește niciodată `ordId`+`flowId` corecți.

## Ce trebuie trasat și raportat (fără edit)
```
# 1. Cum/unde se creează fluxul din ORD și DE CE flows.form_type rămâne 'none'
grep -rn "form_type\|form_instance_id\|INSERT INTO flows\|saveFlow\|createFlow" server/routes/flows/crud.mjs | head -40
#   → la INSERT/persistare flux, form_type primește vreodată 'ord'/'df', sau default 'none'? de ce nu se setează din ALOP?

# 2. PUNCTUL DE LINK: unde se scrie alop_ord_cicluri.ord_flow_id (acolo trebuie agățată copierea)
grep -rn "ord_flow_id\|link-ord-flow\|linkOrdFlow\|alop_ord_cicluri" server/routes/ server/services/ | head -40
#   → endpoint-ul / funcția care face UPDATE alop_ord_cicluri SET ord_flow_id = ... ; aici ord_id ȘI ord_flow_id sunt ambele cunoscute

# 3. Cum arată acum hook-ul fix 3 și ce primește efectiv
grep -rn "copyFormularAttachmentsToFlow\|formAttachmentsCopied" server/routes/flows/crud.mjs server/services/formular-flow-attachments.mjs

# 4. Semnătura helper-ului (ce params cere: flowId, formType, formId) — pt. a-l rechema corect din punctul de link
grep -n "export\|function\|INSERT INTO flow_attachments\|form_type\|form_id\|flow_id\|NOT EXISTS\|deleted_at" server/services/formular-flow-attachments.mjs

# 5. Există deja un DF echivalent? (DF se leagă prin alt câmp — df_flow_id pe alop_instances?) pentru paritate
grep -rn "df_flow_id\|link-df-flow\|alop_instances" server/routes/ server/services/ | head -20
```

## Întrebări la care raportul trebuie să răspundă explicit
1. La crearea/persistarea fluxului (`crud.mjs`), de ce `flows.form_type` rămâne `'none'`? E un default care nu se suprascrie niciodată din lansarea ALOP? (explică de ce cuplarea actuală a fix 3 e moartă din start)
2. Care e funcția/endpoint-ul exact care setează `alop_ord_cicluri.ord_flow_id` (UPDATE), și acolo sunt disponibile simultan `ord_id` + `ord_flow_id`? (= punctul corect de declanșare a copierii)
3. Helper-ul `copyFormularAttachmentsToFlow(pool, {flowId, formType, formId})` poate fi rechemat din acel punct cu `formType='ord'`, `formId=ord_id`, `flowId=ord_flow_id` fără modificări interne? (helper-ul rămâne neatins, doar punctul de apel se schimbă)
4. Echivalentul DF: legarea DF↔flux trece prin `df_flow_id` (pe `alop_instances`?) — există același bug și pe DF, sau DF folosea deja calea bună? (pentru ca fixul să acopere ambele simetric)
5. Idempotența (`NOT EXISTS` pe `flow_id`+`filename`) rămâne validă dacă copierea se mută la punctul de link (care poate rula de mai multe ori)?
6. Backfill: ciclurile deja existente (ex. `ord_flow_id='PT_A698690EC0'`) — un script ADD-ONLY care apelează copierea pentru cicluri cu `ord_flow_id IS NOT NULL` și fără atașamente în flux ar fi sigur și idempotent?

## Output cerut
Raport scurt: (a) de ce `form_type='none'` face cuplarea actuală inutilă; (b) funcția:linie exactă unde se scrie `ord_flow_id` = punctul propus de declanșare a copierii; (c) confirmarea că helper-ul rămâne neatins (doar re-cuplare la apel); (d) dacă DF are același bug; (e) schiță backfill idempotent. NU aplica nimic.
