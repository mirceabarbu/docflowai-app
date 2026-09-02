---
prompt: 166
titlu: "Aprobarea derivată pe ORD + cele patru rute de detaliu — o singură sursă, nu opt copii"
model_suggested: "Opus 5, efort high"
branch: develop
versiune_curenta: v3.9.819
versiune_tinta: v3.9.820
migratii: NU
fisiere_din_public: NU  (⇒ fără CACHE_VERSION, fără bump `?v=`)
zona_no_touch_atinsa: NU
---

# ⚠️ BRANCH

Lucrezi **EXCLUSIV pe `develop`**. `main` = PRODUCȚIE, gestionat manual de Mircea.
Pasul final obligatoriu: `git push origin develop`.

---

## Context

#165 (v3.9.819) a mutat pe sursa unică `services/df-aprobat-sql.mjs → dfAprobatSql()` toate
formele laxe de „DF aprobat" **de pe ramura DF** din `formulare/shared.mjs`. Raportul tău de
la #165 a semnalat corect că aceeași omisiune trăiește în alte locuri, pe care le închide
lotul de față.

Predicatul LAX arată așa (nu verifică nici fluxul soft-șters, nici anulat, nici refuzat):

```
fo.flow_id IS NOT NULL AND ((f.data->>'status')='completed' OR (f.data->>'completed')::boolean=true)
```

De ce contează, concret — un flux ANULAT păstrează `completed:true` în JSONB (istoric
intenționat, vezi #164). Deci:

- **ramura ORD din lista de formulare** (`shared.mjs`) marchează „Aprobat" un ORD al cărui
  flux a fost anulat, iar `computeDocCapabilities` iese devreme pe `if (aprobat)` (linia 128
  din `formular-capabilities.mjs`) ⇒ `can_reopen` (care cere `!aprobat`, linia 114) nu se mai
  randează. Exact simptomul incidentului DF 46149, transpus pe ORD;
- **cele patru rute de DETALIU** (`df.mjs:155`, `df.mjs:224`, `ord.mjs:141`, `ord.mjs:214`)
  verifică `f.deleted_at IS NULL`, dar **nu** `cancelled` / `refused`. Ele prind anularea
  administrativă (care face soft-delete) și ratează anularea OBIȘNUITĂ (care scrie doar
  `status='cancelled'`). Nota mea mai veche „detaliul e singurul corect" era greșită: e
  corect doar pe jumătate;
- **`df.mjs:91`** (`GET /api/formulare-df`) n-are nici măcar `deleted_at` — pe asta am
  declarat-o greșit „cu gărzi" în promptul #165 și ai găsit tu că nu e.

Acesta e al patrulea lot în care același predicat scris de mână produce un defect. De aceea
Etapa A nu doar înlocuiește: dă sursei unice **numele corect**, ca următorul care scrie o
rută ORD să nu creadă că helperul e „doar pentru DF".

---

## ⛔ DELIBERAT ÎN AFARA LOTULUI

Nu atinge, nu „repara din drum", nu include în commit:

1. **`df.mjs:132` — `GET /api/formulare-df/aprobate`.** E lax, e cunoscut, devine **#167**.
   Motivul separării: ruta alimentează `<select id="o-df-sel">` din `public/js/formular/list.js:139`,
   iar `alopDeschideORD` (#157) face `await loadDfAprobate()` și apoi setează `sel.value = df_id`.
   Dacă un DF deja legat dispare din listă, `sel.value` devine tăcut `''` și se poate salva
   `formulare_ord.df_id = NULL` — exact clasa de bug reparată la #157. Întărirea rutei cere
   simultan o opțiune „lipicioasă" în frontend, deci fișiere din `public/` și bump `?v=`.
   Alt lot, cu testul lui.
2. **`services/clasa8.mjs` (`:103`, `:146`, `:338`)** — aceeași formă laxă, dar acolo
   consecința e o CIFRĂ raportată, nu un badge. Cere teste pe sume, înainte/după. Alt lot.
3. **`routes/alop.mjs`** — orice expresie de acolo. Cardul ALOP folosește `sqlDosarAreAprobat`,
   care are gărzile; restul se analizează separat.
4. **`df.mjs:400`** — e DEJA strict (are `deleted_at` + `cancelled` + `refused`). Nu-l
   rescrie ca să folosească helperul: e o interogare pe `flows` cu `$1`, fără aliasul `fd`,
   deci nu se potrivește pe semnătura helperului. **Îl RAPORTEZI** la punctul 7 din raport ca
   posibil candidat pentru o a treia variantă a helperului. Atât.

---

## ETAPA 0 — ancore (READ-ONLY, zero modificări)

Nu scrii nimic până nu ai citit și copiat în raport ancorele reale.

```bash
cd $(git rev-parse --show-toplevel)
git status --short
git rev-parse --abbrev-ref HEAD        # Așteptat: develop

# A0.1 — semnătura REALĂ a sursei unice (la #165 am scris numele pe dos în prompt)
sed -n '1,45p' server/services/df-aprobat-sql.mjs

# A0.2 — inventarul EXACT al formei laxe, pe fișier și pe linie
for f in server/routes/formulare/shared.mjs server/routes/formulare/df.mjs \
         server/routes/formulare/ord.mjs; do
  echo "--- $f"; grep -n "completed')::boolean" $f; done
# Așteptat, ÎNAINTE de patch:
#   shared.mjs → 3 linii (741, 806, 809)
#   df.mjs     → 5 linii (91, 132, 155, 224, 400)
#   ord.mjs    → 2 linii (141, 214)

# A0.3 — toți consumatorii actuali ai helperului (nu trebuie să se rupă niciunul)
grep -rn "dfAprobatSql\|dfAprobatExistsSql" server --include=*.mjs | grep -v "^server/tests"

# A0.4 — importurile existente în cele trei fișiere
grep -n "df-aprobat-sql" server/routes/formulare/shared.mjs server/routes/formulare/df.mjs \
                          server/routes/formulare/ord.mjs
# Așteptat: shared.mjs DA, df.mjs DA, ord.mjs NU (îl adaugi tu la Etapa D)

# A0.5 — cum consumă capabilities coloana `aprobat`
sed -n '84,132p' server/services/formular-capabilities.mjs
```

**Dacă A0.2 dă alte numere sau alte linii decât cele scrise mai sus, OPREȘTE-TE și
raportează.** Arhiva pe care am scris promptul e `develop` la v3.9.819; o divergență
înseamnă că a intrat altceva între timp și ancorele mele nu mai sunt de încredere.

---

## ETAPA A — sursa unică primește numele corect (`docAprobatSql`)

Predicatul nu are nimic specific DF-ului: e „documentul e aprobat pentru că fluxul lui e
finalizat și viu". Aliasurile sunt deja parametri. Îl redenumim și păstrăm numele vechi ca
alias **exportat**, ca cele 8 apeluri existente să nu se atingă deloc.

**Fișier:** `server/services/df-aprobat-sql.mjs`

`old_str`:
```
export const dfAprobatSql = (fd = 'fd', f = 'f') => `(
  ${fd}.flow_id IS NOT NULL
```

`new_str`:
```
export const docAprobatSql = (fd = 'fd', f = 'f') => `(
  ${fd}.flow_id IS NOT NULL
```

Apoi, imediat DUPĂ blocul returnat de `docAprobatSql` (adică după linia care conține
`)\`;` de la finalul acelui export, ÎNAINTE de docblock-ul lui `dfAprobatExistsSql`),
inserezi:

```js

/**
 * #166 — ALIAS ISTORIC. Predicatul e identic pentru DF si ORD (aliasurile sunt parametri),
 * dar numele `dfAprobatSql` a facut sa para specific DF-ului, iar ramura ORD si-a scris
 * propria copie laxa. Numele canonic e `docAprobatSql`. Aliasul ramane exportat ca cele 8
 * apeluri existente sa nu se atinga in acest lot; se retrage cand nu-l mai foloseste nimeni.
 * ⛔ NU sunt doua implementari — e aceeasi referinta de functie.
 */
export const dfAprobatSql = docAprobatSql;
```

Actualizezi și titlul docblock-ului fișierului:

`old_str`:
```
 * server/services/df-aprobat-sql.mjs — CE INSEAMNA "DF APROBAT" (#134d)
```

`new_str`:
```
 * server/services/df-aprobat-sql.mjs — CE INSEAMNA "DOCUMENT APROBAT" (#134d, extins #166)
```

**Verificare imediată:**
```bash
node --check server/services/df-aprobat-sql.mjs
node -e "import('./server/services/df-aprobat-sql.mjs').then(m=>{ \
  console.log('alias identic:', m.dfAprobatSql === m.docAprobatSql); \
  console.log(m.docAprobatSql('fo','f')); })"
# Așteptat: `alias identic: true` și un predicat cu `fo.flow_id`, `f.deleted_at IS NULL`,
# cele două IS DISTINCT FROM și ramura de finalizare.
```

---

## ETAPA B — ramura ORD din `formulare/shared.mjs` (3 locuri, o singură sursă)

**Fișier:** `server/routes/formulare/shared.mjs`

### B.1 — importul

`old_str`:
```
import { dfAprobatSql } from '../../services/df-aprobat-sql.mjs';
```

`new_str`:
```
import { dfAprobatSql, docAprobatSql } from '../../services/df-aprobat-sql.mjs';
```

### B.2 — fragmentul de filtru `_foAprobat`

`old_str`:
```
      const _foAprobat  = `fo.flow_id IS NOT NULL AND ((f.data->>'status')='completed' OR (f.data->>'completed')::boolean=true)`;
```

`new_str`:
```
      // #166 — sursa unica (`services/df-aprobat-sql.mjs`), identic cu ramura DF de la #165.
      // Forma veche nu verifica nici fluxul soft-sters, nici anulat, nici refuzat, iar un flux
      // anulat pastreaza `completed:true` in JSONB ⇒ ORD-ul ramanea „Aprobat" dupa anulare si
      // `computeDocCapabilities` iesea devreme pe ramura aprobata (fara `can_reopen`).
      const _foAprobat  = docAprobatSql('fo', 'f');
```

### B.3 — coloana `aprobat` + ramura `aprobat` din `badge_status`

Cele două se schimbă ÎMPREUNĂ (paritate filtru⟺badge — dacă atingi doar una, filtrul și
eticheta încep să divergă exact ca înainte de #165). Blocul e contiguu.

`old_str`:
```
            CASE WHEN fo.flow_id IS NOT NULL
                      AND (f.data->>'status' = 'completed' OR (f.data->>'completed')::boolean = true)
                 THEN 'aprobat' ELSE fo.status END
          ) AS badge_status,
          CASE WHEN fo.flow_id IS NOT NULL AND (f.data->>'status' = 'completed' OR (f.data->>'completed')::boolean = true)
               THEN true ELSE false END AS aprobat,
```

`new_str`:
```
            -- #166 — identic cu fragmentul de filtru _foAprobat de mai sus (paritate
            -- filtru<=>badge). Aceeasi sursa unica ca la ramura DF (#165).
            CASE WHEN ${_foAprobat} THEN 'aprobat' ELSE fo.status END
          ) AS badge_status,
          -- #166 — `aprobat` alimenteaza computeDocCapabilities (doc.aprobat), care are
          -- return timpuriu pe ramura aprobata si conditioneaza `can_reopen` pe `!aprobat`.
          -- COALESCE: predicatul poate da NULL cand fluxul nu are cheia de finalizare in
          -- JSONB; coloana ramane boolean strict, ca la rutele de detaliu. Valoarea de
          -- adevar e IDENTICA cu fragmentul de filtru, care trateaza NULL prin IS NOT TRUE.
          COALESCE((${_foAprobat}), false) AS aprobat,
```

⚠️ **Verifică înainte de a patch-ui** că `_foAprobat` e declarat mai SUS în aceeași funcție
decât locul unde îl interpolezi acum (la DF așa e). Dacă nu e în scope, **oprește-te și
raportează** — nu muta declarația fără să spui.

---

## ETAPA C — coloana `aprobat` din `GET /api/formulare-df` (`df.mjs:91`)

**Fișier:** `server/routes/formulare/df.mjs` (importul `dfAprobatSql` există deja)

`old_str`:
```
        CASE WHEN fd.flow_id IS NOT NULL AND (f.data->>'status' = 'completed' OR (f.data->>'completed')::boolean = true)
             THEN true ELSE false END AS aprobat,
        -- #126 A6: semnal (NU blocaj)
```

`new_str`:
```
        -- #166 — sursa unica. Aici lipsea inclusiv `f.deleted_at IS NULL` (am afirmat gresit
        -- contrariul in promptul #165; tu ai gasit lacuna). COALESCE pastreaza coloana
        -- boolean strict cand predicatul da NULL.
        COALESCE(${dfAprobatSql('fd', 'f')}, false) AS aprobat,
        -- #126 A6: semnal (NU blocaj)
```

⚠️ Verifică la Etapa 0 că interogarea are într-adevăr `LEFT JOIN flows f ON f.id = fd.flow_id`.
Dacă JOIN-ul e `INNER`, `deleted_at IS NULL` schimbă mulțimea de rânduri, nu doar coloana —
în cazul ăsta **oprește-te și raportează**, nu improviza.

---

## ETAPA D — cele patru rute de detaliu

Toate patru au `deleted_at`, dar niciuna nu are `cancelled`/`refused` ⇒ prind anularea
administrativă și ratează anularea obișnuită.

### D.1 — `df.mjs` (detaliu document)

`old_str`:
```
        CASE WHEN fd.flow_id IS NOT NULL AND f.deleted_at IS NULL AND (f.data->>'status' = 'completed' OR (f.data->>'completed')::boolean = true)
             THEN true ELSE false END AS aprobat,
        CASE WHEN fd.flow_id IS NOT NULL
```

`new_str`:
```
        -- #166 — sursa unica; forma veche rata anularea OBISNUITA (`status='cancelled'`
        -- fara soft-delete), fiindca verifica doar `deleted_at`.
        COALESCE(${dfAprobatSql('fd', 'f')}, false) AS aprobat,
        CASE WHEN fd.flow_id IS NOT NULL
```

### D.2 — `df.mjs` (ruta `/xml`)

`old_str`:
```
        CASE WHEN fd.flow_id IS NOT NULL AND f.deleted_at IS NULL AND (f.data->>'status' = 'completed' OR (f.data->>'completed')::boolean = true)
             THEN true ELSE false END AS aprobat
      FROM formulare_df fd
```

`new_str`:
```
        -- #166 — sursa unica (vezi detaliul de mai sus).
        COALESCE(${dfAprobatSql('fd', 'f')}, false) AS aprobat
      FROM formulare_df fd
```

### D.3 — `ord.mjs`: importul

`old_str`:
```
import { liveFlowSql } from '../../services/flow-provenance.mjs';
```

`new_str`:
```
import { liveFlowSql } from '../../services/flow-provenance.mjs';
import { docAprobatSql } from '../../services/df-aprobat-sql.mjs';
```

### D.4 — `ord.mjs` (detaliu document)

`old_str`:
```
        CASE WHEN fo.flow_id IS NOT NULL AND f.deleted_at IS NULL AND (f.data->>'status' = 'completed' OR (f.data->>'completed')::boolean = true)
             THEN true ELSE false END AS aprobat,
        CASE WHEN fo.flow_id IS NOT NULL
```

`new_str`:
```
        -- #166 — sursa unica; forma veche rata anularea OBISNUITA (`status='cancelled'`
        -- fara soft-delete), fiindca verifica doar `deleted_at`.
        COALESCE(${docAprobatSql('fo', 'f')}, false) AS aprobat,
        CASE WHEN fo.flow_id IS NOT NULL
```

### D.5 — `ord.mjs` (ruta `/xml`)

`old_str`:
```
        CASE WHEN fo.flow_id IS NOT NULL AND f.deleted_at IS NULL AND (f.data->>'status' = 'completed' OR (f.data->>'completed')::boolean = true)
             THEN true ELSE false END AS aprobat
      FROM formulare_ord fo
```

`new_str`:
```
        -- #166 — sursa unica (vezi detaliul de mai sus).
        COALESCE(${docAprobatSql('fo', 'f')}, false) AS aprobat
      FROM formulare_ord fo
```

⚠️ **`can_export_xml`** (`formular-capabilities.mjs:107`) e `aprobat || status==='completed' || status==='transmis_flux'`. Un ORD/DF cu flux anulat rămâne
exportabil prin ramura `status`, deci D.2/D.5 **nu** îi taie exportul XML. Confirmă asta
explicit în raport — dacă găsești o cale în care exportul se închide, oprește-te.

---

## ETAPA E — teste (DB REAL, nu mock)

**Fișier nou:** `server/tests/db/ord-aprobat-derivat.test.mjs`

Modelul e `server/tests/db/df-aprobat-derivat.test.mjs` (#165) — citește-l întâi și
refolosește-i structura și helperii (`seedOrgUser`, `seedOrd`, `seedFlow`, `makeAuthCookie`,
`buildApp`, `computeDocCapabilities`). Nu inventa helperi noi.

Cazuri OBLIGATORII (⭐ = cele care ar fi picat înainte de lot):

1. ORD cu flux VIU finalizat ⇒ `aprobat=true`, `badge_status='aprobat'`, apare la
   `?status=aprobat`. (Neschimbat față de azi — protecție anti-regresie.)
2. ⭐ ORD cu flux **anulat administrativ** (soft-șters + `status='cancelled'` +
   `completed:true` păstrat) ⇒ `aprobat=false`, `badge_status` NU e `'aprobat'`, ORD-ul
   **nu** apare la `?status=aprobat`.
3. ⭐ ORD cu flux anulat OBIȘNUIT (`status='cancelled'`, **fără** soft-delete,
   `completed:true` păstrat) ⇒ la fel ca (2). Ăsta e cazul pe care rutele de detaliu îl
   ratau.
4. ⭐ ORD cu flux **refuzat** care poartă `completed:true` ⇒ nu e `aprobat`;
   `badge_status='neaprobat'` (ramura `_foRespins`, care are deja gărzile).
5. ORD fără flux (`flow_id IS NULL`) ⇒ `aprobat=false`, fără eroare, `badge_status=fo.status`.
6. ⭐ **Paritate filtru⟺badge, exhaustiv.** Construiește un dataset cu TOATE stările de mai
   sus simultan, apoi pentru fiecare valoare de `status` din filtru compară **mulțimile de
   id-uri** returnate cu mulțimea rândurilor al căror `badge_status` e acea valoare.
   Acoperire totală, fără suprapunere. Nu compara numere de rânduri.
7. ⭐ `computeDocCapabilities` pe rândul de listă al cazului (2): `can_reopen` devine
   disponibil (documentul e `completed` și nu mai e `aprobat`), acolo unde înainte ramura
   `if (aprobat)` ieșea devreme.
8. ⭐ **Rutele de detaliu**, pentru cazul (3): `GET /api/formulare-ord/:id` și
   `GET /api/formulare-df/:id` întorc `aprobat=false`.

Dacă un test EXISTENT cade, analizează întâi dacă el codifica forma laxă (atunci se
corectează, cu justificare explicită în raport) sau dacă e regresie reală (atunci te
oprești). **Nu slăbi niciodată predicatul ca să treacă un test.**

---

## ETAPA F — verificări, versionare, push

```bash
node --check server/services/df-aprobat-sql.mjs
node --check server/routes/formulare/shared.mjs
node --check server/routes/formulare/df.mjs
node --check server/routes/formulare/ord.mjs
npm run check                       # exit 0

grep -c "completed')::boolean" server/routes/formulare/shared.mjs   # Așteptat: 0
grep -c "completed')::boolean" server/routes/formulare/ord.mjs      # Așteptat: 0
grep -n  "completed')::boolean" server/routes/formulare/df.mjs
# Așteptat: EXACT 2 linii rămase — `/aprobate` (~132, deliberat #167) și forma
# DEJA STRICTĂ din PUT (~400). Enumeră-le pe amândouă în raport, cu linia și contextul.
# Orice a treia linie = te-ai abătut.

grep -rn "docAprobatSql\|dfAprobatSql" server --include=*.mjs | grep -v "^server/tests"
# Așteptat: sursa + alias + toți consumatorii; NICIUN apel rămas la forma scrisă de mână.

npm test
npm run test:db                     # PG 17 efemer, port 55432. PASSED, nu SKIPPED.
```

```bash
# package.json: 3.9.819 → 3.9.820   ⛔ fără CACHE_VERSION, fără `?v=` (zero fișiere din public/)
git add server/services/df-aprobat-sql.mjs \
        server/routes/formulare/shared.mjs \
        server/routes/formulare/df.mjs \
        server/routes/formulare/ord.mjs \
        server/tests/db/ord-aprobat-derivat.test.mjs \
        package.json
git status --short
git commit -m "#166: aprobarea derivata ORD si rutele de detaliu trec pe sursa unica (v3.9.820)"
git push origin develop
```

---

## RAPORT FINAL

1. Ancorele din Etapa 0, **literal** — inclusiv semnătura reală a helperului și inventarul
   pe linii din A0.2, înainte de orice modificare.
2. Diff-ul pe fiecare fișier.
3. SQL-ul FINAL generat pentru ORD: fragmentul de filtru `_foAprobat`, ramura `aprobat` din
   `badge_status` și coloana `aprobat`, copiate integral. Vreau să văd cu ochii mei că sunt
   **identice**.
4. Rezultatul explicit al fiecărui caz ⭐, în special (6) — cu mulțimile de id-uri comparate.
5. Cele două apariții rămase în `df.mjs`, cu linia și contextul fiecăreia.
6. Confirmarea despre `can_export_xml` cerută la finalul Etapei D.
7. **Constatare cerută explicit, fără reparație:** `df.mjs:400` — merită o a treia variantă
   a helperului (gen `flowAprobatSql(alias)`, pe un flux dat prin parametru, fără alias de
   document)? Câte alte locuri ar consuma-o? Enumeră-le. **Nu repara nimic acolo.**
8. `npm test` / `npm run test:db` — rezultat real. Orice test existent atins, cu justificare.
9. Hash-ul commitului + confirmarea push-ului pe `develop`.

## ⛔ CONSTRÂNGERI ABSOLUTE

- Zero fișiere din `public/`. Zero migrații. Zero atingeri în zona NO-TOUCH.
- Nu atinge nimic din lista „DELIBERAT ÎN AFARA LOTULUI" de mai sus — nici `/aprobate`,
  nici `clasa8.mjs`, nici `alop.mjs`, nici `df.mjs:400`.
- Nu modifica `dfAprobatExistsSql` și nu-i schimba semnătura.
- Nu redenumi fișierul `df-aprobat-sql.mjs` și nu muta exporturile în alt modul: 8 apeluri
  existente depind de calea asta, iar mutarea ar amesteca o refactorizare de structură într-un
  lot de corectitudine.
- `dfAprobatSql` rămâne EXPORTAT. Nu-l șterge și nu-l converti în funcție separată — trebuie
  să fie aceeași referință (testul din Etapa A verifică `===`).
- Nu schimba `computeDocCapabilities`: return-ul timpuriu pe `aprobat` e corect **odată ce**
  `aprobat` e calculat corect.
- Nu adăuga coduri de eroare noi și nu schimba forma răspunsurilor existente.
- ⚠️ Pe STAGING, înainte de merge, Mircea testează: anulare (obișnuită, nu administrativă) a
  fluxului unui ORD finalizat ⇒ ORD-ul nu mai apare „Aprobat" nici în listă, nici la
  deschiderea documentului, iar acțiunea de redeschidere e disponibilă.
- Orice verificare cu rezultat neașteptat ⇒ oprire și raport, fără improvizație.
