---
prompt: 124a
titlu: RECON dublări din click repetat — inventar apeluri de mutație, rute de creare neidempotente, interacțiuni rapide legitime
model_suggested: Opus 4.8
branch: develop
version_bump: NU (recon read-only, zero cod de producție)
migratii: NU
tip: READ-ONLY — livrabilul e un RAPORT, nu un fix
---

# ⚠️⚠️ BRANCH: `develop` — EXCLUSIV ⚠️⚠️
`main` = PRODUCȚIE, administrat MANUAL de Mircea. NU face checkout/merge/push pe `main`.

Prima comandă:
```
git fetch origin && git status && git log --oneline --graph --all -6
```
Trebuie să fii pe `develop`, curat, aliniat cu `origin/develop` (v3.9.753).

# ⛔⛔ ACEST PROMPT NU MODIFICĂ NICIUN FIȘIER DE PRODUCȚIE ⛔⛔
Singurele fișiere pe care ai voie să le creezi:
- `docs/audits/RECON-124-dublari-click.md` (raportul)
- `docs/audits/recon-124-duplicate-check.sql` (scriptul de numărare, READ-ONLY)

⛔ ZERO modificări în `server/`, `public/`, `package.json`, migrații. Dacă la final `git status` arată altceva decât cele două fișiere noi, ai greșit — raportează și nu comite.
⛔ Nu „repara pe drum" nimic din ce găsești. Constatările merg în raport; fixurile vin la #124b/#124c, cu decizia lui Mircea.

---

# CONTEXT — problema raportată

Utilizatorii apasă butoanele de mai multe ori pentru că platforma nu le dă niciun semnal că lucrează. Rezultat: dosare, fluxuri și documente duplicate — pe toată platforma, inclusiv pe calea de semnare STS.

## Fapte deja verificate (NU le re-descoperi — pornește de aici și EXTINDE)

- **Tiparul corect EXISTĂ deja, aplicat o singură dată, la DF.** `server/routes/formulare/df.mjs:255-273` (după incidentul 13.07.2026, „dublu-click pe «Completează DF»"): (1) `SELECT` de deduplicare pe `source_alop_id + org_id + revizie_nr=0 + deleted_at IS NULL` care întoarce documentul existent **tăcut (200)**, nu eroare; (2) indexul unic `df_source_alop_revizie_uniq` (migrarea 095, `server/db/index.mjs:2136`) ca poartă durabilă; (3) `catch` pe `23505` pentru cursa paralelă. Ancora e `source_alop_id` fiindcă există din prima milisecundă (spre deosebire de `nr_unic_inreg`, care vine prin PUT ulterior).
- **ORD NU are garda**: `server/routes/formulare/ord.mjs:270` doar împinge `source_alop_id` în coloane. Fără `SELECT` de dedup, fără index unic.
- **`POST /api/alop`** (`server/routes/alop.mjs:436`, crearea dosarului) nu are nicio cheie de deduplicare.
- **Mașina de stări E deja protejată** prin construcție: `df-completed` are `WHERE ... AND status='angajare'`, `confirma-lichidare` e idempotent (`status IN ('lichidare','ordonantare')`). Al doilea clic nu găsește rândul ⇒ nu poate dubla o tranziție. ⇒ **concentrează-te pe rutele care CREEAZĂ**, nu pe cele care tranziționează.
- **Autosave poate dubla FĂRĂ dublu-click**: `public/js/formular/doc.js:1024` — `saveDoc` ramifică pe `if(!docId)` → POST. Două salvări plecate înainte ca `docId` să fie setat de primul răspuns ⇒ două documente.
- **Volum**: ~143 apeluri de mutație (POST/PUT/PATCH/DELETE) în 36 de fișiere din `public/js/`. Concentrate în `admin/organizations.js` (20), `formular/alop.js` (13), `semdoc-initiator/main.js` (11), `formular/doc.js` (9).
- **Nu există un wrapper unic de cereri**: `_apiFetch` e pe 8 pagini, `window.docflow.apiFetch` (notif-widget.js) pe 10, dar restul apelurilor folosesc `fetch()` direct.
- **Gărzi existente, inconsecvente**: ~105 locuri cu `.disabled=true`, scrise ad-hoc. Tiparul cel mai complet e `alopDeschideDF/ORD` (`formular/alop.js:837,899`): cheie in-flight + `disabled` + reset în `finally`. `initiateCloudSigning` (`semdoc-signer/main.js:356`) și `btnUploadSignedPdf` (`:726`) au gărzi. `alopDfCompleted`/`alopOrdCompleted` NU au.
- **Interacțiuni rapide LEGITIME** (identificate; confirmă și completează): paginarea (`shared/pagin.js` — `onChange` pe pg-btn, click rapid next-next-next), butoanele `.badd`/`.bdel` de adăugare/ștergere rânduri în tabelele DF/ORD, autosave cu conținut diferit.

⛔ ZONĂ NO-TOUCH: `server/signing/providers/STSCloudProvider.mjs`, `server/routes/flows/cloud-signing.mjs`, `server/routes/flows/bulk-signing.mjs`, `server/signing/pades.mjs`, `server/signing/java-pades-client.mjs`. **Le poți CITI** pentru recon (e read-only oricum) — nu le modifici.

===============================================================================
# LIVRABIL 1 — `docs/audits/RECON-124-dublari-click.md`
===============================================================================

## Secțiunea A — inventarul apelurilor de mutație
Tabel cu TOATE apelurile POST/PUT/PATCH/DELETE din `public/js/` și `public/*.js`. Coloane:

| fișier:linie | metodă | endpoint | funcția apelantă | butonul/UI care o declanșează | gardă existentă (in-flight / disabled / niciuna) | CREEAZĂ obiect? (da/nu) | risc (M/m/–) |

Reguli de clasificare:
- **CREEAZĂ obiect** = un al doilea apel identic produce un al doilea rând în DB (dosar, document, flux, ciclu, înregistrare). Astea sunt singurele care dau dublări VIZIBILE.
- **risc M (mare)** = creează obiect ȘI n-are gardă. **m (mic)** = creează dar are gardă, sau nu creează dar e vizibil deranjant. **–** = tranziție/update idempotent prin construcție.
- Pentru „butonul care o declanșează": urmărește lanțul `onclick=` din HTML sau `addEventListener` până la funcție. Dacă nu-l poți determina, scrie explicit „nedeterminat" — ⛔ NU ghici.

## Secțiunea B — rute de server care creează fără cheie de deduplicare
Pentru fiecare `INSERT INTO` din `server/routes/` (exclude testele), notează: ruta, tabelul, dacă există `SELECT` de dedup înainte, dacă există index unic care să prindă cursa paralelă, ce **ancoră naturală** ar putea servi drept cheie de idempotență (câmp prezent din prima milisecundă, ca `source_alop_id` la DF).
⚠️ La `POST /api/alop` ancora e cea mai grea întrebare — un dosar ALOP nou nu are niciun părinte. Propune opțiuni (ex. `created_by + titlu + fereastră de timp`, sau o cheie de idempotență generată de client și trimisă în body) **cu argumente pro/contra pentru fiecare**, fără să alegi. Decizia e a lui Mircea.

## Secțiunea C — interacțiuni rapide legitime (lista de excepții)
Enumeră fiecare loc unde un utilizator apasă LEGITIM același element de mai multe ori în câteva sute de milisecunde. Pentru fiecare: elementul, de ce e legitim, și ce s-ar rupe dacă l-am bloca. Asta devine lista de excepții pentru #124c — o omisiune aici înseamnă o regresie în producție.

## Secțiunea D — calea de semnare
Inventar SEPARAT al butoanelor de pe fluxul de semnare (`semdoc-signer/`, `bulk-signer/`, `flow/flow.js`, `semdoc-initiator/`): ce gardă are fiecare și ce se întâmplă la al doilea clic (o a doua sesiune STS? o a doua semnătură? o eroare?).
⚠️ Analiză STATICĂ pe cod. ⛔ Nu rula nimic împotriva STS. Dacă răspunsul nu se poate determina din cod, scrie „necesită test manual" și spune exact ce test.

## Secțiunea E — recomandare pe trei straturi (analiză, nu implementare)
Evaluează, cu argumente pro/contra și riscuri concrete:
1. **Dedup la nivel de `fetch` global** — împachetarea `window.fetch` în `df-utils.js` (încărcat de toate cele 15 pagini, e în `PRECACHE_ASSETS`). Cheie = `method + url + hash(body)`; o cerere identică deja în zbor returnează aceeași promisiune.
   ⚠️ **Capcana fatală, tratează-o explicit**: `Response` se poate citi O SINGURĂ DATĂ. Doi apelanți care primesc același obiect ⇒ al doilea `.json()` aruncă „body already read" ⇒ regresie pe TOATĂ platforma. Verifică dacă `response.clone()` per apelant rezolvă complet și dacă mai există cazuri (streaming, `FormData`, upload de PDF semnat) unde tiparul cade.
   ⚠️ Verifică și interacțiunea cu `window.docflow.apiFetch` (notif-widget.js:189), care face refresh automat la 401 și RE-emite cererea — un dedup naiv ar putea bloca re-emiterea legitimă.
2. **Helper `df.once(btn, fn)`** — feedback vizual, generalizarea tiparului din `alopDeschideDF`.
3. **Idempotență pe server** pentru rutele din Secțiunea B — oglindirea tiparului DF.

Pentru fiecare strat: ce acoperă, ce NU acoperă, și ce ordine de livrare recomanzi.

## Secțiunea F — ordinea de atac propusă
Grupează constatările din Secțiunea A în loturi livrabile, fiecare cu deploy propriu. Estimează riscul fiecărui lot. ⛔ Nu implementa nimic.

===============================================================================
# LIVRABIL 2 — `docs/audits/recon-124-duplicate-check.sql`
===============================================================================

Script **STRICT READ-ONLY** (doar `SELECT`; ⛔ niciun `INSERT/UPDATE/DELETE/CREATE/ALTER`) pe care Mircea îl rulează pe PRODUCȚIE ca să afle **dacă există deja duplicate**. Rezultatul decide dacă un index unic pe ORD se poate crea direct sau trebuie precedat de curățare — migrarea 095 are deja un `RAISE WARNING` fiindcă exact asta poate eșua.

Cerințe:
- fiecare interogare precedată de un comentariu care spune ce numără și cum se interpretează rezultatul;
- ORD duplicate pe `source_alop_id` (oglindind cheia de la DF: `+ org_id`, `revizie_nr` dacă există coloana, `deleted_at IS NULL`) — cu `COUNT(*)` agregat ȘI un `SELECT` detaliat al grupurilor cu ≥2, limitat la 50 de rânduri;
- dosare ALOP potențial duplicate (`created_by + titlu + created_at` în aceeași fereastră scurtă — propune fereastra și explic-o);
- fluxuri duplicate pe același document (`data->'meta'->>'dfId'` / `ordId`) — ⚠️ refolosește predicatul `liveFlowSql` din `server/services/flow-provenance.mjs` (un flux ANULAT poate păstra `completed=true`; predicatul e definit acolo O SINGURĂ dată de la #122);
- verifică prezența indexului `df_source_alop_revizie_uniq` (`pg_indexes`) — dacă LIPSEȘTE în producție, înseamnă că migrarea 095 a eșuat tăcut pe duplicate rămase, ceea ce e o constatare în sine, de scris în raport;
- la final, un comentariu cu interpretarea: „dacă X > 0 atunci indexul unic pe ORD NU se poate crea fără curățare prealabilă".

⚠️ Scriptul trebuie să ruleze fără erori chiar dacă o coloană lipsește — verifică pe schema din `server/db/index.mjs` ce coloane există REAL la `formulare_ord` înainte să le folosești. ⛔ Nu presupune simetria cu DF.

===============================================================================
# METODĂ
===============================================================================
- Citește codul REAL. Fiecare afirmație din raport are `fișier:linie`. ⛔ Nicio afirmație fără ancoră.
- Unde ceva nu se poate determina static, scrie „nedeterminat — necesită test manual: <testul exact>". ⛔ Nu ghici, nu completa cu plauzibil.
- Dacă găsești o constatare de SECURITATE (nu doar de dublare), pune-o într-o secțiune separată „Constatări colaterale" — nu o repara.
- Raportul se adresează lui Mircea (dezvoltator unic, context complet). Fii concis și concret; fără umplutură.

===============================================================================
# FINALIZARE
===============================================================================
```
git status
# Așteptat: EXACT două fișiere noi, ambele în docs/audits/. Nimic altceva.
git add docs/audits/RECON-124-dublari-click.md docs/audits/recon-124-duplicate-check.sql
git commit -m "docs(#124a): recon dublări din click repetat — inventar mutații, rute de creare neidempotente, excepții rapide legitime"
git push origin develop
```
⛔ FĂRĂ bump de versiune (nu se schimbă cod de producție). FĂRĂ `npm test` obligatoriu (nu s-a atins nimic) — dar dacă l-ai rulat oricum, notează rezultatul.

# RAPORT FINAL (în chat, după push)
- Commit: __________ · push: __________
- `git status` înainte de commit conținea DOAR cele două fișiere? __________
- Câte apeluri de mutație inventariate / din care CREEAZĂ obiect / din care fără gardă (risc M): ____ / ____ / ____
- Rute de server care creează fără cheie de deduplicare (listă): __________
- Ancore de idempotență propuse pentru `POST /api/alop` (opțiuni, fără alegere): __________
- Excepții rapide legitime găsite (câte, care sunt cele neevidente): __________
- Verdictul pe dedup-ul de `fetch`: `response.clone()` acoperă complet? Ce cazuri cad? Conflict cu refresh-ul la 401 din notif-widget? __________
- Constatări colaterale (securitate/altele) — dacă există: __________
