/**
 * server/middleware/uploadGuard.mjs — multipart upload validation middleware.
 *
 * Uses busboy for streaming multipart parsing.
 * Files are buffered into memory — suitable for documents up to ~15 MB.
 */

import busboy from 'busboy';

const PDF_MAGIC = Buffer.from('%PDF');
const CSV_MIMES = new Set(['text/csv', 'application/csv', 'text/plain']);

/**
 * Build an upload middleware that validates MIME type, magic bytes, and size.
 *
 * @param {object} opts
 * @param {number}   opts.maxSizeMB     - Maximum file size in MB
 * @param {string}   opts.expectedMime  - Expected MIME type prefix (e.g. 'application/pdf')
 * @param {Function} opts.magicCheck    - (buffer) => boolean — validates magic bytes
 * @param {string}   opts.errorMsg      - Human-readable error if wrong type
 */
function _buildUploadMiddleware({ maxSizeMB, expectedMime, magicCheck, errorMsg }) {
  const maxBytes = maxSizeMB * 1024 * 1024;

  return function uploadMiddleware(req, res, next) {
    const contentType = req.headers['content-type'] || '';
    if (!contentType.includes('multipart/form-data')) {
      return res.status(400).json({ error: 'upload_invalid', message: 'Expected multipart/form-data' });
    }

    let settled = false;
    let fileReceived = false;

    const done = (err) => {
      if (settled) return;
      settled = true;
      if (err) return next(err);
      if (!fileReceived) {
        return res.status(400).json({ error: 'upload_missing', message: 'No file provided' });
      }
      next();
    };

    let bb;
    try {
      bb = busboy({ headers: req.headers, limits: { files: 1, fileSize: maxBytes + 1 } });
    } catch (e) {
      return res.status(400).json({ error: 'upload_parse_error', message: 'Could not parse multipart request' });
    }

    bb.on('file', (fieldname, fileStream, info) => {
      const { filename, mimeType } = info;
      const chunks = [];
      let size = 0;
      let truncated = false;

      fileStream.on('data', (chunk) => {
        size += chunk.length;
        if (size > maxBytes) {
          truncated = true;
          fileStream.resume(); // drain remaining data
          return;
        }
        chunks.push(chunk);
      });

      fileStream.on('limit', () => { truncated = true; });

      fileStream.on('end', () => {
        if (truncated) {
          return done(Object.assign(new Error(`File exceeds ${maxSizeMB} MB limit`), { statusCode: 400, code: 'UPLOAD_TOO_LARGE' }));
        }

        const buffer = Buffer.concat(chunks);

        // MIME check (flexible: expectedMime can be a string prefix or a Set)
        const mimeOk = typeof expectedMime === 'string'
          ? mimeType.startsWith(expectedMime)
          : expectedMime.has(mimeType);

        if (!mimeOk) {
          return done(Object.assign(new Error(errorMsg), { statusCode: 400, code: 'UPLOAD_WRONG_TYPE' }));
        }

        // Magic bytes check
        if (magicCheck && !magicCheck(buffer)) {
          return done(Object.assign(new Error(errorMsg), { statusCode: 400, code: 'UPLOAD_WRONG_TYPE' }));
        }

        fileReceived = true;
        req.uploadedFile = {
          buffer,
          originalName: filename || 'upload',
          size: buffer.length,
          mimeType,
        };
      });

      fileStream.on('error', done);
    });

    bb.on('finish', () => done(null));
    bb.on('error', (e) => done(e));

    req.pipe(bb);
  };
}

/**
 * acceptPdf — validates that uploaded file is a PDF (MIME + magic bytes).
 *
 * @param {object} [opts]
 * @param {number}  [opts.maxSizeMB=15]
 * @returns Express middleware — sets req.uploadedFile = { buffer, originalName, size, mimeType }
 */
export function acceptPdf({ maxSizeMB = 15 } = {}) {
  return _buildUploadMiddleware({
    maxSizeMB,
    expectedMime: 'application/pdf',
    magicCheck: (buf) => buf.length >= 4 && buf.slice(0, 4).equals(PDF_MAGIC),
    errorMsg: 'Fișierul trebuie să fie un PDF valid.',
  });
}

/**
 * acceptCsv — validates that uploaded file is a CSV.
 *
 * @param {object} [opts]
 * @param {number}  [opts.maxSizeMB=5]
 * @returns Express middleware — sets req.uploadedFile = { buffer, originalName, size, mimeType }
 */
export function acceptCsv({ maxSizeMB = 5 } = {}) {
  return _buildUploadMiddleware({
    maxSizeMB,
    expectedMime: CSV_MIMES,
    magicCheck: null, // CSV has no reliable magic bytes
    errorMsg: 'Fișierul trebuie să fie un CSV valid.',
  });
}
