/**
 * #179 — analiză statică: cei patru consumatori chiar citesc sursa unică.
 *
 * ⚠️ Aserțiunile rulează pe sursa CU COMENTARIILE ELIMINATE (lecția de la #124i, #172,
 * #172b, #173, #175): altfel un „creat:'Creat'" scris într-un comentariu explicativ ar
 * trece drept hartă literală vie, sau invers, o mențiune într-un comentariu ar masca
 * absența codului real.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AUDIT_LABELS } from '../../services/audit-labels.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const cite = p => fs.readFileSync(path.join(ROOT, p), 'utf8');

/** Elimină comentariile /* *​/ și // — naiv, dar suficient: nu avem regex cu `//` în zonele testate. */
function faraComentarii(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map(l => l.replace(/(^|\s)\/\/.*$/, ''))
    .join('\n');
}

const CHEI = Object.keys(AUDIT_LABELS);
const SURSA_UNICA = 'window.DFAuditLabels';

describe('#179 — consumatorii vocabularului de audit', () => {
  it('(7) doc.js nu mai are harta literală și citește sursa unică', () => {
    const src = faraComentarii(cite('public/js/formular/doc.js'));
    expect(src).not.toContain("creat:'Creat'");
    expect(src).not.toContain("trimis_p2:'Trimis la Responsabil CAB'");
    expect(src).toContain(SURSA_UNICA);
    // rezerva pe numele brut rămâne
    expect(src).toContain('_AUDIT_LABELS[e.event_type]||e.event_type');
  });

  it('(8) hărțile de admin nu mai conțin niciuna dintre cele 11 chei ca literal', () => {
    for (const f of ['public/js/admin/audit.js', 'public/js/admin/activity.js']) {
      const src = faraComentarii(cite(f));
      const harta = src.slice(src.indexOf('Object.assign({'), src.indexOf(SURSA_UNICA));
      expect(harta.length, `${f}: harta nu a fost găsită`).toBeGreaterThan(100);
      for (const k of CHEI)
        expect(harta, `${f}: cheia ${k} a rămas literală în hartă`)
          .not.toMatch(new RegExp(`(^|[\\s{,])'?${k}'?\\s*:`, 'm'));
      expect(src, `${f}: nu pornește din sursa unică`).toContain(SURSA_UNICA);
    }
  });

  it('(9) formular.html și admin.html încarcă audit-labels.js ÎNAINTEA consumatorilor', () => {
    const cazuri = [
      ['public/formular.html', ['/js/formular/doc.js']],
      ['public/admin.html', ['/js/admin/audit.js', '/js/admin/activity.js']],
    ];
    for (const [html, consumatori] of cazuri) {
      const src = cite(html);
      const sursa = src.indexOf('/js/shared/audit-labels.js');
      expect(sursa, `${html}: scriptul partajat lipsește`).toBeGreaterThan(-1);
      for (const c of consumatori)
        expect(src.indexOf(c), `${html}: ${c} e încărcat înaintea sursei unice`).toBeGreaterThan(sursa);
    }
  });

  it('(9b) în formular.html scriptul partajat e FĂRĂ defer (doc.js are defer)', () => {
    const linie = cite('public/formular.html')
      .split('\n').find(l => l.includes('/js/shared/audit-labels.js'));
    expect(linie).not.toContain('defer');
  });

  it('(10) hărțile de culori/emoji din admin sunt NEATINSE', () => {
    // Contorul de chei, nu conținutul: prinde o ștergere colaterală fără a îngheța paleta.
    const nrChei = (src, marker) => {
      const i = src.indexOf(marker);
      expect(i, `${marker} lipsește`).toBeGreaterThan(-1);
      const bloc = src.slice(i, src.indexOf('};', i));
      return (bloc.match(/[A-Za-z0-9_.']+\s*:/g) || []).length;
    };
    const audit = cite('public/js/admin/audit.js');
    const activity = cite('public/js/admin/activity.js');
    expect(nrChei(audit, 'const badgeColor = {')).toBe(8);
    expect(nrChei(activity, 'const OP_COLORS = {')).toBe(33);
    expect(nrChei(activity, 'const OP_ICONS = {')).toBe(33);
    // canarul concret: culoarea anulării administrative n-a plecat odată cu eticheta
    expect(audit).toContain("'FLOW_ADMIN_CANCELLED': '#ef4444'");
    expect(activity).toContain("FLOW_ADMIN_CANCELLED: '#ff5050'");
  });

  it('(10b) serverul nu mai are a doua listă de etichete', () => {
    const src = faraComentarii(cite('server/routes/formulare/shared.mjs'));
    expect(src).not.toContain('FORMULAR_AUDIT_LABELS');
    expect(src).toContain("from '../../services/audit-labels.mjs'");
    // rezerva pentru un eveniment necunoscut rămâne cea dinainte
    expect(src).toContain("(t || '').replace(/_/g, ' ').toUpperCase()");
  });
});
