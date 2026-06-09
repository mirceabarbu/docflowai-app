# ⚠️ BRANCH: develop — NU `main`. NU push/merge/checkout pe main.

> NO-TOUCH (doar citire): `signing.mjs`, `bulk-signing.mjs`, `cloud-signing.mjs`,
> `pades.mjs`, `java-pades-client.mjs`, `STSCloudProvider.mjs`.
> Ambele fix-uri sunt în `server/index.mjs` — NU se ating fișierele de semnare.

---

## Obiectiv — corectitudine notificări (Bug 1 + Bug 3)

**Bug 1:** la finalizarea unui flux, utilizatorii primesc notificări `COMPLETED` duplicate (până la 5).
Cauza: `COMPLETED` se trimite din `signing.mjs`/`cloud-signing.mjs` (două locuri)/`bulk-signing.mjs`
(NO-TOUCH), iar callback-ul STS + polling-ul ating căile de finalizare de mai multe ori. Fixăm la nivelul
helper-ului `notify` (editabil), nu în fișierele de semnare: **dedup pentru tipurile terminale**.

**Bug 3:** job-ul de reminder (24/48/72h) trimite atenționări și pentru fluxuri **șterse** (`deleted_at`
setat) care nu erau finalizate. Interogarea exclude completed/refused/cancelled/review_requested, dar
NU exclude `deleted_at`. Fix: `AND deleted_at IS NULL`.

---

## Patch 1 (Bug 1) — `server/index.mjs`: dedup în `notify` pentru tipuri terminale

În funcția `async function notify({...})`, imediat după `if (!email) return;` (înainte de query-ul de
preferințe `uRow`), adaugă un guard anti-duplicat pentru `COMPLETED`/`REFUSED` (o singură notificare per
flux+user într-o fereastră scurtă — prinde callback+polling fără a bloca o re-finalizare legitimă ulterioară).

**old_str**
```
  const email = (userEmail || '').toLowerCase();
  if (!email) return;
  const [uRow] = (await pool.query('SELECT phone, notif_inapp, notif_whatsapp, notif_email FROM users WHERE email=$1', [email])).rows;
```
**new_str**
```
  const email = (userEmail || '').toLowerCase();
  if (!email) return;

  // Anti-duplicat (Bug-1): tipurile terminale se trimit o singură dată per flux+user
  // într-o fereastră scurtă. Cauza duplicatelor: COMPLETED emis din mai multe căi de
  // finalizare (callback STS + polling) în signing/cloud-signing/bulk-signing (NO-TOUCH).
  const ONCE_PER_FLOW_TYPES = new Set(['COMPLETED', 'REFUSED']);
  if (flowId && ONCE_PER_FLOW_TYPES.has(type)) {
    const { rows: dup } = await pool.query(
      `SELECT 1 FROM notifications
        WHERE user_email=$1 AND flow_id=$2 AND type=$3
          AND created_at > NOW() - INTERVAL '30 minutes'
        LIMIT 1`,
      [email, flowId, type]
    );
    if (dup.length) {
      logger.info({ email, flowId, type }, 'notify: duplicat suprimat (anti-spam terminal)');
      return;
    }
  }

  const [uRow] = (await pool.query('SELECT phone, notif_inapp, notif_whatsapp, notif_email FROM users WHERE email=$1', [email])).rows;
```

> Fereastra de 30 min prinde duplicatele cvasi-simultane (callback+polling, secunde/minute) și permite
> o re-finalizare legitimă (flux reinițiat cu același flowId) după interval. NU afectează `YOUR_TURN`,
> `REMINDER` (care escaladează intenționat) sau `REVIEW_REQUESTED`.

---

## Patch 2 (Bug 3) — `server/index.mjs`: reminderul ignoră fluxurile șterse

În `_runReminderJob`, în interogarea care selectează fluxurile, adaugă `AND deleted_at IS NULL`.

**old_str**
```
      `SELECT id, data FROM flows
       WHERE (data->>'completed') IS DISTINCT FROM 'true'
         AND (data->>'status') NOT IN ('refused','cancelled','review_requested')
         AND updated_at < $1
       LIMIT 300`,
```
**new_str**
```
      `SELECT id, data FROM flows
       WHERE deleted_at IS NULL
         AND (data->>'completed') IS DISTINCT FROM 'true'
         AND (data->>'status') NOT IN ('refused','cancelled','review_requested')
         AND updated_at < $1
       LIMIT 300`,
```

---

## Patch 3 — `package.json`: version bump

**old_str**
```
  "version": "3.9.528",
```
**new_str**
```
  "version": "3.9.529",
```

---

## Verificări

```bash
node --check server/index.mjs

# Bug 1: dedup prezent
grep -n "ONCE_PER_FLOW_TYPES\|duplicat suprimat" server/index.mjs   # 2 hit-uri

# Bug 3: reminderul filtrează deleted_at
grep -n "deleted_at IS NULL" server/index.mjs | head   # noul filtru în _runReminderJob

# Suita mock — backend-only, niciun test existent nu trebuie să pice
npm test   # → 800 verde

# diff strict: doar index.mjs + package.json
git diff --name-only
git diff --name-only | grep -E "signing|pades|STSCloud|^public/" ; echo "↑ trebuie GOL"
```

> Notă: `notify` și `_runReminderJob` sunt funcții interne (setInterval), nu rute — nu sunt acoperite
> ușor de harness fără refactor. Verificarea e prin cod + observație pe staging (vezi mai jos).

## Verificare manuală pe staging (recomandat)

- **Bug 1:** finalizează un flux cu mai mulți semnatari (ideal pe cale STS) → inițiatorul/semnatarii
  trebuie să primească **o singură** notificare „Document semnat complet", nu 2–5.
- **Bug 3:** șterge un flux în lucru (nefinalizat) → după rularea job-ului (sau forțat) NU mai trebuie
  să apară remindere 24/48/72h pentru el.

---

## RAPORT FINAL (completează)

- [ ] Versiune: 3.9.528 → 3.9.529
- [ ] Bug 1: dedup `COMPLETED`/`REFUSED` în `notify` (fereastră 30 min, per flux+user)
- [ ] Bug 3: `_runReminderJob` filtrează `deleted_at IS NULL`
- [ ] `npm test` verde (800)
- [ ] diff: doar `index.mjs` + `package.json`; fără fișiere de semnare/frontend
- [ ] commit + push **doar pe develop** → CI verde
- [ ] (după staging) confirmă: o singură notificare la finalizare + zero remindere pe fluxuri șterse

Commit sugerat:
```
fix(notif): suprimă COMPLETED duplicat + remindere pe fluxuri șterse

- notify: dedup tipuri terminale (COMPLETED/REFUSED) per flux+user, fereastră 30 min
  → cauza: callback STS + polling emit COMPLETED din mai multe căi în signing files (NO-TOUCH)
- _runReminderJob: AND deleted_at IS NULL → fluxurile șterse nu mai primesc remindere 24/48/72h
- v3.9.529
```
```
