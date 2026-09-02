# PROMPT #153 — accesul la conținutul fluxului se derivă din document (CAB pe DF/ORD)

> ⚠️ **BRANCH: `develop`.** Niciun `checkout`, `merge` sau `push` spre `main`.
> Dacă `git branch --show-current` nu arată `develop`, OPREȘTE-TE.

- **Model recomandat:** Opus 5 (atinge o poartă anti-IDOR)
- **versiune_start:** 3.9.808
- **versiune_tinta:** 3.9.809
- **Migrații:** ZERO

---

## DE CE

Raportat din producție: un membru al compartimentului **Responsabil CAB** vede
un DF aprobat, dar la „Descarcă PDF semnat" primește „PDF-ul fluxului nu este
disponibil încă". Discriminat empiric: **adminul descarcă același PDF fără
problemă** ⇒ documentul EXISTĂ, refuzul e de **autorizare** (403), nu 404.

Cauza: două porți au evoluat separat.

- `authz-formular.mjs` (vizibilitatea DF/ORD/ALOP) a primit ramura CAB
  (`isCabDept`, linia 197) și, la #143, proprietatea pe compartimentul
  creatorului.
- `flow-access.mjs` (conținutul fluxului) cunoaște doar cinci categorii:
  token de semnatar, inițiator, semnatar, admin/org_admin din aceeași org,
  destinatar repartizat. **Nu știe nimic despre compartimente sau CAB.**

Rezultat: omul deschide documentul, dar nu poate lua dovada semnării lui.

⛔ **Fixul NU este o ramură „CAB" în `flow-access.mjs`.** Poarta aceea e
generică peste TOATE fluxurile; o ramură de rol acolo ar da CAB-ului dreptul
de a descărca orice flux din organizație — contracte, documente de personal,
orice a trecut prin DocFlowAI. Ar fi un IDOR proiectat de noi, exact clasa pe
care poarta a fost creată s-o închidă.

**Decizia proprietarului (Mircea):** accesul se derivă din **document** —
membrul compartimentului Responsabil CAB are acces la fluxurile **cu DF și
ORD**, nu la restul.

---

## PASUL 0 — ancore

```bash
git branch --show-current           # develop
git status --short
grep -n '"version"' package.json    # 3.9.808
grep -n "^export" server/services/flow-access.mjs        # aștept 2
grep -n "^import" server/services/authz-formular.mjs     # aștept 0 (fără ciclu)
grep -rn "isFlowAccessAllowed" server/ --include=*.mjs | grep -v tests | grep -v "flow-access.mjs" | wc -l   # aștept 8
```

⭐ Confirmă în raport că `authz-formular.mjs` nu importă `flow-access.mjs` —
dacă importă, cablarea propusă face ciclu și te oprești.

---

## ETAPA A — MĂSOARĂ ÎNTÂI, pe producție, read-only

Livrează un fișier `docs/audits/DIAGNOSTIC-153-acces-flux-cab.sql`, **strict
`SELECT`**, pe care îl rulează Mircea. Nu-l rula tu.

Trebuie să răspundă la:

1. Câți utilizatori activi sunt în compartimentul `cab_compartiment` al
   fiecărei organizații (`organizations.cab_compartiment` vs
   `users.compartiment`, `users.deleted_at IS NULL`).
2. Câte fluxuri au `flow_id` referit din `formulare_df` și câte din
   `formulare_ord` (documente nešterse), pe organizație.
3. ⭐⭐ **Delta reală:** câte dintre acele fluxuri NU sunt deja accesibile
   membrului CAB pe o cale existentă — adică nu e inițiator, nu e semnatar,
   nu e destinatar repartizat. Asta e mulțimea pe care o deschidem.
4. Câte fluxuri din organizație **nu** au niciun DF/ORD atașat — mulțimea care
   rămâne, corect, închisă.

⛔ Zero `UPDATE`/`DELETE`/`INSERT`. Fiecare interogare cu antet-comentariu care
spune ce răspunde. ⛔ Fără backtick-uri în comentariile SQL.

**OPREȘTE-TE după livrarea fișierului** și raportează. Continui doar după ce
Mircea îți dă cifrele.

---

## ETAPA B — ramura derivată în `flow-access.mjs`

În `isFlowAccessAllowed`, **după** ce toate verificările existente au eșuat
(ordinea contează — cele ieftine și pure rămân primele), adaugă o ramură:

> Fluxul `fid` este fluxul de semnare al unui DF sau ORD pe care actorul are
> deja dreptul să-l vadă?

Implementare:

1. Caută rândul: `formulare_df WHERE flow_id = $1`, altfel
   `formulare_ord WHERE flow_id = $1`. ⭐ **Scopat pe `org_id` = orgul
   actorului** și `deleted_at IS NULL`. Fără rând ⇒ `false`.
2. Încarcă `actorComp` + `cabComp` cu `loadActorCompAndCab(pool, actor.userId,
   actor.orgId)`.
3. Deleagă la `canViewFormular(pool, actor, doc, actorComp, { cabComp })`.
   Rezultatul ei ESTE răspunsul — nu rescrie logica de autorizare aici.

Reguli:

- ⛔ **Fail-closed:** orice eroare de DB ⇒ `false` + `logger.error`. Un acces
  refuzat e mai bun decât unul acordat din greșeală.
- ⛔ Ramura NU rulează pentru semnatari anonimi (`signerToken` fără `actor`).
- ⛔ Nu schimba `canActorReadFlow` — rămâne pură și sincronă.
- ⚠️ Verifică `deleted_at` pe utilizator dacă `actor` nu vine deja filtrat.
- Comentariu în cod care spune de ce derivăm din document și nu din rol
  (mulțimea fluxurilor fără DF/ORD trebuie să rămână închisă).

⚠️ **Notă de recursie, verific-o:** `canViewFormular` are o ramură
`_isInFlowSigners(pool, doc.flow_id, actor.userId)`. Confirmă că
`authz-formular.mjs` NU cheamă înapoi în `flow-access.mjs` — altfel apare
recursie infinită. Dacă apare, oprește-te și raportează.

**Efectul se propagă automat la toate cele 8 situri** ale porții — `signed-pdf`,
`pdf`, atașamente (2 rute), Audit PDF al fluxului și restul. Enumeră-le în
raport, ca să știm exact ce s-a deschis.

---

## ETAPA C — mesajul care ne-a costat un diagnostic

`public/js/formular/doc.js:1014-1027` (`viewFlowPdf`) cade înapoi pe `/pdf` la
ORICE răspuns non-ok, apoi afișează același text pentru 403, 404 și 500.
Utilizatorului i s-a spus „nu este disponibil încă" când de fapt nu avea voie.

- **403** ⇒ mesaj de acces („nu aveți drept de acces la acest document"),
  fără fallback pe `/pdf` (ar da tot 403).
- **404** ⇒ mesajul actual („nu este disponibil încă"), cu fallback ca acum.
- **altceva** ⇒ mesaj de eroare care include codul.

⚠️ `?v=` țintit pe `doc.js`. Verifică dacă `doc.js` e în `PRECACHE_ASSETS`
(`public/sw.js`) — dacă DA, `CACHE_VERSION` se bumpează; dacă NU, doar `?v=`.
Citește lista, nu presupune.

---

## ETAPA D — teste (DB reale, nu mock-uri)

`server/tests/db/flow-access-df-ord.test.mjs`:

1. ⭐⭐ membru al compartimentului CAB + flux legat de un DF din org ⇒ **200**
   pe `signed-pdf`. **Cade pe codul de azi** (403). Ancora lotului.
2. ⭐⭐ același membru CAB + flux **fără** DF/ORD în aceeași org ⇒ **403**.
   Ăsta e testul care demonstrează că nu am lărgit prea mult; fără el, lotul
   nu are voie să intre.
3. ⭐⭐ membru CAB din **ALTĂ** organizație + același flux ⇒ **403**.
4. ⭐ flux legat de un **ORD** ⇒ **200** (paritate cu DF).
5. ⭐ utilizator obișnuit, fără legătură, din aceeași org ⇒ **403** (neschimbat).
6. ⭐ inițiator / semnatar / destinatar repartizat ⇒ **200** (neregresie pe
   cele cinci căi existente).
7. ⭐ DF `deleted_at IS NOT NULL` ⇒ **403**.
8. ⭐ eroare de DB pe ramura nouă ⇒ **403**, nu 200 (fail-closed).

⚠️ Fixturile trec prin aceleași funcții ca rutele reale (`hashPassword`, email
lowercase). Fiecare nume de coloană verificat pe migrațiile din
`server/db/index.mjs` înainte de a scrie SQL.

```bash
npm test
npm run test:db     # PASSED REAL — „skipped" nu e „passed"
```

Înainte de `test:db`: omoară rulările anterioare și recreează baza.

---

## PASUL FINAL

```bash
# package.json: 3.9.808 → 3.9.809
git status --short          # NICIODATĂ `git add -A`
git add server/services/flow-access.mjs \
        public/js/formular/doc.js \
        server/tests/db/flow-access-df-ord.test.mjs \
        docs/audits/DIAGNOSTIC-153-acces-flux-cab.sql \
        package.json
git diff --cached --stat
git commit -m "fix(#153): acces la continutul fluxului derivat din DF/ORD pentru compartimentul CAB (v3.9.809)"
git push origin develop
```

---

## RAPORT FINAL

1. Branch, versiune, ancorele din PASUL 0 + confirmarea absenței ciclului.
2. ⭐⭐ Etapa A: fișierul livrat și **cifrele primite de la Mircea**, în special
   delta de la punctul 3.
3. ⭐⭐ Etapa B: ramura scrisă; confirmarea că `canViewFormular` nu recursează
   înapoi în `flow-access.mjs`.
4. ⭐ Lista completă a celor 8 situri care se deschid, pe rute.
5. Etapa C: cele trei ramuri de mesaj; `doc.js` e sau nu în PRECACHE, cu dovada.
6. ⭐⭐ Etapa D: ce dădeau cazurile 1, 2 și 3 pe codul VECHI.
7. Câte interogări noi la DB adaugă ramura, și pe ce cale (doar fallback?).
8. `npm test` / `npm run test:db` — cifre, PASSED REAL, zero skipped.
9. Ce ai găsit și NU ai reparat.

---

## ⛔ CONSTRÂNGERI

- Doar `develop`. Zero migrații, zero scrieri de date.
- Fluxurile **fără** DF/ORD rămân închise pentru CAB — cazul 2 din teste e
  obligatoriu.
- Fail-closed pe orice eroare.
- `canActorReadFlow` rămâne pură și sincronă.
- Autorizarea nu se rescrie în `flow-access.mjs` — se deleagă la
  `canViewFormular`.
- Granița organizației nu se traversează niciodată.
- Dacă un `old_str` nu se potrivește: OPREȘTE-TE și raportează.
