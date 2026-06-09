# FEATURE: Verificare credite bugetare la completarea Sec.B (Responsabil CAB) — soft-warning

> ⚠️ **BRANCH: `develop` EXCLUSIV.** NU face checkout/merge/push pe `main`.
> `main` = producție, gestionat manual de Mircea. Toată munca rămâne pe `develop`.
>
> ⚠️ **NO-TOUCH:** fluxul de semnare STS/PAdES. Nimic din acest task nu îl atinge.

---

## Context

În Sec.B a DF-ului, Responsabilul CAB completează col.10 = 8+9
(`sum_rezv_crdt_bug_act` — „Suma rezervată din credite bugetare pentru anul curent
actualizată") per rând, fiecare rând având un `cod_SSI`.

Centralizatorul Clasa 8 (`server/services/clasa8.mjs`) calculează deja, per cod_SSI:
`ramane_din_buget = buget(clasa8_buget) − Σ angajamente(col.10 din DF APROBATE,
ultima revizie per nr_unic_inreg)`. Problema: depășirea bugetului devine vizibilă
**abia după aprobare**, în Clasa 8 (vezi captura: cod `…200130`, buget 462.470 vs
angajat 700.000 → −237.530). Vrem s-o aducem **în timp real, în fața CAB-ului, la
completarea col.10**, ca avertisment.

**Decizie: SOFT-WARNING, NON-BLOCANT.** Sec.B doar *înregistrează* ce e deja în
sistemul de control al angajamentelor (textul formularului: „au fost înregistrate
în sistemul de control al angajamentelor"), deci NU blocăm finalizarea — doar
semnalăm vizibil depășirea. Fără modificări la logica de submit/complete.

---

## 1. Endpoint nou read-only (reutilizează logica Clasa 8)

În `server/routes/clasa8.mjs`:

```
GET /api/clasa8/buget/disponibil?exclude_df=<uuid?>
```

- `requireAuth`; scope pe `req.actor.orgId` (multi-tenant, obligatoriu).
- Întoarce, per cod_SSI din bugetul activ:
  `{ cod_ssi, buget, angajat_aprobat, disponibil }`
  unde `angajat_aprobat` = Σ col.10 din DF-urile APROBATE (flow completat, ultima
  revizie per `nr_unic_inreg`), iar `disponibil = buget − angajat_aprobat`.
- **`exclude_df`**: dacă e dat, rezolvă `nr_unic_inreg` al acelui DF și **exclude
  din `angajat_aprobat` toate DF-urile cu același `nr_unic_inreg`** (ca să nu
  numărăm dublu o revizie anterioară aprobată a aceluiași document în curs de
  editare/revizuire).

**Implementare:** extrage/reutilizează CTE-urile `latest_approved_df` +
`angajamente` din `services/clasa8.mjs` (NU rescrie regula de agregare — același
SoT: col.10 `sum_rezv_crdt_bug_act`, „aprobat" = flow `completed`). Adaugă în
`latest_approved_df` condiția de excludere
`AND ($2::uuid IS NULL OR fd.nr_unic_inreg IS DISTINCT FROM (SELECT nr_unic_inreg FROM formulare_df WHERE id=$2))`.
Pune logica într-o funcție în `services/clasa8.mjs` (ex. `getBugetDisponibil(pool, orgId, excludeDfId)`)
și apeleaz-o din rută, pentru consistență cu `getClasa8Aggregate`.

Răspuns:
```json
{ "items": [ { "cod_ssi": "...", "buget": 462470, "angajat_aprobat": 0, "disponibil": 462470 } ] }
```

## 2. Frontend — avertisment live la col.10 (`public/js/formular/doc.js`)

Sec.B se completează doar de CAB; validarea rulează când Sec.B e editabilă.

- **Cache map disponibil:** la deschiderea unui DF în rol CAB (P2) — sau când
  Sec.B devine editabilă — fă un singur fetch
  `/api/clasa8/buget/disponibil?exclude_df=<docId>` și ține rezultatul într-o
  variabilă de modul `_bugetDisponibil = Map(cod_ssi → {buget,angajat_aprobat,disponibil})`.
  Re-fetch doar când se schimbă un `cod_SSI` în Sec.B.
- **Recalcul + verificare:** în bucla existentă de recalcul col.10 pe
  `#n-ctbody tr` (acolo unde `c10 = fMR(c8+c9)`), după recalcul:
  1. agregă pe `cod_SSI` Σ col.10 din TOATE rândurile Sec.B ale DF-ului curent
     (folosește `pMR` pe valorile col.10);
  2. pentru fiecare `cod_SSI` cu `disponibil` cunoscut, dacă
     `Σcol10_curent > disponibil` → marchează rândurile cu acel cod_SSI.
- **UI avertisment (soft, non-blocant):**
  - badge roșu inline pe rândul/rândurile în depășire (ex. un `<span>` discret în
    celula cod_SSI sau col.10): „⚠ depășire";
  - un sumar deasupra/dedesubtul tabelului Sec.B (element nou, ex.
    `#secb-buget-warn`), ascuns implicit, care listează codurile în depășire:
    „⚠ Depășire credite bugetare disponibile: SSI <cod> −<X> lei" (format RO cu `fMR`).
  - NU dezactiva butoanele de submit/complete; e doar informativ.
- Curăță avertismentul când nu mai există depășiri (reset Sec.B, corecții valori).

Nu modifica formatul de salvare al `rows_ctrl` (nici un câmp nou persistat — e
pură validare client pe date deja existente + endpoint read-only).

## 3. (Opțional, doar dacă pct.2 „Audit DF/ORD" e deja deployat)

La `complete` Sec.B cu depășire, scrie un event de audit
`completat_cu_depasire` (meta: lista `{cod_ssi, depasire}`) prin
`recordFormularAudit`. Best-effort, gated pe existența tabelului `formulare_audit`.
Dacă pct.2 NU e încă deployat, OMITE complet acest pas.

## 4. Teste

- `services/clasa8.mjs` `getBugetDisponibil`: cod cu buget și DF aprobat →
  `disponibil = buget − angajat`; cu `exclude_df` pe revizia aceluiași
  `nr_unic_inreg` → revizia exclusă nu se numără; cod fără buget → `disponibil`
  raportat corect (buget null tratat ca în agregatul existent).
- endpoint `GET /api/clasa8/buget/disponibil`: 401 fără auth, scope pe orgId.

## 5. Cache-busting

- Bumpează `version` în `package.json` la următoarea valoare patch
  (ex. `3.9.540` — verifică valoarea curentă).
- Bumpează `?v=` doar pe referința către `doc.js` din `public/formular.html`.

## Verificare

- `npm test` → **verde, fără regresii.**
- `npm run check` → fără erori de sintaxă.
- Manual: ca CAB, completează Sec.B col.10 pe un cod_SSI peste `disponibil` →
  apare avertisment roșu + sumar; reduci valoarea sub prag → avertismentul dispare;
  finalizarea NU e blocată.

## Finalizare (obligatoriu)

```bash
git add .
git commit -m "feat(df): soft-warning depasire credite bugetare la completare Sec.B (CAB) v3.9.540"
git push origin develop
```
