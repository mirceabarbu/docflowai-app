# PROMPT #129 — limita de import OPME: 5 MB → 10 MB

> ## ⚠️ BRANCH: `develop`
> Toate commit-urile pe `develop`. **NU** propune și **NU** executa `checkout main`,
> `merge main`, `push origin main`. Deploy-ul în producție îl face Mircea manual.

**Model recomandat:** Sonnet 4.6 (Default) · **Target versiune:** `v3.9.760` (de la 3.9.759)
**Migrații:** ZERO

> ⚠️ **Ordine:** promptul #128b (fundația ORD multi-bloc) NU a fost încă rulat. Dacă îl rulezi
> DUPĂ acesta, ținta lui de versiune devine `v3.9.761`, nu `760`.

---

## 1. Cerința

Importul OPME (PDF F1129) e limitat la 5 MB. Fișierele reale de la trezorerie depășesc limita.
Se ridică la **10 MB**.

⚠️ Limita există în **DOUĂ** locuri independente, plus **TREI** texte afișate utilizatorului.
Dacă se schimbă doar serverul, clientul refuză fișierul înainte să-l trimită și pare că fixul
n-a funcționat. Toate cinci se schimbă în acest lot.

Inventar verificat pe arhiva v3.9.759:

| Fișier | Linie | Ce e |
|---|---|---|
| `server/routes/opme.mjs` | 23 | `const MAX_BYTES = 5 * 1024 * 1024; // 5 MB` — folosit la `Busboy limits.fileSize` (:105) |
| `public/js/components/opme-import-modal.js` | 18 | `const MAX_BYTES = 5 * 1024 * 1024;` |
| `public/js/components/opme-import-modal.js` | 7 | comentariu de antet: „…validare client (.pdf, ≤5 MB)" |
| `public/js/components/opme-import-modal.js` | 44 | text vizibil: „Doar PDF F1129 · max 5 MB" |
| `public/js/components/opme-import-modal.js` | 137 | mesaj de eroare: „Fișierul depășește 5 MB." |

---

## 2. NO-TOUCH

⛔ `server/signing/**`, `server/routes/flows/signing.mjs`, `cloud-signing.mjs`, `bulk-signing.mjs`
⛔ `server/services/opme-parser.mjs` și `server/services/opme-matcher.mjs` — logica de parsare și
   potrivire NU se atinge
⛔ Nu schimba `limits.files: 1`, nu schimba nicio altă limită din proiect
   (`/api/convert-to-pdf` rămâne la 50 MB)
⛔ Zero refactorizări în trecere

---

## 3. Patch-uri

### 3.1 Server — `server/routes/opme.mjs`

**old_str:**
```js
const MAX_BYTES = 5 * 1024 * 1024; // 5 MB
```
**new_str:**
```js
const MAX_BYTES = 10 * 1024 * 1024; // 10 MB (#129 — ridicat de la 5 MB; fișierele F1129 reale de la trezorerie depășeau limita)
```

### 3.2 Client — `public/js/components/opme-import-modal.js`

Patru înlocuiri, în ordine:

**(a)** `const MAX_BYTES = 5 * 1024 * 1024;` → `const MAX_BYTES = 10 * 1024 * 1024;`

**(b)** în comentariul de antet: `≤5 MB` → `≤10 MB`

**(c)** textul vizibil: `Doar PDF F1129 · max 5 MB` → `Doar PDF F1129 · max 10 MB`

**(d)** mesajul de eroare: `Fișierul depășește 5 MB.` → `Fișierul depășește 10 MB.`

⚠️ Verifică întâi că fiecare `old_str` e unic în fișier
(`grep -n "5 MB\|5 \* 1024" public/js/components/opme-import-modal.js`). Dacă vreunul nu e unic,
extinde-l cu context — nu ghici.

### 3.3 Cache busting

`public/js/components/opme-import-modal.js` E un fișier din `public/`. Verifică pe cod, **nu
presupune**:

```bash
grep -n "opme-import-modal" public/sw.js
grep -rn "opme-import-modal" public/*.html
```

- Dacă apare în `PRECACHE_ASSETS` din `sw.js` → **bump obligatoriu `CACHE_VERSION`** (citește
  valoarea curentă din fișier, nu o presupune — era `v300` la v3.9.756).
- Dacă NU apare → e suficient `?v=3.9.760` țintit pe referințele din HTML, iar `CACHE_VERSION`
  rămâne neschimbat.

Raportează care dintre cele două cazuri e valabil și ce ai făcut.

---

## 4. Test

Extinde suita existentă OPME dacă are un caz pe limită
(`grep -rn "MAX_BYTES\|prea mare\|file_too_large" server/tests/`). Dacă există un test care
codifică pragul de 5 MB, **actualizează-l la 10 MB** și raportează care.

Dacă NU există niciun test pe limită, adaugă unul singur, minimal, în suita unitară OPME
existentă: un buffer de 10 MB + 1 octet e respins, unul de 9 MB e acceptat de gardă.
⛔ Nu construi o schelă nouă de test pentru atât — dacă suita existentă nu permite testarea
limitei fără infrastructură nouă, spune-o în raport și sari peste, nu improviza.

---

## 5. Rulare, versionare, push

```bash
npm test
npm run test:db
```

⛔ „Skipped" NU e „passed" — rețeta cu PG 17 efemer din `CLAUDE.md`.

Apoi: bump `package.json` → `3.9.760`; commit pe `develop` cu
`feat(#129): limita de import OPME ridicată de la 5 MB la 10 MB (server + client)`;
`git push origin develop`. ⛔ Fără `--amend`, fără `--force`.

---

## 6. Verificări de ieșire (verbatim în raport)

```bash
grep -rn "5 \* 1024 \* 1024" server/routes/opme.mjs public/js/components/opme-import-modal.js
# Așteptat: 0 rezultate

grep -rn "10 \* 1024 \* 1024" server/routes/opme.mjs public/js/components/opme-import-modal.js
# Așteptat: exact 2 linii (una per fișier)

grep -n "5 MB" public/js/components/opme-import-modal.js
# Așteptat: 0 rezultate

grep -c "10 MB" public/js/components/opme-import-modal.js
# Așteptat: 3

git status --short
# Așteptat: package.json, server/routes/opme.mjs, opme-import-modal.js, eventual sw.js/HTML
#           pentru cache busting, eventual un fișier de test. ⚠️ Working tree-ul are ~50 de
#           fișiere netracked din sesiuni anterioare — ignoră-le și CONFIRMĂ ce ai stage-uit.
```

---

## 7. RAPORT FINAL

- commit hash + intervalul de push
- `npm test` / `npm run test:db`: numere REALE
- ieșirea celor 5 verificări, verbatim
- **cazul de cache busting**: `opme-import-modal.js` e sau nu în `PRECACHE_ASSETS`, și ce ai făcut
- dacă ai găsit un al ȘASELEA loc cu limita de 5 MB pe care inventarul de mai sus nu-l listează —
  **raporteaz-o explicit**, e cea mai valoroasă constatare posibilă aici
- orice abatere, cu motivul. Dacă găsești o eroare în prompt, **spune-o, nu o repara tăcut**
