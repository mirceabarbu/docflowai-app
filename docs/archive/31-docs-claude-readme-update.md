---
docs: actualizare CLAUDE.md + README.md cu arcul complet al sesiunii (transmitere internă, 2× IDOR închis, dedup notificări, lock identitate ÎNTOCMIT, trasabilitate) + arhivare prompturi 21-30
target_branch: develop
model_suggested: Sonnet 4.6 (task de documentare, fără logică — dar cere acuratețe pe ce s-a livrat efectiv)
risk: FOARTE SCĂZUT (doar fișiere .md, zero cod de aplicație)
version: 3.9.610 → 3.9.611
---

# ⚠️ BRANCH `develop` EXCLUSIV
TOATE comenzile pe `develop`. NU `checkout`/`merge`/`push` pe `main`. La final `git push origin develop` și **STOP**.

# 🎯 Scop
Sesiunea curentă (prompturile 21→30, v3.9.600→3.9.610) a livrat un arc complet de funcționalitate + hardening. Documentează-l în `CLAUDE.md` (referință tehnică pentru sesiuni viitoare) și `README.md` (prezentare produs), și arhivează cele 10 fișiere de prompt care au produs-o, urmând convenția deja existentă în `docs/archive/`.

# 🚫 NO-TOUCH
Fișier de aplicație ZERO. Doar `CLAUDE.md`, `README.md`, și mutarea/adăugarea fișierelor din `docs/archive/`.

# Etapa 0 — caracterizare
```bash
grep -n "^##" CLAUDE.md | tail -20
tail -5 CLAUDE.md
grep -n "^##" README.md
sed -n '1,5p' README.md
ls docs/archive/ | sort | tail -10
grep -n '"version"' package.json | head -1
# Verifică unde sunt fișierele 21-30 (rădăcina repo, dacă persoana le-a pus acolo, sau deja în docs/archive/):
find . -maxdepth 2 -iname "2[1-9]-*.md" -o -iname "30-*.md" 2>/dev/null | grep -v node_modules
```

# Partea 1 — arhivare prompturi
Cele 10 fișiere de prompt ale sesiunii (`21-feat-transmitere-interna-engine.md` … `30-fix-test-and-feat-flow-transmit-traceability.md`) trebuie să existe/ajungă în `docs/archive/`, exact ca prompturile anterioare (`01-tab-implicit-alop.md`, `02-audit-df-ord.md` etc. — convenție `NN-descriere-kebab.md`, deja respectată de numele lor). Dacă persoana le-a plasat la rădăcina repo sau altundeva, mută-le:
```bash
git mv <sursă>/21-feat-transmitere-interna-engine.md docs/archive/ 2>/dev/null || true
# ... repetă pentru toate cele 10, sau folosește un loop dacă sunt într-un singur folder
```
Dacă fișierele NU sunt încă prezente nicăieri în repo (persoana urmează să le adauge manual), SARI peste această parte — nu inventa conținutul lor — și menționează explicit în raport că arhivarea rămâne de făcut manual.

# Partea 2 — `CLAUDE.md`

## 2a. Secțiune nouă de feature (după secțiunea „Capabilities" sau înainte de „Cache busting" — alege un loc coerent cu fluxul documentului, vezi Etapa 0 pentru TOC exact)
```markdown
## Transmitere internă (repartizare) — user/compartiment + confirmare (din v3.9.601–3.9.610)

Documentul semnat + atașamentele unui flux pot fi transmise, prin aplicație, unui **utilizator
SAU unui compartiment întreg** — inclusiv persoane care NU au fost semnatari. Terminologie
domeniu: „repartizare". Sursa de adevăr a accesului: tabelul `flow_recipients`.

### Arhitectură
- `server/services/flow-transmit.mjs` — serviciu PUR (fără dependențe de semnare):
  `normalizeRecipients`, `transmitFlowTo` (insert idempotent ON CONFLICT), `isFlowRecipient`,
  `resolveRecipientEmails` (expansiune compartiment→useri), `listReceivedFor`, `acknowledgeReceipt`.
- `server/services/flow-access.mjs` — `canActorReadFlow` (mutat din `crud.mjs`, semantică identică)
  + `isFlowAccessAllowed` = `canActorReadFlow ∪ isFlowRecipient`. Poartă unică pentru acces la
  metadata fluxului ȘI la conținut (`signed-pdf`, `pdf`, `attachments`).
- `server/routes/flows/transmit.mjs` — `POST /flows/:id/transmit` (manual), `POST /flows/:id/acknowledge`,
  `GET /api/my-received`. Authz pe transmitere = `canActorReadFlow` (NU include destinatari —
  transmiterea e acțiune de inițiator/semnatar/admin, nu a cuiva care doar a primit documentul).
- **Auto-transmit la finalizare**: EXCLUSIV în `notify()` din `server/index.mjs`, pe ramura
  `type==='COMPLETED'`, citind `data.transmiteLaFinalizare` (setat opțional la creare flux, din
  UI-ul `semdoc-initiator`). Non-fatal (try/catch) — un eșec de transmitere NU rupe notificarea
  COMPLETED către inițiator. NU există niciun cârlig în fișierele de semnare NO-TOUCH.
- Migrații: `088_flow_recipients` (user XOR compartiment, CHECK + unicitate parțială),
  `089_flow_recipient_acks` (confirmare PER-PERSOANĂ — o repartizare pe compartiment are UN
  rând `flow_recipients`, dar fiecare membru confirmă individual).

### Trasabilitate (din v3.9.610)
`FLOW_TRANSMITTED`/`FLOW_ACKNOWLEDGED` scrise în `data.events[]` (sursă „Progres flux") ȘI
`audit_events` (sursă „Evenimente"), oglindind exact pattern-ul `EMAIL_SENT`/`EMAIL_OPENED`.
Corelare transmitere↔confirmare pe `recipientKey` (`user:<id>` sau `comp:<nume>`), NU pe ordine
cronologică — esențial când o transmitere pe compartiment are mai mulți confirmatori sau când
mai multe transmiteri sunt apropiate în timp.

### ⚠️ Lecție: `data.flowId` din JSONB NU e de încredere
`getFlowData()` întoarce blob-ul JSONB brut; câmpul `flowId` din el există DOAR dacă a fost
persistat explicit la creare — NU e garantat (fluxuri legacy, fixture-uri de test). Orice funcție
care are nevoie de id-ul fluxului trebuie să-l primească EXPLICIT (`req.params.flowId`), nu să-l
deriveze din `data.flowId`. (`isFlowAccessAllowed` a avut inițial exact acest bug — vezi
semnătura ei, care acceptă `flowId` ca parametru dedicat, cu fallback la `data.flowId` doar
pentru compatibilitate.)

**Regula:** pentru orice cod nou care lucrează cu un flux, id-ul autoritar e mereu cel din URL/
apelant, nu unul citit din interiorul blob-ului de date al fluxului.
```

## 2b. Secțiune nouă — integritate identitate ÎNTOCMIT (din v3.9.609)
```markdown
## Identitate ÎNTOCMIT — blocată la actorul autentificat (din v3.9.609)

Cine „întocmește" un document (rolul ÎNTOCMIT) NU poate fi ales liber — e mereu persoana
autentificată care creează fluxul, indiferent de origine (creare manuală, șablon propriu,
șablon partajat pe instituție, prefill ALOP/formulare, reinițiere).

- **Backend (plasa de siguranță reală):** în `createFlow` (`server/routes/flows/crud.mjs`),
  `initName`/`initEmail` se derivă din `actor` (JWT), NU din `body` — indiferent ce trimite
  clientul. Orice semnatar cu rol normalizat `ÎNTOCMIT` din `signers[]` e forțat la aceeași
  identitate. Validarea de format pe `body.initName`/`initEmail` (400 pre-auth) rămâne
  neschimbată — doar valorile REALE folosite după `requireAuth` sunt cele ale actorului.
- **Frontend (UX):** un singur punct de aplicare — `updateIntocmitVisibility()` în
  `semdoc-initiator/main.js`, deja apelată din toate căile de creare/modificare rânduri
  (MutationObserver pe tbody + rol-change handler + finalul `applyTemplate()`). Rândul activ
  ÎNTOCMIT devine `disabled`, sincronizat cu profilul userului logat (`localStorage.docflow_user`).
- **Efect colateral util:** cazul șablonului partajat pe instituție (ÎNTOCMIT salvat acolo
  aparține altcuiva) se rezolvă AUTOMAT prin aceeași regulă — fără cod separat, fără mesaj de
  eroare. Suprascrierea e silențioasă și sigură.

**Regula:** dacă adaugi o cale nouă de populare a rândurilor de semnatari (alt tip de prefill),
`updateIntocmitVisibility()` o acoperă automat DACĂ rândurile ajung în `tbody` prin DOM normal
(MutationObserver le prinde). Nu e nevoie să atingi call-site-ul nou.
```

## 2c. Actualizează tabelul „Index migrații ALOP & Formulare" (la coada fișierului)
Adaugă rândurile:
```
| server/db/index.mjs                       | 088_flow_recipients    | user XOR compartiment (repartizare), CHECK + unicitate parțială |
| server/db/index.mjs                       | 089_flow_recipient_acks | confirmare luare la cunoștință PER-PERSOANĂ |
```

## 2d. Actualizează „ZONE INTERZISE" — DOAR dacă lipsesc fișiere relevante
Verifică lista NO-TOUCH existentă (`STSCloudProvider.mjs`, `cloud-signing.mjs`, `bulk-signing.mjs`,
`pades.mjs`, `java-pades-client.mjs`) — NU adăuga `flow-access.mjs`/`flow-transmit.mjs`/`transmit.mjs`
acolo (NU sunt NO-TOUCH, sunt servicii normale, editabile). Doar confirmă că lista rămâne corectă.

# Partea 3 — `README.md`

## 3a. Bump versiune titlu
`# DocFlowAI v3.9.547` → `# DocFlowAI v3.9.611` (sau versiunea curentă reală din `package.json` după Etapa 0).

## 3b. Bullet nou în „Module principale" (după „Bulk Signing", înainte de „Verificare furnizor")
```markdown
### Transmitere internă (repartizare)
Documentul semnat + atașamentele unui flux finalizat pot fi transmise prin aplicație către un
**utilizator sau un compartiment** care nu a fost semnatar — automat la finalizare (configurabil
la creare) sau manual, cu rezoluție opțională. Confirmare de luare la cunoștință per-persoană,
inbox durabil „📥 Primite", trasabilitate completă în timeline-ul fluxului.
```

## 3c. Bullet-uri noi în „Securitate" (adaugă la lista existentă, NU rescrie ce e acolo)
```markdown
- Acces la documentele unui flux (PDF semnat, atașamente) restricționat la nivel de obiect —
  inițiator/semnatar/admin same-org/destinatar repartizat (închide un IDOR pre-existent, v3.9.603)
- Trimiterea externă de email (`send-email`) restricționată la aceeași bară de authz (v3.9.605)
- Identitatea „Întocmit" nu poate fi impersonată — derivată server-side din actorul autentificat,
  indiferent ce trimite clientul (v3.9.609)
```

# Guardrails diff
`git diff --name-only` atinge EXCLUSIV: `CLAUDE.md`, `README.md`, plus mutări/adăugări în `docs/archive/` (fișiere `.md`, fără cod).
```bash
git diff --name-only | grep -vE "^CLAUDE\.md$|^README\.md$|^docs/archive/" && echo "⛔ STOP: fișier neașteptat!" || echo "✅ doar documentație"
```
NU bump `package.json` pentru un commit doar-documentație — DAR dacă preferi consistență cu restul sesiunii, poți face un bump minor 3.9.610→3.9.611 (opțional, la alegerea ta; dacă o faci, fără `?v=`/`CACHE_VERSION`, e pur cosmetic).

# La final
```bash
git add CLAUDE.md README.md docs/archive/
git commit -m "docs: actualizare CLAUDE.md + README.md cu arcul sesiunii (transmitere internă, 2x IDOR închis, lock identitate ÎNTOCMIT, trasabilitate) + arhivare prompturi 21-30"
git push origin develop
```
**STOP. NU merge/push pe `main`.** Raportează:
1. Secțiunile noi adăugate în `CLAUDE.md` (transmitere internă + lecția `data.flowId` + lock ÎNTOCMIT) și unde au fost plasate în TOC.
2. Tabelul de migrații actualizat cu 088/089.
3. `README.md` — versiune, bullet modul nou, bullet-uri securitate.
4. Prompturile 21-30 — arhivate în `docs/archive/` SAU raportate ca „rămân de adăugat manual" dacă nu erau prezente în repo.
5. Guardrail: zero fișier de cod atins.
