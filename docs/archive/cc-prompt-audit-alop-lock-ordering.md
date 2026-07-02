---
target_branch: develop (READ-ONLY — zero editări, zero commit, zero push)
model_suggested: Opus 4.8 (raționament de concurență / deadlock)
risk: NONE — audit static pur. NU modifica niciun fișier.
---

# ⚠️ AUDIT READ-ONLY ⚠️

> Acest task NU editează cod. NU face `str_replace`, NU crea fișiere, NU comite,
> NU pusha, NU atinge `main`. Singurul livrabil e un RAPORT în chat. Dacă găsești
> un bug, îl DESCRII — nu-l repari aici. Reparațiile sunt task separat, cu
> caracterizare-întâi.

# Task: audit de lock-ordering și lock-duration pe tranzacțiile ALOP (post P0.2)

## Context
P0.2 (commit f78b505, v3.9.560) a introdus 3 puncte cu `SELECT ... FOR UPDATE`
pe conexiune dedicată (`pool.connect()` + BEGIN/COMMIT):
1. `confirma-plata` — `server/routes/alop.mjs`
2. `noua-lichidare` — `server/routes/alop.mjs`
3. `_processGroup` — `server/services/opme-matcher.mjs`

`applyPlataConfirmedSideEffects` (`alop.mjs`, primește un `executor`/`client`) e
apelat din ambele: endpoint-ul manual `confirma-plata` ȘI matcher-ul OPME.

Testele de concurență existente sunt `Promise.all` pe ACELAȘI ALOP → se
serializează pe același rând (cazul ușor). Acest audit acoperă ce NU prind ele.

## Citește efectiv (nu din memorie)
- `server/routes/alop.mjs` — funcțiile `confirma-plata`, `noua-lichidare`,
  `applyPlataConfirmedSideEffects`.
- `server/services/opme-matcher.mjs` — `_processGroup`, bucla apelantă
  (`matchImport` / `tryAutoConfirmAlop`), și unde începe/închide tranzacția.

## Întrebări la care raportul TREBUIE să răspundă cu dovadă (nr. linie + citat scurt)

### 1. Ordinea de achiziție a lock-urilor (risc deadlock)
Pentru FIECARE din cele 3 căi, listează în ordine ce rânduri/tabele blochează
sau scrie în cadrul tranzacției (`alop_instances`, `alop_ord_cicluri`,
`opme_lines`, eventual buget). Întrebarea cheie:
- **Există vreo cale care atinge două tabele în ordine INVERSĂ față de altă cale?**
  (ex: A blochează `alop_instances` apoi scrie `opme_lines`; B atinge `opme_lines`
  apoi `alop_instances`.) Dacă da → potențial deadlock; descrie scenariul.
- Vreo cale care face `FOR UPDATE` pe **mai multe rânduri ALOP** într-o singură
  tranzacție fără `ORDER BY id` deterministic? (lock ordering nedeterministic
  între rânduri = deadlock clasic).

### 2. Durata lock-ului în batch-ul OPME
- `_processGroup` rulează într-o tranzacție **per-ALOP (BEGIN/COMMIT scurt)** sau
  e apelat în buclă în interiorul UNUI SINGUR `BEGIN` peste tot importul?
- Dacă e un singur BEGIN peste batch: lock-urile pe rânduri se acumulează pe toată
  durata importului → contenție cu `confirma-plata` manual. Cuantifică (câte
  rânduri pot fi blocate simultan).

### 3. I/O extern sub lock (bombă de contenție)
- Vreuna din cele 3 tranzacții ține lock-ul `FOR UPDATE` în timp ce face muncă
  lentă/externă: HTTP către STS, generare PDF, email, Google Drive, query-uri
  grele? Un `FOR UPDATE` ținut peste un apel de rețea blochează rândul secunde.
  Verifică în special ce face `applyPlataConfirmedSideEffects` cât timp e sub lock.

### 4. Integritatea tranzacției (lock/conexiune scursă)
- Fiecare `BEGIN` are `COMMIT`/`ROLLBACK` pe TOATE ramurile, inclusiv `return`-uri
  timpurii (404/403/400) și `throw`?
- `client.release()` e în `finally` pe toate cele 3 căi? O conexiune ne-eliberată
  cu lock activ e mai rău decât lipsa lock-ului (epuizezi pool-ul, blochezi rândul
  la nesfârșit).

## Format raport (în chat, fără fișiere)
Pentru fiecare din cele 4 secțiuni: verdict scurt — `OK` / `RISC` / `BUG` — cu
linia exactă și 1-2 propoziții de justificare. La final: o listă prioritizată de
ce-ar trebui reparat (dacă ceva), ca task viitor cu caracterizare-întâi. NU repara
nimic acum.
