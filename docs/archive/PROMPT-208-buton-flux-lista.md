---
prompt: 208
titlu: "Buton „Deschide fluxul de semnare\" în lista DF/ORD"
model_suggested: "Sonnet 5"
efort: medium
branch: develop
versiune_curenta: v3.9.860  (după #207)
versiune_tinta: v3.9.861
migratii: NU
scrieri_in_baza: NU
fisiere_din_public: DA ⇒ `?v=` ȚINTIT + verificare `CACHE_VERSION`
zona_no_touch_atinsa: NU
tip: UX (o coloană nouă în listă + un buton)
---

# ⚠️ BRANCH

**EXCLUSIV `develop`**. Fără `checkout main`, `merge`, `push main`, deploy.
Final: **`git push origin develop`**, apoi **stop** și raportezi.

---

# CONTEXTUL ȘI OBIECTIVUL

Azi, un utilizator care vrea să vadă unde a ajuns un DF/ORD trimis pe flux trebuie să: rețină
numărul documentului → navigheze la „Fluxurile mele" → caute fluxul. Trei pași pentru o
informație pe care aplicația o are deja.

Obiectivul: **un buton pe rândul din listă care deschide direct fluxul de semnare.**

---

# ⭐ DE CE LOTUL E MIC — verificat pe cod, nu presupus

**Autorizarea e deja rezolvată și nu se atinge.** `isAllowedViaFormular`
(`services/flow-access.mjs:70`, adăugată la #153) deschide fluxul dacă e fluxul de semnare al
unui DF/ORD pe care actorul are deja dreptul să-l vadă — verdictul îl dă `canViewFormular`.

Iar filtrul de vizibilitate al listei (`routes/formulare/shared.mjs:~500` pentru DF, `~700`
pentru ORD) aplică **exact aceleași ramuri**: creator, atribuit, coleg de compartiment al
creatorului, document atribuit compartimentului meu, persoană din compartimentul meu, plus
`cab_dept` care vede tot.

**Deci: dacă documentul e în lista ta, fluxul lui ți se deschide.** Nu e nevoie de niciun calcul
de vizibilitate per rând și nu există riscul unui buton care dă 403.

⛔ **NU adăuga nicio verificare de autorizare** în lotul ăsta — nici pe server, nici pe frontend.
Orice „gardă suplimentară de siguranță" ar fi o a doua sursă de adevăr peste `canViewFormular`,
adică exact tiparul pe care l-am demontat la #204 și #206.

**`flow_id` ajunge deja la client.** E în `SELECT`-ul ambelor ramuri (DF `~610`, ORD `~797`), iar
`res.json` (`:691`, `:859`) trimite toate coloanele prin spread. Nu e nevoie să-l adaugi.

**Ecranul de flux există**: `/flow.html?flow=<flowId>`.

---

# DECIZII DE PRODUS (luate, nu de renegociat)

| Întrebare | Decizia |
|---|---|
| Coleg de compartiment care nu e parte din flux | **Nu vede butonul** dacă nu vede documentul. Rezultă automat din filtrul listei — nimic de implementat. |
| Revizii DF (fiecare cu `flow_id` propriu) | **Doar revizia curentă**, cea afișată în listă. Fără acces la fluxurile reviziilor anterioare. |
| Se afișează doar cât documentul „stă pe flux"? | **NU.** Butonul apare ori de câte ori există flux viu, inclusiv după aprobare. Un utilizator care vrea să vadă *cine a semnat și când* are aceeași nevoie ca unul care vrea să vadă *unde stă* — iar dacă butonul dispare la aprobare, îl trimitem înapoi la căutare manuală fix în cazul cel mai frecvent. |
| Flux anulat / refuzat | **Butonul APARE.** `cancelled` și `refused` sunt stări vizibile și utile (vrei să vezi de ce). Doar fluxul **șters** (`deleted_at`) ascunde butonul. |

---

# ETAPA 0 — ancore

```bash
grep -n "fd.flow_id," server/routes/formulare/shared.mjs
grep -n "fo.flow_id," server/routes/formulare/shared.mjs
# Așteptat: câte 1 (în SELECT-ul fiecărei ramuri)

grep -n "res.json({ ok: true, rows: rows.map" server/routes/formulare/shared.mjs
# Așteptat: 2 (DF ~691, ORD ~859) — spread, deci toate coloanele trec

grep -n "trasab-inline-btn" public/js/formular/list.js
# Așteptat: 1 linie (~950) — celula e comună pentru DF și ORD

grep -n "LEFT JOIN flows f" server/routes/formulare/shared.mjs
# ⭐ Confirmă că `f` e disponibil în AMBELE ramuri. Dacă într-una lipsește sau are alt
#   alias, RAPORTEAZĂ înainte de a scrie Etapa A.

grep -n "list.js?v=" public/formular.html
grep -c "formular/list.js" public/sw.js
# Dacă 0 ⇒ nu e în PRECACHE_ASSETS ⇒ CACHE_VERSION neatins. Raportează care e cazul.
# ⚠️ La #207 presupunerea că fișierele nu sunt în PRECACHE s-a dovedit GREȘITĂ.
#    Verifică prin grep, niciodată din memorie.
```

---

# ETAPA A — coloana `flow_viu` (singura schimbare de server)

`flow_id` ajunge deja la client, dar el singur nu spune dacă fluxul mai există. Un flux **șters**
ar produce un buton care duce la un refuz.

În `SELECT`-ul **fiecărei** ramuri, lângă `flow_id`:

```sql
          (f.id IS NOT NULL AND f.deleted_at IS NULL) AS flow_viu,
```

(pentru ORD, același lucru cu aliasul folosit acolo — verifică-l, nu presupune că e tot `f`).

⚠️ **Doar `deleted_at`.** Un flux `cancelled` sau `refused` există și trebuie să rămână
deschizabil — vezi tabelul de decizii. Nu adăuga condiții pe `f.data->>'status'`.

⛔ Nu atinge fragmentele `_dfTransmis` / `_dfAprobat` / `_foAprobat` și nici `badge_status`. Au
comentarii care le declară **sursă unică** (#165) și sunt folosite ca inversă algebrică a
filtrelor. O coloană nouă, independentă — nimic altceva.

---

# ETAPA B — butonul în listă

`public/js/formular/list.js`, celula de la `~950`. Butonul se adaugă **după** cel de
trasabilitate.

```js
${(row.flow_id && row.flow_viu) ? `<a class="flux-inline-btn" href="/flow.html?flow=${encodeURIComponent(row.flow_id)}" target="_blank" rel="noopener" onclick="event.stopPropagation()" title="Deschide fluxul de semnare">✍️</a>` : ''}
```

Puncte de atenție:

⚠️ **Iconița NU e 🔗** — aia e deja trasabilitatea (lanțul DF↔ALOP↔ORD), pe același rând. Două
iconițe identice cu destinații diferite sunt o capcană. `✍️` sau altceva vizibil distinct; dacă
alegi alta, spune în raport care și de ce.

⚠️ **`title` distinct** de cel al trasabilității („Vezi trasabilitate (lanț DF↔ALOP↔ORD)").

⚠️ **`target="_blank"` + `rel="noopener"`** — utilizatorul nu-și pierde poziția în listă, filtrele
și paginarea. E chiar motivul pentru care există lotul: mai puțini pași, nu alții.

⚠️ **`event.stopPropagation()`** — rândul are handler de clic (`openDocFromList`); fără asta se
deschide și documentul, și fluxul.

⚠️ `encodeURIComponent` pe `flow_id`. Nu e opțional, chiar dacă valorile arată curate azi.

⚠️ Verifică numele real al variabilei rândului în funcția aia (poate fi `r`, `row`, `d`) și
**cum ajung câmpurile** — dacă există o destructurare de sus, `flow_id` și `flow_viu` trebuie
adăugate acolo, altfel sunt `undefined` și butonul nu apare niciodată, tăcut.

## B.2 — stilul

`.flux-inline-btn` în același loc cu `.trasab-inline-btn`, cu aceeași dimensiune și aliniere.
⛔ Nu rescrie `.trasab-inline-btn`.

---

# ETAPA C — teste

## C.1 — `server/tests/db/lista-flow-viu.test.mjs` (nou)

1. DF cu flux viu ⇒ `flow_id` prezent, `flow_viu = true`.
2. ⭐ DF cu flux **șters** (`flows.deleted_at` setat) ⇒ `flow_viu = false`.
3. ⭐ DF cu flux **anulat** (`data->>'status' = 'cancelled'`, `deleted_at` NULL) ⇒
   `flow_viu = true`. Ancorează decizia de produs; fără el, un lot viitor „curăță" și ascunde
   butonul pe fluxurile anulate.
4. DF fără flux (`flow_id` NULL) ⇒ `flow_viu = false`.
5. Aceleași patru pe ramura **ORD**.
6. ⭐ **Neregresie**: `badge_status` și numărul total de rânduri sunt **identice** cu înainte de
   lot, pentru același set de date. Coloana nouă nu schimbă nimic din ce se vedea.

## C.2

```bash
npm test
npm run test:db
```

⚠️ **Secvențial.** Verdictul din **output real**, niciodată dintr-un sumar de fundal.
`skipped` ≠ `passed`.

⛔ Test preexistent care pică ⇒ **raportează ÎNAINTE de a-l atinge.** Atenție la testele care
compară forma exactă a rândului din listă (`toEqual` pe obiect întreg) — acelea vor pica pe
coloana nouă. Alea sunt teste de **formă**, nu de comportament: se actualizează, dar raportează-le.

---

# ETAPA D — versiune, cache, commit

```bash
npm version 3.9.861 --no-git-tag-version
npm install --package-lock-only
git status --short
```

**`?v=` ȚINTIT** pe fișierele efectiv modificate. ⛔ Fără `sed` în masă.
**`CACHE_VERSION`** doar dacă un fișier din `PRECACHE_ASSETS` s-a schimbat — ancora din Etapa 0
îți spune. Raportează decizia **și dovada prin grep**.

`git add` explicit. Arhivează promptul în `docs/archive/`, în același commit.

```
feat(#208): buton „Deschide fluxul de semnare" in lista DF/ORD — v3.9.861

Utilizatorul trebuia sa retina numarul documentului, sa mearga la „Fluxurile
mele" si sa caute fluxul. Acum are un buton pe rand.

Lotul e mic pentru ca autorizarea era deja rezolvata: isAllowedViaFormular
(#153) deschide fluxul daca e fluxul de semnare al unui DF/ORD pe care actorul
il poate vedea, iar filtrul listei aplica exact aceleasi ramuri. Daca
documentul e in lista ta, fluxul lui ti se deschide — fara verificari noi si
fara riscul unui buton care da 403.

Server: o singura coloana, flow_viu = (f.id IS NOT NULL AND f.deleted_at IS
NULL), pe ambele ramuri. `flow_id` ajungea deja la client.

Butonul apare si dupa aprobare (vrei sa vezi cine a semnat si cand) si pe
fluxuri anulate/refuzate (vrei sa vezi de ce). Doar fluxul STERS il ascunde —
ancorat de testul 3. Deschidere in tab nou: utilizatorul nu-si pierde filtrele.

NEATINSE: autorizarea, badge_status, fragmentele _dfTransmis/_dfAprobat (sursa
unica #165), butonul de trasabilitate. Doar revizia curenta are buton.
```

```bash
git push origin develop
```

**Stop.**

---

# RAPORT FINAL

1. Ancorele Etapa 0, cu valorile **OBȚINUTE**. ⭐ În special aliasul tabelei `flows` în ambele ramuri.
2. Cum ajung `flow_id` și `flow_viu` în funcția de randare (destructurare? obiect întreg?) și ce ai adăugat.
3. Ce iconiță ai ales și de ce nu se confundă cu 🔗.
4. Rezultatul fiecărui test din C.1, **în special 2, 3 și 6**.
5. Teste preexistente atinse — care și de ce. (Așteptat: cel mult teste de formă pe rândul din listă.)
6. Decizia `CACHE_VERSION` + dovada prin grep + lista `?v=` modificate.
7. Numere reale `npm test` / `npm run test:db`, secvențial, cu sursa verdictului declarată.
8. Divergențe prompt ↔ cod — **raportate, NU reparate tăcut**.
9. Colaterale.

---

# ⛔ CONSTRÂNGERI ABSOLUTE

- `develop` ONLY. Fără `main`, merge, deploy.
- **Zero verificări noi de autorizare**, nici pe server, nici pe frontend.
- `flow_viu` doar pe `deleted_at`. Fluxurile anulate/refuzate rămân deschizabile.
- `badge_status`, `_dfTransmis`, `_dfAprobat`, `_foAprobat`, `.trasab-inline-btn`: **NEATINSE**.
- Iconiță **diferită** de 🔗, cu `title` distinct.
- `target="_blank"` + `rel="noopener"` + `event.stopPropagation()` + `encodeURIComponent`.
- `?v=` țintit. `git add` explicit. `git push origin develop`, apoi **stop**.
- `old_str` care nu se potrivește exact o dată ⇒ **OPREȘTE-TE și raportează**.
