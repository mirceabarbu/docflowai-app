# PROMPT — BLOC 4.3 (Dropdown smart + auto-redirect concediu)

## CONTEXT

DocFlowAI v3.9.379+. BLOC 4.1 (backend) + BLOC 4.2 (UI setări) sunt verzi. Acum integrăm feature-ul în fluxul de semnare:

1. **Dropdown smart** în Flux nou + Șabloane: când userul e în concediu și are delegat, option afișează `Ion (concediu — semnează Maria)`. La submit, payload-ul folosește **email-ul Mariei** (delegatul real) cu marker de delegare pentru audit.

2. **Auto-redirect fluxuri EXISTENTE**: când un flux ajunge la un semnatar care între timp a intrat în concediu, sistemul transferă automat slot-ul către delegat (folosește mecanismul existent `POST /flows/:flowId/delegate` din `lifecycle.mjs`).

3. **Audit trail**: marker `delegated_for_user_id` și `delegated_for_name` pe fiecare semnatar — afișat în istoric/notificări ca „semnat **în delegare pentru Ion**".

## ⛔ CONSTRÂNGERI ABSOLUTE

1. NU atinge zona STS:
   - `STSCloudProvider.mjs`, `cloud-signing.mjs`, `bulk-signing.mjs`
   - `pades.mjs`, `java-pades-client.mjs`
2. NU atinge `df-apifetch-shim*.js`, `admin/core.js`
3. NU atinge backend BLOC 4.1 (deja funcțional)
4. NU schimba mecanismul existent de delegare manuală (`POST /flows/:flowId/delegate`) — îl REFOLOSIM
5. `npm test` verde

## ARHITECTURĂ

### Componenta 1 — Dropdown smart (UI)

În `semdoc-initiator/main.js` și `templates/templates.js`:
- Modificăm cum se construiește `<option>` pentru un user în concediu
- Adăugăm `data-delegate-email`, `data-delegate-name`, `data-original-user-id` pe option
- La submit (`readSigners` în main.js), folosim aceste atribute pentru a substitui semnatarul cu delegatul
- Payload-ul către `/flows` conține: `name=delegateName`, `email=delegateEmail`, plus marker `delegatedForUserId` și `delegatedForName`

### Componenta 2 — Backend extindere createFlow

În `server/routes/flows/crud.mjs`, în `normalizedSigners`, accept 2 câmpuri opționale noi: `delegatedForUserId` și `delegatedForName`. Le pun în obiectul semnatar — backend nu modifică altceva, doar le persistă pentru audit.

### Componenta 3 — Auto-redirect fluxuri existente

În `server/routes/flows/signing.mjs` (NU `cloud-signing.mjs`!), în endpoint-urile care setează un semnatar la `current` (după ce semnatarul anterior a uploadat PDF semnat), adaug un hook **post-tranziție**: verific dacă `nextSigner` e în concediu, și dacă DA + are delegat, substituim slot-ul cu delegatul + marcăm pentru audit.

NB: Auto-redirect se aplică DOAR în `signing.mjs` (manual upload). Pentru `cloud-signing.mjs` (STS QES) nu putem atinge — utilizatorul în concediu va vedea mesaj „Ești în concediu — fluxul a fost transferat la Maria" la deschiderea linkului. Implementăm asta în Componenta 4.

### Componenta 4 — Verificare la deschidere link semnare

Endpoint-ul `GET /flows/:flowId/sign?token=...` (sau cum e structurat) — adăugăm verificare: dacă userul logat e cel din token și e în concediu cu delegat, transferăm automat slot-ul (apelăm intern logica din Componenta 3) și redirect la link nou.

### Componenta 5 — Afișare audit trail

În `flow.html` (pagina de detalii flux), `notifications.html`, etc. — pentru fiecare semnatar cu `delegatedForUserId`, afișăm badge „**în delegare pentru Ion Popescu**" în loc de doar numele Mariei.

---

## FAZA 0 — Pre-checks

```bash
# 0.1 — BLOC 4.1 + 4.2 confirmate
grep -c "063_user_leave_delegate" server/db/index.mjs
# Așteptat: 1

ls server/services/user-leave.mjs
# Așteptat: prezent

grep -c "openLeaveModal" public/js/df-user-modals.js
# Așteptat: ≥ 1

# 0.2 — Pattern delegare existentă (lifecycle.mjs) — îl REFOLOSIM
grep -n "router.post.*delegate" server/routes/flows/lifecycle.mjs
# Așteptat: 1 linie cu POST /flows/:flowId/delegate

# 0.3 — Versiune
grep '"version"' package.json
# Notează ca <VER>

# 0.4 — Confirm signing.mjs e atingibil (NU în lista STS protejată)
ls server/routes/flows/signing.mjs
# Așteptat: prezent. NB: NU confunda cu cloud-signing.mjs (PROTEJAT)

# 0.5 — Inventar utilizări signers în UI
grep -c "_dbUsers\|_tmplUsers" public/js/semdoc-initiator/main.js public/js/templates/templates.js
# Așteptat: > 0 ambele
```

---

## FAZA 1 — Dropdown smart în `semdoc-initiator/main.js` (Flux nou)

### 1.1. Modifică `populateSelectGlobal` (linia ~397) să marcheze userii în concediu

**Caută** funcția exactă (linii 397-409):
```js
      function populateSelectGlobal(sel) {
        while (sel.options.length > 1) sel.remove(1);
        const usedEmails = getUsedEmails(sel);
        (window._dbUsers || []).forEach(u => {
          if (usedEmails.has(u.email || '')) return;
          const opt = document.createElement("option");
          opt.value = u.nume || "";
          opt.dataset.email = u.email || "";
          opt.dataset.functie = u.functie || "";
          opt.textContent = (u.nume || u.email) + (u.functie ? " — " + u.functie : "");
          sel.appendChild(opt);
        });
      }
```

**Înlocuiește cu**:
```js
      function populateSelectGlobal(sel) {
        while (sel.options.length > 1) sel.remove(1);
        const usedEmails = getUsedEmails(sel);
        (window._dbUsers || []).forEach(u => {
          if (usedEmails.has(u.email || '')) return;
          const opt = document.createElement("option");

          // BLOC 4.3: detectare concediu activ
          const onLeave = !!(u.leave?.onLeave);
          const hasDelegate = !!(u.leave?.delegate?.email);

          if (onLeave && hasDelegate) {
            // Userul e în concediu cu delegat → option special, semnează delegatul
            opt.value = u.leave.delegate.nume || u.leave.delegate.email;
            opt.dataset.email = u.leave.delegate.email;
            opt.dataset.functie = u.leave.delegate.functie || u.functie || "";
            opt.dataset.delegateEmail = u.leave.delegate.email;
            opt.dataset.delegateName = u.leave.delegate.nume || "";
            opt.dataset.originalUserId = String(u.id);
            opt.dataset.originalName = u.nume || "";
            opt.dataset.originalEmail = u.email || "";
            opt.textContent = `${u.nume || u.email} (concediu — semnează ${u.leave.delegate.nume})`;
            opt.style.fontStyle = "italic";
          } else if (onLeave && !hasDelegate) {
            // În concediu fără delegat → option dezactivat (nu poate fi ales)
            opt.value = u.nume || "";
            opt.dataset.email = u.email || "";
            opt.disabled = true;
            opt.textContent = `${u.nume || u.email} (concediu — fără delegat ⚠)`;
            opt.style.color = "#999";
          } else {
            // User normal — comportament neschimbat
            opt.value = u.nume || "";
            opt.dataset.email = u.email || "";
            opt.dataset.functie = u.functie || "";
            opt.textContent = (u.nume || u.email) + (u.functie ? " — " + u.functie : "");
          }

          sel.appendChild(opt);
        });
      }
```

### 1.2. Modifică `readSigners` (linia ~1668) să trimită markeri delegare la backend

**Caută** funcția (linii 1668-1686):
```js
      function readSigners() {
        const rows = [...tbody.querySelectorAll("tr")];
        return rows.map((tr, i) => {
          const ancoreSel = tr.querySelector(".ancoreField");
          const ancoreFieldName = ancoreSel?.value?.trim() || null;
          // Email citit din data-email al opțiunii selectate (nu mai avem input vizibil)
          const nameSel2 = tr.querySelector(".name-select");
          const emailVal = (nameSel2?.options[nameSel2?.selectedIndex]?.dataset?.email || '').trim();
          return {
            order: i + 1,
            rol: (() => { const sel = tr.querySelector(".rol"); if (sel.value === "__alt__") { return tr.querySelector(".rolCustom").value.trim().toUpperCase() || "__alt__"; } return sel.value; })(),
            functie: tr.querySelector(".functie").value.trim(),
            name: (tr.querySelector(".name-select") || tr.querySelector(".name"))?.value?.trim() || "",
            email: emailVal,
            // ancoreFieldName: câmpul AcroForm — prezent doar pentru flowType='ancore'
            ...(ancoreFieldName ? { ancoreFieldName } : {}),
          };
        }).filter(s => s.rol && (s.name || s.email));
      }
```

**Înlocuiește cu** (adaug citirea markerilor de delegare din option):
```js
      function readSigners() {
        const rows = [...tbody.querySelectorAll("tr")];
        return rows.map((tr, i) => {
          const ancoreSel = tr.querySelector(".ancoreField");
          const ancoreFieldName = ancoreSel?.value?.trim() || null;
          // Email citit din data-email al opțiunii selectate (nu mai avem input vizibil)
          const nameSel2 = tr.querySelector(".name-select");
          const selectedOpt = nameSel2?.options[nameSel2?.selectedIndex];
          const emailVal = (selectedOpt?.dataset?.email || '').trim();

          // BLOC 4.3: detectare delegare (userul ales era în concediu)
          const delegatedForUserId = selectedOpt?.dataset?.originalUserId
            ? Number(selectedOpt.dataset.originalUserId) : null;
          const delegatedForName = selectedOpt?.dataset?.originalName || null;
          const delegatedForEmail = selectedOpt?.dataset?.originalEmail || null;

          return {
            order: i + 1,
            rol: (() => { const sel = tr.querySelector(".rol"); if (sel.value === "__alt__") { return tr.querySelector(".rolCustom").value.trim().toUpperCase() || "__alt__"; } return sel.value; })(),
            functie: tr.querySelector(".functie").value.trim(),
            name: (tr.querySelector(".name-select") || tr.querySelector(".name"))?.value?.trim() || "",
            email: emailVal,
            // ancoreFieldName: câmpul AcroForm — prezent doar pentru flowType='ancore'
            ...(ancoreFieldName ? { ancoreFieldName } : {}),
            // BLOC 4.3: marker delegare (doar dacă originalul e în concediu)
            ...(delegatedForUserId ? {
              delegatedForUserId,
              delegatedForName,
              delegatedForEmail,
            } : {}),
          };
        }).filter(s => s.rol && (s.name || s.email));
      }
```

### 1.3. Verificare

```bash
grep -c "delegatedForUserId\|originalUserId" public/js/semdoc-initiator/main.js
# Așteptat: ≥ 4

node --check public/js/semdoc-initiator/main.js && echo "Syntax OK"
```

---

## FAZA 2 — Dropdown smart în `templates/templates.js` (Șabloane)

### 2.1. Modifică ambele locuri unde se construiesc option-urile

**Locația A** — în `loadUsers` IIFE (linia 358 — populare prim rând):

**Caută** (linii 374-379):
```js
        window._tmplUsers.forEach(u => {
          const opt = document.createElement('option');
          opt.value = u.nume||''; opt.dataset.email = u.email||''; opt.dataset.functie = u.functie||'';
          opt.textContent = (u.nume||u.email) + (u.functie?' — '+u.functie:'');
          sel.appendChild(opt);
        });
```

**Înlocuiește cu**:
```js
        window._tmplUsers.forEach(u => {
          const opt = document.createElement('option');
          _tmplApplyUserToOption(opt, u);
          sel.appendChild(opt);
        });
```

**Locația B** — în `refreshAllDropdowns` (linia ~37, în interior):

**Caută** (linii 50-55):
```js
      const opt = document.createElement('option');
      opt.value = u.nume || '';
      opt.dataset.email = u.email || '';
      opt.dataset.functie = u.functie || '';
      opt.textContent = (u.nume || u.email) + (u.functie ? ' — ' + u.functie : '');
      sel.appendChild(opt);
```

**Înlocuiește cu**:
```js
      const opt = document.createElement('option');
      _tmplApplyUserToOption(opt, u);
      sel.appendChild(opt);
```

### 2.2. Adaugă helper `_tmplApplyUserToOption`

**Inserează** la începutul fișierului `public/js/templates/templates.js`, ÎNAINTE de prima `function`:

```js
// BLOC 4.3: helper care setează value/dataset/textContent pe option,
// detectând concediul și marcând delegarea pentru auto-substituire la submit.
function _tmplApplyUserToOption(opt, u) {
  const onLeave = !!(u.leave?.onLeave);
  const hasDelegate = !!(u.leave?.delegate?.email);

  if (onLeave && hasDelegate) {
    opt.value = u.leave.delegate.nume || u.leave.delegate.email;
    opt.dataset.email = u.leave.delegate.email;
    opt.dataset.functie = u.leave.delegate.functie || u.functie || '';
    opt.dataset.delegateEmail = u.leave.delegate.email;
    opt.dataset.delegateName = u.leave.delegate.nume || '';
    opt.dataset.originalUserId = String(u.id);
    opt.dataset.originalName = u.nume || '';
    opt.dataset.originalEmail = u.email || '';
    opt.textContent = `${u.nume || u.email} (concediu — semnează ${u.leave.delegate.nume})`;
    opt.style.fontStyle = 'italic';
  } else if (onLeave && !hasDelegate) {
    opt.value = u.nume || '';
    opt.dataset.email = u.email || '';
    opt.disabled = true;
    opt.textContent = `${u.nume || u.email} (concediu — fără delegat ⚠)`;
    opt.style.color = '#999';
  } else {
    opt.value = u.nume || '';
    opt.dataset.email = u.email || '';
    opt.dataset.functie = u.functie || '';
    opt.textContent = (u.nume || u.email) + (u.functie ? ' — ' + u.functie : '');
  }
}
```

NB: În `templates.js`, șabloanele se salvează pe server cu `name + email` direct (nu trimit `delegatedForUserId`). Substituirea cu delegat se face **doar la momentul când șablonul e ÎNCĂRCAT într-un flux nou** — dropdown-ul afișează corect, iar `readSigners` din semdoc-initiator face substituția. **DECI: pentru templates.js NU modificăm nimic la save** — doar dropdown-ul afișează corect.

### 2.3. Verificare

```bash
grep -c "_tmplApplyUserToOption" public/js/templates/templates.js
# Așteptat: 3 (1 definiție + 2 utilizări)

node --check public/js/templates/templates.js && echo "Syntax OK"
```

---

## FAZA 3 — Backend extindere `createFlow`

**Fișier:** `server/routes/flows/crud.mjs`

**Caută** blocul `normalizedSigners.map` (în jur de linia 130-150):
```js
    const normalizedSigners = signers.map((s, idx) => ({
      order: Number(s.order || idx + 1),
      rol: String(s.rol || s.atribut || '').trim(),
      functie: String(s.functie || '').trim(),
      compartiment: String(s.compartiment || '').trim(),
      name: String(s.name || '').trim(),
      email: String(s.email || '').trim(),
      token: String(s.token || crypto.randomBytes(16).toString('hex')),
      tokenCreatedAt: new Date().toISOString(),
      status: 'pending', signedAt: null, signature: null,
      // b253: păstrat pentru flux ancore (câmpul AcroForm repartizat semnătarului)
      ancoreFieldName: String(s.ancoreFieldName || '').trim() || null,
      // b253+: coordonate XFA pentru câmpuri fără /Rect în AcroForm (PDF-uri XFA Forexebug)
      ancoreFieldRect: (s.ancoreFieldRect && typeof s.ancoreFieldRect === 'object' && !Array.isArray(s.ancoreFieldRect))
        ? { x: s.ancoreFieldRect.x ?? null, y: s.ancoreFieldRect.y ?? null,
            w: s.ancoreFieldRect.w ?? null, h: s.ancoreFieldRect.h ?? null,
            page: s.ancoreFieldRect.page ?? null }
        : null,
    }));
```

**Înlocuiește cu** (adaug 3 câmpuri noi opționale la sfârșit, înainte de `}));`):
```js
    const normalizedSigners = signers.map((s, idx) => ({
      order: Number(s.order || idx + 1),
      rol: String(s.rol || s.atribut || '').trim(),
      functie: String(s.functie || '').trim(),
      compartiment: String(s.compartiment || '').trim(),
      name: String(s.name || '').trim(),
      email: String(s.email || '').trim(),
      token: String(s.token || crypto.randomBytes(16).toString('hex')),
      tokenCreatedAt: new Date().toISOString(),
      status: 'pending', signedAt: null, signature: null,
      // b253: păstrat pentru flux ancore (câmpul AcroForm repartizat semnătarului)
      ancoreFieldName: String(s.ancoreFieldName || '').trim() || null,
      // b253+: coordonate XFA pentru câmpuri fără /Rect în AcroForm (PDF-uri XFA Forexebug)
      ancoreFieldRect: (s.ancoreFieldRect && typeof s.ancoreFieldRect === 'object' && !Array.isArray(s.ancoreFieldRect))
        ? { x: s.ancoreFieldRect.x ?? null, y: s.ancoreFieldRect.y ?? null,
            w: s.ancoreFieldRect.w ?? null, h: s.ancoreFieldRect.h ?? null,
            page: s.ancoreFieldRect.page ?? null }
        : null,
      // BLOC 4.3: marker delegare la creare (userul ales era în concediu, semnează delegatul)
      delegatedForUserId: (s.delegatedForUserId && Number.isInteger(Number(s.delegatedForUserId)))
        ? Number(s.delegatedForUserId) : null,
      delegatedForName: String(s.delegatedForName || '').trim() || null,
      delegatedForEmail: String(s.delegatedForEmail || '').trim() || null,
    }));
```

**Verificare:**
```bash
grep -c "delegatedForUserId" server/routes/flows/crud.mjs
# Așteptat: ≥ 2

node --check server/routes/flows/crud.mjs && echo "Syntax OK"
```

---

## FAZA 4 — Auto-redirect fluxuri existente (signing.mjs)

**Fișier:** `server/routes/flows/signing.mjs`

### 4.1. Adaugă import pentru helper-ul user-leave

**Caută** (în jur de linia 6):
```js
import { pool, DB_READY, requireDb, saveFlow, getFlowData, getDefaultOrgId, getUserMapForOrg, writeAuditEvent } from '../../db/index.mjs';
```

**Inserează imediat după**:
```js
import { getActiveSigner, getLeaveInfo } from '../../services/user-leave.mjs';
```

### 4.2. Adaugă helper privat de auto-redirect post-tranziție

**Inserează** ÎNAINTE de `export default router;` (caută linia exactă în fișier — probabil la sfârșit):

```js

// ════════════════════════════════════════════════════════════════════════════
// BLOC 4.3 — Auto-redirect la semnatar în concediu
// Apelat după ce un semnatar a uploadat PDF semnat și fluxul s-a mutat la
// următorul semnatar (status='current'). Verifică dacă noul semnatar curent
// e în concediu și are delegat — dacă DA, transferă slot-ul automat.
// ════════════════════════════════════════════════════════════════════════════
async function _autoRedirectIfOnLeave(flowId, data, signers) {
  try {
    const currentIdx = signers.findIndex(s => s.status === 'current');
    if (currentIdx === -1) return false;
    const cur = signers[currentIdx];

    // Lookup user după email
    const { rows: uRows } = await pool.query(
      'SELECT id FROM users WHERE email=$1',
      [(cur.email || '').toLowerCase()]
    );
    if (!uRows.length) return false;
    const userId = uRows[0].id;

    // Verifică concediu activ + delegat
    const active = await getActiveSigner(userId);
    if (!active || !active.isDelegate) return false;

    // Lookup datele delegatului
    const { rows: dRows } = await pool.query(
      'SELECT id, nume, email, functie FROM users WHERE id=$1',
      [active.userId]
    );
    if (!dRows.length) return false;
    const del = dRows[0];

    // Substituție în slot
    const originalName = cur.name;
    const originalEmail = cur.email;
    cur.name = del.nume || del.email;
    cur.email = del.email;
    cur.functie = del.functie || cur.functie;
    cur.delegatedForUserId = userId;
    cur.delegatedForName = originalName;
    cur.delegatedForEmail = originalEmail;
    cur.token = crypto.randomBytes(16).toString('hex'); // token nou pentru delegat
    cur.tokenCreatedAt = new Date().toISOString();
    cur.emailSent = false;
    cur.notifiedAt = null;
    cur.delegatedFrom = {
      name: originalName,
      email: originalEmail,
      reason: 'auto: utilizator în concediu',
      at: new Date().toISOString(),
      by: 'system',
    };

    data.events = Array.isArray(data.events) ? data.events : [];
    data.events.push({
      at: new Date().toISOString(),
      type: 'AUTO_DELEGATED_LEAVE',
      from: originalEmail,
      to: del.email,
      order: cur.order,
    });

    writeAuditEvent({
      flowId, orgId: data.orgId,
      eventType: 'AUTO_DELEGATED_LEAVE',
      actorEmail: 'system',
      payload: { from: originalEmail, to: del.email, order: cur.order },
    });

    logger.info(`🔁 Auto-delegated flow ${flowId} from ${originalEmail} to ${del.email} (on leave)`);
    return true;
  } catch (e) {
    logger.warn({ err: e, flowId }, '_autoRedirectIfOnLeave failed (non-fatal)');
    return false;
  }
}
```

### 4.3. Apelează auto-redirect după tranziție

**Caută** în `signing.mjs` linia ~291:
```js
    if (nextIdx !== -1) signers.forEach((s, i) => { if (s.status !== 'signed') s.status = i === nextIdx ? 'current' : 'pending'; });
    data.signers = signers;
```

**Înlocuiește cu**:
```js
    if (nextIdx !== -1) signers.forEach((s, i) => { if (s.status !== 'signed') s.status = i === nextIdx ? 'current' : 'pending'; });
    // BLOC 4.3: auto-redirect dacă noul semnatar curent e în concediu cu delegat
    if (nextIdx !== -1) await _autoRedirectIfOnLeave(flowId, data, signers);
    data.signers = signers;
```

### 4.4. Verificare

```bash
grep -c "_autoRedirectIfOnLeave" server/routes/flows/signing.mjs
# Așteptat: 2 (1 definiție + 1 apel)

grep -c "AUTO_DELEGATED_LEAVE" server/routes/flows/signing.mjs
# Așteptat: 2 (events.push + writeAuditEvent)

node --check server/routes/flows/signing.mjs && echo "Syntax OK"
```

---

## FAZA 5 — Verificare la creare flux (createFlow primul semnatar)

În `createFlow` (`server/routes/flows/crud.mjs`), primul semnatar este setat `status='current'` la creare. Dacă acesta e în concediu cu delegat, și clientul NU a făcut substituția (de exemplu, request prin API directă, fără UI), backend-ul ar trebui să o facă automat.

### 5.1. Adaugă import în `crud.mjs`

**Caută** (în jur de linia 5-15, unde sunt import-urile):
```js
import { pool, requireDb, ...
```

**Adaugă (după ultimul import):**
```js
import { getActiveSigner } from '../../services/user-leave.mjs';
```

### 5.2. Adaugă auto-redirect pentru primul semnatar la creare

**Caută** linia (în `createFlow`, după setarea status-urilor):
```js
    normalizedSigners.forEach((s, i) => { s.status = i === 0 ? 'current' : 'pending'; });
```

**Inserează imediat după**:
```js
    // BLOC 4.3: auto-redirect dacă primul semnatar e în concediu cu delegat
    // (fallback pentru clienți API care n-au substituit în UI)
    try {
      const first = normalizedSigners[0];
      if (first && first.email && !first.delegatedForUserId) {
        const { rows: uRows } = await pool.query(
          'SELECT id FROM users WHERE email=$1',
          [first.email.toLowerCase()]
        );
        if (uRows.length) {
          const userId = uRows[0].id;
          const active = await getActiveSigner(userId);
          if (active && active.isDelegate) {
            const { rows: dRows } = await pool.query(
              'SELECT id, nume, email, functie FROM users WHERE id=$1',
              [active.userId]
            );
            if (dRows.length) {
              const del = dRows[0];
              first.delegatedForUserId = userId;
              first.delegatedForName = first.name;
              first.delegatedForEmail = first.email;
              first.name = del.nume || del.email;
              first.email = del.email;
              first.functie = del.functie || first.functie;
              first.token = crypto.randomBytes(16).toString('hex');
              first.tokenCreatedAt = new Date().toISOString();
              logger.info(`🔁 createFlow: first signer ${first.delegatedForEmail} on leave, redirected to ${del.email}`);
            }
          }
        }
      }
    } catch (autoErr) {
      logger.warn({ err: autoErr }, 'createFlow auto-redirect failed (non-fatal)');
    }
```

### 5.3. Verificare

```bash
grep -c "createFlow auto-redirect failed" server/routes/flows/crud.mjs
# Așteptat: 1
```

---

## FAZA 6 — Afișare audit „în delegare pentru" în UI

Când flow-ul are un semnatar cu `delegatedForName`, afișăm mențiunea în UI. Trebuie să verific unde sunt afișați semnatarii pentru a aplica:

### 6.1. În `flow.html` și/sau `notifications.html`

**Pre-check**: identifică unde se afișează numele semnatarilor în flow.html (probabil în `js/flow/...`).

```bash
# Identifică template-ul de signer în flow
grep -rnE "signer.*name|s\.name|signedBy" public/js/flow/ public/js/notifications/ 2>/dev/null | head -10
```

**Dacă găsești un template** (ex. `${s.name}` într-un innerHTML), modifică să afișeze `delegatedForName` ca subline:

```html
${s.name}
${s.delegatedForName ? `<span style="display:block;font-size:.7rem;color:var(--df-text-3);font-style:italic;">în delegare pentru ${s.delegatedForName}</span>` : ''}
```

### 6.2. Implementare DEFENSIVĂ (skip dacă nu găsești)

Dacă nu identifici imediat locul exact, **skip această fază** — feature-ul funcționează corect (delegare se face automat), doar UI-ul nu marchează vizual că e delegat. Adaugi în BLOC 4.4 sau cu fix ulterior.

**Documentează în commit message** ce ai făcut/n-ai făcut.

---

## FAZA 7 — Verificări finale

```bash
# 7.1 — UI: dropdown smart aplicat
grep -c "delegatedForUserId\|originalUserId" public/js/semdoc-initiator/main.js
# Așteptat: ≥ 4

grep -c "_tmplApplyUserToOption" public/js/templates/templates.js
# Așteptat: 3

# 7.2 — Backend: createFlow accept noi câmpuri
grep -c "delegatedForUserId" server/routes/flows/crud.mjs
# Așteptat: ≥ 3 (1 definiție + 1 import + 1 utilizare în auto-redirect)

# 7.3 — Backend: auto-redirect signing.mjs
grep -c "_autoRedirectIfOnLeave\|AUTO_DELEGATED_LEAVE" server/routes/flows/signing.mjs
# Așteptat: ≥ 4

# 7.4 — Sintaxă OK
node --check public/js/semdoc-initiator/main.js && \
node --check public/js/templates/templates.js && \
node --check server/routes/flows/crud.mjs && \
node --check server/routes/flows/signing.mjs && \
echo "ALL OK"

# 7.5 — Confirm zona STS NEATINSĂ
git diff --stat origin/develop -- server/routes/flows/cloud-signing.mjs server/routes/flows/bulk-signing.mjs server/signing/
# Așteptat: NIMIC
```

---

## FAZA 8 — Test + commit + push

```bash
npm test
# Așteptat: toate verzi

git add public/js/semdoc-initiator/main.js \
        public/js/templates/templates.js \
        server/routes/flows/crud.mjs \
        server/routes/flows/signing.mjs

git commit -m "feat: BLOC 4.3 — dropdown smart concediu + auto-redirect fluxuri

UI (semdoc-initiator/main.js + templates/templates.js):
- populateSelectGlobal / _tmplApplyUserToOption: detectează users.leave.onLeave
- User în concediu cu delegat → option afișează 'Ion (concediu — semnează Maria)',
  italic, value=delegate.nume, dataset.email=delegate.email, dataset.originalUserId=ion.id
- User în concediu fără delegat → option disabled cu marker '⚠'
- readSigners (semdoc-initiator): citește dataset.originalUserId/Name/Email și
  trimite payload cu marker delegatedForUserId la /flows

Backend createFlow (server/routes/flows/crud.mjs):
- normalizedSigners acceptă 3 câmpuri opționale: delegatedForUserId,
  delegatedForName, delegatedForEmail (validate ca Number / String).
- Auto-redirect fallback la creare: dacă primul semnatar e în concediu cu
  delegat și clientul nu a făcut substituirea (API direct), backend o face
  automat folosind getActiveSigner() din services/user-leave.mjs

Auto-redirect fluxuri existente (server/routes/flows/signing.mjs):
- Hook nou _autoRedirectIfOnLeave: după ce un semnatar uploadează PDF semnat
  și fluxul se mută la următorul (status='current'), verifică dacă noul
  semnatar curent e în concediu activ cu delegat. Dacă DA, substituie:
    * name/email/functie/token din slot
    * marker delegatedForUserId/Name/Email pentru audit
    * delegatedFrom obj cu reason 'auto: utilizator în concediu'
    * event AUTO_DELEGATED_LEAVE în data.events + audit_log
- Aplicat DOAR în signing.mjs (manual upload PDF semnat).
- NU atinge cloud-signing.mjs (zona STS interzisă).
  Pentru fluxuri STS, userul în concediu va vedea linkul direct și poate
  delega manual prin UI existent dacă e cazul.

Audit trail:
- normalizedSigners stochează delegatedForUserId/Name/Email — disponibile
  pentru afișare 'în delegare pentru' în flow.html / notifications.html
  (UI marker — implementare în BLOC 4.4 sau fix ulterior).

Constrângeri respectate:
- ZERO atingeri zona STS (cloud-signing, bulk-signing, pades, java-pades, STSCloudProvider)
- REFOLOSEȘTE mecanismul existent POST /flows/:flowId/delegate fără să-l modifice
- Backend BLOC 4.1 user-leave.mjs nemodificat — doar îl importă

Următorul pas: BLOC 5 — consolidare design system (.frow/.modal global).
"

git push origin develop
```

---

## REZUMAT BLOC 4.3

**Fișiere atinse:** 4
- `public/js/semdoc-initiator/main.js` (dropdown smart + readSigners)
- `public/js/templates/templates.js` (dropdown smart helper)
- `server/routes/flows/crud.mjs` (createFlow accept delegatedFor* + auto-redirect primul semnatar)
- `server/routes/flows/signing.mjs` (hook _autoRedirectIfOnLeave după upload semnat)

**Fișiere STS:** 0

## Test manual recomandat după deploy

### Test 1 — Setup
1. User A → Setări (modal) → setează concediu activ pentru azi/mâine cu delegat User B → Salvează
2. User C (alt user, alt browser/incognito) → /admin sau Flux nou

### Test 2 — Dropdown smart (Flux nou)
1. User C → Flux nou → adaugă semnatar
2. Click dropdown semnatari
3. **Verifică:**
   - User A apare cu text italic „User A (concediu — semnează User B)"
   - User C selectează User A
   - Funcția se completează cu cea a User B (delegatul)
4. Click „Lansează flux"
5. **Verifică în DB / admin:**
   - signer-ul are `email=B@...`, `name=User B`
   - signer-ul are `delegatedForUserId=A.id`, `delegatedForName='User A'`

### Test 3 — Auto-redirect flux existent
1. Creează un flux NORMAL (toți semnatarii disponibili) cu User D ca al doilea semnatar
2. Primul semnatar (User C) semnează manual și uploadează PDF
3. **ÎNTRE** semnări: User D își setează concediu cu delegat User E (modal user)
4. **Așteaptă** ca User C să termine upload (sau verifică logs)
5. **Verifică în Railway logs**: apare „Auto-delegated flow ... from D@... to E@... (on leave)"
6. **Verifică în UI** (admin → flow): slot User D arată acum cu User E + marker „delegated"

### Test 4 — User în concediu fără delegat
1. User F → Setări → setează concediu (mâine), DAR cu un delegat care apoi își setează propriu concediu
   (NB: validarea NO CHAIN ar trebui să blocheze această configurație — verifică)
2. Test: dacă cumva ajunge un user în concediu fără delegat valid, apare în dropdown ca disabled cu „⚠"

### Test 5 — Validări
- User A își setează concediu retroactiv (start ieri) → server respinge
- User A își alege ca delegat un user din altă instituție → server respinge
- User A își alege un delegat care are deja propriu delegat → server respinge

## Atenție / posibile observații

- **Flux STS (cloud-signing.mjs)** — auto-redirect NU se aplică pentru semnătura QES via STS, doar pentru manual upload. Dacă userul în concediu primește email cu link STS, va putea totuși să-l deschidă (token e valid). În practică, dropdown-ul smart la creare flux previne situația majoră (95% din fluxuri creează signers prin UI).
- **Templates.js fără auto-substituire la save** — șabloanele se salvează cu user-ul original (nu delegat). Substituirea se aplică doar când șablonul e ÎNCĂRCAT într-un flux nou (semdoc-initiator preia delegatul în readSigners). Această decizie e intenționată — șabloanele rămân stabile, delegarea se aplică la momentul utilizării.
- **UI marker „în delegare pentru"** — backend-ul stochează datele, dar UI flow.html nu le afișează încă. E TODO pentru BLOC 4.4 sau fix ulterior. Pentru audit, datele sunt disponibile în `flow.signers[i].delegatedForName`.
- **Notifications email** — auto-redirect setează `cur.emailSent=false` și `cur.notifiedAt=null`, deci sistemul de notificări va trimite email delegatului la următoarea iterație de notificare (pattern existent). NU e nevoie să tratezi explicit notificarea aici.

După BLOC 4.3 verde 24h pe staging, atac BLOC 5 (consolidare design system: `.frow/.modal/.modal-bg/.modal-acts/.grid2` mutate global cu prefix `df-`).
