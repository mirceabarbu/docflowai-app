---
prompt: 194
titlu: "Cauza deadlock-ului din test:db + fixtura care corupe baza între rulări"
model_suggested: "Sonnet 5"
branch: develop
versiune_curenta: v3.9.847
versiune_tinta: v3.9.848
migratii: NU
fisiere_din_public: NU  (⇒ FĂRĂ bump `CACHE_VERSION`, FĂRĂ `?v=`)
zona_no_touch_atinsa: NU
scrieri_in_baza: ZERO
baza: RECON #193
---

# ⚠️ BRANCH

Lucrezi **EXCLUSIV pe `develop`**. `main` = PRODUCȚIE, gestionat manual de Mircea.
Nu propune și nu executa `checkout main`, `merge main`, `push main`.
Pasul final obligatoriu: **`git push origin develop`**.

---

## Contextul — reconul #193 a stabilit două lucruri distincte

**(1) Deadlock-ul (40P01) din `truncateAll`.** Raportul Postgres, din rulare reală:
`TRUNCATE` deține `users` și cere `organizations`; un `INSERT INTO formulare_audit` deține
`organizations` (prin FK pe `org_id`) și cere `users` (prin FK pe `actor_id`). Ciclu clasic,
în ordine inversă.

A doua sesiune vine din **același pool, același worker**: `lifecycle.mjs:744` și `:748`
lansează `recordFormularAudit(...)` **fără `await`**, pe calea admin-cancel. Interogarea
pleacă după ce cererea HTTP a răspuns, iar testul următor intră peste ea cu `TRUNCATE`.

Control negativ din recon: 400 de iterații ale tiparului, 277 deadlock-uri când ținta
INSERT-ului are FK spre tabelele trunchiate, **0** când nu are. FK-ul e ingredientul necesar.

Celelalte **16** apeluri `recordFormularAudit` din cod sunt toate `await`-uite. Cele două
din `lifecycle.mjs` sunt excepția, nu regula.

**(2) Fixtura care corupe baza — mai important pentru noi decât (1).**
`df-dedup-idempotent.test.mjs` coboară indexul `df_source_alop_revizie_uniq`, iar ultimul
test lasă intenționat două rânduri duplicate. `afterAll` încearcă recrearea **cât timp
rândurile sunt încă acolo** (`truncateAll` rulează în `beforeEach`, nu în `afterEach`) ⇒
`CREATE UNIQUE INDEX` pică pe `unique_violation` ⇒ eșecul e înghițit de `.catch(() => {})`
⇒ indexul rămâne lipsă. Migrația 095 e deja marcată aplicată, deci nu-l mai reface nimeni.

Consecința: pe o bază refolosită, `test:db` e roșu de la rularea 2 încolo, permanent.
**Adică „test:db verde local" a fost o afirmație validă doar pe bază proaspătă.** Asta
subminează chiar semnalul pe care ne bazăm când decidem dacă un push e sigur.

---

## ETAPA 0 — ancorele (READ-ONLY, raportează valorile OBȚINUTE)

```bash
node -p "require('./package.json').version"                          # Așteptat: 3.9.847
grep -n "recordFormularAudit" server/routes/flows/lifecycle.mjs      # Așteptat: import + 744 + 748
grep -rn "await recordFormularAudit" server/routes/ --include=*.mjs | grep -v tests | wc -l
grep -n "afterAll" -A 8 server/tests/db/df-dedup-idempotent.test.mjs
sed -n '28,36p' server/db/queries/formulare-audit.mjs
```

⭐ Ultima comandă stabilește faptul care face Etapa A sigură: `recordFormularAudit` are
`try/catch` propriu și **nu aruncă niciodată** — logează `non-fatal` și se întoarce. Deci
`await` **nu poate** transforma un admin-cancel reușit într-un 500.
⛔ Tocmai de aceea: **nu adăuga `.catch()`** peste `await`. Ar fi mort și ar sugera fals că
apelul poate arunca.

---

## ETAPA A — cele două `await` din `lifecycle.mjs`

`old_str` (unic), la ~744:
```js
      recordFormularAudit({ orgId: data.orgId, formType: 'df', formId: undo.dfId, actorId: actor.userId, actorEmail: actor.email,
```
`new_str`: aceeași linie, cu `await ` înaintea apelului. Identic pentru cel de la ~748
(`formType: 'ord'`).

Adaugă deasupra blocului o singură frază de comentariu: apelurile sunt `await`-uite fiindcă
`formulare_audit` are FK spre `organizations` și `users`, iar o scriere detașată se poate
ciocni de curățenia dintre teste (RECON #193).

⛔ **Nu atinge** `writeAuditEvent(...)` de deasupra. Scrie în `audit_log`, care nu are FK,
deci nu e în închiderea `TRUNCATE ... CASCADE` — reconul a verificat. E altă clasă și n-are
ce căuta în lotul ăsta.

⛔ **Nu atinge** blocurile `setImmediate` din `signing.mjs`, `cloud-signing.mjs`,
`bulk-signing.mjs`, `email.mjs`. Sunt detașate **intenționat**, `cloud-signing` și
`bulk-signing` sunt zonă ⛔ NO-TOUCH, iar durabilitatea lor e subiectul unui tichet separat.

⛔ Nu converti celelalte apeluri, nu uniformiza nimic altceva.

---

## ETAPA B — fixtura din `df-dedup-idempotent.test.mjs`

În `afterAll`: **șterge rândurile duplicate înainte** de a reface indexul, apoi creează-l.

Și, la fel de important: **`.catch(() => {})` dispare.** Înghițirea tăcută e motivul pentru
care coruperea a trecut neobservată luni de zile. Dacă recrearea indexului eșuează, trebuie
să se **vadă** — aruncă, sau cel puțin logează zgomotos. Un `afterAll` roșu e un cost mic pe
lângă o bază de test coruptă în tăcere.

⚠️ Curățarea trebuie să șteargă exact rândurile pe care le-a creat testul, nu `formulare_df`
în întregime — alte fișiere nu depind de starea lui aici, dar principiul rămâne: fixtura
curăță după ea, nu după alții.

⛔ Nu atinge cele patru teste din fișier, nici `DROP INDEX`-urile de la liniile ~90 și ~112.
Ele fac parte din ce verifică testul.

---

## ETAPA C — garda care ține regula vie

Adaugă în `server/tests/unit/` (fișier nou, sau extinde unul din familia „sursă unică") un
test care citește sursele din `server/routes/**/*.mjs` și verifică:

⭐ **niciun apel `recordFormularAudit(` nu e lansat fără `await`.**

Construiește tiparul astfel încât linia de `import` să nu producă fals-pozitiv. Testul
trebuie să pice dacă cineva adaugă mâine un al 19-lea apel detașat — pentru că exact așa a
apărut și ăsta.

Raportează câte apeluri a găsit (așteptat: **18**, toate `await`-uite după Etapa A).

---

## ETAPA D — verificarea, care e chiar testul de acceptanță

```bash
npm test
```

Apoi, ⭐ **partea care contează**: ridică baza efemeră **o singură dată** și rulează
`npm run test:db` de **două ori la rând pe aceeași bază**, fără s-o recreezi între rulări.

```
Rularea 1: verde
Rularea 2: verde   ← ĂSTA e criteriul de acceptanță pentru Etapa B
```

Înainte de lot, rularea 2 pica pe `backfill-df-source-alop B4`. Dacă tot pică, Etapa B nu
și-a atins scopul — **raportează, nu ajusta testul până trece**.

Pentru Etapa A: reconul a măsurat deadlock-ul în 2 din 5 rulări (40%). Două rulări verzi nu
sunt dovadă definitivă, doar semnal bun. Spune asta onest în raport; nu prezenta absența
deadlock-ului în două rulări drept demonstrație.

⚠️ `npm test` și `test:db` **secvențial, niciodată în paralel.**
Test preexistent care pică ⇒ **raportează ÎNAINTE** de a-l modifica.

---

## ETAPA E — versiune, commit

```bash
npm version 3.9.848 --no-git-tag-version
npm install --package-lock-only
git diff --stat package-lock.json        # Așteptat: ≤ 4 linii
```

⛔ **FĂRĂ** `CACHE_VERSION`, **FĂRĂ** `?v=` — lotul nu atinge `public/`.

```bash
git status --short
```
⚠️ `git add` **explicit, pe fișiere numite**. **Niciodată `git add -A`** — working tree-ul
are ~34 de fișiere netrackate din sesiuni vechi.

```
fix(#194): cauza deadlock-ului din test:db + fixtura care corupea baza — v3.9.848

RECON #193, din raportul Postgres pe rulare reala: TRUNCATE detine `users` si
cere `organizations`; un INSERT in formulare_audit detine `organizations` (FK
org_id) si cere `users` (FK actor_id). A doua sesiune venea din acelasi pool:
lifecycle.mjs:744,748 lansau recordFormularAudit FARA await, pe calea
admin-cancel, iar interogarea pleca dupa ce raspunsul HTTP fusese trimis.
Celelalte 16 apeluri erau deja await-uite; astea doua erau exceptia.
Helperul are try/catch propriu si nu arunca, deci await nu poate transforma un
admin-cancel reusit intr-un 500.

Separat, si mai important: df-dedup-idempotent.test.mjs cobora indexul
df_source_alop_revizie_uniq si incerca sa-l refaca in afterAll cat timp
randurile duplicate erau inca acolo. Esecul era inghitit de .catch(() => {}),
indexul ramanea lipsa, iar migratia 095 fiind deja aplicata nu-l mai refacea
nimeni. Pe o baza refolosita, test:db era rosu de la rularea 2 incolo —
adica "test:db verde local" era valid doar pe baza proaspata. Fixtura curata
acum dupa ea si nu mai inghite esecul in tacere.

O garda noua verifica pe sursa ca niciun recordFormularAudit nu e lansat detasat.
```

```bash
git push origin develop
```

---

## RAPORT FINAL — obligatoriu

1. Ancorele din Etapa 0, cu valorile OBȚINUTE (inclusiv confirmarea că helperul nu aruncă).
2. Cele două linii din `lifecycle.mjs`, înainte și după.
3. `afterAll`-ul din Etapa B, înainte și după, cu confirmarea că `.catch(() => {})` a dispărut.
4. ⭐ Numărul de apeluri `recordFormularAudit` găsite de garda din Etapa C (așteptat: 18).
5. ⭐⭐ **Rularea 1 și rularea 2 pe ACEEAȘI bază**, cu numerele reale ale fiecăreia.
6. Formularea onestă despre Etapa A: două rulări fără deadlock ≠ dovadă, la o rată
   observată de 40%.
7. Fișierele stage-uite, pe nume. Confirmarea `git push origin develop`.
8. Teste preexistente atinse. (Așteptat: doar `df-dedup-idempotent.test.mjs`, la `afterAll`.)
9. Divergențe prompt↔cod — raportate, **NU** reparate tăcut.
10. Constatări colaterale.

---

## ⛔ CONSTRÂNGERI ABSOLUTE

- `develop` ONLY. Zero migrații. Zero scrieri în baza de producție.
- ⛔ `setImmediate`-urile din `signing.mjs` / `cloud-signing.mjs` / `bulk-signing.mjs` /
  `email.mjs` — **NEATINSE**. Tichet separat.
- ⛔ `writeAuditEvent` — **neatins**.
- ⛔ Fără `.catch()` peste noile `await` — helperul nu aruncă.
- ⛔ `db-real.mjs`, `vitest.config.db.mjs`, `setup.mjs` — **neatinse**. Nicio reîncercare pe
  `40P01`: reparăm cauza, nu ascundem simptomul.
- `npm test` și `test:db` **secvențial**.
- `git add` explicit, niciodată `-A`.
- `old_str` care nu se potrivește exact ⇒ **OPREȘTE-TE și raportează**.
