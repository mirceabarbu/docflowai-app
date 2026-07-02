---
fix(notif): YOUR_TURN duplicat (×4) — dedup fereastră scurtă în notify() pentru cursa poll STS + callback (cloud-signing NO-TOUCH)
target_branch: develop
model_suggested: Opus 4.8 (logică de notificare cu ferestre per-tip — ușor de rupt reminderele dacă greșești)
risk: SCĂZUT (un bloc extins în notify; backend-only)
version: 3.9.604 → 3.9.605
---

# ⚠️ BRANCH `develop` EXCLUSIV
TOATE comenzile pe `develop`. NU `checkout`/`merge`/`push` pe `main`. La final `git push origin develop` și **STOP**.

# 🎯 Problema
Notificările „De semnat" (`type='YOUR_TURN'`, „Este rândul tău să semnezi documentul …") apar duplicate (×4) în pagina de notificări. Query-ul de listare e un simplu `SELECT * FROM notifications` (fără JOIN) — deci rândurile sunt real duplicate în DB. Cauza: poller-ul STS din `server/routes/flows/cloud-signing.mjs:566` (`STS poll notify`) emite `YOUR_TURN` pentru semnatarul curent printr-un read-modify-write ne-atomic pe `nextSigner.emailSent`; mai multe tick-uri de poll + callback-ul STS intră în cursă și cheamă `_notify` de mai multe ori. Aceeași clasă de bug ca duplicatele `COMPLETED` rezolvate în v3.9.529 — dar acolo `YOUR_TURN` a fost exclus intenționat (ca să nu blocheze reminderele care escaladează).

# 🚫 NO-TOUCH
Semnare integral — în special **NU** modifica `cloud-signing.mjs` (nici garda `emailSent`, nici poller-ul). Financiar ALOP. Fix-ul e EXCLUSIV în `notify()` din `server/index.mjs` (helper editabil prin care trec toate emiterile).

# 🎯 Soluția (pe precedentul v3.9.529)
Extinde garda anti-duplicat existentă din `notify()` cu **ferestre per-tip**: păstrează 30 min pentru `COMPLETED`/`REFUSED` și adaugă o **fereastră scurtă (2 minute) pentru `YOUR_TURN`**. Fereastra scurtă:
- absoarbe cursele poll+callback (secunde/zeci de secunde) → o singură notificare;
- **NU** blochează reminderele (`signing.mjs:445`, tot `YOUR_TURN`, dar la 24/48/72h → mult peste 2 min);
- **NU** blochează rândul altui semnatar (email diferit → altă cheie);
- **NU** blochează reinițierea fluxului (`lifecycle.mjs:131` emite pe `flowId` NOU → altă cheie).

# Etapa 0 — caracterizare
```bash
grep -n "ONCE_PER_FLOW_TYPES\|Anti-duplicat" server/index.mjs
sed -n "$(grep -n 'ONCE_PER_FLOW_TYPES' server/index.mjs | head -1 | cut -d: -f1),+16p" server/index.mjs
# Confirmă că YOUR_TURN vine din poll (mesajul din screenshot):
grep -n "Este rândul tău să semnezi documentul „\${data.docName}\"." server/routes/flows/cloud-signing.mjs
# Confirmă reminderele YOUR_TURN (nu trebuie afectate):
grep -n "Reminder: Document de semnat\|type: 'YOUR_TURN'" server/routes/flows/signing.mjs | head
```

# Implementare — `server/index.mjs`, în `notify()`
Înlocuiește blocul actual (guard-ul `ONCE_PER_FLOW_TYPES` cu fereastra fixă de 30 min) cu o variantă cu ferestre per-tip:

**old_str** (adaptează exact la conținutul din Etapa 0 — acesta e conținutul așteptat):
```js
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
```
**new_str**:
```js
  // Anti-duplicat cu ferestre per-tip:
  //  • COMPLETED/REFUSED (terminale) — 30 min: callback STS + polling emit din mai multe căi
  //    de finalizare (signing/cloud-signing/bulk-signing, NO-TOUCH).
  //  • YOUR_TURN — 2 min: absoarbe cursa poll STS + callback (cloud-signing:566, read-modify-write
  //    ne-atomic pe emailSent), FĂRĂ a bloca reminderele (24/48/72h), rândul altui semnatar
  //    (email diferit) sau reinițierea (flowId nou).
  const DEDUP_WINDOW = { COMPLETED: '30 minutes', REFUSED: '30 minutes', YOUR_TURN: '2 minutes' };
  const dedupWin = DEDUP_WINDOW[type];
  if (flowId && dedupWin) {
    const { rows: dup } = await pool.query(
      `SELECT 1 FROM notifications
        WHERE user_email=$1 AND flow_id=$2 AND type=$3
          AND created_at > NOW() - $4::interval
        LIMIT 1`,
      [email, flowId, type, dedupWin]
    );
    if (dup.length) {
      logger.info({ email, flowId, type }, 'notify: duplicat suprimat (dedup fereastră)');
      return;
    }
  }
```
Ordinea rămâne neschimbată: garda de dedup PRIMA, apoi blocul auto-transmit `COMPLETED` (deci un `COMPLETED` duplicat e suprimat înainte de a re-declanșa transmiterea — corect, idempotent). NU atinge restul funcției.

# Teste
`notify()` e funcție internă (nu rută) — nu e acoperită de harness fără refactor; verificarea reală e pe staging. Rulează suita existentă: `npm test verde, fără regresii`; `npm run check` OK. NU adăuga teste care depind de trimiterea reală de email/STS.

(Opțional, doar dacă `notify` e deja exportabil/testabil fără efecte externe: un test DB în `server/tests/db/` care apelează `notify({type:'YOUR_TURN', flowId, userEmail})` de două ori rapid → un singur rând; cu email diferit → două rânduri. Dacă necesită refactor de export, SARI peste — nu extinde scope-ul.)

# Guardrails diff
`git diff --name-only` atinge EXCLUSIV: `server/index.mjs`, `package.json` (+ opțional un test în `server/tests/db/`).
```bash
git diff --name-only | grep -E "cloud-signing|bulk-signing|signing\.mjs|pades|STSCloud|java-pades|alop\.mjs" && echo "⛔ STOP: zonă interzisă!" || echo "✅ NO-TOUCH ok"
git diff server/index.mjs | grep -n "DEDUP_WINDOW\|ONCE_PER_FLOW_TYPES" && echo "verifică: blocul vechi înlocuit complet, nu duplicat"
```
Backend-only → fără `?v=`/`CACHE_VERSION`. Bump `package.json` 3.9.604 → 3.9.605.

# Curățare duplicate deja existente (opțional, o singură dată — DOAR dacă owner confirmă)
Duplicatele deja în DB rămân până le ștergi. **NU** rula automat; propune owner-ului un one-shot de curățare (păstrează rândul cel mai recent per (user_email, flow_id, type, title) pentru YOUR_TURN necitite):
```sql
-- Rulează manual, cu backup, DOAR după confirmarea owner-ului:
DELETE FROM notifications a USING notifications b
 WHERE a.type='YOUR_TURN' AND a.user_email=b.user_email AND a.flow_id=b.flow_id
   AND a.title=b.title AND a.read=false AND b.read=false AND a.id < b.id;
```
Nu include acest DELETE în cod/migrație — e o operațiune de întreținere, la decizia owner-ului.

# La final
```bash
git add server/index.mjs package.json
git commit -m "fix(notif): dedup fereastră scurtă pentru YOUR_TURN — elimină duplicatele din cursa poll STS + callback (v3.9.605)"
git push origin develop
```
**STOP. NU merge/push pe `main`.** Raportează:
1. Blocul `ONCE_PER_FLOW_TYPES` înlocuit cu `DEDUP_WINDOW` per-tip; `cloud-signing.mjs` neatins (NO-TOUCH).
2. Ferestre: COMPLETED/REFUSED 30 min (neschimbat), YOUR_TURN 2 min (nou).
3. Status CI (`npm test` verde, `npm run check`).
4. Pas de verificare pe staging: semnează un flux pe cale STS Cloud cu ≥2 semnatari → următorul semnatar primește **o singură** notificare „De semnat", nu 2–4.
5. Dacă owner cere, rulează manual DELETE-ul de curățare a duplicatelor existente.
