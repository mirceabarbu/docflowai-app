---
task: "#115 — un flux REFUZAT nu mai ține documentul „pe flux" (aliniere formulare ↔ ALOP)"
branch: develop
model_suggested: Sonnet 4.6   # șase adăugiri identice de o linie, complet specificate
target_version: v3.9.744
migrations: none
cache_version_bump: NO   # doar backend (SQL în rutele de formulare)
---

# ⚠️ BRANCH: develop

## PASUL 0 — CONFIRMĂ BRANCH-UL ÎNAINTE DE ORICE
```
git branch --show-current      # Așteptat: develop
git fetch origin && git status
```

===============================================================================
## CONTEXT — o ruptură între două straturi
===============================================================================

Simptom din producție (ORD 41011): ALOP-ul afișează „Generează PDF + Lansează flux ORD",
dar când deschizi ORD-ul ca să regenerezi PDF-ul, opțiunea lipsește — documentul apare
ca fiind „pe fluxul de semnare", iar în listă are badge-ul **„Trimis flux"**.

Cauza: **modulul ALOP și modulul formulare nu sunt de acord dacă un flux REFUZAT mai
e activ.**

Verificat pe cod (v3.9.743):

| loc | verifică `cancelled` | verifică `refused` |
|---|---|---|
| `server/routes/alop.mjs:349` (df_flow_active, listă) | da | **da** ✅ |
| `server/routes/alop.mjs:651` (df_flow_active, detaliu) | da | **da** ✅ |
| `server/routes/formulare/df.mjs:143` (flow_active) | da | **NU** ❌ |
| `server/routes/formulare/ord.mjs:144` (flow_active) | da | **NU** ❌ |
| `server/routes/formulare/shared.mjs:446` (`_dfTransmis`) | da | **NU** ❌ |
| `server/routes/formulare/shared.mjs:507` (badge_status DF) | da | **NU** ❌ |
| `server/routes/formulare/shared.mjs:575` (`_foTransmis`) | da | **NU** ❌ |
| `server/routes/formulare/shared.mjs:622` (badge_status ORD) | da | **NU** ❌ |

Lanțul concret: `formulare_ord.flow_id` rămâne pe fluxul refuzat (proveniență istorică,
decizie confirmată la #114) ⇒ `ord.mjs:144` calculează `flow_active=true` ⇒
`formular-capabilities.mjs` pune `onActiveFlow=true` ⇒ butonul de regenerare/relansare e
ascuns; iar `shared.mjs:622` scoate `badge_status='transmis_flux'` ⇒ „Trimis flux" în listă.

**Semantica corectă e cea din ALOP:** un flux refuzat e TERMINAL, documentul nu mai e
„pe flux". Pe ea se bazează și traseul proiectat la #77 (după refuz, ALOP-ul oferă
relansarea). ⛔ NU „alinia" invers (ALOP-ul la formulare) — ar rupe #77 și #114.

De ce lovește ORD și nu DF: refuzul DF (#74) mută documentul pe `neaprobat`, iar condiția
badge-ului cere `status='completed'`, deci DF-ul scapă din întâmplare. Refuzul ORD (#77)
lasă statusul `completed` ⇒ ORD-ul intră direct în capcană. **Reparăm ambele** — DF-ul e
protejat accidental, nu prin construcție.

===============================================================================
## PASUL 1 — Adaugă verificarea `refused` în cele ȘASE locuri
===============================================================================

În fiecare, adaugă o condiție NOUĂ imediat DUPĂ cea de `cancelled`, în același stil
(`IS DISTINCT FROM`, care e NULL-safe — ⛔ nu folosi `<>` sau `!=`):

```sql
AND (f.data->>'status')    IS DISTINCT FROM 'refused'
```

Locurile (verifică numerele de linie înainte — codul a avansat la v3.9.743):
1. `server/routes/formulare/df.mjs` — `flow_active` (~l.143), aliasul e `f`
2. `server/routes/formulare/ord.mjs` — `flow_active` (~l.144), aliasul e `f`
3. `server/routes/formulare/shared.mjs` — `_dfTransmis` (~l.446), fragment pe o linie
4. `server/routes/formulare/shared.mjs` — `badge_status` DF (~l.507)
5. `server/routes/formulare/shared.mjs` — `_foTransmis` (~l.575), fragment pe o linie
6. `server/routes/formulare/shared.mjs` — `badge_status` ORD (~l.622)

⚠️ **Perechile 3↔4 și 5↔6 TREBUIE schimbate împreună.** Comentariul din cod spune
explicit: „Fragmente = EXACT condițiile din badge_status — sursă unică, fără drift".
Fragmentele alimentează FILTRUL de status; dacă schimbi doar badge-ul, filtrarea după
„Trimis flux" nu va mai returna aceleași rânduri pe care le arată badge-ul.

⛔ NU atinge `alop.mjs` (deja corect).
⛔ NU atinge `notifications.mjs`, `admin/flows.mjs`, `crud.mjs` (deja corecte sau
   filtre de listă cu altă semantică).
⛔ NU atinge condiția `aprobat` din niciun fișier — un flux refuzat nu e `completed`,
   deci `aprobat` iese corect `false` deja.
⛔ NU modifica `formulare_ord.flow_id` / `formulare_df.flow_id` nicăieri (proveniență
   istorică — decizia de la #114).

Verificare:
```
grep -rn "IS DISTINCT FROM 'refused'" server/routes/formulare/
# Așteptat: 6 apariții (2 în df.mjs+ord.mjs, 4 în shared.mjs)

grep -c "IS DISTINCT FROM 'cancelled'" server/routes/formulare/df.mjs server/routes/formulare/ord.mjs server/routes/formulare/shared.mjs
# Așteptat: 1, 1, 4 — fiecare are acum perechea lui de 'refused'
```

===============================================================================
## PASUL 2 — Teste
===============================================================================

Caută întâi suita existentă de badge/status DF-ORD (a fost construită ca matrice
parametrizată de ~14 cazuri — `grep -rl "badge_status" server/tests/`). **Extinde-o**,
nu crea una paralelă.

Cazuri de adăugat, pentru DF **și** ORD:
1. Document `completed` + `flow_id` → flux **refuzat** ⇒ `badge_status` NU e
   `'transmis_flux'`, iar `flow_active` e `false`. ← cazul central
2. Același, dar flux **anulat** ⇒ idem (non-regresie).
3. Același, dar flux **activ nefinalizat** ⇒ `badge_status='transmis_flux'`,
   `flow_active=true` (comportamentul legitim rămâne).
4. Același, dar flux **completat** ⇒ `aprobat=true` (neatins de acest fix).
5. **Filtru ↔ badge coerente**: filtrarea listei după „transmis_flux" NU întoarce
   documentul cu flux refuzat — dovada că fragmentul și badge-ul au fost schimbate
   împreună. ← al doilea caz important

Dacă suita existentă e pe PG real (`server/tests/db/`), adaugă acolo; nu muta teste
între suite.

===============================================================================
## PASUL 3 — Versiune
===============================================================================
Bump `package.json` → `3.9.744`.
⛔ FĂRĂ `?v=`, FĂRĂ `CACHE_VERSION` (zero fișiere frontend atinse).

===============================================================================
## PASUL 4 — Porți
===============================================================================
```
npm test            # baseline la intrare: 109 fișiere / 1405 teste
npm run test:db     # OBLIGATORIU — baseline 79 fișiere / 525
```
⛔ „Docker absent" NU e motiv de skip: PG 17 efemer, port 55432, rețeta din CLAUDE.md.

===============================================================================
## PASUL 5 — Commit + PUSH
===============================================================================
```
git status    # ⛔ NU `git add -A` (clutter netrackuit preexistent)
git add <doar fișierele task-ului>
git commit -m "fix(formulare): un flux refuzat nu mai ține documentul pe flux — aliniere cu ALOP — v3.9.744"
git push origin develop
```

===============================================================================
## RAPORT FINAL
===============================================================================
- Commit + versiune; `npm test` / `test:db` reale (dacă test:db n-a rulat, spune-o).
- Ieșirea reală a celor două `grep` din Pasul 1.
- Ce suită de teste ai extins (cale + câte cazuri erau înainte / după).
- Confirmă: `alop.mjs` neatins; `flow_id` neatins nicăieri; condiția `aprobat` neatinsă.
- Orice abatere + justificare.

===============================================================================
## ⛔ CONSTRÂNGERI
===============================================================================
- ⛔ BRANCH develop; PASUL 0 obligatoriu.
- ⛔ Fragmentele de filtru și `badge_status` se schimbă ÎMPREUNĂ (perechile 3↔4, 5↔6).
- ⛔ `IS DISTINCT FROM`, niciodată `<>` / `!=` (NULL-safe).
- ⛔ NU alinia ALOP-ul la formulare — semantica corectă e cea din ALOP.
- ⛔ NO-TOUCH: `server/signing/*`.
- ⛔ `git push origin develop`. Pe `main` niciodată.
