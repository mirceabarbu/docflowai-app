# DocFlowAI v3.5.1

**Platformă SaaS de circulație și semnare electronică calificată pentru administrația publică din România.**

---

## Descriere

DocFlowAI gestionează fluxuri de semnare secvențială multi-semnatar pe documente PDF. Suportă atât documente generate de platformă (tabel de semnături) cât și formulare cu câmpuri AcroForm/XFA predefinite (Ordonanță de Plată, Document de Fundamentare, formulare ANAF etc.).

Platforma este conformă cu **eIDAS**, **Legea 455/2001** și **HG 1259/2001**, operând exclusiv cu semnături electronice calificate (QES).

---

## Stack tehnic

| Componentă | Tehnologie |
|---|---|
| Runtime | Node.js ESM (ES Modules) |
| Framework | Express 4 |
| Bază de date | PostgreSQL (pg) |
| Real-time | WebSocket (ws) |
| PDF | pdf-lib, node-forge |
| Autentificare | JWT (HttpOnly cookies) |
| Email | Resend API |
| WhatsApp | Meta Business API |
| Notificări push | Web Push (VAPID) |
| Stocare arhivă | Google Drive API |
| Deploy | Railway |

---

## Structura proiectului

```
server/
  index.mjs                    ← Entry point, Express app, WebSocket, jobs
  db/index.mjs                 ← Pool PostgreSQL + sistem migrări automate
  middleware/
    auth.mjs                   ← JWT verify, requireAuth
    logger.mjs                 ← Pino structured logging
    rateLimiter.mjs            ← Rate limiting DB-backed
    metrics.mjs                ← Prometheus metrics
  routes/
    flows.mjs                  ← CRUD fluxuri, semnare, XFA detection, STS
    admin.mjs                  ← Panel admin: useri, org, fluxuri, rapoarte
    auth.mjs                   ← Login, logout, JWT refresh
    templates.mjs              ← Șabloane semnatari
    notifications.mjs          ← Notificări in-app
    admin/outreach.mjs         ← Campanii email outreach
  signing/
    SigningProvider.mjs        ← Interfață abstractă provider semnătură
    index.mjs                  ← Factory + registry provideri
    providers/
      LocalUploadProvider.mjs  ← Upload local (orice certificat calificat)
      STSCloudProvider.mjs     ← STS Cloud QES — implementare completă
      CertSignProvider.mjs     ← certSIGN / Paperless (schelet)
      TransSpedProvider.mjs    ← Trans Sped (schelet)
      AlfaTrustProvider.mjs    ← AlfaTrust / AlfaSign (schelet)
      NamirialProvider.mjs     ← Namirial eSignAnyWhere (schelet)
      CloudProviderBase.mjs    ← HTTP + retry + HMAC comun cloud
  emailTemplates.mjs
  mailer.mjs / whatsapp.mjs / push.mjs / drive.mjs / gws.mjs / webhook.mjs

public/
  semdoc-initiator.html        ← Creare flux, upload PDF, configurare semnatari
  semdoc-signer.html           ← Semnare document, selecție provider QES
  flow.html                    ← Status flux, timeline vizual
  admin.html                   ← Panel administrare complet
  templates.html               ← Gestionare șabloane
```

---

## Variabile de mediu

Copiază `env.example` în `.env`:

```env
DATABASE_URL=postgresql://user:pass@host:5432/dbname
JWT_SECRET=secret-minim-32-caractere
RESEND_API_KEY=re_...
MAIL_FROM=DocFlowAI <noreply@docflowai.ro>
PUBLIC_BASE_URL=https://app.docflowai.ro
VAPID_PUBLIC_KEY=...
VAPID_PRIVATE_KEY=...
VAPID_SUBJECT=mailto:contact@docflowai.ro
# Opțional
GOOGLE_SERVICE_ACCOUNT_JSON=...
DRIVE_FOLDER_ID=...
WA_TOKEN=... / WA_PHONE_ID=...
GWS_SUBJECT=admin@domeniu.ro
```

---

## Rulare locală

```bash
npm install
cp env.example .env
node server/index.mjs
```

Migrările DB rulează automat la startup.

---

## Tipuri de fluxuri

### Tabel generat
DocFlowAI generează PDF-ul cu tabelul de semnături și ancora predefinită.

### Ancore existente (XFA / AcroForm)
PDF-ul vine cu câmpuri de semnătură predefinite. Suportat:
- **AcroForm standard** — câmpuri `/Sig` în structura PDF
- **XFA dinamic** — formulare Adobe LiveCycle (Ordonanță de Plată SIMEC, Document de Fundamentare, formulare ANAF)

Platforma detectează automat câmpurile și le prezintă inițiatorului pentru asociere per semnatar.

---

## Provideri semnătură electronică calificată

### Local Upload ✅ Operațional
Semnare cu orice aplicație desktop, orice certificat calificat.

### STS Cloud QES ✅ Implementat — necesită credențiale
Implementare completă conform documentației oficiale STS (hash-based, OpenID Connect PKCE):
- Documentul rămâne exclusiv pe server — STS primește doar hash SHA-256
- Autentificare 2FA + PIN certificat pe `idp.stsisp.ro`
- Aprobare pe email sau notificare PUSH
- Înregistrare prin `formulare.sts.ro` de reprezentantul instituției

**Configurare:** Admin → Organizații → ⚙ Config → bifează STS → ⚙ Config → Generează pereche chei RSA → trimite cheia publică la STS → completează `clientId`, `kid`, `redirectUri`.

### certSIGN / Trans Sped / AlfaTrust / Namirial ⏳ Schelete
Arhitectura implementată. Necesită credențiale API și completarea `_buildSigningRequest()` / `handleCallback()` per provider.

---

## Arhitectură multi-tenant

- Fiecare **organizație** are propria configurație de provideri de semnătură
- **Semnatarul alege** providerul la semnare dintre cei activi în organizație
- **Upload local** este întotdeauna disponibil ca fallback

---

## Securitate

- JWT în cookie HttpOnly (nu localStorage)
- Token versioning — invalidare la reset parolă
- Rate limiting DB-backed
- Cross-tenant isolation
- Audit log complet per flux
- HMAC-SHA256 pentru webhook-uri
- CSP activat

---

## Schema DB

Migrările rulează automat la startup (`server/db/index.mjs`). Ultima: **033_signing_providers**.

> Pentru instanțe existente fără coloana `signing_providers_enabled`: rulează SQL-ul din migrarea 033 manual sau șterge rândul din `schema_migrations` și redeploy.

---

## Integrare AvanDoc

Configurează `webhook_url` per organizație. La finalizare flux, DocFlowAI trimite `POST` cu payload complet. Evenimente: `flow.completed`, `flow.refused`, `flow.cancelled`.

---

## Licență

Proprietar — DocFlowAI © 2026. Toate drepturile rezervate.
