---
model_suggested: Opus 4.8
tip: RECON — read-only. Zero modificări de cod.
---

# ⚠️ BRANCH: develop — NU `main`. NU push/merge/checkout pe main.
> `main` = PRODUCȚIE, gestionat manual, exclusiv de Mircea.

> **NO-TOUCH (doar citire, niciodată editare):**
> `server/routes/flows/signing.mjs`, `server/routes/flows/cloud-signing.mjs`,
> `server/routes/flows/bulk-signing.mjs`, `server/signing/pades.mjs`,
> `server/signing/java-pades-client.mjs`, `server/signing/providers/STSCloudProvider.mjs`

---

## ⛔ CITEȘTE ASTA ÎNAINTE DE ORICE

**Modulul ALOP funcționează corect.** Comportamentul lui a fost validat manual, în producție,
împotriva OMF 1140/2025 (modificat prin OMF 2037/2025). **Codul este specificația.**

Acest prompt **NU repară ALOP-ul**. Nu ai voie să „corectezi" nicio tranziție, oricât de ciudată
ți-ar părea. Dacă găsești o tranziție înapoi (`ordonantare → lichidare`), sau un salt
(`draft → lichidare`), sau un update în masă pe mai multe rânduri — **acelea sunt corecte
și intenționate.** Le documentezi, nu le judeci.

Ce e greșit e altceva: constanta `VALID_TRANSITIONS` din `server/routes/alop.mjs:159` a rămas
în urma codului, are **zero apelanți** (`canTransition()` la linia 168 nu e chemată nicăieri),
iar testul `server/tests/unit/alop-state.test.mjs` **își redeclară propria copie a funcției**
(linia 31 — singurul lui import e `vitest`), deci e verde de luni de zile testând o oglindă,
nu producția.

**Misiunea ta aici: extragi matricea de tranziții REALĂ din cod, ca text.**
Într-un prompt ulterior (#92) o vom transforma în poartă unică + constrângere DB.
Fără recon-ul ăsta, poarta s-ar construi peste tabela fosilă și ar rupe producția.

---

## Obiectiv

Un singur fișier nou: **`docs/audits/ALOP-STATE-MATRIX.md`**.
Zero modificări în `server/`, `public/`, `package.json`, migrații. Zero bump de versiune.

---

## PAS 1 — Inventarul complet al scrierilor de status

Toate scrierile pe `alop_instances` (40 de situri, 7 fișiere). Confirmă numărul:

```bash
grep -rn "UPDATE alop_instances" server --include="*.mjs" | grep -v tests | wc -l
# Așteptat: 40
grep -rln "UPDATE alop_instances" server --include="*.mjs" | grep -v tests
# Așteptat: 7 fișiere (alop-link.mjs, formular-shared.mjs, crud.mjs, lifecycle.mjs,
#           signing.mjs, alop.mjs, formulare/df.mjs)
```

**Separă-le în două categorii.** Nu toate cele 40 ating `status`:

- **Categoria A — scriu `status`** (`SET ... status = ...`, inclusiv `CASE WHEN`, inclusiv
  `sets.push()` dinamic — vezi `alop.mjs:715` unde `status='plata'` se adaugă condiționat).
- **Categoria B — NU scriu `status`** (doar `df_id`, `ord_flow_id`, `titlu`, câmpuri
  `lichidare_*`/`plata_*` etc.). Astea NU intră în poartă la #92. Le listezi separat, scurt.

⚠️ **Capcană:** `status` apare des în `WHERE`, nu în `SET`. Un `WHERE status='ordonantare'`
**nu** face situl să fie Categoria A. Citește fiecare `SET` cu ochii, nu cu grep.

---

## PAS 2 — Pentru fiecare sit din Categoria A, extrage exact 6 lucruri

| Câmp | Ce vreau |
|---|---|
| **Locație** | `fișier:linie` |
| **Trigger** | ce acțiune de utilizator / eveniment de flux ajunge aici (numele rutei sau al funcției) |
| **from → to** | stările sursă (din `WHERE`) și starea destinație (din `SET`). Dacă `WHERE` nu constrânge statusul, scrie `ORICE → x` și **marchează cu ⚠️** |
| **Gardă** | condiția completă din `WHERE` (status, `org_id`, `cancelled_at`, `df_flow_id IS NOT NULL`, `plata_confirmed_at IS NULL`, ...) |
| **0 rânduri = ?** | **CRITIC.** Ce se întâmplă când UPDATE-ul nu prinde niciun rând? Trei variante: `NO-OP TĂCUT` (self-heal idempotent, e OK), `EROARE 4xx` (`if (!rows[0]) return res.status(400)...`), sau `NECONTROLAT` (nimeni nu verifică `rows`). Citește codul de după query. |
| **Tranzacțional?** | rulează pe `pool.query` sau pe un `client` dintr-un `BEGIN/COMMIT`? |

**Distincția „0 rânduri" e cea mai importantă din tot promptul.** La #92, poarta trebuie să
suporte AMBELE regimuri: unele situri vor no-op tăcut (`alop-link.mjs`, `crud.mjs:452`,
`signing.mjs:437` sunt self-heal-uri idempotente — o excepție acolo ar transforma o
reconciliere liniștită într-un 500 pe calea de semnare), altele vor eroare explicită.
Dacă greșești clasificarea aici, #92 pică în producție.

---

## PAS 3 — Cazurile speciale (tratează-le individual, nu le forța în tabel)

Trei situri nu sunt tranziții per-instanță și au nevoie de secțiune proprie:

1. **`alop.mjs:1583`** — `UPDATE alop_instances a SET status = CASE ... END` pe **mai multe
   rânduri deodată** (resync bulk). Descrie: ce selectează, ce stări poate produce, cine îl
   declanșează, dacă e idempotent.
2. **`alop.mjs:1523`** — reset ciclu ORD: duce ALOP-ul **înapoi** la `lichidare` și golește
   toate câmpurile `ord_*`/`plata_*`. **Este corect și intenționat.** Documentează din ce stări
   se poate intra și de ce (legea permite reluarea ordonanțării).
3. **`alop.mjs:1672`** — `cancelled`. Din ce stări e permis (vezi `WHERE status != 'completed'`).

---

## PAS 4 — Adevărul din bază

Rulează pe baza de test locală **sau**, dacă ai `DATABASE_URL` de staging în `.env`, pe staging.
**NU pe producție.** Dacă nu ai acces la nicio bază, scrie explicit „NEVERIFICAT — fără acces DB"
în raport și treci mai departe; nu inventa cifre.

```sql
SELECT status, COUNT(*) FROM alop_instances GROUP BY status ORDER BY 2 DESC;
SELECT status, COUNT(*) FROM alop_instances WHERE cancelled_at IS NOT NULL GROUP BY status;
```

Motivul: la #92 vrem `CHECK (status IN (...))`. Dacă în bază există fie și **un singur** rând cu
un status care nu e în listă (un orfan dintr-o migrare veche), constrângerea pică la boot,
`markDbFailed()` se declanșează, `DB_READY` rămâne `false` și aplicația nu mai servește nicio
rută DB. **Exact incidentul din 19.04.2026** (`docs/incidents/2026-04-19-db-init-failure.md`
— citește-l, ca să înțelegi miza).

---

## PAS 5 — Divergențele față de `VALID_TRANSITIONS`

Compară matricea reală (PAS 2+3) cu constanta de la `alop.mjs:159`. Tabel cu 3 coloane:
**tranziție reală** | **permisă de `VALID_TRANSITIONS`?** | **verdict**.

Verdictul e întotdeauna unul dintre:
- `CODUL E CORECT — tabela e incompletă` (cazul normal; tabela se va extinde la #92)
- `TABELA E CORECTĂ — codul nu execută niciodată tranziția asta` (tranziție moartă)

**Nu există verdictul „codul e greșit".** Dacă crezi că ai găsit unul, NU-l repara: notează-l
într-o secțiune finală `## Întrebări pentru Mircea` și oprește-te acolo.

---

## PAS 6 — Auditul (pregătire pentru #92)

`writeAuditEvent` (`server/db/index.mjs:2249`) folosește `pool.query` propriu și înghite
eroarea în `catch`. Deci o tranziție poate face commit fără urmă de audit.

Pentru fiecare sit din Categoria A, notează într-o coloană finală: **există un
`writeAuditEvent` corespunzător?** (`DA` / `NU` / `DA, dar în afara tranzacției`).

Doar constatare. **Nu modifica `writeAuditEvent` în acest prompt.**

---

## PAS 7 — Verificare finală

```bash
git status --short
# Așteptat: EXCLUSIV docs/audits/ALOP-STATE-MATRIX.md (untracked)

git diff --name-only server/ public/ package.json
# Așteptat: GOL. Zero linii.

npm run check
# Așteptat: verde (n-ai atins nimic, dar confirmăm)
```

Commit doar fișierul de audit, pe `develop`:
```
docs: matricea reală de tranziții ALOP (recon pentru #92)
```

**Fără bump de versiune. Fără atingere `sw.js` / `CACHE_VERSION` / `?v=`.**
E doar documentație — nu e o schimbare vizibilă pentru utilizator.

---

## RAPORT FINAL

Răspunde punctual:

1. Câte situri Categoria A (scriu `status`) și câte Categoria B? (suma = 40)
2. Matricea reală, ca listă compactă `from → to (n situri)`.
3. Câte situri au `0 rânduri = NO-OP TĂCUT` vs `EROARE 4xx` vs `NECONTROLAT`?
4. Există vreun sit **fără nicio gardă de status în `WHERE`** (`ORICE → x`)? Care?
5. Câte situri rulează într-o tranzacție reală vs pe `pool.query` liber?
6. `SELECT DISTINCT status` — ce valori există efectiv în bază? Vreun orfan care ar rupe un `CHECK`?
7. Divergențele față de `VALID_TRANSITIONS` (tabelul de la PAS 5).
8. Câte situri Categoria A au audit și câte nu?
9. Ai găsit ceva ce ți se pare o **greșeală reală** de comportament? (Dacă da: descrie, NU repara.)
10. `git diff --name-only server/ public/` — gol? Confirmă.

---

## ⛔ CONSTRÂNGERI ABSOLUTE

- ⛔ **ZERO modificări în `server/`, `public/`, `package.json`, migrații.** Singurul fișier
  nou permis: `docs/audits/ALOP-STATE-MATRIX.md`.
- ⛔ **NU „repara" nicio tranziție.** ALOP-ul funcționează conform legii. Codul e specificația.
- ⛔ **NU șterge** `VALID_TRANSITIONS`, `canTransition()`, sau `alop-state.test.mjs`.
  Sunt greșite, dar le demolăm la #92, controlat, nu acum.
- ⛔ **NU crea** `transitionAlop()` și **NU adăuga** niciun `CHECK` constraint. Ăla e #92.
- ⛔ **NU rula nimic pe baza de PRODUCȚIE.** Local sau staging.
- ⛔ **NU atinge `main`.** Doar `develop`.
- ⛔ Zonele NO-TOUCH: **doar citire.** `signing.mjs` se citește, nu se editează — chiar dacă
  vezi acolo `UPDATE alop_instances SET status='lichidare'` la linia 437 și te mănâncă mâna.
- ⛔ Dacă un grep de verificare nu dă rezultatul din `# Așteptat:`, **oprește-te și raportează.**
  Nu improviza.
