/**
 * server/db/seeds/forms.mjs — Seeds ALOP-2024 standard form template (idempotent).
 *
 * ALOP = Angajare, Lichidare, Ordonanțare și Plată
 * Standard template for Romanian public administration financial approvals.
 */

import { pool }   from '../index.mjs';
import { logger } from '../../middleware/logger.mjs';

const ALOP_CODE = 'ALOP-2024';

// ── ALOP-2024 schema ──────────────────────────────────────────────────────────

const ALOP_SCHEMA = {
  fields: [
    // Section A — Angajare (Commitment)
    { name: 'sectionA.institutie',         label: 'Instituția/Ordonatorul de credite', type: 'text',   required: true,  maxLength: 200, section: 'A' },
    { name: 'sectionA.compartiment',       label: 'Compartimentul',                   type: 'text',   required: true,  maxLength: 200, section: 'A' },
    { name: 'sectionA.programBugetar',     label: 'Programul bugetar',                type: 'text',   required: false, maxLength: 200, section: 'A' },
    { name: 'sectionA.capitol',            label: 'Capitol bugetar',                  type: 'text',   required: true,  maxLength: 50,  section: 'A' },
    { name: 'sectionA.articol',            label: 'Articol bugetar',                  type: 'text',   required: true,  maxLength: 50,  section: 'A' },
    { name: 'sectionA.valoareAngajata',    label: 'Valoarea angajată (RON)',           type: 'number', required: true,  section: 'A' },
    { name: 'sectionA.descriere',          label: 'Descrierea cheltuielii',            type: 'text',   required: true,  maxLength: 500, section: 'A' },
    { name: 'sectionA.dataAngajare',       label: 'Data angajării',                   type: 'date',   required: true,  section: 'A' },
    { name: 'sectionA.numarAngajament',    label: 'Nr. document angajament',           type: 'text',   required: false, maxLength: 50,  section: 'A' },

    // Section B — Lichidare (Liquidation/Verification)
    { name: 'sectionB.furnizor',           label: 'Furnizor/Prestator',                type: 'text',   required: true,  maxLength: 200, section: 'B' },
    { name: 'sectionB.cuiFurnizor',        label: 'CUI Furnizor',                      type: 'text',   required: true,  maxLength: 20,  section: 'B' },
    { name: 'sectionB.numarFactura',       label: 'Nr. factură/document justificativ', type: 'text',   required: true,  maxLength: 50,  section: 'B' },
    { name: 'sectionB.dataFactura',        label: 'Data factură',                      type: 'date',   required: true,  section: 'B' },
    { name: 'sectionB.valoareFactura',     label: 'Valoarea facturată (RON)',           type: 'number', required: true,  section: 'B' },
    { name: 'sectionB.tva',               label: 'TVA inclus (RON)',                   type: 'number', required: false, section: 'B' },
    { name: 'sectionB.serviciiConforme',  label: 'Servicii/bunuri conforme cu contractul', type: 'boolean', required: true, section: 'B' },
    { name: 'sectionB.observatii',        label: 'Observații lichidare',               type: 'text',   required: false, maxLength: 500, section: 'B' },

    // Section C — Ordonanțare (Authorization)
    { name: 'sectionC.creditDisponibil',   label: 'Credit bugetar disponibil (RON)',   type: 'number', required: true,  section: 'C' },
    { name: 'sectionC.valoareOrdonantata', label: 'Valoarea ordonanțată (RON)',        type: 'number', required: true,  section: 'C' },
    { name: 'sectionC.contPlata',          label: 'Contul de plată IBAN',              type: 'text',   required: true,  maxLength: 34,  section: 'C' },
    { name: 'sectionC.bancaFurnizor',      label: 'Banca furnizorului',                type: 'text',   required: false, maxLength: 100, section: 'C' },
    { name: 'sectionC.dataScadenta',       label: 'Data scadentă',                     type: 'date',   required: false, section: 'C' },

    // Section D — Plată (Payment authorization)
    { name: 'sectionD.contTrezorerie',     label: 'Contul trezorerial de plată',       type: 'text',   required: false, maxLength: 50,  section: 'D' },
    { name: 'sectionD.numarOP',           label: 'Nr. ordin de plată',                type: 'text',   required: false, maxLength: 50,  section: 'D' },
    { name: 'sectionD.dataPlata',         label: 'Data plată',                        type: 'date',   required: false, section: 'D' },
    { name: 'sectionD.observatiiPlata',   label: 'Observații plată',                  type: 'text',   required: false, maxLength: 300, section: 'D' },

    // Section E — Metadata
    { name: 'meta.numarDosar',             label: 'Numărul dosarului',                 type: 'text',   required: false, maxLength: 50,  section: 'E' },
    { name: 'meta.anBugetar',             label: 'Anul bugetar',                      type: 'number', required: true,  section: 'E' },
    { name: 'meta.surseFinantare',         label: 'Surse de finanțare',                type: 'text',   required: false, maxLength: 100, section: 'E' },
  ],
};

const ALOP_PDF_MAPPING = {
  template: null,    // No AcroForm template — use programmatic generation
  fields:   {},
};

const ALOP_RULES = [
  // If services are not compliant, observations become required
  {
    id: 'require-obs-when-not-conforme',
    condition: { field: 'sectionB.serviciiConforme', operator: 'eq', value: false },
    action:    { type: 'require', field: 'sectionB.observatii' },
  },
  // Auto-set anBugetar from dataAngajare year if not provided
  // (left as documentation — set_value requires a literal, not a computed value)
  // Real year computation happens server-side in service.mjs
];

const ALOP_REQUIRED_SIGNERS = [
  { role: 'angajare',      label: 'Persoana autorizată să angajeze (ordonator credite sau delegat)',     required: true  },
  { role: 'lichidare',     label: 'Persoana care a efectuat lichidarea (verificarea documentelor)',      required: true  },
  { role: 'ordonantare',   label: 'Ordonatorul de credite (sau persoana delegată)',                      required: true  },
  { role: 'plata',         label: 'Conducătorul compartimentului financiar-contabil (pentru plată)',     required: true  },
];

const ALOP_REQUIRED_ATTACHMENTS = [
  { code: 'contract',     label: 'Contract/comandă/convenție',              required: true  },
  { code: 'factura',      label: 'Factură fiscală/document justificativ',   required: true  },
  { code: 'pvr',          label: 'Proces-verbal de recepție/constatare',    required: false },
  { code: 'garantie',     label: 'Garanție de bună execuție (dacă aplicabil)', required: false },
];

// ── seedDefaultForms ──────────────────────────────────────────────────────────

export async function seedDefaultForms() {
  // Check if ALOP-2024 already exists
  const { rows: existing } = await pool.query(
    "SELECT id FROM form_templates WHERE code=$1 AND is_standard=TRUE LIMIT 1",
    [ALOP_CODE]
  );
  if (existing.length > 0) {
    logger.debug({ code: ALOP_CODE }, 'ALOP-2024 template already exists — skipping seed');
    return;
  }

  // Insert template
  const { rows: [template] } = await pool.query(
    `INSERT INTO form_templates
       (code, name, category, description, is_standard, is_mandatory, org_id)
     VALUES ($1, $2, $3, $4, TRUE, TRUE, NULL)
     RETURNING *`,
    [
      ALOP_CODE,
      'Angajare, Lichidare, Ordonanțare și Plată (ALOP)',
      'financiar',
      'Formular standard pentru angajarea, lichidarea, ordonanțarea și plata cheltuielilor bugetare conform Ordinului MFP 1792/2002 și modificărilor ulterioare.',
    ]
  );

  // Insert version v1 and publish immediately
  const { rows: [version] } = await pool.query(
    `INSERT INTO form_versions
       (template_id, version_no, schema_json, pdf_mapping_json, rules_json,
        required_attachments, required_signers, status, published_at)
     VALUES ($1, 1, $2::jsonb, $3::jsonb, $4::jsonb, $5::jsonb, $6::jsonb, 'published', NOW())
     RETURNING *`,
    [
      template.id,
      JSON.stringify(ALOP_SCHEMA),
      JSON.stringify(ALOP_PDF_MAPPING),
      JSON.stringify(ALOP_RULES),
      JSON.stringify(ALOP_REQUIRED_ATTACHMENTS),
      JSON.stringify(ALOP_REQUIRED_SIGNERS),
    ]
  );

  logger.info({ templateId: template.id, versionId: version.id }, 'ALOP-2024 standard form seeded');
}
