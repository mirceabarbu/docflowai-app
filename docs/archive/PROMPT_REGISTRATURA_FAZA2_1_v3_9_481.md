# DocFlowAI — 🔧 v3.9.481: Registratură Faza 2.1 — fix CSRF intrări + atașament în modal + compartiment auto + format număr `00001`

```
═══════════════════════════════════════════════════════════
⚠️  BRANCH OBLIGATORIU: develop
⚠️  NU face checkout/merge/push pe main. NICIODATĂ.
⚠️  Producția (main → app.docflowai.ro) o gestionează Mircea manual.
═══════════════════════════════════════════════════════════

DocFlowAI v3.9.480 → v3.9.481 (SW v196 → v197)
Branch: develop
Subiect: fix(registratura): CSRF la POST intrări + input atașament în modal +
         compartiment auto din profil + nr. înregistrare afișat 00001 (5 cifre)
```

---

## 🎯 Context — 4 fix-uri pe modulul Registratură (Faza 2 e deja livrată)

Din test pe staging:

1. **`Eroare: csrf_invalid`** la „Înregistrare document intrat". Cauză: frontend-ul
   NU trimite headerul `x-csrf-token` (schema e double-submit cookie — vezi
   `server/middleware/csrf.mjs`). Pattern-ul corect e deja folosit în
   `public/js/setari/entitlements.js`: `window.df.getCsrf()` → `x-csrf-token`.
2. **Lipsă buton atașare** în modalul de înregistrare. Scanul se atașează la
   înregistrare; endpoint-ul `/atasament` cere `intrare_id`, deci create-ul
   trebuie să întoarcă `id`-ul poziției noi, apoi urcăm fișierul pe el.
3. **Compartiment** — să se completeze automat cu compartimentul utilizatorului
   logat (nu tastat manual). JWT-ul poartă deja `actor.compartiment`.
4. **Nr. înregistrare** — afișat doar numărul, `00001` (zero-pad 5 cifre), fiindcă
   data e deja coloană separată. Aplică la listă (Ieșiri + Intrări) și la
   numerotarea nouă (footer documente emise viitoare). Footer-ele deja semnate
   rămân neschimbate (PDF semnat = NO-TOUCH).

---

## ⛔ ABSOLUTE — NU se ating

1. `server/routes/flows/cloud-signing.mjs`, `bulk-signing.mjs`
2. `server/services/pades.mjs`, `java-pades-client.mjs`
3. `server/signing/providers/STSCloudProvider.mjs`
4. `server/routes/flows/lifecycle.mjs`, `server/routes/flows/crud.mjs`
5. `stampFooterOnPdf` din `server/index.mjs` — neatins (footer touch = 0)
6. Calea **emise** din `allocateNumber`: comportament semantic neschimbat
   (apelul din `crud.mjs` rămâne identic; doar formatul `{nr5}` schimbă cum
   arată numărul nou-alocat — corect și dorit).
7. Niciun test existent șters / dezactivat.

---

## 📋 Modificări detaliate

### 1. `server/db/index.mjs` — migrarea `076_registratura_format`

**Verificare context:**
```bash
grep -n "id: '075_registratura_faza2'" server/db/index.mjs   # Așteptat: 1 (ultima)
grep -n "^];" server/db/index.mjs | head -1
```

old_str:
```javascript
      CREATE INDEX IF NOT EXISTS idx_registru_atas_intrare
        ON registru_atasamente (intrare_id, deleted_at);
    `
  }
];
```

new_str:
```javascript
      CREATE INDEX IF NOT EXISTS idx_registru_atas_intrare
        ON registru_atasamente (intrare_id, deleted_at);
    `
  },
  {
    id: '076_registratura_format',
    sql: `
      -- Numărul de înregistrare se afișează doar ca număr zero-pad 5 cifre
      -- ({nr5}); data e coloană separată. Seriile existente cu pattern-ul
      -- vechi sunt migrate; default-ul coloanei devine {nr5} pentru serii noi.
      ALTER TABLE registru_serii ALTER COLUMN pattern SET DEFAULT '{nr5}';
      UPDATE registru_serii
         SET pattern = '{nr5}'
       WHERE pattern = '{nr}/{dd}.{mm}.{yyyy}';
    `
  }
];
```

---

### 2. `server/services/registratura.mjs` — token `{nr5}` în `_fmt`

Calea emise rămâne identică; se schimbă doar reprezentarea numărului
(`{nr5}` = 5 cifre, zero-pad). Peste 99999 crește natural (fără cap dur — n-ar
trebui atins într-un an).

**Verificare context:**
```bash
grep -n "function _fmt" server/services/registratura.mjs
```

old_str:
```javascript
function _fmt(pattern, { nr, d }) {
  const dd = String(d.getDate()).padStart(2, '0');
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const yyyy = String(d.getFullYear());
  return String(pattern || '{nr}/{dd}.{mm}.{yyyy}')
    .replace('{nr}', String(nr))
    .replace('{dd}', dd)
    .replace('{mm}', mm)
    .replace('{yyyy}', yyyy);
}
```

new_str:
```javascript
function _fmt(pattern, { nr, d }) {
  const dd = String(d.getDate()).padStart(2, '0');
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const yyyy = String(d.getFullYear());
  const nr5 = String(nr).padStart(5, '0');
  return String(pattern || '{nr5}')
    .replace('{nr5}', nr5)
    .replace('{nr}', String(nr))
    .replace('{dd}', dd)
    .replace('{mm}', mm)
    .replace('{yyyy}', yyyy);
}
```

---

### 3. `server/routes/registratura.mjs` — create întoarce `id` + compartiment auto

Endpoint-ul `POST /api/registratura/intrari` trebuie să întoarcă `id`-ul
poziției (pentru upload atașament imediat) și să folosească compartimentul
utilizatorului când nu vine din formular. Fără atingerea serviciului:
re-citim `id`-ul prin cheia deterministă (`sursaId`-ul generat aici).

**3a. Capturează `sursaId` + default compartiment.**

**Verificare context:**
```bash
grep -n "sursaId: randomUUID()," server/routes/registratura.mjs
```

old_str:
```javascript
    const obiect = String(b.obiect || '').trim();
    if (!obiect) return res.status(400).json({ error: 'obiect_required' });

    const reg = await allocateNumber({
      orgId: actor.orgId,
      sursaId: randomUUID(),
      sursaTip: 'manual',
      registru,
      directie: 'intrare',
      status: 'inregistrat',
      obiect,
      expeditor: String(b.expeditor || '').trim(),
      compartiment: b.compartiment || null,
```

new_str:
```javascript
    const obiect = String(b.obiect || '').trim();
    if (!obiect) return res.status(400).json({ error: 'obiect_required' });

    const _sursaId = randomUUID();
    const _comp = (b.compartiment && String(b.compartiment).trim())
      || (actor.compartiment && String(actor.compartiment).trim())
      || null;
    const reg = await allocateNumber({
      orgId: actor.orgId,
      sursaId: _sursaId,
      sursaTip: 'manual',
      registru,
      directie: 'intrare',
      status: 'inregistrat',
      obiect,
      expeditor: String(b.expeditor || '').trim(),
      compartiment: _comp,
```

**3b. După alocare: re-citește `id` și întoarce-l în răspuns.**

old_str:
```javascript
    if (!reg) return res.status(500).json({ error: 'alocare_esuata' });

    await writeAuditEvent({
      orgId: actor.orgId, eventType: 'registratura_intrare_creata',
      actorEmail: actor.email, payload: { registru, numar: reg.numarFormat, obiect },
    }).catch(() => {});
    res.json({ ok: true, numar: reg.numar, numarFormat: reg.numarFormat,
               data: reg.data, an: reg.an, registru });
```

new_str:
```javascript
    if (!reg) return res.status(500).json({ error: 'alocare_esuata' });

    let newId = null;
    try {
      const idr = await pool.query(
        `SELECT id FROM registru_intrari
          WHERE org_id=$1 AND registru=$2 AND sursa_tip='manual' AND sursa_id=$3
          LIMIT 1`,
        [actor.orgId, registru, _sursaId]);
      newId = idr.rows.length ? idr.rows[0].id : null;
    } catch (e) { logger.warn({ err: e }, 'registratura: re-citire id eșuată'); }

    await writeAuditEvent({
      orgId: actor.orgId, eventType: 'registratura_intrare_creata',
      actorEmail: actor.email, payload: { registru, numar: reg.numarFormat, obiect },
    }).catch(() => {});
    res.json({ ok: true, id: newId, numar: reg.numar, numarFormat: reg.numarFormat,
               data: reg.data, an: reg.an, registru });
```

---

### 4. `public/js/registratura/main.js` + `public/registratura.html` — frontend

> Nu am conținutul exact al acestor fișiere (scrise de Claude Code în Faza 2).
> Inspectează-le și aplică punctual următoarele. Model CSRF canonic:
> `public/js/setari/entitlements.js` liniile 34–35.

**4a. Helper CSRF + atașare la TOATE POST-urile.**

Adaugă (o singură dată, sus în `main.js`):
```javascript
function _csrfHdr() {
  const t = (window.df && window.df.getCsrf) ? window.df.getCsrf() : null;
  return t ? { 'x-csrf-token': t } : {};
}
```
La fiecare `fetch(...)` cu `method:'POST'` din `main.js` (înregistrare intrare,
schimbare status, leagă răspuns, upload atașament), include în `headers`:
`{ 'Content-Type': 'application/json', ..._csrfHdr() }` (sau fără Content-Type
dacă trimite FormData — dar aici toate trimit JSON base64). `credentials:'same-origin'`
rămâne ca în restul codului.

**4b. Input atașament în modalul „Înregistrare document intrat".**

- Adaugă în modal un câmp opțional: `<input type="file" accept="application/pdf">`
  cu label „Document scanat (PDF, opțional)".
- La submit: întâi `POST /api/registratura/intrari` (cu `_csrfHdr()`). Dacă
  răspunsul are `id` ȘI s-a ales un fișier → citește fișierul ca base64
  (`FileReader.readAsDataURL`, ia partea de după `,`) și
  `POST /api/registratura/intrari/{id}/atasament` cu body
  `{ filename, mimeType:'application/pdf', fileB64 }` + `_csrfHdr()`.
- Erori: afișează prin `window.df.showMsg` (clase `.df-msg--err` / `--ok`).
  La succes: închide modal, reîncarcă lista Intrări.

**4c. Prefill compartiment din profil.**

La deschiderea modalului (sau la load pagină), `GET /auth/me`
(`credentials:'same-origin'`) → pune `me.compartiment` în inputul Compartiment
ca valoare implicită (rămâne editabil). Default-ul real e garantat și
server-side (pasul 3a), prefill-ul e doar UX.

**4d. Afișare număr `00001` în AMBELE liste (Ieșiri + Intrări).**

În randarea rândurilor, coloana „Nr. înregistrare" afișează
`String(item.numar).padStart(5, '0')` în loc de `item.numarFormat`.
(Funcționează și pe rândurile vechi — derivă din întregul `numar`, nu din
stringul stocat. `numarFormat` rămâne folosit doar pentru footer/CSV/audit.)

---

### 5. Bump versiune & cache busting

**5a. `package.json`:** old_str: `"version": "3.9.480",` → new_str: `"version": "3.9.481",`

**5b. `public/sw.js`:** old_str: `const CACHE_VERSION = 'docflowai-v196';` → new_str: `const CACHE_VERSION = 'docflowai-v197';`

**5c.** Cache busting:
```bash
find public -maxdepth 1 -name "*.html" -type f -exec \
  sed -i -E 's/\?v=3\.9\.480/\?v=3.9.481/g' {} +
```

---

## ✅ VERIFICĂRI OBLIGATORII

```bash
# 1. Migrare 076
grep -c "id: '076_registratura_format'" server/db/index.mjs            # 1
grep -c "ALTER COLUMN pattern SET DEFAULT '{nr5}'" server/db/index.mjs  # 1

# 2. Serviciu — token nr5, default schimbat
grep -c "{nr5}" server/services/registratura.mjs                       # ≥ 2
grep -c "String(pattern || '{nr}/{dd}.{mm}.{yyyy}')" server/services/registratura.mjs  # 0

# 3. Router — id întors + compartiment auto
grep -c "const _sursaId = randomUUID()" server/routes/registratura.mjs # 1
grep -c "actor.compartiment" server/routes/registratura.mjs            # ≥ 1
grep -c "id: newId" server/routes/registratura.mjs                     # 1

# 4. Frontend — CSRF + atașament + format
grep -c "_csrfHdr" public/js/registratura/main.js                      # ≥ 4 (def + ≥3 POST)
grep -c "x-csrf-token" public/js/registratura/main.js                  # ≥ 1
grep -c "padStart(5" public/js/registratura/main.js                    # ≥ 1
grep -Ec "type=.file.|/atasament" public/js/registratura/main.js public/registratura.html | tail -1
# Așteptat: ≥ 1 (input fișier prezent)

# 5. Versiune + SW + cache busting
grep '"version"' package.json | head -1            # "version": "3.9.481",
grep "^const CACHE_VERSION" public/sw.js           # docflowai-v197
grep -rE "\?v=3\.9\.480" public/*.html | wc -l     # 0

# 6. NO-TOUCH
for f in cloud-signing.mjs bulk-signing.mjs; do
  git diff develop --name-only | grep -q "server/routes/flows/$f" && echo "FAIL $f" || echo "OK $f"
done
for p in "server/routes/flows/lifecycle.mjs" "server/routes/flows/crud.mjs" \
         "server/services/pades.mjs" "server/services/java-pades-client.mjs" \
         "server/signing/providers/STSCloudProvider.mjs"; do
  git diff develop --name-only | grep -q "$p" && echo "FAIL $p" || echo "OK $p"
done
git diff develop -- server/index.mjs | grep -iE "footerRight|stampFooter|_regPrefix" | wc -l  # 0

# 7. Syntax
node --check server/services/registratura.mjs && echo OK
node --check server/routes/registratura.mjs && echo OK
node --check public/sw.js && echo OK

# 8. Tests
npm test
# Așteptat: verde, fără regresii (≥ 589)
```

---

## 📊 RAPORT FINAL (completează)

```
═══════════════════════════════════════════════════════════
RAPORT FINAL — v3.9.481 Registratură Faza 2.1
═══════════════════════════════════════════════════════════
[ ] Migrarea 076_registratura_format (default {nr5} + UPDATE serii vechi)
[ ] _fmt: token {nr5} + default schimbat
[ ] router: _sursaId capturat, compartiment auto (actor.compartiment), id întors
[ ] main.js: _csrfHdr pe toate POST-urile (csrf_invalid rezolvat)
[ ] modal: input fișier PDF + upload pe id după create
[ ] prefill compartiment din /auth/me (+ default server-side garantat)
[ ] liste Ieșiri+Intrări: nr afișat padStart(5,'0')
[ ] package.json 3.9.481 + sw v197 + cache busting
[ ] VERIFICĂRILE 1–7 trec
[ ] npm test VERDE — output atașat
[ ] git push origin develop

Smoke staging (Mircea):
  [ ] Înregistrare intrare → fără csrf_invalid, primește nr. 00003 (5 cifre)
  [ ] Compartiment pre-completat cu cel al userului logat
  [ ] Atașez PDF în modal → apare la poziție, download OK
  [ ] Lista Ieșiri: 1/18.05.2026 → afișat 00001 (data rămâne în coloana ei)
  [ ] Document emis vechi: footer/STS neschimbat (regresie zero)

Fișiere modificate: ____   OBSERVAȚII: ____
═══════════════════════════════════════════════════════════
```

---

## 🔒 CONSTRÂNGERI ABSOLUTE

1. develop only. Niciun checkout/merge/push pe `main`.
2. NO-TOUCH (vezi secțiunea). `crud.mjs`/`lifecycle.mjs`/footer/STS neatinse.
3. Serviciul `allocateNumber` — semantica emise neschimbată; doar `_fmt` capătă `{nr5}`.
4. CSRF: header `x-csrf-token` din `window.df.getCsrf()` pe toate POST-urile noi.
5. Footer-ele documentelor deja semnate NU se rescriu (imutabile).
6. `esc()` pe tot ce se afișează. Zero `localStorage`/`sessionStorage`.
7. `npm test` verde, fără regresii. Niciun test șters.
8. La final, după teste verzi: `git add -A && git commit && git push origin develop`.
```
