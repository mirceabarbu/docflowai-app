---
prompt: 207
titlu: "Audit extern: boot DB fail-closed, tenant leak pe /signing, flip P0-06 la 422"
model_suggested: "Opus 5"
efort: high
branch: develop
versiune_curenta: v3.9.859  (după #206)
versiune_tinta: v3.9.860
migratii: NU
scrieri_in_baza: NU
fisiere_din_public: DA  (livrat ≠ plănuit — vezi nota de mai jos; inițial: NU)
zona_no_touch_atinsa: ⚠️ DA — `signing.mjs` (vezi ⚠️ de mai jos)
tip: securitate + fail-closed
---

# 📝 NOTĂ POST-EXECUȚIE (15.09.2026) — divergență antet ↔ livrat

Antetul original spunea `fisiere_din_public: NU`. Noul tip de audit `P0_06_REJECTED_UNSIGNED`
(cerut de C.1) a declanșat garda preexistentă `audit-labels-sync.test.mjs`, care cere etichetă
în `public/js/admin/activity.js` + `audit.js`. Decizie owner: etichetele se adaugă (2 linii
display-only), garda rămâne bit-identică. Consecință: `?v=` țintit pe cele două asset-uri în
`admin.html` și `CACHE_VERSION` v308→v309 (ambele fișiere SUNT în `PRECACHE_ASSETS`, confirmat
prin grep în `sw.js:32-33`).

# ⚠️ BRANCH

**EXCLUSIV `develop`**. Fără `checkout main`, `merge`, `push main`, deploy.
Final: **`git push origin develop`**, apoi **stop** și raportezi.

# ⚠️ ZONA NO-TOUCH — citește înainte de orice

Etapa C atinge `server/routes/flows/signing.mjs`, care e în vecinătatea zonei NO-TOUCH.
**Atingi EXCLUSIV blocul P0-06 (liniile ~415-430).** Nu `STSCloudProvider`, nu `cloud-signing.mjs`,
nu `bulk-signing.mjs`, nu `pades`, nu `java-pades-client`. Dacă o modificare pare să ceară
atingerea lor, **oprește-te și întreabă**.

---

# CONTEXTUL

Un audit extern pe v3.9.857 a produs o listă lungă. Lotul ăsta ia **doar cele trei constatări pe
care le-am verificat pe cod și care se repară în câteva linii**. Restul (DSS, outbox, KMS,
consolidarea migrărilor, Redis/HA) rămâne în planul pe luni — **nu intră aici**.

---

# ETAPA A — `initDbWithRetry` nu mai minte în log

`server/db/index.mjs`. După cinci încercări eșuate, funcția scrie
`logger.error('DB init failed permanent. Exiting.')` și… **se întoarce normal**. Fără `throw`,
fără `process.exit`.

Consecința: `initDbWithRetry().then(...)` din `server/index.mjs:2045` rulează, `runMigrationsV4`
reușește (baza e accesibilă — a picat doar o migrare inline), `markDbReady()` declară baza gata,
și aplicația servește trafic cu **schema inline incompletă**.

Iar mesajul spune „Exiting" — un operator care citește logul crede că procesul a murit.

`old_str`:
```js
export async function initDbWithRetry() {
  const delays = [1000, 2000, 4000, 8000, 15000];
  for (let i = 0; i < delays.length; i++) {
    try {
      logger.info({ attempt: i+1, total: delays.length }, 'DB init attempt...');
      await initDbOnce();
      return;
    } catch(e) {
      DB_READY = false; DB_LAST_ERROR = String(e?.message || e);
      logger.error({ err: e }, 'DB init failed');
      await new Promise(r => setTimeout(r, delays[i]));
    }
  }
  logger.error('DB init failed permanent. Exiting.');
}
```
`new_str`:
```js
export async function initDbWithRetry() {
  const delays = [1000, 2000, 4000, 8000, 15000];
  let lastError = null;
  for (let i = 0; i < delays.length; i++) {
    try {
      logger.info({ attempt: i+1, total: delays.length }, 'DB init attempt...');
      await initDbOnce();
      return;
    } catch(e) {
      lastError = e;
      DB_READY = false; DB_LAST_ERROR = String(e?.message || e);
      logger.error({ err: e }, 'DB init failed');
      await new Promise(r => setTimeout(r, delays[i]));
    }
  }
  // #207 — înainte, funcția se întorcea NORMAL după ultima eșuare: mesajul spunea
  // „Exiting" dar procesul continua, runMigrationsV4 reușea și markDbReady() declara
  // baza gata cu schema inline INCOMPLETĂ. Acum aruncă — deployment-ul se oprește.
  logger.error({ err: lastError }, 'DB init failed permanent după toate încercările — oprire.');
  throw lastError || new Error('db_init_failed_permanent');
}
```

## A.2 — `.catch()` explicit pe lanțul de boot

Există deja `process.on('unhandledRejection')` la `server/index.mjs:713`, care loghează și iese —
deci comportamentul ar fi corect și fără. Dar a te baza pe handlerul global face intenția
invizibilă. Adaugă un `.catch()` explicit pe lanțul de la `:2045`:

```js
  }).catch((e) => {
    // #207 — initDbWithRetry aruncă acum după epuizarea încercărilor. Fail-closed
    // explicit: nu servim trafic cu schema inline incompletă.
    logger.error({ err: e }, 'Boot DB eșuat definitiv — oprire proces.');
    process.exit(1);
  });
```

⚠️ **Verifică forma reală a lanțului** înainte de patch — `.then(async () => { … })` se închide
la câteva zeci de linii distanță, iar `old_str` trebuie să prindă exact finalul lui. Dacă nu
poți face `old_str` unic, **raportează** în loc să ghicești.

⚠️ Verifică dacă `initDbWithRetry` mai e chemată **și altundeva** (teste, scripturi) — un `throw`
nou poate schimba comportamentul acolo. Raportează ce ai găsit.

---

# ETAPA B — tenant leak pe `GET /admin/organizations/:id/signing`

`server/routes/admin/organizations.mjs:~417`. Ruta verifică doar `isAdminOrOrgAdmin(actor)`, apoi
folosește direct `req.params.id`. Un `org_admin` din instituția A poate citi configurația de
semnare a instituției B: `clientId`, `kid`, `redirectUri`, `idpUrl`, `apiUrl`, `publicKeyPem`,
plus existența cheii private și a secretelor.

Cheia privată **nu** se scurge (e mascată) — dar restul e metadata cross-tenant.

⭐ Aceeași asimetrie ca la #206: `PUT`-ul de dedesubt e marcat „Doar super-admin", `GET`-ul nu
verifică nimic. **Scrierea păzită, citirea nu.**

`old_str`:
```js
  const orgId = parseInt(req.params.id);
  if (!orgId) return res.status(400).json({ error: 'invalid_id' });
```
`new_str`:
```js
  const orgId = parseInt(req.params.id);
  if (!orgId) return res.status(400).json({ error: 'invalid_id' });
  // #207 — org_admin putea citi configurația de semnare a ALTEI organizații
  // (clientId, kid, redirectUri, idpUrl, apiUrl, publicKeyPem, existența secretelor).
  // Cheia privată era deja mascată, dar restul e metadata cross-tenant.
  // 404, nu 403: nu confirmăm existența organizației.
  if (actor.role === 'org_admin' && Number(actor.orgId) !== orgId) {
    return res.status(404).json({ error: 'org_not_found' });
  }
```

⚠️ **404, nu 403** — un 403 ar confirma că organizația există.

⚠️ `actor.role === 'admin'` (super-admin de platformă) trece mai departe, corect: are nevoie de
acces cross-org. Verifică valorile reale de rol în `authz-scope.mjs` — dacă mai există un rol cu
scop de organizație în afară de `org_admin`, **raportează-l**, poarta trebuie să-l acopere.

## B.2 — celelalte rute din același fișier

⭐ Nu presupune că e singura. **Inventariază** toate rutele din
`server/routes/admin/organizations.mjs` care iau un `:id` de organizație din URL și verifică
doar `isAdminOrOrgAdmin`:

```bash
grep -n "router\.\(get\|post\|put\|patch\|delete\)('/admin/organizations/:id" server/routes/admin/organizations.mjs
```

**Raportează lista cu verdictul fiecăreia** (păzită / nepăzită). Repară în lotul ăsta **doar
rutele de CITIRE** cu același tipar. Pentru scrieri nepăzite, dacă găsești, **oprește-te și
raportează** — acolo impactul e altul și vreau să decid eu.

---

# ETAPA C — flip P0-06: `422` în loc de observare

## Ce știm din producție (măsurat 15.09.2026)

```
SIGNED_PDF_UPLOADED       11157 evenimente / 2559 fluxuri / 20.04 → 15.09
   dintre care provider   sts-cloud: 11157  (100%)
P0_06_OBSERVED_UNSIGNED   0
```

**Fiecare upload din istorie vine prin `sts-cloud`.** Calea manuală „descarc → semnez local →
urc înapoi" are **zero utilizări măsurate** în cinci luni.

⚠️ Deci flip-ul e o **poartă închisă preventiv pe o cale cu zero utilizări**, NU una „validată pe
trafic real" — n-a existat trafic de validat. Scrie asta în commit exact așa; peste un an
diferența va conta.

## C.1 — garda devine respingere

`server/routes/flows/signing.mjs`, blocul de la ~415. Structura nouă:

- `sigAfter <= sigBefore` ⇒ **`422`** `{ error: 'pdf_not_signed', message: … }`, eveniment de
  audit `P0_06_REJECTED_UNSIGNED` (tip **nou**, ca să se distingă de observațiile istorice — care
  sunt zero, dar tipul vechi rămâne referit în rapoarte).
- **Fluxul NU avansează**: `return` înainte de orice mutație pe `data` (`signedPdfVersions`,
  `signedPdfB64`, `events`, `signers[idx].status`). ⭐ Verifică ordinea în cod — respingerea
  trebuie să fie **înaintea** tuturor scrierilor, altfel refuzăm după ce am modificat starea.
- `extractPdfSignatures` aruncă ⇒ **fail-closed**, dar cu cod **distinct**: `503`
  `{ error: 'verification_unavailable' }`. Nu `422` — un verificator defect nu e același lucru cu
  un PDF nesemnat, iar în loguri trebuie să le putem separa.

Comentariul #156 („OBSERVARE… înainte de flip") se **înlocuiește** cu unul care spune ce s-a
măsurat, când, și că flip-ul s-a făcut pe zero utilizări.

## C.2 — ⛔ ce NU se atinge

- Garda de hash de deasupra (`uploadedHash === uploadPayload.preHash` ⇒ 422 `pdf_not_signed`)
  rămâne **exact** cum e. Comentariul spune că e „moartă structural la semnatarul 2+" — adevărat,
  dar la primul semnatar funcționează.
- `cloud-signing.mjs`, `bulk-signing.mjs`: **NEATINSE**. Ele nu trec prin ruta asta.
- `local-upload` **rămâne activ** în `signing_providers_enabled`. Dezactivarea lui e o decizie de
  configurare, separată, și se ia după ce e configurat al doilea QTSP.

---

# ETAPA D — teste

## D.1 — `server/tests/unit/boot-db-fail-closed.test.mjs` (nou)

1. ⭐ `initDbWithRetry` cu `initDbOnce` care aruncă mereu ⇒ **respinge** cu ultima eroare
   (înainte se rezolva normal).
2. `initDbOnce` care reușește la a treia ⇒ se rezolvă, fără throw.
   ⚠️ Mock-uiește întârzierile — altfel testul durează 30 s.

## D.2 — `server/tests/integration/org-signing-tenant.test.mjs` (nou)

3. ⭐ `orgA_admin` cere `/admin/organizations/<orgB>/signing` ⇒ **404 `org_not_found`**,
   zero câmpuri de config în corp.
4. `orgA_admin` cere propria organizație ⇒ 200, config prezent.
5. `admin` (platformă) cere orice organizație ⇒ 200.
6. Utilizator obișnuit ⇒ 403 (neregresie).

## D.3 — `server/tests/integration/p0-06-flip.test.mjs` (nou)

7. ⭐ Upload al cărui PDF are **acelaşi număr** de semnături ca precedentul ⇒ **422
   `pdf_not_signed`**; în bază fluxul e **neschimbat** (semnatarul nu e `signed`,
   `signedPdfB64` neatins, niciun `SIGNED_PDF_UPLOADED`).
8. ⭐ Upload cu o semnătură în plus ⇒ 200, fluxul avansează (neregresie — calea fericită).
9. `extractPdfSignatures` aruncă ⇒ **503 `verification_unavailable`**, fluxul neschimbat.
10. Eveniment `P0_06_REJECTED_UNSIGNED` scris la cazul 7.

⚠️ Pentru 7 și 8 ai nevoie de PDF-uri cu număr **cunoscut** de semnături. **Caută întâi
fixture-urile existente** (`server/tests/fixtures/`, testele de `pades`/`verify`) și refolosește-le.
Dacă nu există, spune-mi **înainte** de a genera ceva — nu inventa un PDF „aproape valid" care ar
face testul să măsoare altceva decât credem.

## D.4

```bash
npm test
npm run test:db
```

⚠️ **Secvențial.** Verdictul din **output real**, niciodată dintr-un sumar de fundal.
`skipped` ≠ `passed`.

⛔ Test preexistent care pică ⇒ **raportează ÎNAINTE de a-l atinge.** Atenție specială la testele
care exercitau calea de observare P0-06 — dacă vreunul afirma „warning, nu respinge", acela
**descria etapa de observare**, nu o cerință; raportează-l, nu-l rescrie din reflex.

---

# ETAPA E — versiune și commit

```bash
npm version 3.9.860 --no-git-tag-version
npm install --package-lock-only
git status --short
```

**Zero fișiere din `public/`** ⇒ `CACHE_VERSION` și `?v=` neatinse. Verifică.

`git add` explicit. Arhivează promptul în `docs/archive/`, în același commit.

```
fix(#207): boot DB fail-closed, tenant leak pe /signing, flip P0-06 — v3.9.860

Trei constatari dintr-un audit extern pe v3.9.857, verificate pe cod.

initDbWithRetry loga „Exiting" dar se intorcea NORMAL dupa cele cinci
incercari: runMigrationsV4 reusea, markDbReady() declara baza gata, iar
aplicatia servea trafic cu schema inline incompleta. Acum arunca, plus .catch()
explicit care opreste procesul.

GET /admin/organizations/:id/signing verifica doar isAdminOrOrgAdmin si folosea
req.params.id direct: un org_admin citea configuratia de semnare a altei
institutii (clientId, kid, redirectUri, idpUrl, apiUrl, publicKeyPem, existenta
secretelor). Cheia privata era deja mascata. 404, nu 403. Aceeasi asimetrie ca
la #206: PUT-ul era pazit, GET-ul nu.

P0-06 trece din OBSERVARE in respingere: sigAfter <= sigBefore ⇒ 422, fluxul NU
avanseaza; verificator defect ⇒ 503 distinct.

ATENTIE la interpretare: masurat pe productie 15.09 — 11157 upload-uri pe 2559
fluxuri din 20.04, TOATE cu provider sts-cloud, si ZERO observatii P0-06. Calea
manuala are zero utilizari in cinci luni. Flip-ul e deci o poarta inchisa
PREVENTIV pe o cale nefolosita, NU una validata pe trafic real.

local-upload ramane activ in signing_providers_enabled — dezactivarea e decizie
de configurare, dupa al doilea QTSP.

NEATINSE: cloud-signing, bulk-signing, pades, java-pades-client, garda de hash.
Restul auditului (DSS, outbox, KMS, consolidare migrari, Redis/HA) nu intra aici.
```

```bash
git push origin develop
```

**Stop.**

---

# RAPORT FINAL

1. Ancorele/valorile **OBȚINUTE** pentru fiecare etapă.
2. Dacă `initDbWithRetry` mai e chemată altundeva și ce efect are `throw`-ul acolo.
3. Cum ai făcut `old_str` unic pentru finalul lanțului `.then()` din `index.mjs`.
4. ⭐ **Inventarul complet** al rutelor `/admin/organizations/:id*` cu verdictul fiecăreia
   (păzită / nepăzită). Scrieri nepăzite ⇒ **raportate, NU reparate**.
5. Dacă mai există un rol cu scop de organizație în afară de `org_admin`.
6. ⭐ Confirmarea că respingerea din C.1 e **înaintea** oricărei mutații pe `data`, cu numerele de
   linie.
7. Ce fixture-uri PDF ai folosit pentru testele 7 și 8, și dacă au fost preexistente sau generate.
8. Rezultatul fiecărui test din D.1–D.3, în special **1, 3, 7, 8, 9**.
9. Numere reale `npm test` / `npm run test:db`, secvențial, cu sursa verdictului declarată.
10. Teste preexistente atinse — care și de ce. (Așteptat: cel mult cele care descriau observarea.)
11. Divergențe prompt ↔ cod — **raportate, NU reparate tăcut**.
12. Colaterale.

---

# ⛔ CONSTRÂNGERI ABSOLUTE

- `develop` ONLY. Fără `main`, merge, deploy.
- În `signing.mjs`: **DOAR blocul P0-06**. `cloud-signing`, `bulk-signing`, `pades`,
  `java-pades-client`, `STSCloudProvider`: **NEATINSE**.
- Garda de hash de deasupra blocului P0-06: **NEATINSĂ**.
- `local-upload` rămâne activ în configurație. Nu-l dezactiva.
- Respingerea P0-06 **înaintea** oricărei scrieri pe `data`.
- `404`, nu `403`, la tenant leak.
- Zero fișiere din `public/`. Fără migrare.
- Restul auditului (DSS, outbox, KMS, migrări, Redis) **nu intră** în lot.
- `git add` explicit. `git push origin develop`, apoi **stop**.
- `old_str` care nu se potrivește exact o dată ⇒ **OPREȘTE-TE și raportează**.
