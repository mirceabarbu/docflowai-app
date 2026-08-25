/**
 * #145/E2 — semnătura ECDSA din CMS este DER (`SEQUENCE{INTEGER r, INTEGER s}`);
 * `webcrypto.subtle.verify` cere raw (`r||s`, fiecare pe EXACT dimensiunea
 * curbei). Fără conversie, verificarea întoarce `false` chiar și cu
 * certificatul corect — defectul ar fi părut nereparat.
 *
 * Cazul de la testul 10 (`r` mai scurt cu un octet) apare la ~1 din 256 de
 * semnături și producea eșecuri INTERMITENTE.
 */
import { describe, it, expect } from 'vitest';
import { ecdsaDerToRaw } from '../../verify.mjs';

/** Construiește un DER `SEQUENCE{INTEGER r, INTEGER s}` din doi Buffer bruți. */
function derSig(r, s) {
  const int = (v) => {
    let b = Buffer.from(v);
    while (b.length > 1 && b[0] === 0x00 && !(b[1] & 0x80)) b = b.slice(1); // minimal
    if (b[0] & 0x80) b = Buffer.concat([Buffer.from([0x00]), b]);           // bit de semn
    return Buffer.concat([Buffer.from([0x02, b.length]), b]);
  };
  const body = Buffer.concat([int(r), int(s)]);
  // lungime DER: formă scurtă sub 128, altfel formă lungă (cazul P-521)
  const hdr = body.length < 0x80
    ? Buffer.from([0x30, body.length])
    : Buffer.from([0x30, 0x81, body.length]);
  return Buffer.concat([hdr, body]);
}
const fill = (n, byte) => Buffer.alloc(n, byte);

describe('#145/E2 — ecdsaDerToRaw', () => {
  // 8
  it('DER cu r și s pe 32 de octeți ⇒ 64 de octeți raw', () => {
    const r = fill(32, 0x11), s = fill(32, 0x22);
    const out = ecdsaDerToRaw(derSig(r, s), 32);
    expect(out.length).toBe(64);
    expect(out.slice(0, 32).equals(r)).toBe(true);
    expect(out.slice(32).equals(s)).toBe(true);
  });

  // 9 ⭐ — INTEGER prefixat cu 0x00 (bit de semn) ⇒ zeroul se scoate
  it('⭐ DER cu INTEGER prefixat cu 0x00 (bit de semn) ⇒ tot 64, cu zeroul scos', () => {
    const r = Buffer.concat([Buffer.from([0xF0]), fill(31, 0xAB)]); // MSB=1 ⇒ DER pune 0x00
    const s = fill(32, 0x22);
    const der = derSig(r, s);
    expect(der.length).toBe(2 + (2 + 33) + (2 + 32)); // r codat pe 33 de octeți
    const out = ecdsaDerToRaw(der, 32);
    expect(out.length).toBe(64);
    expect(out.slice(0, 32).equals(r)).toBe(true);
    expect(out.slice(32).equals(s)).toBe(true);
  });

  // 10 ⭐ — r scurt (31 de octeți) ⇒ stânga-completat la 32
  it('⭐ DER cu r pe 31 de octeți ⇒ completat la stânga la 32', () => {
    const r31 = fill(31, 0x07);
    const s   = fill(32, 0x22);
    const out = ecdsaDerToRaw(derSig(r31, s), 32);
    expect(out.length).toBe(64);
    expect(out[0]).toBe(0x00);                       // zeroul de completare
    expect(out.slice(1, 32).equals(r31)).toBe(true);
    expect(out.slice(32).equals(s)).toBe(true);
  });

  it('r foarte scurt (1 octet) ⇒ tot 64, restul zerouri', () => {
    const out = ecdsaDerToRaw(derSig(Buffer.from([0x09]), fill(32, 0x22)), 32);
    expect(out.length).toBe(64);
    expect(out.slice(0, 31).equals(fill(31, 0x00))).toBe(true);
    expect(out[31]).toBe(0x09);
  });

  // 11
  it('intrare raw de 64 de octeți ⇒ neschimbată', () => {
    const raw = Buffer.concat([fill(32, 0xAA), fill(32, 0xBB)]);
    expect(ecdsaDerToRaw(raw, 32).equals(raw)).toBe(true);
  });

  // 12
  it('gunoi ⇒ întors neschimbat, fără excepție', () => {
    for (const junk of [
      Buffer.from([]),
      Buffer.from([0x01, 0x02, 0x03]),
      Buffer.from('nu sunt DER', 'utf8'),
      Buffer.from([0x30, 0x7f, 0x02, 0x01, 0x01]),   // lungime mincinoasă
      Buffer.from([0x30, 0x08, 0x03, 0x01, 0x01, 0x02, 0x01, 0x01, 0x00, 0x00]), // tag greșit
    ]) {
      expect(() => ecdsaDerToRaw(junk, 32)).not.toThrow();
      expect(ecdsaDerToRaw(junk, 32).equals(Buffer.from(junk))).toBe(true);
    }
  });

  // 13
  it('P-384 ⇒ 96 de octeți', () => {
    const out = ecdsaDerToRaw(derSig(fill(48, 0x33), fill(47, 0x44)), 48);
    expect(out.length).toBe(96);
    expect(out[48]).toBe(0x00);                       // s completat la stânga
  });

  it('P-521 ⇒ 132 de octeți', () => {
    expect(ecdsaDerToRaw(derSig(fill(66, 0x55), fill(66, 0x66)), 66).length).toBe(132);
  });

  it('fieldSize lipsă/invalid ⇒ intrare neschimbată, fără excepție', () => {
    const der = derSig(fill(32, 0x11), fill(32, 0x22));
    expect(ecdsaDerToRaw(der, 0).equals(der)).toBe(true);
    expect(ecdsaDerToRaw(der, undefined).equals(der)).toBe(true);
  });

  it('acceptă Uint8Array, nu doar Buffer', () => {
    const der = new Uint8Array(derSig(fill(32, 0x11), fill(32, 0x22)));
    expect(ecdsaDerToRaw(der, 32).length).toBe(64);
  });
});
