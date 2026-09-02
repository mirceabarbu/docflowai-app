/**
 * #169 — testul de paritate pe cele patru căi de finalizare a unui flux.
 *
 * ⛔ NU modifică niciuna dintre cele patru rute. Testul FIXEAZĂ starea actuală a
 * sistemului, nu o uniformizează. Analiză statică pe sursă (tiparul din
 * admin-cancel-ui.test.mjs), nu import de rute — au efecte secundare la încărcare
 * (pornesc conexiuni DB, montează middleware etc.).
 *
 * De ce testul e așa — CONTRACTUL REAL al sistemului (nu un bug de reparat):
 *
 *  - `status` și `completed` sunt ORTOGONALE: `status` = starea de ciclu de viață
 *    a fluxului (`active` / `cancelled` / `refused` / `review_requested`),
 *    `completed` = finalizarea semnării. Sunt două axe diferite.
 *  - Măsurat pe producție la 02.09.2026: 2102 fluxuri cu `completed=true`,
 *    ZERO cu `status='completed'` ⇒ `signing.mjs` (local-upload) e EXCEPȚIA
 *    istorică, NU norma sistemului.
 *  - De aceea fiecare predicat din sistem care verifică "documentul e aprobat/
 *    finalizat" testează `OR (completed)::boolean` — nu e o compensare
 *    accidentală pentru un bug, e definiția însăși a „finalizat" în acest sistem
 *    (vezi `df-aprobat-sql.mjs`, `flow-provenance.mjs`).
 *  - A ADĂUGA `status='completed'` pe celelalte trei căi (cloud-signing ×2,
 *    bulk-signing) ar introduce o valoare pe care NICIUN rând din producție n-a
 *    purtat-o vreodată și ar rupe contorul `active` din `/admin/flows/stats`,
 *    care exclude fluxurile printr-o listă explicită de valori de status.
 *
 * Dacă testul ăsta cade la prima rulare pe cod neschimbat, ancorele din prompt nu
 * se potrivesc cu codul curent — NU ajusta codul ca să treacă testul, oprește-te
 * și raportează divergența.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dir = dirname(fileURLToPath(import.meta.url));
const readServer = (rel) => readFileSync(join(__dir, '../../', rel), 'utf8');

const signingSrc = readServer('routes/flows/signing.mjs');
const cloudSigningSrc = readServer('routes/flows/cloud-signing.mjs');
const bulkSigningSrc = readServer('routes/flows/bulk-signing.mjs');

// Un bloc „de finalizare" = un `if (allDone)` urmat, în cel mult 400 caractere, de
// un `data.events.push({ ..., type: 'FLOW_COMPLETED', ... })`. Exclude deliberat
// blocurile care doar CITESC `allDone` (idempotent-return, notificări async) sau
// care scriu `eventType: 'FLOW_COMPLETED'` prin `writeAuditEvent` (acela e AUDIT,
// nu blocul care setează starea de finalizare pe `data`).
const FINALIZARE_BLOCK_RE = /if\s*\(allDone\)[\s\S]{0,400}?type:\s*'FLOW_COMPLETED'/g;

function extractFinalizareBlocks(src) {
  return [...src.matchAll(FINALIZARE_BLOCK_RE)].map((m) => m[0]);
}

describe('#169 — paritatea celor patru căi de finalizare a fluxului', () => {
  it('găsește exact un bloc de finalizare în signing.mjs (local-upload)', () => {
    expect(extractFinalizareBlocks(signingSrc)).toHaveLength(1);
  });

  it('găsește exact două blocuri de finalizare în cloud-signing.mjs (sts-poll + cloud-callback)', () => {
    expect(extractFinalizareBlocks(cloudSigningSrc)).toHaveLength(2);
  });

  it('găsește exact un bloc de finalizare în bulk-signing.mjs', () => {
    expect(extractFinalizareBlocks(bulkSigningSrc)).toHaveLength(1);
  });

  it('⭐ toate cele patru blocuri setează completed=true, completedAt și evenimentul FLOW_COMPLETED', () => {
    const toate = [
      ...extractFinalizareBlocks(signingSrc),
      ...extractFinalizareBlocks(cloudSigningSrc),
      ...extractFinalizareBlocks(bulkSigningSrc),
    ];
    expect(toate).toHaveLength(4);
    for (const bloc of toate) {
      expect(bloc).toMatch(/completed\s*=\s*true/);
      expect(bloc).toMatch(/completedAt\s*=/);
      expect(bloc).toContain(`type: 'FLOW_COMPLETED'`);
    }
  });

  it('⭐ EXACT UNA dintre cele patru căi scrie și status=\'completed\' — cea din signing.mjs', () => {
    const toate = [
      { sursa: 'signing.mjs', blocuri: extractFinalizareBlocks(signingSrc) },
      { sursa: 'cloud-signing.mjs', blocuri: extractFinalizareBlocks(cloudSigningSrc) },
      { sursa: 'bulk-signing.mjs', blocuri: extractFinalizareBlocks(bulkSigningSrc) },
    ];
    const STATUS_COMPLETED_RE = /status\s*=\s*'completed'/;
    const cuStatusCompleted = [];
    for (const { sursa, blocuri } of toate) {
      for (const bloc of blocuri) {
        if (STATUS_COMPLETED_RE.test(bloc)) cuStatusCompleted.push(sursa);
      }
    }
    expect(cuStatusCompleted).toHaveLength(1);
    expect(cuStatusCompleted[0]).toBe('signing.mjs');
  });
});
