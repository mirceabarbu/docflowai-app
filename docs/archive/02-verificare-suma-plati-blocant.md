---
fix: 2 / 4 — Verificare blocantă: suma tabelului de plăți (pct.5) = total angajamente (pct.4) înainte de Transmite P2
target_branch: develop
model_suggested: Opus 4.8 (mapare juridică OMF 1140/2025 + risc de blocare falsă)
risk: MEDIU — gate care poate bloca trimiterea formularului; trebuie să NU blocheze fals
---

# ⚠️ BRANCH `develop` EXCLUSIV
Toate comenzile rulează pe `develop`. NU `checkout/merge/push` pe `main`. `main` = producție, manual de owner.

## NO-TOUCH
`STSCloudProvider.mjs`, `cloud-signing.mjs`, `bulk-signing.mjs`, `pades.mjs`, `java-pades-client.mjs`. `git diff` curat pe ele.

## Obiectiv
Tabelul de la **pct.4** („Valoarea angajamentelor legale") are coloana **Val. totală actualizată (7=5+6)** cu un TOTAL. Tabelul de la **pct.5** (planificarea plăților pe ani: ani precedenți, an curent, N+1, N+2, N+3, ani ulteriori) are propriul TOTAL pe toate benzile.

Conform logicii ALOP, **suma tuturor benzilor din tabelul de plăți (pct.5) trebuie să fie egală cu totalul Val. totală actualizată din pct.4**. Exemplu din capturi: `0 + 29.000 + 250.000 + 271.000 + 0 + 0 = 550.000` = totalul actualizat din pct.4 (550.000). ✓

Vrem:
1. **Indicator vizual** lângă/sub totalul tabelului de plăți: verde când sumele coincid, roșu + mesaj când diferă (afișează ambele sume: „Plăți planificate: X — Angajament total: Y — diferență: Z").
2. **Gate blocant**: dacă sumele NU coincid, butonul **Transmite P2** nu trebuie să trimită formularul (blocaj cu mesaj clar).

## Nuanță juridică — NU bloca fals (citește înainte)
Tabelul de plăți **nu e activ** pentru toate bifele pct.5. Din ghidul OMF 1140/2025: pentru sub-opțiunea **„Stingere angajamente în exercițiul curent"** tabelul de planificare multi-an e dezactivat. Dacă tabelul e dezactivat, suma lui e 0 și ar bloca fals față de pct.4. **Deci verificarea se aplică DOAR când tabelul de plăți e activ/relevant.** Când e dezactivat → gate-ul se sare (N/A), nu blochează.

## Caracterizare-întâi
```
# parsing numeric RO (helperele existente) + calcule total
grep -n "getNP\|pMR\|fMR\|valt_actualiz\|plati_estim_ancrt\|rows_plati\|rows_val" public/js/formular/core.js public/js/formular/doc.js
# logica care activează/dezactivează tabelul de plăți pe bifele pct.5
grep -n "Stingere\|updateTabel\|tabel-plati\|ang-stingere\|ang-cu-plati\|disabled" public/js/formular/*.js public/formular.html
# unde se face validarea / trimiterea la P2 (Transmite P2)
grep -n "Transmite\|transmitP2\|trimit.*p2\|btn.*p2\|submitP2" public/js/formular/*.js public/formular.html
# totalurile randate în UI (pct.4 col.7 și totalul pct.5)
grep -n "TOTAL\|total.*actualiz\|total.*plati" public/formular.html public/js/formular/*.js
```

## Implementare
1. Funcție pură `verificaSumaPlati()` care:
   - calculează **totalul Val. totală actualizată** din tabelul pct.4 (suma col.7 pe rânduri) cu helperul RO existent (`getNP`/`pMR`);
   - calculează **suma tuturor benzilor** din tabelul pct.5 (toate coloanele temporale × rânduri);
   - compară rotunjit la 2 zecimale (bani), toleranță ≤ 0.01 lei pentru floating-point;
   - întoarce `{ ok, sumaPlati, sumaAngajament, diferenta, aplicabil }` unde `aplicabil=false` dacă tabelul de plăți e dezactivat (caz „Stingere" etc.).
2. **Indicator vizual** sub totalul pct.5: verde/roșu + cifrele, doar când `aplicabil`. Actualizare live pe `input/change` în ambele tabele și pe schimbarea bifelor pct.5.
3. **Gate la Transmite P2**: în handlerul de trimitere, dacă `aplicabil && !ok` → oprește trimiterea, afișează mesajul, focus pe tabelul pct.5. (Nu schimba alte validări existente; doar adaugi acest gate.)
4. Stil consecvent cu design system-ul (clase scoped, fără `!important`). Folosește helper-ul de formatare RO existent pentru cifre.

## Teste
- Unit/caracterizare pe `verificaSumaPlati`: sume egale → `ok`; diferite → `!ok` cu `diferenta` corectă; tabel dezactivat (Stingere) → `aplicabil=false` (nu blochează); rotunjire pe 2 zecimale.
- Integrare (dacă există infra): Transmite P2 blocat când sume diferite & aplicabil; permis altfel.
- `npm test` verde.

## Acceptare
- `npm test` → **verde, fără regresii**.
- Nu blochează fals pe cazul „Stingere" / tabel dezactivat.
- `git diff` NO-TOUCH gol.
- Cache-bust țintit + bump `package.json` patch.

## Finalizare
```
git add -A
git commit -m "feat(formulare): gate blocant Transmite P2 — suma plăți (pct.5) = total angajamente actualizat (pct.4), cu indicator vizual"
git push origin develop
```
