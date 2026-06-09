# ⚠️ BRANCH: develop — NU `main`. NU push/merge/checkout pe main.

> Toate comenzile git rămân pe `develop`. Commit pe develop → auto-deploy staging.
> NU atinge fișierele de semnare STS (NO-TOUCH):
> `server/routes/flows/signing.mjs`, `server/routes/flows/bulk-signing.mjs`,
> `server/routes/flows/cloud-signing.mjs`, `pades.mjs`, `java-pades-client.mjs`,
> `server/signing/providers/STSCloudProvider.mjs`.
> Pe acestea ai voie doar să le **citești** ca referință (pattern restore parent).

---

## Obiectiv

Transformăm logica de **anulare** din ALOP / DF / ORD în **ȘTERGERE** (soft-delete real),
cu condiții stricte. Fără regresii — `npm test` trebuie să rămână verde.

### Reguli de ștergere (sursă unică de adevăr)

1. **ORD** se poate șterge dacă **NU a fost trimisă pe flux semnare** (`flow_id IS NULL`).
2. **DF** se poate șterge dacă:
   - **NU a fost trimis pe flux** (`flow_id IS NULL`), **ȘI**
   - **NU există ORD legată** ne-ștearsă (`NOT EXISTS formulare_ord WHERE df_id=DF AND deleted_at IS NULL`).
   - Pentru **revizii**: aceeași condiție pe rândul reviziei (o revizie draft nu are niciodată
     ORD legat direct → condiția "fără ORD" trece automat; ce contează e `flow_id IS NULL` pe revizie).
3. **ALOP** se poate șterge dacă **NU are DF/ORD legat** (`df_id IS NULL AND ord_id IS NULL`,
   verificat pe DF/ORD ne-șterse).

### Relink ALOP la ștergere (mirror după logica de refuse din signing.mjs)

- La ștergere **DF**:
  - dacă e **R0** (`revizie_nr=0` sau `parent_df_id IS NULL`) → `alop_instances.df_id=NULL, df_flow_id=NULL, df_completed_at=NULL` (butonul "Completează DF" reapare).
  - dacă e **R1+** și parent aprobat → relink la parent: `df_id=parent.id, df_flow_id=parent.flow_id, df_completed_at=NOW()`.
  - dacă parent NU e aprobat → fallback: eliberează (`df_id=NULL,...`).
- La ștergere **ORD**: `alop_instances.ord_id=NULL, ord_flow_id=NULL, ord_completed_at=NULL`
  (status ALOP rămâne `ordonantare` → butonul "Completează Ordonanțare" reapare).

### Punctul 2 (NU regresa — funcționează deja corect)

DF/ORD **aprobat** (de pe flux) afișează în acțiuni **doar**: vizualizare (deschidere) + "Descarcă PDF semnat";
DF păstrează în plus butonul "Revizuiește". Acest comportament e deja în `doc.js` (blocul `ST.docAprobat`).
**NU modifica** blocul ăsta. Condiția nouă de ștergere (`flow_id IS NULL`) garantează că butonul de ștergere
NU apare niciodată pe documente aprobate / pe flux.

---

## Patch 1 — `server/routes/formulare-db.mjs`: flag `can_delete` în lista DF

În SELECT-ul listei DF (în `GET /api/formulare/list`, ramura `type === 'df'`), inserează coloana
`can_delete` imediat înainte de coloana `isP1`.

**old_str**
```
          (fd.created_by = $${params.push(actor.userId)}) AS "isP1",
          COUNT(*) OVER() AS total
        FROM formulare_df fd
```
**new_str**
```
          (
            ${(isAdmin || isOrgAdmin) ? 'TRUE' : `fd.created_by = $${params.push(actor.userId)}`}
            AND fd.flow_id IS NULL
            AND NOT EXISTS (
              SELECT 1 FROM formulare_ord fo_chk
              WHERE fo_chk.df_id = fd.id AND fo_chk.deleted_at IS NULL
            )
          ) AS can_delete,
          (fd.created_by = $${params.push(actor.userId)}) AS "isP1",
          COUNT(*) OVER() AS total
        FROM formulare_df fd
```

## Patch 2 — `server/routes/formulare-db.mjs`: flag `can_delete` în lista ORD

În SELECT-ul listei ORD (ramura `else`), analog.

**old_str**
```
          (fo.created_by = $${params.push(actor.userId)}) AS "isP1",
          COUNT(*) OVER() AS total
        FROM formulare_ord fo
```
**new_str**
```
          (
            ${(isAdmin || isOrgAdmin) ? 'TRUE' : `fo.created_by = $${params.push(actor.userId)}`}
            AND fo.flow_id IS NULL
          ) AS can_delete,
          (fo.created_by = $${params.push(actor.userId)}) AS "isP1",
          COUNT(*) OVER() AS total
        FROM formulare_ord fo
```

## Patch 3 — `server/routes/formulare-db.mjs`: înlocuiește ruta `/anuleaza` DF cu `/sterge`

Înlocuiește integral blocul rutei `POST /api/formulare-df/:id/anuleaza` (de la comentariul-header
până la `});` de final) cu ștergere reală + relink ALOP.

**old_str**
```
// ── POST /api/formulare-df/:id/anuleaza ───────────────────────────────────────
router.post('/api/formulare-df/:id/anuleaza', _csrf, async (req, res) => {
  if (requireDb(res)) return;
  const actor = requireAuth(req, res);
  if (!actor) return;
  const { id } = req.params;
  try {
    const { rows } = await pool.query(
      `SELECT created_by, org_id, status FROM formulare_df WHERE id=$1 AND deleted_at IS NULL`,
      [id]
    );
    if (!rows.length) return res.status(404).json({ error: 'not_found' });
    const doc = rows[0];
    if (actor.role !== 'admin' && doc.org_id !== actor.orgId)
      return res.status(403).json({ error: 'forbidden' });
    {
      const authz = canDestroyOnly(actor, doc);
      if (!authz.allowed) return res.status(403).json({ error: authz.reason });
    }
    if (!['draft','pending_p2','returnat'].includes(doc.status))
      return res.status(400).json({ error: 'cannot_cancel', message: 'Doar documentele draft, transmis_p2 sau returnate pot fi anulate.' });

    await pool.query(
      `UPDATE formulare_df SET status='anulat', updated_at=NOW(), updated_by=$2 WHERE id=$1`,
      [id, actor.userId]
    );
    res.json({ ok: true });
  } catch (e) {
    logger.error({ err: e }, 'anuleaza df error');
    res.status(500).json({ error: 'server_error' });
  }
});
```
**new_str**
```
// ── POST /api/formulare-df/:id/sterge — ȘTERGERE (soft-delete) ─────────────────
// Permis dacă DF NU e pe flux (flow_id IS NULL) ȘI nu are ORD legată ne-ștearsă.
// Pentru revizii: condiția se aplică pe rândul reviziei. Relink ALOP (mirror refuse).
router.post('/api/formulare-df/:id/sterge', _csrf, async (req, res) => {
  if (requireDb(res)) return;
  const actor = requireAuth(req, res);
  if (!actor) return;
  const { id } = req.params;
  try {
    const { rows } = await pool.query(
      `SELECT created_by, org_id, status, flow_id, revizie_nr, parent_df_id, nr_unic_inreg
         FROM formulare_df WHERE id=$1 AND deleted_at IS NULL`,
      [id]
    );
    if (!rows.length) return res.status(404).json({ error: 'not_found' });
    const doc = rows[0];
    if (actor.role !== 'admin' && doc.org_id !== actor.orgId)
      return res.status(403).json({ error: 'forbidden' });
    {
      const authz = canDestroyOnly(actor, doc);
      if (!authz.allowed) return res.status(403).json({ error: authz.reason });
    }
    if (doc.flow_id)
      return res.status(409).json({ error: 'cannot_delete_on_flow', message: 'Documentul a fost trimis pe fluxul de semnare și nu poate fi șters.' });

    const { rows: ordRows } = await pool.query(
      `SELECT id, nr_ordonant_pl FROM formulare_ord WHERE df_id=$1 AND deleted_at IS NULL LIMIT 1`,
      [id]
    );
    if (ordRows.length)
      return res.status(409).json({ error: 'cannot_delete_has_ord', message: `Nu se poate șterge DF-ul: există o Ordonanțare de Plată legată (${ordRows[0].nr_ordonant_pl || 'fără nr.'}). Ștergeți întâi ORD-ul.` });

    await pool.query(
      `UPDATE formulare_df SET deleted_at=NOW(), updated_at=NOW(), updated_by=$2 WHERE id=$1`,
      [id, actor.userId]
    );

    // Relink ALOP (mirror după signing.mjs refuse): R0 → eliberează; R1+ → restore parent aprobat
    try {
      if ((doc.revizie_nr || 0) === 0 || !doc.parent_df_id) {
        await pool.query(
          `UPDATE alop_instances
             SET df_id=NULL, df_flow_id=NULL, df_completed_at=NULL, updated_at=NOW(), updated_by=$2
           WHERE df_id=$1 AND cancelled_at IS NULL`,
          [id, actor.userId]
        );
      } else {
        const { rows: parentRows } = await pool.query(
          `SELECT id, flow_id, status FROM formulare_df WHERE id=$1 AND deleted_at IS NULL LIMIT 1`,
          [doc.parent_df_id]
        );
        if (parentRows.length && parentRows[0].status === 'aprobat' && parentRows[0].flow_id) {
          await pool.query(
            `UPDATE alop_instances
               SET df_id=$1, df_flow_id=$2, df_completed_at=NOW(), updated_at=NOW(), updated_by=$4
             WHERE df_id=$3 AND cancelled_at IS NULL`,
            [parentRows[0].id, parentRows[0].flow_id, id, actor.userId]
          );
        } else {
          await pool.query(
            `UPDATE alop_instances
               SET df_id=NULL, df_flow_id=NULL, df_completed_at=NULL, updated_at=NOW(), updated_by=$2
             WHERE df_id=$1 AND cancelled_at IS NULL`,
            [id, actor.userId]
          );
        }
      }
    } catch (relinkErr) {
      logger.error({ err: relinkErr, dfId: id }, 'sterge df: ALOP relink failed (non-fatal)');
    }

    res.json({ ok: true });
  } catch (e) {
    logger.error({ err: e }, 'sterge df error');
    res.status(500).json({ error: 'server_error' });
  }
});
```

## Patch 4 — `server/routes/formulare-db.mjs`: înlocuiește ruta `/anuleaza` ORD cu `/sterge`

**old_str**
```
// ── POST /api/formulare-ord/:id/anuleaza ──────────────────────────────────────
router.post('/api/formulare-ord/:id/anuleaza', _csrf, async (req, res) => {
  if (requireDb(res)) return;
  const actor = requireAuth(req, res);
  if (!actor) return;
  const { id } = req.params;
  try {
    const { rows } = await pool.query(
      `SELECT created_by, org_id, status FROM formulare_ord WHERE id=$1 AND deleted_at IS NULL`,
      [id]
    );
    if (!rows.length) return res.status(404).json({ error: 'not_found' });
    const doc = rows[0];
    if (actor.role !== 'admin' && doc.org_id !== actor.orgId)
      return res.status(403).json({ error: 'forbidden' });
    {
      const authz = canDestroyOnly(actor, doc);
      if (!authz.allowed) return res.status(403).json({ error: authz.reason });
    }
    if (!['draft','pending_p2','returnat'].includes(doc.status))
      return res.status(400).json({ error: 'cannot_cancel', message: 'Doar documentele draft, transmis_p2 sau returnate pot fi anulate.' });

    await pool.query(
      `UPDATE formulare_ord SET status='anulat', updated_at=NOW(), updated_by=$2 WHERE id=$1`,
      [id, actor.userId]
    );
    res.json({ ok: true });
  } catch (e) {
    logger.error({ err: e }, 'anuleaza ord error');
    res.status(500).json({ error: 'server_error' });
  }
});
```
**new_str**
```
// ── POST /api/formulare-ord/:id/sterge — ȘTERGERE (soft-delete) ────────────────
// Permis dacă ORD NU a fost trimisă pe flux (flow_id IS NULL). Relink ALOP (eliberează ord_id).
router.post('/api/formulare-ord/:id/sterge', _csrf, async (req, res) => {
  if (requireDb(res)) return;
  const actor = requireAuth(req, res);
  if (!actor) return;
  const { id } = req.params;
  try {
    const { rows } = await pool.query(
      `SELECT created_by, org_id, status, flow_id FROM formulare_ord WHERE id=$1 AND deleted_at IS NULL`,
      [id]
    );
    if (!rows.length) return res.status(404).json({ error: 'not_found' });
    const doc = rows[0];
    if (actor.role !== 'admin' && doc.org_id !== actor.orgId)
      return res.status(403).json({ error: 'forbidden' });
    {
      const authz = canDestroyOnly(actor, doc);
      if (!authz.allowed) return res.status(403).json({ error: authz.reason });
    }
    if (doc.flow_id)
      return res.status(409).json({ error: 'cannot_delete_on_flow', message: 'Ordonanțarea a fost trimisă pe fluxul de semnare și nu poate fi ștearsă.' });

    await pool.query(
      `UPDATE formulare_ord SET deleted_at=NOW(), updated_at=NOW(), updated_by=$2 WHERE id=$1`,
      [id, actor.userId]
    );

    // Relink ALOP: eliberează ord_id → butonul "Completează Ordonanțare" reapare
    try {
      await pool.query(
        `UPDATE alop_instances
           SET ord_id=NULL, ord_flow_id=NULL, ord_completed_at=NULL, updated_at=NOW(), updated_by=$2
         WHERE ord_id=$1 AND cancelled_at IS NULL`,
        [id, actor.userId]
      );
    } catch (relinkErr) {
      logger.error({ err: relinkErr, ordId: id }, 'sterge ord: ALOP relink failed (non-fatal)');
    }

    res.json({ ok: true });
  } catch (e) {
    logger.error({ err: e }, 'sterge ord error');
    res.status(500).json({ error: 'server_error' });
  }
});
```

## Patch 5 — `server/routes/alop.mjs`: ștergere ALOP blocată și de ORD legat

Extinde verificarea de blocare din `POST /api/alop/:id/cancel` să cuprindă și `ord_id`
(păstrează codul de eroare `cancel_blocked_df_exists` și forma răspunsului pentru DF — testele
existente depind de ele; **nu schimba numărul de query-uri**, doar lărgește SELECT-ul existent
și adaugă o ramură separată pentru ORD).

**old_str**
```
    // v3.9.498 (Issue R-B): block cancel dacă ALOP are DF emis (df_id setat
    // și DF ne-șters). Refuze (R0) eliberează df_id=NULL → cancel redevine
    // permis. Simetric cu logica refuse din v3.9.497.
    const { rows: dfCheck } = await pool.query(`
      SELECT a.df_id, fd.nr_unic_inreg, fd.status AS df_status
      FROM alop_instances a
      LEFT JOIN formulare_df fd ON fd.id = a.df_id AND fd.deleted_at IS NULL
      WHERE a.id=$1 AND a.org_id=$2
    `, [req.params.id, actor.orgId]);
    if (dfCheck[0]?.df_id && dfCheck[0]?.df_status) {
      return res.status(409).json({
        error: 'cancel_blocked_df_exists',
        message: `Nu se poate anula ALOP-ul: există un DF emis (${dfCheck[0].nr_unic_inreg || 'fără nr.'}, status: ${dfCheck[0].df_status}). Anulați sau refuzați DF-ul mai întâi.`,
        df_id: dfCheck[0].df_id,
        df_nr: dfCheck[0].nr_unic_inreg,
        df_status: dfCheck[0].df_status,
      });
    }
```
**new_str**
```
    // ALOP se poate ȘTERGE doar dacă NU are DF/ORD legat (pe documente ne-șterse).
    // Păstrăm codul cancel_blocked_df_exists pentru DF (compat. clienți + teste);
    // adăugăm ramura ORD. Refuzul (R0) eliberează df_id=NULL → ștergerea redevine permisă.
    const { rows: dfCheck } = await pool.query(`
      SELECT a.df_id, a.ord_id,
             fd.nr_unic_inreg, fd.status AS df_status,
             fo.nr_ordonant_pl AS ord_nr, fo.status AS ord_status
      FROM alop_instances a
      LEFT JOIN formulare_df  fd ON fd.id = a.df_id  AND fd.deleted_at IS NULL
      LEFT JOIN formulare_ord fo ON fo.id = a.ord_id AND fo.deleted_at IS NULL
      WHERE a.id=$1 AND a.org_id=$2
    `, [req.params.id, actor.orgId]);
    if (dfCheck[0]?.df_id && dfCheck[0]?.df_status) {
      return res.status(409).json({
        error: 'cancel_blocked_df_exists',
        message: `Nu se poate șterge ALOP-ul: există un DF legat (${dfCheck[0].nr_unic_inreg || 'fără nr.'}, status: ${dfCheck[0].df_status}). Ștergeți sau refuzați DF-ul mai întâi.`,
        df_id: dfCheck[0].df_id,
        df_nr: dfCheck[0].nr_unic_inreg,
        df_status: dfCheck[0].df_status,
      });
    }
    if (dfCheck[0]?.ord_id && dfCheck[0]?.ord_status) {
      return res.status(409).json({
        error: 'cancel_blocked_ord_exists',
        message: `Nu se poate șterge ALOP-ul: există o Ordonanțare de Plată legată (${dfCheck[0].ord_nr || 'fără nr.'}, status: ${dfCheck[0].ord_status}). Ștergeți întâi ORD-ul.`,
        ord_id: dfCheck[0].ord_id,
        ord_nr: dfCheck[0].ord_nr,
        ord_status: dfCheck[0].ord_status,
      });
    }
```

## Patch 6 — `public/js/formular/list.js`: buton ȘTERGE pe baza `can_delete`

### 6a — condiția + butonul (în `_renderLstTable`)

**old_str**
```
    const canCancel=row.status==='draft'||(row.status==='pending_p2'&&row.isP1);
    const cancelBtn=canCancel
      ?`<button class="df-action-btn danger sm" onclick="anuleazaDoc('${type}','${esc(row.id)}')" title="Anulează">🚫</button>`
      :'';
```
**new_str**
```
    const canDelete=row.can_delete===true;
    const cancelBtn=canDelete
      ?`<button class="df-action-btn danger sm" onclick="stergeDoc('${type}','${esc(row.id)}')" title="Șterge">🗑</button>`
      :'';
```

### 6b — funcția (înlocuiește `anuleazaDoc`)

**old_str**
```
async function anuleazaDoc(type,id){
  if(!confirm('Anulați acest document? Operațiunea nu poate fi inversată.'))return;
  try{
    const r=await fetch(`/api/formulare-${type}/${id}/anuleaza`,{
      method:'POST',credentials:'include',
      headers:{'X-CSRF-Token':df.getCsrf()},
    });
    const j=await r.json();
    if(!r.ok||!j.ok){alert(j.error||'Eroare la anulare');return;}
    loadList();
  }catch(e){alert('Eroare: '+e.message);}
}
```
**new_str**
```
async function stergeDoc(type,id){
  const eticheta=type==='ord'?'ordonanțare':'document de fundamentare';
  if(!confirm(`Ștergeți acest ${eticheta}? Operațiunea nu poate fi inversată.`))return;
  try{
    const r=await fetch(`/api/formulare-${type}/${id}/sterge`,{
      method:'POST',credentials:'include',
      headers:{'X-CSRF-Token':df.getCsrf()},
    });
    const j=await r.json();
    if(!r.ok||!j.ok){
      const msg=j.message||({
        cannot_delete_on_flow:'Documentul este pe fluxul de semnare și nu poate fi șters.',
        cannot_delete_has_ord:'Există o ORD legată — ștergeți întâi ORD-ul.',
      }[j.error])||j.error||'Eroare la ștergere';
      alert(msg);
      return;
    }
    loadList();
  }catch(e){alert('Eroare: '+e.message);}
}
```

### 6c — export global (verifică numele în blocul de `window.*` din list.js)

**old_str**
```
  window.loadDfAprobate         = loadDfAprobate;
```
**new_str**
```
  window.stergeDoc              = stergeDoc;
  window.loadDfAprobate         = loadDfAprobate;
```

> Dacă există vreun alt `window.anuleazaDoc = anuleazaDoc;` în list.js, elimină-l (grep verificare mai jos).

## Patch 7 — `public/js/formular/alop.js`: ALOP "Anulează" → "Șterge"

### 7a — condiția în lista ALOP

**old_str**
```
      const active=a.status!=='completed'&&a.status!=='cancelled';
      // v3.9.498 (Issue R-B): blochăm cancel dacă DF emis (df_id setat)
      const canCancel=active&&!a.df_id;
```
**new_str**
```
      const active=a.status!=='completed'&&a.status!=='cancelled';
      // Ștergere permisă doar dacă ALOP nu are DF/ORD legat
      const canCancel=active&&!a.df_id&&!a.ord_id;
```

### 7b — butonul din listă (titlu)

**old_str**
```
          ${canCancel?`<button class="df-action-btn danger sm" style="margin-left:4px" onclick="cancelAlop('${esc(a.id)}')" title="Anulează ALOP">✕</button>`:''}
```
**new_str**
```
          ${canCancel?`<button class="df-action-btn danger sm" style="margin-left:4px" onclick="cancelAlop('${esc(a.id)}')" title="Șterge ALOP">🗑</button>`:''}
```

### 7c — butonul din detaliu (blochează și pe ord_id, relabel)

**old_str**
```
    // v3.9.498 (Issue R-B): ascunde Anulează când DF emis (df_id setat)
    if(!a.df_id){
      actionsHtml+=`<button class="df-action-btn danger" onclick="cancelAlop('${id}')">${_alopIcoBtn('ico-x')}Anulează</button>`;
    }
```
**new_str**
```
    // Ștergere ascunsă când ALOP are DF/ORD legat
    if(!a.df_id&&!a.ord_id){
      actionsHtml+=`<button class="df-action-btn danger" onclick="cancelAlop('${id}')">${_alopIcoBtn('ico-trash')}Șterge</button>`;
    }
```

> Dacă `ico-trash` nu există în `public/icons.svg`, păstrează `ico-x`. Verifică:
> `grep -c 'id="ico-trash"' public/icons.svg` — dacă 0, lasă `ico-x` în patch-ul 7c.

### 7d — confirm + handler eroare în `cancelAlop`

**old_str**
```
async function cancelAlop(id){
  if(!confirm('Anulezi acest ALOP? Documentele DF/ORD nu vor fi șterse.'))return;
  try{
    const r=await fetch(`/api/alop/${encodeURIComponent(id)}/cancel`,{
      method:'POST',credentials:'include',headers:{'X-CSRF-Token':df.getCsrf()},
    });
    const data=await r.json();
    if(!r.ok){
      // v3.9.498 (Issue R-B): mesaj user-friendly pentru block-ul DF
      if(data.error==='cancel_blocked_df_exists'){
        alert(data.message||'ALOP nu poate fi anulat: există DF emis.');
        return;
      }
      throw new Error(data.error||'server_error');
    }
    closeAlopDetail();loadAlop();loadAlopStats();
  }catch(e){alert('Eroare: '+e.message);}
}
```
**new_str**
```
async function cancelAlop(id){
  if(!confirm('Ștergeți acest ALOP? Operațiunea nu poate fi inversată.'))return;
  try{
    const r=await fetch(`/api/alop/${encodeURIComponent(id)}/cancel`,{
      method:'POST',credentials:'include',headers:{'X-CSRF-Token':df.getCsrf()},
    });
    const data=await r.json();
    if(!r.ok){
      if(data.error==='cancel_blocked_df_exists'||data.error==='cancel_blocked_ord_exists'){
        alert(data.message||'ALOP nu poate fi șters: are DF/ORD legat.');
        return;
      }
      throw new Error(data.error||'server_error');
    }
    closeAlopDetail();loadAlop();loadAlopStats();
  }catch(e){alert('Eroare: '+e.message);}
}
```

---

## Verificări grep (rulează după patch-uri, înainte de commit)

```bash
# Rutele vechi /anuleaza nu mai există nicăieri
grep -rn "/anuleaza" server/ public/ ; echo "↑ trebuie GOL"

# Rutele noi /sterge există
grep -n "formulare-df/:id/sterge\|formulare-ord/:id/sterge" server/routes/formulare-db.mjs

# Frontend folosește /sterge + stergeDoc
grep -n "stergeDoc\|/sterge" public/js/formular/list.js
grep -rn "anuleazaDoc" public/ ; echo "↑ trebuie GOL"

# can_delete returnat în ambele ramuri de listă
grep -n "AS can_delete" server/routes/formulare-db.mjs   # trebuie 2 hit-uri

# ALOP blochează și pe ord_id
grep -n "cancel_blocked_ord_exists" server/routes/alop.mjs public/js/formular/alop.js

# ALOP UI ascunde ștergerea pe df_id SAU ord_id
grep -n "!a.df_id&&!a.ord_id" public/js/formular/alop.js   # trebuie 2 hit-uri (listă + detaliu)

# NU s-a atins niciun fișier de semnare
git diff --name-only | grep -E "signing\.mjs|bulk-signing|cloud-signing|pades\.mjs|java-pades|STSCloudProvider" ; echo "↑ trebuie GOL"
```

## Cache-busting + version bump (un singur commit)

`list.js`, `alop.js`, `doc.js` NU sunt în `PRECACHE_ASSETS` din `public/sw.js` → **NU** bump-ezi `CACHE_VERSION`.
Doar:

```bash
OLD=3.9.518 ; NEW=3.9.519
# package.json
sed -i "s/\"version\": \"$OLD\"/\"version\": \"$NEW\"/" package.json
# query-param ?v= pe toate link-urile din formular.html
sed -i "s/?v=$OLD/?v=$NEW/g" public/formular.html
grep -c "?v=$NEW" public/formular.html   # confirmă că toate au noua versiune
```

## Teste

```bash
npm test
```

Trebuie **verde, fără regresii**. Atenție specială:
- `server/tests/integration/alop-cancel-block-df.test.mjs` — mock-urile dau 2 query-uri
  (SELECT created_by + SELECT df check); patch-ul 5 păstrează 2 query-uri și codul
  `cancel_blocked_df_exists` cu aceeași formă → trebuie să treacă neatins.
- `server/tests/integration/df-refuse-restore.test.mjs`, `cancel-restore.test.mjs` — NU sunt
  atinse (lucrează pe `/flows/:id/cancel`, nu pe ștergerea DF/ORD).

Dacă vrei acoperire în plus (opțional, recomandat): adaugă un test nou
`server/tests/integration/sterge-df-ord.test.mjs` cu cazurile:
- ORD cu `flow_id` setat → 409 `cannot_delete_on_flow`
- ORD `flow_id=NULL` → 200 + UPDATE deleted_at + relink ALOP (ord_id=NULL)
- DF cu ORD legată → 409 `cannot_delete_has_ord`
- DF `flow_id=NULL`, fără ORD, R0 → 200 + ALOP df_id=NULL
- DF R1+ → restore parent aprobat (df_id=parent, df_flow_id=parent.flow_id)

(folosește pattern-ul de mock din testele ALOP existente: secvență `mockResolvedValueOnce`).

---

## RAPORT FINAL (completează după execuție)

- [ ] Versiune: 3.9.518 → 3.9.519 (package.json + ?v= în formular.html)
- [ ] Patch 1–2: `can_delete` în listele DF + ORD (2 hit-uri `AS can_delete`)
- [ ] Patch 3: DF `/anuleaza` → `/sterge` (soft-delete + relink ALOP R0/R1+)
- [ ] Patch 4: ORD `/anuleaza` → `/sterge` (soft-delete + relink ALOP ord_id)
- [ ] Patch 5: ALOP cancel blochează și pe ord_id (`cancel_blocked_ord_exists`)
- [ ] Patch 6: list.js buton 🗑 + `stergeDoc` + export
- [ ] Patch 7: alop.js buton 🗑 listă + detaliu + confirm/handler
- [ ] grep: `/anuleaza` și `anuleazaDoc` → GOL
- [ ] grep: fișiere semnare în diff → GOL
- [ ] `npm test` → verde, fără regresii (raportează nr. teste passed)
- [ ] git: commit + push **doar pe develop**

Format commit sugerat:
```
feat(alop/df/ord): anulare → ștergere reală cu condiții (flow_id/ORD/DF) + relink ALOP

- DF/ORD: /anuleaza → /sterge (soft-delete via deleted_at)
  · ORD ștearsă doar dacă nu e pe flux (flow_id IS NULL)
  · DF șters doar dacă nu e pe flux ȘI nu are ORD legată; relink ALOP (mirror refuse)
- ALOP: ștergere blocată dacă are DF SAU ORD legat (cancel_blocked_ord_exists)
- listă: flag can_delete server-side; buton 🗑 în loc de 🚫/✕
- v3.9.519
```
```
```
