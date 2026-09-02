---
prompt_id: 134a
titlu: RECON READ-ONLY — care revizie DF e „în vigoare" pentru ALOP (regresia pointerului df_id)
branch: develop
model_suggested: Opus 5 (efort high)
versiune_start: v3.9.785
migratii: NU
cod_de_productie_atins: NU — STRICT READ-ONLY
---

# ⚠️ BRANCH: `develop` — EXCLUSIV, și STRICT READ-ONLY

⛔ NU `checkout main`, NU `merge`, NU `push`.
⛔ **ZERO fișiere de producție modificate. ZERO commit. ZERO bump de versiune.**
✅ Singurul artefact permis: `docs/audits/ALOP-134-RECON-REVIZIE-2026-08.md`.

Dacă ai impulsul să „repari repede" ceva găsit pe drum — NU. Consemnează-l în
secțiunea R8. Reconul din #128a a reușit tocmai fiindcă n-a atins cod.

===============================================================================
## FAPTE DEJA STABILITE — nu le redescoperi, dar RAPORTEAZĂ orice nepotrivire
===============================================================================

Comportamentul așteptat de proprietarul produsului: **cât timp revizia R(n+1) nu
e aprobată, R(n) rămâne DF-ul în vigoare** — valorile, bugetul și plafoanele
ALOP se citesc de pe R(n). Azi nu se întâmplă asta.

**Cauza directă**, verificată pe `server/routes/formulare/df.mjs`
(`POST /api/formulare-df/:id/revizuieste`, în tranzacția de creare a reviziei):

```sql
UPDATE alop_instances SET df_id=$1, df_flow_id=NULL, df_completed_at=NULL, …
 WHERE df_id=$2 AND cancelled_at IS NULL
```

Pointerul `alop_instances.df_id` este mutat pe noua revizie **în clipa creării
ei, cât e încă `status='draft'`**, plus un fallback pe `source_alop_id`.

**Dovada că e REGRESIE, nu design** — trei locuri din cod scrise sub premisa
opusă, toate rămase în arbore:

1. `server/routes/alop.mjs` — `df_revizie_in_lucru` se calculează ca
   `EXISTS (SELECT 1 FROM formulare_df fd2 WHERE fd2.parent_df_id = df.id …)`,
   unde `df` este `a.df_id`. Asta are sens DOAR dacă `df_id` a rămas pe PĂRINTE.
   Cu relegarea eager, `df_id` este chiar copilul ⇒ predicatul caută un copil al
   copilului ⇒ **este întotdeauna FALSE**. Cod mort.
2. `server/services/alop-capabilities.mjs` — două ramuri depind de el:
   `caps.df_action = 'in_lucru_disabled'` și garda `!alop.df_revizie_in_lucru`
   din `can_revise_df`. Ambele sunt **inaccesibile** azi.
3. `server/services/alop-link.mjs` — antetul spune explicit că relegarea se face
   **„La aprobarea fluxului DF"**, prin `selfHealAlopDfLink`, apelată din
   `signing.mjs` și `crud.mjs`. Există deci DOUĂ mecanisme care mută același
   pointer, în două momente diferite; cel din `revizuieste` îl mută prea devreme.

**Consecințe deja identificate** (de confirmat și completat):

- `alop.mjs` citește TOATE mărimile financiare din `LEFT JOIN formulare_df df ON
  df.id = a.df_id`: `df_valoare`, `df_buget_an_curent`,
  `credite_bugetare_an_curent`, `df_stingere`, `df_an_referinta`,
  `df_revizie_nr` ⇒ cardul afișează cifrele unei revizii NEAPROBATE.
- `alop.ramas = df_valoare − suma_platita`, iar UI-ul îl etichetează literal
  **„din DF aprobat"** (`public/js/formular/alop.js:803`).
- `POST /api/alop/:id/noua-lichidare` calculează plafonul cu
  `crediteBugetareAnCurent(dfRow.rows_ctrl)` pe `alop.df_id`, iar comentariul de
  deasupra spune „al DF-ului **aprobat**" și „după o revizie de DF, `alop.df_id`
  pointează deja la revizia activă" — exact locul unde cele două înțelesuri ale
  pointerului au fost confundate. ⇒ **plafonul unei noi ordonanțări parțiale se
  poate calcula azi pe un draft.** Aceasta e miza reală a lotului.
- `public/js/formular/alop.js:584` are ramura
  „🔄 Revizia N pe flux — în curs · ultima aprobată: Revizia N−1", dar e gardată
  de `df_flow_active` ⇒ nu se aprinde pentru o revizie în DRAFT; se cade pe
  ramura 585 `✅ DF aprobat · Revizia N`.
- `revizuieste` pune `df_completed_at=NULL`, dar NU schimbă `a.status`; pentru un
  ALOP `completed`, `isCompleted` forțează oricum toate fazele pe „done".

**Caz real raportat din producție:** dosar cu R0 ✓, R1 ✓ (55.000), R2 în draft
(redeschisă după completare, niciodată aprobată). Trasabilitatea și cardul ALOP
arată „Completat" și „195.000,00 lei DF actual" — cifra lui R2.

===============================================================================
## CE TREBUIE SĂ PRODUCĂ RECONUL
===============================================================================

Un singur document, `docs/audits/ALOP-134-RECON-REVIZIE-2026-08.md`, cu
secțiunile R1…R8. Peste tot: **cifre reale din grep, cu fișier:linie** — nu
estimări. Unde nu poți stabili ceva, spune-o în R8; ⛔ nu ghici.

### R1 — Arheologia: CÂND a apărut relegarea eager

Rulează și raportează ieșirea BRUTĂ:
```bash
git log --follow --oneline -S "df_flow_id=NULL, df_completed_at=NULL" -- server/routes/formulare/df.mjs
git log --follow --oneline -S "UPDATE alop_instances SET df_id" -- server/routes/formulare/df.mjs
git log --follow --oneline -- server/services/alop-link.mjs | tail -5
git log --follow --oneline -S "df_revizie_in_lucru" -- server/routes/alop.mjs
```
Pentru fiecare commit găsit: hash, dată, mesaj și `git show --stat`.
**Întrebarea la care trebuie să răspunzi cu dovadă:** relegarea eager a existat
dintotdeauna, sau a fost adăugată/mutată ulterior — și, dacă da, ce bug repara?
(Suspiciunea de verificat: a fost adăugată ca să repare „ALOP arată Fără DF după
revizuire", adică un fix care a rezolvat legătura și a rupt semantica.)
Ordonează pe axa timpului și față de commit-ul care a introdus
`df_revizie_in_lucru` — care dintre ele e mai vechi decide care e regresia.

### R2 — Inventarul EXACT al consumatorilor lui `a.df_id`

Tabel cu fiecare sit, `fișier:linie`, ce citește și **ce se strică dacă
pointerul rămâne pe revizia aprobată** vs **ce se strică azi**. Împarte-le în:

- (a) **financiare** — valori, bugete, plafoane, `ramas`, `noua-lichidare`
- (b) **de navigare** — „deschide DF", `df_action`, tab-ul DF, trasabilitate
- (c) **de stare/afișare** — `df_flow_active`, `df_aprobat`, `df_revizie_nr`,
  badge-urile, cardul de fază
- (d) **de integritate** — `selfHealAlopDfLink`, `relinkAlopOnDfDelete`,
  restaurarea părintelui la refuz din `signing.mjs`, `flow-link-audit.mjs`,
  `authz-formular.mjs`, `flow-provenance.mjs`, `deriveOrdIdentityCols`

Marchează explicit fiecare rupere ca **ZGOMOTOASĂ** (eroare/vizibilă) sau
**TĂCUTĂ** (cifră greșită afișată/salvată). Clasa tăcută e cea care ne-a costat
la #115 și #128l.

### R3 — Cele trei variante de reparație, cu costul REAL

Prezintă-le față în față, ⛔ **fără să alegi tu**. Pentru fiecare: numărul de
situri atinse, dacă cere migrație, dacă cere reparare de date existente, și ce
logică azi moartă se reactivează.

- **(A) Pointerul se mută doar la APROBARE.** Se scoate relegarea eager din
  `revizuieste`; `selfHealAlopDfLink` (deja apelat din `signing.mjs` și
  `crud.mjs`, deja capabil să treacă de la o revizie la alta pe același
  `nr_unic_inreg`) rămâne singurul mecanism.
  ⚠️ **Verifică obligatoriu wrinkle-ul:** cu `df_id` pe R(n) aprobat,
  `COALESCE(df.flow_id, a.df_flow_id)` se oprește la fluxul COMPLETAT al lui
  R(n) și nu mai ajunge la `a.df_flow_id` ⇒ `df_flow_active` devine fals și cât
  timp R(n+1) e pe flux. Deci ramura de afișare 584 și badge-ul
  `angajare_flux`/`revizie_flux` (#132b) au nevoie de o derivare proprie, pe
  dosar, nu pe COALESCE. Cuantifică exact câte locuri.
  ⚠️ Verifică și navigarea: cum mai ajunge utilizatorul la R(n+1) din cardul
  ALOP, mai ales pentru un ALOP `completed` (unde `computeAlopCapabilities`
  iese devreme și `df_action` nici nu se calculează).
- **(B) Coloană nouă** `alop_instances.df_revizie_lucru_id`: `df_id` = revizia în
  vigoare (aprobată), coloana nouă = revizia în lucru. Migrație `ADD COLUMN`,
  fără backfill (NULL = nicio revizie în lucru), în linia deciziei de la #128b.
  ⚠️ Contra de cântărit: al DOILEA pointer de ținut sincron — aceeași clasă
  „adevăr dublu" pe care am respins-o la #128 (`orgId` coloană + JSONB,
  `df.flow_id` vs `alop.df_flow_id`).
- **(C) Derivare în SQL, fără a schimba semantica pointerului:** `df_id` rămâne
  „revizia curentă" (navigare), iar TOATE mărimile financiare se citesc dintr-un
  alias nou `dfa` = ultima revizie APROBATĂ din dosar, printr-un `LEFT JOIN
  LATERAL` pe cheia de dosar. Zero migrație, se auto-repară pentru rândurile deja
  stricate.
  ⚠️ Cuantifică: câte coloane și câte fișiere trec de la `df.` la `dfa.`; ce
  cheie de dosar e corectă (`dosarKeyExpr` din `df.mjs` vs `nr_unic_inreg` folosit
  de `selfHealAlopDfLink` — dacă diferă, SPUNE, e o capcană); costul în plan de
  execuție pentru lista ALOP.

### R4 — Ce înseamnă „în vigoare": pragul, apoi definiția

**R4.1 — PRAGUL (întrebare de produs, ⛔ NU o decide tu; adună doar dovezile).**
Sunt două candidate pentru momentul în care cifrele unei revizii devin cele în
vigoare:

- **`aprobat`** — fluxul de semnare s-a încheiat;
- **`completed`** — Responsabilul CAB a completat Secțiunea B, moment în care
  (după proprietarul produsului) modificarea e deja operată în Forexebug, deci
  cifrele sunt reale chiar dacă semnăturile nu s-au strâns.

Diferența contează: cu pragul `completed`, fereastra de inconsistență se
îngustează mult, dar o revizie REDESCHISĂ din `completed` înapoi în `draft`
(cazul real raportat) rămâne în afara ei în ambele variante.
Adună pentru fiecare prag: ce alte reguli din cod îl folosesc deja ca prag de
„real" (caută în `formular-capabilities.mjs`, `alop-capabilities.mjs`,
`noua-lichidare`, `computeOrdBudgetContext`), și ce s-ar întâmpla la
**redeschidere** (`resetDocToP1` / butonul „Redeschide document") — dacă un DF
`completed` devine `draft`, pragul trebuie să se retragă, iar cifrele să sară
înapoi pe revizia anterioară. Spune explicit dacă vreun mecanism face asta azi.

**R4.2 — Definiția, o singură dată.**
În cod există cel puțin trei forme pentru „aprobat": coloana `status='aprobat'`,
derivarea din flux din `relinkAlopOnDfDelete` (v3.9.746 — care spune explicit că
pe calea de semnare cloud coloana rămâne 'completed'), și `df_aprobat` din
`alop.mjs`. Enumeră-le pe toate cu `fișier:linie`, spune dacă sunt echivalente și
propune formularea unică pe care s-ar sprijini reparația.

### R5 — Repararea datelor existente (AMÂNATĂ deliberat)

⛔ NU te conecta la nicio bază de date — nici producție, nici staging.
Diagnosticul pe date reale a fost amânat CONȘTIENT de proprietarul produsului:
reparația de COD nu depinde de el, iar expunerea operațională e considerată mică
(fereastra în care o revizie stă neaprobată e scurtă, iar la pragul `completed`
cifrele sunt deja operate în Forexebug).

Ce trebuie să faci aici, tot pe hârtie:
1. Citește `DIAGNOSTIC-134-alop-revizie-in-vigoare.sql` (rădăcina repo) și
   verifică fiecare interogare contra SCHEMEI reale (nume de coloane, contra
   migrațiilor inline din `server/db/index.mjs`). Raportează orice greșeală —
   fișierul trebuie să fie gata de rulat când se decide.
2. Spune **dacă** varianta de reparație aleasă la R3 mai are nevoie de reparație
   retroactivă de date, sau se auto-repară la citire (varianta C).
3. Dacă are nevoie: schițează reparația (migrație vs script one-off), fără să o
   scrii, și spune ce backup e obligatoriu înainte.

### R6 — Ce se întâmplă cu ORD-ul deja emis

Un ALOP finalizat are deja cicluri ORD legate de o revizie anume. Dacă pointerul
se mută (azi) sau rămâne (după reparație), ce se întâmplă cu:
`computeOrdBudgetContext({ dfId: ordDoc.df_id })` · `deriveOrdIdentityCols`
(corelarea pozițională cu `rows_ctrl` al DF-ului legat) · ciclurile arhivate din
`alop_ord_cicluri` · `validateOrdCol5`. Spune explicit dacă `formulare_ord.df_id`
trebuie să rămână „înghețat" pe revizia de la momentul emiterii — și dacă azi
rămâne.

### R7 — Decupajul propus

`#134b…` cu ordinea, migrațiile necesare (dacă vreuna), ce lot poate rula
independent și care e primul lot care schimbă vizibil comportamentul pentru
utilizator. Include un lot separat pentru repararea datelor existente, dacă R5
arată că e nevoie.

### R8 — Ce NU am putut stabili

Onest și explicit. Plus orice loc unde codul real a contrazis faptele declarate
mai sus.

===============================================================================
## VERIFICARE ȘI RAPORT
===============================================================================

```bash
git status --short          # Așteptat: UN singur fișier nou, în docs/audits/
git diff --stat             # Așteptat: GOL
```

În răspunsul din chat: rezumatul fiecărei secțiuni R1-R8 în cel mult 5 rânduri,
plus răspunsul direct la întrebarea „când am regresat", cu hash-ul și data.

⛔ Fără commit. Fără push. Fără bump. Fără `npm test` (nu s-a schimbat nimic).
