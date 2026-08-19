---
prompt: 126 (v2 — Etapa A REscrisă după analiza datelor din producție)
titlu: Lanțul de revizii DF cheiat pe dosarul ALOP (nu pe număr) · gardă la schimbarea numărului + avertisment în listă · confirmarea plății doar pentru CAB · OPME cu 4 criterii (+IBAN)
model_suggested: Opus 4.8
branch: develop
migratii: NU
---

# ⚠️⚠️ BRANCH: `develop` — EXCLUSIV ⚠️⚠️
Pasul final OBLIGATORIU: `git push origin develop`. NICIODATĂ pe `main`.
```
git fetch origin && git status && git log --oneline --graph --all -6
```
⛔ Citește versiunea din `package.json` ACUM și bump patch de la ea. Nu presupune (dacă #125 a intrat, e 3.9.754; dacă nu, 3.9.753).

⛔ ZONĂ NO-TOUCH: `server/signing/providers/STSCloudProvider.mjs`, `server/routes/flows/cloud-signing.mjs`, `bulk-signing.mjs`, `pades.mjs`, `java-pades-client.mjs`. (Dacă #125 e nemergeuit, atenție la conflicte pe primele două — nu le atinge.)

Trei etape INDEPENDENTE. Dacă una se blochează, celelalte merg înainte.

===============================================================================
# ETAPA A — lanțul de revizii se cheie pe DOSARUL ALOP, nu pe număr
===============================================================================

## Ce arată producția (7 documente, 3 coliziuni, verificate în DB)
| nr | doc A | doc B | doc C |
|---|---|---|---|
| 40339 „Anunt ziar Național" | 5/5 semnat, ALOP *ordonantare* | 3/4 semnat, ALOP *angajare* | — |
| 42320 „Contravaloarea Serviciilor…" | 1/5, flux **anulat** | 5/5 semnat, ALOP *angajare* | — |
| 6736 „Servicii Spatii Verzi" | 1/5, flux **refuzat** | 5/5 semnat, ALOP *ordonantare* | 4/5 semnat, ALOP *angajare* |

`source_alop_id` e DIFERIT la toate ⇒ dosare ALOP independente (dedup-ul de la migrarea 095 n-a ratat nimic). Tiparul: utilizatorii deschid un dosar NOU pentru o cheltuială următoare pe același obiect și refolosesc numărul din registratură. **Calea corectă, confirmată de Mircea: o REVIZIE (R1) a DF-ului existent.**

⛔ Curățarea completă a datelor e IMPOSIBILĂ: la 40339 și 6736 câte două documente au semnături aplicate (au ieșit din aplicație — PDF semnat, posibil la trezorerie). ⇒ **niciun index unic pe număr, niciodată.** Nu propune unul.

## Ideea fixului
Identitatea lanțului de revizii e DEJA dosarul ALOP, la nivel de constrângere:
- indexul unic `df_source_alop_revizie_uniq (source_alop_id, revizie_nr)` există din migrarea 095 (`server/db/index.mjs:2136`);
- `/revizuieste` copiază `source_alop_id` în revizia nouă (`df.mjs:594`) și leagă `parent_df_id`.

Dar **cinci interogări** cheie încă pe `nr_unic_inreg`, inconsecvent cu propriul index. Le mutăm pe toate pe dosar. După fix, un număr duplicat devine **confuz, nu corupător**.

## ⚠️ Expresia de cheie — o folosești IDENTIC în toate cele cinci locuri
```sql
COALESCE(fd.source_alop_id::text, fd.nr_unic_inreg)
```
- DF-uri cu dosar ⇒ grupare pe dosar (corect);
- DF-uri LEGACY fără `source_alop_id` ⇒ cad înapoi pe număr, adică EXACT comportamentul de azi (retrocompatibil).
- ⛔ NU folosi `COALESCE(source_alop_id::text, id::text)` — ar rupe lanțurile legacy de revizii (fiecare revizie ar deveni un lanț separat).
- ⛔ La `DISTINCT ON`, primul termen din `ORDER BY` trebuie să fie EXACT aceeași expresie, altfel Postgres dă eroare.
Definește-o o singură dată ca fragment SQL reutilizat (constantă în modul) ca să nu divergă între cele cinci locuri.

## Pas A1 — `/revizuieste`: MAX(revizie_nr) pe dosar (`df.mjs:522-526`)
`WHERE nr_unic_inreg=$1 AND org_id=$2` → cheia pe dosar. **Ăsta e fixul care deblochează revizuirea**: azi, după ce un dosar ajunge la R1, celălalt primește „Această revizie (R0) nu mai este cea curentă" pe viață. ⛔ Garda „doar revizia cea mai recentă poate fi revizuită" RĂMÂNE — se aplică doar în interiorul dosarului.

## Pas A2 — `/api/formulare-df/aprobate`: `DISTINCT ON` pe dosar (`df.mjs:107-116`)
🔴 **Cel mai urgent din etapă.** E dropdown-ul din care se alege DF-ul la crearea unui ORD. Azi, două DF-uri aprobate cu același număr ⇒ unul DISPARE din listă și nu se mai poate face ORD pe el. În producție nu mușcă încă doar fiindcă al doilea DF de la 40339 e la 3/4 semnături — se declanșează singur când termină.

## Pas A3 — lista DF: `latest_revizie_nr` + `has_newer_revision` pe dosar (`df.mjs:155-166`)
Azi un document e marcat „are revizie mai nouă" din cauza unui dosar STRĂIN care întâmplător împarte numărul.

## Pas A4 — `/api/formulare-df/:id/revizii`: lanțul pe dosar (`df.mjs:474-478`)
Azi `OR nr_unic_inreg = (…)` trage reviziile ambelor dosare în același lanț — exact „R0 ✓ | R0 ⏳" din trasabilitate. Păstrează `id = $1 OR parent_df_id = $1`, înlocuiește ramura pe număr cu ramura pe dosar.

## Pas A5 — gardă la PUT, DOAR când numărul se SCHIMBĂ (`df.mjs:325`)
⚠️ Capcană: o gardă necondiționată ar BLOCA documentele existente — la 40339, documentul nou n-ar mai putea fi salvat deloc (vede celălalt 40339 → 409), deși e un document viu, în lucru. `excludeId` acoperă doar auto-conflictul.
```js
if ('nr_unic_inreg' in data) {
  const nrNou  = String(data.nr_unic_inreg || '').trim();
  const nrVechi = String(doc.nr_unic_inreg || '').trim();
  if (nrNou && nrNou !== nrVechi) {       // ⛔ doar la SCHIMBARE efectivă
    // liber = niciun ALT document (alt dosar) cu același număr la aceeași revizie
    // ⇒ coliziunile EXISTENTE rămân salvabile, dar nu se mai pot CREA altele
  }
}
```
Mesajul de eroare (409 `nr_unic_duplicat`) trebuie să îndrume spre calea corectă, altfel utilizatorii inventează „40339/2" și pierdem trasabilitatea altfel:
> „Numărul <nr> este deja folosit de alt document. Dacă e o cheltuială următoare pe același obiect, nu deschideți un dosar nou — **revizuiți documentul existent** (butonul Revizuiește pe DF-ul aprobat), revizia păstrează numărul."

⛔ Compară TRIMMED pe ambele părți (altfel „40339" ≠ „40339 " și gaura rămâne). ⛔ NU pune garda pe calea `/revizuieste` — acolo copierea numărului e LEGITIMĂ.

## Pas A6 — avertisment vizibil în listă
Lista DF trebuie să arate, pe documentele cu număr partajat de alt DOSAR, un indicator discret (ex. badge „⚠ nr. partajat") cu `title` explicativ („Alt document folosește același număr unic — verificați dacă nu trebuia o revizie"). Calculează-l în interogarea listei (`EXISTS` pe alt dosar, același număr, `deleted_at IS NULL`), nu în frontend. ⛔ Nu blochează nimic — e doar semnal. Oglindește stilul badge-urilor existente din listă (`R0`, status).

## Pas A7 — documentare
`docs/incidents/DF-NR-DUPLICAT.md`: tabelul de mai sus, cele cinci interogări mutate, motivul pentru care nu există index unic, și decizia de produs (continuarea = revizie R1). ⛔ Zero cod executabil în `db/index.mjs`.

## Pas A8 — teste (`server/tests/db/df-revizii-pe-dosar.test.mjs`, NOU)
Fixtură care REPRODUCE producția: două dosare ALOP diferite, fiecare cu DF R0, **ambele cu nr_unic_inreg = '40339'**.
1. `/revizuieste` pe DF-ul dosarului A ⇒ 200, creează R1 în dosarul A. Apoi `/revizuieste` pe DF-ul dosarului B ⇒ **200** (azi ar da 400). Testul central al etapei.
2. `/aprobate` cu ambele DF-uri aprobate ⇒ **ambele** apar în listă.
3. `/revizii` pe DF-ul dosarului A ⇒ conține DOAR reviziile dosarului A.
4. lista: `has_newer_revision` fals pe DF-ul B când doar A a fost revizuit.
5. PUT care salvează DF-ul B cu numărul NESCHIMBAT ⇒ 200 (nu blocăm documente vii).
6. PUT care SCHIMBĂ numărul DF-ului B într-unul folosit de alt dosar ⇒ 409, număr nemodificat în DB.
7. PUT cu număr identic dar cu spații („ 40339 ") ⇒ 409 (normalizarea).
8. LEGACY: două DF-uri cu `source_alop_id` NULL, același număr, R0 și R1 ⇒ lanțul funcționează ca înainte (fallback-ul nu regresează).
9. `/revizuieste` păstrează numărul în revizie (R1 are același `nr_unic_inreg`) ⇒ 200.
10. badge-ul de la A6 apare pe ambele DF-uri de la 40339 și NU apare pe un DF cu număr unic.

===============================================================================
# ETAPA B — confirmarea manuală a plății: doar compartimentul CAB
===============================================================================
`POST /api/alop/:id/confirma-plata` (`server/routes/alop.mjs:1548`) verifică azi doar `canEditAlop` ⇒ inițiatorul dosarului poate confirma plata. Cerință: doar utilizatorii din `organizations.cab_compartiment`.
Infrastructura există: `loadActorCompAndCab(pool, userId, orgId)` (`services/authz-formular.mjs:48`) e DEJA apelat în această rută și întoarce `{ actorComp, cabComp }` trimmed.

## Pas B1 — garda
După `canEditAlop` (o păstrezi — e apărarea de tenant/dosar), ÎNAINTE de `pool.connect()`:
- `actor.role === 'admin'` (platform) ⇒ exceptat.
- `!cabComp` ⇒ **409 `cab_compartiment_nesetat`**, mesaj: „Compartimentul CAB nu este configurat pentru organizație. Setați-l în Organizații → Date generale." (fail-closed)
- `actorComp !== cabComp` ⇒ **403 `doar_cab`**, „Doar utilizatorii din compartimentul CAB pot confirma plata."
- ⛔ `org_admin` NU e exceptat — e separare de atribuții, nu poartă de tenant.
- ⛔ NU atinge tranzacția `FOR UPDATE`, nici `applyPlataConfirmedSideEffects`.

## Pas B2 — frontend (`public/js/formular/alop.js`)
Dezactivează/ascunde butonul de confirmare manuală pentru cine nu e din CAB, cu `title` explicativ. Serverul rămâne poarta. ⛔ Dacă datele despre compartimentul actorului NU există deja în frontend, NU adăuga endpoint nou — lasă butonul și tratează 403 cu mesaj clar; notează în raport.

## Pas B3 — teste (`server/tests/db/alop-confirma-plata-cab.test.mjs`, NOU)
1. utilizator din CAB ⇒ 200, plată confirmată în DB.
2. inițiatorul dosarului, alt compartiment ⇒ 403 `doar_cab`, `plata_confirmed_at` rămâne NULL **în DB**.
3. `cab_compartiment` gol ⇒ 409, nimic scris.
4. `admin` din aceeași org, alt compartiment ⇒ 200 (excepție deliberată).
5. `org_admin`, alt compartiment ⇒ 403.
6. non-regresie: confirmarea prin OPME (calea automată) NU e afectată.

===============================================================================
# ETAPA C — OPME: al patrulea criteriu (IBAN beneficiar)
===============================================================================
`server/services/opme-matcher.mjs` potrivește azi pe `cif_beneficiar` + `(cod_angajament, indicator_angajament)` (`:124-134`). Cerință: **+ IBAN-ul din ordonanțare**, pregătind ORD-ul cu mai multe CONTURI (același furnizor, conturi diferite).
Ambele capete există, fără migrație: `opme_lines.iban_beneficiar` (parsat la `services/opme-parser.mjs:173`, stocat la `routes/opme.mjs:221`) și `formulare_ord.iban_beneficiar`.

## Pas C1 — normalizare
`_normIban(v)` = `String(v||'').toUpperCase().replace(/[^A-Z0-9]/g,'')`. ⛔ Fără ea, „RO49 AAAA…" ≠ „RO49AAAA…" și criteriul respinge potriviri corecte — regresie mai gravă decât problema rezolvată.

## Pas C2 — regula pentru valorile lipsă (DECIZIE, respect-o exact)
Criteriul IBAN se aplică **doar când AMBELE părți au IBAN**. Dacă ORD-ul n-are `iban_beneficiar` (documente vechi) SAU linia OPME n-are, potrivirea cade pe cele trei criterii existente. Motiv: altfel toate ALOP-urile deja în „plata" devin brusc nepotrivibile și oamenii confirmă manual sute de plăți.
Loghează distinct `opme.match.candidate.no_iban` ca să se vadă în timp câte mai sunt.
⚠️ Aplică regula IDENTIC în AMBELE căi: interogarea de selecție (`:124-134`) ȘI `_processAlop` (`:306-320`). ⛔ Dacă divergă, un OP se potrivește la selecție dar nu se agregă la sumă = clasa de bug de la #115 (plată sub-numărată).

## Pas C3 — raportul de import
Când IBAN-ul a fost diferența, spune-o în `match_notes` („IBAN diferit față de ordonanțare"), în stilul existent.

## Pas C4 — teste (`server/tests/db/opme-match-iban.test.mjs`, NOU)
1. triplet + IBAN identic ⇒ auto. 2. triplet identic, IBAN DIFERIT ⇒ nepotrivit (miezul cerinței). 3. IBAN formatat diferit, același ⇒ potrivire. 4. ORD fără IBAN ⇒ potrivire + log `no_iban`. 5. linie OPME fără IBAN ⇒ potrivire. 6. două ALOP cu același triplet, IBAN diferit ⇒ **dezambiguizate** (înainte `ambiguous`) — câștigul funcțional. 7. non-regresie #115: ORD multi-indicator plătit prin mai multe OP ⇒ suma agregată corectă.

===============================================================================
# ETAPA D — versionare, rulare, push
===============================================================================
- `package.json`: bump patch de la valoarea citită la început.
- Se ating fișiere din `public/` (A6 listă, B2 buton) ⇒ verifică în `public/sw.js` dacă sunt în `PRECACHE_ASSETS`; dacă DA, bump `CACHE_VERSION` (citește valoarea curentă). `?v=` țintit DOAR pe fișierele atinse. ⛔ Fără bulk-sed.
- `npm test` + `npm run test:db` (rețeta PG 17 efemeră) — VERZI, `test:db` PASSED REAL.
```
git add -A
git commit -m "fix(#126): lanțul de revizii DF cheiat pe dosarul ALOP (5 interogări) + gardă la schimbarea nr. + avertisment listă · confirmarea plății doar CAB · OPME 4 criterii (+IBAN)"
git push origin develop
```

===============================================================================
# RAPORT FINAL
===============================================================================
- Commit: ______ · push: ______ · versiune: ______ → ______
- `npm test`: ____ / ____ · `npm run test:db`: ____ / ____ PASSED REAL?
- A: expresia de cheie e definită O SINGURĂ dată și folosită în toate cele 5 locuri? ______
- A: mai există vreo interogare cheiată pe `nr_unic_inreg` pe care n-am listat-o? (grep + listă) ______
- A: testul 1 (ambele dosare pot fi revizuite independent) VERDE? ______
- A: testul 2 (ambele DF apar în dropdown-ul ORD) VERDE? ______
- A: testul 5 (documentul cu număr coliziune se poate SALVA) VERDE? ______
- A: testul 8 (legacy fără source_alop_id nu regresează) VERDE? ______
- B: `org_admin` refuzat, `admin` acceptat — ambele testate? ______
- C: regula „IBAN doar când ambele îl au" aplicată identic în selecție ȘI `_processAlop`? ______
- C: testul 6 (dezambiguizare prin IBAN) VERDE? ______
- CACHE_VERSION: ce fișiere din PRECACHE au fost atinse? valoare veche → nouă: ______
- Abateri + motiv: ______

# ⛔ CONSTRÂNGERI
- ⛔ Niciun `CREATE UNIQUE INDEX` pe `nr_unic_inreg`. Nu e posibil (documente semnate în coliziune) și nu e necesar după fixul structural.
- ⛔ Fără migrații. Zona NO-TOUCH neatinsă.
- ⛔ Garda de la PUT se declanșează DOAR la schimbarea efectivă a numărului — altfel blochează documente vii din producție.
- ⛔ Expresia de cheie: `COALESCE(source_alop_id::text, nr_unic_inreg)`. NU `id::text` (rupe legacy).
- ⛔ Fail-closed la CAB (nesetat ⇒ refuz).
- ⛔ `test:db` PASSED REAL, nu SKIPPED. Teste importate din producție.
- ⛔ Un test roșu se explică prin premisă greșită sau se raportează — nu se slăbește garda.
- ⛔ Citește fiecare fișier înainte de patch; `old_str` unic.
