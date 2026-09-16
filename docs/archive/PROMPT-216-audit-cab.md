---
prompt: 216
titlu: "Audit document DF/ORD — vizibil și compartimentului CAB al organizației (poartă + capabilitate din server)"
model_suggested: "Sonnet 5"
efort: medium
branch: develop
versiune_curenta: "cea din package.json"
versiune_tinta: "următorul patch după versiunea curentă din package.json"
migratii: NU
scrieri_in_baza: NU
fisiere_din_public: DA — `js/formular/list.js` ⇒ `?v=` ȚINTIT, `CACHE_VERSION` doar dacă e în PRECACHE
zona_no_touch_atinsa: NU
tip: extindere de acces (cerută de Mircea) + consolidare a deciziei pe server
---

# ⚠️ BRANCH

**EXCLUSIV `develop`**. Fără `checkout main`, `merge`, `push main`, deploy.
Final: **`git push origin develop`**, apoi **stop** și raportezi.

---

# CONTEXTUL

Cererea lui Mircea: butonul **„Audit document"** din listele DF și ORD (tab-urile „Document de
Fundamentare" și „Ordonanțare de Plată") să fie **vizibil și utilizabil de compartimentul CAB**.
Azi e doar pentru `admin` / `org_admin`.

Starea, verificată pe cod:

- **Butonul** e decis în browser: `public/js/formular/list.js:~935`
  `const isAdm=window.ST?.user?.role==='admin'||…==='org_admin'`.
- **Ruta** `GET /api/formulare-audit/:type/:id` (`routes/formulare/shared.mjs:~909`) are
  `if (!isAdminOrOrgAdmin(actor)) 403`, apoi după încărcarea documentului
  `if (actor.role === 'org_admin' && doc.org_id !== actor.orgId) 403`.
- **Lista** `GET /api/formulare/list` încarcă deja `loadActorCompAndCab` pentru non-admini și
  folosește `isCabDept` ca să le dea CAB-ului vizibilitatea pe tot org-ul.

⭐ Aceeași clasă cu #210/#211: o decizie de acces scrisă de mână în două locuri (rol în browser, rol pe
server). Lotul pune decizia într-o **singură funcție pură**, folosită de poarta rutei **și** de un câmp
`can_audit` pe rândurile listei. Butonul citește câmpul, nu rolul.

## Regula

`canViewFormularAudit(actor, { actorComp, cabComp, docOrgId })`:
- `admin` ⇒ `true` (ca azi — vede orice organizație);
- document din altă organizație ⇒ `false`;
- `org_admin` ⇒ `true`;
- altfel ⇒ `isCabDept(actorComp, cabComp)`.

`docOrgId` absent ⇒ tratat ca aceeași organizație (folosire în listă, unde rândurile sunt deja scopate
pe org pentru non-platform).

---

# ETAPA 0 — ancore (READ-ONLY)

```bash
git branch --show-current
grep -n "router.get('/api/formulare-audit/:type/:id'" -A4 server/routes/formulare/shared.mjs
grep -n "Scoping org_admin" -A2 server/routes/formulare/shared.mjs
grep -n "lstActorComp" server/routes/formulare/shared.mjs
grep -n "narrowCanDeleteRows(rows" server/routes/formulare/shared.mjs
grep -n "export function isCabDept\|export async function loadActorCompAndCab" server/services/authz-formular.mjs
grep -n "isAdm" public/js/formular/list.js
grep -n "js/formular/list.js" public/*.html public/sw.js
grep -rn "formulare-audit" server/tests --include=*.mjs | head
# Cunoscute: integration/formulare-audit.test.mjs (mock pe pool.query prin substring SQL:
# „403 user normal", „403 org_admin alt org", „200 admin", CSV), db/tenant-isolation test 10.
```

⭐ `integration/formulare-audit.test.mjs` „403 — user normal" nu mock-uiește interogarea de
compartiment. Cu patch-ul, ruta o cheamă pentru non-admini. **Căutarea eșuată trebuie să dea 403
(fail-closed), nu 500** — de aceea e în `try/catch` în Etapa B. Verifică ce întoarce `mockBySql`
pentru un SQL nemapat și raportează.

---

# ETAPA A — funcția unică

`server/services/authz-formular.mjs`, imediat după `export function isCabDept(actorComp, cabComp) { … }`:

```js

/**
 * #216 — Cine poate vedea jurnalul de audit al unui DF/ORD.
 * SURSA UNICĂ pentru poarta `GET /api/formulare-audit/:type/:id` ȘI pentru câmpul `can_audit`
 * din `GET /api/formulare/list` (butonul „Audit document"). Nu duplica regula în browser.
 *
 *   admin      ⇒ orice organizație (comportamentul dinainte)
 *   alt org    ⇒ nu
 *   org_admin  ⇒ da
 *   altfel     ⇒ membru al compartimentului CAB al organizației
 *
 * `docOrgId` absent ⇒ aceeași organizație (listele sunt deja scopate pe org).
 */
export function canViewFormularAudit(actor, { actorComp = '', cabComp = '', docOrgId = null } = {}) {
  if (!actor) return false;
  if (actor.role === 'admin') return true;
  if (docOrgId != null && String(docOrgId) !== String(actor.orgId)) return false;
  if (actor.role === 'org_admin') return true;
  return isCabDept(actorComp, cabComp);
}
```

---

# ETAPA B — poarta rutei

`server/routes/formulare/shared.mjs`.

**B.1 — importul.** `old_str`:
```js
import { loadActorCompAndCab, isCabDept, canEditFormular, canViewFormular } from '../../services/authz-formular.mjs';
```
`new_str`:
```js
import { loadActorCompAndCab, isCabDept, canEditFormular, canViewFormular, canViewFormularAudit } from '../../services/authz-formular.mjs';
```

**B.2 — poarta de intrare.** `old_str`:
```js
  const actor = requireAuth(req, res); if (!actor) return;
  if (!isAdminOrOrgAdmin(actor)) return res.status(403).json({ error: 'forbidden' });

  const type = String(req.params.type || '').toLowerCase();
```
`new_str`:
```js
  const actor = requireAuth(req, res); if (!actor) return;
  // #216 — auditul e vizibil și compartimentului CAB. Decizia: canViewFormularAudit (sursa unică,
  // aceeași ca `can_audit` din listă). Non-adminii sunt refuzați ÎNAINTE de a căuta documentul,
  // ca un id inexistent să nu se distingă de unul interzis. Căutare eșuată ⇒ 403 (fail-closed).
  let auditComps = { actorComp: '', cabComp: '' };
  if (!isAdminOrOrgAdmin(actor)) {
    try {
      const c = await loadActorCompAndCab(pool, actor.userId, actor.orgId);
      auditComps = { actorComp: c?.actorComp || '', cabComp: c?.cabComp || '' };
    } catch (e) {
      logger.warn({ err: e, userId: actor.userId }, 'formulare-audit: compartimentul nu a putut fi citit — refuz');
      return res.status(403).json({ error: 'forbidden' });
    }
    if (!canViewFormularAudit(actor, auditComps)) return res.status(403).json({ error: 'forbidden' });
  }

  const type = String(req.params.type || '').toLowerCase();
```

**B.3 — scoparea pe organizație.** `old_str`:
```js
    // Scoping org_admin: vede doar org-ul propriu
    if (actor.role === 'org_admin' && doc.org_id !== actor.orgId)
      return res.status(403).json({ error: 'forbidden' });
```
`new_str`:
```js
    // Scoping pe organizație (org_admin și CAB) — #216: aceeași funcție ca poarta de mai sus.
    if (!canViewFormularAudit(actor, { ...auditComps, docOrgId: doc.org_id }))
      return res.status(403).json({ error: 'forbidden' });
```

⚠️ Verifică forma întoarsă de `loadActorCompAndCab` (chei `actorComp`, `cabComp`) și raportează.

---

# ETAPA C — `can_audit` în listă

`server/routes/formulare/shared.mjs`, `GET /api/formulare/list`.

**C.1** — `old_str`:
```js
  let lstActorComp = '';
```
`new_str`:
```js
  let lstActorComp = '';
  let lstCabComp = '';   // #216 — pentru `can_audit`
```

**C.2** — `old_str`:
```js
          lstActorComp = actorComp;   // #143b — înainte de orice return timpuriu pe ramura CAB
```
`new_str`:
```js
          lstActorComp = actorComp;   // #143b — înainte de orice return timpuriu pe ramura CAB
          lstCabComp = cabComp;       // #216
```

**C.3** — `old_str`:
```js
          lstActorComp = actorComp;   // #143b — vezi comentariul din ramura DF
```
`new_str`:
```js
          lstActorComp = actorComp;   // #143b — vezi comentariul din ramura DF
          lstCabComp = cabComp;       // #216
```

**C.4 — ramura DF.** `old_str`:
```js
        ORDER BY fd.updated_at DESC
        LIMIT $${limIdx} OFFSET $${offIdx}`;

      const { rows } = await pool.query(sql, params);
      narrowCanDeleteRows(rows, { isOrgManager, actorComp: lstActorComp });
```
`new_str`:
```js
        ORDER BY fd.updated_at DESC
        LIMIT $${limIdx} OFFSET $${offIdx}`;

      const { rows } = await pool.query(sql, params);
      narrowCanDeleteRows(rows, { isOrgManager, actorComp: lstActorComp });
      // #216 — butonul „Audit document": aceeași decizie ca poarta rutei de audit.
      { const _ca = canViewFormularAudit(actor, { actorComp: lstActorComp, cabComp: lstCabComp });
        for (const r of rows) r.can_audit = _ca; }
```

**C.5 — ramura ORD.** Identic, cu `ORDER BY fo.updated_at DESC` în `old_str`/`new_str`.

⛔ Nicio interogare nouă în listă: `loadActorCompAndCab` e deja chemat o dată, pe ramura non-admin.

---

# ETAPA D — butonul citește câmpul

`public/js/formular/list.js`. `old_str`:
```js
    const isAdm=window.ST?.user?.role==='admin'||window.ST?.user?.role==='org_admin';
    const auditBtn=isAdm
```
`new_str`:
```js
    // #216 — vizibilitatea vine de la server (`can_audit`, aceeași funcție ca poarta rutei).
    const auditBtn=row.can_audit===true
```
⚠️ Confirmă că `isAdm` nu mai e folosit altundeva în funcție (Etapa 0).

---

# ETAPA E — teste

## E.1 — unit: `server/tests/unit/can-view-formular-audit.test.mjs` (nou)
Tabel de adevăr: admin (org diferit ⇒ true), org_admin (același org ⇒ true, alt org ⇒ false),
user CAB (același org ⇒ true, alt org ⇒ false), user non-CAB ⇒ false, user fără compartiment și
`cabComp` gol ⇒ false, `actor` null ⇒ false, `docOrgId` absent pentru CAB ⇒ true.

## E.2 — db: `server/tests/db/formulare-audit-cab.test.mjs` (nou)
Organizație cu `cab_compartiment`, un user CAB, un user non-CAB, o a doua organizație cu propriul DF.
1. ⭐ CAB ⇒ `GET /api/formulare-audit/df/:id` pe DF din org proprie ⇒ **200**; la fel pentru ORD.
2. ⭐ CAB ⇒ DF din **altă** organizație ⇒ **403**.
3. Non-CAB ⇒ 403 (neregresie).
4. ⭐ Paritate: `GET /api/formulare/list?type=df` și `?type=ord` ⇒ rândurile au `can_audit=true`
   pentru CAB, `false` pentru non-CAB — **și pentru fiecare rând, rezultatul rutei de audit coincide
   cu `can_audit`** (200 ⇔ true, 403 ⇔ false).
5. org_admin ⇒ `can_audit=true` și 200 (neregresie).

## E.3 — rulare
Testele noi **întâi pe codul nereparat**: raportează roșiile (așteptat: E.1 integral — funcția nu
există; E.2: 1, 4 pentru CAB). Apoi:
```bash
npm test
npm run test:db
```
Secvențial, verdict din output real. ⛔ Test preexistent care pică ⇒ raportează ÎNAINTE de a-l atinge.
Neregresie citată: `integration/formulare-audit.test.mjs` (toate), `db/tenant-isolation` testul 10.

---

# ETAPA F — versiune, cache, commit

```bash
npm version <TINTA> --no-git-tag-version
npm install --package-lock-only
grep -n "js/formular/list.js?v=" public/formular.html
NEW=<TINTA>
sed -i -E "s#(js/formular/list\.js\?v=)[0-9.]+#\1${NEW}#g" public/formular.html
grep -n "js/formular/list.js?v=" public/formular.html   # linia <script> întreagă
```
`CACHE_VERSION` doar dacă `js/formular/list.js` e în `PRECACHE_ASSETS`.

`git add` explicit. Arhivează ca `docs/archive/PROMPT-216-audit-cab.md`.

```
feat(#216): auditul DF/ORD vizibil si compartimentului CAB — v<TINTA>

Butonul „Audit document" din listele DF/ORD era decis in browser pe rol
(admin/org_admin), iar ruta GET /api/formulare-audit avea aceeasi regula
scrisa separat. Decizia e acum o singura functie pura, canViewFormularAudit,
folosita de poarta rutei si de campul can_audit din lista; butonul citeste
campul. CAB-ul organizatiei vede auditul documentelor din propria
organizatie; admin si org_admin neschimbati. Cautarea compartimentului esuata
da 403 (fail-closed).
```

```bash
git push origin develop
```

**Stop.**

---

# RAPORT FINAL
1. Ancore obținute, inclusiv forma lui `loadActorCompAndCab` și comportamentul `mockBySql` pe SQL nemapat.
2. Roșiile pe codul nereparat.
3. Rezultatul testelor noi, în special paritatea E.2.4.
4. Teste preexistente atinse (așteptat: niciunul).
5. Numere reale `npm test` / `npm run test:db`, secvențial.
6. `?v=` / `CACHE_VERSION` cu dovadă.
7. Divergențe și colaterale — raportate, nereparate.

# ⛔ CONSTRÂNGERI ABSOLUTE
- `develop` ONLY, apoi stop. Zero migrații, zero scrieri de date.
- Regula de acces într-o SINGURĂ funcție; zero reguli de rol noi în browser.
- Admin și org_admin: comportament identic cu azi.
- ⛔ Exportul CSV/PDF al auditului, `listFormularAudit`, restul listei — neatinse.
- `?v=` țintit, `git add` explicit, `old_str` unic sau STOP.
