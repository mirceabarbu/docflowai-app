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
 * Normalizează numărul de telefon la formatul internațional fără +
 * Ex: "0712345678" → "40712345678", "+40712345678" → "40712345678"
 */
function normalizePhone(phone) {
  if (!phone) return null;
  let p = String(phone).replace(/\s+/g, "").replace(/-/g, "");
  if (p.startsWith("+")) p = p.slice(1);
  if (p.startsWith("0")) p = "40" + p.slice(1); // România implicit
  return p;
}

/**
 * Trimite un mesaj WhatsApp folosind un template aprobat de Meta.
 * @param {string} to - Numărul de telefon al destinatarului
 * @param {string} templateName - Numele template-ului aprobat
 * @param {string[]} components - Variabilele template-ului (în ordine)
 */
async function sendWhatsAppTemplate(to, templateName, components = []) {
  if (!isWhatsAppConfigured()) {
    console.warn("⚠️ WhatsApp nu e configurat (WA_PHONE_NUMBER_ID / WA_ACCESS_TOKEN lipsesc)");
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
      console.error(`❌ WhatsApp API error (${phone}):`, JSON.stringify(data));
      return { ok: false, error: data };
    }
    console.log(`📱 WhatsApp trimis la +${phone} (template: ${templateName})`);
    return { ok: true, data };
  } catch(e) {
    console.error(`❌ WhatsApp fetch error (${phone}):`, e.message);
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
