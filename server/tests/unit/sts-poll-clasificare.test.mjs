// #125 — clasificarea răspunsurilor STS în pollSignatureResult.
//
// Incidentul: un corp gol / non-JSON făcea `resp.json()` să arunce
// `SyntaxError: Unexpected end of JSON input`; catch-ul returna `{ready:false}`
// FĂRĂ `error:true`, deci sts-poll raporta „waiting" la infinit, iar textul brut
// al excepției ajungea pe ecranul semnatarului.
//
// ⛔ ZERO apeluri reale către STS — `global.fetch` e stub-uit pe fiecare test.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { STSCloudProvider } from '../../signing/providers/STSCloudProvider.mjs';

const CLBK_WAIT = 0x400;

// Răspuns minimal în forma pe care o consumă pollSignatureResult (text-first).
function mockResp(body, status = 200) {
  return {
    status,
    ok: status >= 200 && status < 300,
    text: async () => body,
    json: async () => JSON.parse(body),
  };
}

describe('#125 — STSCloudProvider.pollSignatureResult: clasificare răspunsuri', () => {
  let provider;
  const realFetch = global.fetch;

  beforeEach(() => {
    provider = new STSCloudProvider();
  });
  afterEach(() => {
    global.fetch = realFetch;
    vi.restoreAllMocks();
  });

  it('corp gol ⇒ transient, fără „JSON" în mesaj', async () => {
    global.fetch = vi.fn(async () => mockResp('', 200));

    const r = await provider.pollSignatureResult('op-1', 'tok', 'https://sign.example');

    expect(r.ready).toBe(false);
    expect(r.transient).toBe(true);
    expect(r.error).toBeFalsy();
    expect(r.message).toBeTruthy();
    expect(r.message).not.toMatch(/JSON/i);
  });

  it('corp non-JSON (HTML 502) ⇒ transient, fără text tehnic scurs spre client', async () => {
    global.fetch = vi.fn(async () => mockResp('<html>502 Bad Gateway</html>', 502));

    const r = await provider.pollSignatureResult('op-2', 'tok', 'https://sign.example');

    expect(r.ready).toBe(false);
    expect(r.transient).toBe(true);
    expect(r.error).toBeFalsy();
    expect(r.message).not.toMatch(/JSON/i);
    expect(r.message).not.toMatch(/502|html/i);
  });

  it('excepție de rețea ⇒ transient, mesaj prietenos fără textul excepției', async () => {
    global.fetch = vi.fn(async () => { throw new Error('ECONNRESET la sign.stsisp.ro'); });

    const r = await provider.pollSignatureResult('op-3', 'tok', 'https://sign.example');

    expect(r.ready).toBe(false);
    expect(r.transient).toBe(true);
    expect(r.message).not.toMatch(/ECONNRESET/);
    expect(r.message).not.toMatch(/SyntaxError|TypeError/);
  });

  it('errorCode === CLBK_WAIT ⇒ waiting (comportamentul legitim NU s-a schimbat)', async () => {
    global.fetch = vi.fn(async () => mockResp(JSON.stringify({ errorCode: CLBK_WAIT })));

    const r = await provider.pollSignatureResult('op-4', 'tok', 'https://sign.example');

    expect(r.ready).toBe(false);
    expect(r.waiting).toBe(true);
    expect(r.transient).toBeFalsy();
    expect(r.error).toBeFalsy();
  });

  it('răspuns valid cu signByte ⇒ ready:true (ramura de succes intactă)', async () => {
    global.fetch = vi.fn(async () => mockResp(JSON.stringify({
      errorCode: 0, eligible: true,
      signList: [{ signByte: 'QkFTRTY0' }],
    })));

    const r = await provider.pollSignatureResult('op-5', 'tok', 'https://sign.example');

    expect(r.ready).toBe(true);
    expect(r.signByte).toBe('QkFTRTY0');
    expect(Array.isArray(r.signList)).toBe(true);
  });

  it('errorCode nenul ⇒ eroare PERMANENTĂ (error:true, nu transient)', async () => {
    global.fetch = vi.fn(async () => mockResp(JSON.stringify({
      errorCode: 42, errorMessage: 'Operațiune respinsă',
    })));

    const r = await provider.pollSignatureResult('op-6', 'tok', 'https://sign.example');

    expect(r.ready).toBe(false);
    expect(r.error).toBe(true);
    expect(r.transient).toBeFalsy();
  });
});
