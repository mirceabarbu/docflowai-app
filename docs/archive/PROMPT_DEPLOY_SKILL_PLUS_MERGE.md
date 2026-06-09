# PROMPT Claude Code — Skill nou pe develop + merge → main

> ⚠️ Acest prompt are DOUĂ faze cu naturi diferite:
>   - **Faza 1** (commit skill pe `develop`): operație mică, safe.
>   - **Faza 2** (merge `develop` → `main`): operație în PRODUCȚIE.
>     Activează skill-ul `docflowai-deploy` care impune gate-uri stricte
>     (pg_dump, confirmare „DA, merge", monitorizare 10 min).
> Faza 2 NU începe automat — se așteaptă confirmarea utilizatorului
> după ce Faza 1 e raportată ca terminată.

## Faza 0 — Verificări preliminare (BLOCANTE)

```bash
# 0.1 Skill-ul nou există local, în calea corectă (cu „s" la skills)
find .claude -type f -name "SKILL.md" | sort
# Așteptat exact 2 rezultate:
#   .claude/skills/docflowai-deploy/SKILL.md   ← nou
#   .claude/skills/docflowai-ui/SKILL.md       ← existent

# 0.2 Frontmatter valid pe skill-ul nou
head -4 .claude/skills/docflowai-deploy/SKILL.md
# Așteptat primele linii:
#   ---
#   name: docflowai-deploy
#   description: >
#     Procedura OBLIGATORIE pentru deploy DocFlowAI ...

# 0.3 Develop are deja hang-fix-ul (v3.9.485)
git fetch origin
git checkout develop && git pull origin develop
grep '"version"' package.json
# Așteptat: "version": "3.9.485" sau mai mare.
# DACĂ vezi "3.9.484" → STOP. Spune-i utilizatorului: „rulează întâi
# prompt-ul PROMPT_HANG_FIX_v3_9_485.md, apoi reia acest prompt".

# 0.4 Working tree curat (în afară de skill-ul nou care e untracked)
git status --short
# Așteptat: doar `?? .claude/skills/docflowai-deploy/SKILL.md`
# (sau nimic dacă a fost deja add-uit). Orice altceva neașteptat → STOP.

# 0.5 Staging trăiește
curl -sf -o /dev/null -w "staging /health: HTTP %{http_code}\n" \
  https://docflowai-app-staging.up.railway.app/health
# Așteptat: HTTP 200. Dacă nu → STOP, raportează utilizatorului.
```

Dacă ORICE verificare 0.1–0.5 pică → oprește, raportează exact ce-ai
văzut și ce așteptai. Nu trece la Faza 1.

## ⛔ ZONE NO-TOUCH (valabile în AMBELE faze)

```
server/signing/providers/STSCloudProvider.mjs
server/routes/flows/cloud-signing.mjs
server/routes/flows/bulk-signing.mjs
server/signing/pades.mjs
server/signing/java-pades-client.mjs
server/db/migrate.mjs
```

În Faza 1 nu atingi NIMIC în afară de `.claude/skills/docflowai-deploy/SKILL.md`.
În Faza 2, doar git ops (checkout, merge, push) — nu modifici cod.

---

## FAZA 1 — Commit + push skill nou pe develop

### 1.1 Citește skill-ul (încarcă-l în context)

```bash
cat .claude/skills/docflowai-deploy/SKILL.md
```

> Confirmă explicit în răspuns: „Skill `docflowai-deploy` încărcat
> ({N} linii, {M} secțiuni `##`)." Așa știe utilizatorul că tu îl ai
> activ, nu doar că e pe disc.

### 1.2 Add + commit

```bash
git add .claude/skills/docflowai-deploy/SKILL.md

git commit -m "chore(skills): add docflowai-deploy SKILL.md

Procedură formalizată pentru deploy develop → main:
- gate-uri pre-merge (staging healthy, branch curat, npm test verde,
  inspecție migrări inline + V4 conform incident 2026-04-19)
- pg_dump obligatoriu salvat local înainte de orice push pe main
- merge --no-ff cu mesaj standardizat și confirmare explicită DA, merge
- monitorizare post-deploy 10 min (/health, login, DB ready. în log)
- rollback documentat (git revert -m 1 ca default, --force-with-lease
  doar cu confirmare scrisă)
- checklist final 11 puncte + format raport final fix

Skill-ul se auto-încarcă în Claude Code la trigger-e de tip
'merge develop main', 'deploy prod', 'pornește producția prin merge'."
```

### 1.3 Push pe develop

```bash
git push origin develop
```

### 1.4 Verificare post-push

```bash
# SHA-ul commit-ului
git log -1 --format='%h %s'

# Skill-ul e pe remote
git fetch origin
git diff origin/develop..develop -- .claude/skills/docflowai-deploy/SKILL.md
# Așteptat: gol (totul push-at)

# Două skill-uri active acum
git ls-tree -r origin/develop -- .claude/skills/
# Așteptat: 2 fișiere SKILL.md
```

### 1.5 RAPORT FAZA 1 (formatul așteptat)

```
FAZA 1 COMPLETĂ:
  Commit: <SHA scurt> pe develop
  Fișiere: .claude/skills/docflowai-deploy/SKILL.md (+N -0)
  Push: develop @ <SHA scurt>
  Skill activ în această sesiune: da ({N} linii încărcate în context)
  Staging redeploy: declanșat automat (nu afectează app — schimbarea e doar în .claude/)
  Develop @ versiune: v3.9.485 (sau mai sus)
```

**OPREȘTE-TE AICI**. Așteaptă utilizatorul să răspundă cu unul din:
- `Continuă Faza 2` → treci la merge develop → main
- `Stop` / `Mâine` / orice altceva → încheie sesiunea aici

Nu trece la Faza 2 fără un „continuă" explicit. Motivul: utilizatorul
ar putea vrea să verifice manual staging înainte de a livra în prod,
sau să amâne merge-ul.

---

## FAZA 2 — Merge develop → main (folosind skill-ul `docflowai-deploy`)

Activează-se DOAR la comanda explicită „Continuă Faza 2" sau echivalent.

### 2.1 Re-confirmă skill-ul activ

```bash
# Confirmă că `docflowai-deploy` e încărcat în context.
# Dacă din vreun motiv n-a fost — re-citește:
test -f .claude/skills/docflowai-deploy/SKILL.md && \
  echo "Skill prezent. Aplic procedura din SKILL.md exact."
```

### 2.2 Urmează skill-ul `docflowai-deploy` PAS CU PAS

Aplică TOATE secțiunile din `.claude/skills/docflowai-deploy/SKILL.md`,
în ordine, fără sări peste:

1. **Gate-uri pre-merge** — toate 5 (staging healthy, branch sincronizat,
   `npm test` verde, inspecție migrări, bump versiune dacă e cazul).
   La fiecare „STOP" din skill — oprește efectiv, raportează.

2. **Întreabă utilizatorul despre 24h staging**. Skill-ul spune că
   trebuie 24h uptime; v3.9.485 e proaspăt push-at și NU are 24h.
   Întreabă textual:
   > „v3.9.485 (hang-fix) e proaspăt push-at pe staging — nu are 24h
   > uptime cum cere skill-ul. Confirmi că asumi excepția dată fiind că
   > e un fix pentru incident activ în producție? Răspuns: `da, asum` /
   > `nu, aștept 24h`."
   Fără „da, asum" exact → STOP, încheie cu mesaj „aștept 24h, reia mâine".

3. **Backup pg_dump OBLIGATORIU**. Skill-ul îți spune exact comanda;
   așteaptă utilizatorul să confirme că vede fișierul local.

4. **Merge `--no-ff`** cu mesajul standardizat. Înainte de `git push origin main`
   afișează `git log -1 --stat` + `git log main@{u}..main --oneline` și
   cere confirmarea exactă „DA, merge".

5. **Push pe main** doar la „DA, merge" exact (case-insensitive).

6. **Monitorizare 10 min** — la 30s, 1m, 2m, 5m, 10m: `curl /health`,
   verifică `"version":"3.9.485"`, verifică Railway log pentru `DB ready.`
   și absența `db_not_ready` / `ROLLBACK`.

### 2.3 RAPORT FAZA 2 (formatul din skill)

Format exact din skill-ul `docflowai-deploy`, secțiunea „Raport final":

```
DEPLOY: v3.9.485 → producție
Backup:  ~/docflowai-backups/prod-YYYYMMDDTHHMMSSZ-pre-deploy.sql (X MB)
Commits livrate (N):
  - <sha> chore(skills): add docflowai-deploy SKILL.md
  - <sha> fix(stability): crash-on-error + DB timeouts (v3.9.485)
  - ...
Migrări noi (M):
  - inline: <listă sau „niciuna">
  - V4:     <listă sau „niciuna">
Post-deploy (verificat 10 min):
  - /health: 200 ✅
  - login:   200 ✅
  - DB ready.: da ✅
  - 503 errors: 0 ✅
Versiune servită: v3.9.485 (confirmat via /health)
```

---

## Ce să faci dacă ceva pică

- **Faza 1 pică (commit/push)**: oprește, raportează exact eroarea git.
  Nu încerca workaround-uri. Probabil e un conflict pe `.claude/` din
  alt commit recent — îmi trimiți eroarea și fac patch.
- **Faza 2 pică la oricare gate**: oprește, raportează care gate și de
  ce. Nu face „mai încearcă o dată".
- **Faza 2 pică post-push pe main** (producție returnează 5xx):
  aplică secțiunea „Rollback" din skill — întâi `git revert -m 1`
  (safe), apoi cere confirmare „DA, force push main" pentru orice
  metodă mai dură.

---

## Ce ramane în sarcina utilizatorului (Mircea), NU Claude Code

Independent de acest prompt:

1. **Healthcheck Railway** pe ambele environments (staging + production):
   path `/health`, interval 30s, timeout 10s, failure threshold 3.
   Setat din dashboard, nu din cod.
2. **Restart policy** confirmat `ON_FAILURE` sau `ALWAYS`.
3. **Monitorizare azi noapte 02:00 UTC** — dacă apare iar un crash,
   acum v3.9.485 îți va lăsa stack trace în Railway log (`unhandledRejection — exiting`).
   Trimite stack trace-ul ca să facem patch țintit pe sursa hang-ului
   original.
