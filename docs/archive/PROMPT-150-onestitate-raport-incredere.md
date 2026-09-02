# PROMPT #150 — onestitatea Raportului de încredere (diacritice, L4, L5, canar)

> ⚠️ **BRANCH: `develop`.** Niciun `checkout`, `merge` sau `push` spre `main`.
> Dacă `git branch --show-current` nu arată `develop`, OPREȘTE-TE.

- **Model recomandat:** Sonnet 5 (efort mediu)
- **versiune_start:** 3.9.806
- **versiune_tinta:** 3.9.807
- **Migrații:** ZERO
- **CACHE_VERSION:** lot server-side — probabil NU; se decide pe dovadă

---

## DE CE

#147 a făcut Raportul de încredere să verifice criptografic. Un smoke test pe
un document real din producție a scos la iveală trei defecte pe **același
document oficial**, plus o fragilitate structurală semnalată de agent.

Toate sunt din aceeași familie ca #149/#147: documentul afirmă lucruri pe care
nu le-a dovedit, sau le afirmă greșit.

---

## PASUL 0 — ancore

```bash
git branch --show-current           # develop
git status --short
grep -n '"version"' package.json    # 3.9.806
grep -n "const ro = t =>" server/services/sign-trust-report.mjs   # aștept 1 (~L40)
grep -n "momentul semnarii (OCSP/CRL)" server/services/sign-trust-report.mjs  # aștept 1 (~L561)
grep -n "chain.length >= 2\|chainCerts.length >= 2" server/services/certificate-verify.mjs
```

---

## ETAPA A — diacriticele (o linie, cel mai mare efect vizibil)

`sign-trust-report.mjs:40`:

```js
const ro = t => String(t || '').replace(/[^\x00-\xFF]/g, '').split('').map(ch => diacr[ch] || ch).join('');
```

Ordinea e inversată. `replace(/[^\x00-\xFF]/g, '')` **șterge** tot ce e în afara
Latin-1 — iar `ă` (U+0103), `ș` (U+0219), `ț` (U+021B) sunt exact acolo. Sunt
eliminate **înainte** ca tabelul `diacr` să le poată înlocui. Supraviețuiesc
doar `â` și `î`, care sunt în Latin-1.

Efect măsurat pe raport real: „Semnătură" → „Semntur", „verificată" →
„verificat", „în lanț" → „in lan", „negăsit" → „negsit".

**Fixul: mapează întâi, șterge după.**

`old_str`
```js
const ro = t => String(t || '').replace(/[^\x00-\xFF]/g, '').split('').map(ch => diacr[ch] || ch).join('');
```
`new_str`
```js
// #150 — ORDINEA CONTEAZĂ: ă/ș/ț sunt în afara Latin-1, deci un strip aplicat
// ÎNAINTE de mapare le ștergea complet („Semnătură" → „Semntur"). Mapăm întâi
// diacriticele cunoscute, abia apoi curățăm ce a rămas neredabil de Helvetica.
const ro = t => String(t || '').split('').map(ch => diacr[ch] || ch).join('').replace(/[^\x00-\xFF]/g, '');
```

⚠️ Verifică tabelul `diacr` (linia ~39): trebuie să acopere ambele variante
Unicode ale lui s/t cu virgulă **și** cu sedilă (`ș`/`ş`, `ț`/`ţ`), plus
majusculele. Completează ce lipsește. Adaugă și `ë`→`e`, `ü`→`u` dacă apar în
nume proprii — **nu inventa** intrări dincolo de ce e plauzibil în nume
românești și instituții.

**Test obligatoriu** (`server/tests/unit/trust-report-diacritice.test.mjs`):

1. ⭐⭐ `ro('Semnătură')` === `'Semnatura'` — **cade pe codul vechi** (dă `'Semntur'`).
2. ⭐ `ro('în lanț')` === `'in lant'`.
3. ⭐ `ro('Calificat pe dovadă: QcSSCD')` — niciun caracter lipsă.
4. ⭐ un caracter chiar neredabil (ex. un emoji) e eliminat, nu aruncă.
5. ⭐ ASCII pur trece neschimbat.

---

## ETAPA B — eticheta lui L5 spune altceva decât verifică L5

`sign-trust-report.mjs:~561`:

```js
{ key: 'L5', label: 'Certificatul era valabil la momentul semnarii (OCSP/CRL)' },
```

L5 verifică **revocarea**, nu valabilitatea la momentul semnării. Cele două
sunt lucruri diferite, iar când L5 iese NEVERIFICAT utilizatorul citește azi
„nu știm dacă certificatul era valabil" — o afirmație mai gravă și diferită de
cea reală, „nu am putut verifica dacă era revocat".

Reformulează eticheta ca stare de revocare. Verifică și nota afișată dedesubt
(pe raportul real apare „URL OCSP negăsit în certificat") — dacă sugerează
invaliditate, nu indisponibilitate, corecteaz-o în aceeași direcție.

⛔ Nu atinge `L5.ok` și nu-l introduce în formula verdictului.

---

## ETAPA C — L4 diverge între cele două motoare

Pe același semnatar, motorul public afișează „Neconcludent — rădăcina lanțului
e dedusă", iar Raportul afișează **VALID**. `certificate-verify.mjs` declară
lanțul valid pe lungime, ca înainte de #149.

**C1 — măsoară întâi, nu presupune.** Pe fixtura
`server/tests/fixtures/sts-signed-staging.pdf`, raportează:

- câte certificate are lanțul construit de `certificate-verify.mjs`;
- ⭐ **care dintre ele, dacă vreunul, este dedus** (adăugat de noi din numele
  emitentului) și nu vine din CMS ori din bundle-ul de CA-uri de încredere;
- ce marcaj poartă (`isInferred` sau echivalent — dacă motorul ăsta nu are
  câmpul, spune-o explicit).

**C2 — aplică regula #149 doar dacă C1 arată că rădăcina e dedusă.**
Un lanț ale cărui certificate vin toate din CMS/bundle este verificat, și
atunci `L4.ok = true` rămâne **corect** — nu-l strica.

Dacă rădăcina e dedusă: `L4.ok = null` + notă („rădăcina lanțului e dedusă, nu
verificată criptografic"), oglindind motorul public.

⛔ L4 NU intră în formula verdictului, nici acum, nici după.

**C3** — un test de paritate: pe fixtură, `L4.ok` trebuie să fie **identic** în
cele două motoare. Testul ăsta e valoros indiferent ce arată C1.

---

## ETAPA D — „Valabil la semnare" măsoară „valabil acum"

`certificate-verify.mjs:~285`:

```js
const checkTime = result.signingTime || new Date();
```

`signingTime` este `null` la fiecare document real (STS nu pune atributul CMS —
măsurat 1/1 la #147), deci valabilitatea se evaluează la **momentul curent**.
Un certificat expirat între timp ar apărea „valabil la semnare".

Fără moment de referință, răspunsul corect este **nedeterminat**, nu `true`:

- `signingTime` prezent ⇒ `validAtSigning` boolean, ca acum;
- `signingTime` absent ⇒ `validAtSigning = null`, iar eticheta afișată devine
  explicită („nedeterminat — momentul semnării nu e declarat în semnătură").

⚠️ Găsește **toți** consumatorii lui `validAtSigning` înainte de a schimba
tipul — `null` nu trebuie să devină „INVALID" sau „NU" pe niciun ecran sau
raport. Raportează lista.

⛔ Nu introduce `validAtSigning` în formula verdictului.

---

## ETAPA E — canarul pe selecția semnatarului

La #147 s-a descoperit că metoda 1 de selecție (emitent + serie) era **cod
mort** din cauza unei schimbări de API pkijs, iar semnatarul corect era prins
de euristică, tăcut. `_selectSignerCert` are aceeași fragilitate structurală,
acum într-un singur loc.

Adaugă un test-canar: pe fixtură, `_selectSignerCert` trebuie să întoarcă
**`branch === 1`**. Dacă o viitoare versiune pkijs schimbă forma lui `sid`,
selecția degradează pe euristică — iar CI-ul devine roșu în loc să tacă.

Comentariu obligatoriu în test care explică de ce există și ce înseamnă dacă
pică (nu „reparat" prin relaxarea aserțiunii la `branch <= 3`).

---

## ETAPA F — teste și rulare

```bash
npm test
npm run test:db
```

⚠️ Înainte de `test:db`: omoară rulările anterioare și recreează baza — o
rulare expirată care încă trăiește produce eșecuri fantomă (`fileParallelism:
false` e per-proces, nu între procese).

Docker absent **nu** e motiv de skip — instanță PG efemeră pe 55433.

---

## PASUL FINAL

```bash
# package.json: 3.9.806 → 3.9.807
git status --short          # NICIODATĂ `git add -A`
git add <fișierele atinse> package.json
git diff --cached --stat
git commit -m "fix(#150): diacritice in Raportul de incredere, etichete L4/L5 oneste, canar selectie semnatar (v3.9.807)"
git push origin develop
```

---

## RAPORT FINAL

1. Branch, versiune, ancorele din PASUL 0.
2. ⭐⭐ Etapa A: ce dădea `ro('Semnătură')` înainte și după. Ce ai completat în
   tabelul `diacr`.
3. Etapa B: eticheta veche și cea nouă; nota de dedesubt.
4. ⭐⭐ Etapa C1 **măsurat**: câte certificate, care e dedus, ce marcaj poartă.
   Apoi: ai aplicat C2 sau nu, și de ce.
5. Etapa C3: `L4.ok` în ambele motoare, pe fixtură.
6. ⭐ Etapa D: lista completă a consumatorilor lui `validAtSigning` și ce
   afișează fiecare pentru `null`.
7. Etapa E: canarul — ce ramură întoarce fixtura azi.
8. `npm test` / `npm run test:db` — cifre, PASSED REAL, zero skipped.
9. Ce ai găsit și NU ai reparat.

---

## ⛔ CONSTRÂNGERI

- Doar `develop`. Zero migrații, zero scrieri de date.
- L4, L5 și `validAtSigning` NU intră în formula verdictului.
- `false` ≠ `null` în nicio ramură.
- Nu strica un `L4.ok = true` care e **corect** (lanț integral din CMS/bundle).
- `null` nu trebuie să se afișeze nicăieri ca „INVALID" sau „NU".
- Motorul public (`verify.mjs`) nu se atinge în acest lot.
- Niciun PDF nou în repo.
- Dacă un `old_str` nu se potrivește: OPREȘTE-TE și raportează.
