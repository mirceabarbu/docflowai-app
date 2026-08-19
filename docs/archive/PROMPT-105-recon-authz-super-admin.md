---
title: "#105 RECON (READ-ONLY) — contractul super-admin / org-scope: inventar + plan de aliniere"
model_suggested: Opus 4.8   # analiză de autorizare pe tot codul, mize cross-tenant
target_version: none   # RECON PUR — zero cod, zero commit, zero bump
branch: develop
migration: NU
mode: READ-ONLY
---

# ⚠️ RECON READ-ONLY — NU modifica NICIUN fișier de producție, NU comita, NU bump versiune

Singurul artefact scris e un document de audit în `docs/audits/`. Restul e analiză.
Dacă simți nevoia să „repari" ceva cât citești — NU o face; notează în document.

===============================================================================
## SCOP
===============================================================================

Rolul `role='admin'` = super-admin de PLATFORMĂ (bootstrap `admin@docflowai.ro`,
migrația 013; `users_role_check` migrația 024 permite exact `admin`/`org_admin`/`user`).
El are AZI TREI semantici incompatibile în cod, calculate inline la ~40 de situri —
de aceea diverg. Cu o singură primărie în producție nimic nu se vede; la al doilea
client, varianta (a) = **leak cross-org** (un „admin" vede documentele altei instituții).

Semanticile (confirmate pe cod, dar tu re-verifici și completezi):
- **(a) „vede tot, FĂRĂ filtru org"** — LEAK. Ex.: `formulare/shared.mjs:397` (`const isAdmin = actor.role === 'admin'`) folosit la `:410` și `:540` (`if(!isAdmin){…filtru org…}` ⇒ adminul sare peste filtru pe listarea DF/ORD); `formulare/df.mjs:48` (`if (actor.role === 'admin')`); `formulare/ord.mjs:45`. Codul chiar are comentariul „isAdmin rămâne NEATINS (inconsistența #105)".
- **(b) „vede tot DOAR dacă n-are org_id"** — CORECT. `isGlobalAdmin = actor.role === 'admin' && !actor.orgId`. Ex.: `df.mjs:130,192`; `ord.mjs:107,130,193`.
- **(c) „admin SAU org_admin, same-org"** — `isAdminOrOrgAdmin` (`admin/_helpers.mjs`), `flow-access.mjs`, `alop-capabilities.mjs`.

Ipoteza de contract (de VALIDAT în recon, nu de presupus): **generalizează (b)**. Un
super-admin de platformă are `org_id = NULL` ⇒ vede tot (legit, pentru suport). Un
`role='admin'` CU `org_id` ar fi admin la nivel de instituție ⇒ trebuie org-scoped.
Varianta (a) scurge fiindcă cheie DOAR pe rol, ignorând `org_id`.

⚠️ Numerele de linie de mai sus sunt de pe v3.9.725 dar POT drifta la următoarea
editare — tratează-le ca puncte de plecare, nu ca adevăr. Re-grep și confirmă.

===============================================================================
## PAS 1 — INVENTAR COMPLET (grep pe TOT server/)
===============================================================================

Rulează și adună (read-only). Nu te opri la exemplele de mai sus — vrei TOATE situurile.

```bash
cd <repo>
git checkout develop && git pull --ff-only
grep '"version"' package.json          # doar pentru antetul documentului

# toate testele de rol
grep -rn "role === 'admin'\|role==='admin'\|role !== 'admin'\|=== 'org_admin'\|isAdmin\b\|isGlobalAdmin\|isAdminOrOrgAdmin\|isOrgAdmin\|isCabDept\|cab_dept" server/ --include=*.mjs | grep -v "/tests/"

# scoping pe org: unde apare (și unde LIPSEȘTE) filtrul org
grep -rn "org_id\|actor.orgId\|\.orgId\b" server/routes/formulare/*.mjs server/services/formular-shared.mjs server/routes/flows/*.mjs server/routes/admin/*.mjs --include=*.mjs | grep -v "/tests/"

# suprafețe NOI de la 19.07 care ar putea avea aceeași clasă:
grep -rn "role === 'admin'\|role==='admin'\|isAdmin\|org_id" server/routes/chat.mjs server/services/chat-access.mjs 2>/dev/null
```

===============================================================================
## PAS 2 — CLASIFICARE (fiecare sit → a / b / c)
===============================================================================

Pentru FIECARE sit găsit, notează în document: fișier:linie, fragmentul, ce
CONTEXT are (listare? get object? update? guard de capabilitate? query admin?), și
în care semantică intră (a/b/c). Marchează cu 🔴 fiecare sit din categoria (a) care
e pe o cale de **listare sau citire** (acolo e leak-ul cross-org real). Marchează 🟠
situurile ambigue (ex. guard de scriere care ar trebui org-scoped dar nu e clar).

Întrebări la care documentul TREBUIE să răspundă:
1. Câte situri (a) există și care sunt pe cale de listare/citire (leak efectiv) vs.
   guard de scriere (deja protejat de `WHERE id=$1 AND org_id=$2` în altă parte)?
2. Există un sit unde un `role='admin'` CU `org_id` (nu super-admin de platformă)
   ar obține vizibilitate cross-org? (ăsta e testul-cheie al contractului)
3. Suprafețele noi (chat.mjs / chat-access.mjs) respectă deja izolarea prin modelul
   „participant activ", sau au și ele un `role==='admin'` care sare peste? (chat-ul
   are izolare proprie testată 14/14 — confirmă că NU introduce clasa (a))
4. `admin/flows.mjs`, `admin/audit.mjs`, `admin/analytics.mjs` — mai există citiri
   nescopate după #101? (#101 a scopat 4; confirmă că restul sunt org-scoped)

===============================================================================
## PAS 3 — PROPUNERE CONTRACT UNIC + HELPER
===============================================================================

În document, propune (nu implementa):
- **Helperul canonic** — un singur loc care exprimă contractul, ex. în
  `server/routes/admin/_helpers.mjs` sau un modul nou `server/services/authz-scope.mjs`:
  - `isPlatformAdmin(actor)` → `actor.role === 'admin' && !actor.orgId` (varianta b)
  - și/sau `orgScopeSql(actor, alias)` → întoarce `''` pentru platform-admin, altfel
    `AND ${alias}.org_id = $N` — sursă unică pentru filtrul de listare.
- **Cele „patru alinieri"** (grupare pe fișier/temă) din PLAN: (1) listări DF/ORD
  în `formular-shared.mjs`; (2) `df.mjs`/`ord.mjs` situurile (a) rămase; (3) `alop.mjs`;
  (4) citirile admin. Pentru fiecare grup: câte situri, ce se schimbă, ce NU se atinge.
- **Ordinea de execuție recomandată** și dacă merită SPLIT în mai multe prompturi
  (ex. #105a = introdu helperul + teste, fără schimbare de comportament; #105b =
  comută situurile (a) pe helper). Recomandă split dacă blast-radius > ~15 situri.

===============================================================================
## PAS 4 — ACOPERIRE DE TESTE (#104 tenant-isolation)
===============================================================================

Citește `server/tests/db/tenant-isolation.test.mjs` (pachetul #104). Documentul
trebuie să spună:
- Ce cazuri acoperă deja (B nu vede nimic din A; IDOR 403/404; control pozitiv).
- Ce cazuri LIPSESC pentru contractul aliniat, care TREBUIE adăugate la execuție:
  - un `role='admin'` CU `org_id=A` NU trebuie să listeze documentele org-ului B;
  - un platform-admin (`role='admin'`, `org_id=NULL`) VEDE ambele (control pozitiv al
    variantei b — să nu rupem suportul);
  - pe fiecare din cele patru suprafețe (DF list, ORD list, ALOP list, admin reads).

===============================================================================
## PAS 5 — DOCUMENT DE AUDIT (singurul fișier scris)
===============================================================================

Scrie `docs/audits/AUTHZ-105-RECON-2026-07.md` cu:
1. Rezumat executiv (3–5 rânduri): câte situri, câte leak-uri reale, decizia de contract.
2. Tabel inventar: fișier:linie · context · semantică (a/b/c) · 🔴/🟠/✅ · acțiune propusă.
3. Contractul unic propus + semnătura helperului.
4. Planul pe cele patru alinieri, cu recomandare de split.
5. Gap-urile de test de adăugat la execuție.
6. Riscuri / capcane (ex.: dacă vreun platform-admin real are `org_id` setat greșit,
   varianta (b) l-ar org-scopa brusc — de verificat pe producție `SELECT id,email,role,
   org_id FROM users WHERE role='admin'` ÎNAINTE de execuție).

===============================================================================
## RAPORT FINAL (în răspuns)
===============================================================================

- [ ] Nr. total situri de rol/scope găsite: ___
- [ ] Din care semantică (a): ___ (leak listare/citire: ___), (b): ___, (c): ___
- [ ] Suprafețe noi (chat) verificate — introduc clasa (a)? DA/NU
- [ ] Citiri admin nescopate rămase după #101: ___
- [ ] Split recomandat? #105 unic / #105a+#105b / altă structură
- [ ] Cazuri de test de adăugat: ___
- [ ] Document scris: `docs/audits/AUTHZ-105-RECON-2026-07.md` (da/nu)
- [ ] `git status --short` — Așteptat: DOAR documentul de audit (niciun fișier de producție)
- [ ] Observații / surprize față de analiza din 19.07: ___

===============================================================================
## ⛔ CONSTRÂNGERI ABSOLUTE
===============================================================================

- ⛔ READ-ONLY. Zero fișiere de producție atinse. Zero commit. Zero bump. Zero migrație.
- ⛔ Singurul fișier scris = `docs/audits/AUTHZ-105-RECON-2026-07.md`. (Îl poți lăsa
     ne-comitat — Mircea decide dacă îl adaugă.)
- ⛔ NU „corecta" inconsistența cât citești — doar inventariază și propune.
- ⛔ Numerele de linie din prompt sunt orientative — confirmă-le prin grep pe codul curent.
- ⛔ Dacă un grep întoarce mult mai multe/puține situri decât cele ~40 estimate,
     NU forța potrivirea cu analiza din 19.07 — raportează realitatea codului curent.
- ⛔ NU propune schimbări la `chat-access.mjs`/izolarea chat-ului (model separat, testat).
