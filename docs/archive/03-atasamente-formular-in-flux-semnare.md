---
fix: 3 / 4 — Transfer atașamente DF/ORD în fluxul de semnare ca documente suport (fără re-upload)
target_branch: develop
model_suggested: Opus 4.8 (adiacent zonei de semnare + interacțiune cu arhivarea Drive)
risk: MEDIU-RIDICAT — lângă lanțul de semnare și atinge arhivarea atașamentelor
---

# ⚠️ BRANCH `develop` EXCLUSIV
Toate comenzile rulează pe `develop`. NU `checkout/merge/push` pe `main`. `main` = producție, manual de owner.

## NO-TOUCH (critic aici — suntem lângă semnare)
`STSCloudProvider.mjs`, `cloud-signing.mjs`, `bulk-signing.mjs`, `pades.mjs`, `java-pades-client.mjs`. `git diff` TREBUIE gol pe ele. Atingem DOAR crearea fluxului + copierea atașamentelor, nimic din semnare/PAdES.

## Obiectiv
La **lansarea fluxului de semnare din DF/ORD** (`mkFlow('notafd')` pentru DF, echivalentul pentru ORD), atașamentele uploadate pe formular (ex. „declaratie interese 2026.pdf", „declaratie avere 2026.pdf") să fie **copiate automat în flux ca documente suport** (`flow_attachments`), ca utilizatorul să NU le reîncarce în fluxul de semnare.

**Important — domeniul exact:** se transferă DOAR atașamentele uploadate de utilizator pe formular. NU se transferă „capturile"/conținutul randat al formularului — acela apare deja pe PDF-ul generat al DF/ORD. Deci: PDF DF/ORD generat = documentul principal (ca acum); atașamentele de formular = documente suport în flux.

## Caracterizare-întâi (obligatoriu)
```
# unde se creează fluxul din DF/ORD (frontend)
grep -n "mkFlow\|notafd\|ordnt\|link-df-flow\|link-ord-flow\|creare.*flux\|lanseaz" public/js/formular/*.js
# tabela și endpointurile atașamentelor de formular (sursa bytes)
grep -rn "atasamente\|attachment" server/routes/formulare-db.mjs server/routes/formulare*.mjs server/db/index.mjs | head -40
# tabela și endpointurile atașamentelor de flux (destinația)
grep -rn "flow_attachments" server/routes/flows/attachments.mjs server/db/index.mjs | head -40
# crearea fluxului pe backend (unde se inserează fluxul) — punctul de hook pentru copiere
grep -rn "INSERT INTO flows\b\|createFlow\|flows_pdfs\|mkFlow" server/ | head -30
# ARHIVARE: cum sunt arhivate atașamentele de flux în Drive (bug-ul vechi cu data=NULL)
grep -n "flow_attachments\|drive_file_id\|data=NULL\|att.data\|uploadFile" server/drive.mjs | head -30
```

## Implementare
1. **Hook la crearea fluxului din DF/ORD** (backend, în endpoint-ul care creează fluxul când vine din formular): după ce fluxul e creat, **copiază** rândurile din atașamentele de formular ale acelui DF/ORD în `flow_attachments` pentru noul `flow_id`, marcate ca documente suport.
   - Copiază bytes-ul/`data` din sursa de formular în `flow_attachments.data` (sau folosește același mecanism de stocare ca atașamentele de flux uzuale — respectă schema existentă a `flow_attachments`, fără migrare nouă dacă coloanele acoperă cazul).
   - Păstrează numele original al fișierului și content-type-ul.
2. **Idempotență**: dacă fluxul se re-lansează / fixul rulează de două ori, NU duplica atașamentele (verifică după `flow_id` + nume fișier înainte de insert).
3. **Compatibilitate cu arhivarea Drive** (regresie cunoscută): atașamentele copiate trebuie să se arhiveze corect în Drive ca celelalte `flow_attachments`, iar la upload în Drive `data` se setează `NULL` exact ca în fluxul existent (nu reintroduce bug-ul de umflare DB). Verifică `server/drive.mjs` — atașamentele copiate trec prin aceeași cale.
4. **Frontend**: dacă există un pas în care utilizatorul e invitat să încarce documente suport în flux, indică vizual că atașamentele de formular au fost preluate automat (listă pre-populată). Nu forța re-upload.
5. NU atinge generarea PDF-ului DF/ORD și nici cartușul de semnături.

## Teste
- Caracterizare DB/integration: flux creat din DF cu 2 atașamente → 2 rânduri în `flow_attachments` pentru noul `flow_id`, cu nume/content-type corecte. Re-lansare → fără duplicate.
- Regresie arhivare: fluxul cu atașamente preluate se arhivează în Drive; după arhivare `data=NULL` pe acele rânduri (nu se umflă DB). Calculul de mărime (`getFlowPdfBytesMap` / helperele de stats) include atașamentele preluate.
- Caracterizare: crearea fluxului fără atașamente de formular = comportament neschimbat.
- `npm test` verde.

## Acceptare
- `npm test` → **verde, fără regresii**.
- `git diff` NO-TOUCH (semnare) = gol.
- Fără migrare nouă dacă schema `flow_attachments` acoperă cazul; dacă chiar e necesară o coloană (ex. flag „sursă: formular"), folosește migrare inline în `server/db/index.mjs` ADD-ONLY.
- Cache-bust țintit + bump `package.json` patch.

## Finalizare
```
git add -A
git commit -m "feat(flux): preia automat atașamentele DF/ORD ca documente suport la lansarea fluxului de semnare (idempotent, arhivare Drive ok)"
git push origin develop
```
