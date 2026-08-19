---
prompt: 126
titlu: Nr. DF duplicat (gardă la PUT) · confirmarea manuală a plății doar pentru compartimentul CAB · OPME cu 4 criterii de potrivire (+IBAN)
model_suggested: Opus 4.8
branch: develop
version_bump: 3.9.754 → 3.9.755   (⚠️ dacă #125 n-a intrat încă, versiunea de pornire e 3.9.753 → 3.9.754 — CITEȘTE package.json, nu presupune)
migratii: NU în acest prompt (indexul unic e amânat deliberat — vezi A3)
cache_version_bump: verifică pe fișier (se atinge `public/js/formular/alop.js`)
---

# ⚠️⚠️ BRANCH: `develop` — EXCLUSIV ⚠️⚠️
Pasul final OBLIGATORIU: `git push origin develop`. NICIODATĂ pe `main`.
```
git fetch origin && git status && git log --oneline --graph --all -6
```
⛔ Prima acțiune: citește versiunea din `package.json` și pornește de acolo. Versiunea se citește ACUM, nu se presupune din titlu.

⛔ ZONĂ NO-TOUCH: `server/signing/providers/STSCloudProvider.mjs`, `server/routes/flows/cloud-signing.mjs`, `bulk-signing.mjs`, `pades.mjs`, `java-pades-client.mjs`. (Dacă #125 e în lucru în paralel, atenție la conflicte pe primele două — nu le atinge aici sub nicio formă.)

Trei etape INDEPENDENTE. Fiecare cu testele ei. Dacă una se blochează, celelalte două merg mai departe.

===============================================================================
# ETAPA A — nr_unic_inreg duplicat (INCIDENT în producție)
===============================================================================

## Ce s-a întâmplat (verificat pe cod)
`POST /api/formulare-df` ARE gardă anti-duplicat (`server/routes/formulare/df.mjs:233-245` → 409 `nr_unic_duplicat`). Dar numărul se completează de regulă mai TÂRZIU, prin `PUT /api/formulare-df/:id` (`:325`), care **nu verifică nimic**, iar `nr_unic_inreg` e în `DF_P1_FIELDS` (`services/formular-shared.mjs:91`) ⇒ editabil liber. Indexul `idx_formulare_df_nr_unic` (`server/db/index.mjs:1108`) e **non-UNIC** — doar pentru performanță.

Daune reale (nu doar cosmetice):
- `/revizuieste` ia `MAX(revizie_nr) WHERE nr_unic_inreg=$1 AND org_id=$2` (`df.mjs:522-526`) peste AMBELE documente ⇒ după ce unul devine R1, celălalt e blocat definitiv („nu mai este cea curentă").
- Lista face `SELECT DISTINCT ON (nr_unic_inreg) … ORDER BY revizie_nr DESC` (`df.mjs:107-116`) ⇒ un document dispare din vedere.
- Trasabilitatea le grupează pe număr ⇒ apar ca revizii ale aceluiași document.

⚠️ **Cheia unică corectă este `(org_id, nr_unic_inreg, revizie_nr)`, NU `(org_id, nr_unic_inreg)`.** Reviziile ÎMPART legitim numărul (R0→R1→R2) conform OMF 1140/2025. O cheie pe doar (org, nr) ar rupe complet revizuirea. ⛔ Nu „simplifica" asta.

## Pas A1 — extrage garda într-un helper partajat (`server/routes/formulare/df.mjs`)
Creează o funcție locală în acest fișier (nu un modul nou — e folosită doar aici):
```js
/**
 * Numărul unic e liber pentru (org, revizie)? Reviziile ÎMPART numărul, deci
 * cheia e (org_id, nr_unic_inreg, revizie_nr) — nu doar (org_id, nr).
 * @param excludeId  id-ul documentului curent (la PUT), ca să nu se conteste singur
 */
async function nrUnicLiber(pool, { nr, orgId, revizieNr, excludeId = null })
```
- normalizează: `String(nr || '').trim()`; dacă e gol ⇒ `true` (numărul lipsă nu e coliziune).
- interoghează `formulare_df` cu `TRIM(nr_unic_inreg) = $1 AND org_id = $2 AND COALESCE(revizie_nr,0) = $3 AND deleted_at IS NULL` + `AND id <> $4` când `excludeId` e dat.
- ⚠️ compară pe `TRIM(...)` pe AMBELE părți — altfel „40339" și „40339 " trec ca numere diferite și gaura rămâne.

Rescrie garda existentă din POST ca să folosească helperul (cu `revizieNr` = 0 la creare — verifică pe cod ce valoare primește un DF nou; dacă e `data.revizie_nr` sau default 0, folosește exact ce se inserează). ⛔ Codul de eroare `nr_unic_duplicat` și mesajul rămân IDENTICE (frontendul le poate afișa).

## Pas A2 — aplică garda la PUT (`df.mjs:325`)
După `pick(req.body, allowedFields)` și înainte de `UPDATE`:
```js
if ('nr_unic_inreg' in data) {
  const liber = await nrUnicLiber(pool, {
    nr: data.nr_unic_inreg, orgId: actor.orgId,
    revizieNr: doc.revizie_nr || 0, excludeId: doc.id,
  });
  if (!liber) return res.status(409).json({
    error: 'nr_unic_duplicat',
    message: 'Numărul unic de înregistrare există deja la un alt document. Folosiți alt număr sau revizuiți documentul existent.'
  });
}
```
⛔ `excludeId` e OBLIGATORIU — fără el, orice salvare a unui document își vede propriul număr și se auto-blochează. Testul 3 din A4 exact asta prinde.
⛔ Verifică dacă mai există ALTE căi care scriu `nr_unic_inreg` (ex. `/revizuieste` care copiază numărul — acolo e LEGITIM, revizia trebuie să-l păstreze; ⛔ NU pune garda pe calea de revizuire). Enumeră în raport toate căile găsite și ce ai decis pentru fiecare.

## Pas A3 — indexul unic: PREGĂTIT, NU APLICAT
⛔ **NU crea indexul unic în acest prompt.** În producție există deja cel puțin o coliziune (nr. 40339); `CREATE UNIQUE INDEX` ar eșua, iar tiparul de la `095_df_dedup` arată că eșecul e TĂCUT (`RAISE WARNING`, bootul continuă) ⇒ am rămâne cu falsa impresie că suntem protejați.
În schimb: scrie migrarea **comentată complet**, gata de activat, într-un fișier `docs/incidents/DF-NR-DUPLICAT.md`, împreună cu: constatarea, daunele de mai sus, cheia corectă `(org_id, nr_unic_inreg, revizie_nr)`, și pașii de activare după curățarea datelor. ⛔ Fără cod executabil în `server/db/index.mjs`.

## Pas A4 — teste (`server/tests/db/df-nr-unic-duplicat.test.mjs`, NOU)
1. POST cu număr deja folosit la aceeași revizie ⇒ 409 `nr_unic_duplicat` (comportament existent, nu s-a rupt).
2. PUT care setează un număr folosit de ALT document, aceeași revizie ⇒ 409, iar în DB numărul documentului editat e NESCHIMBAT.
3. PUT care salvează documentul cu PROPRIUL număr (fără schimbare) ⇒ 200. (regresia pe care `excludeId` o previne)
4. PUT cu număr identic dar cu spații („ 40339 ") ⇒ 409 (normalizarea funcționează).
5. Două documente cu același număr dar `revizie_nr` DIFERIT (R0 și R1, lanț legitim) ⇒ permis.
6. `/revizuieste` pe un DF aprobat continuă să creeze R1 cu ACELAȘI număr ⇒ 200 (garda nu a rupt revizuirea). **Testul cel mai important din etapă.**
7. Izolare pe org: același număr în două organizații ⇒ permis.

===============================================================================
# ETAPA B — confirmarea manuală a plății: doar compartimentul CAB
===============================================================================

## Context
`POST /api/alop/:id/confirma-plata` (`server/routes/alop.mjs:1548`) verifică azi doar `canEditAlop` — adică inițiatorul sau compartimentul dosarului pot confirma plata. Cerința: **doar utilizatorii din compartimentul setat ca CAB pe organizație** (`organizations.cab_compartiment`, vizibil în Organizații → „Compartiment CAB implicit").

Infrastructura există: `loadActorCompAndCab(pool, userId, orgId)` (`server/services/authz-formular.mjs:48`) întoarce `{ actorComp, cabComp }` într-un singur query și **e deja apelat în această rută**.

## Pas B1 — garda
După garda `canEditAlop` existentă (păstreaz-o — e apărarea de tenant/dosar), adaugă:
```js
// Confirmarea plății e act de execuție bugetară — o face compartimentul CAB
// al organizației (organizations.cab_compartiment), nu inițiatorul dosarului.
if (actor.role !== 'admin') {
  if (!cabComp) {
    return res.status(409).json({ error: 'cab_compartiment_nesetat',
      message: 'Compartimentul CAB nu este configurat pentru organizație. Setați-l în Organizații → Date generale.' });
  }
  if (actorComp !== cabComp) {
    return res.status(403).json({ error: 'doar_cab',
      message: 'Doar utilizatorii din compartimentul CAB pot confirma plata.' });
  }
}
```
Decizii, respectă-le exact:
- `actorComp`/`cabComp` se compară **trimmed** (helperul le întoarce deja trimmed — verifică, nu presupune).
- **platform-`admin` rămâne exceptat** (consecvent cu restul rutelor de administrare). `org_admin` NU e exceptat — e o poartă de separare a atribuțiilor, nu una de tenant. ⛔ Dacă vrei să schimbi asta, oprește-te și întreabă.
- `cab_compartiment` nesetat ⇒ **409, fail-closed**, cu mesaj care spune unde se setează. ⛔ Nu lăsa să treacă „dacă nu e configurat".
- ⛔ NU atinge tranzacția `FOR UPDATE` de dedesubt, nici `applyPlataConfirmedSideEffects`. Garda stă ÎNAINTE de `pool.connect()`.

## Pas B2 — frontend (`public/js/formular/alop.js`)
Butonul de confirmare manuală a plății: dacă utilizatorul nu e din compartimentul CAB, ascunde-l sau dezactivează-l cu `title` explicativ. ⚠️ Serverul rămâne poarta — frontendul e doar curtoazie. Verifică ce date despre compartimentul actorului sunt DEJA disponibile în `window.ST`/profil; ⛔ dacă nu există, NU adăuga un endpoint nou pentru asta în acest prompt — lasă butonul vizibil și tratează 403 cu un mesaj clar, și notează în raport.

## Pas B3 — teste (`server/tests/db/alop-confirma-plata-cab.test.mjs`, NOU)
1. utilizator din compartimentul CAB ⇒ 200, plata confirmată în DB.
2. utilizator din alt compartiment, deși e inițiatorul dosarului ⇒ **403 `doar_cab`**, iar în DB `plata_confirmed_at` rămâne NULL (verifică DB, nu doar statusul).
3. `org.cab_compartiment` NULL/gol ⇒ 409 `cab_compartiment_nesetat`, nimic scris.
4. platform-`admin` din altă… nu — `admin` din aceeași org, compartiment diferit ⇒ 200 (excepția e deliberată).
5. confirmarea prin OPME (calea automată) NU e afectată de această gardă ⇒ test de non-regresie.

===============================================================================
# ETAPA C — OPME: al patrulea criteriu de potrivire (IBAN beneficiar)
===============================================================================

## Context
`server/services/opme-matcher.mjs` potrivește azi pe TRIPLET: `cif_beneficiar` + `(cod_angajament, indicator_angajament)` din rândurile ORD (`:124-134`). Cerința: **patru** criterii — cod angajament, indicator, CIF, **și IBAN-ul din ordonanțare** — pregătind ORD-ul cu mai multe CONTURI (același furnizor, conturi diferite).

Ambele capete există deja, fără migrație:
- `opme_lines.iban_beneficiar` — parsat la `services/opme-parser.mjs:173` (`IbanBeneficiar`), stocat la `routes/opme.mjs:221`.
- `formulare_ord.iban_beneficiar` — coloană existentă.

## Pas C1 — normalizare (helper local în matcher)
IBAN-urile vin formatate inconsecvent („RO49 AAAA 1B31…" vs „RO49AAAA1B31…", minuscule). Scrie `_normIban(v)`: `String(v||'').toUpperCase().replace(/[^A-Z0-9]/g, '')`. ⛔ Fără normalizare, criteriul 4 ar respinge potriviri corecte — regresie mai gravă decât problema pe care o rezolvă.

## Pas C2 — criteriul, cu regulă explicită pentru valorile lipsă
⚠️ **Decizia cheie, respect-o exact:** criteriul IBAN se aplică **doar când ambele părți au IBAN**. Dacă ORD-ul nu are `iban_beneficiar` (documente vechi) SAU linia OPME n-are `iban_beneficiar`, potrivirea cade înapoi pe cele trei criterii existente.
Motiv: altfel toate ALOP-urile deja în „plata" create înainte de azi ar deveni brusc nepotrivibile, iar utilizatorii ar confirma manual sute de plăți. ⛔ Nu transforma asta într-o cerință dură fără decizia lui Mircea.
Loghează distinct cazul „potrivit pe 3 criterii, IBAN absent" (`opme.match.candidate.no_iban`) ca să se vadă în timp câte mai sunt.

Modifică interogarea de la `:124-134` adăugând condiția IBAN în forma „ori lipsește, ori se potrivește (normalizat)". Aplică ACEEAȘI regulă și în `_processAlop` (`:306-320`), unde se re-citește CIF-ul și setul de triplete pentru agregare — ⛔ dacă cele două căi diverg, un OP se potrivește la selecție dar nu se agregă la sumă, exact clasa de bug de la #115 (plată sub-numărată).

## Pas C3 — raportul de import
Ecranul „Raport import OPME" arată azi cauzele de nepotrivire. Adaugă IBAN-ul în motivul afișat când el a fost diferența (ex. „IBAN diferit față de ordonanțare"), ca utilizatorul să înțeleagă de ce o linie a rămas `Nepotrivit`. Verifică pe cod cum se construiesc azi `match_notes` și oglindește stilul existent.

## Pas C4 — teste (`server/tests/db/opme-match-iban.test.mjs`, NOU)
1. triplet identic + IBAN identic ⇒ potrivire automată.
2. triplet identic + IBAN DIFERIT ⇒ **nepotrivit** (miezul cerinței).
3. triplet identic + IBAN formatat diferit (spații/minuscule) dar același ⇒ potrivire (normalizarea).
4. triplet identic + ORD fără IBAN ⇒ potrivire (retrocompatibilitate) + log `no_iban`.
5. triplet identic + linie OPME fără IBAN ⇒ potrivire.
6. două ALOP-uri cu același triplet dar IBAN-uri diferite ⇒ potrivire DEZAMBIGUIZATĂ corect (înainte ar fi fost `ambiguous`). Ăsta e câștigul funcțional — arată-l explicit.
7. non-regresie #115: ORD cu mai mulți indicatori, plătit prin mai multe OP-uri ⇒ suma agregată rămâne corectă.

===============================================================================
# ETAPA D — versionare, rulare, push
===============================================================================
- `package.json`: bump patch de la valoarea CITITĂ la început.
- ⚠️ Se atinge `public/js/formular/alop.js` (Etapa B2) ⇒ verifică în `public/sw.js` dacă e în `PRECACHE_ASSETS`; dacă DA, bump `CACHE_VERSION` (citește valoarea curentă). `?v=` țintit pe fișierele atinse. ⛔ Fără bulk-sed.
- `npm test` + `npm run test:db` (rețeta PG 17 efemeră) — ambele VERZI, `test:db` PASSED REAL.
```
git add -A
git commit -m "fix(#126): gardă nr_unic_inreg la PUT DF · confirmarea plății doar pentru compartimentul CAB · OPME potrivire pe 4 criterii (+IBAN normalizat)"
git push origin develop
```

===============================================================================
# RAPORT FINAL
===============================================================================
- Commit: ______ · push: ______ · versiune: ______ → ______
- `npm test`: ____ / ____ · `npm run test:db`: ____ / ____ PASSED REAL?
- A: TOATE căile care scriu `nr_unic_inreg` (listă) + ce ai decis pentru fiecare: ______
- A: testul 6 (revizuirea păstrează numărul) e VERDE? ______
- A: migrarea comentată e în `docs/incidents/DF-NR-DUPLICAT.md`, ZERO cod executabil în `db/index.mjs`? ______
- B: `org_admin` NU e exceptat, `admin` DA — confirmat în teste? ______
- B2: ce date despre compartimentul actorului existau deja în frontend? A fost nevoie de endpoint nou (dacă da — n-ai adăugat, corect)? ______
- C: regula „IBAN doar când ambele părți îl au" e aplicată IDENTIC în ambele căi (selecție + `_processAlop`)? ______
- C: testul 6 (dezambiguizare prin IBAN) e VERDE? ______
- CACHE_VERSION: alop.js e în PRECACHE? valoare veche → nouă: ______
- Abateri + motiv: ______

# ⛔ CONSTRÂNGERI
- ⛔ Cheia unică pentru DF e `(org_id, nr_unic_inreg, revizie_nr)`. Reviziile împart numărul.
- ⛔ Niciun `CREATE UNIQUE INDEX` în acest prompt.
- ⛔ Fără migrații. Zona NO-TOUCH neatinsă.
- ⛔ Fail-closed peste tot (CAB nesetat ⇒ refuz, nu permisiune).
- ⛔ `test:db` PASSED REAL, nu SKIPPED. Teste importate din producție, nu logică redeclarată.
- ⛔ Un test roșu se explică prin premisă greșită sau se raportează — nu se slăbește garda.
- ⛔ Citește fiecare fișier înainte de patch; `old_str` unic.
