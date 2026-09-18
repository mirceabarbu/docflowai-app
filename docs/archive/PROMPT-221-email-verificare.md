---
prompt: 221
titlu: "Emailul de verificare la crearea unui cont — același șablon alb ca emailul cu credențialele (ilizibil în Outlook)"
model_suggested: "Sonnet 5"
efort: low
branch: develop
versiune_curenta: "cea din package.json (v3.9.873 după #220)"
versiune_tinta: "următorul patch după versiunea curentă din package.json"
migratii: NU
scrieri_in_baza: NU
fisiere_din_public: NU  (⇒ FĂRĂ `?v=`, FĂRĂ `CACHE_VERSION`)
zona_no_touch_atinsa: NU
tip: corectură de prezentare (email) + test
---

# ⚠️ BRANCH

**EXCLUSIV `develop`**. Fără `checkout main`, `merge`, `push main`, deploy.
Final: **`git push origin develop`**, apoi **stop** și raportezi.

---

# CONTEXTUL

La crearea unui utilizator nou pleacă două emailuri. Al doilea (credențialele) arată bine. Primul,
**„Verificare adresă email"**, e ilizibil în Outlook (captură de la Mircea, 17.09.2026): benzi negre, text
gri pe fundal închis, linkul de rezervă aproape invizibil.

## Cauza, verificată pe cod

- Credențialele: `emailCredentials` din `server/emailTemplates.mjs` — fundal **alb**, text închis, card cu
  bordură, buton violet.
- Verificarea: HTML **scris inline** în `server/routes/admin/users.mjs` (~318), ruta de creare a
  utilizatorului, cu `background:#0f1731` (albastru-negru), text `#eaf0ff` și gri `#5a6a8a`, link în
  `<code>` gri-albastru. Outlook desktop ignoră parțial `background` pe `<div>` ⇒ textul deschis cade pe
  alb sau pe benzi negre, după element.
- Există deja un șablon alb de verificare, `emailVerifyGws`, dar e pentru fluxul GWS (alt text). Nu îl
  refolosim: textul contului creat de administrator e diferit, iar `emailVerifyGws` e mock-uit în mai
  multe teste.

⛔ Paginile HTML din `server/routes/auth.mjs` (~318–346, răspunsul la click pe link, cu același fundal
închis) sunt **pagini de browser**, nu emailuri — se afișează corect și rămân neatinse.

---

# ETAPA 0 — ancore (READ-ONLY)

```bash
git branch --show-current
grep '"version"' package.json
grep -n "background:#0f1731" server/routes/admin/users.mjs server/emailTemplates.mjs
grep -n "import { emailResetPassword, emailCredentials } from '../../emailTemplates.mjs';" server/routes/admin/users.mjs
grep -n "// ── 6. VERIFICARE EMAIL GWS" server/emailTemplates.mjs
grep -rln "vi.mock(.*emailTemplates" server/tests
```

⭐ Pentru fiecare test care mock-uiește `emailTemplates.mjs`, verifică dacă încarcă (direct sau indirect)
`server/routes/admin/users.mjs`. Un mock fără exportul nou `emailVerifyAccount` ar face importul să cadă.
Raportează lista. Dacă vreunul îl încarcă, adaugă în mock-ul lui
`emailVerifyAccount: vi.fn(() => ({ subject: 's', html: '<p>t</p>' }))` (singura modificare permisă
într-un test existent) și raportează.

---

# ⭐ ETAPA T — testele ÎNTÂI

`server/tests/unit/email-verify-account.test.mjs` (nou):

1. ⭐ `emailVerifyAccount({ verifyUrl, numeUser, expiraOre: 72 })` întoarce `subject` =
   `'✅ Verificare adresă email — DocFlowAI'` (identic cu cel de azi) și un `html` care:
   - conține `background:#ffffff` și **nu** conține `#0f1731`;
   - conține URL-ul de verificare de **cel puțin două ori** (butonul și linkul de rezervă — acesta îl are și ca `href`, și ca text);
   - conține numele utilizatorului;
   - conține `72 de ore`.
2. ⭐ Escaping: `numeUser = '<script>x</script>'` ⇒ `html` nu conține `<script>`; un `verifyUrl` cu `"`
   nu poate închide atributul `href`.
3. `expiraOre` invalid (`0`, `'abc'`, lipsă) ⇒ `72 de ore`.
4. ⭐ Static: `server/routes/admin/users.mjs` **nu** mai conține `#0f1731` și cheamă `emailVerifyAccount(`.

Rulează pe codul nereparat; raportează roșiile (așteptat: toate).

---

# ETAPA A — șablonul

`server/emailTemplates.mjs`, **înainte** de linia `// ── 6. VERIFICARE EMAIL GWS ───…`:

```js
// ── 6b. VERIFICARE EMAIL — cont creat de administrator (#221) ─────────────────
// Același design ca emailCredentials / emailVerifyGws: fundal alb, text închis, buton violet.
// Nu folosi fundaluri închise în emailuri: Outlook desktop ignoră de multe ori `background`
// pe <div>, iar textul deschis/gri devine ilizibil.
export function emailVerifyAccount({ verifyUrl, numeUser, expiraOre = 72 }) {
  const subject = '✅ Verificare adresă email — DocFlowAI';
  const url = esc(verifyUrl);
  const ore = Number.isFinite(+expiraOre) && +expiraOre > 0 ? Math.trunc(+expiraOre) : 72;
  const html = `
<div style="font-family:Arial,sans-serif;max-width:540px;margin:0 auto;background:#ffffff;color:#1a1a1a;padding:32px;border:1px solid #dde4f5;border-radius:10px;">
  <div style="text-align:center;margin-bottom:24px;">
    <strong style="display:inline-block;background:#7c5cff;color:#ffffff;padding:10px 20px;border-radius:6px;font-size:1.05rem;letter-spacing:.3px;">DocFlowAI</strong>
  </div>
  <h2 style="margin:0 0 8px;font-size:1.05rem;color:#1a1a1a;">Bună${numeUser ? ', ' + esc(numeUser) : ''},</h2>
  <p style="margin:0 0 20px;color:#4a5568;line-height:1.6;">Contul tău în <strong style="color:#1a1a1a;">DocFlowAI</strong> a fost creat de un administrator. Pentru a-l activa, verifică adresa de email apăsând butonul de mai jos.</p>
  <div style="text-align:center;margin:0 0 24px;">
    <a href="${url}" style="display:inline-block;background:#7c5cff;color:#ffffff;text-decoration:none;padding:12px 32px;border-radius:6px;font-weight:600;font-size:.95rem;">Verifică adresa de email</a>
  </div>
  <div style="background:#f7f9fc;border:1px solid #dde4f5;border-radius:8px;padding:14px 18px;margin-bottom:20px;">
    <div style="color:#5a6a9a;font-size:.75rem;text-transform:uppercase;letter-spacing:.5px;margin-bottom:6px;">Dacă butonul nu funcționează, copiază linkul în browser</div>
    <a href="${url}" style="color:#3d5299;font-size:.82rem;font-family:monospace;word-break:break-all;text-decoration:underline;">${url}</a>
  </div>
  <p style="color:#5a6a9a;font-size:.85rem;margin:0 0 8px;">Linkul este valabil ${ore} de ore.</p>
  <p style="color:#7a8ab0;font-size:.78rem;margin:0;">Dacă nu te așteptai la acest email, îl poți ignora.</p>
</div>`;
  return { subject, html };
}

```

⚠️ `esc` e helperul local al fișierului (linia ~12). Verifică.

---

# ETAPA B — ruta folosește șablonul

`server/routes/admin/users.mjs`.

**B.1 — importul.** `old_str`:
```js
import { emailResetPassword, emailCredentials } from '../../emailTemplates.mjs';
```
`new_str`:
```js
import { emailResetPassword, emailCredentials, emailVerifyAccount } from '../../emailTemplates.mjs';
```

**B.2 — emailul.** `old_str`:
```js
        subject: '✅ Verificare adresă email — DocFlowAI',
        html: `<div style="font-family:system-ui,sans-serif;max-width:500px;margin:0 auto;background:#0f1731;color:#eaf0ff;border-radius:16px;padding:36px;">
  <h2 style="color:#7c5cff;margin:0 0 16px;">✅ Verificare adresă email</h2>
  <p>Bună <strong>${escHtml(numeComplet)}</strong>,</p>
  <p>Contul tău DocFlowAI a fost creat de un administrator.</p>
  <div style="text-align:center;margin:28px 0;">
    <a href="${verifyLink}" style="background:#7c5cff;color:#fff;padding:14px 32px;border-radius:10px;text-decoration:none;font-weight:700;font-size:1rem;">Verifică adresa email</a>
  </div>
  <p style="font-size:.82rem;color:#5a6a8a;">Sau copiază: <code style="color:#9db0ff;">${verifyLink}</code></p>
  <p style="font-size:.82rem;color:#5a6a8a;">Link expiră în 72h.</p>
</div>`,
```
`new_str`:
```js
        // #221 — același șablon alb ca emailul cu credențiale (emailTemplates.mjs). Varianta
        // inline, pe fundal închis, devenea ilizibilă în Outlook (fundalul div-ului ignorat,
        // textul gri rămânea pe alb sau pe negru, după client).
        ...emailVerifyAccount({ verifyUrl: verifyLink, numeUser: numeComplet, expiraOre: 72 }),
```

⛔ `to: credsDest`, `.catch(...)`, condiția `needsVerification && verificationToken`, construcția
`verifyLink` și restul rutei — neatinse. ⛔ `escHtml` rămâne importat dacă mai e folosit în fișier
(verifică; dacă nu mai e folosit nicăieri, lasă importul și raportează — nu curățăm în acest lot).

---

# ETAPA C — suitele

```bash
npx vitest run server/tests/unit/email-verify-account.test.mjs
npm test
```
`test:db` nu e necesar (fără SQL, fără date). ⛔ Test preexistent care pică ⇒ raportează ÎNAINTE de a-l
atinge (excepție: mock-urile din Etapa 0).

---

# ETAPA D — versiune și commit

```bash
npm version <TINTA> --no-git-tag-version
npm install --package-lock-only
git status --short
```
Zero fișiere din `public/` ⇒ fără `?v=` / `CACHE_VERSION`. `git add` explicit. Arhivează ca
`docs/archive/PROMPT-221-email-verificare.md`.

```
fix(#221): emailul de verificare la crearea contului foloseste sablonul alb — v<TINTA>

Emailul „Verificare adresa email" era HTML scris inline in admin/users.mjs,
pe fundal inchis (#0f1731) cu text deschis si gri. In Outlook fundalul div-ului
era ignorat partial si emailul devenea ilizibil, spre deosebire de emailul cu
credentiale. Nou: emailVerifyAccount in emailTemplates.mjs, acelasi design ca
emailCredentials (alb, card, buton violet), link de rezerva lizibil, subiect
neschimbat.
```

```bash
git push origin develop
```

**Stop.**

---

# RAPORT FINAL
1. Ancore obținute + lista testelor care mock-uiesc `emailTemplates.mjs` și dacă încarcă `admin/users.mjs`.
2. Roșiile pe codul nereparat.
3. Rezultatul testelor noi.
4. Teste preexistente atinse (așteptat: niciunul, eventual mock-uri).
5. `npm test` real.
6. Divergențe și colaterale (ex. alte emailuri inline pe fundal închis găsite prin `grep -rn "background:#0" server --include=*.mjs`) — raportate, nereparate.

# ⛔ CONSTRÂNGERI ABSOLUTE
- `develop` ONLY, apoi stop. Zero migrații, zero scrieri de date, zero fișiere din `public/`.
- Doar prezentarea emailului se schimbă: destinatar, subiect, link, condiții — identice.
- ⛔ Paginile HTML din `auth.mjs` — neatinse.
- `git add` explicit, `old_str` unic sau STOP.
