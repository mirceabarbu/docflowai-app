---
DIAGNOSTIC READ-ONLY — atașare fișiere eșuează la a doua ORD (nouă ordonanțare)
target_branch: develop (doar inspecție — NU se modifică nimic)
model_suggested: Opus 4.8 (trasare cale, fără fix)
risk: ZERO — read-only, fără edit, fără commit
---

# ⚠️ READ-ONLY — NU MODIFICA NIMIC
Această sarcină e DOAR de diagnostic. NU edita fișiere, NU rula migrări, NU commit, NU push. Output-ul e un **raport de constatări** + locul propus al fix-ului. Așteaptă promptul de reparare separat.

# Branch `develop` (doar pentru context/inspecție). NU atinge `main`.

## Simptom
Pe o **a doua ORD** (creată prin „nouă ordonanțare" dintr-un DF aprobat, după o lichidare nouă), butonul „Atașează fișiere" din secțiunea „Compartiment specialitate — Date beneficiar & plată" nu permite atașarea. Prima ORD funcționează. Întrebare deschisă: e draft nesalvat fără `ST.docId['ord']`?

## Ce trebuie trasat și raportat (fără edit)
```
# 1. Mecanismul de atașare în formular (buffer + upload) — ORD
grep -n "addAtt\|remAtt\|Atașează\|Ataseaza\|attachInput\|fileInput\|upload.*atasament\|atasament.*upload" public/js/formular/core.js public/js/formular/doc.js public/formular.html

# 2. Unde se setează ST.docId['ord'] și starea ORD-ului la 'nouă ordonanțare'
grep -n "ST.docId\|docId\['ord'\]\|docId.ord\|nouaOrd\|noua-ord\|nouă ordon\|newOrd\|createOrd\|openOrd" public/js/formular/*.js

# 3. Câte zone de atașare are ORD-ul (poate fi una la 'Documente justificative' și alta la 'Date beneficiar')
grep -n "Atașează\|Documente justificative\|Date beneficiar\|atasament" public/formular.html

# 4. Endpoint-ul de upload atașament ORD + eventuale guard-uri (doc salvat? deleted_at? auth?)
grep -rn "atasament\|attachment\|upload" server/routes/formulare-db.mjs server/routes/formulare*.mjs | grep -i "post\|upload\|insert"

# 5. Diferența cheie: cum se inițializează contextul de atașare la PRIMA ORD vs la A DOUA (nouă ordonanțare)
grep -n "newDoc\|openDoc\|showFormSection\|resetForm\|_attBuffer\|pendingAtt\|ST.att" public/js/formular/*.js

# 6. Verifică dacă fix 3 (copiere atașamente formular→flux) a atins calea de upload din formular
git log --oneline -5 -- server/routes/formulare-db.mjs public/js/formular/core.js public/js/formular/doc.js
git show fc0fff5 --stat
```

## Întrebări la care raportul trebuie să răspundă explicit
1. Atașarea în formular cere un `id` de document persistat (ORD salvat) înainte de upload, sau bufferează în memorie și încarcă la salvare? (decide între „draft fără id" vs „buffer neinițializat").
2. La „nouă ordonanțare", ORD-ul nou primește un `ST.docId['ord']` valid în momentul în care butonul „Atașează" e activ, sau e încă draft?
3. Există un guard pe endpoint (ex. „document inexistent/needitabil") care respinge upload-ul pentru a doua ORD?
4. Butonul „Atașează" e legat de aceeași zonă/handler ca la prima ORD, sau e un al doilea bloc de atașare cu binding diferit/lipsă?
5. Confirmă dacă fix 3 / commit `fc0fff5` a modificat calea de upload din formular (ar trebui să NU — doar copierea spre flux).

## Output cerut
Un raport scurt: cauza probabilă (cu fișier:linie), confirmarea că NU e regresie din fix 3 (sau, dacă e, unde), și **locul exact** unde ar trebui fix-ul — fără să-l aplici.

(Manual, în paralel, util pentru raport: deschide consola browserului pe a doua ORD, apasă „Atașează" și notează dacă apare eroare în Console sau un request roșu în Network — și ce status are.)
