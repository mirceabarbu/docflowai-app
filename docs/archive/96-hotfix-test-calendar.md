---
model_suggested: Sonnet 4.6 (Default)
tip: HOTFIX CI — test expirat prin calendar. Mic, chirurgical.
---

# ⚠️ BRANCH: develop — NU `main`.

> **NO-TOUCH (doar citire):** `signing.mjs`, `cloud-signing.mjs`, `bulk-signing.mjs`,
> `pades.mjs`, `java-pades-client.mjs`, `STSCloudProvider.mjs`

---

## Context — CI e roșu, dar #95 e nevinovat

`server/tests/db/user-email-reuse-authz.test.mjs` pică:
```
self leave updates only the active reused-email account
AssertionError: expected 400 to be 200
```

**Nu e o regresie.** E un test care a expirat prin trecerea timpului.

`server/services/user-leave.mjs:134-136`:
```js
const today = new Date().toISOString().slice(0, 10);
if (leaveStart < today) throw new Error('leave_start_in_past');   // → 400
```

Testul hardcodează `leave_start: '2026-07-13'`. **Azi e 14 iulie.** Ieri trecea, azi nu mai trece,
și n-o să mai treacă niciodată. Ar fi picat și fără #95.

Aceeași clasă cu testul care hardcoda `CACHE_VERSION = 'docflowai-v284'` (reparat la #89):
**un test care fixează o valoare care se mișcă.** Atunci versiunea, acum calendarul.

---

## PAS 1 — Fixture-uri relative la „azi"

`server/tests/db/user-email-reuse-authz.test.mjs`, **liniile 135 și 150**.

Adaugă un helper sus în fișier (după importuri):

```js
// Datele de concediu TREBUIE să fie relative la ziua rulării — user-leave.mjs:135
// respinge `leave_start < today` (leave_start_in_past). Datele fixe expiră.
const _isoIn = (days) => new Date(Date.now() + days * 86400000).toISOString().slice(0, 10);
```

Înlocuiește **ambele** apariții:
```js
leave_start: '2026-07-13', leave_end: '2026-07-14', leave_reason: 'Test',
```
cu:
```js
leave_start: _isoIn(1), leave_end: _isoIn(2), leave_reason: 'Test',
```

**De ce `+1/+2` și nu `0/+1`:** dacă CI rulează în jurul miezului nopții UTC, `Date.now()` din test
și `new Date()` din serviciu pot cădea în zile diferite, iar `_isoIn(0)` ar deveni „ieri" pentru
serviciu. `+1` dă o zi întreagă de marjă.

⚠️ Repară **și linia 150**, deși testul ăla trece azi (așteaptă 403, iar autorizarea se verifică
înaintea datei). E aceeași bombă, doar că neamorsată. Nu o lăsa.

⚠️ **NU atinge `server/services/user-leave.mjs`.** Validarea „fără concediu retroactiv" e
CORECTĂ și intenționată. Testul e greșit, nu producția. Nu relaxa regula ca să treacă testul.

---

## PAS 2 — Măturăm clasa, nu doar cazul

```bash
grep -rn "20[0-9][0-9]-[0-9][0-9]-[0-9][0-9]" server/tests/ | grep -v node_modules
```

Pentru **fiecare** dată hardcodată găsită, decide și **raportează în tabel**:

| Fișier:linie | Data | E comparată cu „azi" în producție? | Verdict |
|---|---|---|---|

- **Comparată cu „azi"** (validări de tip „nu în trecut", „nu în viitor", expirări, ferestre)
  ⇒ 🔴 **bombă cu ceas — repar-o** cu `_isoIn()`.
- **Doar fixture de date** (ex. `opme-per-group-isolation.test.mjs:26` — `DATE '2026-05-06'`,
  o dată de import stocată, niciodată comparată cu prezentul) ⇒ ✅ **las-o în pace.**

Nu converti mecanic toate datele la relative — unele trebuie să fie stabile ca să fie
deterministe. **Criteriul e unul singur: producția o compară cu `NOW()`/`today`?**

---

## PAS 3 — Verificare

```bash
grep -n "2026-07-13\|2026-07-14" server/tests/db/user-email-reuse-authz.test.mjs
# Așteptat: ZERO

npm run test:db
# Așteptat: VERDE. Dacă sandbox-ul n-are Postgres, spune-o explicit —
# skipped ≠ passed. CI e verificarea autoritară.

npm test
# Așteptat: verde
```

`package.json` → **v3.9.680**. Zero fișiere în `public/`. Fără `CACHE_VERSION`.

Commit:
```
test: fixture-uri de concediu relative la ziua rulării — testul expirase prin calendar (v3.9.680)
```

---

## RAPORT FINAL

1. Ambele linii (135 și 150) folosesc acum `_isoIn()`? Grep-ul pe datele vechi e gol?
2. **Ai atins `server/services/user-leave.mjs`?** (Așteptat: **NU**. Validarea e corectă.)
3. Tabelul din PAS 2 — câte date hardcodate există în `server/tests/`, câte sunt bombe cu ceas, câte sunt fixture-uri legitime? Listează-le.
4. `npm run test:db` — verde sau skipped? Spune care, explicit.
5. `git diff --name-only public/` — gol? Versiune 3.9.680?
6. A rămas în repo vreo altă valoare „care se mișcă" fixată într-un test (versiune, dată, contor)? Dacă da: listează, **nu repara** în acest prompt.

---

## ⛔ CONSTRÂNGERI

- ⛔ **NU relaxa validarea din `user-leave.mjs`** ca să treacă testul. Producția are dreptate.
- ⛔ **NU converti toate datele la relative.** Doar cele comparate cu prezentul în producție.
- ⛔ **NU atinge `public/`.** Zero frontend.
- ⛔ Zonele NO-TOUCH: doar citire. **NU atinge `main`.**
- ⛔ Dacă un grep nu dă `# Așteptat:`, oprește-te și raportează.
