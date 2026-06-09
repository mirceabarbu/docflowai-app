# DocFlowAI — 🧹 Docs + curățenie repo: CLAUDE.md, README, arhivare prompturi

```
═══════════════════════════════════════════════════════════
⚠️  BRANCH OBLIGATORIU: develop
⚠️  NU face checkout/merge/push pe main. NICIODATĂ.
⚠️  Producția (main → app.docflowai.ro) o gestionează Mircea manual.
═══════════════════════════════════════════════════════════

DocFlowAI v3.9.546 → v3.9.547
Branch: develop
Subiect: docs(refactor): codifică disciplina de consolidare în CLAUDE.md + actualizează README
         + chore: arhivează prompturile executate, curăță clutter-ul netracked
Tip: DOCS + CLEANUP — zero cod de producție. Fără CACHE_VERSION, fără ?v=.
```

---

## 🎯 Scop

Trei lucruri:
1. **CLAUDE.md** — adaugă o secțiune care codifică disciplina de consolidare DF/ORD + asimetrii (lecțiile
   care au prins 2 regresii reale), și repară referințele moarte la `formulare-db.mjs` (fișier șters la
   Etapa 2).
2. **README** — adu-l la zi: versiune, structura `routes/formulare/`, secțiunea de teste pe două niveluri.
3. **Curățenie repo** — mută prompturile executate în `docs/archive/`, tratează clutter-ul netracked.

ZERO cod de producție atins. Doar `.md` + mutări de fișiere.

---

## 🚫 Zone interzise

- NU atinge cod (`server/**/*.mjs` în afară de comentarii moarte cu `formulare-db.mjs`, vezi Pas 1c — DOAR
  în comentarii/docs, NU logică). NU atinge signing NO-TOUCH, `migrate.mjs`, schema.
- **NU șterge fișiere fără confirmare.** Clutter-ul netracked se LISTEAZĂ și se raportează; ștergi doar ce
  e clar junk (vezi Pas 3c) — restul îl lași și-l notezi pentru Mircea.

---

## 📋 Pas 0 — context

```bash
git checkout develop && git pull origin develop
git status   # vezi și fișierele untracked — sunt relevante la Pas 3
```

---

## 📋 Pas 1 — CLAUDE.md

### 1a. Inserează secțiunea nouă

Găsește finalul secțiunii `## Testing — două niveluri` (se termină cu paragraful „**Înainte de orice
modificare:** … testele DB sunt sursa de adevăr pentru regresii." urmat de `---`). **Imediat după acel
`---`, înainte de `## Capabilities`**, inserează verbatim:

````markdown
## Consolidare DF/ORD & asimetrii (anti-regresie) (din v3.9.544)

Lifecycle-ul DF/ORD e consolidat într-un singur service parametrizat pe `formType`, NU duplicat:

- `server/services/formular-shared.mjs` → `FORMULAR_TYPES` (config per tip) + funcții lifecycle
  (`submitFormular`/`completeFormular`/`returnFormular`/`linkFlowFormular`/`stergeFormular`), contract
  `{ status, body }`. Rutele din `server/routes/formulare/{df,ord}.mjs` sunt wrappers subțiri.

**Regula de aur:** orice diferență DF↔ORD trăiește ca o CHEIE EXPLICITĂ în `FORMULAR_TYPES`, niciodată ca
`if (ft === 'ord')` îngropat într-un handler. O asimetrie tăcută într-un handler duplicat e vectorul #1 de
regresie (fix pe DF uitat pe ORD; sau uniformizare care șterge o regulă intenționată).

Asimetrii intenționate DEJA cimentate (test în `server/tests/db/caracterizare-*`) — **NU le uniformiza**:
- `submitStatuses` — DF acceptă `de_revizuit`, ORD nu.
- `budgetCheck` — ORD hard `422 receptii_neplatite_negative` (col.5 ≥ 0); DF `none` (buget = soft-warning
  DOAR în frontend, by design).
- `alopOnComplete` — DF complete avansează ALOP `draft→angajare` + audit `legat_alop`; ORD nu atinge ALOP
  la complete.
- `linkFlow*` — DF setează `status='transmis_flux'`; ORD doar `flow_id`. ⚠️ ORD link-flow folosește o
  proiecție îngustă de coloane — `canEditFormular` citește `doc.assigned_to` pe ramura `p2_comp`, deci ce
  coloane încarci AFECTEAZĂ autorizarea. NU lărgi `SELECT`-ul fără să verifici impactul de authz.
- `relinkOnDelete` — DF conștient de revizii (R0 eliberează / R1+ restore parent aprobat); ORD simplu.

**Workflow obligatoriu când atingi formulare/ALOP:**
1. **Caracterizează întâi.** Dacă zona n-are test de caracterizare DB, adaugă-l în `server/tests/db/**`
   (status code + stare DB curentă) ÎNAINTE de orice schimbare. Vezi secțiunea Testing.
2. **Consolidează ce atingi.** Dacă lovești o pereche DF/ORD încă duplicată (ex. `/api/formulare/list`,
   create/PUT), pliază diferențele în config + funcție shared — nu adăuga o a treia copie.
3. **Asimetrie nouă = cheie nouă de config + test + comentariu „NU uniformiza".** Niciodată un `if` mut.

**Split de fișiere = MUTARE verbatim, nu rescriere.** Modelul e `routes/flows/` (orchestrator `index.mjs`
+ submodule). Capcană: Express potrivește în ordinea înregistrării — rutele statice (`/aprobate`) TREBUIE
înregistrate ÎNAINTEA celor cu param (`/:id`), altfel `:id` le prinde. Un test anti-shadowing în
`server/tests/db/` dovedește asta.

**Stare caracterizată la nivel DB (plasă activă):** formulare DF/ORD
(submit/complete/returneaza/revizuieste/sterge), ALOP (progresie stări, lazy-resync GET, ciclu multi-ORD,
gărzi tranziție), capabilities, zombie-flow, cancel. **Încă pe mock (fără plasă DB — caracterizează
înainte să atingi):** flows lifecycle, signing, entitlements, registratură, OPME.

---
````

### 1b. Reparare referințe moarte `formulare-db.mjs` în CLAUDE.md

Caută toate aparițiile și actualizează-le la noua structură:

```bash
grep -n "formulare-db.mjs" CLAUDE.md
```

În secțiunea `## Capabilities`, înlocuiește mențiunea
`din `server/routes/formulare-db.mjs`` cu `din `server/routes/formulare/{df,ord}.mjs``.
Orice altă apariție în CLAUDE.md → `server/routes/formulare/` (sau fișierul concret potrivit din context).
NU inventa — dacă o referință e ambiguă, pune `server/routes/formulare/`.

### 1c. Reparare referințe în comentariile de cod (DOAR comentarii, dacă au scăpat)

```bash
grep -rn "formulare-db.mjs" server/ --include=*.mjs
```
Dacă mai există în COMENTARII (nu logică), reorientează-le la `server/routes/formulare/`. (La Etapa 2 cele
3 cunoscute au fost reorientate; verifică să nu fi rămas dangling.) NU schimba nicio linie de logică.

### 1d. Actualizează secțiunea Backend Structure din CLAUDE.md

În `### Backend Structure (server/)`, dacă listează `formulare-db.mjs`, înlocuiește cu blocul `formulare/`
(df/ord/shared/index/_helpers) + adaugă `services/formular-shared.mjs`. Păstrează stilul ASCII-tree existent.

---

## 📋 Pas 2 — README.md

### 2a. Versiune (linia 1)
`# DocFlowAI v3.9.426` → `# DocFlowAI v3.9.547`

### 2b. Structura proiectului — blocul `routes/` (≈ liniile 88-90)
Înlocuiește linia:
```
    formulare-db.mjs            ← DF/ORD CRUD + workflow P1→P2 + revizii R0/R1+
```
cu:
```
    formulare/                  ← Modular (model flows/): DF/ORD CRUD + workflow P1→P2 + revizii
      index.mjs                 ← Orchestrator, export formulareDbRouter
      df.mjs                    ← Rute /api/formulare-df* (CRUD, lifecycle, revizii R0/R1+)
      ord.mjs                   ← Rute /api/formulare-ord*
      shared.mjs                ← Capturi, atașamente, beneficiari, list, audit (:type)
      _helpers.mjs              ← requireDb partajat
```
Și în blocul `services/` adaugă (lângă celelalte servicii formulare):
```
    formular-shared.mjs         ← Lifecycle DF/ORD parametrizat pe formType (FORMULAR_TYPES)
    formular-capabilities.mjs   ← Decizii UI server-side (computeDocCapabilities)
    authz-formular.mjs          ← Autorizare DF/ORD (canEdit/canView/canDestroy)
```
(Dacă unele sunt deja listate, nu dubla — adaugă doar ce lipsește.)

### 2c. Secțiunea `### Teste` (≈ liniile 205-211)
Înlocuiește tot blocul (inclusiv cele „293 teste", învechit) cu:
````markdown
### Teste

Două niveluri (detalii în CLAUDE.md → Testing):

```bash
npm test            # Nivel 1 — Vitest mock/unit + integration (rapid, fără DB)
npm run db:test:up  # pornește Postgres efemer (Docker) → exportă TEST_DATABASE_URL afișat
npm run test:db     # Nivel 2 — Postgres real: plasă de caracterizare (sursa de adevăr pt. regresii)
npm run check       # node --check sintaxă pe fișierele server
```

⚠️ `test:db` *sărit* (fără Docker) ≠ *trecut*. Confirmarea autoritară e CI (`push: develop`, `postgres:16`).
````

### 2d. (Opțional) changelog refactor
Sub secțiunea de cleanup existentă (`## Cleanup major v3.9.422 → v3.9.426`), adaugă o secțiune scurtă:
````markdown
## Consolidare anti-regresie v3.9.543 → v3.9.546

| Versiune | Etapă | Schimbare |
|---|---|---|
| v3.9.543 | Etapa 0 | Plasă caracterizare DB DF/ORD (submit/complete/returneaza/revizuieste) |
| v3.9.544 | Etapa 1 | Lifecycle DF/ORD → `formular-shared.mjs` parametrizat pe formType (−587 linii duplicat) |
| v3.9.545 | Etapa 2 | Split `formulare-db.mjs` → `routes/formulare/{df,ord,shared,index}` |
| v3.9.546 | Etapa 0-ALOP | Plasă caracterizare DB mașină de stare ALOP (progresie, lazy-resync, ciclu multi-ORD) |
````

---

## 📋 Pas 3 — Curățenie repo

### 3a. Inventariază prompturile (tracked + untracked)
```bash
echo "--- prompturi în afara docs/archive (tracked) ---"
find . -path ./node_modules -prune -o -name 'PROMPT*.md' -print | grep -v "docs/archive/"
echo "--- toate fișierele .md netracked / loose în root și docs/ ---"
git status --porcelain | grep -E "\.(md|tmp|status)$|/status"
ls -1 *.md 2>/dev/null
ls -1 docs/*.md 2>/dev/null
```

### 3b. Mută prompturile EXECUTATE în `docs/archive/`
Orice `PROMPT*.md` aflat în root, în `docs/` (dar nu în `docs/archive/`), sau netracked și care e clar un
prompt executat (inclusiv cele de refactor din această serie, dacă sunt pe disc:
`PROMPT_REFACTOR_ETAPA0*`, `*ETAPA1*`, `*ETAPA2*`, `PROMPT_ETAPA0_ALOP*`):
```bash
# pentru fiecare prompt executat găsit la 3a:
git mv <cale>/PROMPT_xxx.md docs/archive/    # dacă e tracked
# dacă e untracked:
mv <cale>/PROMPT_xxx.md docs/archive/ && git add docs/archive/PROMPT_xxx.md
```
NU muta `docs/archive/PROMPT_DEPLOY_PRODUCTION.md` / `PROMPT_PROMOTE_MAIN_OPME.md` — sunt deja la locul lor.
Dacă un prompt loose pare NEexecutat încă (te uiți la versiunea-țintă din header vs `package.json` actual),
NU-l arhiva — listează-l separat în raport ca „posibil neexecutat, lăsat pe loc".

### 3c. Clutter netracked (`.tmp`, `.status`, `status*`, `.bak`, `.orig`)
```bash
git status --porcelain | grep -E "^\?\?" | grep -iE "\.tmp$|\.status$|^.. status|\.bak$|\.orig$"
```
- Fișiere clar temporare/junk (`.tmp`, `.bak`, `.orig`, fișiere `status` goale sau cu output vechi de
  comenzi) → poți să le ștergi.
- Orice fișier despre care NU ești sigur → **NU șterge.** Listează-l în raport și lasă-l pe disc pentru
  ca Mircea să decidă.
- Dacă tiparul se repetă (apar des), adaugă-le la `.gitignore` (ex. `*.tmp`, `*.status`) ca să nu mai
  apară ca netracked. NU adăuga reguli prea largi care ar ascunde fișiere reale.

---

## 📋 Pas 4 — verificare + bump + commit + push

```bash
npm run check     # sintaxă (n-ai atins logică, dar confirmă)
npm test          # verde, fără regresii (n-ai atins cod)
# test:db nu e necesar (zero schimbare de comportament), dar nu strică dacă ai Docker.

# package.json: 3.9.546 → 3.9.547. FĂRĂ CACHE_VERSION, FĂRĂ ?v=.

git add CLAUDE.md README.md package.json docs/archive/ .gitignore
# + eventualele git mv deja staged
git commit -m "docs(refactor): codifică disciplina consolidare DF/ORD în CLAUDE.md + README la zi (v3.9.547); chore: arhivează prompturi executate"
git push origin develop
```

---

## ✅ Definiție de „gata"

1. CLAUDE.md: secțiunea „Consolidare DF/ORD & asimetrii" inserată; ZERO referințe moarte la
   `formulare-db.mjs` (nici în text, nici în Backend Structure); secțiunea Capabilities reparată.
2. README: v3.9.547, blocul `routes/formulare/` corect, `formular-shared.mjs` listat, secțiunea Teste pe
   două niveluri (fără numărul învechit „293"), opțional changelog refactor.
3. Toate prompturile executate sunt în `docs/archive/`; root/`docs/` curat de prompturi loose.
4. Clutter junk evident șters SAU listat pentru Mircea; `.gitignore` extins doar dacă justificat.
5. `grep -rn "formulare-db.mjs" server/ CLAUDE.md README.md` → fie 0 rezultate, fie doar în
   `docs/archive/` (prompturi istorice, lăsate intacte).
6. `npm run check` + `npm test` verzi; push pe develop; CI verde.
7. Raport: ce s-a inserat/reparat în CLAUDE.md, ce s-a actualizat în README, lista prompturilor mutate,
   lista clutter-ului șters vs lăsat-pentru-Mircea, eventuale prompturi „posibil neexecutate" semnalate.

**ATENȚIE la ștergeri:** orice fișier netracked despre care nu ești 100% sigur că e junk → lasă-l și
raportează-l. Mai bine un fișier rămas decât unul șters din greșeală.
