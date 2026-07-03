# DocFlowAI — ✉️ Opțiune „Atașează Raportul de Conformitate" în modalul de email extern

```
═══════════════════════════════════════════════════════════
⚠️  BRANCH OBLIGATORIU: develop
⚠️  NU face checkout/merge/push pe main. NICIODATĂ.
⚠️  Producția (main → app.docflowai.ro) o gestionează Mircea manual.
═══════════════════════════════════════════════════════════

DocFlowAI v3.9.547 → v3.9.548
Branch: develop
Subiect: feat(email): opțiune atașare Raport de Conformitate (Trust Report) la emailul extern
Tip: FEATURE — frontend (component global) + backend (~20 linii). Schimbare de frontend →
     BUMP CACHE_VERSION + ?v= pe asset-urile atinse.
```

---

## 🎯 Scop

În modalul de email extern (component global `public/js/df-email-modal.js`), adaugă un checkbox
**bifat implicit**: „Atașează Raportul de Conformitate (Trust Report)". Când e bifat, backend-ul atașează
la email PDF-ul raportului de conformitate (semnături calificate, eIDAS / Legea 455/2001), pe lângă
PDF-ul semnat.

Terenul e pregătit: ruta `POST /flows/:flowId/send-email` acceptă deja `extraAttachments` și construiește
array-ul de atașamente; raportul se generează prin `generateTrustReport()` (din
`server/services/sign-trust-report.mjs`), care întoarce `{ pdfBytes, report, conclusion }` ȘI cachează în
`trust_reports.report_pdf`. **Reutilizezi exact pattern-ul „cache → dacă lipsește, generează" din
`server/routes/report.mjs`. ZERO logică nouă de raport — doar cablare.**

---

## 🚫 Zone interzise

- NU atinge signing NO-TOUCH (`STSCloudProvider.mjs`, `cloud-signing.mjs`, `bulk-signing.mjs`,
  `pades.mjs`, `java-pades-client.mjs`).
- NU modifica `sign-trust-report.mjs` — doar îl **apelezi**. NU modifica `report.mjs`.
- NU atinge `migrate.mjs`, schema, sau mașina de stare. Nicio migrare (tabela `trust_reports` există deja).

---

## 📋 Pas 0 — context

```bash
git checkout develop && git pull origin develop
git status   # clean

# Confirmă punctele de ancorare:
grep -n "extraAttachments\|attachments.push\|cleanPdfB64\|writeAuditEvent\|EMAIL_SENT\|getFlowData" server/routes/flows/email.mjs
grep -n "dfem-attach-list\|extraAttachments\|/send-email\|dfem-submit" public/js/df-email-modal.js
# Pattern de copiat (cache→generate):
sed -n '40,75p' server/routes/report.mjs
```

---

## 📋 Pas 1 — Frontend: checkbox în modal (`public/js/df-email-modal.js`)

### 1a. Markup — adaugă câmpul checkbox
În template-ul HTML al modalului, **imediat după** blocul „Atașamente suplimentare" (după
`<div class="dfem-attach-list" id="dfem-attach-list"></div>`, înainte de `<div class="dfem-msg" ...>`),
inserează:

```html
      <div class="dfem-field dfem-field-check">
        <label class="dfem-check" for="dfem-include-report">
          <input type="checkbox" id="dfem-include-report" checked />
          <span class="dfem-check-text">
            Atașează Raportul de Conformitate
            <span class="dfem-hint">— certifică semnăturile calificate (eIDAS / Legea 455/2001)</span>
          </span>
        </label>
      </div>
```

### 1b. Trimitere — include flag-ul în body
În funcția de trimitere (unde se construiește `body: JSON.stringify({ to: valid, subject, bodyText,
extraAttachments })`), citește checkbox-ul și adaugă flag-ul:

```js
const includeTrustReport = !!_rootEl.querySelector('#dfem-include-report')?.checked;
```
și în body:
```js
body: JSON.stringify({ to: valid, subject, bodyText, extraAttachments, includeTrustReport }),
```
Frontend-ul trimite DOAR flag-ul boolean — NU bytes de raport (backend-ul îl preia/generează).

### 1c. CSS (`public/css/df/email-modal.css`)
Adaugă stil minimal pentru rândul de checkbox, consecvent cu design tokens existente (`.dfem-*`):
```css
.dfem-field-check { margin-top: 4px; }
.dfem-check { display: flex; align-items: flex-start; gap: 8px; cursor: pointer; }
.dfem-check input[type="checkbox"] { margin-top: 3px; flex: 0 0 auto; }
.dfem-check-text { font-size: 13px; line-height: 1.4; }
```
(Adaptează la variabilele/clasele reale din fișier — citește-l întâi, NU inventa culori hardcodate dacă
există tokens.)

---

## 📋 Pas 2 — Backend: atașează raportul (`server/routes/flows/email.mjs`)

### 2a. Import
Adaugă lângă importurile existente:
```js
import { generateTrustReport } from '../../services/sign-trust-report.mjs';
```

### 2b. Citește flag-ul
Unde se destructurează body-ul (`let { to, subject, bodyText, extraAttachments = [] } = req.body || {}`),
adaugă `includeTrustReport = false`:
```js
let { to, subject, bodyText, extraAttachments = [], includeTrustReport = false } = req.body || {};
```

### 2c. Atașează raportul (NON-FATAL) — după ce `attachments` e construit din PDF semnat + extraAttachments
Inserează ÎNAINTE de trimiterea efectivă (înainte de bucla de recipients / construirea payload-ului),
reutilizând pattern-ul din `report.mjs`:

```js
if (includeTrustReport) {
  try {
    let reportBuf = null;
    // 1) cache
    const cache = await pool.query(
      'SELECT report_pdf FROM trust_reports WHERE flow_id = $1', [flowId]
    );
    if (cache.rows[0]?.report_pdf) {
      reportBuf = Buffer.isBuffer(cache.rows[0].report_pdf)
        ? cache.rows[0].report_pdf
        : Buffer.from(cache.rows[0].report_pdf);
    } else {
      // 2) generează (se cachează singur) — folosește bytes-ul PDF-ului semnat
      let pdfBytes = null;
      const srcB64 = data.signedPdfB64 || data.pdfB64;
      if (srcB64) {
        const clean = srcB64.includes(',') ? srcB64.split(',')[1] : srcB64;
        pdfBytes = Buffer.from(clean, 'base64');
      }
      const { pdfBytes: out } = await generateTrustReport({ flowId, flowData: data, pdfBytes, pool });
      reportBuf = out;
    }
    if (reportBuf && reportBuf.length > 100) {
      attachments.push({
        filename: `Raport_Conformitate_${flowId}.pdf`,
        content: reportBuf.toString('base64'),
      });
    }
  } catch (e) {
    // NON-FATAL: emailul pleacă oricum, fără raport. NU bloca trimiterea documentului.
    logger.warn({ err: e, flowId }, 'trust report attach failed — email continuă fără raport');
  }
}
```
> Verifică numele EXACT al variabilei care conține base64-ul PDF-ului semnat curățat (în cod e
> `cleanPdfB64` sau similar) și al obiectului `data` din `getFlowData`. Adaptează dacă diferă. Formatul
> atașamentului (`{ filename, content: <base64> }`) trebuie să fie IDENTIC cu cel folosit deja pentru
> PDF-ul semnat și `extraAttachments`.

### 2d. Audit / eveniment
În payload-ul evenimentului `EMAIL_SENT` (unde se loghează deja `extraAttachmentsCount`) și în
`writeAuditEvent`, adaugă flag-ul, ca să apară în evenimente/audit/flow:
```js
// în payload EMAIL_SENT + writeAuditEvent:
includeTrustReport: !!includeTrustReport,
trustReportAttached: attachments.some(a => a.filename?.startsWith('Raport_Conformitate_')),
```
(`trustReportAttached` reflectă dacă a fost EFECTIV atașat — diferă de flag dacă generarea a picat
non-fatal.)

---

## 📋 Pas 3 — Test (per CLAUDE.md: caracterizează zona pe care o atingi)

Ruta `send-email` e încă pe mock (nu are plasă DB). Adaugă acoperire focalizată pe noul branch:
- verifică testele existente pentru `send-email` (mock-ul de Resend/`fetch`): `grep -rl "send-email" server/tests/`.
- adaugă un test care: cu `includeTrustReport: true` și un flow completed seed-uit cu `report_pdf` în
  cache → atașamentele trimise includ `Raport_Conformitate_*`; cu `false` → nu-l includ.
- adaugă un test pentru **fallback non-fatal**: dacă generarea aruncă (mock `generateTrustReport` să
  arunce / cache gol + pdf lipsă), ruta tot răspunde **2xx** și emailul pleacă fără raport.
Urmează stilul testelor existente de email (mock pe `fetch` către Resend). Dacă zona n-are deloc test,
adaugă întâi unul de caracterizare pe send-email curent, apoi pe branch-ul nou.

---

## 📋 Pas 4 — cache busting (schimbare de frontend!)

Asset-uri atinse: `public/js/df-email-modal.js`, `public/css/df/email-modal.css`.
- Găsește unde sunt referențiate cu `?v=` în paginile HTML și bumpează versiunea (vezi CLAUDE.md →
  „Cache busting"). Folosește noua versiune `3.9.548`.
- Bumpează `CACHE_VERSION` în `public/sw.js`.
```bash
grep -rn "df-email-modal.js?v=\|email-modal.css?v=" public --include="*.html"
grep -n "CACHE_VERSION" public/sw.js
```

---

## 📋 Pas 5 — verificare + bump + commit + push

```bash
npm run check
npm test            # verde, fără regresii (+ noile teste de email)
# test:db opțional (zona nu e DB-characterized; testele noi sunt mock pe fetch).

# package.json: 3.9.547 → 3.9.548. CACHE_VERSION bumped. ?v= bumped pe cele 2 asset-uri.

git add server/routes/flows/email.mjs public/js/df-email-modal.js public/css/df/email-modal.css \
        public/sw.js public/*.html server/tests/ package.json
git commit -m "feat(email): opțiune atașare Raport de Conformitate (Trust Report) la emailul extern, bifată implicit, non-fatal + audit"
git push origin develop
```

---

## ✅ Definiție de „gata"

1. Checkbox bifat implicit în modalul global, după „Atașamente suplimentare".
2. Frontend trimite `includeTrustReport: <bool>` în body; NU trimite bytes de raport.
3. Backend atașează raportul reutilizând cache→generate din `report.mjs`; format atașament identic cu
   PDF-ul semnat; **non-fatal** (email pleacă și dacă raportul eșuează).
4. `EMAIL_SENT` + audit conțin `includeTrustReport` și `trustReportAttached`.
5. Teste: branch true/false + fallback non-fatal; `npm test` verde fără regresii.
6. Cache busting: `?v=3.9.548` pe `df-email-modal.js` + `email-modal.css`; `CACHE_VERSION` bumped.
7. ZERO atingere NO-TOUCH / `sign-trust-report.mjs` / `report.mjs` / schemă.
8. Push pe develop; CI verde.
9. Raport: ce s-a adăugat (FE/BE/test), confirmare non-fatal, confirmare audit, asset-urile bumpate.

> Decizie produs (confirmă cu Mircea dacă diferă): checkbox **bifat implicit**. Dacă vrea nebifat,
> scoate `checked` din input la Pas 1a — restul rămâne identic.
