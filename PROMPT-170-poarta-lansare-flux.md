---
prompt: 170
titlu: "Poarta la lansare — un document nu mai poate avea două fluxuri vii"
model_suggested: "Opus 5, efort high"
branch: develop
versiune_curenta: v3.9.823
versiune_tinta: v3.9.824
migratii: NU
fisiere_din_public: DA  (⇒ bump `?v=` țintit; CACHE_VERSION — verifică la Etapa 0)
zona_no_touch_atinsa: NU
---

# ⚠️ BRANCH

Lucrezi **EXCLUSIV pe `develop`**. `main` = PRODUCȚIE, gestionat manual de Mircea.
Pasul final obligatoriu: `git push origin develop`.

---

## Context — ce s-a măsurat, nu ce se bănuia

Cardul de divergențe a semnalat de două ori în cinci zile clasa „Fluxuri paralele"
(ORD 44269 pe 31.08, DF 45749 pe 02.09). Măsurat pe tot istoricul din producție:

| tip | documente cu 2+ fluxuri | sub 10 s (dublu-click) | peste 10 s (relansare deliberată) |
|---|---|---|---|
| DF  | 35 | 4 | **31** |
| ORD | 13 | 0 | **13** |

Distanța medie între lansări: ~2,5 zile. Deci **44 din 48 de cazuri sunt oameni care
relansează un flux fiindcă primul era greșit** — nu dublu-click. Ipoteza moștenită de la
#124 explică 4 cazuri din 48.

### Ce face sistemul azi

La lansare, `crud.mjs:457-482` încearcă `UPDATE formulare_df SET flow_id = $1`, cu o condiție
care refuză mutarea dacă documentul e deja pe un flux VIU. Când refuză:

```js
if (r.rowCount === 0) {
  logger.warn({ flowId, formType: 'df', formId: body.meta.dfId, rowCount: 0 },
    '[flux] documentul e deja pe un flux activ — pre-setare flow_id refuzata (posibil dublu-click)');
}
```

Un `logger.warn`, și atât. **Fluxul se creează oricum**, utilizatorul primește confirmarea
obișnuită și pleacă crezând că a lansat fluxul. Al doilea flux rămâne orfan.

### De ce e grav, concret

`finalizeDfOnFlowCompleted` (`services/alop-link.mjs:97`) marchează documentul aprobat prin
`WHERE flow_id=$1`. Dacă pointerul a rămas pe primul flux și apoi primul e anulat, fluxul viu
se semnează integral, se finalizează — și găsește ZERO rânduri. Documentul rămâne neaprobat
definitiv, fără nicio eroare nicăieri. Exact starea în care a ajuns DF 45749.

### ⛔ Ce NU e problema (verificat — nu „repara" asta)

Faptul că anularea obișnuită lasă `formulare_df.flow_id` / `formulare_ord.flow_id` pe loc
**este o decizie deliberată**, documentată în `services/flow-undo.mjs:9-18`: pointerul e
mânerul prin care operațiile ulterioare regăsesc documentul (`flow-undo.mjs:49` caută DF-ul
după `flow_id`). Tiparul proiectat e „anulezi, apoi lansezi, iar lansarea preia pointerul,
fiindcă vechiul nu mai e viu".

**NU goli pointerii la anulare.** Ar contrazice designul și ar rupe desfacerea. Singura
verigă lipsă e poarta de la lansare.

---

## Decizia de produs (luată de Mircea, 02.09.2026)

> Poarta se închide COMPLET. Anularea e singura cale de a porni un flux nou pe un document
> care are deja unul.

Nicio portiță „pornește oricum, în paralel". Datele o susțin: 44 din 48 de cazuri sunt
înlocuiri, nu paralelism intenționat. Dacă apare vreodată un caz legitim, se discută atunci,
cu exemplul în față.

---

## ETAPA 0 — ancore (READ-ONLY, zero modificări)

```bash
cd $(git rev-parse --show-toplevel)
git rev-parse --abbrev-ref HEAD        # Așteptat: develop
git status --short
node -e "console.log(require('./package.json').version)"   # Așteptat: 3.9.823

# A0.1 — blocurile de revendicare a pointerului (DF și ORD), cu liniile REALE
grep -n "PASUL 3: Leagă flow_id" -A 60 server/routes/flows/crud.mjs | head -70

# A0.2 — predicatul „flux viu", sursa unică
sed -n '28,40p' server/services/flow-provenance.mjs

# A0.3 — importurile existente în crud.mjs
grep -n "^import" server/routes/flows/crud.mjs

# A0.4 — ruta de creare a fluxului: metodă, cale, forma răspunsului de succes
grep -n "router.post('/flows'" -A 12 server/routes/flows/crud.mjs | head -16
grep -n "res.json\|res.status(4" server/routes/flows/crud.mjs | head -20

# A0.5 — cine lansează fluxuri din frontend (toți apelanții)
grep -rn "'/api/flows'\|\"/api/flows\"\|fetch('/flows'\|/api/flows'," public/js --include=*.js | head

# A0.6 — cache busting: ce fișiere din public/ sunt precacheuite
grep -n "PRECACHE_ASSETS" -A 20 public/sw.js | head -26
```

⚠️ Liniile din context (457, 482, 97) sunt orientative — au fost citite pe v3.9.821 și s-au
putut deplasa. **Folosește numerele reale din A0.1.** Dacă structura blocurilor diferă de
descriere, oprește-te și raportează.

---

## ETAPA A — poarta pe server (fail-closed)

**Fișier:** `server/routes/flows/crud.mjs`, în ruta de creare a fluxului.

Poarta se așază **ÎNAINTE** de crearea fluxului, nu după. Azi fluxul se creează și abia apoi
se încearcă legarea; noi refuzăm din start, ca să nu rămână niciun flux orfan în `flows`.

Comportament:

1. Dacă `body.meta?.dfId` e prezent, cauți un flux VIU care revendică acel document —
   folosind **`liveFlowSql`** din `services/flow-provenance.mjs`, nu un predicat scris de
   mână. Idem pentru `body.meta?.ordId`.
2. Dacă există, răspunzi **409** cu un cod de eroare NOU, `document_are_flux_viu`, și un corp
   care conține destul cât frontendul să fie util: id-ul fluxului existent, statusul lui,
   momentul creării, și câți semnatari au semnat din total.
3. Dacă nu există, continui exact ca azi. Zero schimbare pe calea normală.

⛔ **Predicatul contează, citește cu atenție.** `liveFlowSql` = nețters, ne-anulat,
ne-refuzat. Un flux **finalizat E viu** după această definiție, și asta e intenționat: cele
două fluxuri de la ORD 44269 erau amândouă finalizate. Nu-l înlocui cu `validSignedFlowSql`
(care e alt predicat, despre „valid semnat") și nu-i adăuga excepții pentru `completed`.

⛔ **Sursa de adevăr pentru „ce fluxuri revendică documentul" e `data->'meta'->>'dfId'`, nu
`formulare_df.flow_id`.** Pointerul arată un singur flux; noi vrem să știm dacă EXISTĂ vreunul
viu, inclusiv unul care n-a apucat să ia pointerul. Dacă cheiezi pe pointer, poarta ratează
exact cazul pe care îl repară.

⚠️ Interogarea trebuie să fie scoped pe organizație (`orgId`), la fel ca `UPDATE`-ul existent.

⚠️ Verifică dacă blocul de revendicare a pointerului (`rowCount === 0` + `logger.warn`) mai
are sens după poartă. **Nu-l șterge** — rămâne ca a doua linie de apărare împotriva curselor
(două cereri simultane care trec amândouă de poartă). Dar `logger.warn`-ul lui merită
reformulat: „posibil dublu-click" a devenit ipoteza greșită, iar acum ar însemna o cursă
reală, nu o relansare. Actualizează doar TEXTUL mesajului.

---

## ETAPA B — mesajul în frontend

Toți apelanții găsiți la A0.5 trebuie să trateze 409-ul cu codul nou. Un 409 netratat ar
apărea ca eroare generică, iar utilizatorul n-ar înțelege ce să facă.

Mesajul trebuie să spună trei lucruri, în ordinea asta:

1. **ce s-a întâmplat** — documentul are deja un flux de semnare pornit;
2. **starea lui** — de când, câți au semnat din total;
3. **ce are de făcut** — să anuleze fluxul existent, apoi să pornească unul nou.

⛔ Nu inventa un buton „anulează și pornește" în acest lot. Anularea are propriile gărzi și
propriul ecran; un buton care le ocolește ar fi o poartă nouă, netestată, strecurată într-un
lot de blocare. Dacă e ușor și sigur, un link către fluxul existent e binevenit — dar numai
dacă ruta există deja.

⛔ Nu folosi `alert()` dacă fișierul respectiv are deja un mecanism propriu de mesaje.
Respectă convenția locală a fiecărui apelant.

Bump `?v=` DOAR pe fișierele modificate. Dacă vreunul e în `PRECACHE_ASSETS` (A0.6), bump-ezi
și `CACHE_VERSION`; dacă niciunul nu e, **nu-l atinge**.

---

## ETAPA C — teste

### C.1 — DB real: `server/tests/db/flux-poarta-lansare.test.mjs` (nou)

1. ⭐ Document (DF) cu un flux **activ** ⇒ lansarea a doua întoarce **409**,
   `error: 'document_are_flux_viu'`, iar în `flows` **nu** s-a creat niciun rând nou.
   Verifică numărul de rânduri înainte/după — ăsta e miezul lotului.
2. ⭐ Același caz pentru **ORD**.
3. ⭐ Document cu un flux **finalizat** (nu anulat) ⇒ tot 409. Este cazul ORD 44269.
4. Document cu un flux **anulat** ⇒ lansarea REUȘEȘTE, iar `formulare_df.flow_id` devine
   noul flux. Ăsta e tiparul proiectat („anulezi, apoi lansezi") — dovada că poarta nu-l rupe.
5. Document cu un flux **refuzat** ⇒ lansarea reușește (reinițiere legitimă după refuz;
   vezi comentariul din `liveFlowSql`).
6. Document cu un flux **soft-șters** ⇒ lansarea reușește.
7. Document fără niciun flux ⇒ lansarea reușește. Calea normală, neatinsă.
8. ⭐ Fluxul viu al **altui** document nu blochează lansarea pe documentul curent
   (poarta e cheiată pe `meta.dfId`, nu pe organizație sau utilizator).
9. ⭐ Scoping pe organizație: un flux viu al unui document cu același id dintr-o ALTĂ
   organizație nu blochează. (Dacă modelul face id-urile globale, spune-o în raport în loc
   să forțezi testul.)
10. Corpul răspunsului 409 conține id-ul fluxului existent și numărul de semnături puse.

### C.2 — analiză statică, cablarea din frontend

Pentru fiecare apelant găsit la A0.5: tratează codul `document_are_flux_viu` și afișează un
mesaj. Tiparul din `admin-cancel-ui.test.mjs`.

### C.3 — anti-regresie pe predicat

⭐ Testul verifică faptul că poarta folosește `liveFlowSql` din `flow-provenance.mjs`, nu un
predicat scris de mână: `crud.mjs` îl importă, iar în noul bloc nu apare literalul
`IS DISTINCT FROM 'cancelled'`. Fără asta, a cincea copie a predicatului apare în trei luni.

Dacă un test EXISTENT cade, analizează întâi dacă el codifica lansarea în paralel (atunci se
corectează, cu justificare explicită) sau dacă e regresie reală (atunci te oprești).
**Nu slăbi poarta ca să treacă un test.**

---

## ETAPA D — verificări, versionare, push

```bash
node --check server/routes/flows/crud.mjs
npm run check                       # exit 0 (acum acoperă toate fișierele, #169)

grep -n "liveFlowSql" server/routes/flows/crud.mjs        # Așteptat: import + folosire
grep -c "document_are_flux_viu" server/routes/flows/crud.mjs
grep -rn "document_are_flux_viu" public/js                # toți apelanții din A0.5

npm test
npm run test:db                     # PG 17 efemer, port 55432. PASSED, nu SKIPPED.
```

```bash
# package.json: 3.9.823 → 3.9.824
git status --short                  # verifică lista ÎNAINTE de commit
git commit -m "#170: poarta la lansare — un document nu mai poate avea doua fluxuri vii (v3.9.824)"
git push origin develop
```

---

## RAPORT FINAL

1. Ancorele din Etapa 0, **literal** — în special A0.1 (liniile reale) și A0.5 (lista
   completă a apelanților din frontend).
2. Diff-ul pe fiecare fișier.
3. Interogarea FINALĂ a porții, copiată integral, cu predicatul interpolat vizibil.
4. Rezultatul explicit al fiecărui caz ⭐ din C.1, în special (1) — numărul de rânduri din
   `flows` înainte și după lansarea refuzată.
5. Corpul complet al răspunsului 409, așa cum îl vede frontendul.
6. Mesajul afișat de fiecare apelant, textual.
7. Ce ai făcut cu `logger.warn`-ul de la `rowCount === 0` și de ce.
8. Ieșirea fiecărei comenzi `grep` din Etapa D.
9. **Constatare cerută explicit, fără reparație:** cu poarta activă, mai poate ajunge un
   document în starea lui DF 45749 (pointer pe flux mort + flux viu orfan)? Enumeră căile
   rămase — inclusiv cursele între două cereri simultane și orice cale care creează fluxuri
   ocolind ruta asta (import, migrare, `bulk-signing/initiate`). **Nu repara nimic.**
10. `npm test` / `npm run test:db` — rezultat real. Orice test existent atins, cu justificare.
11. Hash-ul commitului + confirmarea push-ului pe `develop`.

## ⛔ CONSTRÂNGERI ABSOLUTE

- **Nu goli `formulare_df.flow_id` / `formulare_ord.flow_id` la anulare.** E o decizie
  deliberată, documentată în `flow-undo.mjs:9-18`. Orice atingere acolo rupe desfacerea.
- Nu folosi `validSignedFlowSql` în locul lui `liveFlowSql`, și nu scrie predicatul de mână.
- Nu cheia poarta pe `formulare_df.flow_id` — cheia e `data->'meta'->>'dfId'`.
- Nu șterge blocul `rowCount === 0`; doar reformulează textul mesajului.
- Nu adăuga un buton „anulează și pornește" și nu atinge rutele de anulare.
- Nu adăuga o portiță de ocolire a porții (parametru, antet, rol special). Decizia e
  „închisă complet".
- Zero migrații. Zona NO-TOUCH neatinsă. Nu atinge `bulk-signing.mjs`.
- ⚠️ Pe STAGING, înainte de merge, Mircea testează: (1) DF cu flux activ ⇒ a doua lansare e
  refuzată, cu mesaj clar, și nu apare niciun flux nou în listă; (2) anulează fluxul, apoi
  lansează ⇒ reușește și pointerul se mută pe fluxul nou; (3) DF fără flux ⇒ lansare normală,
  neschimbată; (4) ORD, aceleași trei.
- Orice verificare cu rezultat neașteptat ⇒ oprire și raport, fără improvizație.
