# DF cu `nr_unic_inreg` duplicat — lanțul de revizii cheiat pe dosarul ALOP

**Data analizei:** 12.08.2026 · **Fix:** #126, v3.9.755 · **Migrații:** niciuna

## Ce s-a găsit în producție

Interogare de diagnostic pe `formulare_df` (org reală, `deleted_at IS NULL`):
**7 documente, 3 coliziuni de număr.**

| nr | doc A | doc B | doc C |
|---|---|---|---|
| 40339 „Anunt ziar Național" | 5/5 semnat, ALOP *ordonantare* | 3/4 semnat, ALOP *angajare* | — |
| 42320 „Contravaloarea Serviciilor…" | 1/5, flux **anulat** | 5/5 semnat, ALOP *angajare* | — |
| 6736 „Servicii Spatii Verzi" | 1/5, flux **refuzat** | 5/5 semnat, ALOP *ordonantare* | 4/5 semnat, ALOP *angajare* |

`source_alop_id` e **DIFERIT** la toate ⇒ sunt **dosare ALOP independente**, nu duplicate
tehnice (dedup-ul din migrarea 095 n-a ratat nimic).

**Tiparul real:** utilizatorii deschid un dosar ALOP NOU pentru o cheltuială următoare pe
același obiect și **refolosesc numărul din registratură**.

**Decizia de produs (Mircea):** continuarea unei cheltuieli pe același obiect se face printr-o
**REVIZIE (R1) a DF-ului existent**, nu printr-un dosar nou cu același număr. Revizia păstrează
numărul și lanțul de trasabilitate.

## De ce NU există (și nu poate exista) index unic pe `nr_unic_inreg`

⛔ Curățarea completă a datelor e **imposibilă**: la 40339 și 6736 câte **două** documente au
semnături QES aplicate — au ieșit din aplicație (PDF semnat, posibil depus la trezorerie).
Un `CREATE UNIQUE INDEX` ar fi respins de datele existente, iar „repararea" lor ar însemna
rescrierea unor documente semnate.

**Nu propune un index unic pe număr.** După fixul structural de mai jos, un număr duplicat e
**confuz, nu corupător** — iar garda de la PUT împiedică apariția unora noi.

## Fixul structural — cheia lanțului e DOSARUL, nu numărul

Identitatea lanțului de revizii era **deja** dosarul la nivel de constrângere: indexul unic
`df_source_alop_revizie_uniq (source_alop_id, revizie_nr)` (migrarea 095), iar `/revizuieste`
copiază `source_alop_id` în revizia nouă. Dar interogările încă grupau pe număr — inconsecvent
cu propriul index.

Expresia de cheie, definită **o singură dată** în `server/services/df-dosar-key.mjs`:

```sql
COALESCE(fd.source_alop_id::text, fd.nr_unic_inreg)
```

- DF cu dosar ⇒ grupare pe dosar (corect);
- DF **legacy** (fără `source_alop_id`) ⇒ fallback pe număr = exact comportamentul de dinainte.

⛔ **NU** `COALESCE(source_alop_id::text, id::text)` — ar rupe lanțurile legacy (fiecare revizie
ar deveni un lanț separat).

### Interogări mutate pe cheia de dosar

| # | Loc | Simptomul de dinainte |
|---|-----|----------------------|
| 1 | `routes/formulare/df.mjs` — `/revizuieste`, `MAX(revizie_nr)` | după ce un dosar ajungea la R1, celălalt primea „Această revizie (R0) nu mai este cea curentă" **pe viață** |
| 2 | `routes/formulare/df.mjs` — `/aprobate`, `DISTINCT ON` | un DF aprobat **dispărea** din dropdown-ul de creare ORD ⇒ nu se mai putea face ORD pe el |
| 3 | `routes/formulare/df.mjs` — GET detaliu, `latest_revizie_nr` + `has_newer_revision` | document marcat „are revizie mai nouă" din cauza unui **dosar străin** |
| 4 | `routes/formulare/df.mjs` — `/:id/revizii` | reviziile ambelor dosare într-un singur lanț („R0 ✓ | R0 ⏳") |
| 5 | `routes/formulare/shared.mjs` — `/api/formulare/list` (lista reală din UI), `has_newer_revision` | badge „istoric" pus de un dosar străin |
| 6 | `services/trasabilitate.mjs` — Q1 + Q2 (lanțul de revizii DF) | modalul „Trasabilitate" afișa reviziile ambelor dosare |

Garda **„doar revizia cea mai recentă poate fi revizuită" RĂMÂNE** — se aplică acum doar în
interiorul dosarului.

### Gardă la PUT — doar la SCHIMBAREA efectivă a numărului

`PUT /api/formulare-df/:id` respinge cu `409 nr_unic_duplicat` **doar** când numărul chiar se
schimbă (`TRIM(nou) !== TRIM(vechi)`) și numărul nou e folosit de **alt dosar**, la aceeași
revizie.

⚠️ O gardă necondiționată ar **bloca documentele vii** aflate deja în coliziune: la 40339,
documentul nou n-ar mai putea fi salvat deloc. Efect obținut: coliziunile **existente** rămân
salvabile, dar nu se mai pot **crea** altele.

Mesajul îndrumă spre calea corectă (altfel utilizatorii inventează „40339/2" și se pierde
trasabilitatea):

> Numărul `<nr>` este deja folosit de alt document. Dacă e o cheltuială următoare pe același
> obiect, nu deschideți un dosar nou — **revizuiți documentul existent** (butonul Revizuiește
> pe DF-ul aprobat), revizia păstrează numărul.

⛔ Garda **NU** se aplică pe `/revizuieste` — acolo copierea numărului e legitimă.

### Avertisment în listă

Lista DF marchează documentele cu număr partajat de alt DOSAR cu un badge discret
„⚠ nr. partajat" (`nr_partajat`, calculat **server-side** în `/api/formulare/list`).
Nu blochează nimic — e doar semnal.

## Ce a rămas deliberat pe număr

- `POST /api/formulare-df` — verificarea de duplicat la **creare** (`409 nr_unic_duplicat`)
  rămâne pe număr: la creare încă nu există un dosar de comparat, iar scopul e exact să nu se
  mai nască coliziuni noi.
- `services/clasa8.mjs` — **REZOLVAT în #127 (12.08.2026, v3.9.756).** `DISTINCT ON` pentru
  „ultima revizie aprobată" (raportul Clasa 8 + verificarea de plafon `getBugetDisponibil`)
  cheia acum pe DOSARUL ALOP (`dosarKeyExpr` din `df-dosar-key.mjs`), nu pe `nr_unic_inreg`.
  **Impact financiar înainte de fix:** două dosare ALOP diferite cu același număr ⇒ `DISTINCT
  ON (nr_unic_inreg)` păstra un singur DF ⇒ angajamentele bugetare (col.10) ale celuilalt
  dosar erau **sub-numărate complet** în raportul Clasa 8. Mai grav, la `getBugetDisponibil`
  (verificarea de plafon apelată de CAB la completarea Sec.B), excluderea `excludeDfId` compara
  pe număr ⇒ exclude un DOSAR STRĂIN care doar întâmplător partajează numărul, nu doar dosarul
  propriu ⇒ plafonul se putea valida față de un consum sub-raportat, permițând angajarea de
  cheltuieli PESTE creditele bugetare aprobate. Aceeași clasă de bug cu #115 (plată
  sub-numărată), de data asta pe bani ANGAJAȚI, nu plătiți.
- `services/alop-link.mjs` — self-heal-ul folosește `nr_unic_inreg` ca al doilea criteriu, dar
  ancorat pe `a.df_id`/`source_alop_id`, deci nu amestecă dosare.

## Teste

`server/tests/db/df-revizii-pe-dosar.test.mjs` — fixtură care REPRODUCE producția (două dosare
ALOP diferite, ambele DF cu `nr_unic_inreg = '40339'`): revizuire independentă, ambele în
`/aprobate`, lanț `/revizii` separat, `has_newer_revision` pe dosar, PUT nemodificat ⇒ 200,
PUT cu număr schimbat în coliziune ⇒ 409 (inclusiv normalizarea spațiilor), lanț **legacy**
fără regresie, badge-ul de număr partajat.

`server/tests/db/clasa8-dosar-key.test.mjs` (#127) — aceeași fixtură de coliziune, pe agregatul
Clasa 8: raportul însumează angajamentele AMBELOR dosare (nu doar unul), `getBugetDisponibil`
cu `excludeDfId` NU mai exclude dosarul STRĂIN care partajează numărul, excluderea rămâne
corectă ÎN INTERIORUL dosarului propriu (R0+R1 excluse împreună, fără dublă numărare), lanțul
legacy (`source_alop_id` NULL) nu regresează, non-regresie pe un singur dosar cu R0→R1→R2.
