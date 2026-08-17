# #105 RECON (READ-ONLY) — contractul super-admin / org-scope

Data: 2026-07-22 · Branch: `develop` · Versiune la momentul recon: `3.9.725` · Mod: READ-ONLY (zero cod modificat)

---

## 1. Rezumat executiv

Am inventariat **~95 situri** de test pe rol/scope în `server/` (excluzând `/tests/`). Rolul `admin`
are **trei semantici incompatibile**, exact ca în ipoteza inițială, plus o a patra variantă (c′) nouă,
neanticipată: „admin/org_admin same-org, dar platform-admin (`org_id=NULL`) e LOCKED OUT" — vezi §6.

**Numărul care contează:** semantica **(a)** ("vede tot, DOAR pe verificarea rolului, ignorând `org_id`")
apare pe **10 situri**, din care **8 sunt pe cale de listare/citire = leak cross-org real** dacă vreodată
există un `role='admin'` cu `org_id` populat. Cel mai grav: nu e un bug izolat într-un handler — e
**încrustat în helper-ul canonic admin** `actorOrgFilter()` (`server/routes/admin/_helpers.mjs:14-17`),
folosit de `admin/flows.mjs`, `admin/analytics.mjs`, `admin/organizations.mjs`, `admin/users.mjs`.
Asta înseamnă că fixul central e helper-ul, nu cele 8 situri individual.

**Decizia de contract:** ipoteza (b) se confirmă ca fiind CORECTĂ și e deja implementată consecvent
în `df.mjs`/`ord.mjs` (detaliu), dar NU e implementată nicăieri altundeva sub acest nume — fiecare
fișier își reinventează propriul test inline. Recomand generalizarea (b) via un helper central
(§7), NU varianta (a) actuală din `_helpers.mjs`.

**Chat (suprafață nouă din 19.07):** curat — model participant-based, fără niciun `role==='admin'`
de citire, `platform_support` documentat ca traversare intenționată cu gate propriu. NU introduce
clasa (a).

---

## 2. Tabel inventar

Legendă: 🔴 leak efectiv (listare/citire, fără scope org) · 🟠 ambiguu/gap de altă natură ·
✅ corect scopat (b sau c).

| # | Fișier:linie | Context | Semantică | Marcaj | Acțiune propusă |
|---|---|---|---|---|---|
| 1 | `admin/_helpers.mjs:14-17` (`actorOrgFilter`) | helper canonic, folosit peste tot în `admin/*.mjs` | (a) | 🔴 | Rescrie ca `orgScopeSql`/`isPlatformAdmin`-aware — sursă unică, fix propagă automat |
| 2 | `admin/audit.mjs:19,36` | listare audit log (+ export CSV) | (a) | 🔴 | Comută pe helper nou |
| 3 | `formulare/shared.mjs:397-436` (`/api/formulare/list`, ramura DF) | listare | (a) | 🔴 | Comută pe helper nou |
| 4 | `formulare/shared.mjs:540-575` (`/api/formulare/list`, ramura ORD) | listare | (a) | 🔴 | Comută pe helper nou |
| 5 | `formulare/shared.mjs:513,630` (`can_delete` computed field) | listare, câmp derivat | (a) | 🟠 | Derivat din `isAdmin`/`isOrgAdmin` de mai sus — se aliniază automat cu #3/#4 |
| 6 | `formulare/df.mjs:48-53` (`GET /api/formulare-df`) | listare | (a) | 🔴 | Comută pe helper nou (există deja varianta corectă (b) la 130/192 în ACELAȘI fișier — inconsistență intra-fișier) |
| 7 | `formulare/ord.mjs:45-53` (context echivalent) | listare | (a) | 🔴 | idem |
| 8 | `admin/flows.mjs:117` (`/admin/alop/stats` → `payload.gate`) | citire agregată, fără scope pe org **intenționat** (comentariu explicit „metrică de sănătate a platformei") | (a) dar declarat intenționat | 🟠 | NU e leak de date de tenant (doar contor de tranziții ALOP status), dar folosește `role==='admin'` brut — dacă apare vreodată un admin instituțional, ar vedea contorul cross-org. Recomand totuși `isPlatformAdmin()` aici pentru consecvență, chiar dacă payload-ul nu conține date sensibile per-org |
| 9 | `formulare/df.mjs:337,343` / `ord.mjs:307,313,320` (`isP1`/`allowedFields` pe update) | guard de scriere pe câmpuri, în interiorul unui doc deja `WHERE id=$1 AND org_id=$2` (vezi #10/detaliu) | (a) local, dar pe obiect deja org-filtrat | ✅ | Fără acțiune — obiectul e deja izolat de query-ul GET/PUT anterior |
| 10 | `formulare/df.mjs:130,192` / `ord.mjs:107,130,193` | detaliu/XML export — `isGlobalAdmin = role==='admin' && !orgId` | (b) | ✅ | Model de referință — restul codului ar trebui aliniat la ACESTA |
| 11 | `alop-capabilities.mjs:26` | capabilities pe obiect deja org-scopat de query-ul apelant | (c) | ✅ | fără acțiune |
| 12 | `alop.mjs:234` (`buildAlopVisibilityWhere`) | vizibilitate intra-org (relaxare pe `role==='admin'`/`org_admin`), dar apelanții (`stats`, listă) au DEJA `a.org_id=$1` fix pe `actor.orgId` — inclusiv pentru `role==='admin'` | (c), dar cu gap opus | 🟠 | Vezi §6 — un platform-admin (`orgId=NULL`) primește `org_id = NULL` în WHERE ⇒ 0 rezultate, nu „vede tot". Contractul (b) e ÎNCĂLCAT în direcția opusă (lockout, nu leak) |
| 13 | `alop.mjs:573,1176-1178,1762` | guard-uri pe obiect ALOP deja încărcat prin query org-scopat | (c) | ✅ | fără acțiune |
| 14 | `flow-access.mjs:26-27` (`canActorReadFlow`) | poartă unică citire flux + conținut | (c) strict — `isAdmin && sameOrg` | 🟠 | Platform-admin (`orgId=NULL`) → `sameOrg` fals mereu → LOCKOUT total pe fluxuri, inclusiv suport. Simetric cu #12 |
| 15 | `flows/crud.mjs:716-719,904-905` | delete/read flux (folosește `isAdmin` local echivalent cu `flow-access.mjs`) | (c) | ✅ (consecvent cu #14, deci și cu același gap de lockout) | — |
| 16 | `flows/lifecycle.mjs` (5 situri: 46,161,234,380,491) | reinit/delegare/cancel/review — toate folosesc pattern `role==='admin' \|\| (role==='org_admin' && sameOrg)` | (c) parțial — **admin fără condiție de org** (partea `role==='admin'` NU cere `sameOrg`!) | 🔴 | Recitire exactă: `actor.role === 'admin' \|\| (actor.role === 'org_admin' && sameOrg)` — un `role='admin'` CU `org_id` diferit de `data.orgId` tot trece, fiindcă disjuncția nu cere sameOrg pe ramura admin. E deja o inconsistență cu `flow-access.mjs` (#14) care cere `sameOrg` pentru AMBELE roluri. **Acesta e cel mai concret leak de SCRIERE găsit** (reinit/cancel/delegare cross-org de către un ipotetic admin instituțional) |
| 17 | `flows/signing.mjs:486,508` | resend notificare / regenerare token | (c) parțial — același pattern ca #16 | 🔴 | idem — `role==='admin'` fără `sameOrg` |
| 18 | `flows/attachments.mjs:62-63,176-177` | acces atașamente | (c) parțial — același pattern | 🔴 | idem |
| 19 | `flows/email.mjs:364,367` | listare/trimitere email extern | (c) — `isAdmin = role==='admin' \|\| role==='org_admin'` FĂRĂ sameOrg deloc pe niciuna din ramuri, dar combinat cu `!isAdmin && !isInitiator && !isSigner` ca gate de 403 | 🔴 | Nici org_admin nu are `sameOrg` aici — potențial mai larg decât #16-18. De verificat cu prioritate la execuție |
| 20 | `report.mjs:30,33,39,142,145` | generare raport PDF flux | (c) — `isAdmin = role==='admin' \|\| role==='org_admin'`, FĂRĂ sameOrg | 🔴 | idem #19 |
| 21 | `services/formular-shared.mjs:696` | guard update, `actor.role !== 'admin' && doc.org_id !== actor.orgId` | (a)-like (bypass total pt `role==='admin'`, fără condiție `!orgId`) | 🔴 | Comută pe helper nou |
| 22 | `opme.mjs:57-58` | `canAccessOrg`-like — `role==='admin'` → true necondiționat; `org_admin` cere `orgId` | (a) pt. admin | 🔴 | Comută pe helper nou |
| 23 | `admin/entitlements.mjs:29`, `require-module.mjs:34`, `middleware/auth.mjs:175` | guard-uri globale de tip „doar super-admin poate configura X la nivel de platformă" (module flags, entitlements) | (b) implicit — sunt operații GENUIN globale, fără noțiune de org | ✅ | fără acțiune — nu au echivalent org-scoped, sunt corecte prin natura operației |
| 24 | `admin/maintenance.mjs` (8 situri, 35-334), `admin/organizations.mjs` (9 situri, 21-488) | operații CRUD organizații/instituții — „doar super-admin poate crea/șterge/reactiva organizații" | (b) implicit — operații la nivel de platformă, nu au sens org-scoped (creezi o org NOUĂ) | ✅ | fără acțiune |
| 25 | `admin/users.mjs` (~15 situri, 130-1011) | mix — unele `isAdminOrOrgAdmin` (gate general, apoi scoping intern pe `org_id===target.org_id` pentru org_admin), altele `role==='admin'`-only pt operații globale (reasignare org, promovare la admin) | mix (b)/(c) — dar scoping-ul e făcut cu verificare EXPLICITĂ `target.org_id !== actorOrgId` doar pt `org_admin`, nu pt `admin` (identic pattern-ul (a) — admin-ul sare peste) | 🔴 (moderat) | Ex. `users.mjs:595,634,705`: `if (actor.role === 'org_admin' && ...)` — un `role==='admin'` cu `org_id` ar edita/vedea utilizatori din ALTĂ org fără compensare. Comută pe helper nou pentru citire; scrierile (promovare/reasignare) sunt deja "doar admin" prin design (§2 rând 24) |

**Total situri clasificate individual mai sus:** 25 grupuri reprezentând cele ~95 de linii brute din grep
(multe grupuri conțin 3-15 linii identice ca pattern în același fișier).

### Sumar pe semantică

| Semantică | Nr. grupuri | Din care 🔴 (leak/scriere-fără-scope) | Din care ✅/🟠-benign |
|---|---|---|---|
| (a) „vede tot fără filtru org" | 10 grupuri (~40 linii) | 8 grupuri 🔴 + 2 🟠 (rânduri 5, 8) | — |
| (b) „vede tot DOAR dacă `!orgId`" | 3 grupuri (`df.mjs`/`ord.mjs` detaliu, module-guards, org-CRUD) | 0 | 3 ✅ |
| (c) „admin/org_admin same-org" | 12 grupuri | 5 🔴 (16,17,18,19,20 — lipsă `sameOrg` pe ramura `admin`) | 7 ✅/🟠 (inclusiv 2 cazuri de lockout opus, §6) |

---

## 3. Răspunsuri la întrebările din PAS 2

**1. Câte situri (a) există, listare/citire vs. guard de scriere?**
10 grupuri semantică (a). **8 sunt pe listare/citire** (rândurile 1-4, 6, 7, 21, 22 din tabel) = leak
efectiv dacă apare un `role='admin'` cu `org_id`. Restul 2 (rândurile 5, 8) sunt câmpuri derivate/
agregate benigne sau declarate intenționat non-tenant.

**2. Există un sit unde `role='admin'` CU `org_id` ar obține vizibilitate cross-org?** DA — de fapt
**toate cele 8 situri 🔴 din categoria (a)**, PLUS cele 5 din categoria (c) unde ramura `admin` a
disjuncției nu cere `sameOrg` (rândurile 16-20). Testul-cheie eșuează pe ~13 grupuri din 25.

**3. Chat introduce clasa (a)?** NU. `chat.mjs`/`chat-access.mjs` — model participant + org_id pe
conversație la creare, fără niciun `role==='admin'` care sare peste apartenența la conversație.
`platform_support` traversează org-urile INTENȚIONAT (comentariu explicit la linia 15 a fișierului)
și e un tip de conversație separat, nu o relaxare a citirii altor conversații `internal`.

**4. `admin/flows.mjs`, `admin/audit.mjs`, `admin/analytics.mjs` — citiri nescopate rămase după #101?**
- `admin/audit.mjs` — DA, ambele endpoint-uri (`/admin/audit-events/types`, `/admin/audit-events`)
  folosesc `role==='admin' ? null : actor.orgId` — semantică (a) neatinsă de #101.
- `admin/analytics.mjs` — foloseşte `actorOrgFilter()` (helper-ul (a) central) pe toate rutele —
  deci moștenește problema #1 din tabel, dar nu are un bypass propriu suplimentar.
- `admin/flows.mjs` — la fel, `actorOrgFilter()` peste tot, plus siturile 8 (gate ALOP, benign) și
  16 (reinit/cancel — separat, în `flows/lifecycle.mjs`, nu în `admin/flows.mjs`).

---

## 4. Contractul unic propus (PAS 3)

### Helper canonic

Propun un modul nou `server/services/authz-scope.mjs` (paralel cu `authz-formular.mjs`, care
rămâne neatins — logică diferită, per-compartiment):

```js
// Un platform-admin e role='admin' FĂRĂ org_id. Un role='admin' CU org_id e admin instituțional
// (scop identic cu org_admin pentru citire/listare cross-tenant).
export function isPlatformAdmin(actor) {
  return actor?.role === 'admin' && !actor?.orgId;
}

// admin/org_admin, ambii org-scoped DACĂ au org_id; platform-admin = fără scope.
export function isAdminOrOrgAdmin(actor) {
  return actor?.role === 'admin' || actor?.role === 'org_admin';
}

// '' pt platform-admin (fără filtru); altfel fragment SQL + push pe params.
export function orgScopeSql(actor, alias, params) {
  if (isPlatformAdmin(actor)) return '';
  params.push(actor.orgId);
  return ` AND ${alias}.org_id = $${params.length}`;
}

// Pentru guard-uri pe obiect deja încărcat (nu SQL): same-org SAU platform-admin.
export function actorCanAccessOrg(actor, targetOrgId) {
  if (isPlatformAdmin(actor)) return true;
  return actor?.orgId != null && targetOrgId != null && String(actor.orgId) === String(targetOrgId);
}
```

`admin/_helpers.mjs` → `isAdminOrOrgAdmin`/`actorOrgFilter` devin re-export-uri subțiri din
`authz-scope.mjs` (păstrează compatibilitatea de import), dar `actorOrgFilter` trebuie REDEFINIT
ca să folosească `isPlatformAdmin` în loc de `role==='admin'` brut.

### Cele patru alinieri

1. **Listări DF/ORD** (`formular-shared.mjs` rândurile 3-4, `df.mjs`/`ord.mjs` rândurile 6-7) —
   comută `isAdmin`/`orgFilter` pe `isPlatformAdmin()`/`orgScopeSql()`. ~4 situri, izolate, cu teste
   de caracterizare deja existente (`server/tests/db/tenant-isolation.test.mjs`) ca plasă.
2. **Guard-uri de scriere flux fără `sameOrg` pe ramura admin** (`lifecycle.mjs` ×5, `signing.mjs` ×2,
   `attachments.mjs` ×2, `email.mjs`, `report.mjs`) — ~11 situri, TOATE cu același pattern
   `actor.role === 'admin' || (actor.role === 'org_admin' && sameOrg)` → înlocuit cu
   `actorCanAccessOrg(actor, data.orgId)`. Risc mediu — sunt pe cale de SCRIERE (cancel/delegare/
   resend/report), deci un bug de regresie aici e mai vizibil decât un leak de citire silențios.
3. **`alop.mjs`** — de fapt aici problema e INVERSĂ (lockout platform-admin, nu leak) — vezi §6.
   Recomand tratare SEPARATĂ de restul (nu e „aliniere la (b)", e „adăugare de suport (b) unde
   lipsește complet"). ~2 situri (`buildAlopVisibilityWhere` + query-ul de bază din `/api/alop`,
   `/api/alop/stats`).
4. **Citiri admin** (`admin/_helpers.mjs:actorOrgFilter`, `admin/audit.mjs`, `services/formular-
   shared.mjs:696`, `opme.mjs:57`, `admin/users.mjs` ~3 situri de scriere fără compensare) — helper-ul
   central rezolvă `_helpers.mjs` + tot ce-l importă dintr-o mișcare; `audit.mjs`/`formular-shared.mjs
   :696`/`opme.mjs` au nevoie de comutare punctuală (nu importă helperul azi).

### Ordinea de execuție recomandată — SPLIT

Blast-radius total (25 grupuri, ~30-35 linii de cod efectiv modificate, întinse pe 12+ fișiere,
inclusiv căi de scriere pe fluxuri semnate) **depășește pragul de ~15 situri** din prompt. Recomand:

- **#105a — Helper + teste, ZERO schimbare de comportament.** Introdu `authz-scope.mjs`,
  re-exportă din `_helpers.mjs`, adaugă testele unit pentru `isPlatformAdmin`/`orgScopeSql`/
  `actorCanAccessOrg`. Rulează `npm test` — trebuie verde identic (helper-ul încă nu e folosit
  nicăieri nou). Zero risc.
- **#105b — Grupa 1 (listări formulare, aliniere 1 din §4) + testele de gap din §5.** Cel mai
  contained, plasă de test deja existentă (`tenant-isolation.test.mjs`).
- **#105c — Grupa 4 (citiri admin: `_helpers.mjs`, `audit.mjs`, `formular-shared.mjs:696`,
  `opme.mjs`).** Al doilea cel mai contained.
- **#105d — Grupa 2 (guard-uri scriere flux fără `sameOrg`).** Cea mai riscantă — atinge
  `lifecycle.mjs`/`signing.mjs`/`attachments.mjs`, fișiere ADIACENTE zonei NO-TOUCH (nu în ea, dar
  `signing.mjs`-ul de aici e `flows/signing.mjs`, DIFERIT de `cloud-signing.mjs`/`bulk-signing.mjs`
  care sunt NO-TOUCH — de confirmat separat, fișier cu fișier, la execuție, care linii sunt în afara
  zonei interzise). Necesită cea mai atentă revizuire manuală, posibil cerere explicită de
  confirmare per fișier conform CLAUDE.md.
- **#105e — Grupa 3 (`alop.mjs` — fix de lockout, direcție opusă).** Decizie de produs separată:
  merită platform-admin acces la ALOP cross-org? (probabil da, pentru suport) — de confirmat cu
  Mircea înainte de implementare, nu doar tehnic.

Nu recomand un `#105` unic — riscul de regresie pe căile de scriere flux (#105d) nu ar trebui
amestecat cu fix-urile pure de listare (#105b/c), care sunt aproape mecanice.

---

## 5. Gap-uri de test (`tenant-isolation.test.mjs`, pachetul #104)

**Ce acoperă azi (13 cazuri, confirmate prin citire):**
- Grupa 1 (7 cazuri): listări DF/ORD/ALOP/registratură/utilizatori-org/my-flows ca `user-b` NU conțin
  date din org A.
- Grupa 2 (4 cazuri, IDOR): acces direct pe ID străin → 403/404 (nu 200 cu datele altei org).
- Grupa 3 (2 cazuri): control pozitiv — user-a vede propriile date.

**Ce LIPSEȘTE — de adăugat la execuție (una din #105b-e), pe cele patru suprafețe:**

1. **Negativ — admin instituțional NU vede cross-org:** creează un actor `role='admin'` CU
   `org_id=A` (situație azi imposibilă în UI normal — `role==='admin'` e creat doar fără org prin
   `maintenance.mjs`/bootstrap — dar testul trebuie să acopere STAREA, nu doar calea UI de creare,
   fiindcă poate exista prin reasignare manuală sau date legacy). Verifică:
   - `GET /api/formulare/list?type=df` ca acest actor NU conține DF-A dacă actorul e „org B" simulat.
   - `GET /api/alop`, `/admin/audit-events` — idem.
2. **Pozitiv — platform-admin (`role='admin'`, `org_id=NULL`) VEDE ambele org-uri** — pe toate cele
   patru suprafețe (DF list, ORD list, ALOP list, admin reads). ⚠️ Pe baza recon-ului de mai sus,
   **acest test AZI ar PICA pe `/api/alop`** (lockout, §6) — deci testul trebuie scris ca parte din
   #105e, nu poate fi doar „adăugat" fără fix-ul corespunzător.
3. **Guard-uri de scriere flux** (§4 grupa 2) — un `role='admin'` cu `org_id=A` NU trebuie să poată
   `cancel`/`reinit`/`delegate`/`resend-notification`/`regenerate-token` pe un flux din org B. Azi
   ACESTE cazuri lipsesc din `tenant-isolation.test.mjs` (care testează doar citire/IDOR, nu
   acțiuni de lifecycle) — recomand fișier NOU `server/tests/db/tenant-isolation-write.test.mjs`
   pentru #105d, ca să nu umfle fișierul existent cu o categorie diferită de risc.

---

## 6. Riscuri / capcane

1. **Verificare producție OBLIGATORIE înainte de orice execuție (#105b+):**
   ```sql
   SELECT id, email, role, org_id FROM users WHERE role='admin';
   ```
   Dacă VREUN rând are `org_id` NOT NULL, varianta (b) l-ar org-scopa BRUSC la deploy — acel cont ar
   pierde acces la restul organizațiilor peste noapte. Nu am acces la producție din acest recon
   (READ-ONLY, local) — verificarea trebuie făcută de Mircea sau într-un pas dedicat de execuție,
   ÎNAINTE de merge pe main.

2. **Direcție de risc OPUSĂ descoperită, neanticipată în analiza din 19.07:** `alop.mjs` și
   `flow-access.mjs` NU au leak — au **lockout**. Un platform-admin real (`role='admin'`,
   `org_id=NULL`, exact profilul „corect" din ipoteza (b)) e azi **exclus complet** din ALOP și din
   citirea fluxurilor, fiindcă query-urile cer `sameOrg`/`org_id=$1` necondiționat, fără ramură de
   „fără filtru". Dacă acest cont e folosit azi pentru suport (bootstrap `admin@docflowai.ro`), e
   posibil ca el să NU poată deja deschide ALOP-uri sau fluxuri ale clienților — de verificat dacă
   asta a fost deja observat ca „bug" în alt context, sau dacă suportul se face altfel (impersonare/
   acces DB direct). Contractul (b) trebuie aplicat ÎN AMBELE DIRECȚII, nu doar ca restrângere.

3. **`formular-shared.mjs:696` și `df.mjs:337-343`/`ord.mjs:307-320` sunt în ACELAȘI fișier ca
   versiunile corecte (b)** (`df.mjs:130,192`) — inconsistența nu e doar cross-fișier, e
   INTRA-fișier. Un cititor care vede `isGlobalAdmin` la linia 130 ar putea presupune (greșit) că
   tot fișierul urmează acel contract.

4. **Guard-urile de scriere pe fluxuri (#105d) sunt adiacente, dar NU în, zona NO-TOUCH.**
   `server/routes/flows/signing.mjs` (rutele `resend`/`regenerate-token`, liniile 486/508) e un
   fișier DIFERIT de `server/routes/flows/cloud-signing.mjs` și `bulk-signing.mjs` (care SUNT
   NO-TOUCH conform CLAUDE.md). Totuși, orice modificare în `flows/` merită dublă verificare la
   execuție că nu atinge tranzitiv fluxul de semnare STS — CLAUDE.md cere oprire + întrebare dacă
   o modificare „ar putea atinge fluxul de semnare STS/PAdES".

5. **`admin/users.mjs` — scrierile de promovare la `admin`/reasignare org sunt deja `role==='admin'`
   -only** (rândurile 775, 228 din tabel) — asta e prin design corect (doar super-admin poate crea
   alt super-admin), NU trebuie „aliniat" la (b)/(c). Riscul e doar pe partea de CITIRE/editare
   utilizatori existenți (rândurile 595, 634, 705), unde lipsește compensarea pentru `role==='admin'`
   cu `org_id`.

---

## 7. Notă despre `require-module.mjs` și `entitlements.mjs`

Aceste guard-uri (`role==='admin'` fără nicio noțiune de org) sunt corecte AȘA CUM SUNT — configurarea
modulelor la nivel de platformă și entitlements-urile sunt operații genuin globale, nu au echivalent
„org-scoped" (nu are sens un „org_admin" să activeze un modul doar pentru propria org, dacă modelul
de azi e all-or-nothing la nivel de instanță). Documentat aici ca să nu fie confundat la execuție
cu un sit de aliniat.

---

## Concluzie

Contractul (b) e ipoteza corectă, dar **nu există azi ca implementare unică** — există DOAR ca pattern
repetat manual în 3 locuri (`df.mjs`/`ord.mjs` detaliu). Restul codului (helper-ul admin canonic
inclusiv) implementează fie (a) — leak potențial pe citire — fie o variantă (c) mai strictă decât
necesar care LOCHEAZĂ platform-admin-ul din ALOP/fluxuri. Fix-ul central (`authz-scope.mjs`) rezolvă
majoritatea siturilor prin propagare din helper, dar cele 11 situri de scriere fără `sameOrg` pe
ramura admin (§4 grupa 2) și cele 2 situri de lockout (§4 grupa 3) sunt categorii de risc diferite
și merită execuție separată, nu un singur PR mare.
