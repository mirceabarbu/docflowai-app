# OPME (F1129) Import — Ghid utilizator și referință tehnică

## Ce este F1129 OPME

Formularul F1129 este un document electronic generat de Trezoreria Statului (format XFA PDF) care conține lista ordinelor de plată (OP) procesate pentru o instituție publică. DocFlowAI importă aceste fișiere pentru a identifica automat plățile aferente ALOP-urilor active și a le confirma fără intervenție manuală.

## Cum funcționează importul

```
┌──────────────────────────────────────────────────────────┐
│ Utilizator (P2 sau admin)                                │
│   ↓ Upload PDF F1129                                     │
│   POST /api/opme/import (multipart/form-data)            │
└──────────────┬───────────────────────────────────────────┘
               ↓
┌──────────────────────────────────────────────────────────┐
│ Parser (opme-parser.mjs)                                 │
│   ↓ Extrage XFA XML → header + N linii                   │
│   ↓ Validare: template check, câmpuri obligatorii        │
└──────────────┬───────────────────────────────────────────┘
               ↓
┌──────────────────────────────────────────────────────────┐
│ Persistare                                               │
│   INSERT opme_imports (header)                           │
│   INSERT opme_lines (N rânduri, UNNEST batch)            │
│   Idempotent prin SHA-256 file_hash per org              │
└──────────────┬───────────────────────────────────────────┘
               ↓
┌──────────────────────────────────────────────────────────┐
│ Matcher (opme-matcher.mjs) — sincron, tranzacție separată│
│   Per linie:                                             │
│     1. Caută ALOP candidat (triplet match + status)      │
│     2. Grupează pe (alop, triplet)                       │
│     3. Compară sume: exact → auto-confirm                │
│                       parțial → marchează partial        │
│                       0 candidați → unmatched            │
│                       >1 candidați → ambiguous           │
└──────────────────────────────────────────────────────────┘
```

## Reguli de matching

Matching-ul se face pe baza **tripletului**:
- `cif_beneficiar` — din header-ul F1129 (câmpul „cif platitor" sau per linie)
- `cod_angajament` — per rând în F1129
- `indicator_angajament` — per rând în F1129

Un ALOP este candidat dacă:
1. `status = 'plata'` și `plata_confirmed_at IS NULL` și `cancelled_at IS NULL`
2. ORD-ul asociat are `cif_beneficiar` identic (TRIM)
3. ORD-ul are cel puțin un rând cu `cod_angajament` + `indicator_angajament` identice

## Cazuri de match

| Status | Condiție | Efect |
|--------|----------|-------|
| **auto** (matched) | 1 candidat, suma OPME = suma ORD (±0.01 RON) | ALOP confirmat automat (`plata_source='opme_auto'`) |
| **partial** | 1 candidat, suma OPME < suma ORD | Linii marcate, ALOP rămâne în `plata` |
| **overpay** | 1 candidat, suma OPME > suma ORD | Linii marcate, ALOP rămâne în `plata` |
| **ambiguous** | >1 candidați cu același triplet | Linii marcate, necesită rezolvare manuală |
| **unmatched** | 0 candidați | Linia rămâne fără match |

## Integrare cu state machine-ul ALOP

```
ALOP status:  draft → angajare → lichidare → ordonantare → plata → completed
                                                             ↑            ↑
                                                        OPME match   auto-confirm
```

- **Auto-confirm la upload**: Dacă ALOP-ul e deja în `plata`, linia OPME îl confirmă instant.
- **Absorbție retro** (`tryAutoConfirmAlop`): Dacă ALOP-ul ajunge în `plata` după upload-ul OPME, hook-ul de tranziție verifică și absoarbe liniile pending.
- **Noua lichidare**: La `POST /api/alop/:id/noua-lichidare`, ciclul curent se arhivează în `alop_ord_cicluri`, iar `matched_ciclu_id` se populează pe liniile OPME atașate.

## Audit

- **audit_log**: Fiecare auto-confirm inserează un rând cu `event_type = 'plata_auto_opme'` și payload JSON (alop_id, opme_line_ids, suma, triplet).
- **Drawer raport**: Vizibil din UI (`opme-report-drawer.js`) — statistici + tabel linii + status per linie.
- **Export CSV**: `GET /api/opme/imports/:id/export.csv` — fișier descărcabil cu BOM UTF-8, virgulă decimală, compatibil Excel.
- **ALOP card**: În secțiunea Cicluri, badge-ul „Auto" indică confirmare OPME. Textul „Plată confirmată automat din OPME nr.X / data" apare în cardul Plată.

## Rute API

| Metodă | Path | Rol | Descriere |
|--------|------|-----|-----------|
| POST | `/api/opme/import` | responsabil_cab/admin | Upload PDF F1129, auto-match |
| GET | `/api/opme/imports` | orice auth | Listă import-uri org (paginat) |
| GET | `/api/opme/imports/:id` | orice auth | Detaliu import + linii |
| GET | `/api/opme/imports/:id/export.csv` | responsabil_cab/admin | Export CSV pentru audit |
| POST | `/api/opme/imports/:id/rematch` | responsabil_cab/admin | Re-rulează matcher pe un import |
| POST | `/api/opme/rematch-all` | admin | Re-rulează matcher pe toate importurile org |
| GET | `/api/opme/lines/by-alop/:alopId` | orice auth | Linii OPME atașate unui ALOP |
| GET | `/api/me/can-import-opme` | orice auth | Gating server-driven (`{ can: boolean }`) |

### Cine poate importa OPME

- **admin (super)** — acces necondiționat (toate org)
- **org_admin** — pe org propriu
- **Responsabil CAB efectiv** — orice utilizator care e (sau a fost) `assigned_to` pe cel puțin un DF (`formulare_df`) sau ORD (`formulare_ord`) din org-ul său
- **P2-comp** — orice utilizator din ACELAȘI compartiment cu un Responsabil CAB efectiv din org-ul său

Frontend-ul verifică permisiunea via `GET /api/me/can-import-opme` (cache 30s).

## Schema tabel

**opme_imports**: `id, org_id, uploaded_by, file_hash (UNIQUE per org), nr_document, data_op, an_r, luna_r, cif_platitor, den_platitor, suma_totala, nr_inregistrari, raw_meta, created_at`

**opme_lines**: `id, opme_import_id, org_id, row_index, nr_op, cod_angajament, indicator_angajament, cif_beneficiar, den_beneficiar, iban_beneficiar, suma_op, explicatii, match_status, match_notes, matched_alop_id, matched_ciclu_id, matched_at`

## Troubleshooting

### Liniile rămân „unmatched" deși ALOP-ul există
- Verifică `cif_beneficiar` — trebuie să fie identic (cu TRIM) între F1129 și ORD-ul atașat ALOP-ului.
- Verifică `cod_angajament` + `indicator_angajament` — trebuie să existe ca rând în `formulare_ord.rows` JSONB.
- ALOP-ul trebuie să fie în `status = 'plata'` cu `plata_confirmed_at IS NULL`.

### „Ambiguous: 2 ALOP-uri active cu același beneficiar + angajament"
- Două ALOP-uri în `plata` au ORD-uri cu aceleași triplete. Soluții:
  1. Confirmă manual unul dintre ele → rămâne un singur candidat → re-rulează matching.
  2. Pornește „nouă lichidare" pe unul → îl scoate din `plata` → re-rulează.

### „Partial: sumă mai mică decât așteptat"
- Suma OP-urilor din F1129 nu acoperă integral suma din ORD. Posibile cauze:
  - Lipsesc linii din F1129 (Trezoreria nu a procesat toate OP-urile).
  - Eroare în suma din ORD original.
- Soluție: re-uploadează când apar noi F1129 cu OP-uri suplimentare → sumele se agregă.

### Re-rulare matching
- **Per import**: `POST /api/opme/imports/:id/rematch` — resetează liniile non-confirmate și re-rulează.
- **Per org**: `POST /api/opme/rematch-all` (admin only, rate-limited 1/oră) — procesează toate importurile cu linii nerezolvate.

## Cum se adaugă suport pentru un format de fișier nou trezorerie

1. Creează un parser nou în `server/services/` (ex: `opme-parser-f1130.mjs`) care respectă interfața: `async function parse(buffer) → { header, lines, raw_meta }`.
2. Header-ul trebuie să conțină cel puțin: `nr_document, data_op, cif_platitor`.
3. Fiecare linie trebuie să aibă: `cod_angajament, indicator_angajament, cif_beneficiar, suma_op, nr_op`.
4. Înregistrează parser-ul în ruta de import (`server/routes/opme.mjs`) — detecție automată pe baza conținutului XFA sau a câmpurilor.
5. Matcher-ul (`opme-matcher.mjs`) funcționează identic indiferent de sursa liniilor.
