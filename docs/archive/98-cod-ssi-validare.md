---
model_suggested: Opus 4.8
tip: BUG DE PRODUCȚIE — cod bugetar inventat pe document semnat. Server = poarta.
---

# ⚠️ BRANCH: develop — NU `main`. NU push/merge/checkout pe main.
> `main` = PRODUCȚIE, gestionat manual, exclusiv de Mircea.

> **NO-TOUCH (doar citire):** `signing.mjs`, `cloud-signing.mjs`, `bulk-signing.mjs`,
> `pades.mjs`, `java-pades-client.mjs`, `STSCloudProvider.mjs`

---

## Context — cod bugetar liber, zero validare

Câmpul **Cod SSI** din DF (secțiunea 4 și secțiunea 5) e un `<datalist>` — **doar sugestie**.
`public/js/formular/core.js:532-546`:
```js
} catch (_) { /* silent — fallback = free text */ }
```

Utilizatorul poate tasta orice. **Serverul nu validează `cod_ssi` niciodată, nicăieri.**
Zero verificări în `server/routes/formulare/`. Un cod greșit (o cifră în plus, un caracter
lipsă) călătorește: DF → PDF semnat cu QES → **export XML către Ministerul Finanțelor**.
Clasificare bugetară greșită, pe un document cu efect juridic.

Caz real observat: câmp cu `02A67050371010` (14 caractere), în timp ce codurile valide din
listă erau `02A670503710101/102/103` (15 caractere).

**Audit pe producție (13.07.2026):** doar **2 coduri invalide**, unul într-un DF `draft` și
unul într-un `neaprobat`. **ZERO** în `completed` (10), `pending_p2` (23), `returnat` (9).
Niciun document semnat sau pe flux nu poartă cod greșit. **Paguba nu s-a produs** — reparăm
înainte să se producă.

---

## ⛔ CAPCANA PRINCIPALĂ — două ortografii ale cheii

`server/services/clasa8.mjs:110`:
```sql
COALESCE(r->>'cod_SSI', r->>'codSSI', '') AS cod_ssi
```

**Cheia JSONB apare sub DOUĂ ortografii** — `cod_SSI` și `codSSI`. Vin din tabele diferite
din DF (secțiunea 4 vs secțiunea 5). **O validare care acoperă doar una lasă cealaltă să treacă.**

Fă un helper **unic** care extrage codul dintr-un rând, folosit peste tot:
```js
const _rowCodSsi = (r) => String(r?.cod_SSI ?? r?.codSSI ?? '').trim();
```

Înainte de orice: **inventariază toate tabelele de rânduri din DF care au coloană Cod SSI.**
```bash
grep -rn "cod_SSI\|codSSI" server/ public/js/formular/ | grep -v tests
```
Raportează câte tabele și ce câmpuri JSONB le stochează (`rows_val`? `rows_plati`? altele?).
**Nu presupune că sunt doar două.**

---

## Regulile (decise de Mircea, fără excepții)

| Moment | Comportament |
|---|---|
| **Autosave / la părăsirea câmpului** | ⚠️ **Avertisment vizibil**, NU blocare. Utilizatorul e în mijlocul tastării. |
| **Salvare (PUT) cu cod invalid** | 🔴 **BLOCARE.** Documentul nu se salvează cu cod invalid — nici măcar în draft. |
| **Finalizare / trimitere pe flux** | 🔴 **BLOCARE.** |
| **Clasa 8 neimportată (listă goală)** | 🔴 **BLOCARE.** „Importă Clasa 8 mai întâi." **Fără excepții, fără fail-open, indiferent de module.** Codurile SSI sunt obligatorii. |

⚠️ **„Blocăm și editarea" NU înseamnă „nu poți deschide documentul".** Înseamnă: **poți
deschide, poți edita, dar SALVAREA e respinsă cât timp există un cod invalid** — cu mesaj care
arată **exact ce rând și ce cod**. Altfel documentul devine cărămidă: îl deschizi, nu-l poți
repara, nu-l poți salva. **Ăsta e cel mai important paragraf din prompt.**

---

## PAS 1 — Validator server-side (sursa unică de adevăr)

Fișier nou: `server/services/cod-ssi-validate.mjs`.

```js
// Validează codurile SSI dintr-un DF împotriva bugetului Clasa 8 al organizației.
// Returnează { ok, invalid: [{ tabel, index, cod }], bugetGol: bool }
export async function validateCodSsi(pool, orgId, dfData) { ... }
```

Cerințe:
- Extrage codurile din **toate** tabelele de rânduri identificate la pasul de inventar,
  folosind helperul `_rowCodSsi` (ambele ortografii).
- Rândurile cu cod **gol** (`''`) ⇒ **valide** (nu toate rândurile cer cod SSI — verifică
  în UI care sunt obligatorii; dacă nu poți stabili, **nu bloca rândurile goale**).
- Compară cu `SELECT cod_ssi FROM clasa8_buget WHERE org_id = $1`.
  ⚠️ Verifică numele real al tabelei și dacă are **versionare** (importuri versionate —
  `grep -rn "clasa8" server/db/index.mjs`). Dacă e versionată, validează **doar față de
  versiunea activă**. Raportează ce ai găsit.
- Comparație **exactă**, case-sensitive, după `trim()`. Fără `ILIKE`, fără prefixe.
- Dacă lista de coduri e **goală** ⇒ `bugetGol: true` ⇒ apelantul blochează.

⛔ **Fără cache.** Bugetul se poate reimporta oricând; un cache de 60s ar accepta coduri
tocmai șterse. E o validare, nu o listă de sugestii.

---

## PAS 2 — Aplică validatorul pe TOATE căile de scriere

Găsește-le, nu le ghici:
```bash
grep -rn "router.put\|router.post" server/routes/formulare/df.mjs
```

Aplică pe:
- `PUT /api/formulare-df/:id` (salvarea, inclusiv autosave)
- `POST /api/formulare-df/:id/complete` (finalizarea P2)
- `POST /api/formulare-df/:id/submit`
- orice altă cale care persistă `rows_val` / rândurile cu cod SSI

**Răspuns la eroare** — structurat, ca frontendul să poată evidenția rândul:
```json
{
  "error": "cod_ssi_invalid",
  "message": "Cod SSI inexistent în bugetul Clasa 8: 02A67050371010 (rândul 1).",
  "invalid": [{ "tabel": "rows_val", "index": 0, "cod": "02A67050371010" }]
}
```
Buget gol:
```json
{ "error": "clasa8_neimportat",
  "message": "Bugetul Clasa 8 nu este importat. Importă bugetul înainte de a completa DF-uri." }
```
Status: **400**.

⚠️ **NU atinge ORD** în acest prompt decât dacă inventarul arată că ORD are și el cod SSI
validabil față de aceeași listă. Dacă are — spune-o în raport și **întreabă înainte de a
extinde scopul**.

---

## PAS 3 — Frontend: avertisment la blur, mesaj clar la salvare

### 3a. Avertisment la părăsirea câmpului (nu blochează)

Inputul cu `list="ssi-codes-list"`. La `blur`:
- valoarea e `''` ⇒ nimic
- valoarea **există** în `<datalist>` ⇒ curăță orice marcaj de eroare
- valoarea **NU există** ⇒ bordură roșie + mesaj discret („Cod inexistent în Clasa 8")

Compară cu `<option>`-urile deja încărcate de `loadBugetCodes()` (`core.js:533`) — **nu face
un fetch nou la fiecare blur.**

⚠️ Folosește `textContent` / DOM API pentru mesaj. **Fără `innerHTML` cu interpolare** — am
reparat un XSS la #93, nu introducem altul.
⚠️ Folosește clasele/tokenii existenți (`tokens.css`, `--df-danger`). **Nu inventa CSS.**

### 3b. Eroarea de la salvare

`saveDoc()` (`public/js/formular/doc.js:950`) tratează deja `409` prin `_handleDup409()`
(`doc.js:936`). Adaugă tratarea **`400` cu `error: 'cod_ssi_invalid'`**: mesaj + evidențierea
rândului din `invalid[]`. Refolosește tiparul existent din `_handleDup409` (bordură roșie,
focus, curățare la `input`) — **nu construi un mecanism nou.**

Tratează separat `clasa8_neimportat` — mesaj cu îndrumare spre modulul Clasa 8.

---

## PAS 4 — Teste

**Unit** (`server/tests/unit/cod-ssi-validate.test.mjs`), importând validatorul din producție:
1. cod valid ⇒ `ok: true`
2. cod invalid ⇒ `ok: false`, `invalid[]` conține codul și indexul rândului
3. **cheia `cod_SSI`** (underscore) ⇒ detectată
4. **cheia `codSSI`** (camelCase) ⇒ detectată — *ăsta e testul care prinde capcana principală*
5. cod cu spații (` 02A67…  `) ⇒ trim, apoi validare
6. cod gol ⇒ valid (nu blochează)
7. buget gol ⇒ `bugetGol: true`
8. cod care **diferă printr-un singur caracter** (`02A67050371010` vs `02A670503710101`)
   ⇒ **invalid**. Fără potrivire pe prefix.

**DB** (`server/tests/db/cod-ssi-block.test.mjs`), Postgres real:
9. `PUT` cu cod invalid ⇒ **400**, `error: 'cod_ssi_invalid'`, și **documentul NU se modifică
   în bază** (verifică `updated_at` neschimbat).
10. `PUT` cu cod valid ⇒ **200**, se salvează.
11. `POST /complete` cu cod invalid ⇒ **400**.
12. Org fără rânduri în `clasa8_buget` ⇒ **400** `clasa8_neimportat`.

⛔ **Testele importă din producție.** Nu redeclara validatorul.

---

## PAS 5 — Versiune și cache

`package.json` → **v3.9.682**.

```bash
grep -n "formular/core.js\|formular/doc.js" public/sw.js
```
- În `PRECACHE_ASSETS` ⇒ bump `CACHE_VERSION` + `?v=3.9.682` în HTML-uri.
- Nu sunt ⇒ doar `?v=`. **Raportează ce ai găsit.**

```bash
npm run check && npm test && npm run test:db
```

Commit:
```
fix(df): validare Cod SSI împotriva bugetului Clasa 8 — blocare server-side (v3.9.682)
```

---

## RAPORT FINAL

1. **Inventar:** câte tabele de rânduri din DF au cod SSI? Ce câmpuri JSONB? Ambele ortografii (`cod_SSI`, `codSSI`) — unde apare fiecare?
2. `clasa8_buget` — nume real? E **versionat**? Validezi față de versiunea activă? Cum ai stabilit-o?
3. Ce rute persistă coduri SSI? Le-ai acoperit pe toate? Listează-le.
4. **ORD are cod SSI validabil?** Dacă da: NU l-ai extins, ai raportat. Confirmă.
5. **Cel mai important:** un DF existent cu cod invalid — utilizatorul îl poate **deschide și edita**? Salvarea e respinsă cu mesaj care arată rândul? (NU trebuie să devină cărămidă.)
6. Testul #4 (cheia `codSSI` camelCase) — trece?
7. Testul #8 (un caracter diferență) — invalid, fără potrivire pe prefix?
8. Testul #9 — la 400, documentul chiar **nu se modifică** în bază?
9. Avertismentul la blur — `textContent`, fără `innerHTML`? CSS nou: zero?
10. `CACHE_VERSION` — bumped sau nu, și de ce?
11. `npm test` **și** `npm run test:db` — separat.

---

## ⛔ CONSTRÂNGERI ABSOLUTE

- ⛔ **Ambele ortografii ale cheii.** `cod_SSI` ȘI `codSSI`. Una singură = fix incomplet.
- ⛔ **Documentul cu cod invalid TREBUIE să rămână editabil.** Blocăm salvarea, nu deschiderea.
- ⛔ **Fără cache pe lista de coduri.** E validare, nu sugestie.
- ⛔ **Fără fail-open.** Buget gol ⇒ blocare. Fără excepție pe module.
- ⛔ **Comparație exactă.** Fără `ILIKE`, fără potrivire pe prefix.
- ⛔ **Rândurile cu cod gol NU se blochează.**
- ⛔ **Fără `innerHTML` cu interpolare** în frontend. Fără CSS nou.
- ⛔ **NU extinde la ORD** fără să întrebi.
- ⛔ **NU redeclara logica în teste.**
- ⛔ Zonele NO-TOUCH: doar citire. **NU atinge `main`.**
- ⛔ Dacă un grep nu dă `# Așteptat:`, oprește-te și raportează.
