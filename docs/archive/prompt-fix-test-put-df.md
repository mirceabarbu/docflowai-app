# ⚠️ BRANCH: develop — NU `main`. NU push/merge/checkout pe main.

## Obiectiv

Fix test-only: testul `PUT DF (draft, creator) → capabilities prezent` din
`server/tests/db/doc-capabilities-mutations.test.mjs` trimite `{ notes: 'x' }`, dar `notes` NU e
în `DF_P1_FIELDS`. Ruta `PUT /api/formulare-df/:id` filtrează body-ul prin `pick(req.body, DF_P1_FIELDS)`,
rămâne `{}`, și răspunde `400 no_fields`. Cod corect, test greșit (l-am scris eu speculativ în 2b-i fără
să verific lista). CI pe `develop` (acum activ) l-a prins — exact rolul lui.

**Zero atingere de cod prod.** Doar testul.

---

## Patch 1 — `server/tests/db/doc-capabilities-mutations.test.mjs`

Înlocuiește body-ul invalid cu un câmp valid din `DF_P1_FIELDS` (`subtitlu_df` — text liber, fără
constraint-uri) și adaugă o aserțiune ușoară că starea rămâne `draft` după PUT (caps consistent).

**old_str**
```
  it('PUT DF (draft, creator) → capabilities prezent', async () => {
    const created = await request(app).post('/api/formulare-df').set('Cookie', cookie()).send({});
    const id = created.body.document.id;
    const res = await request(app).put(`/api/formulare-df/${id}`).set('Cookie', cookie()).send({ notes: 'x' });
    expect(res.status).toBe(200);
    expect(res.body.document.capabilities).toBeTruthy();
  });
```
**new_str**
```
  it('PUT DF (draft, creator) → capabilities prezent', async () => {
    const created = await request(app).post('/api/formulare-df').set('Cookie', cookie()).send({});
    const id = created.body.document.id;
    // subtitlu_df e în DF_P1_FIELDS (text liber, fără constraint-uri) → PUT valid
    const res = await request(app).put(`/api/formulare-df/${id}`).set('Cookie', cookie())
      .send({ subtitlu_df: 'updated by test' });
    expect(res.status).toBe(200);
    expect(res.body.document.capabilities).toBeTruthy();
    // draft + creator → can_send_p2 + can_reset
    expect(res.body.document.capabilities.can_send_p2).toBe(true);
    expect(res.body.document.status).toBe('draft');
  });
```

---

## Patch 2 — `package.json`: version bump

**old_str**
```
  "version": "3.9.525",
```
**new_str**
```
  "version": "3.9.526",
```

---

## Verificări

```bash
# Diff strict — DOAR test + package.json
git diff --name-only
#   → server/tests/db/doc-capabilities-mutations.test.mjs + package.json

# Sintaxă
node --check server/tests/db/doc-capabilities-mutations.test.mjs

# Suita mock — neschimbat
npm test   # → 778 verde

# Suita DB local (dacă ai Docker la îndemână)
npm run db:test:up
export TEST_DATABASE_URL=postgres://postgres:test@localhost:55432/docflow_test
npm run test:db   # → 23/23 verde
npm run db:test:down ; unset TEST_DATABASE_URL
```

După push, urmărește run-ul de CI pe SHA → pasul „Run DB test suite (Postgres real)" trebuie
acum **23 passed**, 0 failed. Asta închide bucla pentru tot ce am livrat în această conversație.

---

## RAPORT FINAL

- [ ] Versiune: 3.9.525 → 3.9.526
- [ ] Test PUT DF folosește `subtitlu_df` (câmp valid din `DF_P1_FIELDS`) + verifică `can_send_p2` + status
- [ ] `npm test` verde — 778
- [ ] CI pe develop: 23/23 DB tests passed (raportează SHA + statusul)

Commit sugerat:
```
test(db): fix PUT DF body — folosește câmp valid din DF_P1_FIELDS (prins de CI)

- testul trimitea {notes:'x'} → pick() îl filtra → 400 no_fields
- înlocuit cu subtitlu_df (text liber în DF_P1_FIELDS); cod prod neatins
- adaugă aserțiuni: capabilities.can_send_p2 + status='draft' după PUT
- prins de CI pe develop (extins în comm-ul anterior); local era skip fără Docker
- v3.9.526
```
