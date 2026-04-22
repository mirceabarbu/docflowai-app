// server/services/verify/ibanValidator.mjs
// Validare IBAN mod-97 (offline) + decode bank code pentru România.
// Include TREZ (Trezoreria Statului) ca flag dedicat.

const RO_BANK_CODES = {
  TREZ: { name: 'Trezoreria Statului', type: 'treasury' },
  BTRL: { name: 'Banca Transilvania', type: 'commercial' },
  BRDE: { name: 'BRD - Groupe Société Générale', type: 'commercial' },
  RNCB: { name: 'Banca Comercială Română (BCR)', type: 'commercial' },
  RZBR: { name: 'Raiffeisen Bank', type: 'commercial' },
  INGB: { name: 'ING Bank', type: 'commercial' },
  OTPV: { name: 'OTP Bank', type: 'commercial' },
  BUCU: { name: 'Alpha Bank', type: 'commercial' },
  UGBI: { name: 'Garanti BBVA', type: 'commercial' },
  UNCR: { name: 'UniCredit Bank', type: 'commercial' },
  BREL: { name: 'Libra Internet Bank', type: 'commercial' },
  CECE: { name: 'CEC Bank', type: 'commercial' },
  CITI: { name: 'Citibank Europe', type: 'commercial' },
  CARP: { name: 'Credit Europe Bank', type: 'commercial' },
  WBAN: { name: 'Exim Banca Românească', type: 'commercial' },
  BCOR: { name: 'Salt Bank / BCR', type: 'commercial' },
  ETBK: { name: 'Banca Românească', type: 'commercial' },
  EGNA: { name: 'Intesa Sanpaolo Bank', type: 'commercial' },
  BFER: { name: 'First Bank', type: 'commercial' },
  PBKR: { name: 'ProCredit Bank', type: 'commercial' },
  MILB: { name: 'Vista Bank', type: 'commercial' },
  DAFB: { name: 'Banca Comercială Feroviara', type: 'commercial' },
  PIRB: { name: 'Piraeus Bank (exit)', type: 'commercial' },
};

function normalizeIban(raw) {
  if (!raw) return null;
  return String(raw).toUpperCase().replace(/\s+/g, '');
}

function checkMod97(iban) {
  const rearranged = iban.slice(4) + iban.slice(0, 4);
  let numeric = '';
  for (const ch of rearranged) {
    if (/[0-9]/.test(ch)) numeric += ch;
    else if (/[A-Z]/.test(ch)) numeric += (ch.charCodeAt(0) - 55).toString();
    else return false;
  }
  let remainder = 0;
  for (const digit of numeric) {
    remainder = (remainder * 10 + Number(digit)) % 97;
  }
  return remainder === 1;
}

export function verifyIban(rawIban) {
  const iban = normalizeIban(rawIban);
  if (!iban) return { ok: false, reason: 'iban_empty' };
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]+$/.test(iban)) return { ok: false, reason: 'iban_format_invalid' };
  const country = iban.slice(0, 2);
  if (country !== 'RO') {
    return {
      ok: true,
      data: { iban, valid: checkMod97(iban), country, bankCode: null, bankName: null, accountType: 'foreign', isTreasury: false },
    };
  }
  if (iban.length !== 24) return { ok: false, reason: 'iban_ro_length_invalid' };
  const valid = checkMod97(iban);
  const bankCode = iban.slice(4, 8);
  const bank = RO_BANK_CODES[bankCode];
  return {
    ok: true,
    data: {
      iban,
      valid,
      country: 'RO',
      bankCode,
      bankName: bank ? bank.name : 'Bancă necunoscută',
      accountType: bank ? bank.type : 'unknown',
      isTreasury: bankCode === 'TREZ',
    },
  };
}
