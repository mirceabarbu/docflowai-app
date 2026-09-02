---
prompt: 161
titlu: "Flux nou: metoda de semnare pre-bifată pe STS Cloud QES"
model_suggested: "Sonnet 5"
branch: develop
versiune_curenta: v3.9.816
versiune_tinta: v3.9.817
migratii: NU
fisiere_din_public: DA → bump `?v=` ȚINTIT pe `semdoc-initiator/main.js`; **fără** CACHE_VERSION
zona_no_touch_atinsa: NU
---

# ⚠️ BRANCH

Lucrezi **EXCLUSIV pe `develop`**. `main` = PRODUCȚIE, gestionat manual de Mircea.
Pasul final: `git push origin develop`.

---

## Cerința

În `semdoc-initiator` (creare flux nou), grupul „Metodă de semnare" pornește **complet
nebifat**, iar utilizatorul trebuie să aleagă explicit. Mircea vrea ca **STS Cloud QES**
să fie pre-bifat implicit, la fel cum „Cu tabel generat" e pre-bifat în grupul
„Tip document".

## Ce există azi (verificat pe cod)

`public/js/semdoc-initiator/main.js`, funcția `renderProviderRadios(providers, preferred)`:

```js
        // Pre-select: preferred user — NU auto-selectăm dacă nu e preferință salvată
        const preselectId = (preferred && providers.some(p => p.id === preferred))
          ? preferred
          : null;
```

`preferred` vine din `GET /api/me/signing-providers` și e **preferința salvată a
utilizatorului** (`users.preferred_signing_provider`). Când e absentă, `preselectId`
rămâne `null` ⇒ niciun radio bifat ⇒ `validateForm()` (linia ~158, `hasProvider`) ține
butonul de creare dezactivat cu titlul „Alege metoda de semnare".

Comentariul „NU auto-selectăm" a fost o decizie deliberată (alegere conștientă a
metodei). **Mircea o schimbă acum, în cunoștință de cauză** — nu o „repari" tu, o
implementezi la cerere.

⛔ Nu confunda cu `providerBadge()` (~linia 1133), care are alt comentariu despre
fallback la `local-upload`. Acela afișează cum s-a semnat un flux EXISTENT și
**nu se atinge**.

## Decizia de proiectare

Modificarea se face **exclusiv în frontend**. `preferred` de la server înseamnă
„preferința salvată a acestui utilizator" și trebuie să rămână onest — e citit și de
pagina semnatarului (`GET /flows/:flowId/signing-providers`). Un default de UI nu are ce
căuta în acel câmp.

Ordinea de precădere devine:

1. preferința salvată a utilizatorului, dacă e printre providerii activi;
2. altfel `'sts-cloud'`, dacă e printre providerii activi;
3. altfel `null` (comportamentul de azi — nimic bifat).

Pasul 3 contează: o organizație care nu are STS activ nu primește nicio bifă implicită.
Nu extinde default-ul la „primul provider cloud din listă" — cerința e STS, punct.

---

## ETAPA 0 — ancore (READ-ONLY)

```bash
git branch --show-current                      # Așteptat: develop
node -p "require('./package.json').version"    # Așteptat: 3.9.816

grep -n "NU auto-selectăm dacă nu e preferință salvată" public/js/semdoc-initiator/main.js
# Așteptat: EXACT 1 linie
grep -n "semdoc-initiator/main.js?v=" public/semdoc-initiator.html
# Așteptat: EXACT 1 linie — notează valoarea CURENTĂ a `?v=` (nu presupune că e egală cu package.json)
grep -c "semdoc-initiator" public/sw.js
# Așteptat: 0 — fișierul NU e în PRECACHE_ASSETS ⇒ CACHE_VERSION NU se atinge
```

⛔ Orice nepotrivire ⇒ oprește-te și raportează.

---

## ETAPA A — patch-ul

`old_str`:

```js
        // Pre-select: preferred user — NU auto-selectăm dacă nu e preferință salvată
        const preselectId = (preferred && providers.some(p => p.id === preferred))
          ? preferred
          : null;
```

`new_str`:

```js
        // Pre-select, în ordinea de precădere (#161):
        //   1. preferința salvată a utilizatorului, dacă providerul e activ în org;
        //   2. STS Cloud QES ca implicit, dacă e activ în org — oglindește „Cu tabel
        //      generat", pre-bifat în grupul „Tip document";
        //   3. nimic bifat (org fără STS) — utilizatorul alege explicit, ca înainte.
        const DEFAULT_PROVIDER_ID = 'sts-cloud';
        const preselectId =
          (preferred && providers.some(p => p.id === preferred))
            ? preferred
            : (providers.some(p => p.id === DEFAULT_PROVIDER_ID) ? DEFAULT_PROVIDER_ID : null);
```

Restul funcției rămâne neschimbat: blocul `if (preselectId) { _selectedProvider = ...;
updateProviderHint(...); }` de la finalul lui `renderProviderRadios` face deja tot ce
trebuie — setează starea internă, afișează hintul și declanșează `validateForm()`.

⛔ Nu atinge `onProviderChange`, `validateForm`, `loadProviders`, `_PROVIDER_META`,
sortarea providerilor, `providerBadge`, și niciun fișier din `server/`.

---

## ETAPA B — cache busting (ȚINTIT)

Un singur asset s-a schimbat. Bumpul se face **doar** pe el, cu valoarea curentă citită
la Etapa 0 — nu cu un `sed` peste toate `?v=` din HTML (driftul față de `package.json`
este intenționat).

```bash
NEW=3.9.817
sed -i -E "s#(semdoc-initiator/main\.js\?v=)[0-9.]+#\1$NEW#g" public/semdoc-initiator.html
grep -n "semdoc-initiator/main.js" public/semdoc-initiator.html
# Așteptat: 1 linie, tag <script> INTACT, ?v=3.9.817
```

⚠️ În `sed`, grupul de captură se referă cu `\1`, NU cu `\g<1>`. După orice `sed` pe HTML,
verificarea `grep` de mai sus e obligatorie: un `<script>` corupt nu pică niciun test —
testele verifică conținutul fișierelor JS, nu integritatea tagurilor din HTML — și ar
ajunge direct în producție cu pagina moartă.

⛔ `CACHE_VERSION` din `public/sw.js` rămâne `v302`. Nu îl atinge.

---

## ETAPA C — test

Fișier nou `server/tests/unit/prompt-161-provider-default.test.mjs`, analiză statică în
stilul testelor `prompt-1xx-*` (`readFileSync` + regex pe sursă), minim:

1. `renderProviderRadios` conține constanta `DEFAULT_PROVIDER_ID = 'sts-cloud'`.
2. Ramura preferinței utilizatorului există în continuare **înaintea** default-ului
   (preferința salvată nu e ocolită de default).
3. Default-ul e condiționat de prezența providerului în listă — sursa conține
   `providers.some(p => p.id === DEFAULT_PROVIDER_ID)`, deci nu se pre-bifează STS
   într-o organizație unde nu e activ.
4. `public/semdoc-initiator.html` referă `semdoc-initiator/main.js` cu un `?v=` prezent și
   tagul `<script>` e bine format (regex pe `<script src="..." defer></script>`).

---

## ETAPA D — verificări, versionare, push

```bash
npm run check                # Așteptat: exit 0
npm test                     # verde, fără regresii
npm run test:db              # PASSED, nu SKIPPED

# package.json: 3.9.816 → 3.9.817
git add public/js/semdoc-initiator/main.js public/semdoc-initiator.html \
        server/tests/unit/prompt-161-provider-default.test.mjs package.json
git status --short           # doar fișierele sarcinii
git commit -m "#161: metoda de semnare pre-bifata pe STS Cloud QES la flux nou (v3.9.817)"
git push origin develop
```

---

## RAPORT FINAL

1. Rezultatul literal al ancorelor din Etapa 0, inclusiv valoarea `?v=` găsită ÎNAINTE.
2. Diff-ul efectiv (așteptat: un singur bloc în `main.js`, o singură linie în HTML).
3. Linia `<script>` din HTML, după `sed`, copiată integral — dovada că nu e coruptă.
4. Testele scrise și ce dovedește fiecare.
5. `npm test` / `npm run test:db` — fișiere/teste, PASSED nu SKIPPED.
6. Hash-ul commitului + confirmarea push-ului pe `develop`.

## ⛔ CONSTRÂNGERI ABSOLUTE

- Zero fișiere din `server/` în afară de noul test. Zero migrații. Fără CACHE_VERSION.
- Fără `sed` în masă peste `?v=`. Un singur asset, o singură linie.
- Nu schimba `GET /api/me/signing-providers` și nu scrie nimic în
  `users.preferred_signing_provider`. Default-ul e de interfață, nu preferință salvată.
- Orice verificare cu rezultat neașteptat ⇒ oprire și raport.
