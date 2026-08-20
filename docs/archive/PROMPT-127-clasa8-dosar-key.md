---
prompt: 127
titlu: Clasa 8 — angajamentele bugetare se cheie pe dosarul ALOP (ultima constatare rămasă din #126)
model_suggested: Opus 4.8
branch: develop
version_bump: 3.9.755 → 3.9.756
migratii: NU
cache_version_bump: NU (zero fișiere din public/)
---

# ⚠️⚠️ BRANCH: `develop` — EXCLUSIV ⚠️⚠️
Pasul final OBLIGATORIU: `git push origin develop`. NICIODATĂ pe `main`.
```
git fetch origin && git status && git log --oneline --graph --all -6
```
Pe `develop`, curat, aliniat cu `origin/develop` (v3.9.755, după #126).

⛔ ZONĂ NO-TOUCH: `STSCloudProvider.mjs`, `cloud-signing.mjs`, `bulk-signing.mjs`, `pades.mjs`, `java-pades-client.mjs`.

---

# CONTEXT — de ce e urgent

#126 a mutat lanțul de revizii DF de pe `nr_unic_inreg` pe dosarul ALOP, în 5 locuri din `routes/formulare/df.mjs` + `services/trasabilitate.mjs`. A rămas UN consumator neatins, semnalat corect de agent ca scope separat: **`server/services/clasa8.mjs`**.

Verificat pe cod:
- `clasa8.mjs:88` — CTE `latest_approved_df`, `SELECT DISTINCT ON (fd.nr_unic_inreg)`, comentat „ANGAJAMENTE BUGETARE: ultima revizie aprobată per nr_unic_inreg", sursa fiind `rows_ctrl[].sum_rezv_crdt_bug_act` (col.10 = suma rezervată din credite bugetare actualizată).
- `clasa8.mjs:322` — același CTE, în verificarea de PLAFON la o cheltuială nouă, cu excluderea `excludeDfId` scrisă tot pe număr: `fd.nr_unic_inreg IS DISTINCT FROM (SELECT nr_unic_inreg FROM formulare_df WHERE id = $2::uuid)`.

Consecință: două DOSARE ALOP independente care împart un `nr_unic_inreg` ⇒ `DISTINCT ON` păstrează UNUL SINGUR ⇒ **angajamentele bugetare ale celuilalt nu sunt contorizate deloc**. Iar la `:322`, plafonul unei cheltuieli noi se validează față de un consum sub-raportat ⇒ se poate angaja peste creditele aprobate. Aceeași clasă cu #115 (plată sub-numărată), dar pe bani ANGAJAȚI.

⚠️ În producție există 3 coliziuni reale (40339, 42320, 6736 — org 1). Nu mușcă ÎNCĂ doar fiindcă în fiecare grup e un singur DF aprobat. Dar DF-ul al doilea de la 40339 e la 3/4 semnături și cel de la 6736 la 4/5 ⇒ **la o semnătură distanță**. La `:322`, excluderea pe număr are deja efect: excluzând un DF, se exclude și DF-ul CELUILALT dosar.

# Ce există deja (folosește, nu rescrie)
`server/services/df-dosar-key.mjs` — modul PUR (fără `pool`), creat la #126, care expune expresia de cheie `COALESCE(source_alop_id::text, nr_unic_inreg)` cu fallback pentru DF-uri legacy. E importat deja din `routes/formulare/df.mjs` și `services/trasabilitate.mjs`. ⛔ Nu duplica expresia; importă-l. Citește-i semnătura reală înainte (parametru de alias?), nu o presupune.

===============================================================================
# PAȘI
===============================================================================

## Pas 1 — `clasa8.mjs:88` (raportul Clasa 8)
`DISTINCT ON (fd.nr_unic_inreg)` → cheia pe dosar, din `df-dosar-key.mjs`.
⚠️ `ORDER BY`-ul CTE-ului trebuie să înceapă cu EXACT aceeași expresie, altfel Postgres respinge interogarea. Verifică ce urmează după `ORDER BY` (probabil `fd.revizie_nr DESC`) și păstrează restul ordinii — semantica „ultima revizie aprobată" rămâne, doar că se aplică per DOSAR.
Păstrează `fd.nr_unic_inreg` în lista de coloane selectate dacă e folosit mai jos în interogare (verifică; nu-l scoate orbește).

## Pas 2 — `clasa8.mjs:322` (verificarea de plafon)
(a) Același `DISTINCT ON` → cheia pe dosar.
(b) Excluderea `excludeDfId` se rescrie pe DOSAR, nu pe număr:
```sql
AND ($2::uuid IS NULL OR <cheie_dosar(fd)> IS DISTINCT FROM
     (SELECT <cheie_dosar(fd2)> FROM formulare_df fd2 WHERE fd2.id = $2::uuid))
```
Intenția reală a acelei condiții e „exclude DOCUMENTUL pe care îl validez acum (și reviziile lui)", nu „exclude tot ce împarte numărul cu el". ⛔ NU o simplifica la `fd.id <> $2` — ar rata celelalte revizii ale ACELUIAȘI dosar, care trebuie excluse (altfel R0 și R1 se numără de două ori).

## Pas 3 — inventar de închidere
```
grep -rn "nr_unic_inreg" server/services/ server/routes/ --include=*.mjs | grep -v tests
```
Enumeră în raport TOATE aparițiile rămase și clasifică fiecare: „corect pe număr" (ex. verificarea de duplicat la creare, afișare, căutare) sau „de mutat". ⛔ Dacă găsești vreuna care ar trebui mutată și nu e în acest prompt, OPREȘTE-TE și raportează — nu extinde scope-ul singur.

## Pas 4 — teste (`server/tests/db/clasa8-dosar-key.test.mjs`, NOU)
Fixtură care reproduce producția: **două dosare ALOP diferite, fiecare cu DF R0 APROBAT (flux completed), ambele cu `nr_unic_inreg = '40339'`**, fiecare cu `rows_ctrl` conținând sume diferite pe `sum_rezv_crdt_bug_act` (ex. 220 și 320, același cod SSI).
1. Raportul Clasa 8 ⇒ angajamentele bugetare includ **SUMA AMBELOR** (540), nu doar una. Testul central — azi ar da 220 sau 320.
2. Verificarea de plafon cu `excludeDfId` = DF-ul dosarului A ⇒ consumul raportat include DF-ul dosarului B (320), NU îl exclude odată cu A.
3. Excluderea funcționează corect ÎN INTERIORUL dosarului: dosar A cu R0 și R1 aprobate, `excludeDfId` = R1 ⇒ R0 al aceluiași dosar e ȘI EL exclus (nu se numără de două ori).
4. LEGACY: două DF-uri cu `source_alop_id` NULL, același număr, R0 și R1 ⇒ se numără o singură dată (fallback-ul pe număr nu regresează).
5. Non-regresie: un singur dosar, revizii R0→R1→R2 aprobate ⇒ se numără DOAR R2 (ultima revizie), ca înainte.

## Pas 5 — documentare
Actualizează `docs/incidents/DF-NR-DUPLICAT.md`: constatarea `clasa8.mjs` se marchează REZOLVATĂ, cu explicația impactului financiar (sub-numărarea angajamentelor + plafon validat greșit) și data.

===============================================================================
# VERSIONARE, RULARE, PUSH
===============================================================================
- `package.json`: `3.9.755` → `3.9.756` (citește valoarea reală mai întâi).
- ⛔ Fără `CACHE_VERSION`, fără `?v=` — zero fișiere din `public/`.
- `npm test` + `npm run test:db` (rețeta PG 17 efemeră). ⚠️ La #126 suita DB completă n-a fost re-confirmată end-to-end; **aici rulează TOATĂ suita `test:db`**, nu doar fișierele atinse — clasa8 e consumată de mai multe rute și un mock pozițional poate cădea în altă parte.
```
git add <fișierele sarcinii>     # ⛔ NU `git add -A` — working tree-ul are ~50 fișiere netrackuite, inclusiv documente cu date personale
git commit -m "fix(#127): Clasa 8 — angajamentele bugetare și verificarea de plafon se cheie pe dosarul ALOP, nu pe nr_unic_inreg — v3.9.756"
git push origin develop
```

===============================================================================
# RAPORT FINAL
===============================================================================
- Commit: ______ · push: ______ · versiune: ______ → ______
- `npm test`: ____ / ____ · `npm run test:db`: ____ / ____ COMPLET, PASSED REAL?
- Testul 1 (ambele dosare contorizate, 540) VERDE? ______
- Testul 3 (reviziile aceluiași dosar excluse împreună) VERDE? ______
- Testul 5 (non-regresie: doar ultima revizie) VERDE? ______
- Pas 3 — inventarul complet `nr_unic_inreg`, cu clasificarea fiecărei apariții: ______
- Vreo apariție care ar trebui mutată dar nu e în acest prompt? ______
- Abateri + motiv: ______

# ⛔ CONSTRÂNGERI
- ⛔ Importă expresia din `df-dosar-key.mjs`; nu o duplica.
- ⛔ `ORDER BY` trebuie să înceapă cu exact expresia din `DISTINCT ON`.
- ⛔ Excluderea `excludeDfId` NU se simplifică la `fd.id <> $2`.
- ⛔ Fără migrații. Zona NO-TOUCH neatinsă. Zero fișiere din `public/`.
- ⛔ `git add` selectiv, niciodată `-A`.
- ⛔ `test:db` COMPLET și PASSED REAL, nu doar fișierele atinse.
- ⛔ Un test roșu se explică prin premisă greșită sau se raportează.
