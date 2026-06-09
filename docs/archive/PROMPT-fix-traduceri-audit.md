# Fix traduceri evenimente flow_events lipsă din pagina Rapoarte + Log audit

## ⚠️ BRANCH DEVELOP EXCLUSIV

NU face `git checkout main`, NU face `git merge main`, NU face `git push origin main`.
Toată munca rămâne pe branch `develop`. Verifică `git branch --show-current` înainte de orice commit.

## Context

Pe pagina **Rapoarte** (`/admin → tab rapoarte` — fișier `public/js/admin/activity.js`) și pe **Log audit** (`public/js/admin/audit.js`) apar 3 etichete netraduse, afișate cu fallback raw (cu underscore-uri înlocuite cu spații, fără culoare, fără icon):

- `CERTIFICATE_EXTRACTED` → trebuie să devină `CERTIFICAT EXTRAS`
- `TRUST_REPORT_GENERATED` → trebuie să devină `RAPORT VALIDARE GENERAT`
- `TOKEN_REGENERATED` → trebuie să devină `LINK SEMNARE REÎNNOIT`

**Sursa de adevăr (single source of truth)** pentru aceste 3 traduceri este `public/js/flow/flow.js` linia 452-454, unde sunt deja definite identic. Copiază literalmente aceleași string-uri.

**Cauza scapării test guard-ului:** `server/tests/integration/audit-labels-sync.test.mjs` linia 29 scanează regex `eventType:\s*'(...)'` — care prinde doar event-urile scrise în `audit_log` via `writeAuditEvent()`. Cele 3 event-uri lipsă sunt scrise cu pattern `type: '...'` direct în `flows.data.events` (JSONB), deci scapă regex-ului. Trebuie extins testul să scaneze și pattern-ul `type: '...'` push-uit în `data.events`.

===============================================================================

## Pas 1 — Verifică starea curentă

```bash
git branch --show-current
# Așteptat: develop

grep -n "CERTIFICATE_EXTRACTED\|TRUST_REPORT_GENERATED\|TOKEN_REGENERATED" public/js/admin/activity.js public/js/admin/audit.js
# Așteptat: niciun match (asta e bug-ul)

grep -n "CERTIFICATE_EXTRACTED\|TRUST_REPORT_GENERATED\|TOKEN_REGENERATED" public/js/flow/flow.js
# Așteptat: 3 linii (452, 453, 454) — sursa de adevăr
```

===============================================================================

## Pas 2 — Adaugă cele 3 traduceri în `public/js/admin/activity.js`

În `OP_LABELS_RO` (start linia 20), adaugă **înainte de** secțiunea `// ─── Autentificare ───`:

```javascript
    // ─── Validare PAdES & raport trust ────────────────────────────────
    CERTIFICATE_EXTRACTED:          'Certificat extras',
    TRUST_REPORT_GENERATED:         'Raport validare generat',
    TOKEN_REGENERATED:              'Link semnare reînnoit',
```

În `OP_COLORS` (start linia 74), adaugă pe o linie nouă înainte de `'auth.login.success':`:

```javascript
    CERTIFICATE_EXTRACTED: '#9db0ff', TRUST_REPORT_GENERATED: '#26d07c', TOKEN_REGENERATED: '#ffd580',
```

În `OP_ICONS` (start linia 87), adaugă pe o linie nouă înainte de `'auth.login.success':`:

```javascript
    CERTIFICATE_EXTRACTED: '🔎', TRUST_REPORT_GENERATED: '📜', TOKEN_REGENERATED: '🔗',
```

**Note:**
- Folosesc majuscula doar pe prima literă în label (consistent cu restul dicționarului — `'Flux inițiat'`, `'Refuzat'`, nu `'FLUX INIȚIAT'`).
- Culorile: trust report = verde (succes generare), certificate = lavandă (informativ), token = chihlimbar (atenție/admin action).

===============================================================================

## Pas 3 — Adaugă aceleași 3 traduceri în `public/js/admin/audit.js`

În `AUDIT_EVENT_LABELS` (start linia 16), adaugă **înainte de** secțiunea `// ─── Autentificare ───`:

```javascript
    // ─── Validare PAdES & raport trust ────────────────────────────────
    'CERTIFICATE_EXTRACTED':         'Certificat extras',
    'TRUST_REPORT_GENERATED':        'Raport validare generat',
    'TOKEN_REGENERATED':             'Link semnare reînnoit',
```

(atenție la stilul de quoting — `audit.js` folosește chei quoted: `'FLOW_CREATED':`, NU bare).

===============================================================================

## Pas 4 — Extinde test guard-ul să prindă și `data.events`

Editează `server/tests/integration/audit-labels-sync.test.mjs`.

În funcția `extractEventTypesFromBackend()` (linia 26-40), **după** loop-ul existent care folosește regex `eventType:\s*'...'`, adaugă un al doilea pass care scanează pattern-ul `type: '...'` push-uit în arrays de events. Atenție — pattern-ul `type: '...'` apare și în alte contexte (notificări, request bodies), deci filtrăm strict: doar evenimentele care au și `at:` în același obiect (heuristică simplă: ferestre de 200 caractere). Înlocuiește integral funcția cu:

```javascript
function extractEventTypesFromBackend() {
  const files = walkMjs(path.join(REPO, 'server'));
  const types = new Set();

  // Pattern 1: audit_log via writeAuditEvent
  const reAudit = /eventType:\s*'([A-Za-z_.][A-Za-z_.0-9]*)'/g;

  // Pattern 2: flow_events JSONB — type: '...' într-un obiect care conține și `at:`
  // (filtrare strictă pentru a evita match-uri în notificări/payloads)
  const reFlowEv = /\{[^{}]*\bat:\s*[^,{}]+,[^{}]*\btype:\s*'([A-Z_][A-Z_0-9]*)'[^{}]*\}/g;
  const reFlowEvAlt = /\{[^{}]*\btype:\s*'([A-Z_][A-Z_0-9]*)'[^{}]*\bat:\s*[^,{}]+[^{}]*\}/g;

  for (const f of files) {
    if (f.includes(`${path.sep}tests${path.sep}`)) continue;
    const s = readFileSync(f, 'utf8');
    let m;
    while ((m = reAudit.exec(s)) !== null) types.add(m[1]);
    while ((m = reFlowEv.exec(s)) !== null) types.add(m[1]);
    while ((m = reFlowEvAlt.exec(s)) !== null) types.add(m[1]);
  }

  // Eventuri scrise cu raw SQL (rar) sau în notify pipelines fără `at:` în literal
  types.add('plata_auto_opme');
  types.add('entitlement_change');

  // Excludem eventuri tehnice care NU au `by:` setat (deci nu apar în Rapoarte)
  // NOTIFY/NOTIFY_FAILED sunt notificări auto, fără actor uman
  types.delete('NOTIFY');
  types.delete('NOTIFY_FAILED');

  return types;
}
```

**De ce 2 regex (`reFlowEv` și `reFlowEvAlt`)**: ordinea `at`/`type` în obiectul push-uit nu e fixă în codebase — uneori `{ at, type, by }`, alteori `{ type, at, by }`.

**De ce excludem NOTIFY/NOTIFY_FAILED**: vezi `server/index.mjs:1547-1551` — sunt push-uite fără `by:`, iar în `analytics.mjs:339-340` agregatorul filtrează `if (!byEmail) continue;`. Deci nu apar niciodată în pagina Rapoarte.

===============================================================================

## Pas 5 — Rulează testele

```bash
npm test 2>&1 | tail -40
```

**Așteptat:**
- testul `audit-labels-sync.test.mjs` rulează acum cu mai multe `it()` (cele 3 noi: `CERTIFICATE_EXTRACTED`, `TRUST_REPORT_GENERATED`, `TOKEN_REGENERATED`)
- toate trec verde
- nicio regresie pe celelalte teste (npm test verde, fără regresii)

Dacă vreun test eșuează cu mesaj `Lipsește în public/js/admin/...js > ...`, verifică Pas 2 și Pas 3 — probabil ai uitat să adaugi cheia într-unul din cele 2 dicționare client.

===============================================================================

## Pas 6 — Sanity check vizual

```bash
grep -c "CERTIFICATE_EXTRACTED\|TRUST_REPORT_GENERATED\|TOKEN_REGENERATED" public/js/admin/activity.js
# Așteptat: 9 (3 tipuri × 3 dicționare: OP_LABELS_RO + OP_COLORS + OP_ICONS)

grep -c "CERTIFICATE_EXTRACTED\|TRUST_REPORT_GENERATED\|TOKEN_REGENERATED" public/js/admin/audit.js
# Așteptat: 3 (un singur dicționar: AUDIT_EVENT_LABELS)
```

===============================================================================

## Pas 7 — Bump versiune + commit + push

```bash
# Bump package.json: 3.9.491 → 3.9.492
sed -i 's/"version": "3.9.491"/"version": "3.9.492"/' package.json
grep '"version"' package.json
# Așteptat: "version": "3.9.492",

# Bump CACHE_VERSION: docflowai-v206 → docflowai-v207
sed -i "s/CACHE_VERSION = 'docflowai-v206'/CACHE_VERSION = 'docflowai-v207'/" public/sw.js
grep CACHE_VERSION public/sw.js | head -1
# Așteptat: const CACHE_VERSION = 'docflowai-v207';

git add public/js/admin/activity.js public/js/admin/audit.js server/tests/integration/audit-labels-sync.test.mjs package.json public/sw.js
git status
# Așteptat: 5 fișiere modificate, niciun untracked

git commit -m "fix(audit): traduceri CERTIFICATE_EXTRACTED/TRUST_REPORT_GENERATED/TOKEN_REGENERATED în Rapoarte și Log audit + extindere test guard pentru flow_events"
git push origin develop
```

===============================================================================

## RAPORT FINAL

La final, raportează exact:

1. **Linii modificate:**
   - `public/js/admin/activity.js`: +X linii (3 keys × 3 dicționare = 9 keys noi)
   - `public/js/admin/audit.js`: +Y linii
   - `server/tests/integration/audit-labels-sync.test.mjs`: ±Z linii (refactor extractEventTypesFromBackend)
   - `package.json`: 1 linie (version bump)
   - `public/sw.js`: 1 linie (CACHE_VERSION bump)

2. **Rezultat npm test:** verde sau roșu? Câte teste noi adăugate de extinderea regex-ului? (vor apărea ca `it('activity.js are traducere pentru CERTIFICATE_EXTRACTED', ...)` etc.)

3. **Commit SHA:** primele 7 caractere

4. **Push:** confirmare `Everything up-to-date` sau `develop -> develop` plus URL Railway staging deployment dacă apare în output

5. **Smoke test manual recomandat după deploy staging:**
   - Login `app.docflowai.ro` (staging)
   - Tab Rapoarte → confirmă că pentru user-ul `Administrator` din screenshot, badge-urile `CERTIFICATE EXTRACTED` și `TRUST REPORT GENERATED` apar acum ca `Certificat extras` (lavandă, icon 🔎) și `Raport validare generat` (verde, icon 📜)
   - Tab Log audit → caută în filtrul de event type — confirmă că dropdown-ul afișează etichetele RO

===============================================================================

## ⚠️ CONSTRÂNGERI ABSOLUTE — NO-TOUCH

NU modifica niciun fișier din lista de mai jos. Sunt zone STRICT INTERZISE per `CLAUDE.md` (semnătura PAdES STS Cloud QES funcționează în producție; orice modificare poate invalida semnături calificate existente):

```
server/signing/providers/STSCloudProvider.mjs
server/routes/flows/cloud-signing.mjs
server/routes/flows/bulk-signing.mjs
server/signing/pades.mjs
server/signing/java-pades-client.mjs
```

NU atinge nicio configurație de signing, niciun fișier .properties din `docflowai-signing-service`, nici un fișier iText.

NU schimba branch (rămâi pe `develop` tot timpul). NU face merge cu `main`. NU rula `git checkout main` sub nicio formă.

Dacă vreun pas eșuează neașteptat (ex. testul `audit-labels-sync` continuă să fie roșu după modificări), OPREȘTE-TE și raportează diff-ul exact și mesajul de eroare — NU încerca să "repari" prin ștergere de teste sau ajustare de regex.
