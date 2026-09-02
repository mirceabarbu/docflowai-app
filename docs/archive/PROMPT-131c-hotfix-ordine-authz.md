# PROMPT #131c — HOTFIX: ordinea ramurilor în `canEditFormular` blochează returnarea și finalizarea

> ## ⚠️ BRANCH: `develop`
> Toate commit-urile pe `develop`. **NU** propune și **NU** executa `checkout main`,
> `merge main`, `push origin main`. Deploy-ul în producție îl face Mircea manual.

**Model recomandat:** Opus 5 — authz, cu schimbare reală de rol.
**Target versiune:** `v3.9.781` (**citește `package.json`**) · **Migrații:** ZERO
**Repară:** un defect introdus de #131a (`8e8555b`). Blochează deploy-ul lotului.

> ⚠️ Mesajul de commit: `git commit -m "subiect"`, o linie, **sintaxă bash**.
> ⛔ Fără `--amend`, fără `--force`.

---

## 1. Simptomul, reprodus pe staging

DF creat de utilizatorul A (compartimentul „Serviciul Buget"), trimis către **compartimentul**
„Serviciul Buget". Utilizatorul B, din același compartiment, deschide documentul:

- vede corect butoanele **„Salvează"** și **„Finalizez secțiunea"**;
- apasă **„Returnează"** ⇒ banner roșu **`forbidden`**.

## 2. Cauza — verificată pe cod

`canEditFormular` (`server/services/authz-formular.mjs`) evaluează în ordine. În blocul
`if (actorComp)`, **prima** ramură este:

```js
    if (await _userIsInComp(pool, doc.created_by, actorComp))
      return { allowed: true, role: 'comp' };  // P1-comp (back-compat)
```

Creatorul e coleg cu actorul ⇒ funcția întoarce rolul **`'comp'`** și se oprește, **înainte** de
ramura `p2_compartiment` adăugată la #131a (plasată la finalul blocului).

`returnFormular` (`server/services/formular-shared.mjs:571-572`) cere:
```js
['admin','assigned','p2_comp'].includes(authz.role) || doc.assigned_to === actor.userId
```
`'comp'` nu e în listă, iar `doc.assigned_to` e **NULL** la atribuirea pe compartiment ⇒ 403.

**⚠️ Nu e singurul buton afectat.** `completeFormular` folosește aceeași listă de roluri ⇒
**„Finalizez secțiunea" ar fi picat identic.** Butoanele apar fiindcă `deriveDocRole`
(`formular-capabilities.mjs`) e o funcție SEPARATĂ, care verifică `p2_compartiment` și întoarce
corect `'p2'`. Interfața și authz-ul dau răspunsuri diferite — asta e forma reală a defectului,
nu un buton stricat.

**Vina e a promptului #131a**, nu a agentului: §7 cerea plasarea „imediat după ramura existentă
`p2_comp`", iar aceea e ultima din bloc.

---

## 3. Fixul

În `canEditFormular`, mută verificarea `p2_compartiment` **la ÎNCEPUTUL** blocului
`if (actorComp)`, înaintea ramurii `'comp'`.

`old_str`:
```js
  if (actorComp) {
    if (await _userIsInComp(pool, doc.created_by, actorComp))
      return { allowed: true, role: 'comp' };  // P1-comp (back-compat)
```
`new_str`:
```js
  if (actorComp) {
    // #131c — ORDINEA E PARTE DIN CONTRACT, nu stil. Atribuirea EXPLICITĂ a documentului
    // către un compartiment (#131a) e o revendicare mai specifică decât „creatorul se
    // întâmplă să-mi fie coleg", deci se evaluează PRIMA. Plasată după ramura `'comp'`
    // (cum era la #131a), ea nu se atingea niciodată când inițiatorul și compartimentul CAB
    // sunt același compartiment — exact configurația din primării — iar `returnFormular` /
    // `completeFormular`, care cer rolul `p2_comp`, răspundeau 403 pe butoane vizibile.
    if (doc.p2_compartiment && String(doc.p2_compartiment).trim() === actorComp)
      return { allowed: true, role: 'p2_comp' };
    if (await _userIsInComp(pool, doc.created_by, actorComp))
      return { allowed: true, role: 'comp' };  // P1-comp (back-compat)
```

Apoi **șterge** ramura `p2_compartiment` din poziția ei actuală (finalul blocului, adăugată la
#131a). ⚠️ Trebuie să rămână **exact una** — o duplicare ar fi inofensivă funcțional dar ar
ascunde intenția. `grep -c` o verifică.

⛔ Nu atinge ordinea `admin` → `creator` → `assigned`, care rămâne înaintea întregului bloc.
⛔ Nu atinge `canEditAlop` (~155-165), care are ramuri cu nume identice pe alt teren.
⛔ Nu adăuga `'comp'` în listele de roluri din `returnFormular` / `completeFormular`. Rolul e
   abstracția; se repară o dată, în locul unde se decide.

---

## 4. ⚠️ Consecința reală de comportament — de testat, nu de presupus

`server/routes/formulare/df.mjs:357` și `ord.mjs:357`:
```js
const isP1 = doc.created_by === actor.userId || authz.role === 'comp' || authz.role === 'admin';
```

Pentru un coleg al inițiatorului, pe un document atribuit compartimentului său, rolul se schimbă
`'comp'` → `'p2_comp'` ⇒ pe ruta PUT devine **P2 în loc de P1**, deci scrie `P2_FIELDS` în loc de
`P1_FIELDS`.

**Asta e schimbarea CORECTĂ** — documentul i-a fost atribuit ca Responsabil CAB, deci e P2 —
și e chiar scopul lui #131a. Practic nu se pierde nimic: la `status='pending_p2'` Secțiunea A e
oricum blocată, deci câmpurile P1 nu erau scriabile.

**Dar verifică pe cod și confirmă în raport**, cu liniile: ce câmpuri devin scriabile și ce
câmpuri nu mai sunt, pentru actorul din acest scenariu. Dacă găsești un câmp P1 pe care un
membru CAB chiar ar trebui să-l poată scrie la `pending_p2`, **raportează, nu repara.**

⚠️ Domeniul de aplicare al schimbării e îngust prin construcție: ramura nouă se declanșează
DOAR când `p2_compartiment` e non-NULL, adică doar pe documente trimise cu funcția livrată la
#131a. **Toate documentele existente au coloana NULL** ⇒ zero regresie pe date reale.
Confirmă asta explicit.

---

## 5. Teste

Fișierul de authz din #131a (`server/tests/db/p2-compartiment-authz.test.mjs`) sau echivalentul
lui — **extinde-l**, nu crea unul nou.

1. ⭐ **Bug-ul raportat, exact:** creator A din compartimentul X, `p2_compartiment = X`,
   `assigned_to = NULL`, actor B din X (≠ A) ⇒ `canEditFormular` întoarce **`'p2_comp'`**.
   Fără fix întoarce `'comp'`.
2. ⭐ **`POST /returneaza` → 200** în scenariul de la 1, cu `status` devenit `'returnat'` și
   `motiv_returnare` scris în DB. Ăsta e testul care ar fi prins defectul; cel de la 1 singur
   nu ajunge — a existat și la #131a un test de authz verde, dar pe alt scenariu.
3. ⭐ **`POST /complete` → 200** în același scenariu. Al doilea buton afectat, neraportat de
   utilizator fiindcă a apăsat „Returnează" primul.
4. **Non-regresie pe `'comp'`:** document **fără** `p2_compartiment` (NULL), creator A din X,
   actor B din X ⇒ rolul rămâne **`'comp'`**, exact ca înainte de lot. Apără ramura P1-comp.
5. Actor din alt compartiment, pe document cu `p2_compartiment = X` ⇒ refuzat.
6. **Creatorul însuși**, membru al compartimentului atribuit ⇒ rămâne **`'creator'`**
   (ramura de deasupra blocului câștigă) ⇒ `returneaza` îi dă 403. Separarea sarcinilor:
   inițiatorul nu-și returnează propriul document. Documentează comportamentul ca INTENȚIONAT.
7. Atribuire pe **PERSOANĂ** (`assigned_to` setat, `p2_compartiment` NULL): rolurile
   `'assigned'` și `'p2_comp'`-prin-assigned rămân **neschimbate**.
8. ⭐ **Poartă de ordine**, ca defectul să nu revină la un refactor: un test care asertează că,
   într-un scenariu în care AMBELE condiții sunt adevărate (creatorul e colegul meu ȘI
   documentul e atribuit compartimentului meu), rolul întors e `'p2_comp'`, nu `'comp'`.
   Comentează în test **de ce** ordinea contează.
9. `deriveDocRole` și `canEditFormular` sunt **de acord** pe același scenariu: prima dă `'p2'`,
   a doua `'p2_comp'`. Divergența dintre ele a fost forma reală a bug-ului — un test care le
   compară o previne.

---

## 6. Rulare, versionare, push

```bash
npm test
npm run test:db
```
⛔ „Skipped" NU e „passed". `test:db` **integral**, pe instanță PG 17 efemeră proaspătă.
Cazurile 2 și 3 lovesc rutele reale — mock-urile poziționale nu pot dovedi fixul.

Bump; `git commit -m "fix(#131c): ordinea ramurilor authz - p2_compartiment inaintea lui comp"`;
`git push origin develop`.

---

## 7. Verificări de ieșire (verbatim în raport)

```bash
# 1 — ramura există EXACT o dată, și e prima din blocul actorComp
grep -n "p2_compartiment" server/services/authz-formular.mjs
grep -c "p2_compartiment" server/services/authz-formular.mjs

# 2 — ordinea, citită direct
sed -n '/if (actorComp) {/,/^  }/p' server/services/authz-formular.mjs

# 3 — listele de roluri NEATINSE
grep -n "'admin','assigned','p2_comp'" server/services/formular-shared.mjs

# 4 — canEditAlop neatins
git diff server/services/authz-formular.mjs | grep -c "canEditAlop"
# Așteptat: 0

# 5 — scop: un singur fișier de producție
git status --short
# Așteptat: package.json, authz-formular.mjs, fișierul de test. ⚠️ working tree-ul are
# fișiere netrackate din sesiuni vechi — confirmă EXPLICIT ce ai stage-uit

# 6 — zero fișiere din public/, zero migrații
git status --short public/ && grep -n "id: '10[0-9]_" server/db/index.mjs | tail -1
```

---

## 8. RAPORT FINAL

- commit hash + push confirmat; versiunea; `git log -1 --pretty=%s`
- `npm test` / `npm run test:db`: **numere REALE**, cu comanda instanței efemere, verbatim
- ieșirea celor 6 verificări, **verbatim**
- ⭐ rezultatele cazurilor **1, 2, 3, 8**, menționate separat, și confirmarea explicită că
  **cazul 2 și cazul 3 PICĂ pe codul de dinainte de fix** (rulează-le o dată pe `8e8555b` sau
  cu ramura mutată înapoi, ca să dovedești că testul prinde chiar defectul — nu doar că trece)
- răspunsul la §4: ce câmpuri devin scriabile și ce câmpuri nu mai sunt pentru actorul din
  scenariu, cu liniile din `df.mjs:357` / `ord.mjs:357` și listele de câmpuri
- confirmarea că toate documentele existente au `p2_compartiment` NULL ⇒ zero regresie pe date
- confirmarea că `canEditAlop`, `returnFormular`, `completeFormular` și `public/` sunt neatinse
- **orice abatere.** Dacă găsești o eroare în prompt, **spune-o, nu o repara tăcut**

---

## 9. ⛔ Constrângeri absolute

⛔ Branch `develop`. Fără `main`, fără `--amend`, fără `--force`.
⛔ UN SINGUR fișier de producție atins: `server/services/authz-formular.mjs`.
⛔ Zero migrații, zero fișiere din `public/`, zero `CACHE_VERSION`.
⛔ Ramura `p2_compartiment` apare EXACT o dată, prima în blocul `if (actorComp)`.
⛔ Ordinea `admin` → `creator` → `assigned` rămâne deasupra blocului, neatinsă.
⛔ `canEditAlop` neatins.
⛔ Nu adăuga `'comp'` în listele de roluri ale rutelor — se repară rolul, nu consumatorii.
⛔ Zero refactorizări în trecere.
