---
prompt: 180
titlu: "Expeditorul emailului extern poartă numele instituției, nu al platformei"
model_suggested: "Sonnet 5, efort high"
branch: develop
versiune_curenta: v3.9.834
versiune_tinta: v3.9.835
migratii: NU
fisiere_din_public: NU   (⇒ FĂRĂ bump `?v=`, FĂRĂ `CACHE_VERSION`)
zona_no_touch_atinsa: NU
---

# ⚠️ BRANCH

Lucrezi **EXCLUSIV pe `develop`**. `main` = PRODUCȚIE, gestionat manual de Mircea.
Pasul final obligatoriu: `git push origin develop`.

---

## Context

Când un utilizator trimite documentul semnat în exterior (modalul de transmitere,
`POST` din `server/routes/flows/email.mjs`), destinatarul vede ca expeditor
**`DocFlowAI <noreply@docflowai.ro>`**. Destinatarii externi — furnizori, alte instituții — nu
cunosc platforma, iar mailul pare să vină de la un terț necunoscut.

Modelul cerut de Mircea (exemplu real primit de la Județul Brașov):
`Județul Brașov <noreply@conectx.net>` — **adresa rămâne a platformei, se schimbă doar numele
afișat.**

Rezultatul aici: **`Primaria Zarnesti <noreply@docflowai.ro>`**.

## Decizia (Mircea, 04.09.2026)

> Numele afișat vine din **`organizations.name`**, atât. Doar emailul **extern** din modalul de
> transmitere. Nu se atinge nimic altceva.

---

## Fapte VERIFICATE pe codul v3.9.834 și pe producție

- Coloana e **`organizations.name`** (NU `nume` — interogarea cu `nume` eșuează). Valoarea în
  producție: `'Primaria Zarnesti'`, **fără diacritice** ⇒ nicio problemă de codificare RFC 2047
  în antet. Dacă Mircea schimbă cândva denumirea în „Primăria Orașului Zărnești", se schimbă
  singură — ⛔ **nimic hardcodat**.
- `MAIL_FROM` e citit independent în **patru** locuri (`mailer.mjs:4`, `index.mjs:1787`,
  `email.mjs:108`, `admin/outreach.mjs:33`). ⛔ Lotul atinge **DOAR** `email.mjs`. Celelalte trei
  rămân exact cum sunt — notificările interne către semnatari nu se schimbă.
- Ruta are deja `data.orgId` (blobul fluxului) și `actor.org_id`. **Ancora corectă e
  `data.orgId`** — documentul aparține instituției fluxului, nu neapărat org-ului actorului
  (un `admin` global poate trimite pentru altă instituție).
- Ruta NU are azi organizația încărcată ⇒ e nevoie de **un singur `SELECT` pe cheie primară**,
  o dată per cerere (nu per destinatar — bucla de la `:174` iterează până la 20 de destinatari).
- `actor.institutie` EXISTĂ (text liber, per utilizator, încărcat de `session-guard.mjs:101`) și
  e deja folosit la `:91` pentru semnătura din corpul mailului. ⛔ **NU-l folosi ca expeditor** —
  e per-utilizator și poate fi gol sau scris diferit de la om la om. Sursa cerută e
  `organizations.name`.

---

## ⚠️ Riscul de securitate care decide forma implementării

Numele organizației e **editabil din interfața de admin** și ajunge într-un **antet de email**.
Un nume care conține `\r`, `\n`, `"`, `<`, `>`, `,` sau `;` poate rupe antetul `From` sau injecta
antete suplimentare (email header injection). Azi nu e cazul, dar câmpul e editabil, deci
curățarea nu e opțională.

Regula: se păstrează literele, cifrele, spațiile, cratimele, punctele și apostrofurile; restul se
elimină; se normalizează spațiile; se taie la 78 de caractere. Dacă rezultatul e gol ⇒ se cade pe
`MAIL_FROM` neschimbat.

---

## ⛔ Ce NU se atinge

- **NU** modifica `server/mailer.mjs`, `server/index.mjs`, `server/routes/admin/outreach.mjs`.
- **NU** schimba adresa de email — doar partea de nume afișat.
- **NU** atinge corpul mailului (`emailSendExtern`), tracking-ul, atașamentele, `replyTo`.
- **NU** atinge autorizarea rutei (`canActorReadFlow`) și nici `senderName`/`senderTitle` de la
  `:90-91`.
- **NU** folosi `actor.institutie`.
- Zero migrații, zero fișiere din `public/`.

---

## ETAPA 0 — ancore (READ-ONLY)

```bash
cd "$(git rev-parse --show-toplevel)"
git branch --show-current                                   # Așteptat: develop
node -e "console.log(require('./package.json').version)"     # Așteptat: 3.9.834

grep -n "const MAIL_FROM" server/routes/flows/email.mjs      # Așteptat: 1 (:108)
grep -c "from: MAIL_FROM" server/routes/flows/email.mjs      # Așteptat: 1
grep -rn "organizations" server/routes/flows/email.mjs       # Așteptat: 0 (nu e încărcată azi)
ls server/services/mail-from.mjs 2>/dev/null                 # Așteptat: „No such file"

# ⭐ Confirmă numele coloanei pe schema reală, nu pe cuvântul meu:
grep -n "CREATE TABLE IF NOT EXISTS organizations" -A 12 server/db/index.mjs
```

Dacă coloana nu e `name`, **OPREȘTE-TE și raportează**.

---

## ETAPA A — modul PUR nou, ZERO consumatori

Creează `server/services/mail-from.mjs`:

```js
/**
 * DocFlowAI — mail-from.mjs  (#180)
 * -------------------------------------------------------------------------
 * Compune antetul `From` al emailurilor EXTERNE: numele instituției +
 * adresa platformei. Destinatarii externi nu cunosc platforma, iar un mail
 * de la „DocFlowAI" pare să vină de la un terț necunoscut.
 *
 * ⛔ Adresa NU se schimbă — Resend semnează DKIM pe domeniul din adresă.
 *    Se schimbă doar numele afișat, care nu intră în semnătură.
 * ⛔ Numele organizației e editabil din admin și ajunge într-un ANTET.
 *    `curataNumeExpeditor` există ca un nume cu CRLF sau ghilimele să nu
 *    poată rupe antetul ori injecta altele (email header injection).
 * ⛔ Zero acces la baza de date aici — funcții pure. Interogarea rămâne în rută.
 */

/** Extrage adresa dintr-un MAIL_FROM de forma `Nume <a@b.c>` sau `a@b.c`. */
export function adresaDin(mailFrom) {
  const s = String(mailFrom || '').trim();
  const m = s.match(/<([^>]+)>/);
  const adresa = (m ? m[1] : s).trim();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(adresa) ? adresa : '';
}

/** Curăță un nume pentru antetul From. Întoarce '' dacă nu rămâne nimic utilizabil. */
export function curataNumeExpeditor(nume) {
  return String(nume || '')
    .replace(/[\r\n]+/g, ' ')          // CRLF = vectorul de injecție de antete
    .replace(/["<>,;:\\]/g, '')        // caractere cu înțeles în gramatica antetului
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 78);
}

/**
 * @param {string} numeOrg   — `organizations.name`
 * @param {string} mailFrom  — valoarea configurată (env sau implicit)
 * @returns {string} antetul `From`. Cade pe `mailFrom` neschimbat dacă numele
 *          e gol după curățare sau dacă adresa nu poate fi extrasă.
 */
export function expeditorExtern(numeOrg, mailFrom) {
  const adresa = adresaDin(mailFrom);
  const nume = curataNumeExpeditor(numeOrg);
  if (!adresa || !nume) return String(mailFrom || '');
  return `${nume} <${adresa}>`;
}
```

### Test unitar — `server/tests/unit/mail-from.test.mjs`

1. `expeditorExtern('Primaria Zarnesti', 'DocFlowAI <noreply@docflowai.ro>')` →
   `'Primaria Zarnesti <noreply@docflowai.ro>'`.
2. `MAIL_FROM` fără paranteze unghiulare (`'noreply@docflowai.ro'`) ⇒ tot se compune corect.
3. ⭐ **Injecție de antet**: nume care conține `\r\n` sau `\nBcc: x@y.z` ⇒ rezultatul e pe o
   SINGURĂ linie și nu conține `\r`, `\n` sau `Bcc:` ca antet. Verifică explicit absența
   caracterelor de linie nouă în ieșire.
4. Nume cu `"`, `<`, `>`, `,`, `;` ⇒ eliminate; rezultatul rămâne un antet valid.
5. Nume gol / `null` / doar spații ⇒ se întoarce `mailFrom` NESCHIMBAT (nu `'undefined <...>'`).
6. `MAIL_FROM` invalid (fără `@`) ⇒ se întoarce ce s-a primit, fără să arunce.
7. Nume peste 78 de caractere ⇒ tăiat la 78.
8. Nume cu diacritice („Primăria Orașului Zărnești") ⇒ păstrate intacte (nu se elimină,
   nu se transliterează). E cazul viitor, când Mircea schimbă denumirea.

**Poartă de Etapă A:**
```bash
grep -rn "mail-from" server --include=*.mjs | grep -v "server/tests/" | grep -v "server/services/mail-from.mjs"
# Așteptat: 0 linii
npx vitest run server/tests/unit/mail-from.test.mjs
```

---

## ETAPA B — cablarea în ruta externă

În `server/routes/flows/email.mjs`:

### B.1 — importul

Adaugă lângă importurile existente ale rutei (păstrează stilul din fișier):
```js
import { expeditorExtern } from '../../services/mail-from.mjs';
```

### B.2 — încărcarea numelui, O SINGURĂ dată per cerere

`old_str`
```js
    const RESEND_API_KEY = process.env.RESEND_API_KEY;
    const MAIL_FROM = process.env.MAIL_FROM || 'DocFlowAI <noreply@docflowai.ro>';
    if (!RESEND_API_KEY) return res.status(503).json({ error: 'mail_not_configured', message: 'Email-ul nu este configurat pe server.' });
```

`new_str`
```js
    const RESEND_API_KEY = process.env.RESEND_API_KEY;
    const MAIL_FROM = process.env.MAIL_FROM || 'DocFlowAI <noreply@docflowai.ro>';
    if (!RESEND_API_KEY) return res.status(503).json({ error: 'mail_not_configured', message: 'Email-ul nu este configurat pe server.' });

    // #180 — expeditorul poartă numele INSTITUȚIEI, nu al platformei. Destinatarii externi
    // nu cunosc platforma; un mail de la „DocFlowAI" pare de la un terț necunoscut.
    // Adresa rămâne neschimbată (DKIM se semnează pe domeniul ei) — se schimbă doar numele
    // afișat. Ancora e `data.orgId`, nu `actor.org_id`: documentul aparține instituției
    // fluxului, iar un admin global poate trimite pentru altă instituție.
    // O singură interogare pe cheie primară, ÎNAINTE de bucla pe destinatari (până la 20).
    // Orice eșec e non-fatal: se cade pe MAIL_FROM, adică pe comportamentul de dinainte.
    let _fromExtern = MAIL_FROM;
    try {
      if (data.orgId) {
        const { rows: _org } = await pool.query('SELECT name FROM organizations WHERE id = $1', [data.orgId]);
        _fromExtern = expeditorExtern(_org[0]?.name, MAIL_FROM);
      }
    } catch (e) {
      logger.warn({ err: e, flowId }, 'send-email: nu am putut citi numele instituției; folosesc expeditorul implicit');
    }
```

⚠️ Verifică numele importului pentru pool în acest fișier (`pool`, `db`, altceva) și folosește-l
pe cel real. Dacă fișierul nu are acces la `pool`, **OPREȘTE-TE și raportează** — nu introduce un
import nou fără să spui.

### B.3 — antetul

`old_str`
```js
      const payload = { from: MAIL_FROM, to: recipient, subject: subject.trim(), html: htmlWithTracking };
```

`new_str`
```js
      const payload = { from: _fromExtern, to: recipient, subject: subject.trim(), html: htmlWithTracking };
```

---

## ETAPA C — teste de integrare

Fișier NOU: `server/tests/db/email-expeditor-institutie.test.mjs` (sau `integration/`, după
tiparul existent pentru rutele cu `pool` mock-uit — alege modelul folosit de testele existente
pe `flows/email.mjs`, dacă există; raportează ce ai ales).

1. ⭐ Trimitere externă pe un flux al unei organizații cu `name = 'Primaria Zarnesti'` ⇒
   payload-ul către Resend are `from === 'Primaria Zarnesti <noreply@docflowai.ro>'`.
2. ⭐ **Non-regresie**: organizație fără nume (`NULL` sau `''`) ⇒ `from === MAIL_FROM`, exact ca
   înainte. Trimiterea NU eșuează.
3. ⭐ **O singură interogare** pentru numele instituției, chiar și cu 3 destinatari — nu una per
   destinatar. (Numără apelurile pe `pool.query` cu `SELECT name FROM organizations`.)
4. Flux fără `orgId` ⇒ `from === MAIL_FROM`, fără interogare, fără eroare.
5. Eșec la interogare ⇒ `from === MAIL_FROM`, cererea reușește (non-fatal).
6. **Ancora e `data.orgId`**: actor dintr-o organizație, flux din alta ⇒ numele folosit e al
   organizației FLUXULUI.
7. **Non-regresie pe celelalte căi**: `mailer.mjs`, `index.mjs` și `admin/outreach.mjs` nu conțin
   `expeditorExtern` (analiză statică) — notificările interne rămân neatinse.

```bash
node --check server/services/mail-from.mjs
node --check server/routes/flows/email.mjs
npx vitest run server/tests/unit/mail-from.test.mjs
npm test
npm run test:db
```

⚠️ `server/tests/db/flow-received-ack.test.mjs > (4)` e instabil în suita completă. Dacă pică
doar el, raportează-l ca preexistent și NU-l repara. Dacă pică altceva, oprește-te.
⚠️ Rulează suita `test:db` **până la capăt** înainte de push. Dacă nu apuci, spune-o explicit în
raport — la #179 s-a împins cu 10 fișiere din 129 rulate.

---

## ETAPA D — versiune și commit

1. `package.json`: `3.9.834` → `3.9.835`.
2. `package-lock.json` în ACELAȘI commit (`npm install --package-lock-only`), apoi:
```bash
node -e "const p=require('./package.json'),l=require('./package-lock.json');if(p.version!==l.version||l.packages[''].version!==p.version)throw new Error('lockfile desincronizat: '+l.version);console.log('lock OK',l.version)"
git diff --stat -- package-lock.json
```
   ⚠️ Diff-ul trebuie să aibă **cel mult 4 linii**. Mai mult ⇒ oprește-te și raportează.
3. Zero fișiere din `public/` ⇒ FĂRĂ `?v=`, FĂRĂ `CACHE_VERSION`.
   ⚠️ **Verifică singur** că e adevărat (`git status --short`), nu pe cuvântul meu — la #179
   afirmasem greșit că niciun fișier atins nu e în `PRECACHE_ASSETS`.
4. `git add` explicit. **Niciodată `git add -A`.**
5. Commit:
   ```
   feat(#180): expeditorul emailului extern poarta numele institutiei — v3.9.835

   Destinatarii externi vedeau „DocFlowAI <noreply@docflowai.ro>" si nu
   cunosc platforma. Numele afisat vine acum din organizations.name, ancorat
   pe orgId-ul FLUXULUI; adresa ramane neschimbata (DKIM se semneaza pe
   domeniul ei). Numele e curatat inainte de a intra in antet — campul e
   editabil din admin, iar CRLF sau ghilimelele ar permite injectie de
   antete. Orice esec cade pe MAIL_FROM, adica pe comportamentul anterior.
   Atinge DOAR trimiterea externa; notificarile interne raman neschimbate.
   ```
6. `git push origin develop`

---

## RAPORT FINAL — obligatoriu

1. Ancorele din Etapa 0, cu valorile OBȚINUTE, inclusiv numele real al coloanei din schemă.
2. Cum se numește obiectul de acces la baza de date în `email.mjs` și cum l-ai folosit.
3. Rezultatul fiecărui caz din Etapele A și C, cu accent pe injecția de antet (A3) și pe
   numărul de interogări (C3).
4. Ce model de test ai ales pentru Etapa C și de ce.
5. Numerele reale `npm test` / `npm run test:db`; **dacă `test:db` a rulat COMPLET** sau nu.
6. Rezultatul verificării lockfile-ului (`lock OK` + numărul de linii din diff).
7. Teste preexistente atinse. (Așteptat: NICIUNUL. Dacă pică vreunul, oprește-te și raportează
   ÎNAINTE de a-l modifica.)
8. Divergențe prompt↔cod — raportate, NU reparate tăcut.
9. Constatări colaterale — consemnate, nereparate.

---

## ⛔ CONSTRÂNGERI ABSOLUTE

- `develop` ONLY. Zero migrații, zero `public/`.
- `mailer.mjs`, `index.mjs`, `admin/outreach.mjs` NEATINSE.
- Adresa de email NESCHIMBATĂ — doar numele afișat.
- Orice eșec cade pe `MAIL_FROM` (comportamentul de dinainte), niciodată pe eroare la trimitere.
- `git add` explicit.
- `old_str` care nu se potrivește exact ⇒ **OPREȘTE-TE și raportează**.
