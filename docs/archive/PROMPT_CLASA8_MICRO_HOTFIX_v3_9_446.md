# DocFlowAI — 🩹 CLASA 8 MICRO-HOTFIX: substring search pe Cod SSI (v3.9.446)

> Micro-hotfix peste v3.9.445 — schimbă filtrul Cod SSI din prefix-match în substring-match (conține), aliniat cu pattern-ul existent din proiect (`%${q}%`).

```
DocFlowAI v3.9.445 → v3.9.446 (SW v161 → v162)
Branch: develop
Subiect: fix(clasa8): filtru Cod SSI substring (ILIKE '%X%') în loc de prefix

═══════════════════════════════════════════════════════════
CONTEXT — 1 problemă rezolvată
═══════════════════════════════════════════════════════════

P1 (UX) — Filtru Cod SSI prefix-only nu găsește în interiorul codului
  Curent: ssi='03' → SQL `ILIKE '03%'` → NU găsește '510103' (deși conține '03')
  Corect: ssi='03' → SQL `ILIKE '%03%'` → găsește orice cod care conține '03'

  Pattern canonic în proiect:
    - server/routes/formulare-db.mjs L1231 (căutare beneficiari)
    - server/routes/admin/outreach.mjs L852 (căutare instituții)
  ambele folosesc `const like = `%${q}%`` și apoi `ILIKE $2`.

  Schimbarea efectivă: literal o ordine de caractere — `${ssiPrefix}%` →
  `%${ssi}%`. Plus redenumirea variabilei pentru a reflecta semantica.

═══════════════════════════════════════════════════════════
ZONĂ NO-TOUCH
═══════════════════════════════════════════════════════════
- Toate fișierele de signing (STSCloudProvider, cloud-signing, pades, etc.)
- server/middleware/auth.mjs (dual-mode din v3.9.442)
- server/routes/clasa8.mjs (endpoint-ul OK, doar filterare în service se schimbă)

═══════════════════════════════════════════════════════════
PASUL 1 — Schimbă pattern-ul SSI în service
═══════════════════════════════════════════════════════════

În server/services/clasa8.mjs.

PASUL 1.1 — Redenumire variabilă de la `ssiPrefix` la `ssi` pentru claritate:

old_str:
  const ssiPrefix    = (filters.ssi    || '').trim();

new_str:
  const ssi          = (filters.ssi    || '').trim();

PASUL 1.2 — Update construirea filtrului final SSI (de la `${ssiPrefix}%` la `%${ssi}%`):

old_str:
  const ssiFinalFilter = ssiPrefix ? `AND a.cod_ssi ILIKE $${++paramIdx}` : '';
  if (ssiPrefix) params.push(`${ssiPrefix}%`);

new_str:
  const ssiFinalFilter = ssi ? `AND a.cod_ssi ILIKE $${++paramIdx}` : '';
  if (ssi) params.push(`%${ssi}%`);

PASUL 1.3 — Update răspuns `filters_applied` (păstrăm cheia 'ssi' pentru
compatibilitate cu UI-ul curent care nu o folosește, dar folosim noua
variabilă):

old_str:
    filters_applied: {
      ssi:          ssiPrefix || null,
      compartiment: compartiment || null,
      q:            qText || null,
    },

new_str:
    filters_applied: {
      ssi:          ssi || null,
      compartiment: compartiment || null,
      q:            qText || null,
    },

═══════════════════════════════════════════════════════════
PASUL 2 — Update test pentru substring match
═══════════════════════════════════════════════════════════

În server/tests/integration/clasa8.test.mjs, în testul existent
„200 filtru ssi e propagat corect ca parametru SQL", schimbă assertion-ul
de la prefix la substring:

old_str:
    expect(callArgs[1]).toContain('01A%');

new_str:
    expect(callArgs[1]).toContain('%01A%');

NOTĂ: testul verifica înainte că prefix-ul ajunge ca '01A%' în params.
Acum e substring '%01A%'. Restul testului rămâne identic (status 200,
filters_applied.ssi='01A', SQL conține ILIKE).

═══════════════════════════════════════════════════════════
PASUL 3 — UI: ajustează placeholder-ul ca să sugereze substring
═══════════════════════════════════════════════════════════

În public/formular.html, secțiunea #clasa8-section.

old_str:
      <input id="clasa8-filter-ssi" type="text" autocomplete="off"
             placeholder="ex: 01A510 sau 020001..."
             style="width:100%;padding:9px 12px;background:rgba(255,255,255,.06);border:1px solid var(--df-border-2);border-radius:8px;color:var(--df-text);font-size:.9rem;box-sizing:border-box;font-family:monospace;">

new_str:
      <input id="clasa8-filter-ssi" type="text" autocomplete="off"
             placeholder="ex: 510, 0001, A52... (caută în orice poziție)"
             style="width:100%;padding:9px 12px;background:rgba(255,255,255,.06);border:1px solid var(--df-border-2);border-radius:8px;color:var(--df-text);font-size:.9rem;box-sizing:border-box;font-family:monospace;">

═══════════════════════════════════════════════════════════
PASUL 4 — Cache busting (3.9.445 → 3.9.446, SW v161 → v162)
═══════════════════════════════════════════════════════════

4.1 — package.json:
  old_str:   "version": "3.9.445",
  new_str:   "version": "3.9.446",

4.2 — public/sw.js:
  old_str: const CACHE_VERSION = 'docflowai-v161';
  new_str: const CACHE_VERSION = 'docflowai-v162';

4.3 — Cache busting în 4 HTML-uri (consistență):
  for f in public/formular.html public/refnec-form.html \
           public/notafd-invest-form.html public/admin.html; do
    sed -i 's/v=3\.9\.445/v=3.9.446/g' "$f"
  done

  Verifică:
  for f in public/formular.html public/refnec-form.html \
           public/notafd-invest-form.html public/admin.html; do
    OLD=$(grep -c "v=3\.9\.445" "$f")
    NEW=$(grep -c "v=3\.9\.446" "$f")
    echo "$f: 445=$OLD, 446=$NEW"
    [ "$OLD" -eq 0 ] && [ "$NEW" -gt 0 ] && echo "  ✓ OK" || echo "  ✗ FAIL (sau fișier neafectat)"
  done

═══════════════════════════════════════════════════════════
VERIFICARE OBLIGATORIE
═══════════════════════════════════════════════════════════

1. Substring pattern e aplicat corect:
   grep -c "params.push(\`%\${ssi}%\`)" server/services/clasa8.mjs
   → 1
   grep -c "params.push(\`\${ssi" server/services/clasa8.mjs
   → 0 (vechiul prefix-pattern dispărut)

2. Variabila redenumită consistent:
   grep -c "ssiPrefix" server/services/clasa8.mjs
   → 0 (toate ocurențele înlocuite cu `ssi`)

3. Test actualizat:
   grep -c "'%01A%'" server/tests/integration/clasa8.test.mjs
   → 1
   grep -c "'01A%'" server/tests/integration/clasa8.test.mjs
   → 0 (vechiul prefix dispărut)

4. UI placeholder actualizat:
   grep -c "caută în orice poziție" public/formular.html
   → 1

5. Cache busting curat:
   for f in public/formular.html public/refnec-form.html \
            public/notafd-invest-form.html public/admin.html; do
     [ "$(grep -c "v=3\.9\.445" "$f")" -eq 0 ] && echo "OK $f" || echo "FAIL $f"
   done
   → 4 OK

6. Sintaxă + teste:
   node --check server/services/clasa8.mjs
   npm run check
   npm test verde, fără regresii

═══════════════════════════════════════════════════════════
COMMIT pe develop
═══════════════════════════════════════════════════════════
git add server/services/clasa8.mjs \
        server/tests/integration/clasa8.test.mjs \
        public/formular.html \
        public/refnec-form.html \
        public/notafd-invest-form.html \
        public/admin.html \
        public/sw.js \
        package.json

git commit -m "fix(clasa8): filtru Cod SSI substring (ILIKE '%X%') in loc de prefix (v3.9.446)

Pattern aliniat cu căutarea existentă din proiect:
  - server/routes/formulare-db.mjs L1231 (beneficiari: denumire, CIF, IBAN)
  - server/routes/admin/outreach.mjs L852 (instituții: nume, localitate, județ)
ambele folosesc \`%\${q}%\` ca pattern ILIKE.

Înainte: ssi='03' → SQL ILIKE '03%' → NU găsea '510103'.
După:    ssi='03' → SQL ILIKE '%03%' → găsește orice cod care conține '03'.

Schimbări:
  - Redenumită variabila ssiPrefix → ssi (semantica nu mai e prefix-only)
  - Pattern: \`\${ssiPrefix}%\` → \`%\${ssi}%\`
  - Test 'filtru ssi propagat' actualizat: assertion '01A%' → '%01A%'
  - Placeholder UI: 'caută în orice poziție' (hint vizual pentru utilizator)

Cache: package 3.9.445 → 3.9.446, SW v161 → v162, HTML refs bumpate."

git push origin develop

═══════════════════════════════════════════════════════════
TEST POST-DEPLOY (staging) — sanity check 30 sec
═══════════════════════════════════════════════════════════

1. Hard refresh /formular.html → tab Clasa 8.

2. Verifică placeholder nou: 'ex: 510, 0001, A52... (caută în orice poziție)'

3. Cu codurile vizibile în UI ('3', '510103', '56', '789' din screenshot-ul
   anterior):
   - Tastează '03' → trebuie să apară DOAR '510103' (conține '03')
   - Tastează '5' → trebuie să apară '510103' și '56' (ambele conțin '5')
   - Tastează '789' → match exact pe '789'
   - Tastează '00' → niciun rezultat (niciun cod nu conține '00' în datele de test)

4. Reset → toate cele 4 rânduri reapar.

STOP dacă:
- Tastând '03' nu apare '510103' → verifică în SQL emis că params au '%03%':
  În clasa8.mjs caută `params.push(\`%\${ssi}%\`)` — 1 ocurență.
- Apare warning în consolă cu 'ssiPrefix is not defined' → o ocurență a
  rămas neschimbată; rerun grep -n "ssiPrefix" server/services/clasa8.mjs.
```
