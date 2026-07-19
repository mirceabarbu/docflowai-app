# PROMPT — REVERT v3.9.505 cosmetic, întoarcere la v3.9.504

⚠️ **BRANCH DEVELOP EXCLUSIV** — toate comenzile rulează pe `develop`. Niciun `git checkout main`, niciun merge, niciun push pe alt branch.

============================================================
## CONTEXT

Sprint-ul v3.9.505 cosmetic (locked-bar verde + eliminare `setS('Document aprobat','ok')` + CSS `.locked-bar.ok`) a cauzat efecte vizuale nedorite în producție. Trebuie revertat. Întoarcerea: starea exactă de după v3.9.504 (CIF lookup auto-fill), care funcționa corect.

NB: prompt-urile ulterioare v3.9.505 (opendoc cleanup), v3.9.506 (anulat read-only) **NU au fost rulate**, deci nu există pe develop. Doar v3.9.505 cosmetic trebuie revertat.

============================================================
## PAS 1 — Identifică SHA-urile

Pe develop, găsește commit-ul v3.9.504 și commit-ul v3.9.505 cosmetic:

```bash
git checkout develop
git pull origin develop
git log --oneline -10
```

În output ar trebui să vezi (de sus în jos, cel mai recent primul):
- Posibil alte commit-uri ale tale (dacă au fost)
- `<SHA-505> ux(form): consolidare "Document aprobat" pe un singur rând (v3.9.505)`
- `<SHA-504> feat(ord): CIF lookup auto-fill beneficiar — local → ANAF (v3.9.504)`
- mai jos: v3.9.503, v3.9.502, etc.

Notează SHA-ul commit-ului v3.9.505 cosmetic. Acela trebuie revertat.

============================================================
## PAS 2 — Revert cu commit nou

```bash
git revert <SHA-505>
```

Asta creează un commit nou care anulează modificările din v3.9.505 cosmetic. Editorul de git îți va deschide un mesaj de commit pre-completat — păstrează-l sau modifică la:

```
Revert "ux(form): consolidare Document aprobat pe un singur rând (v3.9.505)"

Revert după observare de efecte vizuale nedorite în producție. Întoarcere
la starea de după v3.9.504 (CIF lookup auto-fill). Restaurează:
- locked-bar tip 'info' (mov) pentru status aprobat
- setS('Document aprobat','ok') restaurat (sBar verde)
- CSS .locked-bar.ok eliminat
```

Salvează și închide editorul.

Dacă apar conflicte (improbabil — nimic ulterior nu a atins acele linii): rezolvă manual păstrând codul de la v3.9.504, apoi `git add` + `git revert --continue`.

============================================================
## PAS 3 — Verifică starea după revert

```bash
# Verifică că modificările cosmetice au dispărut
grep -c "setLockedBar(ft,'✔ Document aprobat.*','info')" public/js/formular/doc.js
# Așteptat: 1

grep -c "setS('Document aprobat','ok')" public/js/formular/doc.js
# Așteptat: 1

grep -c "\.locked-bar\.ok" public/css/formular/formular.css
# Așteptat: 0 (eliminat)
```

============================================================
## PAS 4 — Version bump

Commit-ul de revert va lăsa `package.json` și `sw.js` cu versiunile vechi (din v3.9.504). Asta e OK funcțional — codul e identic cu v3.9.504. Dar pentru a marca revert-ul explicit pe staging/production, bump:

În `package.json`: `3.9.505` → `3.9.506` (sărim peste, NU revenim la 3.9.504).
În `public/sw.js`: `CACHE_VERSION` `docflowai-v220` → `docflowai-v221`.

NB: nu revenim la 3.9.504 ca număr — service worker-ul are nevoie de version bump pentru a invalida cache-ul pe client. Sărim la 3.9.506 pentru a marca explicit "post-revert".

```bash
git add package.json public/sw.js
git commit -m "chore: bump v3.9.506 după revert v3.9.505 cosmetic"
```

============================================================
## PAS 5 — Push pe develop

```bash
git status
# Așteptat: working tree clean, ahead of origin/develop by 2 commits
git push origin develop
```

============================================================
## RAPORT FINAL

1. SHA commit revert pushed pe develop?
2. SHA commit bump v3.9.506?
3. Output `git log --oneline -5`?
4. Output celor 3 grep-uri din Pas 3?
5. `npm test` rulează verde? (Așteptat: aceleași teste verzi ca la v3.9.504, posibil +/- câteva legate de cosmetic — raportează exact dacă cade ceva.)
6. `git status` → working tree clean?

============================================================
## CONSTRÂNGERI

- Niciun `git checkout main`, niciun merge pe main, niciun push pe alt branch
- Nu atinge niciun alt fișier în afara revert-ului automat git
- Dacă apare conflict de merge la revert, OPREȘTE-TE și raportează — nu rezolva pe ghicit
- Dacă SHA-ul v3.9.505 cosmetic nu e ușor de identificat, OPREȘTE-TE și raportează `git log --oneline -20` complet
