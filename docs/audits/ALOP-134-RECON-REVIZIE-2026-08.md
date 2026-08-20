# RECON #134a — care revizie DF e „în vigoare" pentru ALOP

**Data:** 2026-08-20 · **Branch:** `develop` @ v3.9.785 (`d24bee5`) · **Mod:** STRICT READ-ONLY
(zero fișiere de producție atinse, zero commit, zero migrație)

**Întrebarea:** proprietarul produsului așteaptă ca, până la aprobarea reviziei R(n+1),
R(n) să rămână DF-ul **în vigoare** (valori, buget, plafoane). Azi nu se întâmplă.

**Răspunsul scurt la „când am regresat":** relegarea eager NU e o regresie ulterioară — a
intrat **odată cu sistemul de revizii**, în `4bbc6d5` (**2026-04-11 18:46 +0300**). Regresia
propriu-zisă (transformarea gărzii `df_revizie_in_lucru` în cod mort) e **`33febe0`
(2026-05-03 16:07 +0300), „Fix 5"**. Detalii în R1.

---

## R1 — Arheologia: când a apărut relegarea eager

### Ieșirea brută a comenzilor cerute

```
$ git log --follow --oneline -S "df_flow_id=NULL, df_completed_at=NULL" -- server/routes/formulare/df.mjs
a772741 fix(df-alop): finalizare DF + self-heal si pe calea de semnare cloud; relink robust la stergere revizie v3.9.746
0e639c2 refactor(formulare): split formulare-db.mjs în routes/formulare/{df,ord,shared,index} (mecanic, zero comportament)

$ git log --follow --oneline -S "UPDATE alop_instances SET df_id" -- server/routes/formulare/df.mjs
a772741 fix(df-alop): finalizare DF + self-heal si pe calea de semnare cloud; relink robust la stergere revizie v3.9.746
0e639c2 refactor(formulare): split formulare-db.mjs în routes/formulare/{df,ord,shared,index} (mecanic, zero comportament)

$ git log --follow --oneline -- server/services/alop-link.mjs | tail -5
fd64dd9 refactor(df-alop): self-heal DF lazy in alop.mjs + revert carlig din zona NO-TOUCH; blocare PUT derivata din flux v3.9.750
a772741 fix(df-alop): finalizare DF + self-heal si pe calea de semnare cloud; relink robust la stergere revizie v3.9.746
77821bb fix(alop-link): proveniență source_alop_id + self-heal relink DF→ALOP la aprobare (v3.9.554, A)

$ git log --follow --oneline -S "df_revizie_in_lucru" -- server/routes/alop.mjs
e261022 feat(df): state machine complet — neaprobat, de_revizuit, badge R0/R1+
```

⚠️ `--follow` NU a traversat redenumirea în `-S` (a raportat commit-ul de split `0e639c2` ca
„origine"). Interogarea pe fișierul VECHI dă originea reală:

```
$ git log --oneline -S "UPDATE alop_instances SET df_id" -- server/routes/formulare-db.mjs server/routes/formulare/df.mjs
a772741  0e639c2  4bbc6d5      ← 4bbc6d5 e originea
```

### Axa timpului (hash · dată · ce a făcut)

| # | Commit | Data | Ce a introdus |
|---|--------|------|---------------|
| 1 | `4bbc6d5` | **2026-04-11 18:46** | `feat: sistem revizuiri DF — revizie_nr, parent_df_id, endpoint + UI`. **Aici apare relegarea eager**, în corpul inițial al lui `/revizuieste`, cu comentariul „Actualizează linkul ALOP → df_id la noua revizie". Nu repara nimic: a fost scrisă odată cu endpoint-ul. |
| 2 | `e261022` | 2026-04-29 10:18 | `feat(df): state machine complet`. Introduce `df_revizie_in_lucru`, cu predicatul `fd2.nr_unic_inreg = df.nr_unic_inreg`. Sub relegarea eager, `df` E DEJA copilul ⇒ subinterogarea se potrivea pe ea însăși ⇒ **aproape întotdeauna TRUE**. |
| 3 | `33febe0` | **2026-05-03 16:07** | `fix: 11 bug-fix-uri surgical`, **„Fix 5 (df_revizie_in_lucru fals pozitiv)"**: predicatul devine `fd2.parent_df_id = df.id`. Cum `df` e copilul, se caută **un copil al copilului** ⇒ **aproape întotdeauna FALSE**. Un „always-true" a fost preschimbat în „always-false". |
| 4 | `5512a4c`,`aab29b4`,`9ecca19`,`1b20a87` | mai 2026 | joinurile de flux devin `COALESCE(df.flow_id, a.df_flow_id)` — pansament peste `a.df_flow_id=NULL` pus de relegarea eager. |
| 5 | `9e7b26f` / `da3ef31` | 2026-05-29 | `alop-capabilities.mjs` — `df_action='in_lucru_disabled'` construit peste flag-ul deja mort. |
| 6 | `73399bd` | 2026-07-08 | `can_revise_df` gated de `df_aprobat` **și** `!df_revizie_in_lucru` — a doua gardă peste flag-ul mort. |
| 7 | `77821bb` | 2026-06-12 | `alop-link.mjs` — self-heal **„la aprobarea fluxului DF"**. Al DOILEA mecanism care mută același pointer, în alt moment. |
| 8 | `a772741` / `fd64dd9` | 2026-08-04 / 08-11 | robustețe pe self-heal (cloud + lazy pe GET) + fallback `source_alop_id` în `/revizuieste`. |
| 9 | `0335cb6` | 2026-08-12 | #126: cheia de dosar (`df-dosar-key.mjs`). **Nu a atins `alop-link.mjs`** — vezi R3-C. |

### Verdict

- **Relegarea eager a existat dintotdeauna** (`4bbc6d5`, 2026-04-11). Suspiciunea din prompt
  („a fost adăugată ca să repare «ALOP arată Fără DF după revizuire»") este **INFIRMATĂ de
  cod**: acel bug a fost reparat separat, 2 luni mai târziu, prin `77821bb` + `a772741`
  (`source_alop_id` + self-heal), și tot atunci a apărut al doilea mecanism.
- **`df_revizie_in_lucru` e mai NOU decât relegarea eager** (2026-04-29 vs 2026-04-11) ⇒
  regresia nu e „pointerul a fost mutat", ci **„garda a fost scrisă sub premisa opusă și apoi
  «reparată» în cod mort"**. Momentul exact al morții: **`33febe0`, 2026-05-03 16:07 +0300**.
- Prin urmare, sensul „`df_id` = revizia în vigoare" a existat **doar în intenția autorilor
  ulteriori** (`df_revizie_in_lucru`, antetul `alop-link.mjs`, comentariul „din DF aprobat"),
  niciodată în comportamentul rulat. Reparația e **o schimbare de semantică deliberată**, nu
  o revenire la un comportament pierdut. Asta contează pentru R7 (datele existente).

**Situl de azi:** `server/routes/formulare/df.mjs:696-700` (relegare eager, în tranzacție) +
`:705-711` (fallback pe `source_alop_id`, din `a772741`).

---

## R2 — Inventarul consumatorilor lui `a.df_id`

Legendă: **AZI** = ce se strică cu pointerul mutat eager; **DUPĂ (A)** = ce s-ar strica dacă
pointerul rămâne pe revizia aprobată. 🔇 = TĂCUT (cifră greșită), 🔊 = ZGOMOTOS (vizibil/eroare).

### (a) Financiare — miza reală

| # | Sit | Citește | AZI | DUPĂ (A) |
|---|-----|---------|-----|----------|
| a1 | `alop.mjs:1753-1757` `noua-lichidare` | `rows_ctrl` (col.10) al `alop.df_id` | 🔇 **plafonul unui ciclu nou se calculează pe un DRAFT**. Comentariul de la `:1747-1751` spune „al DF-ului **aprobat**" — exact locul confuziei. | corect |
| a2 | `alop.mjs:1798` `ramas = bugetAnCurent − sumaOrdonantata` | idem | 🔇 poate deschide sau bloca greșit un ciclu | corect |
| a3 | `alop.mjs:434` (listă) + `:744` (detaliu) `df_buget_an_curent` | `sqlBugetAnExercitiu('df')` | 🔇 card „Buget exercițiu" pe draft | corect |
| a4 | `alop.mjs:435` + `:745` `credite_bugetare_an_curent` | `sqlCrediteBugetareCol10('df')` | 🔇 idem | corect |
| a5 | `alop.mjs:746` `ramas_an_curent` (`sqlRamasAnExercitiu`) | col.10 − ordonanțat | 🔇 „rămas de ordonanțat" pe draft | corect |
| a6 | `alop.mjs:432-433` + `:742-743` `df_valoare` | `SUM(rows_val.valt_actualiz)` | 🔇 **„195.000,00 lei DF actual"** din cazul de producție | corect |
| a7 | `alop.mjs:1036-1038` `alop.ramas = df_valoare − suma_platita` | derivat din a6 | 🔇 alimentează `can_start_noua_ordonantare` (`alop-capabilities.mjs:33`) ⇒ **butonul „Nouă ordonanțare" apare/dispare pe cifra unui draft** | corect |
| a8 | `admin/flows.mjs:104` `valoare_angajata_an` | `SUM(col.10)` peste `a.df_id` | 🔇 KPI admin pe drafturi | corect |
| a9 | `formular-shared.mjs:300` `computeOrdBudgetContext` — `WHERE a.df_id = df.id` | ciclurile arhivate ale ALOP-ului | 🔇 **cel mai urât**: `df` aici e `ord.df_id` (îngheţat pe revizia de la emitere). Când `alop.df_id` s-a mutat, JOIN-ul nu mai găsește ALOP-ul ⇒ `cicluri_arhivate = 0` ⇒ plafonul 422 ignoră tot ce s-a ordonanțat deja. **Clasa de bug de la #115.** | ⚠️ **NU se repară automat** — vezi R6 |

### (b) Navigare

| # | Sit | AZI | DUPĂ (A) |
|---|-----|-----|----------|
| b1 | `alop-capabilities.mjs:57-66` `df_action` | ramurile 'deschide'/'flow_waiting' duc la draft (util accidental) | 🔊 **cardul nu mai are cale către R(n+1)**; pentru ALOP `completed` `computeAlopCapabilities` iese la `:51` și `df_action` nici nu se calculează. **Trebuie rezolvat explicit în lotul de reparație.** |
| b2 | `alop.js:753` buton „Revizuiește DF" cu `a.df_id` | gated de `can_revise_df` | ar deschide revizia aprobată — corect, dar butonul dispare (b4) |
| b3 | `df.mjs:162-170` DF detaliu: `alop_id`/`alop_titlu`/`alop_valoare` prin `a.df_id = fd.id` | 🔇 **revizia APROBATĂ pierde contextul ALOP** în propriul detaliu; îl are doar draftul | corect |
| b4 | `alop-capabilities.mjs:39-42` `can_revise_df` (cere `df_aprobat===true`) | 🔊 **butonul dispare cât timp există un draft** — protecția reală de azi vine din `df_aprobat`, NU din `df_revizie_in_lucru` | butonul revine; garda corectă redevine `!df_revizie_in_lucru` (reînviată) |
| b5 | `trasabilitate.mjs:119-155` `df_valoare` per ALOP prin `a.df_id` | 🔇 cifra draftului în modalul Trasabilitate (cazul de producție) | corect |
| b6 | `alop.js:1019-1027` ORD nou: `o-df-sel.value = alop.df_id` | 🔊 draftul **nu e** în `/aprobate` ⇒ `select` rămâne gol, rândurile nu se auto-populează | corect (valoarea există în dropdown) |
| b7 | `alop.mjs:1351` notificare lichidare: `form_id: df_id` | 🔇 click-through spre draft | corect |
| b8 | `alop.mjs:573-580` raport facturi — `cod_angajament` din `t.df_id` | 🔇 cod din draft | corect |
| b9 | `opme.mjs:416`, `:579` `df_nr` în raport/CSV OPME | 🔇 nr. afișat din draft (cosmetic) | corect |

### (c) Stare / afișare

| # | Sit | AZI | DUPĂ (A) |
|---|-----|-----|----------|
| c1 | `alop.mjs:50` `SQL_ALOP_DF_FLOW = COALESCE(df.flow_id, a.df_flow_id)` | draftul are `flow_id=NULL` ȘI `a.df_flow_id=NULL` (șters de `/revizuieste`) ⇒ NULL | ⚠️ **WRINKLE CONFIRMAT**: `df.flow_id` = fluxul COMPLETAT al lui R(n), non-NULL ⇒ `COALESCE` se oprește acolo și **nu mai ajunge la `a.df_flow_id`** (fluxul reviziei) |
| c2 | `alop.mjs:52-58` `SQL_ALOP_FLUX_DF_ACTIV` | false | 🔊 fals cât timp R(n+1) e pe flux |
| c3 | `alop.mjs:60-63` `SQL_ALOP_DF_APROBAT` | false | true (corect, dar vezi c5) |
| c4 | `alop.mjs:65-73` `SQL_ALOP_DF_ARE_REVIZIE` + `SQL_ALOP_BADGE` | 🔊 badge-ul `revizie_flux` (#132b) nu se aprinde niciodată pentru o revizie în DRAFT; se cade pe `a.status` | 🔊 nu se aprinde nici pentru o revizie **pe flux** (c1) ⇒ **filtrul de status „Revizie pe flux" moare complet** |
| c5 | `alop.mjs:422-428` `df_flow_active` (listă) · `:728-733` (detaliu) | false | 🔊 fals și când R(n+1) e pe flux |
| c6 | `alop.mjs:429-431` / `:725-727` `df_aprobat` | false pe draft | true |
| c7 | `alop.js:663` ramura „🔄 Revizia N pe flux — în curs · ultima aprobată: N−1" | 🔊 gardată de `df_flow_active` ⇒ moartă pentru DRAFT; se cade pe `:664` „✅ DF aprobat · Revizia N" (**cazul de producție**) | 🔊 rămâne moartă din alt motiv (c1) dacă nu se derivă pe dosar |
| c8 | `alop.mjs:420` / `:718` `df_revizie_nr`, `alop.js:816` „DF activ: R{n}" | arată R(n+1) draft | ar arăta R(n) — **corect ca „în vigoare", dar userul pierde semnalul că există R(n+1)** ⇒ e nevoie de un câmp NOU (ex. `df_revizie_lucru_nr`) |
| c9 | `alop.mjs:755-761` `df_revizie_in_lucru` | 🔇 **cod mort, mereu FALSE** (R1) | **reînvie corect** ⇒ `df_action='in_lucru_disabled'` (`alop-capabilities.mjs:59`) și `can_revise_df` (`:42`) devin accesibile prima oară de la 2026-05-03 |

**⚠️ Cuantificare pentru wrinkle-ul c1:** expresia `COALESCE(df.flow_id, a.df_flow_id)` apare
în **6 situri, toate în `server/routes/alop.mjs`**: `:50` (constanta, folosită de `:54`, `:62`,
deci în badge → SELECT listă + WHERE listă + WHERE COUNT + SELECT detaliu), `:422`, `:428`,
`:431`, `:725`, `:728`, plus JOIN-ul `:766` (`f1`). Toate au nevoie de o derivare pe DOSAR
(„există o revizie a acestui dosar pe un flux activ?"), nu pe pointer. Frontend: **1 sit**,
`public/js/formular/alop.js:663`.

### (d) Integritate

| # | Sit | Comportament |
|---|-----|--------------|
| d1 | `alop-link.mjs:47-61` `selfHealAlopDfLink` | mută pointerul la aprobare. **Cheie: `fd.nr_unic_inreg`** (`:57`), NU `dosarKeyExpr` — vezi capcana din R3-C |
| d2 | `alop-link.mjs:113-148` `selfHealAlopDfLinkByAlop` (lazy, `alop.mjs:809-817`) | pornește **doar dacă `df_id IS NULL`** ⇒ nu poate corecta un pointer *greșit*, doar unul lipsă. **Nu va repara retroactiv nimic.** |
| d3 | `signing.mjs:139-205` refuz | R0 → păstrează `df_id`, curăță fluxul; R1+ → restaurează **părintele aprobat** (`:196-197`). **Deja implementează semantica dorită** — e singurul loc din cod care o are azi |
| d4 | `formular-shared.mjs:746-792` `relinkAlopOnDfDelete` | idem d3 la ștergere. Sub (A) ramura R1+ devine **no-op** (`WHERE df_id=$1` nu mai potrivește draftul) — inofensiv, dar de simplificat |
| d5 | `flow-link-audit.mjs:65-95` | detectează doar `df_id NULL`/`df_flow_id NULL` — **nu vede pointerul pe revizie greșită**. Candidat pentru o verificare nouă |
| d6 | `authz-formular.mjs:133-139` `getAlopP2UserIds` | citește `assigned_to` de pe `alop.df_id` ⇒ **azi autorizarea CAB se derivă din draft** 🔇 |
| d7 | `flow-provenance.mjs:43-48` `alopDocCol:'df_id'` | `checkFlowLinkable`/`checkFlowSigned` — sub (A), lansarea fluxului pentru R(n+1) trebuie să treacă pe ramura „proveniență" (`source_alop_id`), nu pe „directă". **De verificat la implementare** |
| d8 | `alop.mjs:1963-1975` cancel | `cancel_blocked_df_exists` — sub (A) raportează R(n), nu R(n+1). Cosmetic |
| d9 | `df.mjs:697` + `:707` | **cele două UPDATE-uri de eliminat** în varianta (A) |
| d10 | `alop.mjs:303` (listă) + `:680` (detaliu) — filtrul de vizibilitate `p2_compartiment`: `SELECT fd.assigned_to FROM formulare_df fd WHERE fd.id = a.df_id` | 🔇 **aceeași clasă ca d6, dar pe VIZIBILITATE, nu pe authz de scriere**: cine vede ALOP-ul în listă se derivă din `assigned_to` al DRAFTULUI. Dacă revizia a fost repartizată altui responsabil CAB, vechiul responsabil **pierde tăcut ALOP-ul din listă**. Sub (A): corect (revizia aprobată). **Lipsea din prompt și din prima redactare a acestui recon.** |
| d11 | `alop.mjs:859-881` — Self-heal #1 (v3.9.517), recuperare ORD orfan: `WHERE fo.df_id = $1` cu `$1 = alop.df_id` | 🔇 **cod mort de facto după orice revizie**: ORD-urile sunt îngheţate pe revizia APROBATĂ (R6), iar `alop.df_id` e draftul ⇒ predicatul nu potrivește niciodată ⇒ recuperarea orfanului **nu pornește**, fără niciun log. Sub (A) **reînvie** (pointerul redevine revizia pe care s-a emis ORD-ul). Al treilea mecanism care se repară „gratis" prin (A)/(B), și **NU** prin (C). |

**Rezumat clase de rupere AZI:** 13 situri 🔇 TĂCUTE (a1-a9, b3, b5, b7, b8, b9, c9, d6, d10, d11 —
toate afișează, *folosesc la decizii* sau *filtrează* pe baza unui draft) și 4 🔊 ZGOMOTOASE
(b6, c4, c7, b4). **Clasa tăcută domină** — exact profilul #115/#128l.

---

## R3 — Cele trei variante, cu costul real (⛔ fără recomandare)

### (A) Pointerul se mută doar la APROBARE

**Ce se atinge:** `df.mjs:696-711` (se scot 2 UPDATE-uri; fallback-ul `source_alop_id` trebuie
mutat, nu șters — el repară cazul „legătură deja ruptă", care rămâne real).

| Dimensiune | Cost |
|---|---|
| Situri financiare reparate | 9 (a1–a9), din care a9 **NU** (vezi R6) ⇒ **8** |
| Situri de afișare/badge de rescris | **6 expresii SQL** în `alop.mjs` (wrinkle c1) + **1** în `alop.js:663` |
| Navigare de rezolvat explicit | **b1** — pentru ALOP `completed`, `computeAlopCapabilities` iese la `:51`, deci `df_action` nu se calculează; **azi** utilizatorul ajunge la revizie prin „tab-ul DF"/lista DF, nu prin card. Fără un câmp nou (`df_revizie_lucru_id`/`_nr`) expus, **cardul nu are cale spre R(n+1)** |
| Migrație | **NU** |
| Reparare de date existente | **DA** (R5) — self-heal-ul lazy nu ajută (d2) |
| Logică moartă reactivată | `df_revizie_in_lucru` (`alop.mjs:755-761`) + ambele ramuri din `alop-capabilities.mjs:42`, `:59`; **plus Self-heal #1 ORD orfan (`alop.mjs:859-881`, d11)**, mort de facto azi pe orice dosar revizuit |
| Reparate în plus (tăcut, azi) | **d10** — vizibilitatea `p2_compartiment` revine pe responsabilul reviziei în vigoare; **d6** — authz CAB nu se mai derivă din draft |
| Teste de rescris | `alop-revizie-afisare.test.mjs` (cimentează explicit „ALOP completed + DF R1 pe flux" ⇒ `df_id`=revizia), `df-alop-link-resilienta.test.mjs:110-139`, `alop-df-relink-selfheal.test.mjs:34-64`, `alop-noua-lichidare-ciclu.test.mjs:115`, `alop-buget-an-curent.test.mjs:80`, `sterge-df-ord.test.mjs:56` |

⚠️ **Wrinkle verificat și confirmat:** `COALESCE(df.flow_id, a.df_flow_id)` (`alop.mjs:50`) se
oprește la fluxul COMPLETAT al lui R(n) ⇒ `df_flow_active=false` cât timp R(n+1) e pe flux ⇒
badge-ul `revizie_flux`/`angajare_flux` (#132b) și ramura de afișare `alop.js:663` mor. Derivarea
corectă e „EXISTS: o revizie din DOSAR are un flux activ", pe `dosarKeyExpr`, nu pe COALESCE.
⚠️ Al doilea efect: `SQL_ALOP_BADGE` e folosit **și în WHERE-ul de COUNT fără JOIN** (`alop.mjs:43-45`)
⇒ derivarea nouă trebuie să rămână **corelată pe `a.*`**, altfel COUNT-ul se rupe.

### (B) Coloană nouă `alop_instances.df_revizie_lucru_id`

| Dimensiune | Cost |
|---|---|
| Situri atinse | ca la (A) pentru partea financiară, **plus** întreținerea celui de-al doilea pointer în: `/revizuieste`, `signing.mjs` (aprobare/refuz), `relinkAlopOnDfDelete`, ambele self-heal-uri, `noua-lichidare` |
| Migrație | **DA** — `ADD COLUMN ... UUID`, fără backfill (NULL = nicio revizie în lucru), în linia deciziei #128b |
| Reparare de date | DA (aceeași ca A) + eventual populare a coloanei noi |
| Câștig propriu | rezolvă **b1** și **c8** *by design* (cardul are explicit „în vigoare" + „în lucru") |
| Contra | **al doilea pointer de ținut sincron** — aceeași clasă „adevăr dublu" respinsă la #128 (`orgId` coloană + JSONB, `df.flow_id` vs `alop.df_flow_id`). Nota din CLAUDE.md despre `data.flowId` e exact această lecție. Wrinkle-ul c1 **NU dispare** dacă badge-ul continuă să citească `COALESCE(df.flow_id,…)` |

### (C) Derivare în SQL (`dfa` = ultima revizie APROBATĂ din dosar)

| Dimensiune | Cost |
|---|---|
| Coloane care trec de la `df.` la `dfa.` | **listă** (`alop.mjs:432-437`): `df_valoare`, `df_buget_an_curent`, `credite_bugetare_an_curent`, `df_an_referinta`, `df_stingere` = **5**; **detaliu** (`:742-748`): aceleași 5 **+ `ramas_an_curent`** = **6**; plus `noua-lichidare` (`:1753-1757`), `sqlRamasAnExercitiu` (`:172-176`), `admin/flows.mjs:104`, `trasabilitate.mjs:126` și `:155` |
| Fișiere | **4**: `server/routes/alop.mjs`, `server/routes/admin/flows.mjs`, `server/services/trasabilitate.mjs`, `server/services/formular-shared.mjs` (doar dacă se atinge și a9) |
| Migrație | **NU** |
| Reparare de date | **NU** — se auto-repară pentru rândurile deja stricate (avantajul decisiv al variantei) |
| Logică moartă reactivată | **niciuna** — `df_revizie_in_lucru` rămâne mort (`df_id` continuă să fie copilul), deci `df_action='in_lucru_disabled'` și garda din `can_revise_df` rămân inaccesibile; **d11 (Self-heal #1 ORD orfan) rămâne și el mort** |
| Navigare / badge | **NEATINSE** — b1, b6, c1–c7 rămân exact ca azi (b6 rămâne 🔊 rupt) |
| d6 / d10 (authz + vizibilitate din draft) | **rămân amândouă** — `getAlopP2UserIds` și filtrul `p2_compartiment` (`alop.mjs:303`, `:680`) citesc tot `alop.df_id`. ⇒ (C) repară **doar** clasa financiară; clasele de authz/vizibilitate/integritate cer oricum atingerea pointerului sau situri separate |

⚠️ **CAPCANA CHEII DE DOSAR — confirmată, e reală:**
`server/services/df-dosar-key.mjs:33` definește `COALESCE(fd.source_alop_id::text, fd.nr_unic_inreg)`
și e importată în `df.mjs`, `formulare/shared.mjs`, `clasa8.mjs`, `trasabilitate.mjs`.
**`server/services/alop-link.mjs:57` NU o folosește** — cheie pe `fd.nr_unic_inreg` gol.
`0335cb6` (#126) a convertit 5 interogări, dar a sărit peste `alop-link.mjs`. Consecință: pe
dosarele cu numere duplicate din producție (documentate în `docs/incidents/DF-NR-DUPLICAT.md`),
self-heal-ul poate considera „aceeași serie" un DF din **alt dosar**. Varianta (C) TREBUIE să
folosească `dosarKeyExpr`; în variantele (A)/(B), `alop-link.mjs:57` trebuie aliniat oricum
(bug independent, de raportat separat — vezi R8).

⚠️ **Cost în plan de execuție (listă ALOP):** azi lista are `LEFT JOIN formulare_df df ON df.id = a.df_id`
(index `idx_alop_df_id`, `alop.mjs:466`) — lookup pe PK. `dfa` cere un `LEFT JOIN LATERAL` cu
`ORDER BY revizie_nr DESC LIMIT 1` filtrat pe cheia de dosar + flux completat, **per rând**, la
`LIMIT 50` (și până la 5000 în modul export `?all=1`, `alop.mjs:83`). Nu există index pe
`COALESCE(source_alop_id::text, nr_unic_inreg)` — ar fi nevoie de un index de expresie (adică,
în practică, **totuși o migrație**, contrar etichetei „zero migrație"). COUNT-ul rămâne neatins
(nu are joinuri).

---

## R4 — Definiția lui „aprobat"

**Cinci forme distincte în arbore:**

| # | Formă | Situri |
|---|-------|--------|
| 1 | **Coloana** `formulare_df.status='aprobat'` (scrisă lazy) | scriere: `crud.mjs:533`, `signing.mjs:452`, `alop-link.mjs:91`, `:155`; citire: `alop-capabilities.mjs:63` |
| 2 | **Derivat din flux, FĂRĂ gărzi** — `flow_id IS NOT NULL AND (status='completed' OR completed=true)` | `df.mjs:90-91`, `:131`, `:558` (garda din `/revizuieste`), `formulare/shared.mjs:532` (`_dfAprobat`), `alop.mjs:60-63` (`SQL_ALOP_DF_APROBAT`), `clasa8.mjs:103` |
| 3 | **Derivat + `f.deleted_at IS NULL`** | `df.mjs:154-155`, `:219`, `formulare/ord.mjs:141`, `:208` |
| 4 | **Derivat + `deleted_at` + NOT cancelled + NOT refused** (cea mai strictă) | `formular-shared.mjs:761-766` (`relinkAlopOnDfDelete`, v3.9.746), `signing.mjs:185`, `alop-link.mjs:122-126` |
| 5 | **Hibrid „derivat SAU coloană"** | `formular-capabilities.mjs:73`, `formular-shared.mjs:773`, `signing.mjs:193`, `formulare/shared.mjs:544` |

**Sunt echivalente?** NU:
- (1) vs (2): comentariul din `a772741` spune explicit că **pe calea de semnare cloud coloana
  rămâne `'completed'`** — de aceea (5) există. (1) singură e nesigură.
- (2) vs (3): un flux soft-șters încă „aprobă" în (2). #131/fix D a închis asta pe `df.mjs`, dar
  **`SQL_ALOP_DF_APROBAT` (`alop.mjs:60-63`) a rămas fără `fx.deleted_at IS NULL`**, deși
  `SQL_ALOP_FLUX_DF_ACTIV` de deasupra (`:56`) îl are. Divergență în ACELAȘI fișier, 3 linii distanță.
- (2)/(3) vs (4): un flux `refused` are `data.status='refused'`, deci nu trece nici prin (2) —
  gărzile suplimentare din (4) sunt defensive, nu semantice.

**Formularea unică propusă** (fragment SQL exportat, în linia lui `liveFlowSql` din
`flow-provenance.mjs:35-39`):

```
dfAprobatSql(fd, f) =
  fd.flow_id IS NOT NULL
  AND f.deleted_at IS NULL
  AND f.data->>'status' IS DISTINCT FROM 'cancelled'
  AND f.data->>'status' IS DISTINCT FROM 'refused'
  AND (f.data->>'status' = 'completed' OR (f.data->>'completed')::boolean = true)
```

= forma (4), cea deja folosită pe căile care iau **decizii de relink** (d3, d4, d1). Coloana
`status='aprobat'` rămâne **cache de afișare**, niciodată sursă unică. Varianta (C) depinde
direct de asta: `dfa` = „ultima revizie din dosar care satisface `dfAprobatSql`".

---

## R5 — Datele din producție

⛔ **`DIAGNOSTIC-134-alop-revizie-in-vigoare.sql` NU EXISTĂ** — nici în rădăcina repo, nici
altundeva (`find . -name "DIAGNOSTIC-134*"` → gol; `git status` listează doar cele patru
`.sql` mutate în `docs/audits/`). Nu am putut valida interogări pe care nu le am. Zero
conectare la producție (respectat).

În locul lor, interogările de mai jos sunt **verificate contra schemei reale**
(`server/db/migrations/014_alop.sql`, migrațiile inline 055–095 din `server/db/index.mjs`).
Toate coloanele citate există: `alop_instances(df_id, df_flow_id, df_completed_at, status,
cancelled_at, org_id, ord_id)`, `formulare_df(revizie_nr, parent_df_id, source_alop_id,
nr_unic_inreg, status, flow_id, deleted_at, rows_ctrl, rows_val, an_referinta)`,
`alop_ord_cicluri(alop_id, ord_id, an_exercitiu, plata_data)`.

```sql
-- Q1. Câte ALOP-uri pointează AZI la un DF care NU e aprobat (definiția R4/forma 4)?
SELECT a.status AS alop_status, fd.status AS df_status, fd.revizie_nr, COUNT(*) AS n
  FROM alop_instances a
  JOIN formulare_df fd ON fd.id = a.df_id AND fd.deleted_at IS NULL
  LEFT JOIN flows f ON f.id = fd.flow_id
 WHERE a.cancelled_at IS NULL
   AND NOT (fd.flow_id IS NOT NULL AND f.deleted_at IS NULL
            AND f.data->>'status' IS DISTINCT FROM 'cancelled'
            AND f.data->>'status' IS DISTINCT FROM 'refused'
            AND (f.data->>'status' = 'completed' OR (f.data->>'completed')::boolean = true))
 GROUP BY 1,2,3 ORDER BY n DESC;

-- Q2. Dintre ele, care au un ANTECESOR aprobat în dosar (candidate la reparație)?
--     Cheia de dosar = df-dosar-key.mjs (source_alop_id, fallback nr_unic_inreg).
WITH cur AS (
  SELECT a.id AS alop_id, a.status AS alop_status, fd.id AS df_id, fd.revizie_nr,
         COALESCE(fd.source_alop_id::text, fd.nr_unic_inreg) AS dosar, fd.org_id
    FROM alop_instances a
    JOIN formulare_df fd ON fd.id = a.df_id AND fd.deleted_at IS NULL
    LEFT JOIN flows f ON f.id = fd.flow_id
   WHERE a.cancelled_at IS NULL
     AND NOT (fd.flow_id IS NOT NULL AND f.deleted_at IS NULL
              AND (f.data->>'status' = 'completed' OR (f.data->>'completed')::boolean = true))
)
SELECT c.alop_id, c.alop_status, c.df_id AS df_curent, c.revizie_nr AS rev_curenta,
       ap.id AS df_in_vigoare, ap.revizie_nr AS rev_in_vigoare
  FROM cur c
  LEFT JOIN LATERAL (
    SELECT fd2.id, fd2.revizie_nr
      FROM formulare_df fd2
      JOIN flows f2 ON f2.id = fd2.flow_id
     WHERE COALESCE(fd2.source_alop_id::text, fd2.nr_unic_inreg) = c.dosar
       AND fd2.org_id = c.org_id AND fd2.deleted_at IS NULL AND f2.deleted_at IS NULL
       AND (f2.data->>'status' = 'completed' OR (f2.data->>'completed')::boolean = true)
       AND fd2.revizie_nr < c.revizie_nr
     ORDER BY fd2.revizie_nr DESC LIMIT 1
  ) ap ON true
 ORDER BY c.alop_status, c.rev_curenta DESC;

-- Q3. IMPACT FINANCIAR: câte dintre ele au deja cicluri arhivate (a9 → plafon sub-numărat)?
SELECT COUNT(DISTINCT c.alop_id) AS alopuri_cu_cicluri
  FROM alop_ord_cicluri c
  JOIN alop_instances a ON a.id = c.alop_id AND a.cancelled_at IS NULL
  JOIN formulare_ord fo ON fo.id = a.ord_id
 WHERE fo.df_id IS DISTINCT FROM a.df_id;   -- ORD înghețat ≠ pointer ALOP

-- Q4. Divergența de cheie (R3-C / R8): dosare unde nr_unic_inreg e partajat.
SELECT nr_unic_inreg, COUNT(DISTINCT COALESCE(source_alop_id::text, nr_unic_inreg)) AS dosare
  FROM formulare_df WHERE deleted_at IS NULL AND TRIM(COALESCE(nr_unic_inreg,'')) <> ''
 GROUP BY 1 HAVING COUNT(DISTINCT COALESCE(source_alop_id::text, nr_unic_inreg)) > 1;
```

**Reparația retroactivă — natura ei:** **script one-off de mentenanță, NU migrație.**
Motive: (1) e o corecție de DATE de tenant, nu de schemă; (2) trebuie rulată **după** deploy-ul
codului nou, altfel codul vechi (`/revizuieste`) o strică din nou la prima revizie; (3) trebuie
să fie dry-run-abilă și reversibilă (raport before/after), ceea ce sistemul de migrări
inline — o singură tranzacție la boot, fără raport — nu permite. Precedent în arbore:
`tools/backfill-formular-flow-attachments.mjs` (idempotent, ADD-ONLY, marcat explicit
„maintenance, NU migrare"). ⚠️ Reparația **NU** trebuie să atingă `formulare_ord.df_id` (R6).

⚠️ **Variantele (A) și (B) au nevoie de reparație de date. Varianta (C) nu.** Dacă Q1/Q2 întorc
multe rânduri pe ALOP-uri `completed` cu cicluri (Q3 > 0), ponderea se mută spre (C).

---

## R6 — Ce se întâmplă cu ORD-ul deja emis

**`formulare_ord.df_id` este ÎNGHEȚAT azi și trebuie să rămână așa.** Dovezi:
`/revizuieste` (`df.mjs:696-711`) atinge **exclusiv** `alop_instances` — nicio cale nu
rescrie `formulare_ord.df_id`; el se setează la creare/PUT din body (`ord.mjs:317`, `:399`,
`:470`), iar frontend-ul îl alege din dropdown-ul `/aprobate` (`alop.js:1019-1027`).

| Consumator | Sub relegarea eager (azi) | Sub (A)/(B) | Sub (C) |
|---|---|---|---|
| `computeOrdBudgetContext({dfId: ordDoc.df_id})` (`formular-shared.mjs:284-316`) | plafonul se ia din DF-ul îngheţat = **corect**; DAR subinterogarea de cicluri filtrează `WHERE a.df_id = df.id` (`:300`) ⇒ când `alop.df_id` s-a mutat, **`cicluri_arhivate = 0`** 🔇 | se repară **doar** dacă ORD-ul a fost emis pe revizia care redevine `a.df_id`; **nu automat** | idem — `a.df_id` nu se schimbă ⇒ **rămâne rupt** |
| `validateOrdCol5` (`formular-shared.mjs:~240-255`) | pur pe `data.rows` — neafectat | neafectat | neafectat |
| `deriveOrdIdentityCols(rows, ctrl)` (`formular-shared.mjs:76`, apelat `ord.mjs:259`, `:409`) | `ctrl` vine din `ord.df_id` (îngheţat) ⇒ corelarea pozițională cu `rows_ctrl` rămâne **stabilă**. Dacă ar urma pointerul ALOP, o revizie care schimbă ordinea rândurilor SecB ar **rescrie tăcut codurile de angajament pe un ORD deja semnat** — inclusiv cheia de match OPME | neafectat | neafectat |
| `alop_ord_cicluri` | `an_exercitiu` + `ord_id`; DF-ul se recuperează prin `ord_id → formulare_ord.df_id`. Ciclurile nu stochează `df_id` ⇒ neafectate direct | neafectate | neafectate |

**Concluzie R6, explicită:** `formulare_ord.df_id` **TREBUIE să rămână înghețat** pe revizia de
la momentul emiterii, și **azi rămâne**. Problema NU e înghețul, ci că
`computeOrdBudgetContext:300` corelează ciclurile prin `a.df_id = df.id`, adică prin **pointerul
mobil**, când ar trebui să le coreleze prin **ALOP** (`a.id`) sau prin **dosar**. **Acesta e un
bug de sine stătător, independent de variantă** — merită lotul lui, cu prioritate ≥ restul.

---

## R7 — Decupajul propus

| Lot | Conținut | Migrație | Independent? | Vizibil pentru user? |
|---|---|---|---|---|
| **#134b** | **Fix a9/R6:** `computeOrdBudgetContext` corelează ciclurile prin ALOP, nu prin `a.df_id = df.id`. Test DB de caracterizare **întâi** (plafon cu cicluri arhivate + pointer mutat). | NU | **DA** — nu depinde de alegerea A/B/C | Da (422 corect la depășire) |
| **#134c** | **Fix cheie dosar:** `alop-link.mjs:57` trece de la `nr_unic_inreg` la `dosarKeyExpr` (finalizează #126). Test pe dosare cu număr partajat. | NU | **DA** | Nu (rar) |
| **#134d** | **R4:** `dfAprobatSql()` exportat + aliniat pe toate siturile derivate (min.: `alop.mjs:60-63` primește `deleted_at`). Pur read-only. | NU | **DA** | Nu |
| **#134e** | **Decizia owner A / B / C** + implementarea. Include derivarea „revizie a dosarului pe flux activ" pentru wrinkle-ul c1 (6 expresii `alop.mjs` + `alop.js:663`) și, pentru (A)/(B), **calea de navigare spre R(n+1) din card** (b1). | (B) DA; (A)/(C) NU* | depinde de b/c/d | **DA — primul lot care schimbă vizibil comportamentul** |
| **#134f** | **Reparare date existente** — doar dacă R5/Q1–Q2 arată rânduri ȘI se alege (A) sau (B). `tools/repair-alop-df-pointer.mjs`, dry-run implicit, raport before/after, rulat **după** deploy-ul lui #134e. | NU (script) | NU — după #134e | Da (cifrele se corectează) |
| **#134g** | `flow-link-audit.mjs`: verificare nouă „ALOP pointează la o revizie neaprobată deși dosarul are una aprobată" (d5) — plasă permanentă. | NU | după #134e | Nu (admin) |

\* varianta (C) devine „DA, migrație" dacă profilul de execuție cere index de expresie pe cheia de dosar.

**Ordinea recomandată:** #134b → #134c → #134d (toate trei sunt câștig net, independent de
decizia mare) → decizia owner → #134e → #134f → #134g.

---

## R8 — Ce NU am putut stabili · unde codul a contrazis faptele declarate

### Nu am putut stabili

1. **Datele reale din producție (R5).** `DIAGNOSTIC-134-alop-revizie-in-vigoare.sql` nu există
   în repo. Nu știu câte ALOP-uri sunt afectate ⇒ **nu pot cuantifica costul lotului #134f** și
   nu pot spune dacă ponderea înclină spre (C).
2. **Costul real în plan de execuție al variantei (C)** — nu am rulat `EXPLAIN` (ar cere DB).
   Afirmația despre indexul de expresie e o deducție din schemă (`idx_alop_df_id` există,
   index pe `COALESCE(source_alop_id::text, nr_unic_inreg)` nu apare în migrații), nu o măsurătoare.
3. **Dacă `checkFlowLinkable`/`checkFlowSigned` (d7) rup lansarea fluxului pentru R(n+1)
   sub varianta (A)** — logica de proveniență e ramificată (directă vs `source_alop_id`) și
   n-am putut-o epuiza fără să rulez cazul. **De verificat obligatoriu la implementare.**
4. **Dacă vreun ORD din producție are `df_id` NULL** (ar face plafonul să se sară complet —
   `validateOrdBugetAnCurent:321`). Ține de R5.

### Unde codul a contrazis faptele declarate în prompt

1. **„Relegarea eager a fost adăugată ulterior, ca să repare «ALOP arată Fără DF»" — FALS.**
   A intrat odată cu sistemul de revizii (`4bbc6d5`, 2026-04-11). Bug-ul „Fără DF" a fost
   reparat separat, prin `77821bb` (2026-06-12) + `a772741`. Vezi R1.
2. **„`df_revizie_in_lucru` a fost scris sub premisa opusă" — parțial fals.** La introducere
   (`e261022`) predicatul era `nr_unic_inreg`, nu `parent_df_id`, și sub relegarea eager era
   **always-TRUE** (se potrivea pe copilul însuși). L-a omorât „Fix 5" din `33febe0`
   (2026-05-03), care l-a schimbat în `parent_df_id = df.id`. Deci nu „scris greșit", ci
   **„reparat greșit"**.
3. **Numerele de linie din prompt nu corespund arborelui actual:** `public/js/formular/alop.js:584`
   → **`:663`**; `alop.js:803` („din DF aprobat") → **`:882`**.
4. **Protecția reală de azi împotriva reviziilor paralele NU e `df_revizie_in_lucru`** (mort),
   **ci `df_aprobat===true`** din `alop-capabilities.mjs:41`, care devine `false` fiindcă
   pointerul e pe draft. Adică: relegarea eager blochează accidental butonul „Revizuiește DF",
   iar reparația îl **deblochează** — trebuie ca `df_revizie_in_lucru` să reînvie în același lot,
   altfel se deschid revizii paralele. **Cuplaj neevident, nemenționat în prompt.**
5. **`selfHealAlopDfLink` (`alop-link.mjs:57`) cheie pe `nr_unic_inreg`, NU pe `dosarKeyExpr`** —
   #126 (`0335cb6`) a convertit 5 interogări și a sărit peste această. Bug independent, real pe
   datele de producție cu numere partajate. → lot #134c.
6. **`SQL_ALOP_DF_APROBAT` (`alop.mjs:60-63`) nu are `fx.deleted_at IS NULL`**, deși
   `SQL_ALOP_FLUX_DF_ACTIV` (`:56`), 4 linii mai sus, îl are. Un flux soft-șters încă „aprobă"
   în badge. Divergență în același bloc. → lot #134d.
7. **Bug NOU, mai grav decât cel raportat:** `computeOrdBudgetContext` (`formular-shared.mjs:300`)
   corelează ciclurile arhivate prin `a.df_id = df.id`. Pointerul mutat ⇒ `cicluri_arhivate = 0`
   ⇒ plafonul 422 **ignoră tot ce s-a ordonanțat deja**. Nu e reparat de niciuna dintre cele trei
   variante și nu figura în prompt. → lot #134b, prioritate maximă.
8. **`getAlopP2UserIds` (`authz-formular.mjs:133-139`)** derivă responsabilul P2 din
   `alop.df_id` ⇒ **azi autorizarea CAB se citește de pe un draft**. Nu figura în prompt.
9. **Filtrul de VIZIBILITATE `p2_compartiment` (`alop.mjs:303` listă + `:680` detaliu)** citește
   tot `fd.assigned_to` de pe `a.df_id` (d10). Nu figura nici în prompt, nici în prima redactare
   a acestui recon. Efect: după o revizie repartizată altui responsabil CAB, **vechiul responsabil
   pierde tăcut ALOP-ul din listă**. Aceeași clasă cu (8), dar pe citire, deci și mai greu de observat.
10. **Self-heal #1 „ORD orfan" (`alop.mjs:859-881`, v3.9.517) e cod mort de facto** pe orice dosar
    revizuit (d11): caută `formulare_ord WHERE fo.df_id = alop.df_id`, dar ORD-urile sunt îngheţate
    pe revizia aprobată (R6), iar `alop.df_id` e draftul ⇒ zero candidați, fără log. **Al treilea
    mecanism omorât de relegarea eager**, după `df_revizie_in_lucru` și corelarea ciclurilor (7).
    Se repară gratis prin (A)/(B); **NU** prin (C).

### Notă de metodă — re-verificare independentă

Afirmațiile portante ale acestui recon au fost re-verificate a doua oară direct pe arbore, nu
preluate din prima redactare. Confirmate literal: `4bbc6d5` (2026-04-11 18:46) ca origine reală
a relegării eager (via `git log -S` pe fișierul VECHI `formulare-db.mjs`); `e261022` cu predicat
`nr_unic_inreg`; `33febe0` „Fix 5" (2026-05-03 16:07) care îl schimbă în `parent_df_id = df.id`
— mesajul commit-ului spune explicit „elimina matches false pe documente cu același număr din
alte ALOP-uri", deci a reparat un simptom REAL (numere partajate, #126/DF-NR-DUPLICAT) omorând
garda; `df.mjs:695-711`; `alop.mjs:755-761`; `formular-shared.mjs:300`; `alop-link.mjs:57`;
`authz-formular.mjs:133-139`; lipsa lui `deleted_at` din `SQL_ALOP_DF_APROBAT` (`alop.mjs:60-63`);
`alop.js:663` și `:882`.

**Corecție minoră de numărătoare (c1):** expresia literală `COALESCE(df.flow_id, a.df_flow_id)`
apare de **6 ori** în `alop.mjs` — `:422`, `:428`, `:431` (listă) și `:725`, `:728`, `:733`
(detaliu) — **plus** forma corelată centralizată `SQL_ALOP_DF_FLOW` (`:50`), consumată de
`SQL_ALOP_FLUX_DF_ACTIV` (`:54`) și `SQL_ALOP_DF_APROBAT` (`:62`), care ajung mai departe în
`SQL_ALOP_BADGE` (`:68`, `:70`) → `:382` (WHERE filtru), `:463` (SELECT listă), `:739` (SELECT
detaliu). Prima redactare enumera `:50` în locul lui `:733`. **Totalul de rescris rămâne 6
expresii literale + 1 constantă**, deci cifra din R3-(A) nu se schimbă.

### Consemnat, nereparat (per instrucțiune)

Nimic nu a fost modificat în cod. Cele 6 abateri reparabile „din mers" (5, 6, 7, 8, 9, 10) sunt
încadrate astfel: (7) → **#134b**; (5) → **#134c**; (6) → **#134d**; (8), (9), (10) → se rezolvă
odată cu decizia din **#134e**, dar NUMAI dacă aceasta e (A) sau (B) — sub (C) rămân deschise și
au nevoie de un lot propriu.

---

## Verificare

```
$ git status --short
?? docs/audits/ALOP-134-RECON-REVIZIE-2026-08.md    ← singurul fișier nou al acestui recon
$ git diff --stat
(gol)
```

---

## R4-bis — stare după #134d

`server/services/df-aprobat-sql.mjs` (nou) exportă forma STRICTĂ (4) de „DF aprobat" —
`dfAprobatSql(fd,f)` (necorelată, cu JOIN flows explicit) și `dfAprobatExistsSql(flowExpr,fx)`
(EXISTS corelat, pentru interogări fără JOIN pe flows). Divergența dovedită în R4 —
`SQL_ALOP_DF_APROBAT` din `alop.mjs` fără gărzile `deleted_at IS NULL` / `!= 'cancelled'` /
`!= 'refused'` pe care fratele ei `SQL_ALOP_FLUX_DF_ACTIV` le avea deja — e reparată: constanta
e acum `dfAprobatExistsSql(SQL_ALOP_DF_FLOW)`.

**Trecute pe helper (formă 4 deja, refactor pur, zero schimbare de comportament):**
- `server/routes/alop.mjs` → `SQL_ALOP_DF_APROBAT`
- `server/services/formular-shared.mjs` → `relinkAlopOnDfDelete`
- `server/routes/flows/signing.mjs` → situl de refuz DF (restore la parent aprobat)
- `server/services/alop-link.mjs` → `selfHealAlopDfLinkByAlop` (interogarea de candidați)

**Rămase deliberat pe formele 2/3/5 — NU atinse în acest lot:**
- `alop.mjs:428-431` și `alop.mjs:724-727` — câmpul JSON `df_aprobat` expus în răspunsurile
  listă/detaliu ALOP (formă **2**, fără nicio gardă). E o expresie SEPARATĂ de
  `SQL_ALOP_DF_APROBAT` (nu o consumă și nu e consumată de ea) — deci e în afara scopului
  „migrează siturile care folosesc DEJA forma 4" din #134d. Trecerea ei pe forma 4 ar fi o
  ÎNĂSPRIRE de comportament (un flux DF soft-șters/anulat/refuzat ar înceta să mai afișeze
  `df_aprobat:true` în UI) și cere caracterizare proprie — vezi R4 pentru inventarul complet.
- `df.mjs`, `formulare/shared.mjs`, `formulare/ord.mjs`, `clasa8.mjs`,
  `formular-capabilities.mjs` — folosesc formele 2/3/5, neschimbate per scopul îngust al #134d
  (constrângere explicită din prompt).

**Descoperire colaterală (nereparată, consemnată):** analiza logică arată că, ÎN CONTEXTUL
actual al `SQL_ALOP_BADGE`, divergența din `SQL_ALOP_DF_APROBAT` era inertă pentru
`badge_status` — clauza unde apare (`NOT (SQL_ALOP_DF_APROBAT)`) e mereu evaluată doar alături
de `SQL_ALOP_FLUX_DF_ACTIV = true`, care deja exclude flux șters/anulat/refuzat prin propriile
gărzi, deci `APROBAT` era deja garantat `false` acolo indiferent de gărzile lipsă. Divergența
rămâne REALĂ și reparabilă corect (dovedită direct pe expresia izolată, vezi raportul #134d),
dar nu avea, până acum, un simptom observabil prin `badge_status`. Asta o face totuși corectă
de reparat — o refolosire viitoare a `SQL_ALOP_DF_APROBAT` în afara acelui context (plan posibil
la #134e) ar fi moștenit bug-ul tăcut.

---

## R5-bis — backfill `source_alop_id` (#134g)

### De ce — blocajul d7

Reconul #134e (Etapa 6, d7) a stabilit că sub varianta **(A)** — pointerul `alop_instances.df_id`
rămâne pe revizia **în vigoare** — lansarea unui flux pentru R(n+1) e **REFUZATĂ**:
`checkFlowLinkable` → `403 flux_alt_document`, `checkFlowSigned` → `409 document_nesemnat`.
`claimsAlopDocument` are două căi și niciuna nu se mai potrivește: cea directă
(`meta.dfId === alop.df_id`) și cea „cloud fără DF" (gardată de `alopDocId == null`).

Reparația (#134f) generalizează a doua cale la „documentul aparține **DOSARULUI** ALOP-ului",
pe predicatul `sqlFdInDosar` livrat la #134e. Dar acel predicat are o **ramură LEGACY** pentru
DF-urile cu `source_alop_id IS NULL`, care cheiază pe `org_id + nr_unic_inreg` — exact vectorul
de coliziune din `docs/incidents/DF-NR-DUPLICAT.md`. Ca poartă de **AFIȘARE** e acceptabilă; ca
poartă de **SECURITATE** pentru lansarea unui flux, **NU**.

**Decizia owner-ului: nu slăbim poarta — eliminăm cazul legacy.** #134g propagă
`source_alop_id` pe lanțurile de revizii DEJA legate de un ALOP, ca #134f să poată cheia strict
pe `source_alop_id = alop.id`, fără niciun fallback.

### Ce scrie

`tools/backfill-df-source-alop.mjs` — **script one-off de mentenanță, NU migrație**, cu
**dry-run implicit**. Scrie o singură coloană:

```sql
UPDATE formulare_df SET source_alop_id = <alop.id>, updated_at = NOW()
 WHERE id = ANY(<membrii lanțului>) AND source_alop_id IS NULL AND deleted_at IS NULL
```

- **Candidați:** `alop_instances` cu `df_id IS NOT NULL`, `cancelled_at IS NULL`, al căror DF
  pointat (nesters) are `source_alop_id IS NULL`.
- **Lanțul:** CTE recursiv pe muchiile `parent_df_id`, traversate **NEORIENTAT** (strămoși ȘI
  descendenți), `deleted_at IS NULL`, cu calea vizitată păstrată în `path` (protecție anti-ciclu)
  și plafon de adâncime 200. ⛔ **Niciodată prin `nr_unic_inreg`** — acela e chiar vectorul de
  coliziune pe care lotul îl elimină.
- 🔒 **ALL-OR-NOTHING pe lanț:** o tranzacție per lanț (`BEGIN`/`COMMIT`), cu verificare de
  `rowCount` == numărul de membri cu `source_alop_id NULL`; orice nepotrivire ⇒ `ROLLBACK` +
  raport. Un lanț scris parțial ar rupe `has_newer_revision` și `/revizuieste` („Această revizie
  nu mai este cea curentă" pe viață) — starea artificială de la #134c.
- **Idempotent:** a doua rulare cu `--apply` raportează zero scrieri (candidații dispar).
- ⛔ **NU** mută `alop_instances.df_id` — aceea e #134h, care rulează **după** #134f.

### Cele patru porți de skip (+ a cincea, pentru date corupte)

Fiecare sare **LANȚUL ÎNTREG** și se raportează **nominal, cu id-uri concrete**:

| Poartă | Condiție |
|---|---|
| **S1** revendicat de altcineva | vreun membru are `source_alop_id` non-NULL diferit de `alop.id` |
| **S2** ambiguu | două ALOP-uri necancelate pointează în același lanț (verificare NEfiltrată pe `--org`) |
| **S3** coliziune de revizie | două rânduri active din lanț au același `revizie_nr` — ar viola `df_source_alop_revizie_uniq` (migrația 095); acoperă și `revizie_nr` deja ocupat pe acel ALOP de rânduri din **afara** lanțului |
| **S4** org diferit | vreun membru are alt `org_id` decât ALOP-ul |
| **CICLU** | buclă în `parent_df_id` (sau adâncime ≥ 200) — lanț neinterpretabil; scriptul îl sare și **continuă** cu restul |

### Efectul secundar, dovedit — `source_alop_id` ESTE cheia de dosar

`dosarKeyExpr = COALESCE(fd.source_alop_id::text, fd.nr_unic_inreg)` (#126). Scriind coloana,
se **schimbă cheia** pentru acele DF-uri. Consumatori reali: `/aprobate` (`DISTINCT ON`),
`has_newer_revision`, `nr_partajat`, `/revizii`, `trasabilitate.mjs`, `clasa8.mjs`,
`/revizuieste`.

- **Lanț cu număr UNIC ⇒ zero regresie** (aceeași partiție, alt nume) — dovedit pe răspunsul
  HTTP în `server/tests/db/backfill-df-source-alop.test.mjs` (B7).
- **Lanțuri care ÎMPART un număr ⇒ se SEPARĂ** — adică se repară exact bug-ul atacat de #126.
  Contaminarea a fost **reprodusă pe fixture-ul nemodificat** (B8): înainte de backfill, R0-ul
  dosarului B primea `has_newer_revision=true` / `latest_revizie_nr=1` de la R1-ul dosarului A,
  `/revizii` pe B întorcea și cele două documente ale dosarului A, `/aprobate` pierdea B0 din
  dropdown-ul ORD, iar badge-ul `nr_partajat` era **false** (avertizarea nu se aprindea, fiindcă
  ambele dosare aveau aceeași cheie). După backfill: `has_newer_revision=false`,
  `/revizii` = doar B0, B0 revine în `/aprobate`, `nr_partajat=true` pe toate trei.

### Instrucțiune de rulare (Mircea)

⚠️ Scriptul **nu** a fost rulat pe nicio bază reală de către agent. Ordinea obligatorie:

1. **Backup întâi** — snapshot de volum Railway (plus, dacă e la îndemână, `pg_dump` local).
   Scriptul e ADD-ONLY pe o singură coloană, dar schimbă o cheie de grupare: fără backup nu
   există cale de întoarcere.
2. **Dry-run** (implicit, nu scrie nimic) — citește raportul integral, în special secțiunea
   `SĂRITE`:
   ```bash
   node tools/backfill-df-source-alop.mjs
   ```
   Opțional, gradual pe o singură organizație: `node tools/backfill-df-source-alop.mjs --org=<int>`.
   ⚠️ `--org=` primește un **INTEGER** (`organizations.id`), nu un UUID.
3. **Apply:**
   ```bash
   node tools/backfill-df-source-alop.mjs --apply
   ```
4. **Dry-run din nou** — confirmarea idempotenței: trebuie să raporteze **0 lanțuri examinate,
   0 scrieri**.

Fiecare lanț sărit apare cu ALOP-ul, DF-ul de pornire, membrii și motivul — investigabil
individual, fără interogări suplimentare.
