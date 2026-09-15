---
prompt: 210
titlu: "admin / org_admin la porțile de acceptare OPME și reluare a confirmării plății"
model_suggested: "Sonnet 5"
efort: medium
branch: develop
versiune_curenta: v3.9.862
versiune_tinta: v3.9.863
migratii: NU
scrieri_in_baza: NU (lărgește cine poate declanșa scrieri existente)
fisiere_din_public: NU  (⇒ FĂRĂ `CACHE_VERSION`, FĂRĂ `?v=`)
zona_no_touch_atinsa: NU
tip: autorizare (lărgirea unei porți)
---

# ⚠️ BRANCH

**EXCLUSIV `develop`**. Fără `checkout main`, `merge`, `push main`, deploy.
Final: **`git push origin develop`**, apoi **stop** și raportezi.

---

# CONTEXTUL

#209 a introdus două acțiuni excepționale pe plăți, ambele cu poarta `isCabDept` — pentru că
**așa cerea promptul #209**, literal: *„exact poarta folosită în `alop.mjs:355`, nu inventa alt
criteriu"*. Agentul a respectat instrucțiunea; instrucțiunea era prea strictă.

Consecința, observată în producție (15.09.2026): un utilizator cu rol **`admin`** deschide
raportul OPME, vede liniile respinse, dar **butonul „Acceptă potrivirea" nu apare** — pentru că
`can_accept` (`opme.mjs:~432`) e calculat doar din `isCabDept`. Nu are nici cum să relanseze
confirmarea (`alop.mjs:~2007`). Fluxul introdus la #209 e inaccesibil pentru contul de operare.

## De ce lărgim

În **același fișier**, `admin` și `org_admin` pot deja: importa OPME (`:101`), **re-rula
matching-ul** (`:643`) și exporta (`:686`). Re-matching-ul rescrie `match_status` pe zeci de
linii dintr-un import. Dacă au voie la aceea, excluderea lor exact de la acceptarea unei linii e
o inconsecvență, nu o politică.

Mecanismul real de control rămâne neschimbat: **motiv scris obligatoriu** (min. 10 caractere) și
**audit cu valorile vechi**, pe ambele acțiuni.

## ⛔ Cât de mult lărgim — citește cu atenție

`_hasOpmeImportRole` (`opme.mjs:~56`) **NU se folosește aici.** Pe lângă `admin` și `org_admin`,
ea permite oricui e `assigned_to` pe un DF/ORD **și** oricui e în același compartiment cu un
responsabil CAB. E semnificativ mai largă decât `isCabDept` și ar deschide acceptarea către o
populație neaprobată.

**Regula exactă, aprobată de Mircea:**

```
admin  OR  (org_admin cu orgId)  OR  isCabDept(actorComp, cabComp)
```

Nimic altceva. Un inspector obișnuit, un inițiator, un coleg de compartiment: **NU**.

---

# ETAPA 0 — ancore

```bash
grep -n "isCabDept" server/routes/opme.mjs server/routes/alop.mjs
# Așteptat: can_accept (~432), poarta de acceptare (~568), poarta de reluare (~2007),
#           plus utilizările preexistente din alop.mjs (NEATINSE)

grep -n "org_admin NU e exceptat" server/routes/alop.mjs
# ⭐ Comentariul de la ~1974 spune explicit contrariul a ce facem. TREBUIE actualizat.

grep -rn "isAdminLike" server --include=*.mjs | grep -v "^server/tests/"
# Tiparul introdus la #206 în df.mjs. Îl refolosim, nu inventăm altul.

grep -n "confirma-plata" server/routes/alop.mjs | head -3
# ⛔ Poarta de pe confirmarea NORMALĂ nu se atinge. Notează unde e, ca să eviți.
```

---

# ETAPA A — poarta de acceptare OPME (`opme.mjs:~566`)

`old_str`:
```js
    // 2. Poarta: responsabilul CAB (isCabDept — aceeași ca în alop.mjs).
    const { actorComp, cabComp } = await loadActorCompAndCab(client, actor.userId, actor.orgId);
    if (!isCabDept(actorComp, cabComp)) {
```
`new_str`:
```js
    // 2. Poarta (#210): responsabilul CAB SAU admin/org_admin.
    //    Motivul lărgirii: în același fișier, admin și org_admin pot deja importa OPME (:101),
    //    RE-RULA matching-ul (:643) — care rescrie match_status pe zeci de linii — și exporta
    //    (:686). Excluderea lor exact de la acceptarea unei linii era inconsecvență, nu politică.
    //    ⛔ NU folosi _hasOpmeImportRole: aceea permite și oricui e assigned_to pe un DF/ORD,
    //    și colegilor de compartiment ai unui responsabil CAB — mult mai larg decât s-a aprobat.
    //    Controlul real rămâne motivul scris obligatoriu + auditul.
    const isAdminLike = actor.role === 'admin' || (actor.role === 'org_admin' && actor.orgId);
    const { actorComp, cabComp } = await loadActorCompAndCab(client, actor.userId, actor.orgId);
    if (!isAdminLike && !isCabDept(actorComp, cabComp)) {
```

Mesajul de eroare se actualizează: *„Doar responsabilul CAB sau un administrator poate accepta o
potrivire OPME."* Codul de eroare rămâne **`doar_responsabil_cab`** — e deja tratat în frontend
și în teste; o schimbare de cod ar rupe lucruri fără câștig.

⚠️ Verifica ordinea: la `:560` există deja verificarea de tenant (`line.org_id === alop.org_id
=== actor.orgId`). **Rămâne neatinsă și înaintea porții de rol** — un `admin` de platformă tot nu
are voie să lege o linie dintr-o organizație de dosarul alteia.

---

# ETAPA B — `can_accept` din ruta de raport (`opme.mjs:~429`)

Aceeași regulă, altfel butonul tot nu apare:

```js
    // #210 — aceeași regulă ca poarta de acceptare: CAB sau admin/org_admin.
    let canAccept = actor.role === 'admin' || (actor.role === 'org_admin' && actor.orgId);
    if (!canAccept) {
      try {
        const { actorComp, cabComp } = await loadActorCompAndCab(pool, actor.userId, actor.orgId);
        canAccept = isCabDept(actorComp, cabComp);
      } catch (_e) { canAccept = false; }
    }
```

⭐ **Cele două trebuie să rămână identice ca regulă.** Dacă diverg, ori butonul apare și acțiunea
dă 403, ori invers. Scrie în comentariul fiecăreia că e oglinda celeilalte.

---

# ETAPA C — poarta de reluare a confirmării (`alop.mjs:~2007`)

Aceeași lărgire.

⭐ **Comentariul de la `~1974` spune azi literal: „⛔ org_admin NU e exceptat".** După schimbare
devine fals. **Actualizează-l** — un comentariu care contrazice codul e mai rău decât lipsa lui.
Noul text explică ce s-a schimbat și de ce (inconsecvența cu celelalte operații OPME, controlul
prin motiv + audit).

⛔ **Poarta de pe `confirma-plata` — confirmarea NORMALĂ a plății — rămâne EXACT cum e.** Aceea e
operarea curentă și rămâne la responsabilul CAB. Lărgim **doar** cele două căi excepționale, care
cer motiv scris și lasă audit. `git diff` pe acea rută: **gol**.

---

# ETAPA D — teste

## D.1 — `server/tests/db/opme-accept-poarta.test.mjs` (nou)

Matricea de roluri, pe acceptarea unei linii:

1. ⭐ `admin` ⇒ **200**, linia acceptată.
2. ⭐ `org_admin` din aceeași organizație ⇒ **200**.
3. `cab_dept` ⇒ 200 (neregresie #209).
4. ⭐ Inspector obișnuit, nici CAB, nici admin ⇒ **403 `doar_responsabil_cab`**, zero scrieri.
5. Inițiatorul documentului, care nu e CAB ⇒ **403**.
6. ⭐⭐ `admin` care încearcă o linie din **ALTĂ organizație** ⇒ **404**, zero scrieri.
   Lărgirea de rol **nu** slăbește izolarea pe organizație.
7. `org_admin` fără `orgId` ⇒ **403** (ramura `&& actor.orgId`).
8. `admin` fără motiv / cu motiv sub 10 caractere ⇒ **400**, zero scrieri. Lărgirea de rol nu
   dispensează de motiv.

## D.2 — `server/tests/db/plata-reia-poarta.test.mjs` (nou)

9–14. Aceeași matrice pe `/plata/reia`, plus:
15. ⭐ `admin` pe un dosar cu **ciclu avansat** ⇒ tot **409 `ciclu_avansat`**. Rolul nu trece peste
    garda de integritate.

## D.3 — `npm test`

16. ⭐ `can_accept` din ruta de raport întoarce **exact aceeași** valoare ca verdictul porții de
    acceptare, pentru fiecare rol din matrice. Testul care împiedică divergența dintre Etapa A și
    Etapa B.

## D.4

```bash
npm test
npm run test:db
```

⚠️ **Secvențial.** Verdictul din **output real**, niciodată dintr-un sumar de fundal.
`skipped` ≠ `passed`.

⛔ Test preexistent care pică ⇒ **raportează ÎNAINTE de a-l atinge.** Probabil: teste din #209
care afirmă că `admin` primește 403. Acelea **descriau poarta veche** — se actualizează, dar
raportează-le cu diff.

---

# ETAPA E — versiune și commit

```bash
npm version 3.9.863 --no-git-tag-version
npm install --package-lock-only
git status --short
```

**Zero fișiere din `public/`** ⇒ `CACHE_VERSION` și `?v=` neatinse. Verifică, nu presupune.

`git add` explicit. Arhivează promptul în `docs/archive/`, în același commit. Dacă documentul
`docs/plati-transe-conturi-diferite.md` există și e netracked, **adaugă-l acum** și actualizează
secțiunea „Cine poate face asta".

```
fix(#210): admin/org_admin pot accepta linii OPME si relua confirmarea — v3.9.863

#209 a pus ambele porti pe isCabDept, pentru ca asa cerea promptul. Consecinta
in productie: un utilizator `admin` vedea liniile respinse dar NU vedea butonul
„Accepta potrivirea" (can_accept calculat doar din isCabDept), si nu putea nici
relua confirmarea. Fluxul introdus la #209 era inaccesibil contului de operare.

Regula devine: admin OR (org_admin cu orgId) OR isCabDept.

Motiv: in acelasi fisier, admin si org_admin pot deja importa OPME, RE-RULA
matching-ul (rescrie match_status pe zeci de linii) si exporta. Excluderea lor
exact de la acceptarea unei linii era inconsecventa, nu politica.

NU s-a folosit _hasOpmeImportRole: aceea permite si oricui e assigned_to pe un
DF/ORD si colegilor de compartiment — mult mai larg decat s-a aprobat.

NEATINSE: poarta de pe confirma-plata (confirmarea normala ramane la CAB),
izolarea pe organizatie (testul 6), garda de ciclu avansat (testul 15), motivul
obligatoriu (testul 8). Comentariul din alop.mjs care spunea „org_admin NU e
exceptat" a fost actualizat.
```

```bash
git push origin develop
```

**Stop.**

---

# RAPORT FINAL

1. Ancorele Etapa 0, cu valorile **OBȚINUTE**.
2. ⭐ Confirmarea că regula din Etapa A și cea din Etapa B sunt **identice**, cu ambele fragmente.
3. Textul nou al comentariului din `alop.mjs:~1974`.
4. ⭐ `git diff` pe ruta `confirma-plata` — așteptat **gol**.
5. Rezultatul fiecărui test, **în special 4, 6, 8, 15, 16**.
6. Teste preexistente atinse, cu diff și motiv.
7. Numere reale, secvențial, cu sursa verdictului declarată.
8. Dacă ai adăugat documentul din `docs/` și ce ai actualizat în el.
9. Divergențe prompt ↔ cod — **raportate, NU reparate tăcut**.
10. Colaterale.

---

# ⛔ CONSTRÂNGERI ABSOLUTE

- `develop` ONLY. Fără `main`, merge, deploy.
- Regula exactă: `admin OR (org_admin cu orgId) OR isCabDept`. **Nimic mai larg.**
- **`_hasOpmeImportRole` NU se folosește** pentru aceste porți.
- **`confirma-plata`: NEATINSĂ.**
- Izolarea pe organizație, garda de ciclu avansat, motivul obligatoriu: **neatinse**.
- Codul de eroare rămâne `doar_responsabil_cab` (doar mesajul se schimbă).
- Etapa A și Etapa B trebuie să rămână identice ca regulă — testul 16 o apără.
- Zero fișiere din `public/`.
- `git add` explicit. `git push origin develop`, apoi **stop**.
- `old_str` care nu se potrivește exact o dată ⇒ **OPREȘTE-TE și raportează**.
