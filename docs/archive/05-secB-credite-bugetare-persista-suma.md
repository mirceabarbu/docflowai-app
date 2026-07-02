---
fix: SecB DF — persistă suma „credite bugetare" + o singură bifă (varianta 2)
target_branch: develop
model_suggested: Opus 4.8 (câmp pe document CFP semnat — sumă tipărită pe PDF oficial)
risk: SCĂZUT-MEDIU — migrare aditivă + frontend localizat; dar e cuantum pe bani publici, tipărit pe documentul semnat
version: 3.9.584 → 3.9.585
---

# ⚠️ BRANCH `develop` EXCLUSIV
Toate comenzile rulează pe `develop`. NU `checkout/merge/push` pe `main`. `main` = producție, manual de owner. La final: `git push origin develop` și STOP. NU propune merge în `main`.

## NO-TOUCH
`STSCloudProvider.mjs`, `cloud-signing.mjs`, `bulk-signing.mjs`, `pades.mjs`, `java-pades-client.mjs`. `git diff` curat pe ele.

## Context — bug confirmat
Secțiunea B (viza CFP) a DF are două perechi bifă+sumă cu nume aproape identice (diferă printr-un underscore):

| | Pereche 1 — credite de angajament | Pereche 2 — credite bugetare |
|---|---|---|
| Bifă | `ckbx_fara_inreg_ctrl_ang` (`n-ck-fararezv`) | `ckbx_fara_inreg_ctrl_crd_bug` (`n-ck-fararezvcrbug`) |
| Sumă | `sum_fara_inreg_ctrl_crdbug` (`n-sumfara`) | `sum_fara_inreg_ctrl_crd_bug` (`n-sumfararezvcrbug`) |

**Pereche 2 e câmp-fantomă:** `core.js` o strânge, dar NU are coloană în DB, NU e în whitelist-ul `DF_P2_FIELDS`, `pick(body, p2Fields)` o aruncă server-side, iar `doc.js` n-o restaurează la reload. Rezultat: suma „credite bugetare" se pierde la ORICE reload din DB (vizibil mai ales la întoarcerea DF→P1). PDF-ul (`formulare.mjs`) o citește deja ca `sumCb` în fraza CFP combinată, dar primește mereu gol → tipărește `_______` pe documentul oficial semnat.

## Decizie owner — varianta 2
**O singură bifă** (ca în PDF, care gate-uiește toată fraza pe `ckbx_fara_inreg_ctrl_ang`), iar **textul tipărit se compune din AMBELE sume**. Concret:
1. Retragem a doua bifă (`ckbx_fara_inreg_ctrl_crd_bug` / `n-ck-fararezvcrbug`) din UI și din colectare.
2. Păstrăm AMBELE input-uri de sumă, mutate în aceeași frază sub o singură bifă.
3. **Persistăm** a doua sumă (`sum_fara_inreg_ctrl_crd_bug`) ca pereche 1.
4. PDF-ul rămâne NEATINS (deja corect).

Starea finală a frazei (UI și PDF identice):
> ☐ Nu s-au rezervat în sistemul de control al angajamentelor credite de angajament în cuantum de **[n-sumfara]** lei, respectiv credite bugetare în cuantum de **[n-sumfararezvcrbug]** lei

## Caracterizare-întâi (confirmă înainte să modifici)
```bash
# 1. Confirmă cele 2 perechi în frontend (collect + restore)
grep -n "fara_inreg_ctrl_ang\|fara_inreg_ctrl_crd_bug\|fara_inreg_ctrl_crdbug\|n-sumfara\|n-sumfararezvcrbug\|n-ck-fararezv\|n-ck-fararezvcrbug" public/js/formular/core.js public/js/formular/doc.js
# 2. Whitelist-ul de persistare P2 (sum_fara_inreg_ctrl_crd_bug NU e acolo)
grep -n "DF_P2_FIELDS" -A6 server/services/formular-shared.mjs
# 3. Confirmă că NU există coloană crd_bug în DB (doar crdbug, pereche 1)
grep -n "crd_bug\|crdbug" server/db/index.mjs
# 4. Confirmă PDF-ul: gate pe ckbx_fara_inreg_ctrl_ang, sumCa + sumCb deja compuse
grep -n "ckbx_fara_inreg_ctrl_ang\|sum_fara_inreg_ctrl_crdbug\|sum_fara_inreg_ctrl_crd_bug\|respectiv credite bugetare" server/routes/formulare.mjs
# 5. A doua bifă apare DOAR în 2 locuri (o retragem) — confirmă zero alte referințe
grep -rn "n-ck-fararezvcrbug\|ckbx_fara_inreg_ctrl_crd_bug" server/ public/ --include="*.mjs" --include="*.js" --include="*.html" | grep -v node_modules
# 6. Ultima migrare inline (087 e următoarea)
grep -oE "id:\s*'[0-9]+_[^']+'" server/db/index.mjs | sort -t"'" -k2 -V | tail -3
```
Dacă oricare premisă diferă (ex. apare o coloană crd_bug, sau a doua bifă e folosită undeva neașteptat) → OPREȘTE și raportează înainte să implementezi.

## Etapa 0 — test de caracterizare (red → green)
În `server/tests/db/caracterizare-complete-df-ord.test.mjs` există deja un test care setează `sum_fara_inreg_ctrl_crdbug` (pereche 1). Extinde-l (sau adaugă un test surori) care:
- la `complete`/P2 setează ȘI `sum_fara_inreg_ctrl_crd_bug` (ex. `'100000'`);
- recitește DF-ul din DB (GET / reload) și **asertează că `sum_fara_inreg_ctrl_crd_bug` se păstrează**.

Acest test trebuie să fie **ROȘU înainte de fix** (valoarea se pierde — documentează bug-ul) și **VERDE după fix**. Nu slăbi nicio aserțiune existentă pe pereche 1.

## Implementare

### 1. Migrare DB (inline, idempotentă) — `server/db/index.mjs`
Adaugă migrarea `087_formulare_df_sum_crd_bug` în array-ul de migrări inline, după `086`:
```sql
ALTER TABLE formulare_df ADD COLUMN IF NOT EXISTS sum_fara_inreg_ctrl_crd_bug TEXT;
```
Coloană nullable, fără DEFAULT obligatoriu (câmp TEXT opțional). Respectă regulile din CLAUDE.md („Database Migrations"): `ADD COLUMN IF NOT EXISTS`, pattern `id: '087_descriere'`. NU atinge `migrate.mjs`. NU adăuga coloană pentru a doua bifă (o retragem).

### 2. Whitelist persistare — `server/services/formular-shared.mjs`
În `DF_P2_FIELDS` adaugă `'sum_fara_inreg_ctrl_crd_bug'` lângă `'sum_fara_inreg_ctrl_crdbug'`. NU adăuga numele bifei retrase.

### 3. Frontend collect — `public/js/formular/core.js`
- **Păstrează** `sum_fara_inreg_ctrl_crdbug` și `sum_fara_inreg_ctrl_crd_bug`.
- **Șterge** linia care colectează `ckbx_fara_inreg_ctrl_crd_bug:cb('n-ck-fararezvcrbug')` (bifa retrasă).

### 4. Frontend collect + restore — `public/js/formular/doc.js`
- **Collect:** lângă `sum_fara_inreg_ctrl_crdbug:g('n-sumfara')||'0'` adaugă `sum_fara_inreg_ctrl_crd_bug:g('n-sumfararezvcrbug')||'0'`.
- **Restore:** lângă `sv('n-sumfara',doc.sum_fara_inreg_ctrl_crdbug||'0')` adaugă `sv('n-sumfararezvcrbug',doc.sum_fara_inreg_ctrl_crd_bug||'0')`.
- Nu adăuga restore pentru a doua bifă (retrasă).

### 5. HTML — `public/formular.html`
Înlocuiește cele DOUĂ `<label class="dck">` (bloc `n-ck-fararezv` + bloc `n-ck-fararezvcrbug`) cu UN SINGUR label, o singură bifă și ambele input-uri de sumă inline, frază identică cu PDF-ul:
```html
<label class="dck">
  <input type="checkbox" id="n-ck-fararezv"/>
  Nu s-au rezervat în sistemul de control al angajamentelor credite de angajament în cuantum de
  <input id="n-sumfara" class="di" type="text" inputmode="decimal" data-money="true" value="0,00" style="width:160px;display:inline;margin:0 4px;padding:6px 10px;font-size:12px;height:auto"/>
  lei, respectiv credite bugetare în cuantum de
  <input id="n-sumfararezvcrbug" class="di" type="text" inputmode="decimal" data-money="true" value="0,00" style="width:160px;display:inline;margin:0 4px;padding:6px 10px;font-size:12px;height:auto"/>
  lei
</label>
```
Păstrează exact ID-urile (`n-sumfara`, `n-sumfararezvcrbug`) și clasa/`data-money` (formatarea monetară e deja legată în `formular.js`). Elimină complet input-ul `n-ck-fararezvcrbug`.

### 6. PDF — `server/routes/formulare.mjs`
**NU modifica.** Verifică doar (citire) că fraza compusă `sumCa`+`sumCb` și gate-ul pe `ckbx_fara_inreg_ctrl_ang` sunt intacte. După persistarea sumei, `sumCb` se va completa automat.

## Verificare migrare locală (fresh DB)
Conform CLAUDE.md, simulează fresh DB local (drop + recreate + start server) și confirmă în logs că migrarea `087` trece fără ROLLBACK. Apoi rulează un DF cu ambele sume completate, întoarce-l P2→P1 și confirmă că suma bugetară se păstrează.

## Teste
`npm test verde, fără regresii`. Testul Etapa 0 (round-trip `sum_fara_inreg_ctrl_crd_bug`) trecut din roșu în verde. Aserțiunile pereche 1 neschimbate.

## Cache busting + versiune
Schimbări frontend (`formular.html`, `core.js`, `doc.js`) → conform regulii proiectului:
- bump `package.json` patch: `3.9.584` → `3.9.585`;
- incrementează `CACHE_VERSION` în `public/sw.js`;
- `sed` pe `?v=` în `formular.html` (și orice HTML care încarcă `core.js`/`doc.js`) la `3.9.585`.

## La final
```bash
git add .
git commit -m "fix(secB-df): persistă suma credite bugetare + o singură bifă CFP (v3.9.585)"
git push origin develop
```
STOP. NU merge/push pe `main`. Raportează: ce s-a atins, status `npm test`, și confirmă vizual pe staging că fraza CFP afișează ambele sume și se păstrează la întoarcerea DF→P1.

## Actualizare CLAUDE.md (opțional, dacă vrei consemnat)
O linie scurtă sub secțiunea SecB / fix-uri: „v3.9.585 — SecB DF: a doua sumă CFP (`sum_fara_inreg_ctrl_crd_bug`, credite bugetare) acum persistată; consolidat la o singură bifă, frază identică cu PDF-ul. Migrare 087."
