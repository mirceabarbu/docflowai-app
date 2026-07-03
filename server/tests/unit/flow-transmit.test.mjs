/**
 * Unit — normalizeRecipients (logică PURĂ, fără DB).
 * Validare/curățare a configurației de destinatari pentru transmiterea internă.
 */
import { describe, it, expect } from 'vitest';
import { normalizeRecipients, alreadyHasAccessEmails } from '../../services/flow-transmit.mjs';

describe('normalizeRecipients', () => {
  it('acceptă user (id numeric) și comp (string) valide', () => {
    const out = normalizeRecipients([
      { type: 'user', value: 7 },
      { type: 'comp', value: 'Contabilitate' },
    ]);
    expect(out).toEqual([
      { type: 'user', value: 7, rezolutie: null },
      { type: 'comp', value: 'Contabilitate', rezolutie: null },
    ]);
  });

  it('respinge intrări invalide: non-array, non-obiect, type necunoscut', () => {
    expect(normalizeRecipients(null)).toEqual([]);
    expect(normalizeRecipients('x')).toEqual([]);
    expect(normalizeRecipients([null, 5, { type: 'x', value: 1 }])).toEqual([]);
  });

  it('respinge user cu value gol/negativ/ne-întreg', () => {
    expect(normalizeRecipients([{ type: 'user', value: 0 }])).toEqual([]);
    expect(normalizeRecipients([{ type: 'user', value: -3 }])).toEqual([]);
    expect(normalizeRecipients([{ type: 'user', value: 1.5 }])).toEqual([]);
    expect(normalizeRecipients([{ type: 'user', value: 'abc' }])).toEqual([]);
  });

  it('respinge comp cu value gol/whitespace', () => {
    expect(normalizeRecipients([{ type: 'comp', value: '' }])).toEqual([]);
    expect(normalizeRecipients([{ type: 'comp', value: '   ' }])).toEqual([]);
  });

  it('trimuiește value pentru comp', () => {
    const out = normalizeRecipients([{ type: 'comp', value: '  Juridic  ' }]);
    expect(out).toEqual([{ type: 'comp', value: 'Juridic', rezolutie: null }]);
  });

  it('deduplică pe (type,value)', () => {
    const out = normalizeRecipients([
      { type: 'user', value: 7 },
      { type: 'user', value: 7 },
      { type: 'comp', value: 'X' },
      { type: 'comp', value: 'X' },
    ]);
    expect(out).toHaveLength(2);
  });

  it('taie rezoluția la 2000 caractere', () => {
    const long = 'a'.repeat(5000);
    const out = normalizeRecipients([{ type: 'user', value: 1, rezolutie: long }]);
    expect(out[0].rezolutie).toHaveLength(2000);
  });

  it('plafonează la 20 destinatari', () => {
    const raw = Array.from({ length: 30 }, (_, i) => ({ type: 'user', value: i + 1 }));
    const out = normalizeRecipients(raw);
    expect(out).toHaveLength(20);
  });
});

describe('alreadyHasAccessEmails', () => {
  it('include initEmail și emailurile semnatarilor, lowercase', () => {
    const out = alreadyHasAccessEmails({
      initEmail: 'Init@X.ro',
      signers: [{ email: 'Semnatar1@X.ro' }, { email: 'semnatar2@x.ro' }],
    });
    expect(out).toEqual(new Set(['init@x.ro', 'semnatar1@x.ro', 'semnatar2@x.ro']));
  });

  it('gol când lipsesc initEmail/signers', () => {
    expect(alreadyHasAccessEmails({})).toEqual(new Set());
    expect(alreadyHasAccessEmails(null)).toEqual(new Set());
    expect(alreadyHasAccessEmails({ signers: 'not-an-array' })).toEqual(new Set());
  });

  it('ignoră semnatari fără email sau cu email gol', () => {
    const out = alreadyHasAccessEmails({ signers: [{ email: '' }, { email: null }, {}] });
    expect(out).toEqual(new Set());
  });
});
