---
target_branch: develop
model_suggested: Opus 4.8 (plan mode obligatoriu — atinge logică financiară)
risk: HIGH — read-modify-write pe sume ALOP. Caracterizare-întâi NON-NEGOCIABILĂ.
---

# ⚠️ BRANCH: `develop` EXCLUSIV ⚠️

> NU atinge `main` (producție, manual de Mircea). Checkout/merge/push DOAR pe `develop`.

# Task: locking tranzacțional pe validările financiare ALOP (NU pe tranzițiile de status)

## Context (verificat în cod)

Tranzițiile de status ALOP din `server/routes/alop.mjs` (`confirma-lichidare`,
`ord-completed`, `confirma-plata`) folosesc deja `UPDATE ... WHERE status IN (...)`
cu `RETURNING` — sunt atomice prin clauza WHERE. **Acelea sunt OK, NU le rescrie.**

Riscul real e altul: nu există `FOR UPDATE` nicăieri în `routes/` + `services/`.
Problemele de cursă apar la:
- validările read-modify-write pe sume: ORD ≤ lichidare, plată ≤ ORD (se citește o
  sumă, se validează, apoi se scrie — fără lock pe rând);
- interleaving între confirmarea manuală, OPME auto-confirm
  (`applyPlataConfirmedSideEffects`, apelat și din `services/opme-matcher.mjs`) și
  `noua-lichidare` (care arhivează ciclul în `alop_ord_cicluri`).

NU supra-inginerii: scopul e să previi cursele pe operațiile cu bani și pe
arhivarea ciclului, nu să wrappezi fiecare endpoint în BEGIN/COMMIT inutil.

## Zone interzise
- NU atinge fișierele de signing (lista NO-TOUCH din CLAUDE.md).
- NU schimba semantica tranzițiilor de status care merg deja (UPDATE gardat).
- NU atinge `migrate.mjs`.

## Etapa 0 — caracterizare (OBLIGATORIE înainte de cod de producție)
Suita are deja teste DB pe state machine-ul ALOP. Extinde-le:
- fixează regulile financiare curente: ce se întâmplă azi când se încearcă ORD >
  lichidare, plată > ORD (probabil nimic — documentează starea reală);
- fixează comportamentul `applyPlataConfirmedSideEffects` cu garda existentă
  `status='plata' AND plata_confirmed_at IS NULL`;
- dacă infra permite, un test care simulează apel dublu concurent pe plată și
  asertează că side-effect-ul se aplică o singură dată.

Rulează `npm test` + `npm run test:db` → verzi pe baseline înainte de orice schimbare.

## Modificări cerute
1. Pentru operațiile cu read-modify-write pe sume (ordonanțare peste lichidare,
   plată peste ordonanțat) și pentru `noua-lichidare` (arhivare ciclu), wrappează
   în tranzacție explicită:
   ```
   BEGIN
   SELECT ... FROM alop_instances WHERE id=$1 AND org_id=$2 FOR UPDATE
   -- verificare stare + reguli financiare
   UPDATE ...
   -- audit event în aceeași tranzacție
   COMMIT   (ROLLBACK pe orice eroare)
   ```
   Folosește un `client` dedicat din pool (`pool.connect()`), nu `pool.query`
   direct, ca lock-ul să țină pe toată tranzacția.
2. Adaugă regulile financiare lipsă ca verificări explicite ÎN tranzacție:
   ord ≤ lichidare, plată ≤ ord. La încălcare → ROLLBACK + `400` cu mesaj clar.
3. `applyPlataConfirmedSideEffects` trebuie să accepte și să folosească același
   `client` tranzacțional când e apelat din OPME matcher (deja primește un
   `executor` — asigură-te că path-ul OPME rulează în aceeași tranzacție cu lock).

## Definition of done
- `npm test verde, fără regresii` + `npm run test:db verde`, cu testele noi de
  concurență incluse.
- `npm run check` trece.
- Tranzițiile de status existente NESCHIMBATE ca semantică (confirmă prin teste).
- Raport: ce reguli financiare ai adăugat, ce endpoint-uri au acum FOR UPDATE,
  ce ai lăsat intenționat neatins.
- Bump `package.json` patch +1. Commit + push DOAR pe `develop`.
