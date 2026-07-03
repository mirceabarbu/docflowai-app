---
DIAGNOSTIC READ-ONLY — atașamentele DF/ORD nu apar ca „Documente suport" în flux (fix 3)
target_branch: develop (doar inspecție — NU se modifică nimic)
model_suggested: Opus 4.8 (trasare cale + ordering, fără fix)
risk: ZERO — read-only, fără edit, fără commit
---

# ⚠️ READ-ONLY — NU MODIFICA NIMIC
Doar diagnostic. NU edita, NU migra, NU commit, NU push. Output = raport de constatări + locul propus al fix-ului (dacă e cazul).

# Branch `develop` doar pentru inspecție. NU atinge `main`.

## Context
Fix 3 (commit `fc0fff5`) trebuia să copieze automat atașamentele formularului DF/ORD în fluxul de semnare ca „Documente suport" la lansarea fluxului. La lansarea unui flux dintr-o ORD, secțiunea „Documente suport" apare **goală** și NU apare banner-ul „📎 N atașamente preluate automat". Testele DB sunt verzi în CI, dar comportamentul real în browser nu e confirmat.

**Atenție la dependență:** există un bug separat (fix 6, încă nelivrat) prin care atașarea pe a doua ORD e blocată (buton dezactivat). Dacă ORD-ul respectiv NU are atașamente salvate, copierea (corect) nu are ce copia. Diagnosticul trebuie să distingă „ORD fără atașamente" (consecința fix 6) de „copiere defectă" (bug real fix 3).

## Ce trebuie trasat și raportat (fără edit)
```
# 0. ORD-ul testat are de fapt atașamente salvate? (sursa copierii)
grep -rn "formulare_atasamente\|atasamente.*ord\|ord.*atasament" server/db/index.mjs server/routes/formulare*.mjs
#   → confirmă TABELA reală în care se salvează atașamentele ORD + coloana discriminator (formType/tip) + cum se leagă de ord_id
#   (manual/CI: SELECT count(*) FROM <tabela> WHERE <discriminator>='ordnt' AND <fk>=<ordId al ORD-ului testat>)

# 1. Hook-ul de copiere — unde e și CE endpoint îl declanșează
grep -rn "copyFormularAttachmentsToFlow\|formAttachmentsCopied" server/routes/flows/crud.mjs server/services/formular-flow-attachments.mjs public/js/
# 2. ORDERING critic: meta.ordId / meta.dfId e setat ÎNAINTE de apelul copierii?
grep -n "meta.ordId\|meta.dfId\|saveFlow\|copyFormularAttachmentsToFlow\|createFlow" server/routes/flows/crud.mjs
#   → în createFlow, verifică ordinea reală a liniilor: linkarea meta.ordId TREBUIE să preceadă copierea; altfel formId=null → copiază 0

# 3. Calea de lansare flux din DF/ORD trece prin ACELAȘI createFlow cu hook?
grep -rn "mkFlow\|notafd\|ordnt\|createFlow\|/api/flows\|POST.*flows" public/js/formular/*.js server/routes/flows/*.js
#   → confirmă că lansarea din ORD lovește endpoint-ul hooked, nu altă rută de creare flux fără hook

# 4. Ce SELECT face copierea (formType/formId) vs cum sunt stocate atașamentele ORD
grep -n "INSERT INTO flow_attachments\|SELECT\|formType\|formId\|deleted_at\|NOT EXISTS\|filename" server/services/formular-flow-attachments.mjs
#   → discriminatorul folosit la SELECT ('ordnt'? 'ord'?) trebuie să fie IDENTIC cu cel din tabela sursă; altfel match 0

# 5. UI: „Documente suport" în signer/initiator citește din flow_attachments (destinația copierii)?
grep -rn "Documente suport\|flow_attachments\|attachments" public/semdoc-initiator/*.js public/js/semdoc-initiator/main.js
#   → confirmă că destinația copierii (flow_attachments) e exact ce randează UI-ul; altfel copiază corect dar afișează din alt slot
```

## Întrebări la care raportul trebuie să răspundă explicit
1. ORD-ul testat are rânduri în tabela de atașamente? (dacă 0 → cauza e fix 6, nu fix 3; copierea e corectă cu 0.)
2. `meta.ordId` e setat înainte ca `copyFormularAttachmentsToFlow` să ruleze în `createFlow`? (ordering bug = formId null = copiază 0.)
3. Lansarea fluxului din ORD trece prin endpoint-ul care conține hook-ul, sau printr-o rută de creare flux diferită (fără hook)?
4. Discriminatorul (`formType`) din SELECT-ul copierii coincide EXACT cu valoarea stocată în tabela sursă pentru ORD? (mismatch = match 0.)
5. UI-ul „Documente suport" randează din `flow_attachments` (destinația copierii)?
6. `formAttachmentsCopied` apare în răspunsul de creare flux și e citit corect de frontend pentru banner?

## Output cerut
Raport scurt cu verdict: **fix 6 (ORD fără atașamente)** SAU **fix 3 defect** — și dacă e fix 3, cauza exactă (ordering / endpoint greșit / discriminator mismatch / UI slot) cu fișier:linie și locul propus al fix-ului. NU aplica nimic.

(Manual util: deschide consola la lansarea fluxului din ORD; vezi dacă răspunsul conține `formAttachmentsCopied` și ce valoare are.)
