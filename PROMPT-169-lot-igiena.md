---
prompt: 169
titlu: "Lot de igienă — porți anti-regresie, plasa de siguranță, evidența, cod mort"
model_suggested: "Sonnet 5, efort high"
branch: develop
versiune_curenta: v3.9.822
versiune_tinta: v3.9.823
migratii: NU
fisiere_din_public: NU  (⇒ fără CACHE_VERSION, fără bump `?v=`)
zona_no_touch_atinsa: NU
---

# ⚠️ BRANCH

Lucrezi **EXCLUSIV pe `develop`**. `main` = PRODUCȚIE, gestionat manual de Mircea.
Pasul final obligatoriu: `git push origin develop`.

---

# ⛔ REGULA CARE DEFINEȘTE LOTUL

**Nicio linie de cod care rulează în producție nu își schimbă comportamentul.**

Tot ce urmează e: teste noi, configurație de teste, documentație, mutări de fișiere,
ștergere de cod dovedit mort. Dacă la vreun pas ajungi să te întrebi „oare asta schimbă
ce vede utilizatorul?", răspunsul e că pasul nu aparține acestui lot — **oprește-te și
raportează**, nu decide singur.

Un lot de igienă care strecoară o schimbare de comportament e mai periculos decât bug-ul
pe care voia să-l repare, fiindcă nimeni nu-l testează cu atenție.

---

## Context — de ce fiecare piesă e aici

Fiecare element de mai jos a produs deja o pierdere măsurabilă de timp:

- **Backtick-uri în comentarii SQL** — de patru ori aceeași greșeală (#134, #144, #157, #166),
  prinsă abia de `node --check`, după ce promptul fusese deja scris și rulat.
- **Cele patru căi de finalizare a unui flux au divergat tăcut** — trei scriu `completed`
  fără `status`, una le scrie pe amândouă. Am pierdut o sesiune întreagă crezând că e un bug,
  apoi descoperind că e definiția sistemului. Nu se repară nimic — se **fixează contractul**,
  ca următorul să afle din test, nu din arheologie.
- **`npm run check` verifică 56 de fișiere din 148** — plasa de siguranță are găuri de două
  treimi, iar noi ne bazăm pe ea la fiecare lot.
- **`auth-crypto.test.mjs` cade sub sarcină** (PBKDF2 la 100k iterații depășește timeout-ul
  global de 15 s; trece izolat) ⇒ suita nu mai e verde, deci un eșec REAL ar trece neobservat.
- **P0-06** — auditul din august l-a marcat P0. Măsurat pe producție: ruta instrumentată n-a
  fost folosită niciodată, iar pe căile vii PDF-ul semnat se produce pe server. Fără evidența
  scrisă, auditul următor redeschide discuția de la zero.

---

## ⛔ DELIBERAT ÎN AFARA LOTULUI

Nu atinge, nu „repara din drum", nu include în commit:

1. **Comutarea P0-06 din observare în blocare** (`signing.mjs:415-427`). E o schimbare de
   comportament pe o rută pe care nu o putem exercita cu date reale — exact categoria pe care
   o evităm. În lotul ăsta P0-06 primește **evidență scrisă**, nu cod.
2. **`catch(_){}` de la upload-ul capturilor** (`public/js/formular/doc.js`, ~1258). E real și
   merită reparat, dar înseamnă că utilizatorii încep să vadă erori pe care azi nu le văd ⇒
   schimbare de comportament, plus fișier din `public/` cu bump `?v=`. Lot separat.
3. **`server/db/migrate.mjs:53`** — `DELETE FROM schema_migrations WHERE id='014_alop'` la
   fiecare boot. E o anomalie reală, dar orice atingere în zona migrațiilor are consecință
   maximă. **O RAPORTEZI** la punctul 7 din raport. Nu o repara.
4. **`middleware/rateLimiter.mjs`** — cheia `${ip}:${req.path}` degenerează sub `router.use`.
   Ruta pe care o păzește are zero folosiri în producție ⇒ reparația n-ar schimba nimic azi.
5. **Cele trei copii ale shim-ului `_apiFetch`**, referințele la `/login.html`, orice fișier
   din `public/`.
6. **`services/clasa8.mjs`** și consolidarea `docAprobatSql`↔`validSignedFlowSql`. Loturi
   proprii, cu teste proprii.

---

## ETAPA 0 — ancore (READ-ONLY, zero modificări)

```bash
cd $(git rev-parse --show-toplevel)
git rev-parse --abbrev-ref HEAD        # Așteptat: develop
git status --short
node -e "console.log(require('./package.json').version)"        # Așteptat: 3.9.822
node -e "console.log(require('./package-lock.json').version)"   # Așteptat: 3.9.772

# A0.1 — dimensiunea găurii din plasa de siguranță
node -e "const s=require('./package.json').scripts.check; console.log('in check:', (s.match(/node --check/g)||[]).length)"
find server -name "*.mjs" -not -path "*/tests/*" | wc -l
# Așteptat: 56 în check, 148 pe disc

# A0.2 — modulele care exportă fragmente SQL (ținta porții anti-backtick)
grep -rln "Sql" server/services/*.mjs
# Așteptat, cel puțin: alop-dosar-sql, alop-link, authz-scope, df-aprobat-sql,
#                      flow-link-audit, flow-provenance, formular-shared

# A0.3 — cele patru căi de finalizare (ținta testului de paritate)
grep -n "allDone" server/routes/flows/signing.mjs server/routes/flows/cloud-signing.mjs \
                  server/routes/flows/bulk-signing.mjs

# A0.4 — limitatoarele din cloud-signing: o singură apariție = doar declarația
for v in _signRateLimit _uploadRateLimit _readRateLimit _largePdf; do
  echo -n "$v: "; grep -c "$v" server/routes/flows/cloud-signing.mjs; done
# Așteptat: primele trei = 1 (moarte), _largePdf > 1 (VIU — nu-l atinge)

# A0.5 — fișiere rătăcite în rădăcină
ls -1 *.md *.sql
# Așteptat: AGENTS.md, CLAUDE.md, README.md (rămân) + 6 PROMPT-128*.md,
#           2 DIAGNOSTIC-df-*.sql, 2 URGENT-sts-*.sql (se mută)

# A0.6 — testul instabil
grep -n "testTimeout" vitest.config.mjs
grep -n "salt aleatoriu" server/tests/unit/auth-crypto.test.mjs
```

Dacă A0.1 sau A0.4 dau alte numere, **oprește-te și raportează**.

---

## ETAPA A — poarta anti-backtick pe fragmentele SQL

**Fișier nou:** `server/tests/unit/sql-fragmente-fara-backtick.test.mjs`

Un backtick dintr-un fragment SQL exportat se interpolează într-un template literal la
consumator și rupe parsarea. `node --check` îl prinde, dar abia după ce lotul a fost scris.
Poarta asta îl prinde la scriere.

Construcție:

1. O listă EXPLICITĂ de invocări — `{ modul, export, args }` — pentru fiecare funcție
   exportată care întoarce SQL, din modulele găsite la A0.2. Le apelezi cu argumente
   plauzibile (aliasuri de tabel), colectezi rezultatul și asertezi că **nu conține
   caracterul backtick**.
2. ⭐ **Un meta-test care face lista să nu rămână în urmă:** parcurge fiecare modul din
   listă, enumeră exporturile lui, și pentru orice export de tip funcție care NU e acoperit
   de lista de la (1), testul CADE cu un mesaj care spune ce export lipsește. Fără asta,
   poarta protejează doar ce exista în ziua scrierii — exact modul în care s-au strecurat
   cele patru apariții.
3. Asertează și că rezultatele nu conțin `${` neevaluat (semn de interpolare ratată).

⚠️ Unele exporturi nu sunt funcții SQL (constante, array-uri de căi). Pe acelea le enumeri
explicit într-o listă de EXCLUDERI, **cu motiv scris lângă fiecare** — o excludere fără motiv
e o gaură viitoare.

⚠️ Importurile trebuie să fie pure: dacă vreun modul din A0.2 pornește o conexiune la DB sau
citește variabile de mediu la import, **nu-l include** și raportează-l — nu-l „aranja".

---

## ETAPA B — testul de paritate pe cele patru căi de finalizare

**Fișier nou:** `server/tests/unit/flux-finalizare-paritate.test.mjs`

⛔ **NU modifici niciuna dintre cele patru rute.** Testul FIXEAZĂ starea actuală, nu o
uniformizează. Analiză statică pe sursă (tiparul din `admin-cancel-ui.test.mjs`), nu import
de rute — au efecte secundare la încărcare.

Contractul real al sistemului, de asertat:

1. ⭐ Toate cele patru locuri (`signing.mjs` ~445, `cloud-signing.mjs` ~579 și ~927,
   `bulk-signing.mjs` ~636) setează, în blocul lor `if (allDone)`: `completed = true`,
   `completedAt`, și adaugă în `data.events` un eveniment `FLOW_COMPLETED`.
2. ⭐ **Exact UNA** dintre ele scrie și `status = 'completed'` — cea din `signing.mjs`.
   Asertează numărul (unu), nu doar prezența.
3. Un docblock în capul fișierului care explică DE CE testul e așa, ca cineva să nu-l
   „repare" uniformizând căile:
   - `status` și `completed` sunt ORTOGONALE: `status` = starea de ciclu de viață
     (`active` / `cancelled` / `refused` / `review_requested`), `completed` = finalizarea;
   - măsurat pe producție la 02.09.2026: **2102 fluxuri cu `completed=true`, ZERO cu
     `status='completed'`** ⇒ `signing.mjs` e EXCEPȚIA, nu norma;
   - de aceea fiecare predicat din sistem are `OR (completed)::boolean` — nu e o compensare
     accidentală, e definiția;
   - a adăuga `status='completed'` pe celelalte trei ar introduce o valoare pe care niciun
     rând din producție n-a purtat-o și ar rupe contorul `active` din
     `/admin/flows/stats`, care exclude prin listă de valori.

Dacă testul cade la prima rulare, înseamnă că ancorele din prompt nu se potrivesc cu codul —
**oprește-te și raportează**, nu ajusta codul ca să treacă testul.

---

## ETAPA C — plasa de siguranță: `npm run check` pe toate fișierele

**Fișier:** `package.json`, scriptul `check`.

Lista manuală de 56 de fișiere se înlocuiește cu o parcurgere reală:

`new_str` pentru valoarea scriptului `check`:
```
find server -name '*.mjs' -not -path '*/node_modules/*' -print0 | xargs -0 -n1 node --check
```

⚠️ Rulează comanda ÎNAINTE de a o pune în `package.json`. Dacă vreun fișier care azi nu era
verificat pică la `node --check`, **NU-L REPARA** — oprește-te, raportează care sunt și
așteaptă decizia. Un fișier cu eroare de sintaxă descoperit acum e o constatare, nu o sarcină
strecurată în lotul de igienă.

⚠️ Verifică și că include fișierele din `server/tests/` — dacă vrei să le excluzi, spune de ce
în raport; nu decide tăcut.

---

## ETAPA D — testul instabil

`server/tests/unit/auth-crypto.test.mjs` cade sub sarcină, trece izolat. Cauza e reală
(PBKDF2 la 100k iterații), nu o eroare de cod. Mărești timeout-ul **doar pe fișierul acela**,
cu comentariul care spune de ce:

- fie `describe(..., { timeout: 60_000 })`, fie `it(..., 60_000)` pe cazurile lente —
  alege forma consecventă cu restul suitei;
- ⛔ **NU** mări `testTimeout` global din `vitest.config.mjs` — ar masca încetiniri reale în
  alte teste;
- ⛔ **NU** reduce numărul de iterații PBKDF2 și nu atinge codul de criptare.

Verifică după: fișierul trece și în rularea completă, nu doar izolat.

---

## ETAPA E — cod dovedit mort

Doar ce e dovedit la A0.4, nimic în plus.

**Fișier:** `server/routes/flows/cloud-signing.mjs` — ștergi cele TREI declarații nefolosite
(`_signRateLimit`, `_uploadRateLimit`, `_readRateLimit`), fiecare cu o singură apariție în
fișier. ⛔ `_largePdf` e VIU — nu-l atinge.

**Constantă nefolosită:** `OID.QC_COMPLIANCE` — verifică întâi cu
`grep -rn "QC_COMPLIANCE" server --include=*.mjs`. Ștergi DOAR dacă singura apariție e
declarația. Dacă apare și în teste, o lași și raportezi.

**Assete:** `server/formulare/templates/ordnt_template.pdf` și `notafd_template.pdf` — la o
primă căutare n-au nicio referință. ⚠️ Înainte de a le șterge, caută și nume CONSTRUITE
dinamic (`+ '_template.pdf'`, `path.join(...)`, interpolare cu tipul formularului). **Dacă
rămâne cea mai mică urmă de îndoială, NU le ștergi și le raportezi** — un asset în plus costă
niște kilobytes, unul lipsă rupe generarea unui formular oficial.

---

## ETAPA F — evidența scrisă

### F.1 — `CLAUDE.md`, secțiune nouă: „P0-06 — închis prin absență (02.09.2026)"

Conținut, cu cifrele exacte:

- Constatarea auditului viza `POST /flows/:flowId/upload-signed-pdf` (`signing.mjs`), unde
  singura verificare era `uploadedHash === uploadPayload.preHash`, gardă moartă în practică.
- Măsurat pe producție, `audit_log` grupat pe `payload->>'via'` pentru
  `SIGNED_PDF_UPLOADED`: **bulk-signing 7.692 evenimente / 1.968 fluxuri** (29.04→02.09),
  **sts-poll 1.918 / 1.027** (20.04→02.09), **upload-local: niciun rând, în tot istoricul**.
  `cloud-callback`: zero.
- Pe căile VII, PDF-ul semnat se produce pe SERVER: `cloud-signing.mjs:471` îl ia de la
  serviciul Java de PAdES (construit din CMS-ul întors de STS); fallback-ul face `injectCms`
  local; bulk la fel. Clientul nu furnizează niciodată PDF-ul semnat ⇒ amenințarea din P0-06
  nu are unde să se producă acolo.
- Evenimentele `P0_06_OBSERVED_UNSIGNED` sunt zero fiindcă **ruta instrumentată nu s-a
  executat niciodată**, nu fiindcă invariantul a ținut. Controlul pozitiv folosit în august
  era invalid: cele 463 de `SIGNED_PDF_UPLOADED` comparate atunci veneau din alte rute.
- Întrebare deschisă pentru Mircea, de PRODUS: dezactivarea rutei locale ar închide subiectul
  definitiv; întărirea ei ar proteja o ușă pe care nu intră nimeni.

### F.2 — `CLAUDE.md`, index de loturi

Ultima secțiune documentată e #143/v3.9.800. Adaugi un index compact **#144 → #168**, câte un
rând: număr, versiune, ce a schimbat, în una-două propoziții. Sursa: `docs/archive` plus
mesajele de commit (`git log --oneline`). ⛔ Nu inventa: dacă pentru un număr nu găsești
dovadă, scrie-l ca „nedocumentat" și enumeră-l în raport.

Merită secțiune proprie, nu doar un rând: arhitectura `services/qc-evidence.mjs` (#144 —
calificarea unui certificat se decide pe DOVADĂ, din OID-urile din `qcStatements`).

### F.3 — mutarea fișierelor rătăcite

Cu `git mv`, ca istoricul să se păstreze:
- cele 6 `PROMPT-128*.md` → `docs/archive/`
- cele 2 `DIAGNOSTIC-df-*.sql` și cele 2 `URGENT-sts-*.sql` → `docs/archive/sql/`
  (creezi directorul dacă nu există)

⛔ `AGENTS.md`, `CLAUDE.md`, `README.md` rămân în rădăcină.

### F.4 — `package-lock.json`

Câmpul `version` al rootului: `3.9.772` → `3.9.823`. ⛔ **Nu rula `npm install`** și nu atinge
nimic altceva din fișier — un arbore de dependențe modificat într-un lot de igienă e exact
felul în care se strecoară o regresie invizibilă.

---

## ETAPA G — verificări, versionare, push

```bash
npm run check                       # noul script, pe toate cele 148 de fișiere. exit 0
npm test
npm run test:db                     # PG 17 efemer, port 55432. PASSED, nu SKIPPED.

# suita completă e verde, inclusiv auth-crypto (Etapa D)
git status --short                  # confirmă că `public/` NU apare deloc
grep -rn "P0-06" CLAUDE.md | head
ls -1 *.md *.sql                    # Așteptat: DOAR AGENTS.md, CLAUDE.md, README.md
node -e "console.log(require('./package-lock.json').version)"   # Așteptat: 3.9.823
```

```bash
# package.json: 3.9.822 → 3.9.823
git add -u && git add server/tests/unit/sql-fragmente-fara-backtick.test.mjs \
                      server/tests/unit/flux-finalizare-paritate.test.mjs
git status --short                  # verifică lista ÎNAINTE de commit
git commit -m "#169: igiena — porti anti-regresie, plasa de siguranta, evidenta P0-06 (v3.9.823)"
git push origin develop
```

---

## RAPORT FINAL

1. Ancorele din Etapa 0, **literal** — în special A0.1 și A0.4.
2. Diff-ul pe fiecare fișier; pentru `CLAUDE.md`, doar secțiunile noi.
3. ⭐ Rezultatul Etapei C: câte fișiere verifică acum `npm run check` față de 56, și
   **dacă vreunul a picat** — enumerat, nereparat.
4. ⭐ Etapa A: lista de invocări acoperite, lista de excluderi **cu motivul fiecăreia**, și
   dovada că meta-testul cade dacă adaugi un export fals neacoperit (rulează-l o dată cu un
   export inventat, ca să arăți că poarta chiar se închide).
5. ⭐ Etapa B: rezultatul celor două aserții, cu numărul obținut la (2).
6. Etapa E: pentru fiecare element șters, dovada că era mort. Pentru cele două PDF-uri,
   inclusiv căutarea după nume construite dinamic. Ce n-ai șters și de ce.
7. **Constatare cerută explicit, fără reparație:** `server/db/migrate.mjs:53` șterge la
   fiecare boot înregistrarea migrației `014_alop` și o reia. E idempotentă cu adevărat?
   Ce ar păți o bază nouă dacă linia dispare? Câte milisecunde costă la fiecare pornire?
   **Nu repara nimic.**
8. Numerele de lot pentru care n-ai găsit dovadă la F.2.
9. `npm test` / `npm run test:db` — rezultat real. Orice test existent atins, cu justificare.
10. Hash-ul commitului + confirmarea push-ului pe `develop`.

## ⛔ CONSTRÂNGERI ABSOLUTE

- **Zero schimbări de comportament în cod de producție.** Singurele atingeri permise în
  `server/` sunt ștergerile dovedite de la Etapa E.
- Zero fișiere din `public/`. Zero migrații. Zona NO-TOUCH neatinsă.
- Nu comuta P0-06 și nu atinge `signing.mjs`.
- Nu rula `npm install`, nu regenera `package-lock.json`.
- Nu mări `testTimeout` global și nu atinge codul de criptare.
- Nu uniformiza cele patru căi de finalizare — testul le FIXEAZĂ așa cum sunt.
- Nu șterge niciun asset dacă rămâne vreo îndoială; raportează în loc.
- Orice verificare cu rezultat neașteptat ⇒ oprire și raport, fără improvizație.
