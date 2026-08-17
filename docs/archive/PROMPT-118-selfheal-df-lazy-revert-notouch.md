---
model_suggested: Opus 4.8   # atinge zona NO-TOUCH (prin REVERT) + calea lazy ALOP
target_branch: develop
version_bump: 3.9.746 → 3.9.747
cache_bump: NU (backend-only)
qv_bump: NU
---

═══════════════════════════════════════════════════════════════════
⚠️  AVERTISMENT BRANCH
═══════════════════════════════════════════════════════════════════
ȚINTĂ: branch `develop` EXCLUSIV.
NU face checkout/merge/push pe `main`. `main` = PRODUCȚIE, gestionat MANUAL de Mircea.
La final: commit pe `develop` + `git push origin develop`.
═══════════════════════════════════════════════════════════════════

# PROMPT #118 — Scoate cârligul DF din zona NO-TOUCH; mută-l în self-heal-ul lazy ALOP

## CONTEXT — de ce există acest prompt

#117 (v3.9.746, în producție) a rezolvat corect pierderea legăturii DF↔ALOP, DAR
a cablat `finalizeDfOnFlowCompleted` direct în
**`server/routes/flows/cloud-signing.mjs`**, care e pe lista **STRICT NO-TOUCH**
din `CLAUDE.md` (liniile 71-77), alături de `bulk-signing.mjs`, `pades.mjs`,
`java-pades-client.mjs`, `STSCloudProvider.mjs`. Regula de la CLAUDE.md:79 e:
dacă o modificare ar putea atinge fluxul STS/PAdES, **oprești și întrebi**.
Promptul #117 afirma greșit că fișierul e editabil — eroare de context, semnalată
corect de agent la deploy.

Cele 2 linii sunt aditive și post-semnare (risc tehnic mic), dar rămân un
precedent prost într-o zonă unde greșeala invalidează semnături calificate ale
unor clienți reali. Acest prompt le scoate și pune logica acolo unde ORD-ul o are
deja: **self-heal LAZY la deschiderea ALOP-ului** (`server/routes/alop.mjs` —
self-heal #1 „orphan ORD auto-linked" ~818, #2 „ord_flow_id back-filled" ~887).

OBIECTIV: aceeași protecție funcțională, ZERO atingere pe calea de semnare.

⚠️ Nu „repara" nimic altceva în zona de semnare. Singura atingere permisă acolo
e ȘTERGEREA liniilor adăugate de #117 (revert), nimic altceva.

═══════════════════════════════════════════════════════════════════
PAS 0 — CITEȘTE ÎNTÂI (fără modificări)
═══════════════════════════════════════════════════════════════════
- `CLAUDE.md` liniile 67-80 (zona NO-TOUCH) și 490-505 (invariantul de relink/self-heal)
- `server/services/alop-link.mjs` (integral: `selfHealAlopDfLink`, `finalizeDfOnFlowCompleted`)
- `server/routes/alop.mjs` ~700-935 (GET detaliu: lazy auto-tranziție ~722, self-heal #1 ~780-835, self-heal #2 ~855-900)
- `server/routes/formulare/df.mjs` ~336-356 (PUT: resetul `completed`→`draft`)
- `server/routes/flows/cloud-signing.mjs` — DOAR ca să localizezi cele 2 linii de șters

🔒 INVARIANT (CLAUDE.md:499) DE RESPECTAT: relink-ul și self-heal-ul se aplică
INTENȚIONAT **și** ALOP-urilor `completed` — doar `cancelled_at IS NULL` exclude.
NU adăuga filtre `completed_at IS NULL` / `status <> 'completed'` pe aceste query-uri.

═══════════════════════════════════════════════════════════════════
PAS 1 — Funcție nouă: self-heal DF dinspre ALOP (cheie = alopId)
═══════════════════════════════════════════════════════════════════
`selfHealAlopDfLink` e cheiată pe `flowId` (o poate apela doar cine ține fluxul în
mână — adică exact calea de semnare). Pentru calea lazy avem nevoie de varianta
cheiată pe ALOP. În `server/services/alop-link.mjs` ADAUGĂ (păstrează cele două
funcții existente NESCHIMBATE):

```js
/**
 * selfHealAlopDfLinkByAlop — varianta LAZY, cheiată pe alopId, apelată din
 * GET /api/alop/:id. Rezolvă cazul „ALOP fără DF" fără a atinge calea de semnare:
 * caută documentul DF care revendică ALOP-ul prin `source_alop_id`, cu flux
 * FINALIZAT, și îl reataşează. Marchează și `status='aprobat'` (calea cloud nu o face).
 * Oglindește self-heal #1 pentru ORD din alop.mjs. Non-fatală și idempotentă.
 * Ambiguitatea (mai multe candidate cu revizia MAXIMĂ) se rezolvă prin SKIP + warn.
 */
export async function selfHealAlopDfLinkByAlop(pool, alopId) {
  if (!pool || !alopId) return null;
  try {
    const { rows: cands } = await pool.query(`
      SELECT fd.id, fd.flow_id, fd.revizie_nr, fd.status,
             (f.data->>'completedAt') AS completed_at
        FROM formulare_df fd
        JOIN flows f ON f.id = fd.flow_id
       WHERE fd.source_alop_id = $1
         AND fd.deleted_at IS NULL
         AND f.deleted_at IS NULL
         AND f.data->>'status' IS DISTINCT FROM 'cancelled'
         AND f.data->>'status' IS DISTINCT FROM 'refused'
         AND (f.data->>'status' = 'completed' OR (f.data->>'completed')::boolean = true)
       ORDER BY fd.revizie_nr DESC, fd.created_at DESC
    `, [alopId]);

    if (!cands.length) return null;
    if (cands.length > 1 && cands[0].revizie_nr === cands[1].revizie_nr) {
      logger.warn({ alopId, candidateCount: cands.length, revizie: cands[0].revizie_nr },
        '[ALOP] self-heal DF: ambiguu (mai multe DF pe aceeași revizie), skipped');
      return null;
    }
    const cand = cands[0];

    const { rows: linked } = await pool.query(`
      UPDATE alop_instances
         SET df_id = $1,
             df_flow_id = COALESCE(df_flow_id, $2),
             df_completed_at = COALESCE(df_completed_at, $3::timestamptz, NOW()),
             updated_at = NOW()
       WHERE id = $4
         AND df_id IS NULL
         AND cancelled_at IS NULL
      RETURNING id, df_id, df_flow_id, df_completed_at
    `, [cand.id, cand.flow_id, cand.completed_at || null, alopId]);

    if (!linked[0]) return null;

    if (cand.status !== 'aprobat') {
      try {
        await pool.query(
          `UPDATE formulare_df SET status='aprobat', updated_at=NOW()
            WHERE id=$1 AND deleted_at IS NULL AND status IS DISTINCT FROM 'aprobat'`,
          [cand.id]
        );
      } catch (e) {
        logger.error({ err: e, dfId: cand.id }, '[ALOP] self-heal DF: marcare aprobat esuata (non-fatal)');
      }
    }

    logger.info({ alopId, dfId: cand.id, flowId: cand.flow_id, revizie: cand.revizie_nr },
      '[ALOP] self-heal DF: legatura ALOP→DF refacuta (lazy)');
    return linked[0];
  } catch (e) {
    logger.error({ err: e, alopId }, '[ALOP] self-heal DF failed (non-fatal)');
    return null;
  }
}
```

⚠️ Garda `df_id IS NULL` = nu fură un ALOP deja legat. `cancelled_at IS NULL` =
singurul filtru permis (invariantul CLAUDE.md:499). NU adăuga `status <> 'completed'`.

# Verificare PAS 1:
node --check server/services/alop-link.mjs
grep -n "^export async function" server/services/alop-link.mjs
# Așteptat: 3 (selfHealAlopDfLink, finalizeDfOnFlowCompleted, selfHealAlopDfLinkByAlop)

═══════════════════════════════════════════════════════════════════
PAS 2 — Cablează în GET /api/alop/:id, ÎNAINTE de lazy auto-tranziție
═══════════════════════════════════════════════════════════════════
În `server/routes/alop.mjs`:

(a) import lângă celelalte servicii (după linia ~28 `authz-scope.mjs`):
```js
import { selfHealAlopDfLinkByAlop } from '../services/alop-link.mjs';
```

(b) în handlerul GET detaliu, imediat DUPĂ
```js
    if (!rows[0]) return res.status(404).json({ error: 'not_found' });
    const alop = rows[0];
```
și ÎNAINTE de comentariul `// ── Lazy auto-tranziție pentru fluxuri STS Cloud`,
inserează:
```js
    // ── Self-heal LAZY al legăturii ALOP→DF (v3.9.747) ──────────────────────
    // Calea de semnare CLOUD nu poate apela cârligul de finalizare (zona NO-TOUCH),
    // deci reataşarea se face aici, la prima deschidere a ALOP-ului. Oglindește
    // self-heal #1/#2 pentru ORD. Non-fatal: o eroare nu strică afișarea.
    if (!alop.df_id) {
      const healed = await selfHealAlopDfLinkByAlop(pool, req.params.id);
      if (healed) {
        alop.df_id           = healed.df_id;
        alop.df_flow_id      = healed.df_flow_id;
        alop.df_completed_at = healed.df_completed_at;
        alop.df_aprobat      = true;
      }
    }
```

⚠️ `alop.df_aprobat = true` e corect prin construcție: funcția reataşează DOAR
documente cu flux finalizat. Setarea contează pentru că blocul următor
(lazy auto-tranziție `draft|angajare → lichidare`) citește `alop.df_aprobat` —
astfel ALOP-ul reparat avansează în ACEEAȘI cerere, nu la următoarea deschidere.

⛔ NU muta și NU rescrie blocurile self-heal #1/#2 existente.

# Verificare PAS 2:
node --check server/routes/alop.mjs
grep -n "selfHealAlopDfLinkByAlop" server/routes/alop.mjs
# Așteptat: 2 (import + apel)

═══════════════════════════════════════════════════════════════════
PAS 3 — REVERT în zona NO-TOUCH (singura atingere permisă acolo)
═══════════════════════════════════════════════════════════════════
În `server/routes/flows/cloud-signing.mjs` ȘTERGE exact ce a adăugat #117:
- linia de import a lui `finalizeDfOnFlowCompleted`;
- cele DOUĂ linii `if (allDone) await finalizeDfOnFlowCompleted(pool, flowId);`
  (situl POLL ~552 și situl CALLBACK ~852).

Nimic altceva. După ștergere, `git diff server/routes/flows/cloud-signing.mjs`
comparat cu commitul de dinainte de #117 trebuie să fie GOL.

`finalizeDfOnFlowCompleted` RĂMÂNE în `alop-link.mjs` — e apelată în continuare din
`signing.mjs` pe calea `upload-signed-pdf`? **NU** (acolo era deja logica proprie).
Dacă rămâne fără apelanți în producție, PĂSTREAZ-O oricum: e acoperită de teste și
e cârligul corect pentru orice cale de semnare care NU e NO-TOUCH. Notează în
RAPORT FINAL câți apelanți are după revert.

# Verificare PAS 3:
git diff <commit_dinainte_de_117> -- server/routes/flows/cloud-signing.mjs
# Așteptat: GOL (fișierul e identic cu starea de dinainte de #117)
grep -rn "finalizeDfOnFlowCompleted" server/ --include=*.mjs | grep -v tests
# Așteptat: doar definiția din alop-link.mjs

═══════════════════════════════════════════════════════════════════
PAS 4 — Blocarea PUT să NU depindă de momentul scrierii lui 'aprobat'
═══════════════════════════════════════════════════════════════════
Cu cârligul mutat în lazy, un DF semnat prin cloud rămâne `status='completed'`
până la prima deschidere a ALOP-ului. În fereastra aceea, `df.mjs:346` ar reseta
un document SEMNAT QES la `draft` (`status='completed'` → reset + version++).
Blocarea trebuie derivată din flux, nu din coloană.

În `server/routes/formulare/df.mjs`, în handlerul PUT, înlocuiește ramura:
```js
      if (doc.status === 'completed') {
```
cu o verificare care întâi întreabă fluxul:
```js
      if (doc.status === 'completed') {
        // v3.9.747: pe calea de semnare CLOUD statusul rămâne 'completed' și după
        // aprobare (marcarea 'aprobat' e lazy). Un document SEMNAT nu se resetează
        // niciodată la draft — calea corectă e /revizuieste.
        let semnat = false;
        if (doc.flow_id) {
          const { rows: fr } = await pool.query(`
            SELECT 1 FROM flows f
             WHERE f.id = $1 AND f.deleted_at IS NULL
               AND f.data->>'status' IS DISTINCT FROM 'cancelled'
               AND f.data->>'status' IS DISTINCT FROM 'refused'
               AND (f.data->>'status' = 'completed' OR (f.data->>'completed')::boolean = true)
             LIMIT 1`, [doc.flow_id]);
          semnat = fr.length > 0;
        }
        if (semnat) return res.status(409).json({ error: 'document_locked', status: 'aprobat' });
        // P1 modifică după ce P2 a completat → reset + version++
```
restul ramurii rămâne neschimbat.

⚠️ VERIFICĂ ÎNTÂI că `doc.flow_id` e selectat în query-ul care încarcă `doc` în
acest handler. Dacă NU e, adaugă-l în lista de coloane — nu presupune.
⚠️ Excluderea `refused`/`cancelled` e esențială: după un REFUZ documentul trebuie
să rămână editabil (altfel blochezi corectarea).

# Verificare PAS 4:
node --check server/routes/formulare/df.mjs
grep -n "document_locked" server/routes/formulare/df.mjs
# Așteptat: 2 (blocarea nouă + cea existentă pe stări ne-editabile)

═══════════════════════════════════════════════════════════════════
PAS 5 — Teste
═══════════════════════════════════════════════════════════════════
Extinde `server/tests/db/df-alop-link-resilienta.test.mjs` (creat la #117) cu:

1. **Self-heal lazy**: ALOP cu `df_id=NULL` + DF cu `source_alop_id` = ALOP-ul, pe
   flux FINALIZAT, `status='completed'` → `selfHealAlopDfLinkByAlop` reataşează,
   marchează DF `aprobat`, iar re-apelul e idempotent (nu schimbă nimic).
2. **Nu fură**: ALOP cu `df_id` = alt document → funcția NU modifică nimic.
3. **Flux nefinalizat / refuzat / anulat** → NU reataşează (3 sub-cazuri).
4. **Ambiguitate**: două DF nedeleted cu ACEEAȘI `revizie_nr` maximă și același
   `source_alop_id`, ambele pe fluxuri finalizate → SKIP + warn, `df_id` rămâne NULL.
5. **Revizie mai nouă câștigă**: R0 și R1 ambele finalizate → se leagă R1.
6. **ALOP `completed` se vindecă și el** (invariantul CLAUDE.md:499): ALOP cu
   `status='completed'`, `df_id=NULL`, `cancelled_at IS NULL` → reataşat. ALOP
   `cancelled_at` ne-null → NU.
7. **PAS 4**: PUT pe DF `status='completed'` cu flux FINALIZAT → 409
   `document_locked`; același DF cu flux ÎN CURS → reset la `draft` (comportament
   neschimbat); cu flux `refused` → reset la `draft` (rămâne editabil).

⛔ Testele IMPORTĂ din producție — nu redeclara logica.

# Verificare PAS 5:
npm test
npm run test:db
# Așteptat: ambele verzi, test:db PASSED (nu SKIPPED)

═══════════════════════════════════════════════════════════════════
PAS 6 — Bump versiune
═══════════════════════════════════════════════════════════════════
`package.json`: 3.9.746 → 3.9.747. NU atinge `sw.js`, NU rula sed pe `?v=`.

═══════════════════════════════════════════════════════════════════
RAPORT FINAL (obligatoriu)
═══════════════════════════════════════════════════════════════════
- Fișiere/funcții atinse.
- **Dovada revertului**: `git diff` pe `cloud-signing.mjs` față de starea de dinainte
  de #117 = GOL, plus confirmarea că `server/signing/**` n-a fost atins deloc.
- Câți apelanți are `finalizeDfOnFlowCompleted` după revert.
- Ieșirea `npm test` + `npm run test:db` (PASSED, nu SKIPPED).
- Cele 7 grupuri de cazuri noi + rezultate.
- Hash commit + confirmarea `git push origin develop`.
- ⚠️ Reamintire: după deploy, self-heal-ul se declanșează la PRIMA DESCHIDERE a
  fiecărui ALOP afectat — nu retroactiv în masă.

═══════════════════════════════════════════════════════════════════
⛔ CONSTRÂNGERI ABSOLUTE
═══════════════════════════════════════════════════════════════════
⛔ În `server/routes/flows/cloud-signing.mjs` ai voie DOAR să ștergi cele 3 linii
   de la #117. Orice altă modificare acolo = STOP și raportează.
⛔ NU atinge `server/signing/**`, `bulk-signing.mjs`, `pades.mjs`,
   `java-pades-client.mjs`, `STSCloudProvider.mjs`.
⛔ NU modifica `selfHealAlopDfLink` și nici blocurile self-heal #1/#2 din alop.mjs.
⛔ NU adăuga filtre `completed_at IS NULL` / `status <> 'completed'` pe query-urile
   de relink/self-heal (invariantul CLAUDE.md:499).
⛔ NU adăuga migrații.
⛔ NU face checkout/merge/push pe `main`. Push DOAR pe `origin develop`.
⛔ Fără `.only`/`.skip` uitate, fără `console.log` de debug.

PAS FINAL: `git add -A && git commit -m "refactor(df-alop): self-heal DF lazy in alop.mjs + revert cârlig din zona NO-TOUCH; blocare PUT derivata din flux v3.9.747" && git push origin develop`
