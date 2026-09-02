---
prompt_id: 134e
titlu: Derivările ALOP trec de la POINTER la DOSAR — fundația variantei (A), fără a muta încă pointerul
branch: develop
model_suggested: Opus 5 (efort high)
versiune_start: v3.9.789
versiune_tinta: v3.9.790
migratii: NU
cache_version_bump: NU (nimic din PRECACHE_ASSETS)
---

# ⚠️ BRANCH: `develop` — EXCLUSIV

⛔ NU `checkout main`, NU `merge` spre `main`, NU `push origin main`.
✅ Ultimul pas: `git push origin develop`.

===============================================================================
## DECIZIA DE ARHITECTURĂ (luată de owner, nu se redeschide)
===============================================================================

Din reconul `docs/audits/ALOP-134-RECON-REVIZIE-2026-08.md`, owner-ul a ales
**varianta (A)**: `alop_instances.df_id` devine „revizia ÎN VIGOARE" și se mută
**doar la aprobare**; revizia în lucru se **DERIVĂ**, nu se stochează (fără
coloană nouă, fără al doilea pointer de sincronizat — lecția #128).

**Acest lot NU mută pointerul.** El pregătește terenul: mută toate derivările de
stare de pe **pointer** pe **DOSAR**. Motivul e de risc: derivările corelate pe
dosar sunt corecte ȘI sub regimul de azi, ȘI după mutarea pointerului. Așa
schimbarea de semantică (#134f) devine o ștergere de două `UPDATE`-uri, nu un
salt în gol.

⛔ **NU atinge `POST /api/formulare-df/:id/revizuieste`** — cele două `UPDATE`-uri
pe `alop_instances` rămân exact cum sunt. Sunt subiectul lotului #134f.

**Renumerotare față de recon:** #134e = fundația derivată (aici) · #134f =
mutarea pointerului · #134g = repararea datelor · #134h = `flow-link-audit`.

===============================================================================
## ⚠️ CUPLAJUL CARE POATE STRICA PRODUCȚIA — citește înainte de a scrie cod
===============================================================================

Reconul (b4) a stabilit că **protecția de azi împotriva reviziilor paralele NU
este `df_revizie_in_lucru`** (acela e cod mort din 2026-05-03) — este faptul că
`df_aprobat` iese `false` cât timp pointerul stă pe draft, ceea ce ascunde
butonul „Revizuiește DF".

Acest lot schimbă `df_aprobat` din „revizia POINTATĂ e aprobată" în „DOSARUL are
o revizie aprobată". Sub regimul de azi cele două DIFERĂ: pointer pe draft +
dosar cu R1 aprobat ⇒ azi `false`, după patch `true`.

⇒ **Dacă nu reînvii garda în ACELAȘI lot, deschizi revizii paralele.**
Obligatoriu, în acest lot: `can_revise_df` capătă garda
`!df_revizie_in_lucru`, iar `df_revizie_in_lucru` se recalculează pe DOSAR
(`df_revizie_lucru_id IS NOT NULL`), nu pe `parent_df_id = df.id`.
Un test dedicat (V7) apără exact asta.

===============================================================================
## FIȘIERE ATINSE (exhaustiv)
===============================================================================

1. `server/services/alop-dosar-sql.mjs` — **FIȘIER NOU**
2. `server/routes/alop.mjs` — fragmentele de stare + coloanele expuse
3. `server/services/alop-capabilities.mjs` — garda `can_revise_df`
4. `public/js/formular/alop.js` — cardul de fază + eticheta reviziei
5. `server/tests/unit/alop-dosar-sql.test.mjs` — **FIȘIER NOU**
6. `server/tests/unit/alop-capabilities.test.mjs` — cazuri ADĂUGATE (existent)
7. `server/tests/db/alop-dosar-derivari.test.mjs` — **FIȘIER NOU**
8. `public/formular.html` — doar `?v=` pe alop.js
9. `package.json` — bump versiune

⛔ NU se atinge: `df.mjs`, `alop-link.mjs`, `formular-shared.mjs`,
`formulare/shared.mjs`, `signing.mjs`, zona NO-TOUCH.

===============================================================================
## ETAPA 1 — Modulul de dosar
===============================================================================

`server/services/alop-dosar-sql.mjs`, modul PUR (fără `pool`), pe tiparul lui
`df-dosar-key.mjs` și `df-aprobat-sql.mjs` (#134d).

⚠️ **Constrângerea de fier:** fragmentele intră în `SQL_ALOP_BADGE`, folosit ȘI
în `WHERE`-ul de COUNT din `GET /api/alop`, **care nu are NICIUN JOIN** (#121).
Deci totul se scrie **corelat strict pe `a.*`**, fără nicio referință la aliasul
`df` sau la vreun alt JOIN. ⛔ O singură referință la `df.` sparge COUNT-ul.

⚠️ **Zero backtick-uri și zero diacritice în comentariile din interiorul
șirurilor SQL** — lecția #134b: rup template literal-ul.

Definiții cerute:

```js
/**
 * server/services/alop-dosar-sql.mjs — STAREA UNUI DOSAR ALOP (#134e)
 *
 * De ce exista: pana acum starea se deriva din POINTERUL a.df_id, care se muta pe
 * revizia noua in clipa crearii ei. Reconul #134a a aratat ca asta face ca:
 *  - badge-ul "Revizie pe flux" sa nu se aprinda niciodata pentru o revizie in draft;
 *  - COALESCE(df.flow_id, a.df_flow_id) sa nu poata vedea fluxul reviziei odata ce
 *    pointerul e mutat inapoi pe revizia aprobata (varianta A).
 * Derivarea pe DOSAR e corecta sub AMBELE regimuri, deci muta riscul in afara
 * schimbarii de semantica.
 *
 * ⛔ Corelat STRICT pe a.* — WHERE-ul de COUNT din GET /api/alop nu are joinuri (#121).
 * ⛔ Fara backtick-uri in comentariile SQL de mai jos (template literal).
 */
```

- `sqlFdInDosar(fd, a)` — predicat: rândul `fd` aparține dosarului ALOP-ului `a`.
  Ramura principală: `fd.source_alop_id = a.id` (indexată — `idx` parțial pe
  `formulare_df(source_alop_id)`, migrația 084, plus unicul
  `df_source_alop_revizie_uniq`, migrația 095).
  Ramura LEGACY, pentru DF-urile fără proveniență:
  `fd.source_alop_id IS NULL AND fd.org_id = a.org_id AND fd.nr_unic_inreg =
  (SELECT d0.nr_unic_inreg FROM formulare_df d0 WHERE d0.id = a.df_id)`.
  Include mereu `fd.deleted_at IS NULL`.
  ⚠️ Ramura legacy e singurul loc care mai poate amesteca dosare cu număr
  partajat; scrie asta în comentariu și limiteaz-o strict la `source_alop_id IS NULL`.

- `sqlDosarAreFluxActiv(a)` — `EXISTS`: o revizie a dosarului e pe un flux viu
  (`deleted_at IS NULL`, `completed` != 'true', status nici `cancelled`, nici `refused`).

- `sqlDosarAreAprobat(a)` — `EXISTS`: dosarul are cel puțin o revizie aprobată,
  folosind **`dfAprobatSql`** din `df-aprobat-sql.mjs` (#134d). ⛔ Nu rescrie
  definiția aprobării.

- `sqlRevizieInLucruId(a)` și `sqlRevizieInLucruNr(a)` — subinterogări scalare:
  revizia cu `revizie_nr` MAXIM din dosar care **nu** e aprobată, sau `NULL`.
  Filtre obligatorii: `revizie_nr > 0` (un R0 în draft e documentul inițial, nu o
  „revizie în lucru") și `ORDER BY revizie_nr DESC, created_at DESC LIMIT 1`.
  ⚠️ O revizie REFUZATĂ se numără ca „în lucru" — are nevoie de rework. Scrie-o
  ca decizie explicită în comentariu, ca următoarea sesiune să nu o creadă bug.

Test NOU `server/tests/unit/alop-dosar-sql.test.mjs` (pur textual, min. 8 cazuri):
aliasuri implicite/personalizate · ambele ramuri din `sqlFdInDosar` prezente ·
`deleted_at IS NULL` prezent peste tot · **zero apariții ale literalului `df.`**
în oricare fragment (poarta anti-COUNT) · zero backtick · paranteze echilibrate ·
`sqlDosarAreAprobat` conține ieșirea lui `dfAprobatSql` · `revizie_nr > 0` prezent
în ambele fragmente de „în lucru".

===============================================================================
## ETAPA 2 — `alop.mjs`: cele 6 situri de COALESCE + coloanele expuse
===============================================================================

⚠️ Nu îți dau `old_str` exact: textul e cel produs la #132b și #134d, iar arhiva
mea e anterioară. **Localizează prin conținut**, și raportează textul VECHI și
NOU pentru fiecare sit.

1. `SQL_ALOP_FLUX_DF_ACTIV` → `sqlDosarAreFluxActiv('a')`
2. `SQL_ALOP_DF_APROBAT` → `sqlDosarAreAprobat('a')`
3. `SQL_ALOP_DF_FLOW` rămâne DOAR dacă mai are consumatori după (1) și (2). Dacă
   nu mai are, **șterge-l** și spune-o în raport. ⛔ Nu-l lăsa mort.
4. Coloana expusă `df_flow_active`, în AMBELE interogări (listă + detaliu)
   → `sqlDosarAreFluxActiv('a')`
5. Coloana expusă `df_aprobat`, în AMBELE interogări → `sqlDosarAreAprobat('a')`
   (⚠️ acesta e situl „viu" semnalat la #134d punctul 8 — până acum pe forma 2/3)
6. Coloane NOI, în AMBELE interogări: `df_revizie_lucru_id`, `df_revizie_lucru_nr`
7. `df_revizie_in_lucru` (azi `EXISTS(... fd2.parent_df_id = df.id)`, cod mort din
   2026-05-03) → `(${sqlRevizieInLucruId('a')}) IS NOT NULL`

⛔ `SQL_ALOP_BADGE` își păstrează structura și ORDINEA ramurilor — se schimbă doar
fragmentele pe care le compune.
⛔ NU atinge `sqlBugetAnExercitiu`, `sqlCrediteBugetareCol10`,
`sqlRamasAnExercitiu`, `df_valoare`, `noua-lichidare`, `GET /api/alop/stats`.
Coloanele FINANCIARE rămân pe `df.` (pointer) în acest lot — se corectează
automat la #134f, când pointerul redevine revizia în vigoare.

**Verificare Etapa 2:**
```bash
grep -c "COALESCE(df.flow_id, a.df_flow_id)" server/routes/alop.mjs   # Așteptat: 0
grep -c "parent_df_id" server/routes/alop.mjs                          # Așteptat: 0
grep -c "alop-dosar-sql" server/routes/alop.mjs                        # Așteptat: 1 (importul)
node --check server/routes/alop.mjs
```

===============================================================================
## ETAPA 3 — Garda anti-revizii-paralele (OBLIGATORIE în acest lot)
===============================================================================

`server/services/alop-capabilities.mjs`:

- `can_revise_df` păstrează `df_aprobat === true` **și** capătă (sau își
  reactivează) `&& !alop.df_revizie_in_lucru`.
- ramura `df_action = 'in_lucru_disabled'` redevine accesibilă — verific-o.

⚠️ Citește motivul din secțiunea „CUPLAJUL" de mai sus înainte de a atinge
fișierul. Fără această etapă, lotul e o regresie de securitate funcțională.

===============================================================================
## ETAPA 4 — Frontend
===============================================================================

`public/js/formular/alop.js`:

- ramura „🔄 Revizia N pe flux — în curs · ultima aprobată: Revizia N−1" (gardată
  azi de `df_flow_active`) folosește noile câmpuri și se aprinde ACUM și pentru o
  revizie în **draft**, nu doar pe flux. Textul pentru draft:
  `🔄 Revizia N in lucru — in vigoare ramane Revizia N-1` (adaptează diacriticele
  la stilul fișierului).
- eticheta „DF activ: R{n}" devine `DF in vigoare: R{n}` și, când
  `df_revizie_lucru_nr` e non-null, primește `· Revizie in lucru: R{m}`.
  ⚠️ Sub regimul de AZI, `df_revizie_nr` e încă revizia draft ⇒ cele două pot
  arăta același număr. E **așteptat** până la #134f; nu-l „repara" cu o
  ajustare pe client.

⛔ NU atinge `_alopStatusBadge` (vine ca `badge_status` de la #132b), nici
`_alopFazaLabel`, nici cardurile financiare.

===============================================================================
## ETAPA 5 — Teste
===============================================================================

`server/tests/db/alop-dosar-derivari.test.mjs` — NOU, pe PG real. Fixture cu
patru dosare, ⛔ **cu pointerul lăsat exact cum îl pune codul de azi**:

- **D1** — R0 aprobat, fără revizii
- **D2** — R0 aprobat + R1 în DRAFT (pointerul e pe R1, ca azi)
- **D3** — R0 aprobat + R1 pe flux ACTIV
- **D4** — dosar LEGACY (`source_alop_id IS NULL`), R0 aprobat

Cazuri:
1. **V1** — D1: `df_aprobat` true, `df_flow_active` false, `df_revizie_lucru_id` NULL
2. **V2** — D2: `df_aprobat` **true** (azi era false — schimbarea centrală),
   `df_revizie_lucru_nr` = 1
3. **V3** — D2: `badge_status` = `revizie_flux`? **NU** — fluxul nu e activ ⇒
   rămâne pe `a.status`. Aserție explicită, ca să nu se confunde „în lucru" cu „pe flux"
4. **V4** — D3: `df_flow_active` true, `badge_status` = `revizie_flux`
5. **V5** — D4: ramura legacy funcționează; un DF cu același `nr_unic_inreg` din
   **alt org** NU intră în dosar
6. **V6** — `total` din `GET /api/alop` == `rows.length` pentru fiecare filtru de
   status, inclusiv `revizie_flux` ⭐ (poarta COUNT-fără-JOIN)
7. **V7** ⭐ — D2: `can_revise_df` este **false** (garda din Etapa 3). ⛔ Rulează-l
   ÎNTÂI contra codului cu Etapa 2 aplicată dar FĂRĂ Etapa 3; trebuie să pice roșu.
   **Ieșirea brută a acelui eșec e obligatorie în raport** — e dovada că garda e
   necesară, nu decorativă.
8. **V8** — o revizie REFUZATĂ se numără ca „în lucru" (decizia din Etapa 1)
9. **V9** — non-regresie financiară: `df_valoare` și `df_buget_an_curent` sunt
   NESCHIMBATE față de înainte de patch pe toate cele patru dosare (acest lot nu
   atinge banii)

În `server/tests/unit/alop-capabilities.test.mjs`, ⛔ fără a slăbi cazurile
existente: `df_revizie_in_lucru: true` ⇒ `can_revise_df` false și
`df_action = 'in_lucru_disabled'` — cazurile scrise la #64 devin în sfârșit
reprezentative pentru producție.

```bash
npm test
npm run test:db
```
Ambele verzi. ⛔ **`test:db` NU se sare la acest lot** — e miezul lui. Absența
Docker nu e motiv de skip; rețeta cu PG 17 efemer e în `CLAUDE.md`.

⚠️ Suitele care pot cimenta comportamentul vechi: `alop-revizie-afisare.test.mjs`,
`alop-list-filtre.test.mjs`, `alop-capabilities.test.mjs`,
`df-alop-link-resilienta.test.mjs`. Dacă vreuna pică, **raportează ce aserta și de
ce e legitim să se schimbe, ÎNAINTE de a o modifica.** ⛔ Nu rescrie tăcut niciun test.

===============================================================================
## ETAPA 6 — Verificare de proveniență (d7 din recon), DOAR raport
===============================================================================

Reconul n-a putut epuiza `checkFlowLinkable` / `checkFlowSigned`
(`flow-provenance.mjs`, `alopDocCol: 'df_id'`) sub varianta (A): lansarea unui
flux pentru R(n+1) trebuie să treacă pe ramura de **proveniență**
(`source_alop_id`), nu pe cea directă.

Citește codul și **raportează**: sub regimul de la #134f (pointer pe revizia
aprobată), lansarea fluxului pentru R(n+1) mai trece? Pe ce ramură?
⛔ **Nu modifica nimic acolo în acest lot** — e input pentru #134f.

===============================================================================
## ETAPA 7 — Versionare și commit
===============================================================================

```bash
# package.json 3.9.789 → 3.9.790
sed -i -E "s#(js/formular/alop\.js\?v=)[0-9.]+#\13.9.790#g" public/formular.html
grep -o 'formular/alop\.js?v=[0-9.]*'      public/formular.html   # Așteptat: 3.9.790
grep -o 'formular/list\.js?v=[0-9.]*'      public/formular.html   # Așteptat: 3.9.784 — NEATINS
grep -o 'shared/xlsx-export\.js?v=[0-9.]*' public/formular.html   # Așteptat: 3.9.789 — NEATINS
grep -n 'js/formular/alop\.js' public/formular.html               # tag <script> INTACT
grep -n "CACHE_VERSION" public/sw.js | head -1                    # NEATINS
```
⚠️ Grupul de captură la `sed` se scrie `\1`, NU `\g<1>`.

```bash
git status --short
# ⛔ NU `git add -A` — reorganizarea de documentație stă necomisă și nu aparține aici.
git add server/services/alop-dosar-sql.mjs server/routes/alop.mjs \
        server/services/alop-capabilities.mjs public/js/formular/alop.js \
        public/formular.html \
        server/tests/unit/alop-dosar-sql.test.mjs \
        server/tests/unit/alop-capabilities.test.mjs \
        server/tests/db/alop-dosar-derivari.test.mjs package.json
git commit -m "refactor(#134e): derivarile de stare ALOP trec de la pointerul df_id pe DOSAR; garda anti-revizii-paralele reinviata (v3.9.790)"
git push origin develop
```

===============================================================================
## RAPORT FINAL (obligatoriu)
===============================================================================

1. **Ieșirea BRUTĂ a eșecului V7** fără Etapa 3. Dacă a trecut din prima, spune-o
   și oprește-te — înseamnă că garda are altă sursă decât cred eu.
2. Pentru fiecare dintre cele 7 situri din Etapa 2: textul VECHI și cel NOU.
   Plus verdictul pe `SQL_ALOP_DF_FLOW`: mai are consumatori sau a fost șters?
3. Ieșirea comenzilor de verificare (Etapele 2, 7).
4. `npm test` / `npm run test:db`, cu confirmarea „PASSED REAL pe PG 17".
5. Cele 9 cazuri DB + cele 8 unitare, numerotat, cu accent pe **V6** și **V7**.
6. Ce teste EXISTENTE au picat, ce asertau și de ce e legitim să se schimbe.
7. **Răspunsul la Etapa 6** (d7 / proveniență) — input pentru #134f.
8. `EXPLAIN` pe COUNT-ul din `GET /api/alop` cu `?status=revizie_flux`:
   apare vreun Seq Scan costisitor peste `formulare_df` sau `flows`?
9. Hash-ul commit-ului + confirmarea push-ului.
10. Orice contrazicere între cod și acest prompt — raportează, nu repara tăcut.

===============================================================================
## ⛔ CONSTRÂNGERI ABSOLUTE
===============================================================================

- ⛔ NU muta pointerul. `/revizuieste` din `df.mjs` rămâne NEATINS (e #134f).
- ⛔ NU adăuga nicio coloană în `alop_instances`. Revizia în lucru se DERIVĂ.
- ⛔ Zero referințe la aliasul `df` (sau la orice JOIN) în fragmentele care ajung
  în `where` — COUNT-ul nu are joinuri și ar crăpa.
- ⛔ NU atinge coloanele FINANCIARE (`df_valoare`, bugete, `ramas`,
  `noua-lichidare`, `/stats`) — se repară la #134f.
- ⛔ NU rescrie definiția aprobării; folosește `dfAprobatSql` de la #134d.
- ⛔ Zero backtick-uri și zero diacritice în comentariile din interiorul
  șirurilor SQL.
- ⛔ Zero migrații, zero index nou, zero `UPDATE` de date.
- ⛔ Zona NO-TOUCH neatinsă. ⛔ NU folosi `git add -A`. ⛔ `main` nu se atinge.
