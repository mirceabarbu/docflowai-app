/**
 * DocFlowAI — WhatsApp Business API (Meta Graph API)
 *
 * Configurare variabile Railway:
 *   WA_PHONE_NUMBER_ID   = ID-ul numărului de telefon din Meta Business Manager
 *   WA_ACCESS_TOKEN      = Token permanent din Meta Business Manager
 *   WA_TEMPLATE_SIGN     = Numele template-ului aprobat pentru "document de semnat" (ex: "docflow_sign_request")
 *   WA_TEMPLATE_COMPLETE = Numele template-ului aprobat pentru "document finalizat" (ex: "docflow_completed")
 *   WA_TEMPLATE_REFUSED  = Numele template-ului aprobat pentru "document refuzat" (ex: "docflow_refused")
 *   WA_TEMPLATE_LANG     = Codul de limbă al template-ului (default: "ro" sau "en_US")
 *
 * Template-uri recomandate de creat în Meta Business Manager:
 *
 * 1. docflow_sign_request (UTILITY):
 *    "Bună {{1}}, ai un document de semnat în DocFlowAI: „{{2}}". Accesează aplicația pentru a semna."
 *    Variabile: [1]=nume_semnatar, [2]=nume_document
 *
 * 2. docflow_completed (UTILITY):
 *    "Documentul „{{1}}" a fost semnat de toți semnatarii. Îl poți descărca din DocFlowAI."
 *    Variabile: [1]=nume_document
 *
 * 3. docflow_refused (UTILITY):
 *    "Documentul „{{1}}" a fost refuzat de {{2}}. Motiv: {{3}}."
 *    Variabile: [1]=nume_document, [2]=nume_refuzant, [3]=motiv
 */

const WA_PHONE_NUMBER_ID = process.env.WA_PHONE_NUMBER_ID;
const WA_ACCESS_TOKEN    = process.env.WA_ACCESS_TOKEN;
const WA_TEMPLATE_LANG   = process.env.WA_TEMPLATE_LANG || "ro";

const WA_TEMPLATE_SIGN     = process.env.WA_TEMPLATE_SIGN     || "docflow_sign_request";
const WA_TEMPLATE_COMPLETE = process.env.WA_TEMPLATE_COMPLETE || "docflow_completed";
const WA_TEMPLATE_REFUSED  = process.env.WA_TEMPLATE_REFUSED  || "docflow_refused";

export function isWhatsAppConfigured() {
  return !!(WA_PHONE_NUMBER_ID && WA_ACCESS_TOKEN);
}

/**
 * Normalizează numărul de telefon la formatul internațional E.164 fără +
 * Suportă:
 *   "0712345678"       → "40712345678"  (România implicit dacă nu există prefix)
 *   "+40712345678"     → "40712345678"
 *   "40712345678"      → "40712345678"
 *   "+33612345678"     → "33612345678"  (Franța)
 *   "0033612345678"    → "33612345678"  (prefix IDD 00)
 *   "07911123456"      → "447911123456" (Marea Britanie cu 07...)
 * Returnează null dacă numărul nu poate fi normalizat (prea scurt/lung, caractere invalide).
 */
// Prefixe naționale cunoscute (format: prefixNational -> prefixInternational)
// Dacă numărul începe cu 0 și NU are deja prefix internațional, mapăm după lungime sau default RO.
// Aceasta este o euristică — pentru input ambiguu se recomandă format internațional explicit.
const NATIONAL_PREFIX_MAP = {
  // Folosit doar ca fallback când numărul începe cu 0 (fără prefix internațional)
  // și utilizatorul nu a specificat codul țării.
  // Default: România (40). Poate fi suprascris prin env WA_DEFAULT_COUNTRY_PREFIX.
};
const DEFAULT_COUNTRY_PREFIX = process.env.WA_DEFAULT_COUNTRY_PREFIX || "40";

function normalizePhone(phone) {
  if (!phone) return null;
  // Elimină spații, cratime, paranteze, puncte, slash
  let p = String(phone).replace(/[\s\-().\/]/g, "");
  if (!p) return null;

  // Format +XXXXXXXXXXX → elimină +
  if (p.startsWith("+")) p = p.slice(1);

  // Format 00XXXXXXXXXXX (IDD internațional) → elimină 00
  if (p.startsWith("00")) p = p.slice(2);

  // Format național (începe cu 0) → adaugă prefix internațional default
  if (p.startsWith("0")) p = DEFAULT_COUNTRY_PREFIX + p.slice(1);

  // Validare finală: doar cifre, lungime E.164 (7-15 cifre)
  if (!/^\d{7,15}$/.test(p)) {
    logger.warn(`⚠️ Număr telefon invalid: "${phone}" → "${p}"`);
    return null;
  }

  return p;
}

/**
 * Detectează formatul unui număr și returnează prefix internațional dacă e identificabil.
 * Folosit pentru feedback UI mai clar.
 */
export function detectPhoneFormat(phone) {
  if (!phone || !phone.trim()) return { format: "empty" };
  const p = phone.trim();
  if (p.startsWith("+")) return { format: "international", countryCode: p.slice(1).match(/^(\d{1,3})/)?.[1] || "?" };
  if (p.startsWith("00")) return { format: "international_idd" };
  if (p.startsWith("0")) return { format: "national", assumedCountry: DEFAULT_COUNTRY_PREFIX };
  return { format: "unknown" };
}

/**
 * Validează un număr de telefon pentru WhatsApp (înainte de salvare în DB).
 * Returnează { valid: true, normalized, display } sau { valid: false, error }.
 */
export function validatePhone(phone) {
  if (!phone || !phone.trim()) return { valid: true, normalized: "" }; // câmp opțional
  const normalized = normalizePhone(phone.trim());
  if (!normalized) {
    return {
      valid: false,
      error: "Număr de telefon invalid. Folosiți formatul internațional (+40712345678), IDD (0040712345678) sau național (0712345678 — se presupune România)."
    };
  }
  return { valid: true, normalized, display: "+" + normalized };
}

/**
 * Trimite un mesaj WhatsApp folosind un template aprobat de Meta.
 * @param {string} to - Numărul de telefon al destinatarului
 * @param {string} templateName - Numele template-ului aprobat
 * @param {string[]} components - Variabilele template-ului (în ordine)
 */
async function sendWhatsAppTemplate(to, templateName, components = []) {
  if (!isWhatsAppConfigured()) {
    logger.warn("⚠️ WhatsApp nu e configurat (WA_PHONE_NUMBER_ID / WA_ACCESS_TOKEN lipsesc)");
    return { ok: false, reason: "not_configured" };
  }

  const phone = normalizePhone(to);
  if (!phone) return { ok: false, reason: "invalid_phone" };

  const body = {
    messaging_product: "whatsapp",
    to: phone,
    type: "template",
    template: {
      name: templateName,
      language: { code: WA_TEMPLATE_LANG },
      components: components.length > 0 ? [{
        type: "body",
        parameters: components.map(text => ({ type: "text", text: String(text) }))
      }] : []
    }
  };

  try {
    const url = `https://graph.facebook.com/v19.0/${WA_PHONE_NUMBER_ID}/messages`;
    const resp = await fetch(url, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${WA_ACCESS_TOKEN}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(body)
    });

    const data = await resp.json();
    if (!resp.ok) {
      logger.error({ phone, data }, 'WhatsApp API error');
      return { ok: false, error: data };
    }
    logger.info(`📱 WhatsApp trimis la +${phone} (template: ${templateName})`);
    return { ok: true, data };
  } catch(e) {
    logger.error({ err: e, phone }, 'WhatsApp fetch error');
    return { ok: false, error: e.message };
  }
}

/**
 * Notificare "Document de semnat" — pentru semnatarul curent
 * Template: docflow_sign_request
 * Variabile: [1]=numeSemnatar, [2]=numeDocument
 */
export async function sendWaSignRequest({ phone, signerName, docName }) {
  return sendWhatsAppTemplate(phone, WA_TEMPLATE_SIGN, [signerName || "utilizator", docName]);
}

/**
 * Notificare "Document finalizat" — pentru inițiator
 * Template: docflow_completed
 * Variabile: [1]=numeDocument
 */
export async function sendWaCompleted({ phone, docName }) {
  return sendWhatsAppTemplate(phone, WA_TEMPLATE_COMPLETE, [docName]);
}

/**
 * Notificare "Document refuzat" — pentru inițiator + semnatarii anteriori
 * Template: docflow_refused
 * Variabile: [1]=numeDocument, [2]=numeRefuzant, [3]=motiv
 */
export async function sendWaRefused({ phone, docName, refuserName, reason }) {
  return sendWhatsAppTemplate(phone, WA_TEMPLATE_REFUSED, [docName, refuserName, reason]);
}

/**
 * Verifică dacă API-ul WhatsApp răspunde corect
 */
export async function verifyWhatsApp() {
  if (!isWhatsAppConfigured()) {
    return { ok: false, reason: "not_configured", hint: "Setează WA_PHONE_NUMBER_ID și WA_ACCESS_TOKEN în Railway Variables" };
  }
  try {
    const url = `https://graph.facebook.com/v19.0/${WA_PHONE_NUMBER_ID}?fields=display_phone_number,verified_name&access_token=${WA_ACCESS_TOKEN}`;
    const resp = await fetch(url);
    const data = await resp.json();
    if (data.error) return { ok: false, error: data.error };
    return { ok: true, phone: data.display_phone_number, name: data.verified_name };
  } catch(e) {
    return { ok: false, error: e.message };
  }
}
