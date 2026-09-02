# PROMPT #131a — Responsabil CAB pe COMPARTIMENT (backend)

> ## ⚠️ BRANCH: `develop`
> Toate commit-urile pe `develop`. **NU** propune și **NU** executa `checkout main`,
> `merge main`, `push origin main`. Deploy-ul în producție îl face Mircea manual.

**Model recomandat:** Opus 5 — atinge authz, vizibilitatea listelor și capabilitățile care
decid ce butoane vede utilizatorul.
**Target versiune:** `v3.9.779` (**citește `package.json`** — dacă #130 n-a aterizat încă, ia
următorul număr real) · **Migrații: UNA (108)**

Lotul e **strict backend**. Modalul și coloana din listă vin în #131b. La finalul lui #131a,
funcționalitatea e completă pe server dar inaccesibilă din interfață — deliberat, ca să poată fi
revertită fără a lăsa un modal care trimite către o rută inexistentă.

> ⚠️ Mesajul de commit: `git commit -m "subiect"`, o linie, **sintaxă bash**.
> ⛔ Fără `--amend`, fără `--force`.

---

## 1. Cererea (decizia de produs a lui Mircea)

Cel care creează un DF sau ORD trebuie să poată alege ca Responsabil CAB **fie o persoană
anume** (comportamentul de azi, pentru strictețe), **fie un întreg compartiment** — caz în care
orice membru al acelui compartiment poate completa Secțiunea B.

## 2. Ce EXISTĂ deja și ce lipsește — verificat pe cod

**Există:** `canEditFormular` (`server/services/authz-formular.mjs:90-92`) are rolul `p2_comp` —
dacă persoana asignată e în compartimentul actorului, actorul POATE edita. Editarea „pe
compartiment" e deci deja pe jumătate implementată.

**Lipsește, și e o inconsecvență care mușcă azi:** predicatul de vizibilitate al listelor
(`server/routes/formulare/shared.mjs:468-480` pentru DF, `618-630` pentru ORD) acoperă doar
documentele mele, cele asignate mie, și cele **create** de cineva din compartimentul meu. Nu are
oglinda pentru `p2_comp`. ⇒ **un coleg poate edita un document pe care nu-l găsește în listă.**
Se repară în acest lot, indiferent de restul.

**Lipsește complet:** ținta „compartiment" la trimitere, notificarea întregului compartiment, și
recunoașterea rolului P2 în capabilități când `assigned_to` e NULL.

---

## 3. Deciziile de model — nu le schimba fără să raportezi

1. **Coloană nouă `p2_compartiment TEXT`** pe `formulare_df` și `formulare_ord`.
2. **EXCLUSIVITATE**: `assigned_to` XOR `p2_compartiment`. Niciodată amândouă. Un document are
   un singur răspuns la „cine e responsabil"; două surse ar diverge în listă, în notificări și
   în audit.
3. **Compartimentul ales poate fi oricare** din organizație care are cel puțin un utilizator
   activ. `organizations.cab_compartiment` (din #59) rămâne doar o valoare implicită sugerată
   în UI — ⛔ nu o transforma într-o restricție pe server.
4. **Nu există „revendicare"**: primul membru care completează NU devine `assigned_to`.
   Documentul rămâne al compartimentului; cine a lucrat se citește din `updated_by`.
   ⛔ Nu implementa revendicare în acest lot.
5. **Fără backfill.** Coloana e nullable, fără `DEFAULT`, fără `NOT NULL`. Documentele existente
   rămân pe `assigned_to` — aceeași disciplină ca la migrația 106.

---

## 4. NO-TOUCH

⛔ `server/signing/**`, `server/routes/flows/**`
⛔ `getAlopP2UserIds` / `isInAlopP2Comp` (`authz-formular.mjs:110-145`) — ALOP e alt teren
⛔ Ramura `cab_dept` din `canEditFormular` și `isCabDept` — rămân exact cum sunt
⛔ `public/**` în întregime — frontend-ul e #131b
⛔ Zero refactorizări în trecere

---

## 5. Etapa A — migrația 108

```bash
grep -n "id: '10[0-9]_" server/db/index.mjs | tail -3
# Așteptat: ultima e 107_formulare_capturi_uniq_bloc. Altfel OPREȘTE-TE și raportează.
```

```js
  {
    // #131a — Responsabilul CAB poate fi un COMPARTIMENT, nu doar o persoană. Exclusiv cu
    // `assigned_to`: exact una dintre cele două e non-NULL. Nullable, fără DEFAULT, fără
    // backfill — documentele existente rămân pe `assigned_to`, comportament neschimbat.
    // ⛔ Fără CHECK de exclusivitate în DB: rândurile istorice au ambele NULL (draft
    // netrimis), iar un CHECK ar trebui să tolereze și cazul ăla — poarta stă în
    // `submitFormular`, unde e și mesajul de eroare util.
    id: '108_formulare_p2_compartiment',
    sql: `
      ALTER TABLE formulare_df  ADD COLUMN IF NOT EXISTS p2_compartiment TEXT;
      ALTER TABLE formulare_ord ADD COLUMN IF NOT EXISTS p2_compartiment TEXT;
    `
  }
```

⛔ Fără `UPDATE`, fără index, fără `NOT NULL`, fără fișier `.sql` nou.

---

## 6. Etapa B — trimiterea (`server/services/formular-shared.mjs`, `submitFormular`)

### B.1 Intrarea

Azi: `const { assigned_to } = body || {}; if (!assigned_to) return 400`.

Nou: acceptă **`assigned_comp`** ca alternativă. Reguli, în ordine:

- niciunul ⇒ 400 `{ error: 'assigned_to obligatoriu' }` (**mesaj neschimbat**, ca frontendul
  vechi din cache să se comporte identic);
- amândouă ⇒ 400 `{ error: 'assigned_ambiguu', message: 'Alegeți fie o persoană, fie un compartiment.' }`;
- doar `assigned_comp` ⇒ calea nouă.

### B.2 Validarea compartimentului

Oglindește validarea existentă a persoanei (`SELECT ... FROM users WHERE id=$1 AND org_id=$2`):

```js
    // #131a — compartimentul trebuie să existe în organizație cu cel puțin un utilizator ACTIV.
    // `TRIM` pe ambele părți + refuz pe șir gol: aceeași convenție ca `_userIsInComp`
    // (authz-formular.mjs:64), altfel un compartiment scris cu spații ar crea un document
    // pe care nimeni nu-l poate edita.
    const compTrim = String(assigned_comp || '').trim();
    if (!compTrim) return { status: 400, body: { error: 'compartiment_invalid' } };
    const { rows: membri } = await pool.query(
      `SELECT id, email FROM users
        WHERE org_id=$1 AND TRIM(compartiment)=$2 AND TRIM(compartiment)<>''
          AND deleted_at IS NULL`,
      [actor.orgId, compTrim]
    );
    if (!membri.length) return { status: 400, body: { error: 'compartiment_fara_membri',
      message: 'Compartimentul selectat nu are utilizatori activi.' } };
```

⚠️ Verifică pe cod dacă `users` chiar are `deleted_at` (soft-delete din migrația 067) și dacă
mai există alte condiții de „activ" folosite prin proiect (ex. un `status`). **Folosește exact
predicatul deja folosit la dropdown-ul de semnatari** (`GET /users` din `admin/users.mjs`, sau
`/api/formulare/utilizatori-org` din `shared.mjs:358`) și **spune în raport de unde l-ai luat.**
⛔ Nu inventa un predicat de „utilizator activ" propriu — ar diverge de restul aplicației.

### B.3 UPDATE-ul

Calea cu persoană rămâne **byte-identică**. Calea cu compartiment scrie oglinda:
`assigned_to=NULL, p2_compartiment=$comp`. Ambele setează `status='pending_p2'`,
`submitted_at=NOW()`, `motiv_returnare=NULL`, `updated_by`.

⚠️ Calea cu persoană trebuie să scrie **și** `p2_compartiment=NULL` — altfel o retrimitere
către o persoană, după una către compartiment, ar lăsa ambele setate și ar rupe exclusivitatea.
Are caz de test dedicat.

### B.4 Notificarea

Azi: `await sendNotif(assigned_to, ...)`. Pe calea cu compartiment: același apel pentru
**fiecare** membru din `membri`, **excluzând** `actor.userId` (cine trimite nu se notifică pe
sine).

⚠️ `sendNotif` (`formular-shared.mjs:30`) e per utilizator și înghite erorile — nu bloca
trimiterea dacă o notificare pică. Rulează-le secvențial, nu în `Promise.all`: un compartiment
mare ar deschide zeci de conexiuni deodată din pool.

⚠️ Textul notificării: refolosește `cfg.notif.submit.message(actor, doc)` **neschimbat**.
⛔ Nu inventa un al doilea text pentru cazul compartiment; dacă simți nevoia, raportează.

### B.5 Auditul

`recordFormularAudit` cu `eventType: 'trimis_p2'` rămâne, dar `meta` devine
`{ assigned_to }` **sau** `{ assigned_comp: compTrim, membri: membri.length }`.
⛔ Zero tipuri noi de eveniment (`audit-labels-sync.test.mjs` ar cere traduceri noi).

---

## 7. Etapa C — authz (`server/services/authz-formular.mjs`)

În `canEditFormular`, **imediat după** ramura existentă `p2_comp` (linia ~90-92), adaugă:

```js
    // #131a — Responsabil CAB = COMPARTIMENT. Când documentul e atribuit unui compartiment
    // (`assigned_to` NULL), orice membru al lui e P2. Convenția de comparație e identică cu
    // `_userIsInComp`: TRIM pe ambele părți, șirul gol nu se potrivește cu nimic.
    if (doc.p2_compartiment && String(doc.p2_compartiment).trim() === actorComp)
      return { allowed: true, role: 'p2_comp' };
```

⚠️ Rolul întors e **`p2_comp`**, același ca ramura existentă — nu unul nou. Toți consumatorii
(`ord.mjs:358 isP2`, `df.mjs`) îl tratează deja corect; un rol nou ar cere să-i găsești pe toți.
**Verifică asta pe cod și confirmă în raport lista consumatorilor lui `'p2_comp'`.**

⚠️ Poziția: DUPĂ `creator`/`assigned`, ÎNAINTE de `cab_dept`. Ordinea contează pentru rolul
raportat, nu pentru permisiune.

`canViewFormular` deleagă la `canEditFormular` ⇒ se aliniază singură. Confirmă.

---

## 8. Etapa D — vizibilitatea în liste (`server/routes/formulare/shared.mjs`)

**DOUĂ locuri**, DF (~468-480) și ORD (~618-630), cu structură identică. Ambele.

Predicatul de azi, în ramura `actorComp !== ''`:
```
fd.created_by = eu  OR  fd.assigned_to = eu  OR  EXISTS(creatorul e în compartimentul meu)
```

Devine:
```js
              conds.push(`(
                fd.created_by=$${u1}
                OR fd.assigned_to=$${u2}
                OR EXISTS (
                  SELECT 1 FROM users uc
                  WHERE uc.id = fd.created_by
                    AND TRIM(uc.compartiment) = $${c1}
                    AND TRIM(uc.compartiment) <> ''
                )
                -- #131a — document atribuit COMPARTIMENTULUI meu.
                OR TRIM(COALESCE(fd.p2_compartiment,'')) = $${c1}
                -- #131a — oglinda lipsă a lui `p2_comp`: document atribuit unei PERSOANE din
                -- compartimentul meu. `canEditFormular` îmi dă deja dreptul de editare
                -- (authz-formular.mjs:90-92), dar documentul nu apărea în listă ⇒ puteam edita
                -- ceva ce nu puteam găsi. Inconsecvență de dinaintea acestui lot.
                OR EXISTS (
                  SELECT 1 FROM users up
                  WHERE up.id = fd.assigned_to
                    AND TRIM(up.compartiment) = $${c1}
                    AND TRIM(up.compartiment) <> ''
                )
              )`);
```

⚠️ `$${c1}` e refolosit de patru ori — **verifică pe cod dacă `params.push` a fost apelat o
singură dată pentru el** (așa e azi) și NU adăuga apeluri noi. Un `params.push` în plus
decalează toți indecșii de după și rupe tăcut filtrele și paginarea.

⚠️ Ramura `actorComp === ''` (utilizator fără compartiment) rămâne **neschimbată** — fără
compartiment nu poate exista potrivire.

### D.2 Filtrul „Responsabil CAB"

`shared.mjs:517` și `:663` caută pe `u2.email`/`u2.nume`. Cu atribuire pe compartiment, `u2` e
NULL ⇒ documentul nu s-ar găsi niciodată. Extinde ambele condiții cu
`OR TRIM(COALESCE(fd.p2_compartiment,'')) ILIKE <același pattern>`.
⚠️ Refolosește indexul de parametru deja împins, nu împinge unul nou.

### D.3 Coloana afișată

`COALESCE(u2.nume, u2.email) AS p2` (`:578` și `:698`) devine:
```sql
          COALESCE(u2.nume, u2.email, NULLIF(TRIM(fo.p2_compartiment),'')) AS p2,
          NULLIF(TRIM(fo.p2_compartiment),'') AS p2_compartiment,
```
Câmpul separat `p2_compartiment` e pentru #131b, ca frontendul să poată marca vizual
„compartiment" vs „persoană" fără să ghicească din text.

---

## 9. Etapa E — capabilitățile (`server/services/formular-capabilities.mjs`) ⚠️ partea delicată

**Problema:** `deriveDocRole(doc, actor)` întoarce `'p1' | 'p2' | 'view'` pe baza lui
`created_by`/`assigned_to`. Cu `assigned_to` NULL, un membru al compartimentului primește
`'view'` și cade pe ramura de **fallback** de la finalul funcției, care setează
`can_send_p2: true, can_reset: true`. ⇒ Responsabilul CAB ar vedea butonul **„Trimite la
Responsabil CAB"** în loc de „Finalizez secțiunea". Exact inversul comportamentului corect.

**Soluția impusă — parametru OPȚIONAL, semnătură retrocompatibilă:**

```js
export function deriveDocRole(doc, actor, actorComp = '') {
  const uid = actor?.userId;
  if (doc?.created_by === uid) return 'p1';
  if (doc?.assigned_to === uid) return 'p2';
  // #131a — Responsabil CAB pe COMPARTIMENT: membrul compartimentului atribuit e P2.
  // Verificat DUPĂ p1/p2 nominal, ca un creator care e și în compartiment să rămână p1.
  const c = String(actorComp || '').trim();
  if (c && String(doc?.p2_compartiment || '').trim() === c) return 'p2';
  return 'view';
}

export function computeDocCapabilities(doc, actor, ft, actorComp = '') { ... }
```

Funcția rămâne **PURĂ** — `actorComp` vine ca argument, nu din DB.

### E.1 Locurile de apel — 14, toate de inventariat

```bash
grep -rn "computeDocCapabilities(" server/ --include=*.mjs | grep -v tests
```

Pentru **fiecare**: dacă `actorComp` e deja în scope (handlerul a chemat `loadActorComp` sau
`loadActorCompAndCab`), pasează-l. Dacă nu e, **lasă apelul neschimbat** — implicitul `''`
reproduce exact comportamentul de azi.

⚠️ Prioritatea absolută: **rutele de DETALIU** (`df.mjs:198`, `ord.mjs:171`) — de acolo își ia
frontendul `ST.docCapabilities`, deci ele decid ce butoane vede omul. Dacă `actorComp` nu e în
scope acolo, **adaugă `loadActorCompAndCab`** (handlerul îl cheamă oricum pentru authz —
verifică; dacă da, refolosește-l, nu-l chema a doua oară).

⚠️ Al doilea ca importanță: răspunsul lui `completeFormular` (`formular-shared.mjs:547`) și al
PUT-urilor — după ce un membru al compartimentului salvează, caps-urile din răspuns trebuie să
rămână cele de P2, altfel interfața comută în P1 sub degetele lui.

**Raportează tabelar toate cele 14: fișier:linie · a primit `actorComp`? · de ce.**
Un apel lăsat fără `actorComp` unde ar fi trebuit pasat = bug tăcut de interfață.

### E.2 `can_reopen` (din #129)

Conține `role === 'p1' || actor?.role === 'admin' || 'org_admin'`. Un membru al compartimentului
devine acum `role === 'p2'` ⇒ **nu** capătă „Redeschide". Corect — verifică și confirmă.

---

## 10. Etapa F — teste

### F.1 Authz (`authz-formular`)
1. ⭐ `doc.p2_compartiment='Serviciul Buget'`, actor din acel compartiment ⇒ `allowed`, rol
   `'p2_comp'`.
2. Actor din alt compartiment ⇒ refuzat.
3. Actor **fără** compartiment (`''`) ⇒ refuzat, chiar dacă `p2_compartiment` e gol.
   (Șirul gol nu se potrivește cu nimic.)
4. `TRIM`: `p2_compartiment=' Serviciul Buget '` cu actor `'Serviciul Buget'` ⇒ allowed.
5. Non-regresie: ramura `p2_comp` existentă (pe `assigned_to`) rămâne verde.

### F.2 Capabilități
6. ⭐ `status='pending_p2'`, `assigned_to=NULL`, `p2_compartiment` = compartimentul actorului
   ⇒ `can_complete_p2 === true`, `can_return === true`, `can_send_p2 === false`.
   **Fără fix, acest caz dă `can_send_p2: true` — e chiar bug-ul.**
7. Același doc, actor din alt compartiment ⇒ caps de `'view'`, exact ca azi.
8. Creatorul documentului care e ȘI în compartimentul atribuit ⇒ rămâne `'p1'`.
9. ⭐ Retrocompatibilitate: apelat **fără** al patrulea argument, `computeDocCapabilities`
   întoarce pentru toate scenariile vechi obiecte **identice** cu cele de dinainte de lot.
10. `can_reopen` rămâne false pentru membrul compartimentului.

### F.3 Trimitere (DB real)
11. ⭐ `POST /submit` cu `assigned_comp` ⇒ `assigned_to IS NULL`, `p2_compartiment` setat,
    `status='pending_p2'`, și **câte o notificare pentru fiecare membru activ**, mai puțin
    expeditorul (numără rândurile din `notifications`).
12. ⭐ `assigned_to` ȘI `assigned_comp` ⇒ 400 `assigned_ambiguu`, **fără nicio scriere** —
    verifică în DB că `status` a rămas `draft`.
13. Compartiment fără utilizatori activi ⇒ 400 `compartiment_fara_membri`, fără scriere.
14. ⭐ Retrimitere: mai întâi la compartiment, apoi la o persoană ⇒ `p2_compartiment` devine
    **NULL** (exclusivitatea nu se rupe). Și invers.
15. Non-regresie: `POST /submit` cu `assigned_to` are efect **identic** cu cel de dinainte —
    inclusiv o singură notificare.
16. Un utilizator soft-șters din compartiment NU primește notificare și nu contează la
    `compartiment_fara_membri`.

### F.4 Vizibilitate (DB real, ambele liste)
17. ⭐ Document atribuit compartimentului meu, creat de altcineva din alt compartiment ⇒
    **apare** în `GET /api/formulare/list` pentru mine.
18. ⭐ **Gaura veche**: document atribuit unei PERSOANE din compartimentul meu ⇒ apare acum
    în listă. Fără fix, nu apărea (deși puteam să-l editez).
19. Document atribuit altui compartiment ⇒ **nu** apare.
20. Non-regresie: un utilizator fără compartiment vede exact ce vedea înainte.
21. Filtrul „Responsabil CAB" cu textul compartimentului găsește documentul.
22. Coloana `p2` afișează numele compartimentului când `assigned_to` e NULL, și numele
    persoanei altfel.

---

## 11. Rulare, versionare, push

```bash
npm test
npm run test:db
```
⛔ „Skipped" NU e „passed". `test:db` e **obligatoriu** și pe **instanță efemeră PROASPĂTĂ** —
altfel migrația 108 e deja în `schema_migrations` și se sare, iar testele ar rula pe o schemă
veche. Rețeta PG 17 e în `CLAUDE.md`.

Bump versiune; `git commit -m "feat(#131a): Responsabil CAB pe compartiment - backend + migratia 108"`;
`git push origin develop`.

---

## 12. Verificări de ieșire (verbatim în raport)

```bash
# 1 — migrația, o singură dată
grep -n "108_formulare_p2_compartiment" server/db/index.mjs

# 2 — coloana e folosită în toate cele patru zone
grep -rn "p2_compartiment" server/services/ server/routes/ --include=*.mjs

# 3 — semnătura retrocompatibilă
grep -n "export function deriveDocRole\|export function computeDocCapabilities" server/services/formular-capabilities.mjs

# 4 — frontend NEATINS
git status --short public/
# Așteptat: nicio linie

# 5 — zero tipuri noi de eveniment de audit
grep -n "eventType" server/services/formular-shared.mjs | head -20

# 6 — indecșii de parametri: niciun params.push nou pe compartiment
git diff server/routes/formulare/shared.mjs | grep -n "params.push"
# Raportează FIECARE linie și explică de ce e acolo

# 7 — scopul lotului
git status --short
# ⚠️ working tree-ul are fișiere netrackate din sesiuni vechi — confirmă EXPLICIT că ai
# stage-uit doar căile sarcinii
```

---

## 13. RAPORT FINAL

- commit hash + push confirmat; versiunea; `git log -1 --pretty=%s`
- `npm test` / `npm run test:db`: **numere REALE**, cu comanda instanței efemere, verbatim
- ieșirea celor 7 verificări, **verbatim**
- ⭐ rezultatele cazurilor **1, 6, 9, 11, 12, 14, 17 și 18**, menționate separat
- **TABELUL celor 14 locuri de apel** ale lui `computeDocCapabilities`: fișier:linie · a primit
  `actorComp`? · de ce da/nu
- lista consumatorilor rolului `'p2_comp'` găsiți pe cod, cu confirmarea că niciunul nu se rupe
- de unde ai luat predicatul de „utilizator activ", cu linia
- confirmarea că `canViewFormular` se aliniază automat prin delegare
- confirmarea că `can_reopen` (#129) rămâne false pentru membrul compartimentului
- confirmarea că `public/` e neatins
- **orice abatere.** Dacă găsești o eroare în prompt, **spune-o, nu o repara tăcut**

---

## 14. ⛔ Constrângeri absolute

⛔ Branch `develop`. Fără `main`, fără `--amend`, fără `--force`.
⛔ O singură migrație, doar `ADD COLUMN`. Fără `UPDATE`, `NOT NULL`, `DEFAULT`, index, CHECK.
⛔ `assigned_to` XOR `p2_compartiment` — niciodată amândouă scrise.
⛔ Calea cu persoană: comportament **byte-identic**, inclusiv o singură notificare.
⛔ `computeDocCapabilities` / `deriveDocRole` rămân PURE și retrocompatibile fără al 4-lea argument.
⛔ Rolul întors rămâne `'p2_comp'` — niciun rol nou.
⛔ Niciun `params.push` nou pentru compartiment în predicatele de listă.
⛔ Zero fișiere din `public/`. Zero tipuri noi de eveniment de audit.
⛔ Fără revendicare, fără `cab_dept` modificat, fără ALOP.
⛔ Zero refactorizări în trecere.
