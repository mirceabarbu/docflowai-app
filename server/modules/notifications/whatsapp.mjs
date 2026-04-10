/**
 * server/modules/notifications/whatsapp.mjs — Meta Business API WhatsApp sender
 */

import { logger } from '../../middleware/logger.mjs';

const BASE_URL = 'https://graph.facebook.com/v18.0';

/**
 * sendWhatsApp — trimite mesaj WhatsApp via Meta Business API.
 * Niciodată nu aruncă eroare.
 *
 * @param {{ phone: string, templateName: string, params: string[] }} opts
 * @returns {Promise<boolean>}
 */
export async function sendWhatsApp({ phone, templateName, params = [] }) {
  const phoneId   = process.env.WA_PHONE_NUMBER_ID;
  const token     = process.env.WA_ACCESS_TOKEN;

  if (!phoneId || !token) {
    return false; // skip silențios
  }

  const normalizedPhone = _normalizePhone(phone);
  if (!normalizedPhone) {
    logger.warn({ phone }, 'sendWhatsApp: număr invalid, skip');
    return false;
  }

  try {
    const body = {
      messaging_product: 'whatsapp',
      to:                normalizedPhone,
      type:              'template',
      template: {
        name:      templateName,
        language:  { code: 'ro' },
        components: params.length > 0
          ? [{
              type:       'body',
              parameters: params.map(p => ({ type: 'text', text: String(p) })),
            }]
          : [],
      },
    };

    const resp = await fetch(`${BASE_URL}/${phoneId}/messages`, {
      method:  'POST',
      headers: {
        'Content-Type':  'application/json',
        'Authorization': `Bearer ${token}`,
      },
      body: JSON.stringify(body),
    });

    if (resp.ok) {
      logger.info({ phone: normalizedPhone, template: templateName }, 'WhatsApp sent');
      return true;
    }

    const data = await resp.json().catch(() => ({}));
    logger.warn({ phone, template: templateName, err: data }, 'sendWhatsApp: API error');
    return false;
  } catch (e) {
    logger.error({ err: e, phone }, 'sendWhatsApp: fetch error');
    return false;
  }
}

function _normalizePhone(phone) {
  if (!phone) return null;
  const digits = String(phone).replace(/\D/g, '');
  if (digits.length < 10) return null;
  // Adaugă prefix 40 pentru numere românești fără prefix internațional
  if (digits.startsWith('07') && digits.length === 10) {
    return `40${digits.slice(1)}`;
  }
  return digits;
}
