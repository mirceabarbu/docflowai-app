# ⚠️ BRANCH: develop — NU `main`. NU push/merge/checkout pe main.

## Obiectiv

Extinde trigger-ele workflow-ului `audit.yml` să ruleze și la `push` pe `develop`, ca fiecare
commit pe develop să fie verificat automat în CI (audit + `npm test` mock + `npm run test:db`
pe Postgres real — serviciul `postgres:16` e deja configurat din Etapa 1).

Modificare: o singură intrare în lista `push.branches`. Restul rămâne neschimbat.

---

## Patch 1 — `.github/workflows/audit.yml`

**old_str**
```
on:
  push:
    branches: [ main, production ]
  pull_request:
    branches: [ main ]
```
**new_str**
```
on:
  push:
    branches: [ main, production, develop ]
  pull_request:
    branches: [ main ]
```

---

## Patch 2 — `package.json`: version bump (consistență per-commit)

**old_str**
```
  "version": "3.9.524",
```
**new_str**
```
  "version": "3.9.525",
```

---

## Verificări

```bash
# Trigger include develop
grep -n "branches:.*develop" .github/workflows/audit.yml   # 1 hit pe linia push.branches

# Diff strict
git diff --name-only
#   → trebuie DOAR: .github/workflows/audit.yml + package.json

# NO-TOUCH semnare
git diff --name-only | grep -E "signing|pades|STSCloud" ; echo "↑ trebuie GOL"
```

După push, deschide pe GitHub tab-ul **Actions** → workflow-ul „Security Audit" → confirmă că
apare un run nou pe commit-ul tău, pe branch `develop`, cu ambele job-uri (`audit` + `test`) verzi.
Pasul „Run DB test suite (Postgres real)" trebuie să raporteze cele 23 teste DB **passed** (nu skipped).

---

## RAPORT FINAL

- [ ] Versiune: 3.9.524 → 3.9.525
- [ ] `audit.yml` rulează acum și pe `push: develop`
- [ ] `git diff --name-only` → doar `audit.yml` + `package.json`
- [ ] commit + push pe develop → run CI verde (raportează SHA + statusul job-urilor)

Commit sugerat:
```
ci: rulează workflow-ul și pe push pe develop (test pe Postgres real în CI)

- adaugă develop la push.branches în audit.yml
- fiecare commit pe develop e acum verificat: audit + npm test (mock) + npm run test:db (postgres:16)
- închide bucla pentru baseline 778 + 23 DB (până acum rulate doar local)
- v3.9.525
```
