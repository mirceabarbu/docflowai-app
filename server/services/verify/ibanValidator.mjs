// server/services/verify/ibanValidator.mjs
// Validare IBAN mod-97 (offline) + decode bank code pentru România.
// Include TREZ (Trezoreria Statului) ca flag dedicat.

// Primele 2 cifre după TREZ din IBAN-ul Trezoreriei → județ (coduri SIRUTA).
// Ex: RO45TREZ0815069XXX004466 → iban.slice(8,10)='08' → Brașov → 'Trezoreria Brașov'.
const TREZ_COUNTY_CODES = {
  '01': 'Alba',           '02': 'Arad',           '03': 'Argeș',          '04': 'Bacău',
  '05': 'Bihor',          '06': 'Bistrița-Năsăud', '07': 'Botoșani',       '08': 'Brașov',
  '09': 'Brăila',         '10': 'Buzău',          '11': 'Caraș-Severin',  '12': 'Cluj',
  '13': 'Constanța',      '14': 'Covasna',        '15': 'Dâmbovița',      '16': 'Dolj',
  '17': 'Galați',         '18': 'Gorj',           '19': 'Harghita',       '20': 'Hunedoara',
  '21': 'Ialomița',       '22': 'Iași',           '23': 'Ilfov',          '24': 'Maramureș',
  '25': 'Mehedinți',      '26': 'Mureș',          '27': 'Neamț',          '28': 'Olt',
  '29': 'Prahova',        '30': 'Satu Mare',      '31': 'Sălaj',          '32': 'Sibiu',
  '33': 'Suceava',        '34': 'Teleorman',      '35': 'Timiș',          '36': 'Tulcea',
  '37': 'Vaslui',         '38': 'Vâlcea',         '39': 'Vrancea',
  '40': 'București S1',   '41': 'București S2',   '42': 'București S3',
  '43': 'București S4',   '44': 'București S5',   '45': 'București S6',
  '46': 'București (DTMB)', '47': 'Călărași',     '51': 'Giurgiu',        '52': 'Ilfov (ATCPMB)',
};

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
  const isTreasury = bankCode === 'TREZ';
  let treasuryCounty = null;
  let treasuryBranchName = null;
  if (isTreasury) {
    const countyCode = iban.slice(8, 10);
    treasuryCounty = TREZ_COUNTY_CODES[countyCode] || null;
    treasuryBranchName = treasuryCounty ? `Trezoreria ${treasuryCounty}` : 'Trezoreria Statului';
  }
  return {
    ok: true,
    data: {
      iban,
      valid,
      country: 'RO',
      bankCode,
      bankName: isTreasury ? treasuryBranchName : (bank ? bank.name : 'Bancă necunoscută'),
      accountType: bank ? bank.type : (isTreasury ? 'treasury' : 'unknown'),
      isTreasury,
      treasuryCounty,
    },
  };
}
