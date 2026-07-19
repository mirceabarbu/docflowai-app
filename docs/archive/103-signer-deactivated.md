---
prompt: 103
titlu: "sec(signer): un utilizator intern DEZACTIVAT nu mai poate fi semnatar — la creare, la delegare, la semnare"
model_suggested: Opus 4.8
branch: develop
zona: server/services/signer-identity.mjs (NOU), server/routes/flows/{crud,lifecycle,signing,cloud-signing}.mjs, teste
versiune_tinta: v3.9.689
---

# ⚠️ BRANCH: develop

> Lucrezi **EXCLUSIV** pe `develop`. `main` = **producție (v3.9.682)**, gestionat manual de Mircea.
> ⛔ NU face merge / push / checkout pe `main`.
>
> ⚠️ **COLIZIUNE DE NUME:**
> - `server/signing/*` = **NO-TOUCH** (cloud-signing, bulk-signing, pades, java-pades-client, STSCloudProvider). **Interzis.**
> - `server/routes/flows/signing.mjs` și `server/routes/flows/cloud-signing.mjs` = **alte fișiere**, pe care **le modifici**.
>
> Verifică întotdeauna calea completă. O greșeală aici nu strică un afișaj — strică un document semnat.

---

## CONTEXT — decizia owner-ului

Semnarea **nu** folosește sesiune de utilizator. `signFlow` (`signing.mjs:39`) o spune în propriul comentariu:

> *„Semnarea din pagina publică de signer se face pe baza tokenului de semnatar, fără sesiune de utilizator logat."*

Autentificarea e **exclusiv** `signers.findIndex(s => s.token === token)`. E o alegere deliberată de
arhitectură — face posibilă semnarea de către externi, care n-au cont. Dar are un efect secundar:

**Dezactivarea unui utilizator NU îl împiedică să semneze un flux pe care era deja pus.** Link-ul lui
e valabil 90 de zile. Un angajat căruia i s-a tăiat accesul azi poate aplica mâine o semnătură
calificată pe un document oficial al instituției. `sessionGuard` (#88) nu vede niciodată calea asta.

**Decizia owner-ului (Mircea, 14.07.2026): se blochează.**

> **Regula: un semnatar care este utilizator intern trebuie să fie ACTIV ca să conteze — la creare
> flux, la delegare, la semnare.**

### Clasificarea în TREI, nu în două

Aici e tot miezul. Un simplu `deleted_at IS NULL` (#102) **nu blochează nimic** — doar degradează,
pentru că nu distinge „utilizator șters" de „niciun utilizator". Emailul trebuie clasificat în trei:

| Clasă | Înseamnă | Verdict |
|---|---|---|
| `active` | există un rând în `users` cu `deleted_at IS NULL` | **OK** |
| `deactivated` | există rând(uri), **toate** cu `deleted_at` setat | **REFUZ** |
| `external` | **niciun** rând în `users` | **OK** — semnatar extern, legitim |

⚠️ `external` **trebuie** să treacă. Semnarea de către externi e o funcție a produsului, nu o scăpare.

### Punctele de aplicare — exact patru

Le-am cartografiat deja. **Nu căuta altele, nu adăuga altele:**

| Rută | Autentificare | Blocăm? |
|---|---|---|
| `POST /flows` (creare) — `crud.mjs` | sesiune | **DA** — toți semnatarii, nu doar primul |
| `POST /flows/:id/delegate` — `lifecycle.mjs` | sesiune | **DA** — ținta delegării |
| `POST /flows/:id/sign` — `signing.mjs:39` | token opac | **DA** |
| `POST /flows/:id/initiate-cloud-signing` — `cloud-signing.mjs:633` | token opac | **DA** — calea STS reală |

**NU blocăm** (și e deliberat — nu „completa" lista):

- `POST /bulk-signing/initiate` — cere deja `requireAuth` (`bulk-signing.mjs:116`) ⇒ acoperit de `sessionGuard` din #88.1.
- `POST /flows/:id/upload-signed-pdf` — cere deja `signers[idx].status === 'signed'` (`signing.mjs:288`) ⇒ nu ajungi acolo dacă `/sign` te-a refuzat.
- `POST /flows/:id/refuse` — ⛔ **NU ÎL ATINGE.** Refuzul e singura supapă care deblochează un flux
  înțepenit pe un cont mort. Refuzul nu angajează instituția, o oprește. Dacă îl blochezi, documentul
  rămâne prizonier.

---

## PAS 0 — RECON (read-only)

```bash
sed -n '39,68p'   server/routes/flows/signing.mjs           # signFlow
sed -n '633,652p' server/routes/flows/cloud-signing.mjs     # initiate-cloud-signing
sed -n '210,232p' server/routes/flows/crud.mjs              # normalizedSigners la creare
grep -n "normalizedSigners" server/routes/flows/crud.mjs | head
grep -n "router.post.*delegate\|delegat" server/routes/flows/lifecycle.mjs | head -5
sed -n '375,410p' server/routes/flows/lifecycle.mjs         # ruta de delegare
grep -rn "signers.findIndex(s => s.token" server/routes/flows/*.mjs   # toate căile pe token opac
```

**Răspunde în raport, ÎNAINTE să scrii cod:**
1. La creare (`crud.mjs`), unde e lista completă de semnatari și cum se numește? Garda trebuie să-i
   acopere pe **toți**, nu doar `normalizedSigners[0]` (azi doar primul e privit, pentru concediu).
2. Ruta de delegare din `lifecycle.mjs` — care e exact, și unde e emailul țintă?
3. `grep`-ul pe `findIndex(s => s.token` — confirmă că **nu** există o a cincea cale pe token opac
   care avansează o semnătură. Dacă găsești una, **raportează, nu o repara** — decidem împreună.

---

## PAS 1 — Modulul nou: `server/services/signer-identity.mjs`

**Acesta E cazul în care factorizarea e corectă** (spre deosebire de cele 7 query-uri de la #102):
aceeași regulă, aceeași semantică, patru apelanți. O singură definiție a adevărului.

```js
// server/services/signer-identity.mjs
//
// SEC-103: un utilizator intern DEZACTIVAT nu mai poate fi semnatar.
//
// Semnarea nu are sesiune (token opac de semnatar, by design — semnatarii externi n-au cont),
// deci sessionGuard (#88) nu acoperă această cale. Clasificarea de mai jos e singurul loc unde
// „cine e emailul ăsta" primește un răspuns autoritar.
//
// TREI clase, nu două. Un simplu `deleted_at IS NULL` confundă „șters" cu „inexistent" și nu
// blochează nimic. `external` TREBUIE să treacă — semnarea de către externi e o funcție, nu o scăpare.

import { pool, DB_READY } from '../db/index.mjs';
import { logger } from '../middleware/logger.mjs';

/** @typedef {'active'|'deactivated'|'external'|'unknown'} SignerClass */

/**
 * @param {string} email
 * @returns {Promise<{ cls: SignerClass, userId: number|null }>}
 *
 * `unknown` = nu putem clasifica (DB indisponibil). Apelantul decide — vezi PAS 2.
 */
export async function classifySignerEmail(email) {
  const e = String(email || '').trim().toLowerCase();
  if (!e) return { cls: 'external', userId: null };     // fără email nu există utilizator intern

  if (!pool || !DB_READY) {
    logger.error({ email: e }, 'classifySignerEmail: DB indisponibil');
    return { cls: 'unknown', userId: null };
  }

  try {
    // O SINGURĂ interogare. Indexul parțial din migrația 067 garantează cel mult UN rând activ.
    const { rows } = await pool.query(
      'SELECT id, deleted_at FROM users WHERE lower(email) = $1',
      [e]
    );
    if (!rows.length) return { cls: 'external', userId: null };
    const act = rows.find(r => r.deleted_at === null);
    if (act) return { cls: 'active', userId: act.id };
    return { cls: 'deactivated', userId: rows[0].id };
  } catch (err) {
    logger.error({ err, email: e }, 'classifySignerEmail: interogare eșuată');
    return { cls: 'unknown', userId: null };
  }
}
```

⚠️ **Clasificarea e GLOBALĂ, nu pe org.** Azi `crud.mjs:218` caută userul după email fără filtru de
org, iar noi păstrăm exact acel comportament. Un utilizator activ din **altă** organizație rămâne, ca
azi, `active`. **Nu schimba asta la acest prompt** — ar fi o modificare de comportament nediscutată.
Notează în raport dacă ți se pare greșit; nu o repara singur.

---

## PAS 2 — `unknown` (DB căzut): fail-closed la semnare, fail-open la creare

Nu e o inconsecvență, e o judecată:

- **La semnare și la `initiate-cloud-signing`** ⇒ `unknown` = **REFUZ** (503 `identity_check_unavailable`).
  Dacă nu putem verifica cine ești, nu semnezi un document oficial. Consistent cu `sessionGuard` (#88),
  care întoarce 503 pe aceeași condiție.
- **La creare flux și la delegare** ⇒ `unknown` = **treci** (log `warn`). Ambele cer deja sesiune, deci
  `sessionGuard` a fail-closed înaintea ta — dacă DB-ul e căzut, nici n-ai ajuns până aici. Un al doilea
  refuz e redundant, iar un flux nesalvat pierde munca utilizatorului.

---

## PAS 3 — Cele patru puncte

**3a. Creare flux (`crud.mjs`)** — verifică **TOȚI** semnatarii, înainte de orice scriere:

```js
// SEC-103: niciun semnatar nu poate fi un utilizator intern dezactivat.
const _deactivated = [];
for (const s of normalizedSigners) {                 // ⚠️ verifică numele real la PAS 0
  if (!s?.email) continue;
  const { cls } = await classifySignerEmail(s.email);
  if (cls === 'deactivated') _deactivated.push(s.email);
}
if (_deactivated.length) {
  return res.status(400).json({
    error: 'signer_deactivated',
    emails: _deactivated,
    message: _deactivated.length === 1
      ? `Utilizatorul ${_deactivated[0]} este dezactivat și nu poate fi semnatar.`
      : `Acești utilizatori sunt dezactivați și nu pot fi semnatari: ${_deactivated.join(', ')}.`
  });
}
```

Plasare: **înainte** de blocul 4.3 (auto-redirect concediu) și înainte de orice `saveFlow`.

**3b. Delegare (`lifecycle.mjs`)** — ținta delegării, înainte de a scrie `signers[idx]`:

```js
{
  const { cls } = await classifySignerEmail(toEmail);
  if (cls === 'deactivated') {
    return res.status(400).json({
      error: 'delegate_deactivated',
      message: 'Utilizatorul către care delegi este dezactivat.'
    });
  }
}
```

⚠️ Plasează-l **după** garda existentă `self_delegation_not_allowed`, ca ordinea erorilor să rămână stabilă.

**3c. `signFlow` (`signing.mjs:39`)** — după `not_current_signer`, **înainte** de `status = 'signed'`:

```js
{
  const { cls } = await classifySignerEmail(signers[idx].email);
  if (cls === 'deactivated') {
    logger.warn({ flowId, email: signers[idx].email }, 'SEC-103: semnare refuzată — cont dezactivat');
    return res.status(403).json({
      error: 'signer_deactivated',
      message: 'Contul tău a fost dezactivat. Nu mai poți semna. Contactează inițiatorul documentului.'
    });
  }
  if (cls === 'unknown') return res.status(503).json({ error: 'identity_check_unavailable' });
}
```

**3d. `initiate-cloud-signing` (`cloud-signing.mjs:633`)** — identic cu 3c, după `not_current_signer`,
înainte de orice apel către provider. **Aceasta e calea STS reală** — dacă o sari, garda e decorativă.

---

## PAS 4 — Ce NU faci

- ⛔ **Nu atinge `/flows/:id/refuse`.** Motivat mai sus. Dacă îl blochezi, înțepenești documente.
- ⛔ Nu atinge `bulk-signing.mjs` (deja `requireAuth`) și nu atinge `upload-signed-pdf` (deja cere `status === 'signed'`).
- ⛔ Nu schimba clasificarea în una scopată pe org.
- ⛔ Nu atinge `server/signing/*`.
- ⛔ Zero modificări în `public/`. (Frontend-ul afișează deja erorile server-side; textele de mai sus
  sunt în română, ajung direct la utilizator. Dacă vreo pagină înghite mesajul, **raportează** — nu-l repara aici.)
- ⛔ Nu modifica `_isSignerTokenExpired`, expirarea la 90 de zile, sau orice altă gardă existentă.

---

## PAS 5 — Teste (⛔ IMPORTĂ din producție — nu redeclara logica)

**Unit** — `server/tests/unit/signer-identity.test.mjs`, `pool` mock, importând `classifySignerEmail`:

1. zero rânduri ⇒ `external` ← *testul care apără semnatarii externi*
2. un rând cu `deleted_at = null` ⇒ `active` + `userId`
3. un rând cu `deleted_at` setat ⇒ `deactivated`
4. **două** rânduri (unul șters + unul activ, șters PRIMUL în ordinea returnată) ⇒ `active` ← *ordinea fizică nu trebuie să conteze*
5. email gol / null ⇒ `external` (nu crapă)
6. `DB_READY = false` ⇒ `unknown`, fără apel la DB
7. query aruncă ⇒ `unknown`

**DB** — `server/tests/db/signer-deactivated.test.mjs`, Postgres real.
⚠️ Două organizații ⇒ `orgName` **și** email distincte (`organizations.name` e UNIQUE — a picat CI-ul
la #100.2 exact aici).

8. creare flux cu un semnatar dezactivat ⇒ **400 `signer_deactivated`**, fluxul **NU** se salvează
9. creare flux cu un semnatar `external` (email fără cont) ⇒ **201/200**, fluxul se creează ← *regresia de care mă tem cel mai tare*
10. `POST /flows/:id/sign` cu tokenul unui semnatar al cărui cont a fost dezactivat **după** crearea fluxului ⇒ **403 `signer_deactivated`**, `signers[idx].status` rămâne `'current'` (verifică în DB, nu doar codul HTTP) ← *scenariul real*
11. același scenariu pe `initiate-cloud-signing` ⇒ **403**
12. delegare către un cont dezactivat ⇒ **400 `delegate_deactivated`**
13. delegare către un email **fără cont** (extern) ⇒ **trece** (comportament de azi, neschimbat)
14. `POST /flows/:id/refuse` de către un semnatar dezactivat ⇒ **trece** (deliberat — supapa rămâne deschisă)

Testele 9, 13 și 14 sunt cele care apără produsul de fixul ăsta. Dacă vreunul e roșu, **oprește-te**.

---

## PAS 6 — Versiune

`package.json` → **v3.9.689**. Zero fișiere în `public/` ⇒ fără `?v=`, fără `CACHE_VERSION`.

```bash
npm run check && npm test && npm run test:db
```

Commit:
```
sec(signer): utilizatorii interni dezactivați nu mai pot fi semnatari — creare, delegare, sign, STS (v3.9.689)
```

---

## RAPORT FINAL

1. PAS 0, întrebarea 3: `grep` pe `findIndex(s => s.token` — există o **a cincea** cale pe token opac care avansează o semnătură? Lipește ieșirea.
2. La creare, garda acoperă **toți** semnatarii sau doar primul? Arată linia.
3. Cele patru puncte sunt cablate? `grep -rn "classifySignerEmail" server/routes/` ⇒ trebuie **4** potriviri (+1 importul în fiecare fișier).
4. Ai atins `/refuse`? (**Trebuie să fie NU.**) Testul 14 e verde?
5. **Testul 9** (semnatar extern ⇒ fluxul se creează) — verde? Lipește. *Dacă e roșu, ai spart produsul.*
6. **Testul 10** (semnare refuzată + `status` rămâne `'current'` în DB) — verde? Lipește.
7. Testul 4 (ordinea fizică a rândurilor nu contează) — verde?
8. `unknown` (DB căzut): 503 la sign/STS, trecere la creare/delegare — implementat așa? Arată cele patru ramuri.
9. Clasificarea e globală (nu pe org)? Ai lăsat-o așa? Ce părere ai — merită scopată? (**Doar opinie. Zero cod.**)
10. `git diff --name-only` — lipește. Nimic din `public/`, nimic din `server/signing/`.
11. `npm test` și `npm run test:db` — **separat**, ambele verzi.

---

## ⛔ CONSTRÂNGERI ABSOLUTE

- ⛔ **`external` trece.** Semnatarii fără cont sunt legitimi. Dacă testul 9 pică, fixul e greșit, nu testul.
- ⛔ **`/refuse` rămâne deschis.** E supapa.
- ⛔ **`initiate-cloud-signing` NU se sare.** E calea STS reală — fără ea, garda e decorativă.
- ⛔ Clasificare globală, nu pe org. Nicio schimbare de comportament nediscutată.
- ⛔ `server/signing/*` — NO-TOUCH.
