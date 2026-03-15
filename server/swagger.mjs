/**
 * DocFlowAI — OpenAPI 3.0 Specification
 *
 * Servit la:
 *   GET /api-docs       — Swagger UI (browser)
 *   GET /api-docs.json  — spec JSON brut (Postman, Insomnia, integrări)
 *
 * Actualizat manual la adăugarea de endpoint-uri noi.
 */

export const openApiSpec = {
  openapi: '3.0.3',
  info: {
    title: 'DocFlowAI API',
    version: '3.3.7',
    description: `Platformă de circulație și semnare electronică calificată pentru administrația publică din România.

**Autentificare:** JWT via cookie HttpOnly \`auth_token\` (setat la login).
Alternativ: header \`Authorization: Bearer <token>\`.

**Multi-tenant:** Toate endpoint-urile filtrează automat pe \`org_id\` din JWT.

**Token semnatar:** Endpoint-urile publice de semnare acceptă \`?token=<signer_token>\` în query string sau header \`X-Signer-Token\`.`,
    contact: {
      name: 'DocFlowAI',
      url: 'https://docflowai.ro',
    },
  },
  servers: [
    {
      url: process.env.PUBLIC_BASE_URL || 'https://docflowai-app-staging.up.railway.app',
      description: 'Server activ',
    },
  ],
  tags: [
    { name: 'Auth', description: 'Autentificare și sesiune' },
    { name: 'Fluxuri', description: 'Creare și gestionare fluxuri de semnare' },
    { name: 'Semnare', description: 'Acțiuni semnatar (sign, refuse, upload, delegate)' },
    { name: 'Atașamente', description: 'Documente suport per flux' },
    { name: 'Notificări', description: 'Notificări in-app' },
    { name: 'Template-uri', description: 'Șabloane semnatari' },
    { name: 'Admin - Utilizatori', description: 'Gestionare utilizatori (admin only)' },
    { name: 'Admin - Fluxuri', description: 'Administrare fluxuri (admin only)' },
    { name: 'Admin - Outreach', description: 'Campanii email instituții publice (admin only)' },
    { name: 'Sistem', description: 'Health, metrics, WebSocket' },
  ],
  components: {
    securitySchemes: {
      cookieAuth: {
        type: 'apiKey',
        in: 'cookie',
        name: 'auth_token',
        description: 'JWT setat automat la login via Set-Cookie HttpOnly.',
      },
      bearerAuth: {
        type: 'http',
        scheme: 'bearer',
        bearerFormat: 'JWT',
        description: 'Alternativă la cookie: Authorization: Bearer <token>',
      },
      signerToken: {
        type: 'apiKey',
        in: 'query',
        name: 'token',
        description: 'Token semnatar din link-ul de semnare (public, fără cont).',
      },
      adminSecret: {
        type: 'apiKey',
        in: 'header',
        name: 'x-admin-secret',
        description: 'Bypass admin via ADMIN_SECRET env (rate-limited, audit logged).',
      },
    },
    schemas: {
      Error: {
        type: 'object',
        properties: {
          error: { type: 'string', example: 'invalid_credentials' },
          message: { type: 'string', example: 'Credențiale invalide.' },
          requestId: { type: 'string', format: 'uuid' },
        },
      },
      FlowSummary: {
        type: 'object',
        properties: {
          flowId: { type: 'string', example: 'PB_3A1F2C' },
          docName: { type: 'string', example: 'Referat aprobare' },
          initName: { type: 'string' },
          initEmail: { type: 'string', format: 'email' },
          institutie: { type: 'string' },
          compartiment: { type: 'string' },
          status: { type: 'string', enum: ['active', 'completed', 'refused', 'cancelled', 'review_requested'] },
          urgent: { type: 'boolean' },
          flowType: { type: 'string', enum: ['tabel', 'ancore'] },
          createdAt: { type: 'string', format: 'date-time' },
          completedAt: { type: 'string', format: 'date-time', nullable: true },
        },
      },
      Signer: {
        type: 'object',
        properties: {
          order: { type: 'integer' },
          name: { type: 'string' },
          email: { type: 'string', format: 'email' },
          rol: { type: 'string', example: 'AVIZAT' },
          functie: { type: 'string' },
          compartiment: { type: 'string' },
          status: { type: 'string', enum: ['pending', 'current', 'signed', 'refused', 'cancelled'] },
          signedAt: { type: 'string', format: 'date-time', nullable: true },
        },
      },
      User: {
        type: 'object',
        properties: {
          id: { type: 'integer' },
          email: { type: 'string', format: 'email' },
          nume: { type: 'string' },
          functie: { type: 'string' },
          institutie: { type: 'string' },
          compartiment: { type: 'string' },
          role: { type: 'string', enum: ['user', 'org_admin', 'admin'] },
          org_id: { type: 'integer' },
          notif_inapp: { type: 'boolean' },
          notif_email: { type: 'boolean' },
          notif_whatsapp: { type: 'boolean' },
        },
      },
    },
  },
  security: [{ cookieAuth: [] }, { bearerAuth: [] }],
  paths: {

    // ── AUTH ──────────────────────────────────────────────────────────────────
    '/auth/login': {
      post: {
        tags: ['Auth'],
        summary: 'Login',
        security: [],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['email', 'password'],
                properties: {
                  email: { type: 'string', format: 'email' },
                  password: { type: 'string', maxLength: 200 },
                },
              },
            },
          },
        },
        responses: {
          200: {
            description: 'Login reușit — cookie JWT setat',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    ok: { type: 'boolean' },
                    email: { type: 'string' },
                    role: { type: 'string' },
                    orgId: { type: 'integer' },
                    force_password_change: { type: 'boolean' },
                  },
                },
              },
            },
          },
          400: { description: 'Câmpuri lipsă sau parolă prea lungă' },
          401: { description: 'Credențiale invalide' },
          429: { description: 'Prea multe încercări — IP blocat' },
        },
      },
    },
    '/auth/logout': {
      post: {
        tags: ['Auth'],
        summary: 'Logout — șterge cookie JWT',
        responses: { 200: { description: 'OK' } },
      },
    },
    '/auth/me': {
      get: {
        tags: ['Auth'],
        summary: 'Profil utilizator curent',
        responses: {
          200: { description: 'Date utilizator', content: { 'application/json': { schema: { $ref: '#/components/schemas/User' } } } },
          401: { description: 'Neautentificat' },
        },
      },
    },
    '/auth/refresh': {
      post: {
        tags: ['Auth'],
        summary: 'Reînnoire token (grace 15 min după expirare)',
        responses: {
          200: { description: 'Token reînnoit' },
          401: { description: 'Token invalid sau expirat complet' },
        },
      },
    },
    '/auth/change-password': {
      post: {
        tags: ['Auth'],
        summary: 'Schimbare parolă (inclusiv la force_password_change)',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['current_password', 'new_password'],
                properties: {
                  current_password: { type: 'string' },
                  new_password: { type: 'string', minLength: 6, maxLength: 200 },
                },
              },
            },
          },
        },
        responses: {
          200: { description: 'Parolă schimbată' },
          401: { description: 'Parolă curentă incorectă' },
        },
      },
    },

    // ── FLUXURI ───────────────────────────────────────────────────────────────
    '/flows': {
      post: {
        tags: ['Fluxuri'],
        summary: 'Creare flux nou',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['docName', 'initName', 'initEmail', 'signers'],
                properties: {
                  docName: { type: 'string', maxLength: 500 },
                  initName: { type: 'string', maxLength: 200 },
                  initEmail: { type: 'string', format: 'email' },
                  institutie: { type: 'string' },
                  flowType: { type: 'string', enum: ['tabel', 'ancore'], default: 'tabel' },
                  urgent: { type: 'boolean', default: false },
                  pdfB64: { type: 'string', description: 'PDF în base64 (max 50MB)' },
                  signers: { type: 'array', items: { $ref: '#/components/schemas/Signer' }, maxItems: 50 },
                },
              },
            },
          },
        },
        responses: {
          200: { description: 'Flux creat', content: { 'application/json': { schema: { type: 'object', properties: { ok: { type: 'boolean' }, flowId: { type: 'string' } } } } } },
          400: { description: 'Date invalide' },
          413: { description: 'PDF prea mare (max 50MB)' },
        },
      },
    },
    '/flows/{flowId}': {
      get: {
        tags: ['Fluxuri'],
        summary: 'Date flux (fără PDF)',
        security: [{ cookieAuth: [] }, { signerToken: [] }],
        parameters: [
          { name: 'flowId', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'token', in: 'query', schema: { type: 'string' }, description: 'Token semnatar (acces public)' },
        ],
        responses: {
          200: { description: 'Date flux', content: { 'application/json': { schema: { $ref: '#/components/schemas/FlowSummary' } } } },
          404: { description: 'Flux negăsit' },
        },
      },
      put: {
        tags: ['Fluxuri'],
        summary: 'Editare completă flux (admin only)',
        responses: { 200: { description: 'OK' }, 403: { description: 'Forbidden' } },
      },
      delete: {
        tags: ['Fluxuri'],
        summary: 'Ștergere flux (inițiator sau admin)',
        responses: {
          200: { description: 'Flux șters permanent' },
          403: { description: 'Forbidden' },
          409: { description: 'Flux în progres — necesită admin' },
        },
      },
    },
    '/flows/{flowId}/pdf': {
      get: {
        tags: ['Fluxuri'],
        summary: 'Descărcare PDF original + emitere uploadToken',
        security: [{ cookieAuth: [] }, { signerToken: [] }],
        parameters: [{ name: 'flowId', in: 'path', required: true, schema: { type: 'string' } }],
        responses: {
          200: {
            description: 'PDF binar',
            headers: {
              'X-Docflow-Prehash': { schema: { type: 'string' }, description: 'SHA256 hex al PDF-ului livrat' },
              'X-Docflow-UploadToken': { schema: { type: 'string' }, description: 'JWT pentru upload verificat (expiră 4h)' },
            },
          },
        },
      },
    },
    '/flows/{flowId}/signed-pdf': {
      get: {
        tags: ['Fluxuri'],
        summary: 'Descărcare PDF semnat final',
        security: [{ cookieAuth: [] }, { signerToken: [] }],
        parameters: [{ name: 'flowId', in: 'path', required: true, schema: { type: 'string' } }],
        responses: { 200: { description: 'PDF semnat binar' }, 404: { description: 'PDF semnat lipsă' } },
      },
    },
    '/flows/{flowId}/cancel': {
      post: {
        tags: ['Fluxuri'],
        summary: 'Anulare flux (inițiator sau admin)',
        parameters: [{ name: 'flowId', in: 'path', required: true, schema: { type: 'string' } }],
        requestBody: {
          content: { 'application/json': { schema: { type: 'object', properties: { reason: { type: 'string', maxLength: 500 } } } } },
        },
        responses: { 200: { description: 'Flux anulat' }, 403: { description: 'Forbidden' } },
      },
    },
    '/flows/{flowId}/send-email': {
      post: {
        tags: ['Fluxuri'],
        summary: 'Trimitere externă document semnat (PDF atașat)',
        parameters: [{ name: 'flowId', in: 'path', required: true, schema: { type: 'string' } }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['to', 'subject'],
                properties: {
                  to: { type: 'string', format: 'email' },
                  subject: { type: 'string' },
                  bodyText: { type: 'string', description: 'Corp mesaj personalizat (newline suportat)' },
                },
              },
            },
          },
        },
        responses: {
          200: { description: 'Email trimis' },
          409: { description: 'Fluxul nu este finalizat sau PDF lipsă' },
          503: { description: 'Email neconfigurat (RESEND_API_KEY lipsă)' },
        },
      },
    },

    // ── SEMNARE ───────────────────────────────────────────────────────────────
    '/flows/{flowId}/sign': {
      post: {
        tags: ['Semnare'],
        summary: 'Marcare semnat (fără upload PDF)',
        security: [{ signerToken: [] }],
        parameters: [{ name: 'flowId', in: 'path', required: true, schema: { type: 'string' } }],
        requestBody: {
          required: true,
          content: { 'application/json': { schema: { type: 'object', required: ['token', 'signature'], properties: { token: { type: 'string' }, signature: { type: 'string' } } } } },
        },
        responses: { 200: { description: 'Semnat' }, 409: { description: 'Nu este rândul acestui semnatar' } },
      },
    },
    '/flows/{flowId}/upload-signed-pdf': {
      post: {
        tags: ['Semnare'],
        summary: 'Upload PDF semnat (verificare hash integritate)',
        security: [{ signerToken: [] }],
        parameters: [{ name: 'flowId', in: 'path', required: true, schema: { type: 'string' } }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['token', 'uploadToken', 'signedPdfB64'],
                properties: {
                  token: { type: 'string', description: 'Token semnatar' },
                  uploadToken: { type: 'string', description: 'JWT emis de GET /pdf (expiră 4h)' },
                  signedPdfB64: { type: 'string', description: 'PDF semnat în base64 (max 30MB)' },
                },
              },
            },
          },
        },
        responses: {
          200: { description: 'Upload acceptat' },
          409: { description: 'PDF identic cu originalul sau document alterat' },
          413: { description: 'PDF prea mare (max 30MB)' },
        },
      },
    },
    '/flows/{flowId}/refuse': {
      post: {
        tags: ['Semnare'],
        summary: 'Refuz cu motiv',
        security: [{ signerToken: [] }],
        parameters: [{ name: 'flowId', in: 'path', required: true, schema: { type: 'string' } }],
        requestBody: {
          required: true,
          content: { 'application/json': { schema: { type: 'object', required: ['token', 'reason'], properties: { token: { type: 'string' }, reason: { type: 'string', maxLength: 1000 } } } } },
        },
        responses: { 200: { description: 'Refuzat' } },
      },
    },
    '/flows/{flowId}/delegate': {
      post: {
        tags: ['Semnare'],
        summary: 'Delegare semnătură',
        security: [{ signerToken: [] }],
        parameters: [{ name: 'flowId', in: 'path', required: true, schema: { type: 'string' } }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['fromToken', 'toEmail', 'reason'],
                properties: {
                  fromToken: { type: 'string' },
                  toEmail: { type: 'string', format: 'email' },
                  toName: { type: 'string' },
                  reason: { type: 'string', maxLength: 1000 },
                },
              },
            },
          },
        },
        responses: { 200: { description: 'Delegat' } },
      },
    },
    '/flows/{flowId}/request-review': {
      post: {
        tags: ['Semnare'],
        summary: 'Cerere revizuire document de la semnatar',
        security: [{ signerToken: [] }],
        parameters: [{ name: 'flowId', in: 'path', required: true, schema: { type: 'string' } }],
        requestBody: {
          required: true,
          content: { 'application/json': { schema: { type: 'object', required: ['token', 'reason'], properties: { token: { type: 'string' }, reason: { type: 'string' } } } } },
        },
        responses: { 200: { description: 'Revizuire solicitată' } },
      },
    },
    '/flows/{flowId}/reinitiate': {
      post: {
        tags: ['Fluxuri'],
        summary: 'Reinițiere după refuz (flux nou, fără semnatarul care a refuzat)',
        parameters: [{ name: 'flowId', in: 'path', required: true, schema: { type: 'string' } }],
        responses: { 200: { description: 'Flux nou creat', content: { 'application/json': { schema: { type: 'object', properties: { ok: { type: 'boolean' }, newFlowId: { type: 'string' } } } } } } },
      },
    },
    '/flows/{flowId}/reinitiate-review': {
      post: {
        tags: ['Fluxuri'],
        summary: 'Reinițiere după revizuire (același flowId, document nou)',
        parameters: [{ name: 'flowId', in: 'path', required: true, schema: { type: 'string' } }],
        requestBody: {
          required: true,
          content: { 'application/json': { schema: { type: 'object', required: ['pdfB64'], properties: { pdfB64: { type: 'string' } } } } },
        },
        responses: { 200: { description: 'Runda nouă de semnare' } },
      },
    },
    '/flows/{flowId}/resend': {
      post: {
        tags: ['Semnare'],
        summary: 'Re-trimitere notificare semnatar curent',
        parameters: [{ name: 'flowId', in: 'path', required: true, schema: { type: 'string' } }],
        responses: { 200: { description: 'Notificare trimisă' } },
      },
    },
    '/flows/{flowId}/register-download': {
      post: {
        tags: ['Semnare'],
        summary: 'Înregistrare descărcare + emitere uploadToken',
        security: [{ signerToken: [] }],
        parameters: [{ name: 'flowId', in: 'path', required: true, schema: { type: 'string' } }],
        responses: { 200: { description: 'downloadedAt setat, uploadToken emis' } },
      },
    },
    '/flows/{flowId}/regenerate-token': {
      post: {
        tags: ['Semnare'],
        summary: 'Token nou pentru semnatar (admin only)',
        parameters: [{ name: 'flowId', in: 'path', required: true, schema: { type: 'string' } }],
        responses: { 200: { description: 'Token regenerat' } },
      },
    },

    // ── ATAȘAMENTE ────────────────────────────────────────────────────────────
    '/flows/{flowId}/attachments': {
      get: {
        tags: ['Atașamente'],
        summary: 'Lista documente suport',
        security: [{ cookieAuth: [] }, { signerToken: [] }],
        parameters: [{ name: 'flowId', in: 'path', required: true, schema: { type: 'string' } }],
        responses: { 200: { description: 'Lista atașamente' } },
      },
      post: {
        tags: ['Atașamente'],
        summary: 'Upload document suport (PDF/ZIP/RAR, max 10MB)',
        parameters: [{ name: 'flowId', in: 'path', required: true, schema: { type: 'string' } }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['filename', 'dataB64'],
                properties: {
                  filename: { type: 'string' },
                  mimeType: { type: 'string' },
                  dataB64: { type: 'string', description: 'Fișier în base64 (max 10MB)' },
                },
              },
            },
          },
        },
        responses: { 201: { description: 'Atașament adăugat' }, 413: { description: 'Fișier prea mare' } },
      },
    },
    '/flows/{flowId}/attachments/{attId}': {
      get: {
        tags: ['Atașamente'],
        summary: 'Descărcare document suport',
        security: [{ cookieAuth: [] }, { signerToken: [] }],
        parameters: [
          { name: 'flowId', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'attId', in: 'path', required: true, schema: { type: 'integer' } },
        ],
        responses: { 200: { description: 'Fișier binar' } },
      },
      delete: {
        tags: ['Atașamente'],
        summary: 'Ștergere document suport (inițiator/admin)',
        parameters: [
          { name: 'flowId', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'attId', in: 'path', required: true, schema: { type: 'integer' } },
        ],
        responses: { 200: { description: 'Șters' } },
      },
    },

    // ── FLUXURI UTILIZATOR ────────────────────────────────────────────────────
    '/my-flows': {
      get: {
        tags: ['Fluxuri'],
        summary: 'Fluxuri proprii (inițiate + de semnat)',
        parameters: [
          { name: 'status', in: 'query', schema: { type: 'string', enum: ['active', 'completed', 'refused', 'cancelled', 'all'] } },
          { name: 'q', in: 'query', schema: { type: 'string' }, description: 'Căutare după nume document' },
        ],
        responses: { 200: { description: 'Lista fluxuri' } },
      },
    },

    // ── TEMPLATE-URI ──────────────────────────────────────────────────────────
    '/api/templates': {
      get: {
        tags: ['Template-uri'],
        summary: 'Lista șabloane (proprii + shared din aceeași instituție)',
        responses: { 200: { description: 'Lista template-uri' } },
      },
      post: {
        tags: ['Template-uri'],
        summary: 'Creare șablon',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['name', 'signers'],
                properties: {
                  name: { type: 'string', maxLength: 200 },
                  signers: { type: 'array', items: { $ref: '#/components/schemas/Signer' } },
                  shared: { type: 'boolean', default: false },
                },
              },
            },
          },
        },
        responses: { 201: { description: 'Șablon creat' } },
      },
    },
    '/api/templates/{id}': {
      put: {
        tags: ['Template-uri'],
        summary: 'Editare șablon (owner only)',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'integer' } }],
        responses: { 200: { description: 'Actualizat' }, 404: { description: 'Negăsit sau nu ești owner' } },
      },
      delete: {
        tags: ['Template-uri'],
        summary: 'Ștergere șablon (owner only)',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'integer' } }],
        responses: { 200: { description: 'Șters' } },
      },
    },

    // ── NOTIFICĂRI ────────────────────────────────────────────────────────────
    '/api/notifications': {
      get: {
        tags: ['Notificări'],
        summary: 'Lista notificări',
        responses: { 200: { description: 'Notificări' } },
      },
    },
    '/api/notifications/unread-count': {
      get: {
        tags: ['Notificări'],
        summary: 'Număr notificări necitite',
        responses: { 200: { description: 'Count', content: { 'application/json': { schema: { type: 'object', properties: { count: { type: 'integer' } } } } } } },
      },
    },
    '/api/notifications/read-all': {
      post: {
        tags: ['Notificări'],
        summary: 'Marchează toate ca citite',
        responses: { 200: { description: 'OK' } },
      },
    },
    '/api/notifications/{id}/read': {
      post: {
        tags: ['Notificări'],
        summary: 'Marchează notificare ca citită',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'integer' } }],
        responses: { 200: { description: 'OK' } },
      },
    },
    '/api/notifications/{id}': {
      delete: {
        tags: ['Notificări'],
        summary: 'Șterge notificare',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'integer' } }],
        responses: { 200: { description: 'Ștearsă' } },
      },
    },

    // ── ADMIN — UTILIZATORI ───────────────────────────────────────────────────
    '/admin/users': {
      get: {
        tags: ['Admin - Utilizatori'],
        summary: 'Lista utilizatori (filtrat pe org)',
        security: [{ cookieAuth: [] }, { adminSecret: [] }],
        responses: { 200: { description: 'Lista utilizatori', content: { 'application/json': { schema: { type: 'array', items: { $ref: '#/components/schemas/User' } } } } } },
      },
      post: {
        tags: ['Admin - Utilizatori'],
        summary: 'Creare utilizator — returnează parolă generată o singură dată',
        security: [{ cookieAuth: [] }, { adminSecret: [] }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['email', 'nume'],
                properties: {
                  email: { type: 'string', format: 'email' },
                  nume: { type: 'string' },
                  functie: { type: 'string' },
                  institutie: { type: 'string' },
                  compartiment: { type: 'string' },
                  role: { type: 'string', enum: ['user', 'org_admin', 'admin'] },
                  password: { type: 'string', description: 'Opțional — generat automat dacă lipsește' },
                },
              },
            },
          },
        },
        responses: {
          201: { description: 'User creat — `tempPassword` vizibilă o singură dată' },
          409: { description: 'Email deja există' },
        },
      },
    },
    '/admin/users/{id}': {
      put: {
        tags: ['Admin - Utilizatori'],
        summary: 'Editare utilizator',
        security: [{ cookieAuth: [] }, { adminSecret: [] }],
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'integer' } }],
        responses: { 200: { description: 'Actualizat' } },
      },
      delete: {
        tags: ['Admin - Utilizatori'],
        summary: 'Ștergere utilizator',
        security: [{ cookieAuth: [] }, { adminSecret: [] }],
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'integer' } }],
        responses: { 200: { description: 'Șters' } },
      },
    },
    '/admin/users/{id}/reset-password': {
      post: {
        tags: ['Admin - Utilizatori'],
        summary: 'Reset parolă — returnează parolă nouă o singură dată',
        security: [{ cookieAuth: [] }, { adminSecret: [] }],
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'integer' } }],
        responses: { 200: { description: 'Parolă resetată' } },
      },
    },
    '/admin/users/{id}/send-credentials': {
      post: {
        tags: ['Admin - Utilizatori'],
        summary: 'Reset parolă + trimitere credențiale pe email',
        security: [{ cookieAuth: [] }, { adminSecret: [] }],
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'integer' } }],
        responses: { 200: { description: 'Email trimis' } },
      },
    },

    // ── ADMIN — FLUXURI ───────────────────────────────────────────────────────
    '/admin/flows/list': {
      get: {
        tags: ['Admin - Fluxuri'],
        summary: 'Lista fluxuri paginată (include cancelled)',
        security: [{ cookieAuth: [] }, { adminSecret: [] }],
        parameters: [
          { name: 'page', in: 'query', schema: { type: 'integer', default: 1 } },
          { name: 'limit', in: 'query', schema: { type: 'integer', default: 20 } },
          { name: 'status', in: 'query', schema: { type: 'string' } },
          { name: 'q', in: 'query', schema: { type: 'string' } },
        ],
        responses: { 200: { description: 'Lista fluxuri + paginare' } },
      },
    },
    '/admin/flows/{flowId}/audit': {
      get: {
        tags: ['Admin - Fluxuri'],
        summary: 'Export audit flux (json/csv/txt/pdf)',
        security: [{ cookieAuth: [] }, { adminSecret: [] }],
        parameters: [
          { name: 'flowId', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'format', in: 'query', schema: { type: 'string', enum: ['json', 'csv', 'txt', 'pdf'], default: 'pdf' } },
        ],
        responses: { 200: { description: 'Raport audit' } },
      },
    },
    '/admin/flows/archive': {
      post: {
        tags: ['Admin - Fluxuri'],
        summary: 'Arhivare batch în Google Drive (async)',
        security: [{ cookieAuth: [] }, { adminSecret: [] }],
        responses: { 200: { description: 'Job de arhivare pornit' } },
      },
    },
    '/admin/db/vacuum': {
      post: {
        tags: ['Admin - Fluxuri'],
        summary: 'VACUUM ANALYZE PostgreSQL',
        security: [{ cookieAuth: [] }, { adminSecret: [] }],
        responses: { 200: { description: 'VACUUM executat' } },
      },
    },

    // ── SISTEM ────────────────────────────────────────────────────────────────
    '/health': {
      get: {
        tags: ['Sistem'],
        summary: 'Status server (public)',
        security: [],
        responses: {
          200: {
            description: 'Server OK',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    ok: { type: 'boolean' },
                    version: { type: 'string', example: '3.3.7' },
                    uptime: { type: 'integer' },
                    memory: { type: 'object' },
                  },
                },
              },
            },
          },
        },
      },
    },
    '/admin/health': {
      get: {
        tags: ['Sistem'],
        summary: 'Status detaliat + DB latency + WS clients (admin)',
        security: [{ cookieAuth: [] }, { adminSecret: [] }],
        responses: { 200: { description: 'Status complet' } },
      },
    },
    '/metrics': {
      get: {
        tags: ['Sistem'],
        summary: 'Prometheus metrics (admin sau METRICS_PUBLIC=1)',
        security: [{ cookieAuth: [] }, { adminSecret: [] }],
        responses: { 200: { description: 'Prometheus text format', content: { 'text/plain': {} } } },
      },
    },
  },
};
