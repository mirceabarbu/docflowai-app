# ⚠️ BRANCH: develop — NU `main`. NU push/merge/checkout pe main.

> NO-TOUCH (doar citire): `signing.mjs`, `bulk-signing.mjs`, `cloud-signing.mjs`,
> `pades.mjs`, `java-pades-client.mjs`, `STSCloudProvider.mjs`.

---

## Obiectiv — Etapa 2b-i (backend ADITIV, prerechizită pentru 2b-ii)

În 2a am atașat `document.capabilities` doar pe rutele de **detaliu** (`GET`). Dar `doc.js` actualizează
starea **optimist, local** după fiecare mutație (`ST.docStatus[ft]='completed'` etc.) și apelează
`renderActions` **fără re-fetch**. Deci dacă 2b-ii ar randa din `capabilities`, acestea ar fi **stale**
după o mutație → regresie.

Fix: atașăm `capabilities` pe **toate** răspunsurile DF/ORD care întorc un `document`, ca starea
trimisă înapoi după orice mutație să conțină deja capabilitățile proaspete.

**Pur aditiv. Frontend NEATINS. Zero schimbare de comportament** (doc.js încă nu citește caps din aceste
răspunsuri — abia 2b-ii o face). Doar adăugăm un câmp la `document`.

`computeDocCapabilities` e deja importat în `formulare-db.mjs` (din 2a) — nu re-importa.

### Rute vizate (8 răspunsuri de mutație)

| Rută | Linie `res.json` (aprox.) | Variabilă document | ft |
|---|---|---|---|
| `POST /api/formulare-df` (create) | ~265 | `rows[0]` | `'notafd'` |
| `PUT /api/formulare-df/:id` | ~330 | `updated[0]` | `'notafd'` |
| `POST /api/formulare-df/:id/submit` | ~379 | `updated[0]` | `'notafd'` |
| `POST /api/formulare-df/:id/complete` | ~441 | `updated[0]` | `'notafd'` |
| `POST /api/formulare-ord` (create) | ~854 | `rows[0]` | `'ordnt'` |
| `PUT /api/formulare-ord/:id` | ~930 | `updated[0]` | `'ordnt'` |
| `POST /api/formulare-ord/:id/submit` | ~978 | `updated[0]` | `'ordnt'` |
| `POST /api/formulare-ord/:id/complete` | ~1056 | `updated[0]` | `'ordnt'` |

> NOTĂ: rutele de **detaliu** (`GET`, ~227 și ~810) au deja caps din 2a — NU le atinge.
> `returneaza` și `link-flow` NU întorc `document` — NU le atinge (le tratăm în 2b-ii).
> Liniile `res.json({ ok: true, document: updated[0] });` se repetă identic în mai multe rute, deci
> **NU pot fi folosite ca `old_str` unic**. Procedează pe rută, cu ancoră logul de eroare/contextul rutei.

---

## Procedeu (pentru fiecare din cele 8 rute)

În corpul fiecărei rute din tabel, găsește linia `res.json({ ok: true, document: <VAR> ... });` și
inserează IMEDIAT ÎNAINTE o linie care atașează caps pe `<VAR>`:

```js
<VAR>.capabilities = computeDocCapabilities(<VAR>, actor, '<FT>');
```

unde `<VAR>` și `<FT>` sunt din tabel. Variabila `actor` e deja în scope în toate rutele (din `requireAuth`).

### Exemple concrete pe variabilă

**Pentru rutele cu `rows[0]` (create df ~265, create ord ~854):**

`old_str` (DF create — folosește contextul unic al logului de creare ca ancoră):
```
    const { rows } = await pool.query(q, allVals);
    logger.info({ id: rows[0].id, actor: actor.email }, 'formulare-df creat');
    res.json({ ok: true, document: rows[0] });
```
`new_str`:
```
    const { rows } = await pool.query(q, allVals);
    logger.info({ id: rows[0].id, actor: actor.email }, 'formulare-df creat');
    rows[0].capabilities = computeDocCapabilities(rows[0], actor, 'notafd');
    res.json({ ok: true, document: rows[0] });
```

Pentru ORD create (~854) — analog, cu ancora logului de creare ORD (verifică textul exact al `logger.info`
din acea rută) și `'ordnt'`.

**Pentru rutele cu `updated[0]`** (PUT/submit/complete × df/ord): fiindcă linia `res.json` se repetă,
ancorează pe linia DINAINTEA ei (specifică rutei) și include-o în `old_str`. Pattern general:

`old_str` (exemplu schematic — adaptează la contextul real al fiecărei rute):
```
    <linia precedentă unică a rutei>
    res.json({ ok: true, document: updated[0] });
```
`new_str`:
```
    <linia precedentă unică a rutei>
    updated[0].capabilities = computeDocCapabilities(updated[0], actor, '<FT>');
    res.json({ ok: true, document: updated[0] });
```

Pentru `submit` (df ~379, ord ~978) răspunsul e `res.json({ ok: true, document: updated[0], assigned_to: p2 });`
— atașează `updated[0].capabilities` înainte, păstrând `assigned_to: p2` neschimbat:
```
    updated[0].capabilities = computeDocCapabilities(updated[0], actor, '<FT>');
    res.json({ ok: true, document: updated[0], assigned_to: p2 });
```

> Dacă într-o rută variabila nu e `updated[0]`/`rows[0]` ci alt nume (ex. `doc`, `row`), folosește numele
> real din acea rută. Important: documentul atașat trebuie să aibă `status`, `created_by`, `assigned_to`,
> `flow_id`, `revizie_nr` — `computeDocCapabilities` derivă restul. Pentru stările pre-flux (draft,
> pending_p2, completed, returnat) `aprobat=false` și `has_newer_revision=undefined→false` sunt corecte.

---

## Patch final — `package.json`: version bump

**old_str**
```
  "version": "3.9.522",
```
**new_str**
```
  "version": "3.9.523",
```

---

## Patch test — `server/tests/db/doc-capabilities-mutations.test.mjs` (verifică wiring pe mutații)

**CREATE** `server/tests/db/doc-capabilities-mutations.test.mjs`:
```js
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import request from 'supertest';
import { hasTestDb, migrate, truncateAll, pool, seedOrgUser, makeAuthCookie } from '../helpers/db-real.mjs';
import { buildApp } from './helpers/app.mjs';

const d = describe.skipIf(!hasTestDb());

d('Răspunsurile de mutație DF/ORD includ document.capabilities', () => {
  let app;
  beforeAll(migrate);
  beforeEach(async () => { await truncateAll(); await seedOrgUser({ role: 'user' }); app = buildApp(); });
  afterAll(() => pool.end());
  const cookie = () => makeAuthCookie({ userId: 1, role: 'user', orgId: 1 });

  it('POST create DF → capabilities (draft → can_send_p2)', async () => {
    const res = await request(app).post('/api/formulare-df').set('Cookie', cookie()).send({});
    expect(res.status).toBe(200);
    expect(res.body.document.capabilities).toBeTruthy();
    expect(res.body.document.capabilities.can_send_p2).toBe(true);
  });

  it('PUT DF (draft, creator) → capabilities prezent', async () => {
    const created = await request(app).post('/api/formulare-df').set('Cookie', cookie()).send({});
    const id = created.body.document.id;
    const res = await request(app).put(`/api/formulare-df/${id}`).set('Cookie', cookie()).send({ notes: 'x' });
    expect(res.status).toBe(200);
    expect(res.body.document.capabilities).toBeTruthy();
  });

  it('POST create ORD → capabilities (draft → can_send_p2)', async () => {
    const res = await request(app).post('/api/formulare-ord').set('Cookie', cookie()).send({});
    expect(res.status).toBe(200);
    expect(res.body.document.capabilities).toBeTruthy();
    expect(res.body.document.capabilities.can_send_p2).toBe(true);
  });
});
```

> Dacă `POST /api/formulare-df` cu body gol nu creează (vreun câmp obligatoriu), trimite minimul necesar
> (ex. `{ nr_unic_inreg: 'TEST-1' }`). Verifică `DF_P1_FIELDS`/`ORD_P1_FIELDS` și ajustează body-ul.

---

## Verificări

```bash
# Toate atașările prezente: 1 import (2a) + 2 detaliu (2a) + 8 mutații (2b-i) = 11
grep -c "computeDocCapabilities" server/routes/formulare-db.mjs   # → 11

# Cele 8 noi atașări (pe document de mutație)
grep -nE "\.(capabilities) = computeDocCapabilities" server/routes/formulare-db.mjs   # → 10 linii
#   (2 din 2a pe doc.capabilities + 8 noi pe rows[0]/updated[0])

# Sintaxă
node --check server/routes/formulare-db.mjs

# Suita mock — câmp ADITIV, niciun test existent nu trebuie să pice
npm test   # → verde, ≥ 778 (raportează nr.; +0 unitare noi, deci tot 778 dacă nu adaugi unitare)

# Suita DB
npm run db:test:up
export TEST_DATABASE_URL=postgres://postgres:test@localhost:55432/docflow_test
npm run test:db   # → verzi (cele din Etapa 1/2a + 3 noi din doc-capabilities-mutations)
npm run db:test:down ; unset TEST_DATABASE_URL

# FRONTEND NEATINS
git diff --name-only | grep -E "^public/" ; echo "↑ trebuie GOL"
# NO-TOUCH semnare
git diff --name-only | grep -E "signing|pades|STSCloud" ; echo "↑ trebuie GOL"
```

---

## RAPORT FINAL (completează)

- [ ] Versiune: 3.9.522 → 3.9.523
- [ ] `capabilities` atașat pe cele 8 răspunsuri de mutație (create/PUT/submit/complete × df/ord)
- [ ] Rutele de detaliu (2a) și `returneaza`/`link-flow` NEATINSE
- [ ] `grep -c computeDocCapabilities` = 11
- [ ] test DB nou: create DF/ORD + PUT întorc capabilities
- [ ] `npm test` verde (raportează nr.); niciun test existent picat
- [ ] `npm run test:db` verde (raportează nr.)
- [ ] `git diff --name-only` → fără `public/**`, fără fișiere de semnare
- [ ] commit + push **doar pe develop**

Commit sugerat:
```
feat(formulare): capabilities pe toate răspunsurile de mutație DF/ORD (Etapa 2b-i, aditiv)

- create/PUT/submit/complete (df+ord) atașează document.capabilities → caps proaspăt după mutații
- elimină riscul de stale caps la actualizarea optimistă din doc.js (prerechizită 2b-ii)
- frontend neatins; test DB confirmă wiring pe create + PUT
- v3.9.523
```
```

---

## Ce urmează (2b-ii — frontend, după ce 2b-i e verde)

`doc.js`: stochează `ST.docCapabilities[ft]=j.document.capabilities` la fiecare actualizare din server
(openDoc + toate mutațiile), apoi rescrie `renderActions` să randeze din caps (status alege doar eticheta;
`hasPdf` rămâne client). `returneaza`/`link-flow` (care nu întorc document) → în 2b-ii le facem fie să
întoarcă document cu caps, fie re-fetch ușor. Plus eventual câteva teste de caracterizare DB pe
submit/complete/returneaza dacă vrei acoperire suplimentară.
