# DocFlowAI — 🔧 v3.9.477: Atașament Ghid Utilizare în Outreach + pas "Final" verde la flux finalizat

```
═══════════════════════════════════════════════════════════
⚠️  BRANCH OBLIGATORIU: develop
⚠️  NU face checkout/merge/push pe main. NICIODATĂ.
⚠️  Producția (main → app.docflowai.ro) o gestionează Mircea manual.
═══════════════════════════════════════════════════════════

DocFlowAI v3.9.476 → v3.9.477 (SW v192 → v193)
Branch: develop
Subiect: feat(outreach): atașează și Ghidul de utilizare + fix(my-flows): pas Final verde la flux finalizat
```

---

## 📌 ÎNAINTE DE A ÎNCEPE — pas manual pentru Mircea

**Mircea pune fizic în repo, sub `tools/`, fișierul `Ghid_utilizare_DocFlowAI.pdf`** (Ghidul de utilizare în formă finală).

Cale exactă: `tools/Ghid_utilizare_DocFlowAI.pdf`

Asistentul (Claude Code) **NU generează acest PDF** — îl găsește deja prezent. Verifică existența la pasul 0:

```bash
test -f tools/Ghid_utilizare_DocFlowAI.pdf && \
  echo "✓ Ghid prezent — $(du -h tools/Ghid_utilizare_DocFlowAI.pdf | cut -f1)" || \
  { echo "✗ STOP — Ghid_utilizare_DocFlowAI.pdf lipsește din tools/. Cere-i lui Mircea să-l adauge înainte."; exit 1; }
```

Dacă lipsește → STOP imediat și raportează. NU continua.

---

## 🎯 Context — 2 fix-uri independente

### FIX 1 — Outreach: atașează **și** Ghidul de utilizare (pe lângă Prezentare)

Astăzi mailul outreach atașează doar `DocFlowAI_Prezentare.pdf`. Vrem să atașeze **și** `Ghid_utilizare_DocFlowAI.pdf` (ghidul complet al platformei) — destinatarii (primării) văd direct cum funcționează platforma.

**Modificări:**
1. `.dockerignore` — whitelist pentru noul fișier (altfel rămâne afară din imaginea Docker pe Railway — exact bug-ul rezolvat anterior pentru Prezentare).
2. `server/routes/admin/outreach.mjs` — citește ambele PDF-uri și trimite array de 2 atașamente la `sendEmail`.
3. `env.example` — adaugă `OUTREACH_GHID_PATH` opțional, simetric cu `OUTREACH_PDF_PATH`.

### FIX 2 — Pas "Final" gri la fluxurile finalizate

Pe `semdoc-initiator.html` (Fluxurile mele), la cardul unui flux **finalizat**:
- ✅ Badge "Finalizat" verde
- ✅ Cercul semnatarului (Administrator) verde cu nume verde
- ❌ Cercul pasului **Final** rămâne gri, cu textul "Final" în loc de "Finalizat"

**Cauză root** (verificat în zip-ul curent):
Endpoint-ul `GET /my-flows` din `server/routes/flows/crud.mjs` returnează `completedAt`, `refusedAt`, `cancelledAt`, `allSigned`, `status`... dar **NU** returnează câmpul `completed`. Frontend-ul (`public/js/semdoc-initiator/main.js` L1049-1052) verifică `f.completed` în 4 ternare succesive — toate evaluează `undefined → false`, deci se cade pe ramurile default ("Final", gri, fără `ms-done`).

Fix-ul corect e **pe backend**, simetric cu cum sunt deja propagate `completedAt`/`refusedAt`/`cancelledAt`: adăugăm `completed: !!d.completed` la obiectul `myFlows`. Frontend-ul **rămâne neatins** — își face deja toată logica corect, doar primește acum câmpul lipsă.

---

## ⛔ ABSOLUTE — NU se ating

1. `server/routes/flows/cloud-signing.mjs`
2. `server/routes/flows/bulk-signing.mjs`
3. `server/services/pades.mjs`
4. `server/services/java-pades-client.mjs`
5. `server/services/STSCloudProvider.mjs`
6. `public/js/semdoc-initiator/main.js` — **NU îl modifici**. Frontend-ul deja funcționează corect, primește doar câmpul lipsă din backend.
7. Niciun test existent nu e șters / dezactivat.

---

## 📋 Modificări detaliate

### 1. `.dockerignore` — whitelist Ghid

**Verificare context curent:**
```bash
grep -E "^!tools/" .dockerignore
# Așteptat:
#   !tools/DocFlowAI_Prezentare.pdf
#   !tools/primarii-romania.json
```

**Patch:**

old_str:
```
tools/*
!tools/DocFlowAI_Prezentare.pdf
!tools/primarii-romania.json
```

new_str:
```
tools/*
!tools/DocFlowAI_Prezentare.pdf
!tools/Ghid_utilizare_DocFlowAI.pdf
!tools/primarii-romania.json
```

---

### 2. `server/routes/admin/outreach.mjs` — adaugă atașamentul Ghid

**2a.** Adaugă constanta `GHID_PATH` lângă `PDF_PATH` (linia ~30).

old_str:
```javascript
const DAILY_SEND_LIMIT    = parseInt(process.env.OUTREACH_DAILY_LIMIT || '100');
const FROM_EMAIL          = process.env.OUTREACH_FROM || 'DocFlowAI <contact@docflowai.ro>';
const PDF_PATH            = process.env.OUTREACH_PDF_PATH || null;
```

new_str:
```javascript
const DAILY_SEND_LIMIT    = parseInt(process.env.OUTREACH_DAILY_LIMIT || '100');
const FROM_EMAIL          = process.env.OUTREACH_FROM || 'DocFlowAI <contact@docflowai.ro>';
const PDF_PATH            = process.env.OUTREACH_PDF_PATH || null;
const GHID_PATH           = process.env.OUTREACH_GHID_PATH || null;
```

**2b.** În loop-ul de trimitere campanie (zona `let attachment = null;` ~linia 698) — înlocuiește atașamentul singular cu array de atașamente.

old_str:
```javascript
    // PDF atașament (opțional)
    let attachment = null;
    const pdfPath = PDF_PATH || path.join(process.cwd(), 'tools', 'DocFlowAI_Prezentare.pdf');
    if (fs.existsSync(pdfPath)) {
      const pdfBuf = fs.readFileSync(pdfPath);
      attachment = { filename: 'DocFlowAI_Prezentare.pdf', content: pdfBuf };
    }
```

new_str:
```javascript
    // Atașamente (opționale): Prezentare + Ghid de utilizare
    // Ambele sunt încărcate o singură dată în memorie și reutilizate pentru toți destinatarii batch-ului.
    const attachments = [];
    const pdfPath = PDF_PATH || path.join(process.cwd(), 'tools', 'DocFlowAI_Prezentare.pdf');
    if (fs.existsSync(pdfPath)) {
      attachments.push({
        filename: 'DocFlowAI_Prezentare.pdf',
        content: fs.readFileSync(pdfPath).toString('base64'),
      });
    } else {
      logger.warn({ pdfPath }, 'outreach: Prezentare PDF lipsește — se trimite fără atașament Prezentare');
    }
    const ghidPath = GHID_PATH || path.join(process.cwd(), 'tools', 'Ghid_utilizare_DocFlowAI.pdf');
    if (fs.existsSync(ghidPath)) {
      attachments.push({
        filename: 'Ghid_utilizare_DocFlowAI.pdf',
        content: fs.readFileSync(ghidPath).toString('base64'),
      });
    } else {
      logger.warn({ ghidPath }, 'outreach: Ghid PDF lipsește — se trimite fără atașament Ghid');
    }
```

**2c.** Update apelul `sendEmail` să folosească noul array (în același loop, ~linia 723).

old_str:
```javascript
        await sendEmail({
          to: recip.email,
          subject,
          html,
          ...(attachment ? { attachments: [{ filename: attachment.filename, content: attachment.content.toString('base64') }] } : {}),
        });
```

new_str:
```javascript
        await sendEmail({
          to: recip.email,
          subject,
          html,
          ...(attachments.length ? { attachments } : {}),
        });
```

**Notă:** mai sus în fișier (linia ~418) există endpointul `GET /download/:trackingId` care servește **doar** `DocFlowAI_Prezentare.pdf` la click pe linkul de tracking din mail — îl lăsăm neatins, e CTA-ul principal "Aflați mai multe". Ghidul este pur atașament — destinatarul îl deschide direct din mail.

---

### 3. `env.example` — variabilă nouă

old_str:
```
# Cale absoluta spre PDF-ul prezentarii (optional — daca lipseste, se trimite fara atasament)
OUTREACH_PDF_PATH=/app/tools/DocFlowAI_Prezentare.pdf
```

new_str:
```
# Cale absoluta spre PDF-ul prezentarii (optional — daca lipseste, se trimite fara atasament Prezentare)
OUTREACH_PDF_PATH=/app/tools/DocFlowAI_Prezentare.pdf
# Cale absoluta spre Ghidul de utilizare (optional — daca lipseste, se trimite fara atasament Ghid)
OUTREACH_GHID_PATH=/app/tools/Ghid_utilizare_DocFlowAI.pdf
```

---

### 4. `server/routes/flows/crud.mjs` — propagă `completed` la `my-flows`

**Verificare context curent:**
```bash
grep -n "completedAt:  d.completedAt" server/routes/flows/crud.mjs
# Așteptat: o singură ocurență, în obiectul myFlows
```

**Patch:**

old_str:
```javascript
    const myFlows = rows.map(r => r.data).filter(Boolean).map(d => ({
      flowId: d.flowId, docName: d.docName || '—', initName: d.initName, initEmail: d.initEmail,
      createdAt: d.createdAt, updatedAt: d.updatedAt,
      completedAt:  d.completedAt  || null,
      refusedAt:    d.refusedAt    || null,  // nivel flux — pentru pasul Final
      cancelledAt:  d.cancelledAt  || null,  // nivel flux — fallback semnatari anulați
      cancelledBy:  d.cancelledBy  || null,
```

new_str:
```javascript
    const myFlows = rows.map(r => r.data).filter(Boolean).map(d => ({
      flowId: d.flowId, docName: d.docName || '—', initName: d.initName, initEmail: d.initEmail,
      createdAt: d.createdAt, updatedAt: d.updatedAt,
      completed:    !!d.completed,           // BUGFIX v3.9.477: lipsea → pasul Final apărea gri în mini-timeline
      completedAt:  d.completedAt  || null,
      refusedAt:    d.refusedAt    || null,  // nivel flux — pentru pasul Final
      cancelledAt:  d.cancelledAt  || null,  // nivel flux — fallback semnatari anulați
      cancelledBy:  d.cancelledBy  || null,
```

---

### 5. Bump versiune & cache busting

**5a. `package.json`** — bump `3.9.476` → `3.9.477`:

old_str: `"version": "3.9.476",`
new_str: `"version": "3.9.477",`

**5b. `public/sw.js`** — bump SW:

old_str: `const CACHE_VERSION = 'docflowai-v192';`
new_str: `const CACHE_VERSION = 'docflowai-v193';`

**5c. Cache busting în HTML** — toate `?v=3.9.475` și `?v=3.9.476` devin `?v=3.9.477`.

Aplicare bulk:
```bash
# Pe macOS folosește: sed -i '' (cu '' după -i)
# Pe Linux/Railway/CI:
find public -maxdepth 1 -name "*.html" -type f -exec \
  sed -i -E 's/\?v=3\.9\.47[56]/\?v=3.9.477/g' {} +
```

---

## ✅ VERIFICĂRI OBLIGATORII (rulează-le toate, raportează output-ul)

```bash
# 0. Ghid prezent
test -f tools/Ghid_utilizare_DocFlowAI.pdf && echo "OK: Ghid prezent" || echo "FAIL"

# 1. .dockerignore whitelist
grep -c "^!tools/Ghid_utilizare_DocFlowAI.pdf$" .dockerignore
# Așteptat: 1

# 2. outreach.mjs — GHID_PATH definit
grep -c "const GHID_PATH" server/routes/admin/outreach.mjs
# Așteptat: 1

# 3. outreach.mjs — array de atașamente
grep -c "const attachments = \[\];" server/routes/admin/outreach.mjs
# Așteptat: 1
grep -c "Ghid_utilizare_DocFlowAI.pdf" server/routes/admin/outreach.mjs
# Așteptat: ≥ 1 (atașamentul în send loop)

# 4. crud.mjs — completed propagat
grep -c "completed:    !!d.completed" server/routes/flows/crud.mjs
# Așteptat: 1

# 5. env.example — OUTREACH_GHID_PATH prezent
grep -c "OUTREACH_GHID_PATH" env.example
# Așteptat: 1

# 6. Versiune package + SW aliniate
grep '"version"' package.json | head -1
# Așteptat: "version": "3.9.477",
grep "^const CACHE_VERSION" public/sw.js
# Așteptat: const CACHE_VERSION = 'docflowai-v193';

# 7. Cache busting HTML — zero ocurențe vechi
grep -rE "\?v=3\.9\.47[56]" public/*.html | wc -l
# Așteptat: 0
grep -rl "?v=3.9.477" public/*.html | wc -l
# Așteptat: 13 (toate HTML-urile care aveau cache busting)

# 8. NO-TOUCH check
for f in cloud-signing.mjs bulk-signing.mjs; do
  git diff develop --name-only | grep -q "server/routes/flows/$f" && echo "FAIL: $f modificat" || echo "OK: $f neatins"
done
for f in pades.mjs java-pades-client.mjs STSCloudProvider.mjs; do
  git diff develop --name-only | grep -q "server/services/$f" && echo "FAIL: $f modificat" || echo "OK: $f neatins"
done
git diff develop --name-only | grep -q "public/js/semdoc-initiator/main.js" && \
  echo "FAIL: main.js modificat — frontend nu trebuia atins" || echo "OK: main.js neatins"

# 9. Syntax check server
node --check server/routes/admin/outreach.mjs && echo "OK syntax outreach"
node --check server/routes/flows/crud.mjs && echo "OK syntax crud"
node --check public/sw.js && echo "OK syntax sw"

# 10. Tests (criticul)
npm test
# Așteptat: verde, fără regresii
```

---

## 🧪 Test funcțional manual pe staging

După push pe `develop` și deploy staging (`docflowai-app-staging.up.railway.app`):

### Outreach
1. Admin → Outreach → selectează o campanie cu măcar 1 destinatar `pending`.
2. Trimite batch de 1 email către o adresă personală controlată.
3. Verifică inbox: emailul are **2 atașamente** — `DocFlowAI_Prezentare.pdf` (~300KB) + `Ghid_utilizare_DocFlowAI.pdf`.
4. Deschide ambele PDF-uri → conținutul e corect.

### Pas Final verde
1. Login cu un user cu fluxuri finalizate.
2. Hard-reload (Ctrl+Shift+R) pagina "Fluxurile mele".
3. La un flux **Finalizat**, mini-timeline-ul are:
   - Cercul "Administrator" verde (deja așa)
   - Cercul **Final** acum verde, text **"Finalizat"** (în loc de "Final"), data și ora în verde.
4. La un flux **Refuzat** → cercul Final rămâne roșu cu "⛔ Refuzat" (regresie 0).
5. La un flux **Anulat** → cercul Final rămâne roșu cu "🚫 Anulat" (regresie 0).
6. La un flux **În semnare** → cercul Final rămâne gri cu "Final" (regresie 0).

### DevTools (consolă, pe Fluxurile mele):
```js
// Verifică că payload-ul my-flows conține acum cheia 'completed'
fetch('/my-flows', { credentials: 'include' })
  .then(r => r.json())
  .then(j => {
    const sample = j.flows.find(f => f.completed);
    console.log('Sample completed flow:', sample);
    console.log('Has key "completed":', 'completed' in (j.flows[0] || {}));
  });
// Așteptat: 'Has key "completed": true' și sample.completed === true pentru fluxurile finalizate
```

---

## 📝 Commit pe `develop` (NU pe main!)

```bash
git add .dockerignore \
        server/routes/admin/outreach.mjs \
        server/routes/flows/crud.mjs \
        env.example \
        package.json \
        public/sw.js \
        public/*.html

git commit -m "feat(outreach): atașează Ghid_utilizare + fix(my-flows): pas Final verde la flux finalizat (v3.9.477)

FIX 1 — Outreach: pe lângă DocFlowAI_Prezentare.pdf se atașează acum și
  Ghid_utilizare_DocFlowAI.pdf la fiecare email de campanie. Whitelist
  adăugat în .dockerignore (altfel directorul tools/ e exclus pe Railway).
  Nouă variabilă env opțională OUTREACH_GHID_PATH simetrică cu
  OUTREACH_PDF_PATH. PDF-urile sunt încărcate o singură dată per batch.

FIX 2 — GET /my-flows omitea câmpul 'completed' (raporta doar
  completedAt). Frontend public/js/semdoc-initiator/main.js verifica
  f.completed în 4 ternare → toate evaluau undefined→false, deci pasul
  Final apărea gri cu textul 'Final' chiar la fluxuri finalizate.
  Adăugat: completed: !!d.completed în obiectul myFlows. Frontend-ul
  rămâne neatins — primește acum câmpul lipsă și își face logica corect:
  ms-done verde + text 'Finalizat' + culoare rgba(38,208,124,.65).

Cache busting: ?v=3.9.475/.476 → ?v=3.9.477 în toate HTML-urile.
SW: docflowai-v192 → docflowai-v193.

Tests: npm test verde, fără regresii."

git push origin develop
```

---

## 🚀 Pas final pentru Mircea (după ce Claude Code raportează verde)

**Pe Railway staging** — adaugă în Variables:

```
OUTREACH_GHID_PATH=/app/tools/Ghid_utilizare_DocFlowAI.pdf
```

Nu e obligatoriu (codul are fallback la `path.join(cwd(), 'tools', 'Ghid_utilizare_DocFlowAI.pdf')`), dar e curat să fie setat explicit.

Verifică în logs la primul send batch:
```
outreach batch sent  campaignId=X sentCount=Y
```
**fără** warning-uri de tipul `outreach: Ghid PDF lipsește`.
