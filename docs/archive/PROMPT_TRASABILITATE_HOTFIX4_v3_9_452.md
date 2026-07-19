# DocFlowAI — 🩹 TRASABILITATE HOTFIX 4: valoare DF + total plătit corect (v3.9.452)

```
═══════════════════════════════════════════════════════════
⚠️  BRANCH: develop ONLY. NU FACE merge / push / checkout pe main.
═══════════════════════════════════════════════════════════
```

> Hotfix peste v3.9.451. Modal funcționează vizual, dar 2 probleme funcționale:
>
> **P1** — Card DF nu afișează valoarea financiară a documentului
> **P2** — ALOP arată „Plătit: 0,00 lei" deși ORD afișează plata efectivă 250.000 lei
>          (am folosit `suma_totala_platita` simplu în loc de pattern-ul canonic
>          `COALESCE(suma_totala_platita,0) + COALESCE(plata_suma_efectiva,0)`)

```
DocFlowAI v3.9.451 → v3.9.452 (SW v167 → v168)
Branch: develop  ⚠️ EXCLUSIV develop
Subiect: fix(trasabilitate): valoare DF + formula plată ALOP cu ciclul curent

═══════════════════════════════════════════════════════════
CONTEXT — discrepanța plată
═══════════════════════════════════════════════════════════

Formula canonică (verificată în server/routes/alop.mjs linia ~total_platit
și ~suma_platita_total) este:

  total_platit = COALESCE(suma_totala_platita, 0) + COALESCE(plata_suma_efectiva, 0)

Pentru că:
  - suma_totala_platita = cumulat din ciclurile ARHIVATE (rolled-in la 'noua lichidare')
  - plata_suma_efectiva = plata din CICLUL CURENT (NULL după ce e arhivat)

Bug-ul meu: am folosit doar a.suma_totala_platita = 0 (ciclul curent încă activ,
plata ne-arhivată), deci ALOP afișa 0. Dar plata_suma_efectiva = 250.000 era
populat. Trebuia formula compusă.

Verificarea „nu se leaga" — confirmat: ALOP.ord_id corect leagă la ORD-ul
afișat. ALOP.df_id corect leagă la DF-ul afișat. Toate relațiile sunt OK.
Discrepanța vine DOAR din formula greșită de calcul al plății.

═══════════════════════════════════════════════════════════
PASUL 1 — service/trasabilitate.mjs: adaug calcul valoare DF în Q2
═══════════════════════════════════════════════════════════

În Q2 (toate reviziile DF), adaug coloana derivată cu SUM peste rows_ctrl[].sum_rezv_crdt_bug_act.

old_str:
    const { rows } = await pool.query(
      `SELECT fd.id, fd.nr_unic_inreg, fd.subtitlu_df AS titlu,
              COALESCE(fd.revizie_nr, 0) AS revizie_nr,
              COALESCE(fd.este_revizie, FALSE) AS este_revizie,
              fd.status, fd.flow_id, fd.created_at, fd.updated_at,
              CASE WHEN fd.flow_id IS NOT NULL
                   AND (f.data->>'status' = 'completed' OR (f.data->>'completed')::boolean = true)
                   THEN TRUE ELSE FALSE END AS aprobat
         FROM formulare_df fd
         LEFT JOIN flows f ON f.id::text = fd.flow_id
        WHERE fd.nr_unic_inreg = $1
          AND fd.org_id = $2
          AND fd.deleted_at IS NULL
        ORDER BY fd.revizie_nr ASC NULLS FIRST`,
      [dfNrUnic, orgId]
    );

new_str:
    const { rows } = await pool.query(
      `SELECT fd.id, fd.nr_unic_inreg, fd.subtitlu_df AS titlu,
              COALESCE(fd.revizie_nr, 0) AS revizie_nr,
              COALESCE(fd.este_revizie, FALSE) AS este_revizie,
              fd.status, fd.flow_id, fd.created_at, fd.updated_at,
              CASE WHEN fd.flow_id IS NOT NULL
                   AND (f.data->>'status' = 'completed' OR (f.data->>'completed')::boolean = true)
                   THEN TRUE ELSE FALSE END AS aprobat,
              COALESCE(
                (SELECT SUM(NULLIF(r->>'sum_rezv_crdt_bug_act', '')::numeric)
                   FROM jsonb_array_elements(COALESCE(fd.rows_ctrl, '[]'::jsonb)) r),
                0
              ) AS valoare_totala
         FROM formulare_df fd
         LEFT JOIN flows f ON f.id::text = fd.flow_id
        WHERE fd.nr_unic_inreg = $1
          AND fd.org_id = $2
          AND fd.deleted_at IS NULL
        ORDER BY fd.revizie_nr ASC NULLS FIRST`,
      [dfNrUnic, orgId]
    );

PASUL 1.2 — Adaugă valoarea în map-area dfRevizii:

old_str:
    dfRevizii = rows.map(r => ({
      id:               r.id,
      nr_unic_inreg:    r.nr_unic_inreg,
      titlu:            r.titlu || '',
      revizie_nr:       Number(r.revizie_nr),
      este_revizie:     r.este_revizie,
      status:           r.status,
      aprobat:          r.aprobat,
      created_at:       r.created_at,
      updated_at:       r.updated_at,
      is_root_df:       type === 'df'  && r.id === id,
      is_root_df_link:  type === 'ord' && r.id === dfRootId,
    }));

new_str:
    dfRevizii = rows.map(r => ({
      id:               r.id,
      nr_unic_inreg:    r.nr_unic_inreg,
      titlu:            r.titlu || '',
      revizie_nr:       Number(r.revizie_nr),
      este_revizie:     r.este_revizie,
      status:           r.status,
      aprobat:          r.aprobat,
      valoare:          r.valoare_totala !== null ? Number(r.valoare_totala) : 0,
      created_at:       r.created_at,
      updated_at:       r.updated_at,
      is_root_df:       type === 'df'  && r.id === id,
      is_root_df_link:  type === 'ord' && r.id === dfRootId,
    }));

═══════════════════════════════════════════════════════════
PASUL 2 — service/trasabilitate.mjs: fix calcul total plătit ALOP
═══════════════════════════════════════════════════════════

Schimb formula în map-area alopuri ca să includă plata din ciclul curent.

old_str:
    suma_totala_platita: a.suma_totala_platita !== null ? Number(a.suma_totala_platita) : null,

new_str:
    // Pattern canonic (vezi server/routes/alop.mjs total_platit / suma_platita_total):
    //   suma_totala_platita (cicluri arhivate) + plata_suma_efectiva (ciclu curent dacă confirmat)
    suma_totala_platita: (Number(a.suma_totala_platita || 0))
                       + (a.plata_confirmed_at && a.plata_suma_efectiva !== null
                          ? Number(a.plata_suma_efectiva) : 0),

═══════════════════════════════════════════════════════════
PASUL 3 — Frontend: afișez valoarea DF în card-ul DOCUMENT DE FUNDAMENTARE
═══════════════════════════════════════════════════════════

În public/js/formular/trasabilitate.js, în funcția _renderDFCard:

old_str:
  // ── Render — card DF cu badges revizii ──────────────────────────────────────
  function _renderDFCard(revizii) {
    const last = revizii[revizii.length - 1];
    const titlu = last.titlu || '(fără subtitlu)';

    const badgesHtml = revizii.map(rv => {
      const isRoot = rv.is_root_df || rv.is_root_df_link;
      const cls = isRoot ? 'trasab-rev-badge trasab-rev-badge-root' : 'trasab-rev-badge';
      const aprobIcon = rv.aprobat ? '✓' : '⏳';
      const tooltip = (rv.titlu||'') + (rv.aprobat ? ' (aprobat)' : ' (în curs)');
      return `<button type="button" class="${cls}"
                data-trasab-type="df" data-trasab-id="${esc(rv.id)}"
                title="${esc(tooltip)}">R${rv.revizie_nr} ${aprobIcon}${isRoot ? ' <span class="trasab-here">●</span>' : ''}</button>`;
    }).join('');

    return `<div class="trasab-card trasab-card-df">
      <div class="trasab-card-icon">📄</div>
      <div class="trasab-card-body">
        <div class="trasab-card-kicker">DOCUMENT DE FUNDAMENTARE</div>
        <div class="trasab-card-title">${esc(last.nr_unic_inreg || '—')}</div>
        <div class="trasab-card-subtitle">${esc(titlu)}</div>
        <div class="trasab-card-badges-row">
          <span class="trasab-card-badges-label">Revizii:</span> ${badgesHtml}
        </div>
      </div>
    </div>`;
  }

new_str:
  // ── Render — card DF cu badges revizii ──────────────────────────────────────
  function _renderDFCard(revizii) {
    const last = revizii[revizii.length - 1];
    const titlu = last.titlu || '(fără subtitlu)';
    const valoare = last.valoare !== undefined && last.valoare !== null ? Number(last.valoare) : 0;
    const valoareLabel = valoare > 0
      ? `<div class="trasab-card-meta">Valoare angajament: <strong>${_formatRO(valoare)} lei</strong></div>`
      : '';

    const badgesHtml = revizii.map(rv => {
      const isRoot = rv.is_root_df || rv.is_root_df_link;
      const cls = isRoot ? 'trasab-rev-badge trasab-rev-badge-root' : 'trasab-rev-badge';
      const aprobIcon = rv.aprobat ? '✓' : '⏳';
      const valTxt = rv.valoare > 0 ? ` · ${_formatRO(rv.valoare)} lei` : '';
      const tooltip = (rv.titlu||'') + (rv.aprobat ? ' (aprobat)' : ' (în curs)') + valTxt;
      return `<button type="button" class="${cls}"
                data-trasab-type="df" data-trasab-id="${esc(rv.id)}"
                title="${esc(tooltip)}">R${rv.revizie_nr} ${aprobIcon}${isRoot ? ' <span class="trasab-here">●</span>' : ''}</button>`;
    }).join('');

    return `<div class="trasab-card trasab-card-df">
      <div class="trasab-card-icon">📄</div>
      <div class="trasab-card-body">
        <div class="trasab-card-kicker">DOCUMENT DE FUNDAMENTARE</div>
        <div class="trasab-card-title">${esc(last.nr_unic_inreg || '—')}</div>
        <div class="trasab-card-subtitle">${esc(titlu)}</div>
        ${valoareLabel}
        <div class="trasab-card-badges-row">
          <span class="trasab-card-badges-label">Revizii:</span> ${badgesHtml}
        </div>
      </div>
    </div>`;
  }

═══════════════════════════════════════════════════════════
PASUL 4 — Cache busting (3.9.451 → 3.9.452, SW v167 → v168)
═══════════════════════════════════════════════════════════

4.1 — package.json:
  old_str:   "version": "3.9.451",
  new_str:   "version": "3.9.452",

4.2 — public/sw.js:
  old_str: const CACHE_VERSION = 'docflowai-v167';
  new_str: const CACHE_VERSION = 'docflowai-v168';

4.3 — Cache busting în 4 HTML-uri (CRITIC: trasabilitate.js?v= bump):

  for f in public/formular.html public/refnec-form.html \
           public/notafd-invest-form.html public/admin.html; do
    sed -i 's/v=3\.9\.451/v=3.9.452/g' "$f"
  done

  Verifică:
  for f in public/formular.html public/refnec-form.html \
           public/notafd-invest-form.html public/admin.html; do
    OLD=$(grep -oE "v=3\.9\.4[0-9]{2}" "$f" | grep -v "v=3.9.452" | wc -l)
    NEW=$(grep -c "v=3.9.452" "$f")
    [ "$OLD" -eq 0 ] && [ "$NEW" -gt 0 ] && echo "OK $f ($NEW refs)" || echo "FAIL $f"
  done

═══════════════════════════════════════════════════════════
VERIFICARE OBLIGATORIE
═══════════════════════════════════════════════════════════

1. Backend SQL include valoarea DF:
   grep -c "sum_rezv_crdt_bug_act.*numeric" server/services/trasabilitate.mjs
   → 1 (în Q2)
   grep -c "AS valoare_totala" server/services/trasabilitate.mjs
   → 1

2. Backend formula plată corectă:
   grep -c "plata_confirmed_at && a.plata_suma_efectiva" server/services/trasabilitate.mjs
   → 1
   grep -c "Pattern canonic.*alop.mjs" server/services/trasabilitate.mjs
   → 1

3. Frontend afișează valoarea:
   grep -c "Valoare angajament:" public/js/formular/trasabilitate.js
   → 1

4. Sintaxă + teste:
   node --check server/services/trasabilitate.mjs
   node --check public/js/formular/trasabilitate.js
   npm run check
   npm test verde, fără regresii

═══════════════════════════════════════════════════════════
COMMIT pe develop  ⚠️ NU MAIN!
═══════════════════════════════════════════════════════════
git add server/services/trasabilitate.mjs \
        public/js/formular/trasabilitate.js \
        public/formular.html \
        public/refnec-form.html \
        public/notafd-invest-form.html \
        public/admin.html \
        public/sw.js \
        package.json

git commit -m "fix(trasabilitate): valoare DF + formula plata ALOP cu ciclul curent (v3.9.452)

Doua bug-uri funcționale rezolvate:

P1 - Card DF nu afișează valoarea financiară
  Adaugat în Q2 SUM peste rows_ctrl[].sum_rezv_crdt_bug_act (col.10 Sec.B,
  consistent cu Clasa 8 angajamente bugetare).
  Frontend afișează 'Valoare angajament: X lei' în card-ul DOCUMENT DE
  FUNDAMENTARE, sub subtitlu.

P2 - ALOP afișa 'Plătit: 0,00' deși plata era confirmată în ciclul curent
  Bug în formula de calcul: am folosit doar a.suma_totala_platita care
  reflectă DOAR ciclurile arhivate (rolled-in la 'noua lichidare').
  Plata din ciclul curent activ rămâne în a.plata_suma_efectiva până
  când ciclul e arhivat.

  Fix: aplicat pattern canonic din server/routes/alop.mjs (linia
  total_platit / suma_platita_total):
    COALESCE(suma_totala_platita, 0) + COALESCE(plata_suma_efectiva, 0)
  în map-area alopuri, condiționat pe plata_confirmed_at IS NOT NULL.

Verificat că nu se leagă greșit (ord_id, df_id) — relațiile sunt OK,
discrepanța era doar din formula incorectă.

Cache: package 3.9.451 → 3.9.452, SW v167 → v168, 4 HTML-uri bumpate."

git push origin develop  # ⚠️ NU origin main

═══════════════════════════════════════════════════════════
TEST POST-DEPLOY (staging)
═══════════════════════════════════════════════════════════

1. Hard refresh (Ctrl+Shift+R) → click 🔗 pe DF-ul cu ALOP plătit (cel
   din screenshot anterior: 1234 Servicii curatenie / 250.000 lei).

2. În card DF: TREBUIE să apară:
   'Valoare angajament: 250.000,00 lei' (sau valoarea exact din Sec.B col.10)

3. În card ALOP: TREBUIE să apară:
   'Plătit: 250.000,00 lei' (NU 0,00 ca înainte)

4. Tooltip pe badge revizie (hover): trebuie să arate „R0 (aprobat) · 250.000,00 lei"
   (sau valoarea per revizie).

5. Test pe ALOP cu cicluri arhivate + plată în ciclul curent:
   total = SUM(plățile arhivate) + plata curentă confirmată

STOP dacă:
- ALOP tot 0,00 → verifică în Network response că suma_totala_platita
  vine corect calculat (în devtools Response, alopuri[0].suma_totala_platita)
- Valoare DF lipsește → SUM SQL eșuat; verifică `rows_ctrl` pe DF-ul
  respectiv (poate fi gol pentru DF-uri vechi fără Sec.B completat)
```
