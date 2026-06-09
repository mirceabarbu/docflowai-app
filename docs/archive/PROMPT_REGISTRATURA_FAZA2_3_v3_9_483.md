# DocFlowAI — 🔢 v3.9.483: Registratură Faza 2.3 — numerotare continuă comună intrare+ieșire (petiții/544 separat) + legătură flux în Ieșiri

```
═══════════════════════════════════════════════════════════
⚠️  BRANCH OBLIGATORIU: develop
⚠️  NU face checkout/merge/push pe main. NICIODATĂ.
⚠️  Producția (main → app.docflowai.ro) o gestionează Mircea manual.
═══════════════════════════════════════════════════════════

DocFlowAI v3.9.482 → v3.9.483 (SW v198 → v199)
Branch: develop
Subiect: feat(registratura): numerotare continuă comună ieșiri+intrări
         generale pe seria 'general' (petiții/544 rămân serii proprii) +
         legătură flow_id afișată în tab-ul Ieșiri (simetric cu Intrări)
```

> Citește `.claude/skills/docflowai-ui/SKILL.md` înainte de partea de frontend
> (afișare link flux conform design system, escaping, fără markup off-pattern).

---

## 🎯 Context — 2 cerințe

### A. Numerotare continuă comună (fără dubluri intrare/ieșire)

Azi numărul e alocat pe cheia `(org_id, registru, an)` din `registru_serii`.
Ieșirile emise folosesc `registru='general'`, iar intrările generale
`registru='intrare'` → **două contoare distincte**, ambele pornesc de la 1
(de-aia o intrare nouă ar primi 00001 deși există deja 00001/00002 la ieșiri).

**Model dorit (confirmat):**
- `general` = serie **unică, continuă**, comună pentru **ieșiri + intrări
  generale**. 2 ieșiri (00001, 00002) → o intrare generală ia **00003** →
  următoarea ieșire **00004**. Fără dubluri între direcții.
- `petitii` = serie proprie 1..N (OG 27/2002, termen 30 zile) — neschimbat.
- `544` = serie proprie 1..N (Legea 544/2001, termen 10 zile) — neschimbat.
- `directie` (`intrare`/`iesire`) rămâne coloană; tab-urile filtrează pe
  `directie`, NU pe `registru`, deci separarea Ieșiri/Intrări nu se rupe când
  intrările generale trec pe `registru='general'`.

### B. Legătură flux în tab-ul Ieșiri

În tab-ul **Ieșiri** fiecare poziție are deja `flow_id` în DB (e auto-generată
dintr-un flux) dar nu e afișat. Adaugă afișarea/legătura către flux **exact
cum e deja în tab-ul Intrări** (acolo se afișează fluxul-răspuns legat). Pur
afișare — datele există.

---

## ⛔ ABSOLUTE — NU se ating

1. NO-TOUCH permanent: `cloud-signing.mjs`, `bulk-signing.mjs`, `pades.mjs`,
   `java-pades-client.mjs`, `STSCloudProvider.mjs`, `lifecycle.mjs`,
   `crud.mjs`, `stampFooterOnPdf` din `index.mjs`.
2. `server/services/registratura.mjs` (`allocateNumber`) — **neatins**.
   Schimbăm DOAR ce `registru` primește o intrare, nu mecanismul de alocare
   (rămâne atomic + idempotent, keyed pe `(org_id, registru, an)`).
3. Calea emise (flux → `registru='general'`, `directie='iesire'`) — neschimbată.
4. Petiții/544 — serii și termene neschimbate.
5. Niciun test existent șters / dezactivat.

---

## 📋 Modificări detaliate

### 1. `server/db/index.mjs` — migrarea `077_registratura_serie_comuna`

Migrează intrările generale vechi (`registru='intrare'`) pe `registru='general'`,
**renumerotându-le** ca să continue după maximul existent pe org/an (zero
coliziuni cu 00001/00002 deja alocate), re-seed-uiește contorul seriei
`general`, apoi curăță seria `intrare` nefolosită. Idempotentă (a doua rulare
nu mai are ce muta).

**Verificare context:**
```bash
grep -n "id: '076_registratura_format'" server/db/index.mjs   # ultima migrare
grep -n "^];" server/db/index.mjs | head -1
```

old_str:
```javascript
      UPDATE registru_serii
         SET pattern = '{nr5}'
       WHERE pattern = '{nr}/{dd}.{mm}.{yyyy}';
    `
  }
];
```

new_str:
```javascript
      UPDATE registru_serii
         SET pattern = '{nr5}'
       WHERE pattern = '{nr}/{dd}.{mm}.{yyyy}';
    `
  },
  {
    id: '077_registratura_serie_comuna',
    sql: `
      -- Numerotare continuă comună pentru ieșiri + intrări GENERALE.
      -- Intrările generale (registru='intrare') trec pe registru='general'
      -- și se renumerotează continuând după max(numar) existent pe org/an,
      -- ca să nu colizioneze cu numerele deja alocate ieșirilor.
      -- Petiții/544 NU se ating (serii proprii).
      WITH base AS (
        SELECT org_id, an, COALESCE(MAX(numar), 0) AS maxn
          FROM registru_intrari
         WHERE registru = 'general'
         GROUP BY org_id, an
      ),
      ren AS (
        SELECT i.id,
               COALESCE(b.maxn, 0)
                 + ROW_NUMBER() OVER (PARTITION BY i.org_id, i.an
                                      ORDER BY i.numar, i.id) AS newnum
          FROM registru_intrari i
          LEFT JOIN base b ON b.org_id = i.org_id AND b.an = i.an
         WHERE i.registru = 'intrare'
      )
      UPDATE registru_intrari t
         SET registru     = 'general',
             numar        = r.newnum,
             numar_format = lpad(r.newnum::text, 5, '0')
        FROM ren r
       WHERE t.id = r.id;

      -- Re-seed contorul seriei 'general' la max(numar) pe org/an
      INSERT INTO registru_serii (org_id, registru, an, contor)
        SELECT org_id, 'general', an, MAX(numar)
          FROM registru_intrari
         WHERE registru = 'general'
         GROUP BY org_id, an
      ON CONFLICT (org_id, registru, an)
        DO UPDATE SET contor = GREATEST(registru_serii.contor, EXCLUDED.contor),
                      updated_at = NOW();

      -- Seria 'intrare' nu mai e folosită
      DELETE FROM registru_serii WHERE registru = 'intrare';
    `
  }
];
```

---

### 2. `server/routes/registratura.mjs` — intrările generale folosesc seria `general`

**Verificare context:**
```bash
grep -n "includes(String(b.registru))" server/routes/registratura.mjs
grep -n "const TERMEN_REGISTRU" server/routes/registratura.mjs
```

**2a. Whitelist + default registru.** Intrările „generale" → `registru='general'`
(aceeași serie ca ieșirile). Petiții/544 rămân.

old_str:
```javascript
    const registru = ['intrare', 'petitii', '544'].includes(String(b.registru))
      ? String(b.registru) : 'intrare';
```

new_str:
```javascript
    // 'general' = serie comună cu ieșirile (numerotare continuă).
    // petiții/544 = serii proprii (legi speciale). Default = general.
    const registru = ['general', 'petitii', '544'].includes(String(b.registru))
      ? String(b.registru) : 'general';
```

**2b. Harta termenelor — `general` fără termen legal, restul neschimbat.**

old_str:
```javascript
const TERMEN_REGISTRU = { petitii: 30, '544': 10, intrare: null, general: null };
```

new_str:
```javascript
const TERMEN_REGISTRU = { general: null, petitii: 30, '544': 10 };
```

> `TERMEN_REGISTRU[registru] ?? null` rămâne corect: pentru `general` → null
> (corespondență generală fără termen legal), petiții→30, 544→10.

> Restul handler-ului (idempotență, `_sursaId`, `_comp`, re-citire `id`,
> upload atașament, derivare status) — **neatins**. Filtrarea listelor e pe
> `directie`, deci intrarea generală cu `registru='general'` +
> `directie='intrare'` apare corect DOAR în tab-ul Intrări.

---

### 3. `public/registratura.html` + `public/js/registratura/main.js` — frontend

**3a. Modal „Înregistrare document intrat" — valorile din `<select>` registru.**

Opțiunea „Intrări generale" trebuie să trimită `registru="general"` (nu
`"intrare"`). „Petiții" → `"petitii"`, „Cereri 544" → `"544"`. Inspectează
`<select>`-ul de registru din modal și corectează `value`-urile:
- Intrări generale → `value="general"`
- Petiții (OG 27/2002) → `value="petitii"`
- Cereri 544 (Legea 544/2001) → `value="544"`

(Eticheta vizibilă rămâne în limba română; doar `value` se aliniază.)

**3b. Tab-ul Ieșiri — afișează legătura cu fluxul, simetric cu Intrări.**

În randarea rândurilor din tab-ul **Ieșiri**, adaugă afișarea/legătura
`flow_id` (răspunsul listei conține deja `flowId`). Replică **exact** modul
în care tab-ul **Intrări** afișează fluxul legat (`raspunsFlowId`): aceeași
clasă, același mod (link sau text monospace truncat cu `title` complet),
 același `window.df.esc()`. Dacă Intrări deschide fluxul printr-un link/rută,
folosește exact aceeași țintă; dacă doar afișează id-ul, fă la fel. Scopul:
cele două tab-uri să fie identice ca tratament al fluxului.

Dacă în tab-ul Ieșiri nu există încă o coloană pentru asta, adaug-o ca ultimă
coloană „Flux" (header în thead + celulă în tbody), conform stilului de tabel
din `.card table` (vezi skill, secțiunea Tabele) — fără stil inline ad-hoc.

---

### 4. Bump versiune & cache busting

- `package.json`: `"version": "3.9.482",` → `"version": "3.9.483",`
- `public/sw.js`: `const CACHE_VERSION = 'docflowai-v198';` → `'docflowai-v199';`
- Cache busting:
```bash
find public -maxdepth 1 -name "*.html" -type f -exec \
  sed -i -E 's/\?v=3\.9\.482/\?v=3.9.483/g' {} +
```

---

## ✅ VERIFICĂRI OBLIGATORII

```bash
# 1. Migrarea 077
grep -c "id: '077_registratura_serie_comuna'" server/db/index.mjs   # 1
grep -c "DELETE FROM registru_serii WHERE registru = 'intrare'" server/db/index.mjs  # 1
grep -c "lpad(r.newnum::text, 5, '0')" server/db/index.mjs          # 1

# 2. Router — intrările generale pe seria 'general'
grep -c "\['general', 'petitii', '544'\]" server/routes/registratura.mjs  # 1
grep -c "{ general: null, petitii: 30, '544': 10 }" server/routes/registratura.mjs  # 1
grep -c "'intrare'" server/routes/registratura.mjs
# Așteptat: 0 ocurențe ca valoare de registru (directie='intrare' rămâne — verifică
# manual că singurele 'intrare' rămase se referă la DIRECȚIE, nu la registru)

# 3. Frontend — select values + flux în Ieșiri
grep -c 'value="general"' public/registratura.html                  # ≥ 1
grep -c 'value="petitii"' public/registratura.html                  # ≥ 1
grep -c 'value="544"' public/registratura.html                      # ≥ 1
grep -Ec "flowId|flow_id|Flux" public/js/registratura/main.js       # ≥ 1

# 4. Versiune + SW + cache busting
grep '"version"' package.json | head -1            # "version": "3.9.483",
grep "^const CACHE_VERSION" public/sw.js           # docflowai-v199
grep -rE "\?v=3\.9\.482" public/*.html | wc -l     # 0

# 5. NO-TOUCH
for p in cloud-signing bulk-signing pades java-pades-client STSCloudProvider \
         "flows/lifecycle.mjs" "flows/crud.mjs"; do
  git diff develop --name-only | grep -q "$p" && echo "FAIL $p" || echo "OK $p"
done
git diff develop -- server/index.mjs | wc -l                # 0
git diff develop -- server/services/registratura.mjs | wc -l # 0 (allocateNumber neatins)

# 6. Syntax + teste
node --check server/db/index.mjs && echo "OK db"
node --check server/routes/registratura.mjs && echo "OK router"
node --check public/sw.js && echo "OK sw"
npm test
# Așteptat: verde, fără regresii (≥ 589)
```

---

## 📊 RAPORT FINAL

```
═══════════════════════════════════════════════════════════
RAPORT FINAL — v3.9.483 Registratură Faza 2.3
═══════════════════════════════════════════════════════════
[ ] Migrarea 077: intrare→general renumerotat (fără coliziuni), serie reseed,
    serie 'intrare' ștearsă
[ ] Router: intrări generale pe registru='general'; TERMEN_REGISTRU actualizat
[ ] allocateNumber NEATINS (git diff services/registratura.mjs = 0)
[ ] Modal: value-uri general/petitii/544 corecte
[ ] Tab Ieșiri: legătură flux afișată simetric cu Intrări
[ ] package.json 3.9.483 + sw v199 + cache busting (0 ?v=3.9.482)
[ ] VERIFICĂRILE 1–6 trec
[ ] npm test VERDE (≥ 589) — output atașat
[ ] NO-TOUCH integral (server signing/lifecycle/crud neatinse)
[ ] git push origin develop

Smoke staging (Mircea):
  [ ] 2 ieșiri existente (00001, 00002) → înregistrez o intrare generală →
      primește 00003 (NU 00001); următoarea ieșire → 00004
  [ ] O petiție nouă → serie proprie (1.. independent de general); termen +30 zile
  [ ] O cerere 544 → serie proprie; termen +10 zile
  [ ] Tab Ieșiri: fiecare rând arată/lincă fluxul, la fel ca în Intrări
  [ ] Document emis vechi: footer/STS neschimbat (regresie zero)

Fișiere modificate: ____   OBSERVAȚII: ____
═══════════════════════════════════════════════════════════
```

---

## 🔒 CONSTRÂNGERI ABSOLUTE

1. develop only. Niciun checkout/merge/push pe `main`.
2. NO-TOUCH integral (signing/PAdES/STS/lifecycle/crud/footer).
3. `allocateNumber` neatins — schimbăm doar ce `registru` primește o intrare.
4. Migrarea 077 renumerotează fără coliziuni și e idempotentă.
5. Petiții/544 — serii și termene legale neschimbate.
6. Frontend conform `.claude/skills/docflowai-ui/SKILL.md`; `esc()` pe flowId.
7. `npm test` verde, fără regresii. Niciun test șters.
8. La final, după teste verzi: `git add -A && git commit && git push origin develop`.
```
