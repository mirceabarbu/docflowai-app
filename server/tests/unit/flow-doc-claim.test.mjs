import { describe, it, expect } from 'vitest';
import { DOC_KINDS, documenteRevendicate, revendicaFormular } from '../../services/flow-doc-claim.mjs';

describe('flow-doc-claim', () => {
  it('data cu meta.dfId ⇒ un element, formType df, docId string', () => {
    const out = documenteRevendicate({ meta: { dfId: 'df-1' } });
    expect(out).toHaveLength(1);
    expect(out[0].formType).toBe('df');
    expect(out[0].docId).toBe('df-1');
  });

  it('data cu meta.ordId ⇒ un element, formType ord', () => {
    const out = documenteRevendicate({ meta: { ordId: 'ord-1' } });
    expect(out).toHaveLength(1);
    expect(out[0].formType).toBe('ord');
    expect(out[0].docId).toBe('ord-1');
  });

  it('data cu AMBELE ⇒ două elemente, în ordinea DF apoi ORD', () => {
    const out = documenteRevendicate({ meta: { dfId: 'df-1', ordId: 'ord-1' } });
    expect(out).toHaveLength(2);
    expect(out[0].formType).toBe('df');
    expect(out[1].formType).toBe('ord');
  });

  it('fără meta / meta:null / data:null / data:undefined ⇒ [] fără eroare', () => {
    expect(documenteRevendicate({})).toEqual([]);
    expect(documenteRevendicate({ meta: null })).toEqual([]);
    expect(documenteRevendicate(null)).toEqual([]);
    expect(documenteRevendicate(undefined)).toEqual([]);
  });

  it('meta.dfId gol/spații/null ⇒ []', () => {
    expect(documenteRevendicate({ meta: { dfId: '' } })).toEqual([]);
    expect(documenteRevendicate({ meta: { dfId: '   ' } })).toEqual([]);
    expect(documenteRevendicate({ meta: { dfId: null } })).toEqual([]);
  });

  it('meta.dfId numeric ⇒ docId string', () => {
    const out = documenteRevendicate({ meta: { dfId: 42 } });
    expect(out).toHaveLength(1);
    expect(out[0].docId).toBe('42');
    expect(typeof out[0].docId).toBe('string');
  });

  it('meta cu chei străine ⇒ ignorate', () => {
    expect(documenteRevendicate({ meta: { alopId: 'x', foo: 'y' } })).toEqual([]);
  });

  it('DOC_KINDS e înghețat', () => {
    expect(Object.isFrozen(DOC_KINDS)).toBe(true);
    expect(() => {
      'use strict';
      DOC_KINDS.push({});
    }).toThrow();
  });

  it('revendicaFormular reflectă lista', () => {
    expect(revendicaFormular({ meta: { dfId: 'df-1' } })).toBe(true);
    expect(revendicaFormular({})).toBe(false);
  });
});
