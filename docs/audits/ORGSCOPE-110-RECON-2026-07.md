# ORGSCOPE-110 — Recon: inventarul scopărilor brute pe org (READ-ONLY)

**Data:** 2026-07-23 · **Branch:** develop · **Bază:** v3.9.739 (post-#105) · **Autor recon:** Claude (Opus 4.8)
**Scop:** clasificarea referințelor `org_id`/`orgId` din afara contractului `authz-scope.mjs`. Zero cod de producție atins.

Contract de referință (`server/services/authz-scope.mjs`, decis 22.07.2026, **role-only**):
`isPlatformAdmin(actor) = actor.role==='admin'` · `orgScopeSql()` → `''` pentru platform-admin, altfel
` AND alias.org_id = $N` (non-platform fără org ⇒ `= NULL` ⇒ 0 rânduri, fail-closed) · `actorCanAccessOrg()`.

Legendă categorii: **(W)** scriere legitimă org_id · **(O)** operație proprie org-ului (întrebare de produs) ·
**(S)** ar trebui pe contract (azi lockout) · **(L)** leak · **(N)** neutru / deja pe contract.

---

## 0. Rezumat executiv

- **Niciun (L) leak găsit.** Confirmă ipoteza promptului: numărul brut ≠ număr de probleme. Majoritatea
  referințelor sunt (W) sau (O) legitime, sau deja pe contract (#105).
- **O singură surpriză reală:** `flows/crud.mjs:903` — ruta `GET /my-flows/:flowId/download` folosește un
  check inline `isAdmin && sameOrg` care **NU** oglindește `isFlowAccessAllowed` (ratează ramura
  platform-admin cross-org ȘI ramura destinatar-repartizat). E **lockout** (mai strict decât contractul),
  nu leak — dar e o **duplicare tăcută** a genului pe care #105 tocmai l-a consolidat. **Prioritate de fix.**
- **Două zone (O) mari — `opme.mjs` și `registratura.mjs`** — scopează corect pe org propriu, dar diferă în
  UX de eșec: `opme` = **403 explicit** (`org_required`, 7×), `registratura` = **listă goală tăcută** (0×
  `org_required`). Ambele ridică aceeași întrebare de produs: vede platform-adminul cross-org la suport?
- Restul (`admin/*`, `templates`, `chat`, `auth`, `notifications`) e **deja pe contract** sau neutru.

**Numărătoare pe categorii** (referințe clasificate, aproximativ — grupate funcțional, nu 1:1 pe grep):

| Cat | Nr aprox. | Unde |
|-----|-----------|------|
| (W) scriere | 12 | INSERT org_id: opme_imports/opme_lines, registru_*, users, archive_jobs, templates, flows, delegations |
| (O) operație proprie | 34 | opme.mjs (toate rutele), registratura.mjs (toate rutele), notifications my-notifications, users „colegii mei" |
| (S) lockout de reparat | 1 | crud.mjs:903 my-flows download (inline, ratează platform-admin + recipient) |
| (L) leak | **0** | — |
| (N) neutru / pe contract | 26 | admin/flows (actorOrgFilter), admin/analytics (actorOrgFilter), admin/organizations (role-gate), admin/users (tenant-guards), templates (actorCanAccessOrg), chat (participant), auth (JWT build), actor-identity, authz-formular |

---

## 1. Inventar clasificat (pe fișier)

### `server/routes/opme.mjs` — 30 refs · sursă actor: **`requireAuth` helper** · formă: **`orgId` camel**
Eșuare **explicită**: 7× `403 org_required`. Se poate cabla DIRECT pe `authz-scope` (fără adaptor `accessActor`).

| Linie | Rută / funcție | Cat | Justificare |
|-------|----------------|-----|-------------|
| 57 | `_hasOpmeImportRole` `role==='admin'→true` | N | poartă de ROL (trece platform-admin) |
| 58 | `_hasOpmeImportRole` `org_admin && orgId` | O | capability scopată pe org |
| 66–85 | `_hasOpmeImportRole` query CAB/P2-comp | O | verifică drepturi în org propriu |
| 97,315,381,455,508,551,635 | toate rutele: `if(!orgId) 403 org_required` | O | fail-closed **explicit** pe org propriu |
| 155,190,197,216,219 | import: check dublură + INSERT | W/O | INSERT `org_id`=(W); check `WHERE org_id`=(O) |
| 341,391,400,417,465,482,521,532,563,580,656,671 | list/detail/export/rematch: `WHERE ...org_id=$` | O | citiri scopate pe org propriu |

**Contradicție de notat (NU repara):** `_hasOpmeImportRole` line 57 acceptă `role==='admin'` (poarta de ROL
trece pentru platform-admin), DAR fiecare rută rulează `if(!actor.orgId) return 403 org_required` **înainte**
de poarta de rol (ex. `/import` line 97 înaintea line 98). Deci un platform-admin **fără org** e blocat de
poarta de ORG înainte să conteze rolul, iar toate query-urile depind de `actor.orgId`. În prod nu mușcă
(`admin@docflowai.ro` are `org_id=1`); ar mușca dacă org-ul adminului redevine NULL, sau la suport cross-org.

### `server/routes/registratura.mjs` — 19 refs · sursă: **`requireAuth` helper** · formă: **`orgId` camel**
Eșuare **tăcută**: **0×** `org_required`. Cu `orgId` absent → liste goale fără explicație. Cablabil direct.

| Linie | Rută | Cat | Justificare |
|-------|------|-----|-------------|
| 93–94,149–150 | GET registre intrări/ieșiri: `WHERE r.org_id=$1` | O | listare scopată **tăcut** pe org |
| 229–231,293–296,356–358 | INSERT/UPDATE registru + atașamente | W | scriere org_id ca proprietar |
| 256,318–324,351–352,377–378,393–394 | detaliu / legătură flux / atașamente: `WHERE ...org_id=$` | O | citire scopată (download atașament e org-scoped → **NU** leak) |
| 415–429 | GET compartimente+useri org | O | `if(!orgId) return {compartimente:[],users:[]}` — tăcut |

### `server/routes/admin/users.mjs` — 9+ refs · sursă: **mix** (`requireAuth` helper + `resolveActorOr`) · formă: **`org_id` snake** (din rând DB)
| Linie | Rută | Cat | Justificare |
|-------|------|-----|-------------|
| 63–79 | GET `/users` (colegii din instituție) | O | `actor.org_id` snake; platform-admin null → listă goală tăcută. Comentariu SEC-90 explică de ce NU folosește `actorOrgFilter` |
| 132–146 | GET `/users/all` | N | org_admin scopat; platform-admin (role admin) → `WHERE 1=1` cross-org (management corect) |
| 213,236–274,478–479,872–876 | POST create user / delegation: INSERT org_id | W | scriere proprietar |
| 592–595,621–634,694–705,812–814,962–969,1021–1028 | update/delete/assign-org/gws: tenant-guard `org_admin && target.org_id!==actorOrgId → 403` | N | gardă de tenant corectă (redundant `SELECT org_id` — vezi Note) |
| 780–795 | assign-org (schimbă org userului) | N | acțiune de admin platformă |

### `server/routes/admin/flows.mjs` — 8 refs · sursă: **`requireAuth` helper** · formă: **`orgId` camel**
| Linie | Rută | Cat | Justificare |
|-------|------|-----|-------------|
| 53,55,89–90 | list flows / audit: `actorOrgFilter(actor)` | N | **deja pe contract** (via `_helpers.mjs`, rescris #105c) |
| 150–151,225–226,266–278,435,478 | archive candidates / user-maps: `actor.orgId` + `role==='org_admin'` dispatch | N | platform-admin (role admin) → org null → cross-org (corect); org_admin scopat, `org_admin_no_org` 403 |
| 387 | INSERT archive_jobs org_id | W | scriere proprietar |
| 438,485,495 | `institutie` în SELECT/filtru | N | doar **display filter** în query deja org-scoped — NU authz (nu e clasa SEC-90) |

### `server/routes/flows/crud.mjs` — 4 refs · sursă: **mix** · formă: **mix**
| Linie | Rută | Cat | Justificare |
|-------|------|-----|-------------|
| 350,408,451–458 | createFlow: INSERT org_id + UPDATE formulare `WHERE org_id` | W | scriere/legare proprietar |
| 763–778 | GET `/my-flows` list: `org_id=$2` strict | O | listare scopată pe org propriu |
| **903–905** | **GET `/my-flows/:flowId/download`** | **S** | ⚠️ inline `isAdmin && sameOrg` — **ratează** `isPlatformAdmin(actor)` ȘI ramura `isFlowRecipient`. Duplicat divergent al `isFlowAccessAllowed` (pe care signed-pdf/pdf le folosesc corect). **Lockout explicit** |

### Restul — deja pe contract sau neutru
| Fișier | Refs | Cat | Note |
|--------|------|-----|------|
| `templates.mjs` | 2 | N | folosește `actorCanAccessOrg` + adaptor `accessActor={role,orgId:org_id}` (snake→camel). **Pe contract.** |
| `admin/analytics.mjs` | 2 | N | `actorOrgFilter(actor)` peste tot. **Pe contract.** `org_admin_no_org` 403 explicit. |
| `admin/organizations.mjs` | 2 | N | rute gate-uite `role!=='admin'→403` (management platform-only). Cele 2 `actor.orgId` = test config semnare pe org propriu (O). |
| `chat.mjs` | 2 | N | model participant-based (`chat-access.mjs`), `platform_support` = traversare intenționată cu poartă proprie (404 non-participant). **Re-confirmat curat**, neschimbat de la #105. |
| `notifications.mjs` | 1 | O | my-notifications scopat pe org propriu. |
| `auth.mjs` | 2 | N | construiește `orgId` în payload-ul JWT din `user.org_id`. Nu e scoping. |
| `services/actor-identity.mjs` | 1 | N | reconciliere `tokenOrgId` vs `dbOrgId`. Nu e scoping. |
| `services/authz-formular.mjs` | 1 | N | doar comentariu; logică per-compartiment separată prin design. |

---

## 2. Distincția lockout vs leak (pentru (S) și (L))

- **(S) `crud.mjs:903` my-flows download** — direcție: **lockout** (mai strict decât contractul).
  - platform-admin (org null) → **403 explicit** (ratează ramura `isPlatformAdmin`).
  - destinatar repartizat (`flow_recipients`) → **403 explicit** (ratează ramura `isFlowRecipient` pe care
    `isFlowAccessAllowed` o are). Acesta e un **gol funcțional real** al transmiterii interne (v3.9.601+):
    cineva care a primit documentul prin repartizare îl poate vedea pe signed-pdf/pdf, dar **nu** îl poate
    descărca prin `/my-flows/:id/download`. Nepericulos (nimeni nu vede ce nu trebuie), dar inconsistent.
- **(L):** niciunul.

Zone (O) — nu sunt (S) până nu se ia decizia de produs, dar **direcția de eșec diferă**:
- `opme.mjs` → **lockout explicit** (`403 org_required`) la platform-admin fără org / cross-org.
- `registratura.mjs` → **lockout tăcut** (listă goală). Mai prost ca UX: nicio explicație.

---

## 3. Ce mușcă și când

**Context:** prod = O SINGURĂ org, `admin@docflowai.ro` are `org_id=1` (restaurat 22.07 după ce nularea a
produs lockout general). Staging = 4 org (1 Primaria Test, 2 Primaria BUG, 3 Primaria ZUP, 5 DocFlowAI).

- **Mușcă AZI (o singură org în prod):** practic **nimic**. Adminul are `org_id=1`, toate fluxurile/registrele
  sunt org 1; scopările tăcute/explicite întorc exact org 1. Chiar și `crud.mjs:903` „merge" fiindcă adminul
  și fluxurile sunt în același org. Singurul lucru care ar mușca azi: un **destinatar repartizat** care încearcă
  `/my-flows/:id/download` (ramura recipient lipsă) — dar UI-ul rutează probabil pe signed-pdf.
- **Mușcă la A DOUA primărie (suport cross-org):** platform-adminul **nu** poate vedea, traversând org-uri:
  registrele altei primării (listă goală tăcută), importurile OPME (403 org_required), fluxul altei primării
  prin `/my-flows/:id/download` (403). Toate = lockout, niciun leak. Testabil pe staging (4 org).
- **Mușcă doar dacă `admin.org_id` redevine NULL:** platform-adminul devine „non-platform fără org" pe TOATE
  căile (O) → 403 pe opme, liste goale pe registratura/notifications/users-colegii, 403 pe my-flows download.
  Fix-ul de contract (`orgScopeSql` = `''` pentru role admin) rezolvă asta pentru cei cablați; cei necablați
  (opme/registratura/crud:903) rămân stricți.

**Teste rulabile pe staging (4 org):**
1. Login ca `admin@docflowai.ro` (platform) → `GET /api/opme/imports` cu context org 2 → azi 403; cu org 1 → doar org 1. Verifică dacă suportul vede org 2/3.
2. Login ca org_admin al org 2 (BUG) → `GET /registru/intrari` → NU trebuie să vadă intrări din org 3 (izolare — verifică că e strict).
3. Destinatar repartizat pe un flux din org 3 → `GET /my-flows/:id/download` (azi 403) vs `GET /flows/:id/signed-pdf` (azi 200). Dovedește golul recipient.
4. org_admin org 2 fără `org_id` (simulat) → confirmă `org_admin_no_org` / listă goală (fail-closed).

---

## 4. Întrebări de produs pentru Mircea (binare, cu consecință)

1. **Registratura cross-org la suport:** platform-adminul vede registrele TUTUROR primăriilor într-o listă
   unică (util la suport, DAR amestecă documentele a două instituții) **SAU** rămâne scopat — și, în plus,
   primește **403 explicit** (`org_required`) în loc de listă goală tăcută?
   → *Recomandare: scopat + 403 explicit (aliniere UX cu opme); cross-org doar dacă suportul chiar are nevoie.*
2. **OPME cross-org la suport:** platform-adminul poate lista/reprocesa importuri OPME ale altor primării
   **SAU** rămâne 403 org_required (cum e azi)? (OPME = date financiare de trezorerie — amestecul e mai sensibil.)
   → *Recomandare: rămâne scopat; cross-org e greu de justificat pentru date de plată.*
3. **`crud.mjs:903` my-flows download:** aliniem la `isFlowAccessAllowed` (adaugă platform-admin cross-org +
   destinatar repartizat) **SAU** păstrăm strict same-org? (Ramura recipient e un **bug**, nu o decizie — un
   repartizat ar trebui să poată descărca ce deja vede.)
   → *Recomandare: aliniere. Parte recipient = fix bug indiscutabil; parte platform-admin = urmează contractul #105f deja decis.*
4. **Meta-decizie (determină tot):** `admin@docflowai.ro` rămâne **org-scoped** (`org_id=1`, vede doar org 1)
   **SAU** devine **platform-admin real** (`org_id=NULL`, vede cross-org)? Azi e org-scoped (1). Dacă rămâne
   așa, întrebările 1–2 sunt teoretice (nu există actor cross-org). Dacă devine NULL, TOATE căile (O)
   necablate îl blochează → trebuie cablate întâi.
   → *Fără răspuns aici nu are sens conversia opme/registratura pe `orgScopeSql`.*

---

## 5. Split propus (ordonat după „când mușcă efectiv", nu după fișiere)

⛔ Fără prompt-monstru. ⛔ Fără conversie oarbă `orgScopeSql` pe opme/registratura (ar amesteca registrele
primăriilor — GREȘIT ca produs, nu doar zgomotos). Fiecare sub-prompt gatat pe decizia sa de produs.

### Prompt #111a — fix `crud.mjs` my-flows download (correctness, NU necesită decizie de produs)
- **Fișiere:** `server/routes/flows/crud.mjs` (rută 875–907) + test în `server/tests/db/`.
- **Ce:** înlocuiește check-ul inline `isAdmin && sameOrg` cu `await isFlowAccessAllowed(pool, actor, d, null, req.params.flowId)`. Elimină duplicatul divergent; câștigă gratuit ramura platform-admin (#105f) + ramura destinatar-repartizat.
- **Risc:** mic (aliniere la contract deja testat). **Model:** Sonnet. **Decizie de produs înainte:** NU (fix de consistență; comportamentul țintă e deja decis în `flow-access.mjs`).
- **Ordine #1:** e singurul cu bug funcțional (recipient) care poate mușca azi, și e cel mai ieftin.

### Prompt #111b — registratura: UX de eșec explicit (gatat pe Q1 + Q4)
- **Fișiere:** `server/routes/registratura.mjs` + teste.
- **Ce (dacă owner alege „scopat + explicit"):** adaugă `if(!actor.orgId) return 403 org_required` pe rutele de listare (aliniere cu opme), **fără** a schimba izolarea. Dacă owner alege „cross-org la suport": cablează `orgScopeSql` cu grijă (platform-admin vede tot).
- **Risc:** mediu (atinge toate rutele). **Model:** Opus (decizii de produs). **Decizie de produs înainte:** **DA (Q1 + Q4).**
- **Ordine #2:** mușcă la a doua primărie; lockout tăcut e cel mai prost UX de reparat.

### Prompt #111c — opme: rezolvă contradicția rol-vs-org (gatat pe Q2 + Q4)
- **Fișiere:** `server/routes/opme.mjs` (`_hasOpmeImportRole` + rute) + teste.
- **Ce:** clarifică ordinea porților (rol înainte de org pentru platform-admin?) și decide cross-org. Dacă platform-admin rămâne scopat: documentează contradicția ca intenționată. Dacă devine cross-org: cablează `orgScopeSql` + mută poarta de rol înaintea celei de org.
- **Risc:** mediu-mare (date financiare). **Model:** Opus. **Decizie de produs înainte:** **DA (Q2 + Q4).**
- **Ordine #3:** mușcă la a doua primărie, dar deja eșuează **explicit** (403) — mai puțin urgent ca lockout-ul tăcut al registraturii.

### (Fără prompt) — deja pe contract / neutru
`admin/flows`, `admin/analytics`, `admin/organizations`, `admin/users`, `templates`, `chat`, `auth`,
`notifications`, `actor-identity`, `authz-formular` — nu necesită acțiune. Eventual **hygiene opțional**:
`admin/users.mjs` face `SELECT org_id FROM users WHERE id=actor.userId` redundant (PERF-pattern din CLAUDE.md
zice să folosească `actor.orgId` din JWT) — dar e perf, nu authz; nu intră în #110.

---

## Note & NECLAR
- **Redundanță perf (nu authz):** `admin/users.mjs` re-citește `org_id` din DB deși JWT-ul îl are (`actor.orgId`).
  Legitim din perspectiva scopingului; menționat doar pentru curățenie viitoare.
- **NECLAR:** dacă frontend-ul cheamă vreodată `/my-flows/:id/download` pentru un destinatar repartizat (vs
  signed-pdf). Ar lămuri cât de tare mușcă azi ramura recipient lipsă. De verificat în `public/js/**` la #111a.
- **Confirmat curat (nu re-descoperit):** `chat.mjs` (participant-based), absența clasei SEC-90 `institutie`-ca-scope
  (folosit doar ca display-filter în query-uri deja org-scoped).
