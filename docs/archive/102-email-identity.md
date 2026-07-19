---
prompt: 102
titlu: "sec(identity): clasa «email = identitate» — deleted_at IS NULL pe cele 7 căutări după email"
model_suggested: Opus 4.8
branch: develop
zona: server/routes/flows/{crud,lifecycle,signing,cloud-signing}.mjs, teste
versiune_tinta: v3.9.688
---

# ⚠️ BRANCH: develop

> Lucrezi **EXCLUSIV** pe `develop`. `main` = **producție (v3.9.682)**, gestionat manual de Mircea.
> ⛔ NU face merge / push / checkout pe `main`.
>
> ⚠️ **COLIZIUNE DE NUME — citește de două ori:**
> - `server/signing/*` = **NO-TOUCH** (cloud-signing, bulk-signing, pades, java-pades-client, STSCloudProvider). **Interzis.**
> - `server/routes/flows/signing.mjs` și `server/routes/flows/cloud-signing.mjs` = **alte fișiere**, pe care **le modifici la acest prompt**.
>
> Verifică de fiecare dată calea completă înainte să deschizi un fișier. O greșeală aici nu strică
> un afișaj — strică metadatele dintr-un document semnat.

---

## CONTEXT

Migrația 067 a înlocuit `UNIQUE(email)` cu un index **parțial**:

```sql
CREATE UNIQUE INDEX users_email_active_uniq ON users (lower(email)) WHERE deleted_at IS NULL;
```

Adică: **un email poate exista de mai multe ori în tabelă** — o dată pe un utilizator activ, de câte
ori vrei pe utilizatori șterși (soft-delete). Unicitatea se aplică doar printre cei activi.

Șapte query-uri nu știu asta. Toate caută `WHERE email=$1` **fără `deleted_at IS NULL`**:

| Fișier:linie | Ce citește | Ce se face cu rezultatul |
|---|---|---|
| `routes/flows/crud.mjs:216` | `id, functie, leave_reason` | rezolvă semnatarul + verifică concediul/delegarea **la creare flux** |
| `routes/flows/lifecycle.mjs:394` | `functie` | funcția originalului la delegare |
| `routes/flows/lifecycle.mjs:402` | `nume, functie, compartiment, institutie` | **datele delegatului** → cartuș/afișaj |
| `routes/flows/signing.mjs:529` | `id` | rezolvă semnatarul curent (auto-redirect concediu) |
| `routes/flows/signing.mjs:556` | `functie, leave_reason` | funcția originalului → **cartuș + trust report** |
| `routes/flows/cloud-signing.mjs:612` | `preferred_signing_provider` | providerul preferat al semnatarului |
| `routes/flows/cloud-signing.mjs:881` | `preferred_signing_provider` | idem, pentru actorul logat |

Consecința: după ce un email e reutilizat, `rows[0]` poate fi **rândul utilizatorului șters** — sau
oricare din cele două, nedeterminist, în funcție de ordinea fizică din tabelă. Iar rezultatul ajunge
în **cartușul de semnătură al unui document PAdES**.

⚠️ **Calibrare — nu supralicita:** query-urile-poartă au fost rulate azi pe producție. **Zero**
emailuri reutilizate. Bug-ul e **latent**, nu activ. Reparăm pentru că e o mină, nu pentru că a explodat.

### Al doilea defect, mai mic: forma căutării

Emailurile **sunt** lowercase-uite la scriere (`admin/users.mjs:182, 450, 528`), iar query-urile
trimit parametrul lowercase — deci merge azi. Dar indexul e pe `lower(email)`, iar căutarea e pe
`email`. Forma canonică — care se aliniază cu indexul și rezistă unui rând legacy scris înainte de
disciplina lowercase — e `WHERE lower(email) = $1`.

Le atingem oricum. Le facem corect.

---

## PAS 0 — RECON (read-only)

```bash
sed -n '210,232p' server/routes/flows/crud.mjs
sed -n '390,406p' server/routes/flows/lifecycle.mjs
sed -n '525,562p' server/routes/flows/signing.mjs
sed -n '605,618p;875,886p' server/routes/flows/cloud-signing.mjs
grep -rn "getActiveSigner" server/services/user-leave.mjs | head -3
```

**Query pe producție (read-only) — răspunde în raport:**

```sql
-- Există rânduri cu email NE-lowercase (legacy, dinainte de disciplina de la admin/users.mjs)?
SELECT COUNT(*) FROM users WHERE email <> lower(email);
```

Dacă e > 0, trecerea la `lower(email)=$1` **repară** căutări care azi dau greș tăcut. Raportează cifra.

---

## PAS 1 — Forma canonică, în toate cele 7

Pentru **fiecare** din cele 7 situri:

```sql
--  ÎNAINTE
WHERE email = $1

--  DUPĂ
WHERE lower(email) = $1
  AND deleted_at IS NULL
```

Parametrul rămâne cel de azi (deja `.toLowerCase()`-uit la apelant — **verifică**, nu presupune).

Adaugă la fiecare un comentariu scurt, o singură linie:
```js
// SEC-102: migrația 067 permite REUTILIZAREA emailului după soft-delete ⇒ fără deleted_at,
// rows[0] poate fi utilizatorul ȘTERS. lower(email) se aliniază cu users_email_active_uniq.
```

⛔ **Nu factoriza cele 7 într-un helper comun.** Contextele diferă (coloane diferite, tratamente
diferite ale rezultatului gol), iar un helper prost tăiat pe calea de semnare e mai scump decât
șapte linii duplicate. Dacă simți nevoia să abstractizezi, **nu**.

⛔ **Nu atinge nimic altceva în aceste fișiere.** Nici formatare, nici „mici îmbunătățiri", nici
căutările pe `id=$1` (id-ul e cheie primară — nu se reutilizează, nu e afectat).

---

## PAS 2 — Ce se întâmplă când rezultatul devine gol (CITEȘTE, nu sări)

Filtrul face ca un utilizator șters să **nu mai fie găsit**. Fiecare sit are deja o ramură pentru
„nu l-am găsit" — **verifică-le pe toate 7 și confirmă în raport că nu crapă**:

- `crud.mjs:219` — `if (uRows.length)` ⇒ sare peste auto-redirect. OK.
- `lifecycle.mjs:397` — `_origFunctie = ''`. OK (semnatarii externi n-au rând în `users` oricum).
- `lifecycle.mjs:404` — `delegatDb = {}` ⇒ numele delegatului cade pe email. **Vezi PAS 3.**
- `signing.mjs:532` — `if (!uRows.length) return false` ⇒ fără auto-redirect. **Vezi PAS 3.**
- `signing.mjs:559` — `catch` + valori implicite. OK.
- `cloud-signing.mjs:614, 880` — `preferred = null` ⇒ se cade pe providerul org-ului. OK.

⛔ **Nu „repara" niciuna dintre aceste ramuri.** Comportamentul la rezultat gol rămâne exact cel de azi.

---

## PAS 3 — DOUĂ întrebări de politică. Le RAPORTEZI, nu le rezolvi.

Filtrul schimbă comportamentul în două locuri. **Nu decide singur. Nu scrie cod pentru ele.**

**(a) `lifecycle.mjs:402` — delegare către un cont dezactivat.**
Azi: rândul celui șters e găsit, delegarea trece cu numele lui. După fix: nu-l mai găsim, delegarea
**trece în continuare**, dar cu emailul pe post de nume. Filtrul **nu blochează** delegarea către un
cont dezactivat — doar degradează afișajul.
Întrebarea pentru owner: *ar trebui delegarea către un utilizator soft-șters să fie REFUZATĂ (400)?*
Complicație: delegarea către un email **care nu e deloc utilizator** (semnatar extern) e legitimă și
funcționează azi. Deci o gardă ar trebui să distingă „utilizator șters" de „niciun utilizator" — două
query-uri, nu unul.

**(b) `signing.mjs:529` — semnatar curent cu cont dezactivat.**
Azi: îl găsim, îi verificăm concediul, poate se face auto-redirect către delegat. După fix:
`return false` ⇒ **niciun auto-redirect**, fluxul rămâne blocat pe el.
Întrebarea pentru owner: *un cont dezactivat, aflat la rând să semneze, ar trebui să declanșeze
redirectul către delegat mai AGRESIV, nu mai puțin?*

**Scrie în raport ce ai găsit și ce s-ar întâmpla. Zero cod pe punctele astea.**

---

## PAS 4 — Teste (⛔ IMPORTĂ din producție — nu redeclara logica)

**DB** — `server/tests/db/email-identity.test.mjs`, Postgres real. Ăsta e testul care contează:
scenariul de reutilizare a emailului **nu se poate simula credibil cu mock-uri**.

Tiparul pentru două organizații / mai mulți useri: `seedOrgUser({ orgName: 'Org 2', email: '…' })`
(vezi `alop-tranzitii-garzi.test.mjs:97`). ⚠️ `organizations.name` e UNIQUE — nume distinct **și**
email distinct, altfel pică CI-ul (s-a întâmplat la #100.2).

1. **Reutilizare email — cazul central:** user A cu `x@y.ro`, `functie='Primar'` ⇒ soft-delete
   (`UPDATE users SET deleted_at=NOW()`) ⇒ user B nou, activ, **același** `x@y.ro`, `functie='Secretar'`.
   Creează un flux cu `x@y.ro` ca prim semnatar ⇒ funcția rezolvată trebuie să fie **`'Secretar'`**.
   *Fără fix, testul poate trece accidental (ordinea fizică a rândurilor) — deci forțează ordinea:
   verifică întâi cu un `SELECT ... FROM users WHERE email='x@y.ro'` fără filtru că întoarce 2 rânduri,
   apoi asertează pe funcția rezolvată de codul de producție.*
2. **Utilizator șters, fără înlocuitor:** `x@y.ro` doar pe un rând șters ⇒ căutarea întoarce gol ⇒
   codul **nu crapă** și cade pe comportamentul de „negăsit" (fluxul se creează, funcția e goală).
3. **Email ne-lowercase:** user activ salvat cu `Mircea@Y.ro` ⇒ căutarea cu `mircea@y.ro` **îl găsește**
   (dovada că `lower(email)=$1` repară, nu doar decorează).

**Unit** — dacă vreunul din cele 7 e izolabil cu `pool` mock, adaugă o aserție pe **SQL-ul** primit:
conține `lower(email)` **și** `deleted_at IS NULL`. Nu forța: valoarea reală e în testele DB.

---

## PAS 5 — Versiune

`package.json` → **v3.9.688**. Zero fișiere în `public/` ⇒ fără `?v=`, fără `CACHE_VERSION`.

```bash
npm run check && npm test && npm run test:db
```

Commit:
```
sec(identity): deleted_at IS NULL + lower(email) pe cele 7 căutări după email (v3.9.688)
```

---

## RAPORT FINAL

1. `SELECT COUNT(*) FROM users WHERE email <> lower(email)` — ce a dat?
2. **Toate 7** sunt reparate? `grep -rn "WHERE email=\$1\|WHERE email = \$1" server/routes/ server/services/` ⇒ trebuie **gol**.
3. Toate 7 folosesc `lower(email)=$1` **și** `deleted_at IS NULL`? Lipește cele 7 linii.
4. Ai verificat că parametrul e deja lowercase la fiecare apelant? Unde **nu** era?
5. **PAS 3 — cele două întrebări de politică.** Ce ai găsit? (Doar raport. Ai scris cod pentru ele? **Trebuie să fie NU.**)
6. Testul #1 (reutilizare email ⇒ funcția utilizatorului ACTIV) — verde în CI? Lipește.
7. Testul #3 (email ne-lowercase ⇒ găsit) — verde?
8. Ai atins `server/signing/*`? `git diff --name-only | grep "^server/signing/"` ⇒ trebuie **gol**.
9. Ai factorizat cele 7 într-un helper? (**Trebuie să fie NU.**)
10. `git diff --name-only` — lipește. `npm test` și `npm run test:db`, **separat**, ambele verzi.

---

## ⛔ CONSTRÂNGERI ABSOLUTE

- ⛔ `server/signing/*` — **NO-TOUCH**. Fișierele din `server/routes/flows/` sunt altele.
- ⛔ **Zero helper comun.** Șapte linii, șapte locuri.
- ⛔ **Zero modificări de comportament** la rezultat gol. Ramurile existente rămân cum sunt.
- ⛔ **Zero cod** pentru cele două întrebări din PAS 3. Doar raport.
- ⛔ Nu atinge căutările pe `id=$1`. Nu atinge `flow-transmit.mjs` (deja curat).
- ⛔ Zero modificări în `public/`.
