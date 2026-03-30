const baseUrl = () => (process.env.SIGNING_SERVICE_URL || '').replace(/\/+$/, '');

function ensureSigningService() {
  const value = baseUrl();
  if (!value) throw new Error('SIGNING_SERVICE_URL is not configured');
  return value;
}

async function postJson(path, body) {
  const res = await fetch(`${ensureSigningService()}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    throw new Error(`Invalid JSON from signing service (${path}): ${text}`);
  }

  if (!res.ok) {
    throw new Error(`Signing service error ${res.status} on ${path}: ${JSON.stringify(json)}`);
  }

  return json;
}

export function hasJavaSigningService() {
  return !!baseUrl();
}

export async function javaPreparePades({
  pdfBase64,
  fieldName,
  signerName,
  signerRole,
  reason,
  location,
  contactInfo,
  page = 1,
  x = 100,
  y = 100,
  width = 180,
  height = 50,
  useSignedAttributes = true,
  subFilter = 'ETSI.CAdES.detached',
}) {
  return postJson('/api/pades/prepare', {
    pdfBase64,
    fieldName,
    signerName,
    signerRole,
    reason,
    location,
    contactInfo,
    page,
    x,
    y,
    width,
    height,
    useSignedAttributes,
    subFilter,
  });
}

export async function javaFinalizePades({
  preparedPdfBase64,
  fieldName,
  signByteBase64,
  certificatePem,
  certificateChainPem = [],
  useSignedAttributes = true,
  subFilter = 'ETSI.CAdES.detached',
}) {
  return postJson('/api/pades/finalize', {
    preparedPdfBase64,
    fieldName,
    signByteBase64,
    certificatePem,
    certificateChainPem,
    useSignedAttributes,
    subFilter,
  });
}
