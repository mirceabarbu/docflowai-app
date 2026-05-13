# 🌐 Traduceri event-uri — audit_log + raport activitate

```
═══════════════════════════════════════════════════════════════════
⚠️  AVERTISMENT BRANCH
═══════════════════════════════════════════════════════════════════
ȚINTĂ: branch `develop` EXCLUSIV.
NU face checkout/merge/push pe `main`.
═══════════════════════════════════════════════════════════════════
```

## CONTEXT

Două pagini admin afișează event-uri din `audit_log`, fiecare cu propriul
dicționar de traduceri (nesincronizate):

1. **Rapoarte** (`/admin#reports`) — folosește `OP_LABELS_RO` din
   `public/js/admin/activity.js`
2. **Log audit** (`/admin#audit`) — folosește `AUDIT_EVENT_LABELS` din
   `public/js/admin/audit.js`

Diagnoză vizuală (Image 1 + Image 2):
- `EMAIL_OPENED` apare **netradus** în Rapoarte
- `entitlement_change` apare **netradus** în Log audit

Audit complet în codebase: **12 event-uri lipsesc din ambele dicționare**,
plus **4 event-uri** au denumiri **inconsistente** între cele două
dicționare (același event scris diferit pe Rapoarte vs Log audit —
confuz pentru utilizator).

## OBIECTIVE

1. Completare exhaustivă AMBELE dicționare cu toate event-urile scrise
   efectiv în `audit_log` (verificat prin grep `eventType: '...'` pe
   tot codul backend)
2. Aliniere denumiri inconsistente — același event = aceeași traducere
3. Convenție clară pentru viitor: ce wording folosim pentru fiecare tip
4. NU refactor (NU extragere SoT comun) — risc inutil de regresie.
   Întreținem 2 dicționare paralele, dar sincronizate manual

## NO-TOUCH

- Logica de query, filter, pagination, render — neatinsă
- Culorile + iconițele evenimentelor din `activity.js` (OP_COLORS,
  OP_ICONS) — neatinse
- Backend (zero modificări — doar dicționarele client-side)
- Tot ce ține de `cloud-signing.mjs`, `pades.mjs`, `OPME`, etc.

## DELIVERABLES

### 1. MODIFICĂ `public/js/admin/activity.js`

Înlocuiește **integral** obiectul `OP_LABELS_RO` (în jurul liniei 12-27)
cu versiunea exhaustivă de mai jos. Păstrează ordinea logică (categorii)
ca să fie ușor de scanat:

```js
const OP_LABELS_RO = {
  // ─── Ciclul de viață al fluxului ──────────────────────────────────
  FLOW_CREATED:                   'Flux inițiat',
  FLOW_COMPLETED:                 'Flux finalizat',
  FLOW_CANCELLED:                 'Flux anulat',
  FLOW_REINITIATED:               'Flux reinițiat după refuz',
  FLOW_REINITIATED_AFTER_REVIEW:  'Flux reinițiat după revizuire',
  REINITIATED_AFTER_REVIEW:       'Reinițiere marcată',

  // ─── Acțiuni semnatari ────────────────────────────────────────────
  SIGNED:                         'Semnat și avansat',
  SIGNED_PDF_UPLOADED:            'PDF semnat încărcat',
  REFUSED:                        'Refuzat',
  REVIEW_REQUESTED:               'Trimis la revizuire',

  // ─── Delegări ─────────────────────────────────────────────────────
  DELEGATE:                       'Delegare semnătură',
  DELEGATED:                      'Delegare semnătură',
  DELEGATION_SET:                 'Delegare configurată',
  DELEGATION_REMOVED:             'Delegare anulată',
  AUTO_DELEGATED_LEAVE:           'Delegare automată (concediu)',

  // ─── Notificări & comunicare ──────────────────────────────────────
  YOUR_TURN:                      'Notificat — e rândul tău',
  EMAIL_SENT:                     'Email extern trimis',
  EMAIL_OPENED:                   'Email deschis',
  PDF_DOWNLOADED:                 'PDF descărcat',
  ATTACHMENT_ADDED:               'Atașament adăugat',

  // ─── Administrare utilizatori & organizații ──────────────────────
  USER_DEACTIVATED:               'Utilizator dezactivat',
  USER_REACTIVATED:               'Utilizator reactivat',
  ORGANIZATION_DELETED:           'Organizație ștearsă',
  ORGANIZATION_REACTIVATED:       'Organizație reactivată',
  ADMIN_SECRET_ACCESS:            'Acces administrator (secrete)',

  // ─── Drepturi & module ───────────────────────────────────────────
  entitlement_change:             'Modificare drepturi modul',

  // ─── Integrări specializate ──────────────────────────────────────
  plata_auto_opme:                'Plată confirmată automat (OPME)',

  // ─── Autentificare ───────────────────────────────────────────────
  'auth.login.success':           'Autentificare reușită',
  'auth.login.failed':            'Autentificare eșuată',
  USER_LOGIN:                     'Autentificare',
  USER_LOGOUT:                    'Deconectare',
};
```

**ATENȚIE la sintaxă**: cheile `entitlement_change`, `plata_auto_opme`,
`auth.login.success`, `auth.login.failed` sunt lowercase (sau conțin
punct) — exact așa se scriu în `audit_log.event_type`. Restul sunt
UPPERCASE_SNAKE. NU schimba case-ul.

Verifică în `OP_COLORS` și `OP_ICONS` (liniile 29-40) dacă există entries
pentru event-urile noi. Dacă lipsesc, adaugă culori neutre + iconițe
sensibile (vezi recomandări mai jos). Dacă nu vrei să-ți complic, las
fără — UI-ul va folosi un default (badge gri, fără icon).

Recomandări iconițe (opțional, dacă ai chef să le adaugi):

```js
const OP_ICONS = {
  // ... existente
  DELEGATION_SET:                 '🔗',
  DELEGATION_REMOVED:             '🔓',
  AUTO_DELEGATED_LEAVE:           '🏖️',
  EMAIL_OPENED:                   '👁️',
  PDF_DOWNLOADED:                 '⬇️',
  ATTACHMENT_ADDED:               '📎',
  USER_DEACTIVATED:               '🚫',
  USER_REACTIVATED:               '✅',
  ORGANIZATION_DELETED:           '🏢',
  ORGANIZATION_REACTIVATED:       '🏢',
  ADMIN_SECRET_ACCESS:            '🔐',
  entitlement_change:             '⚙️',
  plata_auto_opme:                '💰',
  USER_LOGIN:                     '🔑',
  USER_LOGOUT:                    '🚪',
  'auth.login.success':           '🔑',
  'auth.login.failed':            '⛔',
};

const OP_COLORS = {
  // ... existente
  DELEGATION_SET:                 '#9db0ff',
  DELEGATION_REMOVED:             '#888888',
  AUTO_DELEGATED_LEAVE:           '#ffd580',
  EMAIL_OPENED:                   '#7c5cff',
  PDF_DOWNLOADED:                 '#26d07c',
  ATTACHMENT_ADDED:               '#aaa',
  USER_DEACTIVATED:               '#ff5050',
  USER_REACTIVATED:               '#26d07c',
  ORGANIZATION_DELETED:           '#ff5050',
  ORGANIZATION_REACTIVATED:       '#26d07c',
  ADMIN_SECRET_ACCESS:            '#ffd580',
  entitlement_change:             '#7c5cff',
  plata_auto_opme:                '#2dd4bf',
  USER_LOGIN:                     '#26d07c',
  USER_LOGOUT:                    '#888888',
  'auth.login.success':           '#26d07c',
  'auth.login.failed':            '#ff5050',
};
```

### 2. MODIFICĂ `public/js/admin/audit.js`

Înlocuiește **integral** obiectul `AUDIT_EVENT_LABELS` (în jurul liniei
8-31) cu **EXACT același set de traduceri**:

```js
const AUDIT_EVENT_LABELS = {
  // ─── Ciclul de viață al fluxului ──────────────────────────────────
  'FLOW_CREATED':                  'Flux inițiat',
  'FLOW_COMPLETED':                'Flux finalizat',
  'FLOW_CANCELLED':                'Flux anulat',
  'FLOW_REINITIATED':              'Flux reinițiat după refuz',
  'FLOW_REINITIATED_AFTER_REVIEW': 'Flux reinițiat după revizuire',
  'REINITIATED_AFTER_REVIEW':      'Reinițiere marcată',

  // ─── Acțiuni semnatari ────────────────────────────────────────────
  'SIGNED':                        'Semnat și avansat',
  'SIGNED_PDF_UPLOADED':           'PDF semnat încărcat',
  'REFUSED':                       'Refuzat',
  'REVIEW_REQUESTED':              'Trimis la revizuire',

  // ─── Delegări ─────────────────────────────────────────────────────
  'DELEGATE':                      'Delegare semnătură',
  'DELEGATED':                     'Delegare semnătură',
  'DELEGATION_SET':                'Delegare configurată',
  'DELEGATION_REMOVED':            'Delegare anulată',
  'AUTO_DELEGATED_LEAVE':          'Delegare automată (concediu)',

  // ─── Notificări & comunicare ──────────────────────────────────────
  'YOUR_TURN':                     'Notificat — e rândul tău',
  'EMAIL_SENT':                    'Email extern trimis',
  'EMAIL_OPENED':                  'Email deschis',
  'PDF_DOWNLOADED':                'PDF descărcat',
  'ATTACHMENT_ADDED':              'Atașament adăugat',

  // ─── Administrare utilizatori & organizații ──────────────────────
  'USER_DEACTIVATED':              'Utilizator dezactivat',
  'USER_REACTIVATED':              'Utilizator reactivat',
  'ORGANIZATION_DELETED':          'Organizație ștearsă',
  'ORGANIZATION_REACTIVATED':      'Organizație reactivată',
  'ADMIN_SECRET_ACCESS':           'Acces administrator (secrete)',

  // ─── Drepturi & module ───────────────────────────────────────────
  'entitlement_change':            'Modificare drepturi modul',

  // ─── Integrări specializate ──────────────────────────────────────
  'plata_auto_opme':               'Plată confirmată automat (OPME)',

  // ─── Autentificare ───────────────────────────────────────────────
  'auth.login.success':            'Autentificare reușită',
  'auth.login.failed':             'Autentificare eșuată',
  'USER_LOGIN':                    'Autentificare',
  'USER_LOGOUT':                   'Deconectare',
};
```

**Observații**:
- ELIMINATE intenționat din varianta nouă: `FLOW_REFUSED`, `FLOW_DELEGATED`,
  `SIGNER_NOTIFIED`, `ARCHIVE_COMPLETED`, `TRUST_REPORT_GENERATED` — sunt
  „dead labels" (nu se scriu nicăieri în backend). Le scot ca să nu inducă
  în eroare. Dacă vreuna apare totuși vreodată în DB, fallback-ul existent
  `AUDIT_EVENT_LABELS[type] || type` afișează raw — OK.
- Lista de filtre (dropdown „Tip eveniment") va beneficia automat: la
  linia 135 din `audit.js` se folosește același dicționar pentru
  popularea select-ului.

### 3. PROTECȚIE — comentariu pentru viitor

Adaugă la începutul fiecărui dicționar (în AMBELE fișiere), DEASUPRA
obiectului, un comentariu standard:

```js
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Dicționar traduceri event-uri audit_log
// SoT: TREBUIE SĂ FIE IDENTIC între public/js/admin/activity.js și
//      public/js/admin/audit.js. Sincronizează MANUAL la fiecare modif.
// Sursa event-urilor: server/ — `grep -rhn "eventType: '" --include="*.mjs"`
// La adăugarea unui event type nou în backend, COMPLETEAZĂ AMBELE
// dicționare — altfel apare neredus în UI ca tag raw.
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```

### 4. (Opțional, dar recomandat) Test guard

Adaugă un test integration care prinde event-uri nou-introduse fără
traducere. În `server/tests/integration/audit-labels-sync.test.mjs`:

```js
// audit-labels-sync.test.mjs
//
// Test guard: orice event_type scris în audit_log via writeAuditEvent
// trebuie să aibă traducere în AMBELE dicționare client (activity.js +
// audit.js). Previne regresia "tag raw în UI" la adăugarea unui event
// type nou în backend fără update la client.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { glob } from 'glob';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, '../../..');

function extractEventTypesFromBackend() {
  const files = glob.sync('server/**/*.mjs', { cwd: REPO, absolute: true });
  const types = new Set();
  const re = /eventType:\s*'([A-Za-z_.]+)'/g;
  for (const f of files) {
    const s = readFileSync(f, 'utf8');
    let m;
    while ((m = re.exec(s)) !== null) types.add(m[1]);
  }
  // Adaugă manual cele scrise direct cu raw SQL (rar, dar există)
  types.add('plata_auto_opme');
  types.add('entitlement_change');
  return types;
}

function extractLabelsFromClient(relPath) {
  const content = readFileSync(path.join(REPO, relPath), 'utf8');
  const re = /['"]?([A-Za-z_][A-Za-z_.0-9]*)['"]?\s*:\s*['"][^'"]+['"]/g;
  const labels = new Set();
  let m;
  while ((m = re.exec(content)) !== null) labels.add(m[1]);
  return labels;
}

describe('audit labels sync', () => {
  const backendTypes = extractEventTypesFromBackend();
  const activityLabels = extractLabelsFromClient(
    'public/js/admin/activity.js'
  );
  const auditLabels = extractLabelsFromClient(
    'public/js/admin/audit.js'
  );

  for (const type of backendTypes) {
    it(`activity.js are traducere pentru ${type}`, () => {
      expect(activityLabels.has(type),
        `Lipsește în public/js/admin/activity.js > OP_LABELS_RO`
      ).toBe(true);
    });
    it(`audit.js are traducere pentru ${type}`, () => {
      expect(auditLabels.has(type),
        `Lipsește în public/js/admin/audit.js > AUDIT_EVENT_LABELS`
      ).toBe(true);
    });
  }
});
```

Testul rulează în CI și prinde regresia: dacă cineva adaugă un
`eventType: 'NOU'` în backend dar uită să-l completeze în client →
test roșu → corectează înainte de PR.

ATENȚIE: testul folosește extragere prin regex. Dacă acel regex prinde
și keys care nu sunt event types (ex. opțiuni de config), filtrează-le
explicit. Pentru iterația 1, e ok să fie *un pic* permisiv — important
e să prindă lipsurile reale, nu să fie matematic perfect.

### 5. Bump version + sw cache

`package.json` patch bump + `public/sw.js` `CACHE_VERSION` bump.

## ACCEPTANCE

- `npm test` verde — toate testele anterioare trec + testul nou
  `audit-labels-sync` (dacă-l adaugi)
- Manual pe staging după deploy:
  - Pagina **Rapoarte** → toate tag-urile evenimentelor sunt în
    română (NU mai apare `EMAIL_OPENED`, ci „Email deschis")
  - Pagina **Log audit** → toate tag-urile sunt în română
    (NU mai apare `entitlement_change`, ci „Modificare drepturi modul")
  - Dropdown-ul „Tip eveniment" din Log audit afișează DOAR traduceri
    în română, NU coduri raw
  - Wording-ul e CONSISTENT între cele 2 pagini pentru același event
    (ex. `SIGNED` zice „Semnat și avansat" peste tot, nu „Semnat" pe
    una și „Semnat și avansat" pe alta)

## COMMIT

Pe `develop`:

```
fix(i18n): traduceri exhaustive audit + rapoarte + test guard

- Completate dicționarele OP_LABELS_RO (activity.js) și AUDIT_EVENT_LABELS
  (audit.js) cu toate event_type-urile scrise în audit_log
- 12 event-uri lipsă acum traduse: EMAIL_OPENED, entitlement_change,
  DELEGATION_SET, DELEGATION_REMOVED, AUTO_DELEGATED_LEAVE,
  USER_DEACTIVATED, USER_REACTIVATED, ORGANIZATION_DELETED,
  ORGANIZATION_REACTIVATED, ADMIN_SECRET_ACCESS, plata_auto_opme,
  ATTACHMENT_ADDED + PDF_DOWNLOADED (activity)
- 4 aliniate inconsistent: SIGNED, EMAIL_SENT, SIGNED_PDF_UPLOADED,
  REVIEW_REQUESTED — wording acum identic pe ambele pagini
- 5 "dead labels" eliminate din audit.js (nu se scriu în backend)
- Test integration audit-labels-sync.test.mjs prinde regresia viitoare
- Comentariu standard în ambele fișiere reaminteste sincronizarea manuală

Cauza identificată: 2 dicționare paralele nesincronizate. Refactor SoT
(extragere în fișier comun) AMÂNAT — risc regresie inutil. Test guard
oferă protecția necesară.
```

Bump version + sw cache.

---

## 📌 Note pentru viitor

**De ce NU refactor SoT (sursă unică)?** Pentru că ambele fișiere sunt
client-side legacy `(function(){...})()` și extragerea într-un fișier
comun cere modificări la script-loading order, sw.js cache, și script
tags în admin.html. Risc-reward nefavorabil când testul guard face
aceeași treabă cu zero schimbări de arhitectură.

**Când se va impune refactor:** dacă apar 3+ pagini diferite care
afișează aceleași event-uri. Atunci extragere în `public/js/common/event-labels.js`
+ import via `<script defer>` în toate paginile.
