# DocFlowAI — 🔧 FIX OUTREACH: PDF attachment + dark dropdown + ALOP în templates (v3.9.434)

```
DocFlowAI v3.9.433 → v3.9.434 (SW v149 → v150)
Branch: develop
Subiect: fix(outreach): atașament PDF pe Railway + dropdown dark + ALOP în templates

═══════════════════════════════════════════════════════════
CONTEXT — 3 BUG-URI INDEPENDENTE PE PAGINA admin/outreach
═══════════════════════════════════════════════════════════

BUG 1 — Dropdown "Subiecte sugerate" cu fond ALB
  Cauză: <select> la public/admin.html linia 899 are doar inline-style,
  fără color-scheme:dark. Restul aplicației folosește clasa
  .df-filter-select (definită în public/css/admin/admin.css L57-69)
  care setează color-scheme:dark — de aici provine fundalul închis
  al lupei native a OS-ului pentru opțiuni.

BUG 2 — PDF DocFlowAI_Prezentare.pdf NU se atașează la mailuri (CRITIC)
  Cauză root: .dockerignore conține linia "tools" → întreg directorul
  tools/ (inclusiv DocFlowAI_Prezentare.pdf) este EXCLUS din imaginea
  Docker la build-ul Railway. La runtime fs.existsSync(pdfPath) returnează
  false → attachment rămâne null → mail trimis fără atașament.
  Codul din server/routes/admin/outreach.mjs ESTE CORECT — bug de
  configurare deploy, nu de logică. Server-ul rămâne neatins.

  Bonus: tools/primarii-romania.json este folosit de getPrimarii() la
  seed-ul iniţial al outreach_primarii pe fresh DB → trebuie și el păstrat.

BUG 3 — Templates fără mențiune ALOP
  Atât OR_DEFAULT_TEMPLATE (broșură) cât și OR_CONV_TEMPLATE (conversațional)
  din public/js/admin/outreach.js nu menționează modulul ALOP / OMF 1140/2025
  — punct major de diferențiere pentru primării.

═══════════════════════════════════════════════════════════
ZONĂ NO-TOUCH (NU MODIFICA)
═══════════════════════════════════════════════════════════
- server/signing/providers/STSCloudProvider.mjs
- server/routes/flows/cloud-signing.mjs
- server/routes/flows/bulk-signing.mjs
- server/signing/pades.mjs
- server/signing/java-pades-client.mjs
- server/routes/admin/outreach.mjs   ← codul backend e CORECT, fix-ul e doar deploy

═══════════════════════════════════════════════════════════
PASUL 1 — .dockerignore: whitelist asset-uri runtime
═══════════════════════════════════════════════════════════

Înlocuiește COMPLET conținutul .dockerignore cu:

----------------- .dockerignore -----------------
node_modules
.git
.env
*.log
coverage

# Excludem tools/ în general (script-uri de migrare, dezvoltare etc.)
# DAR păstrăm asset-urile folosite la runtime în producție:
#   - DocFlowAI_Prezentare.pdf  → atașament email outreach (server/routes/admin/outreach.mjs)
#   - primarii-romania.json     → seed inițial outreach_primarii (idem)
tools/*
!tools/DocFlowAI_Prezentare.pdf
!tools/primarii-romania.json
-------------------------------------------------

═══════════════════════════════════════════════════════════
PASUL 2 — public/admin.html: dropdown cu clasa .df-filter-select
═══════════════════════════════════════════════════════════

old_str (linia 899-906):
      <select onchange="if(this.value){$('or-c-subject').value=this.value;this.value='';}" style="padding:8px 12px;background:rgba(255,255,255,.05);border:1px solid rgba(255,255,255,.12);border-radius:9px;color:var(--muted);font-size:.82rem;cursor:pointer;max-width:240px;">
        <option value="">💡 Subiecte sugerate…</option>
        <option value="Propunere digitalizare flux documente – DocFlowAI">Propunere digitalizare (generic)</option>
        <option value="Semnături electronice calificate pentru {{institutie}} — demonstrație gratuită">Semnături calificate + demo</option>
        <option value="Cum elimină {{institutie}} hârtia din circuitul intern de documente">Eliminare hârtie (conversațional)</option>
        <option value="DocFlowAI — flux electronic ÎNTOCMIT→VIZAT→APROBAT pentru instituții publice">Flux ÎNTOCMIT→APROBAT</option>
        <option value="O întrebare despre circuitul de documente din {{institutie}}">Întrebare directă (cel mai personal)</option>
      </select>

new_str:
      <select onchange="if(this.value){$('or-c-subject').value=this.value;this.value='';}" class="df-filter-select" style="width:auto;max-width:260px;cursor:pointer;">
        <option value="">💡 Subiecte sugerate…</option>
        <option value="Propunere digitalizare flux documente – DocFlowAI">Propunere digitalizare (generic)</option>
        <option value="Semnături electronice calificate pentru {{institutie}} — demonstrație gratuită">Semnături calificate + demo</option>
        <option value="Cum elimină {{institutie}} hârtia din circuitul intern de documente">Eliminare hârtie (conversațional)</option>
        <option value="DocFlowAI — flux electronic ÎNTOCMIT→VIZAT→APROBAT + modul ALOP">Flux ÎNTOCMIT→APROBAT + ALOP</option>
        <option value="O întrebare despre circuitul de documente din {{institutie}}">Întrebare directă (cel mai personal)</option>
      </select>

═══════════════════════════════════════════════════════════
PASUL 3 — public/js/admin/outreach.js: ALOP în OR_DEFAULT_TEMPLATE
═══════════════════════════════════════════════════════════

old_str:
    <ul style="margin:8px 0 0 0;padding-left:18px;color:#334155;font-size:14px;line-height:1.8;">
      <li>Flux secvențial de semnare electronică (ÎNTOCMIT · VERIFICAT · VIZAT · APROBAT)</li>
      <li>Notificări automate prin email, push și WhatsApp</li>
      <li>Arhivare automată în Google Drive + jurnal de audit complet</li>
      <li>Securitate avansată: JWT HttpOnly, PBKDF2, CSP, GDPR compliant</li>
    </ul>

new_str:
    <ul style="margin:8px 0 0 0;padding-left:18px;color:#334155;font-size:14px;line-height:1.8;">
      <li>Flux secvențial de semnare electronică (ÎNTOCMIT · VERIFICAT · VIZAT · APROBAT)</li>
      <li><strong>Modul ALOP integrat</strong> — Angajament Bugetar · Lichidare · Ordonanțare · Plată, conform <strong>OMF 1140/2025</strong></li>
      <li>Notificări automate prin email, push și WhatsApp</li>
      <li>Arhivare automată în Google Drive + jurnal de audit complet</li>
      <li>Securitate avansată: JWT HttpOnly, PBKDF2, CSP, GDPR compliant</li>
    </ul>

═══════════════════════════════════════════════════════════
PASUL 4 — public/js/admin/outreach.js: ALOP în OR_CONV_TEMPLATE
═══════════════════════════════════════════════════════════

old_str:
  <p style="color:#1e293b;font-size:15px;line-height:1.8;margin:0 0 16px 0;">
    Am construit <strong>DocFlowAI</strong> ca răspuns la această nevoie:
    un sistem în care inițiatorul încarcă documentul, sistemul îl trimite automat
    fiecărui semnatar în ordine, iar la final totul este arhivat cu jurnal de audit complet.
  </p>

new_str:
  <p style="color:#1e293b;font-size:15px;line-height:1.8;margin:0 0 16px 0;">
    Am construit <strong>DocFlowAI</strong> ca răspuns la această nevoie:
    un sistem în care inițiatorul încarcă documentul, sistemul îl trimite automat
    fiecărui semnatar în ordine, iar la final totul este arhivat cu jurnal de audit complet.
  </p>
  <p style="color:#1e293b;font-size:15px;line-height:1.8;margin:0 0 16px 0;">
    În plus, platforma include <strong>modulul ALOP</strong> — un flux dedicat pentru
    <em>Angajament Bugetar · Lichidare · Ordonanțare · Plată</em>, construit conform
    <strong>OMF 1140/2025</strong>, cu pre-populare automată între etape și
    blocare a câmpurilor pe roluri (P1/P2). Practic, întreg circuitul financiar-contabil
    al instituției devine electronic, fără hârtie și fără registre paralele.
  </p>

═══════════════════════════════════════════════════════════
PASUL 5 — public/js/admin/outreach.js: subiect sugerat #4 cu ALOP
═══════════════════════════════════════════════════════════

old_str:
  const OR_SUBJECT_SUGGESTIONS = [
    'Propunere digitalizare flux documente – DocFlowAI',
    'Semnături electronice calificate pentru {{institutie}} — demonstrație gratuită',
    'Cum elimină {{institutie}} hârtia din circuitul intern de documente',
    'DocFlowAI — flux electronic ÎNTOCMIT→VIZAT→APROBAT pentru instituții publice',
    'O întrebare despre circuitul de documente din {{institutie}}',
  ];

new_str:
  const OR_SUBJECT_SUGGESTIONS = [
    'Propunere digitalizare flux documente – DocFlowAI',
    'Semnături electronice calificate pentru {{institutie}} — demonstrație gratuită',
    'Cum elimină {{institutie}} hârtia din circuitul intern de documente',
    'DocFlowAI — flux electronic ÎNTOCMIT→VIZAT→APROBAT + modul ALOP',
    'O întrebare despre circuitul de documente din {{institutie}}',
  ];

═══════════════════════════════════════════════════════════
PASUL 6 — package.json (version bump)
═══════════════════════════════════════════════════════════

old_str:   "version": "3.9.433",
new_str:   "version": "3.9.434",

═══════════════════════════════════════════════════════════
PASUL 7 — public/sw.js (CACHE_VERSION bump — outreach.js e în PRECACHE_ASSETS)
═══════════════════════════════════════════════════════════

old_str: const CACHE_VERSION = 'docflowai-v149';
new_str: const CACHE_VERSION = 'docflowai-v150';

═══════════════════════════════════════════════════════════
PASUL 8 — Cache busting în public/admin.html (?v= → 3.9.434)
═══════════════════════════════════════════════════════════

Există ~100 referințe v=3.9.421 în admin.html. Înlocuire bulk:

sed -i 's/v=3\.9\.421/v=3.9.434/g' public/admin.html

═══════════════════════════════════════════════════════════
VERIFICARE OBLIGATORIE după modificări:
═══════════════════════════════════════════════════════════

1. .dockerignore conține whitelist:
   grep -E "^!tools/" .dockerignore
   → trebuie să afișeze:
     !tools/DocFlowAI_Prezentare.pdf
     !tools/primarii-romania.json

2. Asset-urile există fizic în repo:
   ls -la tools/DocFlowAI_Prezentare.pdf tools/primarii-romania.json
   → ambele trebuie să existe (PDF ~300KB, JSON ~456KB)

3. Dropdown folosește df-filter-select:
   grep -n 'class="df-filter-select"' public/admin.html | wc -l
   → trebuie să fie ≥ 13 (cele 12 existente + cel nou de la outreach)

4. Subiect cu ALOP în <option>:
   grep -c "ÎNTOCMIT→VIZAT→APROBAT + modul ALOP" public/admin.html
   → trebuie să fie 1

5. ALOP în ambele templates JS:
   grep -c "Modul ALOP integrat\|modulul ALOP" public/js/admin/outreach.js
   → trebuie să fie 2 (unul în broșură, unul în conversațional)

6. OMF 1140/2025 menționat în ambele templates:
   grep -c "OMF 1140/2025" public/js/admin/outreach.js
   → trebuie să fie 2

7. Cache version aliniat în admin.html:
   grep -c "v=3.9.434" public/admin.html
   → trebuie să fie ~100
   grep -c "v=3.9.421" public/admin.html
   → trebuie să fie 0

8. CACHE_VERSION bump în sw.js:
   grep "^const CACHE_VERSION" public/sw.js
   → const CACHE_VERSION = 'docflowai-v150';

9. Sintaxă JS validă:
   node --check public/js/admin/outreach.js && echo "OK outreach.js"
   node --check public/sw.js && echo "OK sw.js"

10. Sintaxă server (full check):
    npm run check
    → toate fișierele OK, exit 0

11. Tests:
    npm test
    → verde, fără regresii (server/routes/admin/outreach.mjs nu este modificat,
      deci nicio regresie de aşteptat pe testele de integrare)

═══════════════════════════════════════════════════════════
COMMIT pe develop
═══════════════════════════════════════════════════════════
git add .dockerignore \
        public/admin.html \
        public/js/admin/outreach.js \
        public/sw.js \
        package.json

git commit -m "fix(outreach): PDF attachment Railway + dark dropdown + ALOP în templates (v3.9.434)

BUG 1 — .dockerignore excludea tools/ → DocFlowAI_Prezentare.pdf nu
  ajungea în imaginea Docker pe Railway, deci attachment rămânea null
  la trimiterea campaniilor. Whitelist:
    tools/*
    !tools/DocFlowAI_Prezentare.pdf
    !tools/primarii-romania.json
  (al doilea e necesar pentru seed-ul outreach_primarii pe fresh DB)

BUG 2 — Dropdown 'Subiecte sugerate' din admin/outreach folosea inline
  style fără color-scheme:dark → opțiunile apăreau cu fundal alb,
  inconsistent cu restul UI-ului. Aplicat clasa .df-filter-select
  (color-scheme:dark) + width:auto;max-width:260px.

BUG 3 — Ambele templates outreach (broșură + conversațional) menționează
  acum modulul ALOP și conformitatea OMF 1140/2025:
    - OR_DEFAULT_TEMPLATE: bullet nou în lista 'Ce oferă DocFlowAI'
    - OR_CONV_TEMPLATE: paragraf integrat în proză după descrierea
      fluxului, cu pre-populare automată și blocare pe roluri P1/P2
    - subiect sugerat #4: 'flux ÎNTOCMIT→VIZAT→APROBAT + modul ALOP'

ZONĂ NO-TOUCH respectată: server/routes/admin/outreach.mjs neatins
  (codul de attachment este corect — fix-ul e doar la deploy).

Cache bust: package 3.9.433 → 3.9.434, SW v149 → v150,
admin.html ?v= aliniat la 3.9.434 (100 referințe)."

git push origin develop

═══════════════════════════════════════════════════════════
TEST POST-DEPLOY (staging — docflowai-app-staging.up.railway.app)
═══════════════════════════════════════════════════════════

1. Hard refresh (Ctrl+Shift+R) pe /admin → tab Outreach → Campanie nouă:
   - Click pe dropdown "Subiecte sugerate" → opțiunile au fundal DARK
     (nu alb), match cu dropdown-urile de la Status / Instituție / Compartiment

2. Click "Template broșură" → în <textarea> apare HTML cu bullet nou
   "Modul ALOP integrat — ... OMF 1140/2025"

3. Click "Template conversațional ★" → în <textarea> apare paragraf nou
   despre modulul ALOP după descrierea fluxului

4. Selectează din dropdown opțiunea "Flux ÎNTOCMIT→APROBAT + ALOP"
   → câmpul "Subiect email" se completează cu textul nou

5. Crează o campanie de test cu 1 destinatar (email-ul tău), trimite:
   - Verifică că în Inbox sosește mailul
   - Verifică că ARE atașament DocFlowAI_Prezentare.pdf (~300KB)
     ← KEY TEST pentru BUG 2
   - Verifică că în corpul mailului apare mențiunea ALOP

STOP dacă:
- Atașamentul tot lipsește → verifică log-urile Railway pentru
  "Prezentarea nu este disponibilă" sau erori de citire fișier;
  posibil .railwayignore (nu .dockerignore) suprascrie comportamentul
- Dropdown-ul tot apare cu fundal alb → verifică în DevTools că
  elementul are într-adevăr class="df-filter-select" și că
  components.css se încarcă cu noul ?v=
- Templates nu se actualizează după hard refresh → SW cache nu s-a
  invalidat; verifică în DevTools → Application → Service Workers
  că versiunea e docflowai-v150
```
