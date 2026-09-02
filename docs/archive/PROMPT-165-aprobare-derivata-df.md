---
prompt: 165
titlu: "Aprobarea derivată: badge, filtru și revizie nu mai ignoră fluxul desfăcut"
model_suggested: "Opus 5, efort high"
branch: develop
versiune_curenta: v3.9.818
versiune_tinta: v3.9.819
migratii: NU
fisiere_din_public: NU  (⇒ fără CACHE_VERSION, fără bump `?v=`)
zona_no_touch_atinsa: NU
---

# ⚠️ BRANCH

Lucrezi **EXCLUSIV pe `develop`**. `main` = PRODUCȚIE, gestionat manual de Mircea.
Pasul final: `git push origin develop`.

---

## Context — incidentul DF 46149 (31.08.2026)

După o anulare administrativă corectă și completă (flux soft-șters, `status='cancelled'`,
`adminCancelled=true`), documentul apărea în continuare **„Aprobat"** în lista de formulare,
iar butonul de relansare a fluxului nu se randa. Utilizatorul a rămas blocat pe un document
a cărui aprobare fusese desfăcută.

Cauza: predicatul de aprobare derivată din listă (`shared.mjs:538` și `:642`) este

```
fd.flow_id IS NOT NULL AND ((f.data->>'status')='completed' OR (f.data->>'completed')::boolean=true)
```

Nu verifică `f.deleted_at IS NULL`. Nu verifică `status <> 'cancelled'`. Un flux anulat
administrativ **păstrează** `completed:true` în JSONB — asta e istorie, corectă și
intenționată — deci predicatul îl citește ca aprobare vie.

Efectul se propagă mai departe: `computeDocCapabilities` are un `return caps` timpuriu pe
ramura `if (aprobat)` (`services/formular-capabilities.mjs:128`), deci documentul e tratat
ca închis și nu se mai calculează nicio acțiune. De aceea lista nu oferă relansarea, deși
pagina de detaliu a documentului o oferă: acolo (`df.mjs:154`) predicatul **are** gărzile.

Fratele geamăn e `_dfTransmis` (`shared.mjs:537`), care le are pe toate — dovada că
omisiunea din `_dfAprobat` e o scăpare, nu o decizie.

⚠️ Al treilea loc, mai grav decât afișarea: `POST /api/formulare-df/:id/revizuieste`
(`df.mjs:578`) folosește **aceeași** formă laxă, iar acolo nu e vorba de un badge, ci de o
**decizie** — dacă un document poate fi revizuit sau nu. Intră în acest lot.

---

## Regula lotului

Sursa unică de adevăr există deja: `sqlDfAprobat` din `server/services/df-aprobat-sql.mjs`.
Toate cele trei locuri trec pe ea. Nu scrie predicate noi și nu copia condiții „de mână".

⚠️ **Paritatea filtru↔badge nu e opțională.** Comentariul de la `shared.mjs:534` spune
explicit că fragmentele de filtru sunt inversa algebrică a derivării din `badge_status`.
Dacă schimbi doar unul dintre ele, filtrul „Aprobat" va întoarce alte rânduri decât cele pe
care lista le afișează ca aprobate — o regresie mai greu de observat decât cea pe care o
reparăm. Cele două se schimbă **împreună**, în același commit.

---

## ETAPA 0 — ancore (READ-ONLY, obligatorie)

```bash
git branch --show-current                      # Așteptat: develop
node -p "require('./package.json').version"    # Așteptat: 3.9.818
git status --short                             # arbore fără modificări trackuite

grep -n "export function sqlDfAprobat\|export const sqlDfAprobat" server/services/df-aprobat-sql.mjs
# Așteptat: 1 linie. NOTEAZĂ semnătura exactă (ce parametri primește: alias tabel? alias flux?)

grep -c "f.data->>'status' = 'completed' OR (f.data->>'completed')::boolean = true" server/routes/formulare/shared.mjs
grep -c "(f.data->>'status')='completed' OR (f.data->>'completed')::boolean=true" server/routes/formulare/shared.mjs
# Împreună: EXACT 2 apariții pe ramura DF — fragmentul de filtru (~538) și CASE-ul din badge (~642).
# ⚠️ Ramura ORD din același fișier (~726 și ~796) foloseste aliasul `fo`. NU o atinge în acest lot.

grep -n "AS aprobat" server/routes/formulare/df.mjs
# Așteptat: 4 linii (91, 155, 224, 578). Doar 578 e în scopul acestui lot.
```

⛔ Orice nepotrivire de număr ⇒ **oprește-te și raportează**. Promptul e scris pe arhiva
v3.9.814; formele trebuie să existe, dar liniile pot fi deplasate.

---

## ETAPA A — fragmentul de filtru și CASE-ul din badge, împreună

`server/routes/formulare/shared.mjs`, ramura `type === 'df'`.

**A1.** Importă helperul lângă celelalte importuri ale fișierului (verifică întâi dacă nu e
deja importat) și înlocuiește definiția fragmentului:

`old_str`:

```js
      const _dfAprobat  = `fd.flow_id IS NOT NULL AND ((f.data->>'status')='completed' OR (f.data->>'completed')::boolean=true)`;
```

`new_str`:

```js
      // #165 — forma laxă de aici nu verifica `f.deleted_at` și nici `status='cancelled'`,
      // deci un flux anulat administrativ (care păstrează `completed:true` ca istoric)
      // continua să producă badge-ul „Aprobat" și bloca relansarea prin `return` timpuriu
      // din `computeDocCapabilities`. Incidentul DF 46149, 31.08.2026. Sursă unică:
      // `services/df-aprobat-sql.mjs`, aceeași folosită de pagina de detaliu a documentului.
      const _dfAprobat  = sqlDfAprobat('fd', 'f');
```

⚠️ Adaptează argumentele la semnătura reală citită la Etapa 0. Dacă helperul își construiește
singur `JOIN`-ul sau presupune alte aliasuri decât `fd`/`f`, **oprește-te și raportează** în
loc să-l forțezi — un predicat de aprobare scris pe aliasuri greșite trece de `node --check`
și cade abia în producție.

**A2.** Același predicat în `badge_status`:

`old_str`:

```js
            CASE WHEN fd.flow_id IS NOT NULL
                      AND (f.data->>'status' = 'completed' OR (f.data->>'completed')::boolean = true)
                 THEN 'aprobat' ELSE fd.status END
```

`new_str`:

```js
            -- #165 — identic cu fragmentul de filtru `_dfAprobat` de mai sus (paritate
            -- filtru⟺badge, vezi comentariul de la definirea fragmentelor).
            CASE WHEN ${_dfAprobat} THEN 'aprobat' ELSE fd.status END
```

⚠️ Verifică întâi că `_dfAprobat` e în scope la locul interpolării (e definit în același
bloc `type === 'df'`, dar mai sus). Dacă nu e, **nu muta definiția** — raportează.

---

## ETAPA B — `revizuieste`: aprobarea ca decizie, nu ca etichetă

`server/routes/formulare/df.mjs`, ruta `POST /api/formulare-df/:id/revizuieste`.

`old_str`:

```js
        (fd.flow_id IS NOT NULL AND (f.data->>'status' = 'completed' OR (f.data->>'completed')::boolean = true)) AS aprobat
```

`new_str`:

```js
        -- #165 — aici `aprobat` nu e afișare, ci POARTĂ: decide dacă documentul poate fi
        -- revizuit. Forma laxă considera aprobat un DF al cărui flux fusese desfăcut.
        ${sqlDfAprobat('fd', 'f')} AS aprobat
```

Verifică `JOIN`-ul existent din acea interogare (`LEFT JOIN flows f ON f.id = fd.flow_id`) —
dacă helperul cere alt alias sau altă formă de join, adaptează **join-ul**, nu predicatul.

⛔ Nu atinge liniile 91, 155 și 224 din același fișier: acolo expresia are deja gărzile
(`f.deleted_at IS NULL`). Le verifici și le raportezi ca fiind corecte, atât.

---

## ETAPA C — teste

Fișier nou `server/tests/db/df-aprobat-derivat.test.mjs` (PostgreSQL REAL). Pentru fiecare
caz, verifică **trei** lucruri deodată: `badge_status` din listă, apartenența la filtrul
`status=aprobat`, și `capabilities` întors pentru acel rând.

1. Flux **viu și completat** ⇒ badge `aprobat`, apare la filtrul „Aprobat",
   `capabilities.aprobat = true`. (Comportamentul normal, nu trebuie să se schimbe.)
2. ⭐ Flux **soft-șters** (`deleted_at` setat), `completed:true` păstrat în JSONB ⇒ badge
   **NU** e `aprobat`, **NU** apare la filtrul „Aprobat", iar `capabilities` oferă acțiune
   de relansare. Cazul DF 46149.
3. ⭐ Flux `status='cancelled'` cu `completed:true` ⇒ identic cu (2).
4. Flux `refused` ⇒ badge `neaprobat` (`_dfRespins` neatins de acest lot — test de
   ne-regresie).
5. Flux activ, nefinalizat ⇒ badge `transmis_flux` (`_dfTransmis` neatins — ne-regresie).
6. ⭐ **Paritate filtru↔badge, exhaustiv**: pentru fiecare stare din (1)–(5), mulțimea
   rândurilor întoarse de filtrul `status=X` este **exact** mulțimea rândurilor cu
   `badge_status = X`. Construiește un dataset cu toate stările simultan și compară
   mulțimile de id-uri, nu doar numărul de rânduri.
7. ⭐ `revizuieste` pe un DF al cărui flux a fost anulat administrativ ⇒ nu mai e tratat ca
   aprobat; comportamentul rutei corespunde documentului nearprobat.
8. `revizuieste` pe un DF cu flux viu completat ⇒ neschimbat față de azi.

Dacă un test existent cade, analizează întâi dacă el codifica forma laxă (caz în care testul
se corectează, cu justificare în raport) sau dacă e regresie reală (caz în care te oprești).
**Nu slăbi niciodată predicatul ca să treacă un test.**

---

## ETAPA D — verificări, versionare, push

```bash
node --check server/routes/formulare/shared.mjs
node --check server/routes/formulare/df.mjs
npm run check                       # exit 0

grep -c "(f.data->>'completed')::boolean=true" server/routes/formulare/shared.mjs
grep -c "(f.data->>'completed')::boolean = true" server/routes/formulare/shared.mjs
# Ramura DF nu mai trebuie să conțină forma laxă. Ce rămâne trebuie să fie EXCLUSIV pe
# ramura ORD (alias `fo`) — enumeră fiecare apariție rămasă în raport, cu linia și aliasul.

npm test
npm run test:db                     # PG 17 efemer, port 55432. PASSED, nu SKIPPED.
```

```bash
# package.json: 3.9.818 → 3.9.819   ⛔ fără CACHE_VERSION, fără `?v=`
git add server/routes/formulare/shared.mjs server/routes/formulare/df.mjs \
        server/tests/db/df-aprobat-derivat.test.mjs package.json
git status --short
git commit -m "#165: aprobarea derivata DF tine cont de fluxul desfacut (badge, filtru, revizie) (v3.9.819)"
git push origin develop
```

---

## RAPORT FINAL

1. Ancorele din Etapa 0, literal — inclusiv **semnătura exactă** a lui `sqlDfAprobat` și
   argumentele cu care ai apelat-o.
2. Diff-ul pe fiecare fișier.
3. SQL-ul final generat pentru `badge_status` și pentru fragmentul de filtru, copiat integral
   — vreau să văd cu ochii mei că sunt **identice**.
4. Lista testelor, cu rezultatul explicit al cazurilor ⭐, mai ales (6).
5. Aparițiile rămase ale formei laxe în `shared.mjs`, cu linia și aliasul fiecăreia.
6. `npm test` / `npm run test:db`. Orice test existent atins, cu justificare.
7. Hash-ul commitului + confirmarea push-ului.
8. **Constatare cerută explicit**: ramura ORD (`fo`) are aceeași omisiune? Verifici
   `_ordAprobat` și `badge_status`-ul ORD și **raportezi** ce ai găsit — nu repari nimic
   acolo în acest lot.

## ⛔ CONSTRÂNGERI ABSOLUTE

- Zero fișiere din `public/`. Zero migrații. Zero atingeri în zona NO-TOUCH.
- Nu atinge ramura ORD din `shared.mjs`, nu atinge `_dfTransmis`, `_dfRespins`, și nu
  atinge liniile 91/155/224 din `df.mjs`.
- Nu modifica `services/df-aprobat-sql.mjs` — e sursa, se consumă, nu se ajustează ca să
  încapă în apelanți.
- Nu schimba `computeDocCapabilities`: `return` timpuriu pe `aprobat` e corect **odată ce**
  `aprobat` e calculat corect.
- ⚠️ Pe STAGING, înainte de merge, Mircea verifică: anulare administrativă pe un flux DF
  finalizat ⇒ documentul NU mai apare „Aprobat" în listă, iar relansarea e disponibilă direct
  din listă; plus filtrul „Aprobat" întoarce exact documentele afișate ca aprobate.
- Orice verificare cu rezultat neașteptat ⇒ oprire și raport.
