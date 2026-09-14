---
prompt: 193
titlu: "RECON: deadlock-ul intermitent (40P01) din truncateAll — de unde vine a doua sesiune"
model_suggested: "Opus 5, efort high"
branch: develop
versiune_curenta: v3.9.847
tip: RECON — READ-ONLY
livrabil: RAPORT SCRIS. Zero cod livrat, zero commit, zero push.
---

# ⚠️ CE ESTE ȘI CE NU ESTE LOTUL ĂSTA

Ăsta e un **recon**. Livrabilul e un **raport**, nu un patch.

- ⛔ **NU repara nimic.** Nici măcar „evident".
- ⛔ **NU face commit. NU face push.** Nici pe `develop`.
- ⛔ **NU modifica fișiere trackate.** Dacă instrumentezi ca să măsori, revino la starea
  curată la final și **confirmă cu `git status --short`** că working tree-ul e neschimbat.
- Rulările de teste și interogările pe baza efemeră de test sunt permise și așteptate.

Motivul e simplu: nu știm încă ce reparăm. O reparație pusă peste o ipoteză greșită ne-ar
lăsa cu flake-ul intact **și** cu cod în plus care pare că l-a rezolvat.

---

## Contextul — și de ce explicația evidentă e deja exclusă

`npm run test:db` pică intermitent cu **deadlock detected (40P01)**, ridicat din
`pool.query(TRUNCATE …)` — `server/tests/helpers/db-real.mjs:82`. Două apariții cunoscute,
pe fișiere diferite: `admin-cancel-flow.test.mjs` (#192) și, anterior, pe
`flow-transmit-manual`. În izolare, fiecare fișier e verde.

Explicația care ar fi fost la îndemână — „fișierele rulează în paralel" — **e falsă**:
`vitest.config.db.mjs` are deja `fileParallelism: false`, cu un comentariu care spune fix
asta. Deci fișierele sunt serializate.

Dar un deadlock cere **două sesiuni concurente**. Dacă fișierele nu se suprapun, a doua
sesiune vine din altă parte. Asta e întrebarea lotului: **cine ține lock-uri când
`truncateAll` cere `ACCESS EXCLUSIVE`?**

Un fapt care restrânge căutarea: `db-real.mjs` importă **același** pool ca aplicația
(`db/index.mjs`) — nu e un al doilea pool. Dar un pool are mai multe conexiuni, deci
concurența poate exista în interiorul lui.

---

## Ipoteza principală de verificat (nu de confirmat)

`server/services/notify-dedup.mjs:33` ia `pg_advisory_xact_lock` pe un **client dedicat**,
în interiorul unei tranzacții. Dacă undeva o notificare e pornită **fără `await`**
(fire-and-forget, ca să nu întârzie răspunsul HTTP), tranzacția ei poate supraviețui
sfârșitului cererii și poate încă ține lock-uri când testul următor intră în
`beforeEach(truncateAll)`.

Ar explica de ce apare exact pe `admin-cancel-flow` și `flow-transmit-manual`: ambele
declanșează notificări. Și ar explica de ce e intermitent — depinde de cine ajunge primul.

⚠️ **Tratează asta ca pe o ipoteză, nu ca pe un răspuns.** Dacă datele o contrazic, spune
asta clar în raport; un recon care confirmă politicos ipoteza celui care l-a cerut nu
valorează nimic. Caută activ și explicații alternative: timere periodice pornite la import,
`.catch()`-uri care mai fac `pool.query`, cereri `supertest` neașteptate, `afterAll` care nu
închide ce a deschis.

---

## ETAPA A — reproducere măsurată

Ridică baza efemeră de test după rețeta din `CLAUDE.md` și rulează `npm run test:db` de
**5 ori la rând**, pe aceeași bază, fără s-o recreezi între rulări.

Raportează: de câte ori a picat, pe ce fișier, cu ce mesaj exact. Dacă nu pică deloc în 5
rulări, spune asta — e informație, nu eșec, și schimbă concluzia (înseamnă că are nevoie de
o condiție pe care rularea locală n-o reproduce).

---

## ETAPA B — cine ține lock-urile

În timpul unei rulări, interoghează baza dintr-o a doua sesiune (`psql` separat) și prinde
starea în momentul blocajului:

```sql
SELECT pid, state, wait_event_type, wait_event,
       xact_start, state_change, LEFT(query, 120) AS query
  FROM pg_stat_activity
 WHERE datname = current_database()
 ORDER BY xact_start NULLS LAST;
```

```sql
SELECT l.pid, l.locktype, l.mode, l.granted,
       COALESCE(c.relname, l.objid::text) AS obiect
  FROM pg_locks l
  LEFT JOIN pg_class c ON c.oid = l.relation
 WHERE l.pid <> pg_backend_pid()
 ORDER BY l.granted, l.pid;
```

⭐ Ce caut în raport, explicit:

1. Câte sesiuni are baza în timpul unei rulări `test:db` și **câte sunt în
   `idle in transaction`**.
2. Dacă apar lock-uri de tip `advisory` și cine le ține.
3. Dacă vreo sesiune are `xact_start` mai vechi decât începutul fișierului de test curent —
   adică o tranzacție care a supraviețuit testului care a deschis-o.
4. Textul complet al mesajului de deadlock din logul Postgres (`log_lock_waits`, dacă e
   disponibil): Postgres numește **ambele** procese și ce aștepta fiecare. E dovada directă,
   nu inferență.

---

## ETAPA C — căutarea în cod

Independent de măsurători, caută în `server/` locurile în care se pornește lucru asincron
pe baza de date **fără `await`**, pe căile exercitate de cele două fișiere flaky
(`lifecycle.mjs` admin-cancel, transmiterea manuală, `notifications.mjs`,
`notify-dedup.mjs`, `push.mjs`, `mailer.mjs`).

Pentru fiecare loc găsit, raportează: fișier:linie, dacă rezultatul e așteptat sau nu, și
dacă poate ține o tranzacție deschisă după ce cererea HTTP a răspuns.

Verifică și dacă vreun modul importat de testele DB pornește un `setInterval` care atinge
baza — `server/index.mjs` are mai multe, dar el nu e importat de testele DB; confirmă că
chiar așa e, nu presupune.

---

## ETAPA D — raportul

Structura cerută:

1. **Rezultatele reproducerii** (Etapa A), cu numere reale.
2. **Ce a arătat baza** (Etapa B) — sesiuni, lock-uri, tranzacții orfane, mesajul de deadlock.
3. **Verdictul**: care e a doua sesiune. Dacă datele nu sunt concludente, **spune că nu
   sunt** și zi ce ar trebui măsurat în plus. Un „nu știu încă" documentat e un rezultat
   acceptabil; o cauză inventată nu.
4. **Reparațiile posibile**, cu compromisurile fiecăreia — descrise, **NU implementate**.
   Măcar: (a) `await` pe lucrul asincron pe căile atinse, (b) `lock_timeout` scurt +
   o singură reîncercare pe `40P01` în `truncateAll`, (c) închiderea explicită a
   tranzacțiilor/clienților în `afterAll`. Pentru fiecare: ce repară, ce ascunde, ce riscă.
   ⚠️ O reîncercare pe `40P01` face testele verzi fără să elimine tranzacția orfană — dacă
   aia e cauza, e un plasture pe un simptom care s-ar putea manifesta și în producție.
   Spune asta răspicat dacă e cazul.
5. **Recomandarea ta**, cu motivul.
6. `git status --short` — confirmarea că nu ai lăsat nimic în urmă.

---

## ⛔ CONSTRÂNGERI ABSOLUTE

- `develop` ONLY. **Zero commit, zero push, zero fișiere trackate modificate.**
- ⛔ Nu repara. Nu „optimiza" pe drum. Nu adăuga teste.
- ⛔ Nu atinge `vitest.config.db.mjs`, `db-real.mjs`, `setup.mjs`.
- Instrumentarea temporară e permisă, dar se revine la starea curată și se confirmă cu
  `git status --short`.
- Dacă ipoteza principală e greșită, **spune-o**. Asta e valoarea lotului.
