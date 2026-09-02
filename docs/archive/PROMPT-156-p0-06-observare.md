# PROMPT-156 — P0-06, pasul 2: mod OBSERVARE (invariantul „numărul de semnături crește")

⚠️ BRANCH: develop — NICIODATĂ main. `main` e producția, gestionată manual doar de Mircea.

**model_suggested:** Opus 5 (atinge fișier din lanțul financiar semnare→DF aprobat→ALOP
lichidare; risc redus prin construcție — STRICT logging, zero blocare — dar zona merită
un model mai atent la nuanțe, nu Sonnet)
**cache_version_bump:** NU — `signing.mjs` e backend; `activity.js`/`audit.js` nu sunt în
`PRECACHE_ASSETS`
**migrations:** NU
**target:** citește `package.json` ÎNAINTE de orice modificare, incrementează patch-ul cu 1

## Context — ce s-a stabilit deja, NU se rediscută

- Diagnosticul retroactiv (`tools/diagnostic-p0-06-byterange-check.mjs`, rulat de Mircea pe
  producție) a confirmat **0 fluxuri finalizate cu PDF nesemnat** din 1660 verificate cu
  `signedPdfB64` stocat + 359 arhivate pe Google Drive (confirmate benigne, `storage:'drive'`,
  PDF șters intenționat de jobul de arhivare din `admin/flows.mjs`, nu o gaură). **Nu există
  nimic de reparat retroactiv** — pasul 4 din planul P0-06 e închis fără acțiune.
- Am verificat deja (nu mai verifica tu) că `buildCartusBlob`
  (`public/js/semdoc-signer/main.js`) desenează DOAR text + un widget `/Sig` GOL (fără `/V`,
  fără `/Contents`, fără `/ByteRange`) — deci nu poate produce fals-negativ pe invariantul de
  mai jos la semnatarul 1.
- Garda actuală (`signing.mjs`, ramura `else` / „tabel": `uploadedHash === uploadPayload.preHash`)
  rămâne NEATINSĂ în acest lot — nu o ștergem, nu o modificăm. Adăugăm invariantul nou ALĂTURI
  de ea, strict ca observare (logging), fără să schimbe niciun răspuns HTTP existent.

## Ce se adaugă

În `POST /flows/:flowId/upload-signed-pdf` (`server/routes/flows/signing.mjs`), imediat DUPĂ
blocul `if (data.flowType === 'ancore') {...} else {...}` (deci după ce ambele ramuri au
apucat să seteze `signers[idx].pdfUploaded = true`, ÎNAINTE de `data.signedPdfVersions`),
se adaugă o verificare STRICT NON-BLOCANTĂ: numără semnăturile reale (`extractPdfSignatures`,
tiparul `/ByteRange`) din PDF-ul stocat ÎNAINTE de acest upload (`data.signedPdfB64` dacă
există deja — semnatarul 2+ — altfel `data.pdfB64`, semnatarul 1) și din PDF-ul TOCMAI
uploadat. Dacă numărul nu a CRESCUT, se scrie un `logger.warn` + un eveniment nou în audit
(`P0_06_OBSERVED_UNSIGNED`) — și ATÂT. Cererea continuă normal, răspunsul HTTP nu se schimbă.

Se aplică o singură dată, pentru AMBELE ramuri (`ancore` și `tabel`) — un singur bloc de cod,
nu duplicat în fiecare ramură.

## Fișiere atinse (EXACT 4)

1. `server/routes/flows/signing.mjs` — import + verificarea OBSERVARE
2. `public/js/admin/activity.js` — etichetă RO pentru noul tip de eveniment
3. `public/js/admin/audit.js` — etichetă RO pentru noul tip de eveniment
4. `package.json` — bump patch

═══════════════════════════════════════════════════════════════════
## PASUL 0 — verificări obligatorii
═══════════════════════════════════════════════════════════════════

```bash
git branch --show-current
# Așteptat: develop

git status --short
# Așteptat: gol sau doar fișiere netrackuite cunoscute

grep -rn "PROMPT-156" docs/archive/ 2>/dev/null
git log --all --oneline | grep -i "#156"
# Așteptat: ambele goale. Dacă #156 e deja folosit, OPREȘTE-TE — nu renumerota

grep '"version"' package.json
# Notează valoarea — folosește patch-ul + 1 consecvent mai jos
```

═══════════════════════════════════════════════════════════════════
## ETAPA A — import în `signing.mjs`
═══════════════════════════════════════════════════════════════════

```
old_str:
import { dfAprobatSql } from '../../services/df-aprobat-sql.mjs';
import crypto from 'crypto';
import jwt from 'jsonwebtoken';

new_str:
import { dfAprobatSql } from '../../services/df-aprobat-sql.mjs';
import { extractPdfSignatures } from '../../services/certificate-verify.mjs';
import crypto from 'crypto';
import jwt from 'jsonwebtoken';
```

Verificare:
```bash
grep -c "import { extractPdfSignatures } from '../../services/certificate-verify.mjs';" server/routes/flows/signing.mjs
# Așteptat: 1
```

═══════════════════════════════════════════════════════════════════
## ETAPA B — verificarea OBSERVARE, o singură dată, după ambele ramuri
═══════════════════════════════════════════════════════════════════

⚠️ Ancora `signers[idx].uploadVerified = true; signers[idx].uploadedHash = uploadedHash; signers[idx].pdfUploaded = true;`
e ultima linie a ramurii `else` (tabel) — deci și ultima linie înainte de închiderea
blocului `if/else`. Verifică prin grep, EXACT 1 potrivire, înainte de patch.

```bash
grep -c "signers\[idx\].uploadVerified = true; signers\[idx\].uploadedHash = uploadedHash; signers\[idx\].pdfUploaded = true;" server/routes/flows/signing.mjs
# Așteptat: 1
```

```
old_str:
      signers[idx].uploadVerified = true; signers[idx].uploadedHash = uploadedHash; signers[idx].pdfUploaded = true;
    }
    if (!Array.isArray(data.signedPdfVersions)) data.signedPdfVersions = [];

new_str:
      signers[idx].uploadVerified = true; signers[idx].uploadedHash = uploadedHash; signers[idx].pdfUploaded = true;
    }
    // P0-06 — pasul 2 (OBSERVARE, #156): garda pe hash e moartă structural la semnatarul
    // 2+ (uploadToken vine din /pdf, fișierul din /signed-pdf — hash-urile nu au cum să
    // corespundă). Invariantul „numărul de semnături CREȘTE" e mai fiabil. Deocamdată DOAR
    // loghează — nu respinge — cât timp adunăm date reale de producție înainte de flip.
    try {
      const beforeBuf = Buffer.from(data.signedPdfB64 || data.pdfB64 || '', 'base64');
      const afterBuf  = Buffer.from(rawCheck, 'base64');
      const sigBefore = extractPdfSignatures(beforeBuf).length;
      const sigAfter  = extractPdfSignatures(afterBuf).length;
      if (sigAfter <= sigBefore) {
        logger.warn({ flowId, signerEmail: signers[idx].email, sigBefore, sigAfter },
          'P0-06 OBSERVARE: PDF uploadat nu are mai multe semnături decât versiunea anterioară');
        writeAuditEvent({ flowId, orgId: data.orgId, eventType: 'P0_06_OBSERVED_UNSIGNED',
          actorEmail: signers[idx].email, actorIp: _getIp(req), payload: { sigBefore, sigAfter } });
      }
    } catch(sigErr) {
      logger.warn({ err: sigErr, flowId }, 'P0-06 OBSERVARE: eroare la verificarea semnăturilor (non-fatal)');
    }
    if (!Array.isArray(data.signedPdfVersions)) data.signedPdfVersions = [];
```

Verificare:
```bash
grep -c "P0_06_OBSERVED_UNSIGNED" server/routes/flows/signing.mjs
# Așteptat: 1

grep -c "eventType: 'P0_06_OBSERVED_UNSIGNED'" server/routes/flows/signing.mjs
# Așteptat: 1 — necesar EXACT în această formă pentru testul de sincronizare a etichetelor
# (server/tests/integration/audit-labels-sync.test.mjs face grep pe "eventType:\s*'...'")
```

═══════════════════════════════════════════════════════════════════
## ETAPA C — etichetă RO în `activity.js`
═══════════════════════════════════════════════════════════════════

```bash
grep -c "STS_CANCELLED:                  'Sesiune STS anulată de semnatar'," public/js/admin/activity.js
# Așteptat: 1
```

```
old_str:
    STS_CANCELLED:                  'Sesiune STS anulată de semnatar',

    // ─── Delegări ─────────────────────────────────────────────────────

new_str:
    STS_CANCELLED:                  'Sesiune STS anulată de semnatar',
    P0_06_OBSERVED_UNSIGNED:        'PDF uploadat fără semnătură nouă (observare)',

    // ─── Delegări ─────────────────────────────────────────────────────
```

═══════════════════════════════════════════════════════════════════
## ETAPA D — etichetă RO în `audit.js`
═══════════════════════════════════════════════════════════════════

```bash
grep -c "'STS_CANCELLED':                 'Sesiune STS anulată de semnatar'," public/js/admin/audit.js
# Așteptat: 1
```

```
old_str:
    'STS_CANCELLED':                 'Sesiune STS anulată de semnatar',

    // ─── Delegări ─────────────────────────────────────────────────────

new_str:
    'STS_CANCELLED':                 'Sesiune STS anulată de semnatar',
    'P0_06_OBSERVED_UNSIGNED':       'PDF uploadat fără semnătură nouă (observare)',

    // ─── Delegări ─────────────────────────────────────────────────────
```

⚠️ Dacă `npm test` semnalează că mai lipsește eticheta și în altă parte (de ex.
`public/js/flow/flow.js`, cum s-a întâmplat la #125 pentru un tip de eveniment diferit),
adaug-o acolo la fel, oglindind exact formatul liniei vecine — testul e sursa de adevăr,
nu enumerarea de mai sus.

═══════════════════════════════════════════════════════════════════
## ETAPA E — versionare
═══════════════════════════════════════════════════════════════════

- `package.json`: `"version"` → patch-ul curent + 1

═══════════════════════════════════════════════════════════════════
## ETAPA F — teste
═══════════════════════════════════════════════════════════════════

Nu inventa un test nou dedicat — comportamentul relevant (zero schimbare de răspuns HTTP,
doar logging suplimentar) e greu de verificat util fără o bază reală cu PDF-uri reale
semnate (are nevoie de fixturi binare complexe pentru `/ByteRange`, cost mare / valoare mică
pentru un lot de observare). Rulează suita existentă ca poartă de non-regresie:

```bash
npm test
# Așteptat: verde, 0 failed (NU hardcoda numărul total — suita crește). Testul
# audit-labels-sync.test.mjs TREBUIE să treacă — el confirmă că eticheta nouă există.
```

Dacă ai acces la `test:db` (Postgres efemer), rulează-l și pe ăla — nu e specific acestui
lot, dar confirmă că n-ai stricat nimic în calea de upload existentă.

═══════════════════════════════════════════════════════════════════
## RAPORT FINAL (obligatoriu în răspunsul tău)
═══════════════════════════════════════════════════════════════════

- Versiune veche → nouă
- Commit hash + `git diff --stat` (4 fișiere, sau 5 dacă a trebuit și `flow.js`)
- Rezultat `npm test`, cu mențiune explicită că `audit-labels-sync.test.mjs` a trecut
- Confirmare, prin citire directă a codului: verificarea OBSERVARE rulează o singură dată,
  DUPĂ ambele ramuri (`ancore` ȘI `tabel`), nu duplicată
- Confirmare: NICIUN răspuns HTTP existent (status code, body) nu s-a schimbat față de
  `develop` dinainte de acest commit — verifică prin `git diff` că singurele linii noi sunt
  logging + audit, nimic pe calea `res.status/res.json` din ramurile existente
- Orice abatere, cu motivul

═══════════════════════════════════════════════════════════════════
## ⛔ CONSTRÂNGERI ABSOLUTE
═══════════════════════════════════════════════════════════════════

- ⛔ NU respinge NIMIC în acest lot — zero `return res.status(4xx)` nou. Modul OBSERVARE
  înseamnă STRICT logging + audit_log, nimic altceva. Flip-ul la blocare e un prompt SEPARAT,
  ulterior, după o fereastră de observare pe producție
- ⛔ NU atinge garda existentă pe hash (`uploadedHash === uploadPayload.preHash`) — rămâne
  exact cum e
- ⛔ NU atinge ramura `ancore` dincolo de a fi acoperită de verificarea comună de după `if/else`
- ⛔ NU atinge `server/signing/**`, `STSCloudProvider.mjs`, `cloud-signing.mjs`,
  `bulk-signing.mjs` — zona NO-TOUCH, neafectată de acest lot oricum
- ⛔ NU propune niciodată merge/push/checkout pe `main`
- ⛔ Dacă `#156` e deja folosit, OPREȘTE-TE și raportează

Ultimul pas, obligatoriu:
```bash
git push origin develop
```
