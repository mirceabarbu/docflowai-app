---
task: "#110-recon — inventarul scopărilor brute pe org (READ-ONLY, zero cod de producție)"
branch: develop
model_suggested: Opus 4.8   # clasificare + decizii de produs, nu execuție mecanică
target_version: —   (fără bump, fără commit de cod)
migrations: none
---

# ⚠️ BRANCH: develop

## PASUL 0 — CONFIRMĂ BRANCH-UL ÎNAINTE DE ORICE
```
git branch --show-current      # Așteptat: develop
git fetch origin && git status
```

# ⛔ ACEST PROMPT E READ-ONLY
Singurul fișier pe care ai voie să-l creezi: `docs/audits/ORGSCOPE-110-RECON-2026-07.md`.
⛔ ZERO modificări în `server/` sau `public/`. ⛔ ZERO bump de versiune. ⛔ Fără commit
de cod (dacă comiți, DOAR documentul, mesaj `docs: recon #110`, fără bump).
Dacă în timpul analizei găsești ceva ce „ar trebui reparat pe loc" — NU repara.
Scrie-l în document.

===============================================================================
## CONTEXT
===============================================================================

Sprintul #105 a stabilit contractul unic de autorizare pe org, în
`server/services/authz-scope.mjs`:
- `isPlatformAdmin(actor)` = `actor?.role === 'admin'` (**role-only**, org_id irelevant)
- `isAdminOrOrgAdmin(actor)`
- `orgScopeSql(actor, alias, params)` → `''` pentru platform-admin, altfel
  ` AND <alias>.org_id = $N` (un non-platform fără org împinge `null` ⇒ 0 rânduri, fail-closed)
- `actorCanAccessOrg(actor, targetOrgId)`

#105 a cablat 14 fișiere. Au rămas fișiere care scopează **brut** pe org, în afara
contractului. Numărătoare brută de referințe `actor.org_id` / `actor.orgId`
(pe v3.9.737, exclus `tests`):

```
opme.mjs (30) · registratura.mjs (19) · admin/users.mjs (9) · admin/flows.mjs (8)
flows/crud.mjs (4) · chat.mjs (2) · templates.mjs (2) · admin/analytics.mjs (2)
admin/organizations.mjs (2) · notifications.mjs (1) · auth.mjs (2)
services/actor-identity.mjs (1) · services/authz-formular.mjs (1)
```

⚠️ **Numărul brut NU e numărul de probleme.** Verificat deja de mine pe eșantion:
majoritatea acestor referințe sunt legitime (scriu `org_id` la INSERT, sau scopează
o operație care ȘI TREBUIE să fie a org-ului propriu). Sarcina ta e să le CLASIFICI,
nu să le converteși.

### Fapte deja verificate (nu le re-descoperi, confirmă-le și mergi mai departe)
- `opme.mjs` și `registratura.mjs` folosesc `requireAuth` în **helper-mode** ⇒ actorul
  vine din JWT și are **`orgId` camelCase**. `authz-scope` citește tot `orgId` camel ⇒
  aceste fișiere se pot cabla DIRECT, fără adaptorul `accessActor` care a fost necesar
  în `templates.mjs` (unde actorul vine din `resolveActorOr` = rând DB, `org_id` snake).
  **Notează pentru fiecare fișier din ce sursă vine actorul** — e determinant.
- `opme.mjs` eșuează închis EXPLICIT: 7 × `403 org_required`.
- `registratura.mjs` are **0** `org_required` ⇒ scopează TĂCUT; cu `orgId` absent
  întoarce liste goale fără explicație. Diferența asta contează în raport.
- `opme.mjs:_hasOpmeImportRole` are `if (actor.role === 'admin') return true;`
  (poarta de ROL trece), dar operațiile ulterioare cer `actor.orgId` ⇒ un platform-admin
  fără org trece de rol și cade pe org. Descrie contradicția, nu o rezolva.
- `chat.mjs` a fost verificat CURAT la recon-ul #105 (model participant-based,
  `platform_support` = traversare intenționată cu poartă proprie). Re-confirmă pe scurt
  și clasifică-l ca atare dacă nimic nu s-a schimbat.

===============================================================================
## CE TREBUIE SĂ PRODUCI
===============================================================================

`docs/audits/ORGSCOPE-110-RECON-2026-07.md`, cu:

### 1. Inventar clasificat
Fiecare referință, grupată pe fișier și rută, încadrată în EXACT una din categorii:

- **(W) Scriere legitimă** — `org_id` pus pe INSERT/UPDATE ca proprietar al rândului.
  Corect cum e. Nu se atinge.
- **(O) Operație proprie org-ului** — citire/scriere care prin natura produsului
  aparține unei singure organizații (import OPME, registru de intrări/ieșiri).
  Aici întrebarea NU e tehnică, ci de produs: *are sens ca platform-adminul să vadă
  asta traversând organizațiile?* Marchează și pune întrebarea explicit.
- **(S) Scopare care ar trebui să treacă pe contract** — listare/citire unde
  platform-adminul TREBUIE să vadă cross-org (suport), dar azi e blocat.
- **(L) LEAK potențial** — orice ramură `org_admin`/`admin` care citește un obiect
  **fără** verificare de org (clasa `email.mjs`/`report.mjs` din #105). PRIORITATE MAXIMĂ.
- **(N) Neutru** — nu ține de scoping (logging, telemetrie, `moduleKey`, audit).

Pentru fiecare intrare: fișier:linie · rută/funcție · sursa actorului
(`requireAuth` helper / middleware / `resolveActorOr`) · forma actorului
(`orgId` camel vs `org_id` snake) · categorie · o propoziție de justificare.

### 2. Distincția lockout vs leak
Pentru fiecare (S) și (L), spune explicit **în ce direcție** greșește:
- **lockout** = platform-adminul nu vede ce ar trebui (fail-closed, deranjant, nu periculos)
- **leak** = cineva vede ce nu trebuie (periculos)
și dacă e **tăcut** (listă goală) sau **explicit** (403 cu cod de eroare).

### 3. Ce mușcă și când
Grupează concluziile în: *mușcă azi* (o singură org în producție) · *mușcă la a doua
primărie* · *mușcă doar dacă `admin.org_id` redevine NULL*.
Context: azi producția are O SINGURĂ organizație și `admin@docflowai.ro` are `org_id=1`
(restaurat 22.07 după ce nularea a produs un lockout general). **Stagingul are PATRU
organizații** (1 Primaria Test, 2 Primaria BUG, 3 Primaria ZUP, 5 DocFlowAI) ⇒ e
singurul mediu unde izolarea se poate testa realist. Spune ce teste s-ar putea rula acolo.

### 4. Întrebările de produs pentru Mircea
Lista scurtă de decizii pe care NU le poți lua singur. Formulează-le binar, cu
consecința fiecărei variante. Exemplu de formă așteptată:
*„Registratura: platform-adminul vede registrele TUTUROR primăriilor într-o listă
unică (util la suport, dar amestecă documentele a două instituții) SAU rămâne
scopat și primește 403 explicit în loc de listă goală?"*

### 5. Split propus
Sub-prompturi în ordinea „când mușcă efectiv", nu în ordinea din fișiere. Fiecare cu:
fișierele atinse, riscul, modelul sugerat (Opus/Sonnet), și dacă are nevoie de
decizie de produs ÎNAINTE.
⛔ Nu propune un singur prompt-monstru care atinge toate fișierele.
⛔ Nu propune conversie „la grămadă" pe `orgScopeSql` — o conversie oarbă ar face
platform-adminul să vadă registrele tuturor primăriilor amestecate, ceea ce poate fi
GREȘIT ca produs, nu doar zgomotos.

===============================================================================
## METODĂ
===============================================================================
- Citește codul, nu presupune din nume. Un `grep` care nu găsește ceva **nu e dovadă
  de absență** — verifică cu mai multe tipare (`org_id`, `orgId`, `organization`,
  `institutie`) înainte să declari un fișier curat.
- Verifică dacă fișierul trece prin `admin/_helpers.mjs:actorOrgFilter` (rescris în #105c
  să folosească `isPlatformAdmin`) — dacă da, e DEJA pe contract indirect; spune-o.
- Atenție la `institutie` (text liber) folosit ca scope în loc de `org_id` — clasa
  SEC-90 reparată în #89. Dacă mai există undeva, e (L).
- Unde nu ești sigur, scrie „NECLAR + ce anume ar lămuri" — nu ghici.

===============================================================================
## RAPORT FINAL (în chat, pe lângă document)
===============================================================================
- Câte referințe în fiecare categorie (W/O/S/L/N).
- Ai găsit vreun (L)? Care, și de ce e leak.
- Cele 3-5 întrebări de produs, formulate scurt.
- Splitul propus, cu ordinea și motivul ordinii.
- Confirmă: `git status` arată DOAR documentul nou (`git diff --stat` gol pe `server/` și `public/`).
