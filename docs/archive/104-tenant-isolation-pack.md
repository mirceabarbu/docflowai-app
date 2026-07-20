---
prompt: 104
titlu: "test(tenant): pachet de izolare multi-tenant — poarta de CI care definește «nu regresăm»"
model_suggested: Opus 4.8
branch: develop
zona: server/tests/db/tenant-isolation.test.mjs (NOU), server/tests/db/helpers/app.mjs (extindere), helpers
versiune_tinta: fără bump (doar teste)
---

# ⚠️ BRANCH: develop

> Lucrezi **EXCLUSIV** pe `develop`. `main` = **producție (v3.9.689)**, gestionat manual de Mircea.
> ⛔ NU face merge / push / checkout pe `main`.

---

## CONTEXT — de ce acest prompt e diferit de toate celelalte

Toate prompturile de până acum au **reparat** ceva. Acesta **nu repară nimic.** Construiește plasa
de siguranță pentru ce urmează: mai multe primării în producție.

Astăzi izolarea între organizații e o **convenție** — ține de fiecare `WHERE org_id=$1` scris corect
de mână. La #101 s-au găsit patru uitate. La auditul din 14.07 s-a mai găsit unul (lista DF pentru
admin, `shared.mjs:411`). **Vor mai fi**, pentru că nimic nu le prinde automat. Iar suita are azi
doar ~6 aserțiuni cross-org, apărute accidental în alte teste.

Acest prompt creează **definiția executabilă a lui „nu regresăm"**: un pachet care seed-uiește
DOUĂ organizații cu date reale în fiecare modul și verifică, pe **rutele reale**, că un utilizator
din Org B nu vede/atinge NIMIC din Org A. Odată în CI, orice query viitor care uită org-ul pică în
ziua în care e scris — nu la clientul doi.

⚠️ **Scopul e să DESCOPERE, nu doar să confirme.** Auditul a fost read-only (grep + citit). Acest
pachet EXECUTĂ cu Postgres real și va găsi scurgeri pe care auditul nu le-a văzut. Dacă un test pică,
**nu-l slăbi ca să treacă** — raportează scurgerea. E exact ce căutăm.

---

## PAS 0 — RECON (read-only). Răspunde ÎNAINTE să scrii.

```bash
sed -n '1,50p' server/tests/db/helpers/app.mjs          # ce montează buildApp AZI
grep -n "export async function" server/tests/helpers/db-real.mjs
# Rutele scopate pe org de acoperit:
grep -n "router.get" server/routes/formulare/shared.mjs | grep -iE "list|utilizatori-org|atasamente|capturi|audit"
grep -n "router.get" server/routes/alop.mjs | grep -iE "'/api/alop'|/api/alop/:id|stats"
grep -n "router.get" server/routes/registratura.mjs | grep -iE "intrari|export"
grep -rn "router.get\|router.post" server/routes/flows/crud.mjs | grep -iE "my-flows|/flows/:flowId" | head
```

**Răspunde în raport:**
1. `buildApp()` montează AZI doar `formulareDbRouter` + `alopRouter`. Pentru a acoperi **fluxuri** și
   **registratură** trebuie extins să monteze și `crud.mjs` (flows) și `registratura.mjs`. Confirmă ce
   routere trebuie adăugate și dacă au dependințe de middleware care lipsesc din harness (csrf, module — deja mock-uite).
2. `seedFlow`/`seedFlowApproved` existenți acceptă `orgId`? Sau inserează pe `org_id=1` hardcodat? (Dacă
   da, ai nevoie de un `seedFlow({ orgId })` real — vezi PAS 2.)
3. Registratura: există `seedRegistru`? Dacă nu, îl scrii (PAS 2).

⛔ **NU repara nicio scurgere descoperită la recon.** Dacă vezi o rută ne-scopată, notează în raport
— o reparăm în prompt separat. Acest prompt scrie DOAR teste.

---

## PAS 1 — Extinde harness-ul `buildApp()`

`buildApp()` trebuie să monteze **toate** routerele ale căror listări le testăm. Un harness care nu
montează o rută dă un fals „verde" — testul pică cu 404 și cineva îl marchează `skip`.

Adaugă la `server/tests/db/helpers/app.mjs`:

```js
const flowsCrudRouter   = (await import('../../../routes/flows/crud.mjs')).default;
const registraturaRouter = (await import('../../../routes/registratura.mjs')).default;
// ... în buildApp():
app.use('/', flowsCrudRouter);
app.use('/', registraturaRouter);
```

⚠️ Verifică fiecare import: unele routere se exportă `default`, altele ca `{ xRouter }` (vezi
`formulareDbRouter`). Confirmă forma reală înainte. Dacă un router are un `import` care crapă în
harness (ex. depinde de `sessionGuard` sau de ceva ne-mock-uit), **raportează** — poate necesita un
mock ortogonal în plus, dar NU mock-ui `db` și NU mock-ui `authz`.

⚠️ Dacă montarea unui router nou sparge testele DB **existente** (conflict de rute, dublă montare),
oprește-te și raportează. Nu rescrie testele existente ca să încapă harness-ul nou.

---

## PAS 2 — Helper de seed cu DOUĂ organizații

Un singur helper care construiește peisajul complet pentru două primării. În
`server/tests/helpers/db-real.mjs` (sau un helper nou `tenant-fixture.mjs` importat de test):

```js
// Construiește Org A și Org B, fiecare cu: 1 org_admin, 1 user normal, 1 flux, 1 DF, 1 ORD,
// 1 ALOP, 1 intrare registratură. Emailuri și nume de org DISTINCTE (organizations.name e UNIQUE).
export async function seedTwoOrgs() {
  const A = await seedOrgUser({ orgName: 'Primaria A', email: 'admin-a@a.ro', role: 'org_admin' });
  const B = await seedOrgUser({ orgName: 'Primaria B', email: 'admin-b@b.ro', role: 'org_admin' });
  const uA = await seedUser({ orgId: A.orgId, email: 'user-a@a.ro', compartiment: 'Contabilitate' });
  const uB = await seedUser({ orgId: B.orgId, email: 'user-b@b.ro', compartiment: 'Contabilitate' });

  const dfA  = await seedDf({ orgId: A.orgId, createdBy: uA.userId, nrUnic: 'DF-A-001', status: 'draft' });
  const ordA = await seedOrd({ orgId: A.orgId, createdBy: uA.userId, nrOrd: 'ORD-A-001' });
  const alopA= await seedAlop({ orgId: A.orgId, createdBy: uA.userId /* ...câmpuri minime */ });
  const flowA= await seedFlow({ orgId: A.orgId /* vezi ⚠️ mai jos */ });
  const regA = await seedRegistru({ orgId: A.orgId /* dacă există; altfel scrie-l */ });

  return { A, B, uA, uB, dfA, ordA, alopA, flowA, regA };
}
```

⚠️ **`compartiment` identic intenționat** ('Contabilitate' la ambele) — asta prinde bug-ul de la
auditul din 14.07: subquery-urile pe `TRIM(compartiment)=$1` NU au `org_id`, deci un `compartiment`
scris la fel în două primării ar putea face un user din B vizibil pe documentele din A. **Vrem ca
testul să lovească exact acest caz.**

⚠️ Dacă `seedFlow`/`seedAlop`/`seedRegistru` nu acceptă `orgId` sau nu există, **extinde-i/scrie-i**
— dar minimal, doar câmpurile necesare pentru o listare. Nu construi un seed complet de ALOP dacă
listarea are nevoie doar de `org_id`, `status`, `titlu`, `created_by`.

---

## PAS 3 — Testele. Regula: **B nu vede NIMIC din A.**

`server/tests/db/tenant-isolation.test.mjs`. Actorul e mereu **user-b** (sau **admin-b**), iar
aserțiunea e mereu: rezultatul **nu conține** obiectul din Org A.

### Grupa 1 — Listări (actor = user-b, org_admin-b)

1. `GET /api/formulare/list?type=df` ca **user-b** ⇒ rezultatul NU conține `DF-A-001`
2. `GET /api/formulare/list?type=df` ca **admin-b** (org_admin) ⇒ NU conține `DF-A-001`
   *(org_admin e scopat pe org — spre deosebire de super-admin `role='admin'`, care e altă discuție)*
3. `GET /api/formulare/list?type=ord` ca user-b ⇒ NU conține `ORD-A-001`
4. `GET /api/alop` ca user-b ⇒ NU conține `alopA`
5. `GET /api/alop/stats` ca user-b ⇒ cifrele NU includ valorile din Org A
6. `GET /api/registratura/intrari` ca user-b ⇒ NU conține `regA`
7. `GET /api/formulare/utilizatori-org` ca user-b ⇒ NU conține `user-a@a.ro` (dropdown-ul de semnatari)

### Grupa 2 — Acces la obiect individual (IDOR cross-org)

8. `GET /api/alop/:id` cu `alopA.id` ca user-b ⇒ **403 sau 404** (NU 200 cu datele lui A)
9. `GET /api/formulare-atasamente/df/:id` cu `dfA.id` ca user-b ⇒ 403/404
10. `GET /api/formulare-audit/df/:id` cu `dfA.id` ca user-b ⇒ 403/404
11. `PUT /api/formulare-df/:id` cu `dfA.id` ca user-b ⇒ 403/404 (scriere cross-org blocată)

### Grupa 3 — Control pozitiv (izolarea nu e prea agresivă)

12. user-**a** VEDE `DF-A-001` în lista lui ⇒ 200, conține DF-ul ← *dovada că nu blocăm totul*
13. user-**a** deschide `alopA.id` ⇒ 200 ← *acces legitim în interiorul org-ului funcționează*

⚠️ Grupa 3 e la fel de importantă ca 1 și 2. Un test care blochează tot ar trece grupele 1-2 și ar
fi complet inutil. Controlul pozitiv dovedește că izolarea taie exact pe granița de org, nici mai
mult, nici mai puțin.

⛔ **Fiecare aserțiune „NU conține" verifică pe ID/nr_unic, nu pe lungimea listei.** `expect(rows.length).toBe(0)`
e fragil (poate fi 0 din alt motiv). `expect(rows.find(r => r.id === dfA.id)).toBeUndefined()` e robust.

---

## PAS 4 — Dacă un test pică (CITEȘTE)

Un roșu aici = o scurgere reală descoperită. Procedura:

1. **NU slăbi testul.** Nu-l marca `skip`, nu-l face `not.toBe(500)`.
2. Notează în RAPORT: care rută, ce obiect din A a fost vizibil pentru B, la ce linie de cod.
3. **NU repara scurgerea în acest prompt.** Reparația e prompt separat (o vrem izolată, cu propriul
   ei test de regresie). Acest prompt livrează pachetul + lista de scurgeri găsite.

Excepție: dacă un test pică pentru că **harness-ul** e greșit (404 fiindcă routerul nu e montat, sau
seed incomplet), aia NU e o scurgere — repar-o în harness/seed și continuă.

Distincția e critică: **404 din harness lipsă ≠ 403 din izolare corectă ≠ 200 cu date din A (scurgere).**
Raportează care din cele trei ai văzut la fiecare test.

---

## PAS 5 — Fără bump de versiune

Sunt DOAR teste + harness. `package.json` rămâne **v3.9.689**. Zero `public/`, zero cod de producție.

```bash
npm run check && npm run test:db
```

⚠️ `npm test` (unit) nu atinge acest fișier — e un test DB. Rulează **`npm run test:db`** local dacă
ai Postgres/Docker; altfel confirmarea vine din CI.

Commit:
```
test(tenant): pachet de izolare multi-tenant (poartă de CI, zero cod de producție)
```

---

## RAPORT FINAL

1. PAS 0: ce routere a trebuit să monteze `buildApp()` în plus? Vreun import care a crapat în harness?
2. `seedFlow`/`seedAlop`/`seedRegistru` acceptau `orgId`, sau i-ai extins? Ce ai scris nou?
3. **Câte teste, câte verzi, câte roșii?** Pentru fiecare roșu: rută + obiect scurs + linie de cod.
4. **Grupa 3 (control pozitiv) — verde?** Dacă nu, izolarea e prea agresivă și pachetul e inutil.
5. La testele „NU conține" ai verificat pe **ID**, nu pe `length`? Arată o aserțiune.
6. Ai reparat vreo scurgere de producție? (**Trebuie să fie NU** — doar teste + harness/seed.)
7. Testul cu `compartiment` identic ('Contabilitate' în ambele org-uri) — ce a arătat? Scurgere sau curat?
8. `git diff --name-only` — lipește. Doar `server/tests/**` + eventual `db-real.mjs`. Zero `public/`, zero rute de producție, zero `package.json`.
9. `npm run test:db` — verde în CI? Lipește.

---

## ⛔ CONSTRÂNGERI ABSOLUTE

- ⛔ **Zero cod de producție.** Acest prompt scrie TESTE. Dacă atingi o rută, un serviciu, o migrație — te-ai abătut.
- ⛔ **Nu slăbi un test ca să treacă.** Un roșu e o descoperire, nu o problemă de rezolvat prin `skip`.
- ⛔ **Nu mock-ui `db` și nu mock-ui `authz`.** Rute reale, Postgres real, izolare reală. Mock doar ortogonalele (csrf, logger, module) — deja făcut în harness.
- ⛔ Aserțiuni pe ID, nu pe lungime.
- ⛔ Grupa 3 (control pozitiv) e obligatorie — fără ea pachetul nu dovedește nimic.
- ⛔ Nume org + emailuri DISTINCTE (a picat CI-ul la #100.2 pe `organizations_name_key`).
