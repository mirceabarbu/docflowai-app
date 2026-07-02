# FIX: Revizia DF nu reține atașamentele și capturile reviziei precedente

> ⚠️ **ATENȚIE — BRANCH DISCIPLINE**
> Toate modificările se fac **EXCLUSIV pe branch-ul `develop`**.
> NU propune și NU executa merge/push/checkout către `main`. `main` = producție, gestionat manual.
> **ZONA NO-TOUCH:** `server/routes/flows/cloud-signing.mjs`, `server/routes/flows/bulk-signing.mjs`, `server/signing/pades.mjs`, `server/signing/java-pades-client.mjs`, `server/signing/providers/STSCloudProvider.mjs` — zero modificări.
> 🔒 **INVARIANT (din v3.9.554, CLAUDE.md):** relink-ul ALOP de la revizie și guard-ul de conflict `link-df` rămân neatinse.

## Bug confirmat (cauză identificată în cod)

La crearea unei revizii DF (`POST /revizuieste` în `server/routes/formulare/df.mjs`), `INSERT...SELECT` copiază doar coloanele din `formulare_df`. Atașamentele (`formulare_atasamente`) și capturile de ecran (`formulare_capturi`) sunt tabele separate legate prin `(form_type, form_id)`, iar revizia primește un **id nou** → R1 pornește fără atașamente/capturi, care rămân pe R0 (istoric, blocat la editare). Utilizatorul pierde efectiv anexele la fiecare revizuire.

Notă de scop: doar DF are revizii (ORD nu are endpoint de revizuire). Atașamentele nu sunt încorporate în PDF-ul generat — sunt anexe servite din UI — deci fix-ul e limitat la copierea rândurilor.

## Implementare

### 1. Copierea satelit-elor la revizie (`df.mjs`, endpoint /revizuieste)

În **aceeași tranzacție** cu INSERT-ul reviziei (verifică dacă endpoint-ul folosește deja un client de tranzacție; dacă nu, înfășoară INSERT revizie + copieri + relink ALOP în BEGIN/COMMIT cu client dedicat din pool, pattern-ul existent în proiect):

```sql
INSERT INTO formulare_atasamente (form_type, form_id, uploaded_by, filename, mime_type, size_bytes, data, slot)
SELECT form_type, $idRevizieNoua, uploaded_by, filename, mime_type, size_bytes, data, slot
FROM formulare_atasamente
WHERE form_type='df' AND form_id=$idParinte AND deleted_at IS NULL;
```

Idem pentru `formulare_capturi` (atenție: coloana e `mimetype`, nu `mime_type` — verifică schema exactă din migrarea 080 / ruta de capturi din `shared.mjs`; copiază toate sloturile existente).

Decizii de implementare:
- `uploaded_by` se păstrează de la uploader-ul original (proveniență corectă în audit).
- `created_at` poate rămâne default NOW() pe rândurile noi — acceptabil; dacă tabela are coloana în INSERT-list ușor de propagat, propag-o.
- Copierea e non-fatală DOAR dacă întreaga operație e în tranzacție (atunci nu se pune problema); dacă rămâi fără tranzacție din motive întemeiate, documentează și loghează eșecul vizibil (`logger.error`), nu silențios.

### 2. Comportament la ștergerea reviziei

`stergeFormular` (formular-shared.mjs) șterge soft revizia → atașamentele copiate rămân legate de `form_id`-ul șters, invizibile prin filtrarea existentă. Nu necesită modificare, dar adaugă un comentariu acolo că atașamentele orfane ale reviziilor șterse sunt intenționat lăsate (audit) — și verifică faptul că re-crearea unei revizii cu același `revizie_nr` după ștergere NU vede atașamentele celei șterse (form_id diferit — confirmă în test).

### 3. Teste

- Integration: creare revizie pe DF cu 2 atașamente (slot 1) + 1 captură → revizia are propriile copii (rânduri noi, `form_id` = id-ul reviziei, conținut `data` identic); ștergerea unui atașament de pe revizie NU afectează atașamentele R0; R0 își păstrează rândurile.
- Caracterizare: revizie pe DF fără atașamente → zero rânduri copiate, comportament identic cu acum.
- Dacă endpoint-ul devine tranzacțional: test că eșecul INSERT-ului de revizie nu lasă copii orfane.

### 4. Verificare manuală în staging (descrie în commit)

DF cu atașament + captură → trimite pe flux → aprobă → revizuiește → revizia afișează atașamentul și captura, descărcabile; R0 istoric le păstrează și el.

## Criterii de acceptare

- `npm test` verde, fără regresii.
- Zona NO-TOUCH + invariantul relink: `git diff` curat pe fișierele respective (în df.mjs se schimbă DOAR endpoint-ul /revizuieste, nu WHERE-ul relink-ului).
- Cache-bust dacă se ating asset-uri JS (probabil nu e cazul — fix exclusiv backend), bump versiune `package.json`, CLAUDE.md: o linie în secțiunea de revizii („revizia copiază atașamentele și capturile părintelui în tranzacție").
- Commit-uri mici, doar pe `develop`.
