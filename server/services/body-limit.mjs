// body-limit.mjs — decide dacă o cale primește parserul de 50 MB sau pe cel de 1 MB.
//
// ⚠️ POTRIVIREA E PE FRONTIERĂ DE SEGMENT, nu pe substring și nu pe prefix.
//  - substring (varianta veche) dădea 50 MB rutei PUBLICE /api/verify/signature,
//    fiindcă `/verify/signature`.includes('/sign') e adevărat;
//  - startsWith ar rupe /flows/:id/upload-signed-pdf și /reinitiate-review, adică
//    exact calea critică de semnare — s-ar întoarce 413 la semnare.
// Regula corectă: fragmentul apare în cale ȘI e urmat de '/' sau de sfârșitul căii.

export const LARGE_PDF_PATHS = [
  '/flows',                   // POST/PUT — creare/editare flux cu pdfB64
  '/reinitiate-review',       // POST — upload document revizuit după review
  '/upload-signed-pdf',       // POST — upload PDF semnat de semnatar
  '/signing-callback',        // POST — callback provider cloud signing
  '/sign',                    // POST — poate conține signedPdfB64
  '/detect-acroform-fields',  // POST — detectare câmpuri AcroForm/XFA din PDF
  '/formulare-oficiale',      // POST/PUT/attachments — RN/NF cu form_data JSONB extins + atașamente base64
  '/formulare-ord',           // PUT — ORD cu img2 base64 (captură 2 ~1-5MB)
  '/formulare-df',            // PUT — DF (paritate cu ORD, capturi posibile)
  '/formulare-atasamente',    // POST — upload fișiere generice (max 10MB raw body)
  '/formulare/generate',      // POST — PDF gen primește captureImageBase64 + _2
  '/registratura/intrari',    // POST atașament — PDF scanat base64 (cap 15MB pe buf)
];

export function needsLargeBody(path) {
  if (!path) return false;
  return LARGE_PDF_PATHS.some((fragment) => {
    const idx = path.indexOf(fragment);
    if (idx === -1) return false;
    const endIdx = idx + fragment.length;
    return endIdx === path.length || path[endIdx] === '/';
  });
}
