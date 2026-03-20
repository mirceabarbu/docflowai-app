/**
 * DocFlowAI — flows/acroform.mjs
 * Detectare câmpuri AcroForm/XFA din PDF-uri cu ancore existente
 */
import { Router, json as expressJson } from 'express';
import { AUTH_COOKIE, JWT_SECRET, requireAuth, requireAdmin, sha256Hex, escHtml } from '../middleware/auth.mjs';
import { pool, DB_READY, requireDb, saveFlow, getFlowData, getDefaultOrgId, getUserMapForOrg, writeAuditEvent } from '../db/index.mjs';
import { createRateLimiter } from '../middleware/rateLimiter.mjs';
import { logger } from '../middleware/logger.mjs';
import crypto from 'crypto';
import jwt from 'jsonwebtoken';

const _largePdf = expressJson({ limit: '50mb' });
const _getIp = req => req.ip || req.socket?.remoteAddress || null;
const _signRateLimit   = createRateLimiter({ windowMs: 60_000, max: 20, message: 'Prea multe cereri de semnare. Încearcă în 1 minut.' });
const _uploadRateLimit = createRateLimiter({ windowMs: 60_000, max: 5,  message: 'Prea multe upload-uri. Încearcă în 1 minut.' });
const _readRateLimit   = createRateLimiter({ windowMs: 60_000, max: 60, message: 'Prea multe cereri. Încearcă în 1 minut.' });

function getOptionalActor(req) {
  const cookieToken = req.cookies?.[AUTH_COOKIE] || null;
  if (cookieToken) { try { return jwt.verify(cookieToken, JWT_SECRET); } catch (e) {} }
  const authHeader = req.headers['authorization'] || '';
  if (authHeader.startsWith('Bearer ')) { try { return jwt.verify(authHeader.slice(7), JWT_SECRET); } catch (e) {} }
  return null;
}}

// Deps injectate din flows/index.mjs
let _notify, _wsPush, _PDFLib, _stampFooterOnPdf, _isSignerTokenExpired;
let _newFlowId, _buildSignerLink, _stripSensitive, _stripPdfB64, _sendSignerEmail, _fireWebhook;
export function _injectDeps(d) {
  _notify = d.notify; _fireWebhook = d.fireWebhook || null; _wsPush = d.wsPush;
  _PDFLib = d.PDFLib; _stampFooterOnPdf = d.stampFooterOnPdf;
  _isSignerTokenExpired = d.isSignerTokenExpired; _newFlowId = d.newFlowId;
  _buildSignerLink = d.buildSignerLink; _stripSensitive = d.stripSensitive;
  _stripPdfB64 = d.stripPdfB64; _sendSignerEmail = d.sendSignerEmail;
}}

const router = Router();


  });
});

// ── POST /flows/detect-acroform-fields ───────────────────────────────────
// Extrage câmpurile de semnătură din PDF.
// Suportă 3 formate:
//   1. AcroForm/Fields cu FT=/Sig (PDF standard)
//   2. Page/Annots cu Widget+FT=/Sig (formulare guvernamentale)
//   3. XFA cu tag <signature> (Ordonanță de Plată, formulare dinamice Adobe)
router.post('/flows/detect-acroform-fields', _largePdf, async (req, res) => {
  try {
    const actor = requireAuth(req, res); if (!actor) return;
    const { pdfB64 } = req.body || {};
    if (!pdfB64 || typeof pdfB64 !== 'string')
      return res.status(400).json({ error: 'pdfB64_required' });
    if (!_PDFLib)
      return res.status(503).json({ error: 'pdf_lib_unavailable' });

    const raw = pdfB64.includes(',') ? pdfB64.split(',')[1] : pdfB64;
    if (Math.floor(raw.length * 0.75) > 50 * 1024 * 1024)
      return res.status(413).json({ error: 'pdf_too_large' });

    const { PDFDocument, PDFName } = _PDFLib;
    const pdfBytes = Buffer.from(raw, 'base64');
    const pdfDoc   = await PDFDocument.load(pdfBytes, { ignoreEncryption: true });
    const pages    = pdfDoc.getPages();
    const fieldsMap = new Map();

    // ── METODA 3: XFA (formulare dinamice Adobe) ─────────────────────────
    // Ordonanță de Plată, formulare ANAF — câmpurile sunt în XML comprimat
    try {
      const acroFormRef = pdfDoc.catalog.get(PDFName.of('AcroForm'));
      if (acroFormRef) {
        const acroForm = pdfDoc.context.lookup(acroFormRef);
        const xfaRef   = acroForm?.get?.(PDFName.of('XFA'));
        if (xfaRef) {
          const xfa = pdfDoc.context.lookup(xfaRef);
          const arr = xfa?.asArray?.() || [];
          for (let i = 0; i < arr.length - 1; i += 2) {
            try {
              const keyObj = pdfDoc.context.lookup(arr[i]);
              const key    = String(keyObj).replace(/^\(|\)$/g, '');
              if (key !== 'template') continue;
              const stream  = pdfDoc.context.lookup(arr[i + 1]);
              const rawBuf  = stream?.contents ? Buffer.from(stream.contents) : null;
              if (!rawBuf) continue;
              // Decompress FlateDecode
              let xmlText = '';
              try {
                const { inflateSync } = await import('zlib');
                xmlText = inflateSync(rawBuf).toString('utf8');
              } catch {
                xmlText = rawBuf.toString('utf8');
              }
              // Extrage căile câmpurilor signature din scripturi JavaScript
              // ex: getField("form1[0].MainForm[0].SubformSemnaturaAB[0].SignatureField1[0]")
              const getFieldRe = /getField\(["']([^"']+(?:[Ss]ign|[Ss]emn)[^"']*)["']\)/g;
              let gm;
              const seen = new Set();
              while ((gm = getFieldRe.exec(xmlText)) !== null) {
                const fullPath = gm[1];
                if (seen.has(fullPath)) continue;
                seen.add(fullPath);
                // Numele scurt = ultimul segment fără [index]
                const segments = fullPath.split('.');
                const lastSeg  = segments[segments.length - 1];
                const shortName = lastSeg.replace(/\[\d+\]$/, '');
                // Subform-ul părinte pentru context vizual
                const parentSeg = segments.length > 1
                  ? segments[segments.length - 2].replace(/\[\d+\]$/, '') : '';
                const displayName = parentSeg ? `${parentSeg} → ${shortName}` : shortName;
                if (!fieldsMap.has(fullPath)) {
                  fieldsMap.set(fullPath, {
                    name:     fullPath,          // calea XFA completă — folosită la semnare
                    label:    displayName,        // afișat în UI
                    shortName,
                    page:     null,
                    rect:     null,
                    source:   'xfa',
                  });
                }
              }
              // Fallback: caută <signature name="..."> direct
              const sigTagRe = /<signature[^>]*name="([^"]+)"[^>]*>/g;
              let sm;
              while ((sm = sigTagRe.exec(xmlText)) !== null) {
                const name = sm[1];
                if (!fieldsMap.has(name)) {
                  fieldsMap.set(name, { name, label: name, shortName: name,
                                        page: null, rect: null, source: 'xfa' });
                }
              }
            } catch(xfaErr) {
              logger.warn({ err: xfaErr }, 'detect: XFA stream parse error (non-fatal)');
            }
          }
        }
      }
    } catch(xfaErr) {
      logger.warn({ err: xfaErr }, 'detect: XFA traversal error (non-fatal)');
    }

    // ── METODA 1: AcroForm/Fields traversal recursiv ─────────────────────
    if (fieldsMap.size === 0) {
      try {
        const acroFormRef = pdfDoc.catalog.get(PDFName.of('AcroForm'));
        if (acroFormRef) {
          const acroForm  = pdfDoc.context.lookup(acroFormRef);
          const fieldsRef = acroForm?.get?.(PDFName.of('Fields'));
          const topFields = fieldsRef ? pdfDoc.context.lookup(fieldsRef) : null;
          function traverseFields(refs, inheritedFT = null) {
            const arr = Array.isArray(refs) ? refs : (refs?.asArray?.() || []);
            for (const ref of arr) {
              try {
                const field = pdfDoc.context.lookup(ref);
                if (!field?.get) continue;
                const ftObj = field.get(PDFName.of('FT'));
                const ft    = ftObj ? String(ftObj) : inheritedFT;
                const kidsRef = field.get(PDFName.of('Kids'));
                if (kidsRef) {
                  const kids = pdfDoc.context.lookup(kidsRef);
                  if (kids?.asArray) traverseFields(kids.asArray(), ft);
                }
                if (ft !== '/Sig' && ft !== 'Sig') continue;
                const nameObj = field.get(PDFName.of('T'));
                const name    = nameObj ? String(nameObj).replace(/^\//, '').replace(/^\(|\)$/g, '').trim() : null;
                if (!name || fieldsMap.has(name)) continue;
                let pageNum = null;
                const pRef = field.get(PDFName.of('P'));
                if (pRef) {
                  const pIdx = pages.findIndex(p => p.ref.toString() === pRef.toString());
                  if (pIdx >= 0) pageNum = pIdx + 1;
                }
                let rect = null;
                const rectObj = field.get(PDFName.of('Rect'));
                if (rectObj?.asArray) {
                  const r = rectObj.asArray().map(n => {
                    const v = pdfDoc.context.lookup(n);
                    return typeof v?.asNumber === 'function' ? v.asNumber() : parseFloat(String(v).replace(/[^0-9.\-]/g,'') || '0');
                  });
                  if (r.length === 4) rect = { x: r[0], y: r[1], width: r[2]-r[0], height: r[3]-r[1] };
                }
                fieldsMap.set(name, { name, label: name, shortName: name, page: pageNum, rect, source: 'acroform' });
              } catch { }
            }
          }
          if (topFields?.asArray) traverseFields(topFields.asArray());
        }
      } catch(e1) {
        logger.warn({ err: e1 }, 'detect: AcroForm traversal error (non-fatal)');
      }
    }

    // ── METODA 2: Page/Annots ─────────────────────────────────────────────
    if (fieldsMap.size === 0) {
      for (let pi = 0; pi < pages.length; pi++) {
        try {
          const annotsRef = pages[pi].node.get(PDFName.of('Annots'));
          if (!annotsRef) continue;
          const annots = pdfDoc.context.lookup(annotsRef);
          if (!annots?.asArray) continue;
          for (const aRef of annots.asArray()) {
            try {
              const ann = pdfDoc.context.lookup(aRef);
              if (!ann?.get) continue;
              if (String(ann.get(PDFName.of('Subtype'))) !== '/Widget') continue;
              const ft = ann.get(PDFName.of('FT'));
              if (String(ft) !== '/Sig' && String(ft) !== 'Sig') continue;
              const nameObj = ann.get(PDFName.of('T'));
              const name    = nameObj ? String(nameObj).replace(/^\//, '').replace(/^\(|\)$/g, '').trim() : null;
              if (!name || fieldsMap.has(name)) continue;
              fieldsMap.set(name, { name, label: name, shortName: name, page: pi + 1, rect: null, source: 'annots' });
            } catch { }
          }
        } catch { }
      }
    }

    const fields = [...fieldsMap.values()];
    fields.sort((a, b) => (a.page||0) - (b.page||0));

    const isXfa = fields.some(f => f.source === 'xfa');
    logger.info({ actor: actor.email, fieldsCount: fields.length, isXfa }, 'detect-acroform-fields');
    return res.json({
      fields,
      total:  fields.length,
      isXfa,
      message: fields.length === 0
        ? 'Nu s-au găsit câmpuri de semnătură în PDF. PDF-ul poate fi scanat sau fără câmpuri definite.'
        : undefined,
    });
  } catch(e) {
    logger.error({ err: e }, 'detect-acroform-fields error');
    return res.status(500).json({ error: 'server_error', message: String(e.message) });
  }
});






// ── GET /flows/sts-oauth-callback — callback OAuth2 de la STS IDP ─────────
// STS redirecționează utilizatorul aici după autentificare și selectarea certificatului.
// Query params: code, state, [error], [error_description]


export default router;
