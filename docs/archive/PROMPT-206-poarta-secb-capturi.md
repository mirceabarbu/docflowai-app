---
prompt: 206
titlu: "Poarta de server: Secțiunea B și capturile DF sunt atributul responsabilului CAB"
model_suggested: "Opus 5"
efort: high
branch: develop
versiune_curenta: v3.9.858  (DUPĂ #205 — vezi ⚠️ de mai jos)
versiune_tinta: v3.9.859
migratii: NU
scrieri_in_baza: NU
fisiere_din_public: NU  (⇒ FĂRĂ `CACHE_VERSION`, FĂRĂ `?v=`)
zona_no_touch_atinsa: NU
tip: autorizare (poartă nouă pe server)
---

# ⚠️ BRANCH ȘI ORDINE

**EXCLUSIV `develop`**. Fără `checkout main`, `merge`, `push main`, deploy.
Final: **`git push origin develop`**, apoi **stop** și raportezi.

⚠️ **Lotul ăsta vine DUPĂ #205**, care a modificat exact handlerul de capturi din
`server/routes/formulare/shared.mjs` (a înlocuit `DELETE`+`INSERT` cu `INSERT ... ON CONFLICT`).

**Primul pas: `git pull origin develop`** și confirmă că `package.json` arată **3.9.858** și că
`ON CONFLICT (form_type, form_id, slot, (COALESCE(bloc_idx, 0)))` e prezent în handler.
Dacă nu, **oprește-te** — lucrezi pe cod dinaintea lui #205 și patch-urile nu se vor potrivi.

---

# CONTEXTUL — regula de business și golul din server

Conform **normelor ALOP și ghidului de finanțare**, pe Documentul de Fundamentare:

- **Secțiunea A** (obiect, valori, distribuția pe ani) = atributul **inițiatorului**, P1
- **Secțiunea B** (controlul angajamentului, `rows_ctrl`) și **capturile de ecran** =
  atributul **responsabilului CAB**, P2

Regula e obligatorie, vine din norme, **nu e o convenție de lucru a unei primării** ⇒ se scrie
în cod ca poartă fixă, **nu** ca setare pe organizație.

Azi regula e aplicată **doar în interfață**. Serverul o lasă deschisă în două locuri:

## Golul 1 — `PUT /api/formulare-df/:id`, linia ~419

```js
const allowedFields = isP2 && !isP1 ? DF_P2_FIELDS : [...DF_P1_FIELDS, ...DF_P2_FIELDS];
```

Filtrul e **asimetric**: un P2 pur primește doar `DF_P2_FIELDS` (corect), dar **P1 primește
ambele seturi**, deci și `rows_ctrl`. Un inițiator poate scrie Secțiunea B direct pe API.

Comentariul de la linia ~422 enunță chiar principiul care lipsește aici:
*„Serverul e poarta: frontendul se poate ocoli."*

## Golul 2 — `POST /api/formulare-capturi/:type/:id`

Handlerul verifică doar `authz.allowed` și **ignoră `authz.role`**. `canEditFormular` întoarce
`allowed: true` pentru `creator`, `comp`, `assigned`, `p2_comp`, `cab_dept` și `admin`, fără să
distingă. Deci P1 trece ca `role: 'creator'` și poate încărca capturi.

## Atenuarea existentă (motivul pentru care nu e incendiu)

P1 poate scrie doar în `draft`, `returnat`, `de_revizuit` (poarta de status, linia ~415). După
trimiterea la CAB, statusul e `pending_p2` și P1 e blocat oricum. Fereastra e îngustă — dar
**revizia proaspătă este în `draft`**, deci exact scenariul care a ridicat întrebarea.

## Măsurat pe producție (14.09.2026) — raza de acțiune

```
df_cu_secB = 191 · secB_fara_p2 = 0 · p2_este_creatorul = 0 · inca_editabile = 2
```

**191 din 191** de documente cu Secțiunea B au trecut printr-un P2. Regula e deja respectată din
disciplina utilizatorilor. Poarta **nu schimbă un mod de lucru**, doar îl scrie în cod. Doar
**2** documente sunt în stare în care P1 ar mai putea scrie.

⭐ De aceea poarta poate fi **strictă (refuz), nu avertisment**. Nu e nevoie de etapă intermediară
de logare: nu există trafic de rupt.

---

# ⭐ REGULA CARE TREBUIE SCRISĂ DIN CAPUL LOCULUI

`p2_este_creatorul = 0` pe organizația măsurată, dar asta e **o singură primărie**. În comunele
mici, aceeași persoană e și inițiator, și responsabil CAB — comentariul #131c din
`authz-formular.mjs` descrie exact configurația.

**Dacă cineva e simultan P1 și P2, primește AMBELE seturi.** Are dreptul prin al doilea rol; nu
se refuză pentru primul. Se scrie acum, ca regulă, nu adăugată mai târziu ca excepție când se
plânge un client.

---

# ⛔ CE NU INTRĂ ÎN LOT

| | |
|---|---|
| **ORD** (`type === 'ord'`) | Rolurile P1/P2 pe ORD au altă semantică (`ORD_P2_FIELDS = ['rows']`). Nu cunoaștem regula ALOP pentru capturile ORD, iar o poartă greșită ar bloca un flux funcțional. Poarta se aplică **DOAR pentru `df`**. |
| **Atașamentele** (`formulare_atasamente`) | Anexele justificative sunt atributul **inițiatorului**, nu al CAB-ului. Regula privește Secțiunea B și capturile. Handlerul de atașamente rămâne **NEATINS**. |
| **`canEditFormular`** | Nu se modifică. Ea răspunde la „poate atinge documentul?"; poarta nouă răspunde la „poate atinge ACEST câmp?". Sunt întrebări diferite și rămân funcții diferite. |
| **Frontendul** | `applyDfRoleState` ascunde deja Secțiunea B și capturile de P1. Lotul e **server-only**. Zero fișiere din `public/`. |

---

# ETAPA 0 — ancore

```bash
git pull origin develop
node -e "console.log(require('./package.json').version)"
# Așteptat: 3.9.858  (dacă nu ⇒ OPREȘTE-TE, #205 n-a aterizat)

grep -n "ON CONFLICT (form_type, form_id, slot" server/routes/formulare/shared.mjs
# Așteptat: 1 linie (reparația #205)

grep -n "const allowedFields = isP2" server/routes/formulare/df.mjs
grep -n "const isP1 = \|const isP2 = " server/routes/formulare/df.mjs

grep -n "DF_P2_FIELDS = " -A4 server/services/formular-shared.mjs
# Așteptat: ckbx_secta_inreg_ctrl_ang, ckbx_fara_inreg_ctrl_ang, sum_fara_inreg_ctrl_crdbug,
#           sum_fara_inreg_ctrl_crd_bug, ckbx_interzis_emit_ang, ckbx_interzis_intrucat,
#           intrucat, rows_ctrl

grep -rn "DF_P2_FIELDS\|ORD_P2_FIELDS" server --include=*.mjs | grep -v "^server/tests/"
# ⭐ Cine le mai folosește în afară de PUT? Dacă apare un al treilea consumator,
#   RAPORTEAZĂ-L înainte de a scrie — poarta trebuie să fie coerentă peste tot.
```

---

# ETAPA A — filtrul de câmpuri devine simetric

`server/routes/formulare/df.mjs`, linia ~419.

`old_str`:
```js
    const allowedFields = isP2 && !isP1 ? DF_P2_FIELDS : [...DF_P1_FIELDS, ...DF_P2_FIELDS];
```
`new_str`:
```js
    // #206 — Secțiunea B (`rows_ctrl` și celelalte câmpuri de control) e atributul
    // responsabilului CAB, conform normelor ALOP. Filtrul era ASIMETRIC: P2 pur primea
    // doar DF_P2_FIELDS, dar P1 primea AMBELE seturi, deci un inițiator putea scrie
    // Secțiunea B direct pe API, ocolind interfața care i-o ascunde.
    //
    // Cine e simultan P1 și P2 (comune mici — aceeași persoană e inițiator și responsabil
    // CAB, vezi #131c) primește AMBELE seturi: are dreptul prin al doilea rol.
    const isAdminLike = ['admin', 'org_admin'].includes(actor.role);
    const allowedFields = isAdminLike
      ? [...DF_P1_FIELDS, ...DF_P2_FIELDS]
      : (isP1 && isP2) ? [...DF_P1_FIELDS, ...DF_P2_FIELDS]
      : isP2            ? DF_P2_FIELDS
      : isP1            ? DF_P1_FIELDS
      : [];
```

⚠️ `authz.role === 'admin'` intră deja în `isP1` (linia ~389). Ramura `isAdminLike` e explicită
ca intenția să fie citibilă, nu implicită printr-un efect secundar al lui `isP1`.

⚠️ `cab_dept` (membru al compartimentului CAB al organizației) **nu** apare azi nici în `isP1`,
nici în `isP2`. Verifică ce se întâmplă cu el sub filtrul nou: dacă ajunge la `[]`, un membru CAB
care nu e nici creator, nici atribuit, nu mai poate salva nimic — **regresie**. Dacă e cazul,
**raportează înainte de a scrie**; probabil trebuie tratat ca P2, dar nu decid asta fără să văd
codul exact.

## Ce NU se întâmplă: pierdere de date

`pick()` **filtrează**, nu golește. Dacă frontendul trimite `rows_ctrl` la un salvat făcut de P1,
câmpul lipsește din `data`, deci `UPDATE`-ul nu-l atinge — valoarea existentă rămâne intactă.
Testul B.4 ancorează asta explicit.

---

# ETAPA B — poarta pe capturi (doar DF)

`server/routes/formulare/shared.mjs`, în handlerul de upload, **imediat după** verificarea
`authz.allowed`:

```js
    // #206 — capturile de ecran de pe DF sunt atributul responsabilului CAB (norme ALOP),
    // ca și Secțiunea B. Handlerul se uita doar la `allowed`, ignorând `role`, deci P1
    // trecea ca `creator`. Poarta se aplică DOAR pe `df`: rolurile P1/P2 pe ORD au altă
    // semantică, iar o poartă greșită acolo ar bloca un flux funcțional (#206, în afara scopului).
    if (type === 'df' && !['admin', 'org_admin'].includes(actor.role)) {
      const esteP2 = doc.assigned_to === actor.userId
                  || authz.role === 'p2_comp'
                  || authz.role === 'cab_dept';
      if (!esteP2) {
        logger.warn({ type, id, actorRole: authz.role, actor: actor.email },
          '#206 captura DF refuzată: nu e responsabil CAB');
        return res.status(403).json({ error: 'doar_responsabil_cab',
          message: 'Capturile de ecran se încarcă de responsabilul CAB.' });
      }
    }
```

⚠️ Handlerul citește azi `SELECT created_by, assigned_to, status` (fără `p2_compartiment`).
Verifică ce câmpuri îți trebuie pentru testul de P2 și **extinde `SELECT`-ul dacă e nevoie** —
`canEditFormular` primește `doc`, iar dacă `p2_compartiment` lipsește, ramura `p2_comp` nu se
evaluează niciodată și poarta refuză oameni îndreptățiți. **Verifică, nu presupune.**

⚠️ Codul de eroare e `doar_responsabil_cab`, **nu** `forbidden` generic — ca frontendul să poată
afișa un mesaj util, iar #205 (care acum raportează eșecurile de upload în loc să le înghită) să
nu arate „eroare de server" pe un refuz legitim.

---

# ETAPA C — teste

## C.1 — `server/tests/integration/df-secb-poarta.test.mjs` (nou)

1. ⭐ **P1 pur** (creator, doc în `draft`) trimite `PUT` cu `rows_ctrl` modificat
   ⇒ 200, dar `rows_ctrl` din bază e **NESCHIMBAT**. (Fără pierdere de date — vezi Etapa A.)
2. ⭐ **P1 pur** modifică simultan un câmp P1 **și** `rows_ctrl` ⇒ câmpul P1 se scrie,
   `rows_ctrl` nu. Salvarea nu e respinsă.
3. **P2 pur** scrie `rows_ctrl` ⇒ se aplică; încearcă un câmp P1 ⇒ ignorat (comportamentul de azi,
   neregresie).
4. ⭐ **P1 ȘI P2 simultan** (același user creator și `assigned_to`) ⇒ **ambele** seturi se scriu.
5. `admin` / `org_admin` ⇒ ambele seturi.
6. ⭐ `cab_dept` (membru CAB, nici creator, nici atribuit) ⇒ comportamentul pe care îl constați la
   Etapa A. **Scrie testul după ce raportezi ce ai găsit**, nu invers.

## C.2 — `server/tests/integration/capturi-poarta-cab.test.mjs` (nou)

7. ⭐ P1 pur încarcă captură pe **DF** ⇒ **403 `doar_responsabil_cab`**, zero rânduri scrise.
8. P2 (`assigned_to`) ⇒ 200, captura există.
9. `p2_comp` (prin `p2_compartiment`) ⇒ 200. ⚠️ Ăsta prinde `SELECT`-ul incomplet din Etapa B.
10. `cab_dept` ⇒ 200.
11. `admin` ⇒ 200.
12. ⭐ **ORD neatins**: P1 pur încarcă captură pe **ORD** ⇒ **200**, exact ca înainte de lot.
    Ancorează limita de scop.
13. Reparația #205 rămâne intactă: două încărcări **paralele** de către un P2 ⇒ ambele 200, un
    singur rând. (Rulează de ≥3 ori.)

## C.3

```bash
npm test
npm run test:db
```

⚠️ **Secvențial.** Verdictul din **output real**, niciodată dintr-un sumar de fundal.
`skipped` ≠ `passed`.

⛔ Test preexistent care pică ⇒ **raportează ÎNAINTE de a-l atinge.** Aici e probabil: pot exista
teste care salvează `rows_ctrl` ca P1 din comoditate de fixture. Un astfel de test **descrie golul
pe care îl închidem** — dar nu-l modifica fără să-mi spui care e și de ce.

---

# ETAPA D — versiune și commit

```bash
npm version 3.9.859 --no-git-tag-version
npm install --package-lock-only
git status --short
```

**Zero fișiere din `public/`** ⇒ `CACHE_VERSION` neatins, `?v=` neatins. Verifică.

`git add` explicit. Arhivează promptul în `docs/archive/`, în același commit.

```
feat(#206): poarta de server pentru Sectiunea B si capturile DF — v3.9.859

Normele ALOP: Sectiunea A e atributul initiatorului (P1), Sectiunea B
(rows_ctrl) si capturile sunt ale responsabilului CAB (P2). Regula era aplicata
DOAR in interfata.

PUT /api/formulare-df: filtrul de campuri era asimetric — P2 pur primea doar
DF_P2_FIELDS, dar P1 primea AMBELE seturi, deci un initiator putea scrie
Sectiunea B direct pe API. Devine simetric.

POST /api/formulare-capturi: handlerul se uita doar la authz.allowed, ignorand
authz.role, deci P1 trecea ca `creator`. Poarta cere P2, DOAR pentru df.

Cine e simultan P1 si P2 (comune mici, #131c) primeste AMBELE seturi: are
dreptul prin al doilea rol.

Masurat inainte pe productie: 191 DF-uri cu Sectiunea B, 0 fara P2, 0 unde P2 e
creatorul, 2 inca editabile. Regula era deja respectata in practica, deci poarta
e stricta (refuz), nu avertisment — nu exista trafic de rupt.

NEATINSE: ORD (alta semantica P1/P2), atasamentele (anexele sunt ale
initiatorului), canEditFormular, frontendul. Reparatia #205 (ON CONFLICT)
ramane, ancorata de testul 13.
```

```bash
git push origin develop
```

**Stop.**

---

# RAPORT FINAL

1. Ancorele Etapa 0, cu valorile **OBȚINUTE**. ⭐ Confirmarea că pornești de pe 3.9.858 cu #205 prezent.
2. ⭐ Al treilea consumator de `DF_P2_FIELDS`, dacă există.
3. ⭐ **Ce se întâmplă cu `cab_dept`** sub filtrul nou din Etapa A, și ce ai decis.
4. ⭐ Dacă `SELECT`-ul din handlerul de capturi a trebuit extins și cu ce câmpuri.
5. Rezultatul fiecărui test din C.1 și C.2, **în special 1, 2, 4, 7, 12, 13**.
6. Teste preexistente care au picat — **care și de ce**. (Probabil fixture care scriu `rows_ctrl` ca P1.)
7. Numere reale `npm test` / `npm run test:db`, secvențial, cu sursa verdictului declarată.
8. Confirmarea că `git diff` e **gol** pe `public/`, pe handlerul de atașamente și pe `authz-formular.mjs`.
9. Divergențe prompt ↔ cod — **raportate, NU reparate tăcut**.
10. Colaterale.

---

# ⛔ CONSTRÂNGERI ABSOLUTE

- `develop` ONLY. Fără `main`, merge, deploy. **Pornești de pe 3.9.858, după #205.**
- **ORD: NEATINS.** Poarta doar pentru `type === 'df'`. Testul 12 o ancorează.
- **Atașamentele: NEATINSE.** **`canEditFormular`: NEATINSĂ.**
- Zero fișiere din `public/`.
- P1+P2 simultan ⇒ ambele seturi. Scris din capul locului, nu ca excepție ulterioară.
- `pick()` filtrează, nu golește — nicio valoare existentă nu se pierde. Testele 1 și 2 o dovedesc.
- Reparația #205 rămâne intactă.
- `git add` explicit. `git push origin develop`, apoi **stop**.
- `old_str` care nu se potrivește exact o dată ⇒ **OPREȘTE-TE și raportează**.
