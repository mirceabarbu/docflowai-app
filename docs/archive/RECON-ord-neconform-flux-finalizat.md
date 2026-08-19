# RECON — ORD neconform cu flux finalizat (READ-ONLY)

**Context:** ordonanțare semnată doar de inițiator, ajunsă „aprobat", flux finalizat.
Documentul **nu a ieșit din instituție** ⇒ reparație de date legitimă.
**Țintă:** ORD revine la `completed`, ALOP oferă din nou „Generează + Lansează flux ORD".

**Ancoră (din URL):** ORD `id = 22f74f35-cae6-4e60-8bc3-ba111f49ec86`
(Nr. ORD 41011 · 14.07.2026 · DF 6744 „Servicii iluminat public" · Primăria Zărnești)

> ⛔ Toate interogările de mai jos sunt **READ-ONLY**. Nu executa niciun `UPDATE`
> până nu vedem rezultatele împreună. Rulează-le în Railway → Postgres → Query.

---

## Q1 — Starea ORD-ului

```sql
SELECT id, nr_ordonant_pl, status, aprobat, flow_id, org_id,
       created_by, assigned_to, created_at, updated_at
FROM formulare_ord
WHERE id = '22f74f35-cae6-4e60-8bc3-ba111f49ec86';
```

**Ce ne spune:** `status` (probabil `aprobat` sau `transmis_flux`), dacă `aprobat=true`,
și `flow_id` = fluxul de curățat.

---

## Q2 — ALOP-ul legat și, CRUCIAL, statusul lui

```sql
SELECT a.id, a.status, a.df_id, a.ord_id,
       a.ord_flow_id, a.ord_completed_at,
       a.df_flow_id, a.df_completed_at,
       a.lichidare_confirmed_at, a.cancelled_at,
       a.org_id, a.updated_at
FROM alop_instances a
WHERE a.ord_id = '22f74f35-cae6-4e60-8bc3-ba111f49ec86';
```

**Decide tot restul:**
- `status = 'ordonantare'` ⇒ reparația **nu atinge statusul** (doar `ord_flow_id` +
  `ord_completed_at` → NULL). Trigger-ul nu loghează nimic. **Cazul curat.**
- `status = 'plata'` ⇒ revenirea la `ordonantare` **nu e în matricea de tranziții**
  (`plata → completed|cancelled`). Poarta e în mod observare, deci trece, dar scrie
  `violation=TRUE` în `alop_status_log`. Acceptabil ca reparație conștientă, dar trebuie
  să știm dinainte și să notăm motivul.
- `status = 'completed'` ⇒ **oprește-te**. Înseamnă că plata a fost confirmată; acolo
  calea corectă e „noua lichidare" (ciclu nou), nu rescrierea istoricului.

---

## Q3 — Fluxul de semnare

```sql
SELECT id, status, completed, org_id, deleted_at,
       created_at, updated_at,
       data->>'initEmail'  AS initiator,
       jsonb_array_length(COALESCE(data->'signers','[]'::jsonb)) AS nr_semnatari
FROM flows
WHERE id = (SELECT flow_id FROM formulare_ord
            WHERE id = '22f74f35-cae6-4e60-8bc3-ba111f49ec86');
```

**Ce confirmăm:** că e într-adevăr `completed=true`, cu **un singur semnatar** egal cu
inițiatorul, și că nu e deja soft-deleted.

---

## Q4 — Semnatarii (confirmă anomalia de proces)

```sql
SELECT s->>'email' AS email, s->>'atribut' AS atribut, s->>'status' AS status
FROM flows f,
     LATERAL jsonb_array_elements(COALESCE(f.data->'signers','[]'::jsonb)) s
WHERE f.id = (SELECT flow_id FROM formulare_ord
              WHERE id = '22f74f35-cae6-4e60-8bc3-ba111f49ec86');
```

---

## Q5 — Există deja cicluri ORD arhivate pe acest ALOP?

```sql
SELECT id, ciclu_nr, ord_id, created_at
FROM alop_ord_cicluri
WHERE alop_id = (SELECT id FROM alop_instances
                 WHERE ord_id = '22f74f35-cae6-4e60-8bc3-ba111f49ec86')
ORDER BY ciclu_nr;
```

**De ce contează:** dacă există cicluri arhivate, ALOP-ul a mai trecut prin runde —
reparația nu trebuie să atingă istoricul lor.

---

## Q6 — Poarta ALOP: confirmă modul observare pe PRODUCȚIE

```sql
SELECT COUNT(*) AS violari_totale FROM alop_status_log WHERE violation = TRUE;

SELECT prosrc LIKE '%RAISE EXCEPTION%' AS e_blocanta
FROM pg_proc WHERE proname = 'alop_status_guard';
```

**Așteptat:** `e_blocanta = false` (în cod poarta e `RAISE WARNING` + `RETURN NEW`).
Dacă iese `true`, cineva a trecut-o pe blocantă manual și planul se schimbă.

---

## Q7 — Mai există și alte cazuri de același fel?

```sql
SELECT o.id, o.nr_ordonant_pl, o.status, a.status AS alop_status, o.updated_at
FROM formulare_ord o
JOIN flows f ON f.id = o.flow_id
JOIN alop_instances a ON a.ord_id = o.id
WHERE f.completed = TRUE
  AND f.deleted_at IS NULL
  AND jsonb_array_length(COALESCE(f.data->'signers','[]'::jsonb)) = 1
ORDER BY o.updated_at DESC;
```

**De ce:** dacă utilizatorii au mai construit fluxuri cu un singur semnatar, vrem să
știm acum, nu peste o lună. Influențează direct urgența lui **#113**.

---

## După recon

Cu rezultatele Q1–Q7 îți scriu reparația ca **script tranzacțional**, nu ca `UPDATE`-uri
răzlețe — pe modelul lui `tools/repair-alop-status.mjs` care există deja în repo:
dry-run implicit, o singură tranzacție, verificare înainte/după, eveniment de audit.

Elementele care trebuie să se miște **împreună** (altfel ALOP-ul rămâne agățat, exact
bug-ul reparat de #77):

| Obiect | Câmp | Valoare țintă |
|---|---|---|
| `flows` | `deleted_at` | `NOW()` (soft-delete; `flow_active` îl exclude) |
| `formulare_ord` | `status` | `'completed'` |
| `formulare_ord` | `aprobat` | `false` |
| `formulare_ord` | `flow_id` | `NULL` |
| `alop_instances` | `ord_flow_id` | `NULL` |
| `alop_instances` | `ord_completed_at` | `NULL` |
| `alop_instances` | `status` | `'ordonantare'` (**doar dacă** Q2 arată `plata`) |

⚠️ **Backup înainte de reparație** — Railway → Postgres → tab **Backups**.

---

## #113 — funcția suportată (după reparație)

Reparația manuală rezolvă cazul de azi; **#113 rezolvă clasa**. Schiță:

- `POST /flows/:flowId/admin-cancel` — anulare administrativă a unui flux **finalizat**,
  rezervată `admin`/`org_admin` (prin `actorCanAccessOrg`), cu **motiv obligatoriu**.
- Refolosește curățarea care există deja în `cancel` (`lifecycle.mjs:528` DF / `:553` ORD) —
  ⛔ fără a slăbi garda `already_completed` de pe ruta `cancel` normală, care rămâne pentru
  inițiator și fluxuri în derulare.
- Audit obligatoriu (`FLOW_ADMIN_CANCELLED` + `recordFormularAudit`), ca urma să rămână.
- Confirmare dublă în UI (fluxul poartă un document semnat QES).
- ⛔ Gardă de produs: dacă documentul a fost repartizat/descărcat de altcineva, avertisment
  explicit înainte de confirmare.
