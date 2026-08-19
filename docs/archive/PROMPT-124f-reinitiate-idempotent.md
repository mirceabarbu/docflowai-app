# PROMPT #124f — `reinitiate` devine idempotent (citește `reinitiatedAs`)

> ## ⚠️ BRANCH: `develop`
> Toate commit-urile pe `develop`. **NU** propune și **NU** executa `checkout main`,
> `merge main`, `push origin main`. Deploy-ul în producție îl face Mircea manual.

**Model recomandat:** Sonnet 4.6 · **Target versiune:** `v3.9.757` (de la 3.9.756)
**Migrații:** ZERO · **Fișiere din `public/`:** ZERO ⇒ **fără** bump `CACHE_VERSION`, **fără** `?v=`

---

## 1. Contextul — de ce

`POST /flows/:flowId/reinitiate` (`server/routes/flows/lifecycle.mjs`) scrie, după ce creează
fluxul copil:

```js
// FIX: Marchează fluxul original cu reinitiatedAs — previne reinițializare dublă
data.reinitiatedAs = newFlowId2;
```

**Comentariul e fals.** Câmpul nu e citit NICĂIERI pe server. Singurul cititor e frontendul, la
randarea listei (`public/js/semdoc-initiator/main.js:1210`). Precondiția reală a rutei rămâne
`hasRefused`, care e în continuare **adevărată pe fluxul PĂRINTE** (semnatarul refuzat e eliminat
doar din COPIL) ⇒ al doilea clic pe „Reinițiază" trece de toate gărzile și creează **un al doilea
flux copil**, cu semnatari noi, tokenuri noi și încă un email „e rândul tău".

**Dovadă în producție** (interogare rulată 12.08.2026 pe `flows`, grupare pe
`data->>'parentFlowId'`): părintele `PZ_3083883725` are **2 copii**, creați la **18,9 secunde**
distanță. Un singur caz — deci volumul e mic, dar mecanismul e confirmat, iar butonul din
`semdoc-initiator/main.js:1397` nu are nicio gardă client.

Un comentariu care afirmă o protecție inexistentă e mai periculos decât lipsa protecției:
următorul dezvoltator îl crede. Promptul ăsta face garda să existe cu adevărat.

---

## 2. NO-TOUCH

⛔ Nu atinge, sub nicio formă:

- `server/signing/**` (tot directorul — PAdES, CMS, ByteRange)
- `server/routes/flows/signing.mjs`, `server/routes/flows/cloud-signing.mjs`,
  `server/routes/flows/bulk-signing.mjs`
- orice fișier din `public/` — promptul ăsta e **strict server-side**
- restul rutelor din `lifecycle.mjs`: `/request-review`, `/reinitiate-review`, `/delegate`,
  `/cancel`. Se atinge EXCLUSIV handlerul `POST /flows/:flowId/reinitiate`.

⛔ Zero refactorizări „în trecere". Zero redenumiri. Zero reformatare.

---

## 3. Etapa A — garda de idempotență

### A.1 Verifică întâi unicitatea ancorei

```bash
grep -n "Doar inițiatorul sau un administrator poate reiniția fluxul" server/routes/flows/lifecycle.mjs
```

**Așteptat: exact 1 linie.** Dacă sunt mai multe, OPREȘTE-TE și raportează — ancora de patch
trebuie extinsă cu context, nu ghicită.

### A.2 Patch

**old_str** (în handlerul `POST /flows/:flowId/reinitiate`):

```js
    if (!isAdmin && !isInit) return res.status(403).json({ error: 'forbidden', message: 'Doar inițiatorul sau un administrator poate reiniția fluxul.' });
    const hasRefused = (data.signers || []).some(s => s.status === 'refused');
```

**new_str:**

```js
    if (!isAdmin && !isInit) return res.status(403).json({ error: 'forbidden', message: 'Doar inițiatorul sau un administrator poate reiniția fluxul.' });
    // #124f: `reinitiatedAs` (setat mai jos) era SCRIS dar NICIODATĂ CITIT pe server, deși
    // comentariul de la scriere pretindea că „previne reinițializare dublă". Precondiția
    // `hasRefused` rămâne adevărată pe PĂRINTE (refuzatul e eliminat doar din COPIL), deci al
    // doilea clic crea un al doilea flux copil, cu tokenuri noi și încă un email de notificare.
    // Dovadă în producție: părintele PZ_3083883725 avea 2 copii la 18,9 s distanță.
    // Garda de mai jos face ruta idempotentă. Poziția contează: DUPĂ verificarea de autorizare,
    // ca un actor neîndreptățit să primească 403, nu id-ul fluxului copil.
    if (data.reinitiatedAs) {
      const child = await getFlowData(data.reinitiatedAs);
      // `getFlowData` filtrează deja `deleted_at IS NULL` ⇒ un copil soft-șters vine `null`.
      // Copil ANULAT ⇒ pointerul e mort, se permite o reinițiere nouă (altfel fluxul rămâne
      // blocat definitiv). Copil REFUZAT ⇒ pointerul rămâne valid: traseul corect e reinițierea
      // COPILULUI, nu a părintelui.
      const childAlive = !!child && child.status !== 'cancelled';
      if (childAlive) {
        logger.info(`↩️ reinitiate idempotent: ${flowId} era deja reinițiat ca ${data.reinitiatedAs} (cerere de la ${actor.email})`);
        return res.json({
          ok: true,
          newFlowId: data.reinitiatedAs,
          signers: (child.signers || []).length,
          alreadyReinitiated: true,
        });
      }
      logger.warn(`reinitiate: pointer reinitiatedAs=${data.reinitiatedAs} către un flux mort (anulat/șters) — se permite o reinițiere nouă pentru ${flowId}`);
    }
    const hasRefused = (data.signers || []).some(s => s.status === 'refused');
```

### A.3 Ce NU se schimbă — verifică explicit

- Ramura de succes (crearea fluxului copil) rămâne **byte-identică**. Confirmă cu
  `git diff server/routes/flows/lifecycle.mjs` că diff-ul e **adiție pură**: zero linii șterse,
  cu excepția inexistentă. Dacă apar linii `-`, ceva e greșit.
- Forma răspunsului la succes (`{ ok, newFlowId, signers }`) e păstrată identic pe calea
  idempotentă, ca frontendul existent (`reinitiateFlow`, `semdoc-initiator/main.js:1394`) să
  funcționeze **fără nicio schimbare**. `alreadyReinitiated` e un câmp ADĂUGAT, ignorat azi de
  client — există pentru un lot viitor care va putea afișa „Fluxul era deja reinițiat" în loc de
  „Semnatarii au fost notificați". ⛔ NU modifica frontendul în promptul ăsta.
- Pe calea idempotentă **nu** se trimite nicio notificare, nu se scrie niciun `audit_log`, nu se
  copiază atașamente, nu se atinge `saveFlow`. Ruta devine read-only pe acea ramură.
- `getFlowData` și `logger` sunt deja importate în fișier (liniile 7 și 9) — ⛔ nu adăuga importuri.

---

## 4. Etapa B — test pe Postgres real

Fișier nou: `server/tests/db/reinitiate-idempotent.test.mjs`

**Oglindește fidel structura din `server/tests/db/reinitiate-formular-block.test.mjs`** (același
handler, aceleași mock-uri, același `_injectDeps` cu `newFlowId` secvențial, același
`describe.skipIf(!hasTestDb())`, același `afterAll` cu `pool.end()`). Refolosește helperul
`seedRefusedFlow` din acel fișier ca model — un flux cu un semnatar `refused` (rol **non**-APROBAT)
și unul rămas, `flowType: 'ancore'` ca să se sară ramura de footer PDF.

⚠️ Fluxul de test trebuie să fie **standalone** (fără rând în `formulare_df`/`formulare_ord` cu
acel `flow_id`), altfel garda #114 îl respinge cu 409 `formular_linked_flow` înainte să ajungă la
garda noastră.

Cazuri obligatorii:

1. **Primul reinitiate** → 200, `ok:true`, `alreadyReinitiated` **absent/falsy**,
   `COUNT(*) FROM flows` crescut cu 1, iar părintele are `data->>'reinitiatedAs'` setat.
2. **Al doilea reinitiate pe același părinte** → 200, `newFlowId` **IDENTIC** cu cel din cazul 1,
   `alreadyReinitiated: true`, și — aserțiunea care contează cel mai mult —
   **`COUNT(*) FROM flows` NESCHIMBAT** față de după cazul 1. Verifică și că nu a apărut un al
   doilea rând cu `data->>'parentFlowId' = <părinte>`.
3. **Copil ANULAT** — după cazul 1, pune `data->>'status' = 'cancelled'` pe copil, apoi
   reinitiate din nou → **se creează un flux nou** (count +1), iar `reinitiatedAs` al părintelui
   pointează acum către cel NOU.
4. **Copil SOFT-ȘTERS** — `UPDATE flows SET deleted_at = NOW()` pe copil → la fel ca 3.
5. **Autorizarea are prioritate față de idempotență** — pe un flux DEJA reinițiat, o cerere de la
   un utilizator care nu e nici inițiator, nici admin/org_admin primește **403**, NU 200 cu
   `newFlowId`. Ăsta e testul care apără poziția gărzii în cod (un id de flux nu trebuie să
   scape unui actor neîndreptățit).
6. **Non-regresie** — un flux refuzat FĂRĂ `reinitiatedAs` se reinițiază exact ca înainte.

⛔ Testul IMPORTĂ ruta reală din producție. Nu redeclara logica gărzii în test.

---

## 5. Etapa C — rulare, versionare, push

```bash
npm test
```

Apoi, **obligatoriu**, suita DB pe Postgres real:

```bash
npm run test:db
```

⛔ **„Skipped" NU e „passed".** Absența Docker-ului NU e motiv de skip — folosește rețeta cu
instanță PG 17 efemeră documentată în `CLAUDE.md` (`initdb` + `pg_ctl` pe un port propriu,
`docflow_test`, apoi oprire și curățare). Raportează numărul REAL de fișiere și teste.

Dacă ambele sunt verzi:

1. bump `package.json` → `3.9.757`;
2. commit pe `develop` cu mesaj:
   `fix(#124f): reinitiate idempotent — citește reinitiatedAs, nu mai creează al doilea flux copil`;
3. `git push origin develop`.

⛔ Fără `--amend`, fără `--force`. Dacă un `git add` eșuează, oprește-te și raportează — NU
completa cu un al doilea commit peste unul incomplet fără să spui.

---

## 6. Verificări de ieșire (rulează-le și pune ieșirea în raport)

```bash
grep -n "alreadyReinitiated" server/routes/flows/lifecycle.mjs
# Așteptat: exact 1 linie (în noul răspuns idempotent)

grep -n "const child = await getFlowData(data.reinitiatedAs)" server/routes/flows/lifecycle.mjs
# Așteptat: exact 1 linie

grep -c "data.reinitiatedAs" server/routes/flows/lifecycle.mjs
# Așteptat: ≥ 4 (garda le citește de mai multe ori; scrierea existentă rămâne)

git diff --stat
# Așteptat: EXACT 3 intrări — lifecycle.mjs, testul nou, package.json. Nimic altceva.

grep -rn "reinitiatedAs" public/ | head
# Așteptat: DOAR referința existentă din semdoc-initiator/main.js — zero fișiere modificate în public/
```

---

## 7. RAPORT FINAL — structură obligatorie

- commit hash + intervalul de push
- `npm test`: N fișiere / M teste (passed / failed / todo)
- `npm run test:db`: **PASSED REAL** sau SKIPPED — dacă e skipped, spune de ce și **nu** declara
  lotul terminat
- ieșirea celor 5 verificări grep de mai sus, verbatim
- confirmarea că `git diff` pe `lifecycle.mjs` e **adiție pură** (zero linii șterse)
- orice abatere de la prompt, cu motivul. Dacă găsești o eroare în promptul ăsta,
  **spune-o, nu o repara tăcut** — o aserțiune greșită de-a mea e mai utilă corectată decât
  ocolită.
