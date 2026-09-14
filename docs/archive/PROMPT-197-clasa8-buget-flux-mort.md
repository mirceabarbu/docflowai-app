---
prompt: 197
titlu: "Clasa 8 nu mai consumă buget pe DF-uri cu aprobarea desfăcută administrativ"
model_suggested: "Opus 5, efort high"
branch: develop
versiune_curenta: v3.9.849
versiune_tinta: v3.9.850
migratii: NU
fisiere_din_public: NU  (⇒ FĂRĂ bump `CACHE_VERSION`, FĂRĂ `?v=`)
zona_no_touch_atinsa: NU
scrieri_in_baza: ZERO
baza: RECON #196, secțiunea DIVERGENT-SUSPECT
---

# ⚠️ BRANCH

Lucrezi **EXCLUSIV pe `develop`**. `main` = PRODUCȚIE, gestionat manual de Mircea.
Nu propune și nu executa `checkout main`, `merge main`, `push main`.
Pasul final obligatoriu: **`git push origin develop`**.

---

## ⚠️ POARTĂ DE PORNIRE

Mircea rulează pe producție **`SQL-197-impact-buget-flux-mort.sql`** și îți dă numărul de
rânduri din PASUL 2. Nu începe fără el.

- **0 rânduri** ⇒ pornești; lotul e prevenție, nimic nu se schimbă vizibil.
- **Rânduri** ⇒ pornești la fel, dar **fiecare cifră din raportul tău trebuie confruntată cu
  lista aceea**. După deploy, „Rămâne din buget" va crește pe dosarele respective.

---

## Contextul — un bug financiar, nu o inconsecvență

`server/services/clasa8.mjs` are două CTE-uri `latest_approved_df` (liniile ~94 și ~329) care
decid ce DF consumă buget. Ambele leagă fluxul cu o singură condiție:

```sql
JOIN flows f ON f.id = fd.flow_id
...
AND (f.data->>'status' = 'completed' OR (f.data->>'completed')::boolean = true)
```

Fără `deleted_at IS NULL`, fără `cancelled`, fără `refused`.

Anularea administrativă (`lifecycle.mjs`, #164) face **deliberat** trei lucruri: pune
`status='cancelled'`, face soft-delete pe flux, și **păstrează `completed:true`** ca istoric.
Iar `undoCompletedFlowLinks` golește `formulare_ord.flow_id`, dar **nu** și
`formulare_df.flow_id` — DF-ul rămâne cu pointerul pe fluxul desfăcut.

Compunerea celor trei: **un DF a cărui aprobare a fost retrasă continuă să consume buget.**
Mai rău, `DISTINCT ON (dosar) … ORDER BY revizie_nr DESC` alege tocmai revizia desfăcută
(cea mai mare), în locul reviziei aprobate anterior — adică exact valorile pe care
administratorul a vrut să le retragă.

Se vede la utilizator ca „Rămâne din buget" prea mic și ca avertisment de plafon fals la CAB.

Aceeași clasă a fost reparată în #165–#167 pentru listă, detaliu și „aprobate". A fost uitată
în **consumul de buget** și în **trasabilitate**.

---

## ETAPA 0 — ancorele (READ-ONLY, raportează valorile OBȚINUTE)

```bash
node -p "require('./package.json').version"                      # Așteptat: 3.9.849
grep -n "latest_approved_df" server/services/clasa8.mjs          # Așteptat: ~94, ~118, ~329, ~349
grep -n "import" server/services/clasa8.mjs | head
grep -n "import" server/services/flow-provenance.mjs             # Așteptat: NICIUNUL
grep -n "aprobat" server/routes/trasabilitate.mjs | head
grep -rn "cancelled\|deleted_at" server/tests/db/clasa8*.test.mjs | wc -l   # Așteptat: 0
```

⭐ A patra comandă confirmă că `flow-provenance.mjs` nu importă nimic ⇒ **zero risc de import
circular** când `clasa8.mjs` îl importă.
⭐ Ultima confirmă golul: niciun test de Clasa 8 nu pomenește azi de fluxuri moarte. De-aia a
trecut neobservat.

---

## ETAPA A — testele ÎNTÂI

⛔ **Nu atinge `clasa8.mjs` până testele nu sunt scrise și nu PICĂ pe codul actual.**
Un test scris după corecție demonstrează doar că nu s-a stricat nimic. Unul scris înainte
demonstrează că bugul exista.

În `server/tests/db/` (extinde fișierul de Clasa 8 existent dacă e, altfel fișier nou):

1. ⭐⭐ **Cazul central.** Dosar cu R0 aprobat (flux valid semnat) și R1 al cărui flux a fost
   **anulat administrativ** — `status='cancelled'`, `deleted_at` setat, `completed:true`
   păstrat, `formulare_df.flow_id` rămas pe el. Sumele col.10 diferite între R0 și R1.
   ⇒ consumul de buget trebuie să folosească valorile **R0**.
   Pe codul actual, testul **trebuie să pice** folosind R1. Confirmă asta în raport, cu
   mesajul de eșec.
2. **Flux refuzat cu `completed:true`** ⇒ nu consumă.
3. **Flux soft-șters, necancelat, `completed:true`** ⇒ nu consumă.
4. **Fără regresie:** dosar cu R0 și R1 ambele aprobate, fluxuri vii ⇒ consumă **R1**
   (revizia maximă). Ăsta apără comportamentul normal — cel mai ușor de rupt din greșeală.
5. **Fără regresie:** dosar cu o singură revizie aprobată, flux viu ⇒ consumă neschimbat.
6. **Dosar rămas fără nicio revizie vie** ⇒ dispare din consum, fără eroare.
   ⚠️ Verifică explicit că nu apare `NaN`, `null` sau divizare la zero în agregat.

Ambele CTE-uri trebuie acoperite: cel din centralizator **și** cel din verificarea de plafon
(cea cu `excludeDfId`) — sunt interogări diferite, cu aceeași gaură.

---

## ETAPA B — corecția

În `server/services/clasa8.mjs`, importă `validSignedFlowSql` din
`../services/flow-provenance.mjs` (ajustează calea la structura reală) și înlocuiește, în
**ambele** CTE-uri `latest_approved_df`:

`old_str` (de două ori — fă-le pe rând, cu context suficient ca fiecare să fie unică):
```sql
        AND (f.data->>'status' = 'completed' OR (f.data->>'completed')::boolean = true)
```
`new_str`:
```sql
        AND ${validSignedFlowSql('f')}
```

⚠️ `validSignedFlowSql` include deja `deleted_at IS NULL`, `≠cancelled`, `≠refused` și
condiția de finalizare. Nu adăuga termeni pe deasupra — ar fi duplicare și ar re-deschide
exact tipul de drift pe care-l reparăm.

Adaugă deasupra fiecărui CTE o frază de comentariu: aprobarea se derivă din fluxul **viu**,
fiindcă anularea administrativă păstrează `completed:true` ca istoric (#164) și nu golește
`formulare_df.flow_id`.

⛔ **Nu atinge** `dosarKeyExpr`, `DISTINCT ON`, `ORDER BY revizie_nr DESC`, `dfCompFilter`,
`dfQFilter`, agregatele, sau CTE-ul de buget. Se schimbă **un singur** predicat, de două ori.

⛔ **Nu atinge** predicatul ORD din același fișier. Reconul l-a clasificat drept compensat
(`flow-undo` golește `formulare_ord.flow_id`) și de gravitate scăzută. E o discuție separată;
amestecat aici, ar dilua dovada că am reparat bugul DF.

---

## ETAPA C — `trasabilitate.mjs`

Aceeași gaură, la predicatul de „aprobat" **pe DF** (~linia 79): modalul arată DF-ul desfăcut
ca aprobat, contrazicând badge-ul din listă reparat la #165. Aceeași înlocuire cu
`validSignedFlowSql`.

⛔ Doar predicatul **DF**. Cele de pe ORD din același fișier rămân neatinse, din același motiv
ca la Etapa B.

Un test care verifică faptul vizibil: DF cu aprobarea desfăcută ⇒ trasabilitatea **nu**-l
arată aprobat.

---

## ETAPA D — rulare

```bash
npm test
npx vitest run --config vitest.config.db.mjs server/tests/db/clasa8*.test.mjs
npm run test:db
```

⚠️ Fișierele atinse întâi (secunde), suita completă **o singură dată, la final** — regula din
`CLAUDE.md` (#195). Pe bază **proaspătă**: una refolosită multe rulări devine lentă.
⚠️ `npm test` și `test:db` **secvențial**.
Test preexistent care pică ⇒ **raportează ÎNAINTE** de a-l modifica.

---

## ETAPA E — versiune, commit

```bash
npm version 3.9.850 --no-git-tag-version
npm install --package-lock-only
git diff --stat package-lock.json        # Așteptat: ≤ 4 linii
git status --short
```
⛔ **FĂRĂ** `CACHE_VERSION`, **FĂRĂ** `?v=`.
⚠️ `git add` **explicit, pe fișiere numite**. **Niciodată `git add -A`.**

```
fix(#197): Clasa 8 nu mai consuma buget pe DF cu aprobarea desfacuta — v3.9.850

Cele doua CTE-uri latest_approved_df legau fluxul doar prin "finalizat", fara
deleted_at / cancelled / refused. Anularea administrativa pastreaza DELIBERAT
completed:true ca istoric (#164), face soft-delete pe flux, iar
undoCompletedFlowLinks nu goleste formulare_df.flow_id. Compuse, cele trei
faceau ca un DF cu aprobarea RETRASA sa consume in continuare buget — si, prin
DISTINCT ON ... ORDER BY revizie_nr DESC, sa fie ales tocmai el, peste revizia
aprobata anterior. La utilizator: "Ramane din buget" prea mic si avertisment de
plafon fals la CAB.

Aceeasi clasa a fost reparata in #165-#167 pentru lista, detaliu si aprobate;
uitata in consumul de buget si in trasabilitate. Ambele trec acum prin
validSignedFlowSql — sursa unica, nu un al patrulea predicat scris de mana.

Testele au fost scrise INAINTE si picau pe codul vechi, folosind revizia
desfacuta. Doua cazuri apara comportamentul normal: revizia maxima vie castiga,
iar un dosar cu o singura revizie aprobata ramane neschimbat.

Predicatele ORD din aceleasi fisiere raman neatinse: sunt compensate prin
golirea formulare_ord.flow_id in flow-undo si merita o discutie separata.
```

```bash
git push origin develop
```

---

## RAPORT FINAL — obligatoriu

1. Ancorele din Etapa 0, cu valorile OBȚINUTE (inclusiv confirmarea „zero teste Clasa 8 despre
   fluxuri moarte").
2. ⭐⭐ **Dovada că testul 1 pica pe codul vechi**, cu mesajul de eșec: ce sumă folosea
   (R1 desfăcută) și ce ar fi trebuit (R0).
3. Rezultatul fiecăruia dintre cele 6 cazuri, în special **4 și 5** (anti-regresie).
4. Cele două `old_str` din `clasa8.mjs` și cel din `trasabilitate.mjs`, înainte și după.
5. Confirmarea că predicatele **ORD** au rămas neatinse în ambele fișiere.
6. Numere reale `npm test` / `test:db`, secvențial, pe bază proaspătă.
7. Fișierele stage-uite, pe nume. Confirmarea `git push origin develop`.
8. Teste preexistente atinse. (Așteptat: **NICIUNUL**.)
9. Divergențe prompt↔cod — raportate, **NU** reparate tăcut.
10. Constatări colaterale. În special: mai există în `server/` vreun consumator de buget sau
    de plafon care derivă „aprobat" fără gărzile de flux viu?

---

## ⛔ CONSTRÂNGERI ABSOLUTE

- `develop` ONLY. Zero migrații. Zero scrieri în baza de date.
- ⛔ **Testele înainte de corecție**, și trebuie să pice pe codul vechi. Fără dovada asta,
  lotul nu e complet.
- ⛔ Se schimbă **un singur predicat**, în trei locuri (2 × `clasa8.mjs`, 1 × `trasabilitate.mjs`).
- ⛔ `dosarKeyExpr`, `DISTINCT ON`, `ORDER BY`, filtrele și agregatele — **neatinse**.
- ⛔ Predicatele ORD — **neatinse**.
- ⛔ `flow-provenance.mjs` — **neatins**, nici măcar comentariile.
- ⛔ Nicio consolidare colaterală: reconul #196 a stabilit că restul nu merită. Nu o relua.
- `npm test` și `test:db` **secvențial**.
- `git add` explicit, niciodată `-A`.
- `old_str` care nu se potrivește exact ⇒ **OPREȘTE-TE și raportează**.
