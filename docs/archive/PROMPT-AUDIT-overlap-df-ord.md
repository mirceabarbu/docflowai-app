---
id: AUDIT-FIX
titlu: Bugfix — suprapunere text în auditul PDF DF/ORD (jurnal evenimente)
model_suggested: Sonnet 4.6 / Default   # fix de layout PDF bine delimitat, un singur fișier
branch: develop
bump: 3.9.709   # backend-only (generare PDF server-side), FĂRĂ cache/?v= bump
---

⚠️⚠️⚠️ BRANCH: **develop** — EXCLUSIV. NU merge/push/checkout pe `main` (= PRODUCȚIE, manual, Mircea).

===============================================================================
CONTEXT (bug confirmat vizual + diagnostic pe cod — nu re-investiga)
===============================================================================

În auditul PDF pentru DF și ORD („AUDIT FORMULAR"), textul din coloana „detail" a
jurnalului de evenimente se SUPRAPUNE peste evenimentul următor când e lung (ex.
evenimentul NEAPROBAT: `de:... completed -> neaprobat via:flux_refuzat flowId:...`
împreună cu `alop_id:...` de la LEGAT DE ALOP se revarsă peste rândul REVIZUIT).

Cauza (verificată) — `server/routes/formulare/shared.mjs`, bucla jurnalului (~liniile
790-802): avansează cu `y -= 14` FIX per eveniment, dar `detail` e desenat cu `maxWidth`
și se împarte pe MAI MULTE linii. Înălțimea rândului nu ține cont de câte linii ocupă →
suprapunere. Exact bug-ul pe care l-am rezolvat DEJA la auditul fluxurilor.

FIX = oglindește soluția din auditul fluxurilor (`server/routes/admin/flows.mjs`,
funcția `renderEvent`, ~liniile 846-887): un helper `estimateLines()` + înălțime de rând
dinamică `rowH` + `lineHeight` pe `drawText`. NU inventa altă abordare — copiază pattern-ul
dovedit.

⚠️ TRADUCERI: verificat — `FORMULAR_AUDIT_LABELS` (shared.mjs:659) acoperă toate event_type-urile
și `evLabel` are fallback. NIMIC de schimbat la traduceri. NU atinge dicționarul.

===============================================================================
PAS 1 — Adaugă helper-ul estimateLines în shared.mjs (mirror flows.mjs)
===============================================================================

Verifică întâi forma reală a buclei (liniile pot diferi):
    grep -n "JURNAL EVENIMENTE\|EVENT_FONT_SIZE\|COL_DETAIL\|y -= 14" server/routes/formulare/shared.mjs

ÎNAINTE de bucla `for (const e of sorted)`, definește helper-ul (identic cu cel din
`admin/flows.mjs`):

    // Estimează câte linii ocupă un text la lățimea max și fontul dat (mirror admin/flows.mjs)
    const estimateLines = (text, maxW, font, size) => {
      if (!text) return 0;
      const words = text.split(' ');
      let lines = 1, lineW = 0;
      for (const w of words) {
        const wW = font.widthOfTextAtSize(w + ' ', size);
        if (lineW + wW > maxW && lineW > 0) { lines++; lineW = wW; }
        else { lineW += wW; }
      }
      return lines;
    };
    const EVENT_LINE_H = 12;   // spațiere per linie (≈ FONT_SIZE 8 + aer)

(EVENT_LINE_H ~12 pentru FONT_SIZE 8 din DF/ORD; la fluxuri e 11 pt font 7.5 — scalează.)

===============================================================================
PAS 2 — Înlocuiește avansul fix `y -= 14` cu înălțime de rând dinamică
===============================================================================

În corpul buclei `for (const e of sorted)`:
 • Calculează liniile detaliului ÎNAINTE de desenare și rezervă spațiul corect:

old_str (bucla actuală — adaptează dacă diferă la grep):
      for (const e of sorted) {
        ensureSpace(16);
        const transition = (e.from_status || e.to_status)
          ? `${e.from_status || '—'} -> ${e.to_status || '—'}` : '';
        const metaStr = e.meta && Object.keys(e.meta).length
          ? Object.entries(e.meta).map(([k, v]) => `${k}:${v}`).join(' ') : '';
        const detail = [e.actor_name ? `de:${e.actor_name}` : '', transition, metaStr].filter(Boolean).join('  ');
        page.drawText(ro(`[${fmtDate(e.created_at)}]`), { x:COL_TS, y, size:EVENT_FONT_SIZE, font:fontR, color:rgb(0.5,0.5,0.5) });
        page.drawText(ro(evLabel(e.event_type)), { x:COL_TYPE, y, size:EVENT_FONT_SIZE, font:fontB, color:rgb(0.2,0.2,0.5) });
        if (detail) page.drawText(ro(detail), { x:COL_DETAIL, y, size:EVENT_FONT_SIZE, font:fontR, color:rgb(0.4,0.4,0.4), maxWidth:DETAIL_MAX_W });
        y -= 14;
      }

new_str:
      for (const e of sorted) {
        const transition = (e.from_status || e.to_status)
          ? `${e.from_status || '—'} -> ${e.to_status || '—'}` : '';
        const metaStr = e.meta && Object.keys(e.meta).length
          ? Object.entries(e.meta).map(([k, v]) => `${k}:${v}`).join(' ') : '';
        const detail = [e.actor_name ? `de:${e.actor_name}` : '', transition, metaStr].filter(Boolean).join('  ');
        const detailLines = detail ? estimateLines(ro(detail), DETAIL_MAX_W, fontR, EVENT_FONT_SIZE) : 1;
        const rowH = Math.max(1, detailLines) * EVENT_LINE_H + 2;   // rândul crește cu nr. de linii
        ensureSpace(rowH + 2);
        page.drawText(ro(`[${fmtDate(e.created_at)}]`), { x:COL_TS, y, size:EVENT_FONT_SIZE, font:fontR, color:rgb(0.5,0.5,0.5) });
        page.drawText(ro(evLabel(e.event_type)), { x:COL_TYPE, y, size:EVENT_FONT_SIZE, font:fontB, color:rgb(0.2,0.2,0.5) });
        if (detail) page.drawText(ro(detail), { x:COL_DETAIL, y, size:EVENT_FONT_SIZE, font:fontR, color:rgb(0.4,0.4,0.4), maxWidth:DETAIL_MAX_W, lineHeight:EVENT_LINE_H });
        y -= rowH;
      }

Diferențele-cheie: (1) `estimateLines` + `rowH` dinamic; (2) `lineHeight:EVENT_LINE_H` pe
`drawText` (ca liniile împărțite de pdf-lib să aibă aceeași spațiere ca `rowH`); (3)
`ensureSpace(rowH+2)` în loc de `ensureSpace(16)` (evită tăierea unui eveniment lung la
finalul paginii).

⚠️ ORD: confirmă că auditul ORD folosește ACEEAȘI funcție/buclă din shared.mjs. Dacă DF și
ORD partajează acest generator (probabil — e „AUDIT FORMULAR" cu `type`), fixul acoperă
ambele automat. Verifică:
    grep -n "audit_\${type}\|type === 'ord'\|type === 'df'\|AUDIT FORMULAR" server/routes/formulare/shared.mjs
    # Dacă e o singură cale parametrizată pe `type` → un singur fix acoperă DF+ORD.

===============================================================================
PAS 3 — Verificare vizuală + suită
===============================================================================
    node --check server/routes/formulare/shared.mjs
    npm test        # Așteptat: verde, fără regresii

Bump `package.json`: 3.9.708 → 3.9.709. FĂRĂ CACHE_VERSION/`?v=` (generare PDF server-side,
niciun asset frontend).

RAPORT FINAL:
1. Diff-ul buclei (estimateLines + rowH dinamic + lineHeight).
2. Confirmarea că DF ȘI ORD folosesc aceeași cale (grep) → un fix acoperă ambele; dacă NU,
   aplică același fix și la calea ORD și spune unde.
3. Confirmarea că traducerile n-au fost atinse (dicționarul FORMULAR_AUDIT_LABELS neschimbat).
4. `npm test` passed/0 fail. `git diff --name-only` → doar shared.mjs + package.json.
5. Commit+push develop (`fix(audit): înălțime rând dinamică în jurnalul PDF DF/ORD — fără suprapunere text (v3.9.709)`) + hash.

ACCEPTANCE (manual, Mircea, staging după deploy): re-exportă auditul PDF pe un DF cu un
eveniment lung (ex. cel cu NEAPROBAT + alop_id + flowId) și pe un ORD → jurnalul nu mai
suprapune; fiecare eveniment lung ocupă mai multe linii curat, iar cel următor începe sub el.

===============================================================================
CONSTRÂNGERI ABSOLUTE ⛔
===============================================================================
⛔ NU atinge dicționarul de traduceri FORMULAR_AUDIT_LABELS (traducerile sunt corecte).
⛔ NU atinge auditul FLUXURILOR (admin/flows.mjs) — e deja reparat; doar OGLINDEȘTE de acolo.
⛔ NU schimba coloanele/pozițiile/fonturile — doar înălțimea de rând + lineHeight.
⛔ NU atinge `server/signing/*`. Backend-only, fără cache/?v= bump.
⛔ Totul pe `develop`. NU merge/push pe `main`. Contrazicere grep vs prompt ⇒ oprește-te și raportează.
