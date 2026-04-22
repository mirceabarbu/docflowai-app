// server/services/verify/coherence.mjs
// Engine warnings pentru verificare combinată CUI + IBAN + denumire.
// Niveluri: info (verde) | warning (galben) | error (roșu)

function normalizeName(s) {
  if (!s) return '';
  return String(s).toUpperCase()
    .replace(/Ş/g, 'S').replace(/Ș/g, 'S').replace(/Ţ/g, 'T').replace(/Ț/g, 'T')
    .replace(/Ă/g, 'A').replace(/Â/g, 'A').replace(/Î/g, 'I')
    .replace(/\s+SRL$|\s+S\.R\.L\.?$|\s+SA$|\s+S\.A\.?$|\s+PFA$/g, '')
    .replace(/[^A-Z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function similarity(a, b) {
  a = normalizeName(a); b = normalizeName(b);
  if (!a || !b) return 0;
  if (a === b) return 1;
  if (a.includes(b) || b.includes(a)) return 0.9;
  const wa = new Set(a.split(' ').filter(w => w.length > 2));
  const wb = new Set(b.split(' ').filter(w => w.length > 2));
  if (!wa.size || !wb.size) return 0;
  let inter = 0;
  for (const w of wa) if (wb.has(w)) inter++;
  const union = wa.size + wb.size - inter;
  return union ? inter / union : 0;
}

export function analyzeCoherence({ companyData, ibanData, declaredName }) {
  const warnings = [];

  if (!companyData) {
    warnings.push({ code: 'CUI_NOT_FOUND', level: 'error',
      message: 'CUI-ul nu a fost găsit în baza ANAF.' });
  } else {
    // CRITIC: firmă radiată = nu mai există legal. Plata = fraudă bugetară.
    if (companyData.radiated) {
      warnings.push({ code: 'COMPANY_RADIATED', level: 'error',
        message: `⛔ ENTITATE RADIATĂ${companyData.liquidationDate ? ' la ' + companyData.liquidationDate : ''}. Firma nu mai există legal. NU efectuați plăți către această entitate.` });
    } else if (companyData.inactive) {
      warnings.push({ code: 'COMPANY_INACTIVE', level: 'error',
        message: `Entitatea este marcată INACTIVĂ la ANAF${companyData.inactiveDate ? ' din ' + companyData.inactiveDate : ''}${companyData.reactivationDate ? ' (reactivată ' + companyData.reactivationDate + ')' : ''}.` });
    }

    // TVA expirat — firma nu mai e plătitor TVA dar pe factură apare TVA
    if (companyData.vatEndDate && !companyData.vat) {
      warnings.push({ code: 'VAT_CANCELLED', level: 'warning',
        message: `Înregistrarea TVA a fost anulată${companyData.vatEndDate ? ' la ' + companyData.vatEndDate : ''}${companyData.vatCancelReason ? ' — ' + companyData.vatCancelReason : ''}. Facturile emise după această dată NU trebuie să conțină TVA.` });
    }
    if (declaredName && companyData.name) {
      const sim = similarity(declaredName, companyData.name);
      if (sim >= 0.8) {
        warnings.push({ code: 'COMPANY_NAME_MATCH', level: 'info',
          message: 'Denumirea introdusă corespunde cu datele ANAF.' });
      } else if (sim >= 0.5) {
        warnings.push({ code: 'COMPANY_NAME_PARTIAL', level: 'warning',
          message: `Denumirea introdusă diferă parțial de datele ANAF: "${companyData.name}".` });
      } else {
        warnings.push({ code: 'COMPANY_NAME_MISMATCH', level: 'warning',
          message: `Denumirea introdusă NU corespunde cu datele ANAF: "${companyData.name}".` });
      }
    }
    if (companyData.vatCollected) {
      warnings.push({ code: 'VAT_COLLECTED', level: 'info',
        message: 'Entitate cu TVA la încasare — atenție la momentul deducerii.' });
    }
  }

  if (ibanData && ibanData.valid === false) {
    warnings.push({ code: 'IBAN_INVALID', level: 'error',
      message: 'IBAN-ul are format invalid (check digit mod-97 failed).' });
  }

  if (ibanData && ibanData.isTreasury && companyData) {
    const priv = ['SRL', 'SA', 'PFA', 'PF_other'].includes(companyData.entityType);
    if (priv) {
      warnings.push({ code: 'TREASURY_PRIVATE_MISMATCH', level: 'warning',
        message: `IBAN indică Trezoreria Statului, dar entitatea pare privată (${companyData.entityType}). Verifică dacă este cont corect.` });
    } else if (companyData.entityType === 'public') {
      warnings.push({ code: 'TREASURY_PUBLIC_OK', level: 'info',
        message: 'Cont de trezorerie utilizat pentru instituție publică — corect.' });
    }
  }

  if (ibanData && !ibanData.isTreasury && companyData && companyData.entityType === 'public') {
    warnings.push({ code: 'COMMERCIAL_BANK_PUBLIC_ENTITY', level: 'warning',
      message: 'Cont de bancă comercială pentru instituție publică — cazul obișnuit este trezorerie. Verifică.' });
  }

  return warnings;
}
