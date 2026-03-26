/**
 * DocFlowAI v3.9.2 — Main entry point (orchestrator)
 *
 * CHANGES v3.9.2 (build b216, 26.03.2026):
 *  FIX: semnatura in Signature1 (invisible) in loc de SIG_ROL_N din cartus
 *    Cauza: pdflibAddPlaceholder adauga camp nou in loc sa foloseasca existentul
 *    Fix: preparePadesDoc seteaza /V cu placeholder ByteRange pe campul SIG_ROL_N
 *    Rezultat: semnatura apare in celula vizuala din cartus in Adobe Signature Panel
 *
 * CHANGES v3.9.1 (build b215, 26.03.2026):
 *  FIX: byteRange is not defined in cloud-signing.mjs
 *    Noul API pades.mjs nu mai returneaza byteRange extern
 *    Eliminat padesRange din signers JSONB si din poll handler
 *    injectCms() si calcPadesHash() nu mai au nevoie de byteRange explicit
 *
 * CHANGES v3.9.0 (build b214, 26.03.2026):
 *  FEAT: PAdES corect cu @signpdf/signpdf (incremental update)
 *    pades.mjs rescris complet:
 *      preparePadesDoc() — placeholder ByteRange via pdflibAddPlaceholder
 *      calcPadesHash() — hash corect (reproduce logica SignPdf.sign)
 *      injectCms() — STSSigner custom + SignPdf.sign = incremental update
 *      Semnatura anterioara ramane valida la semnarea urmatoare
 *    stampFooterOnPdf extins:
 *      Genereaza cartus vizual server-side la creare flux
 *      Campuri AcroForm /Sig vizibile in celulele cartusului
 *      Returneaza signersFieldNames -> signers[i].padesFieldName
 *    Rezultat asteptat: Adobe Signature Panel valid per semnatar
 *
 * CHANGES v3.8.7 (build b213, 25.03.2026):
 *  FIX ARHITECTURA PAdES: semnaturi invalide + cartus pe pagina gresita
 *    Problema: pdf-lib nu suporta incremental update → rescriere totala
 *    → ByteRange-ul semnaturii 1 devine invalid la semnarea 2
 *    Solutie: campuri AcroForm /Sig INVIZIBILE (Rect=[0,0,0,0]) per semnatar
 *    Fiecare semnare e independenta — nu se invalideaza reciproc
 *    Cartusul vizual ramane generat client-side (buildCartusBlob + PDF.js)
 *    stampFooterOnPdf: footer + campuri invizibile (nu mai genereaza cartuș)
 *    pades.mjs: simplificat — foloseste campul existent sau nou invizibil
 *
 * CHANGES v3.8.6 (build b212, 25.03.2026):
 *  FIX: sub-pasii (Semnat + PDF incarcat) apar si cu un singur eveniment
 *    Inainte: subRows afisat doar daca existau AMBII (>= 2)
 *    Acum: afisat daca exista cel putin unul (>= 1)
 *    Fluxuri STS vechi (fara SIGNED) vor arata cel putin PDF incarcat
 *
 * CHANGES v3.8.5 (build b211, 25.03.2026):
 *  ARHITECTURA PAdES corecta:
 *    stampFooterOnPdf() — extins:
 *      Genereaza cartusul O SINGURA DATA la creare flux
 *      Adauga camp AcroForm /Sig per semnatar (SIG_ROL_N)
 *      Returneaza { pdfB64, signersFieldNames } → salveaza padesFieldName per semnatar
 *    crud.mjs — aplica padesFieldName din stampResult la signers[i]
 *    pades.mjs — rescris:
 *      buildSignaturePdf() foloseste campul AcroForm existent (padesFieldName)
 *      Nu mai genereaza cartus la semnare — semnatura in celula corecta din tabel
 *      Fallback la camp nou invizibil pentru fluxuri fara padesFieldName
 *
 * CHANGES v3.8.4 (build b210, 25.03.2026):
 *  FIX: semnaturi suprapuse in PDF la flux cu 2+ semnatari STS
 *    Cauza: buildSignaturePdf() adauga pagina noua cu cartus la fiecare semnatar
 *    Fix: detectam hasChainedSignatures (semnatari anteriori semnati)
 *    Semnatar 1: pagina noua + cartus complet
 *    Semnatar 2+: ultima pagina existenta (cartusul e deja acolo)
 *  FIX: evenimentul SIGNED lipsea din audit (STS poll)
 *    Adaugam SIGNED + SIGNED_PDF_UPLOADED (consistent cu local upload flow)
 *
 * CHANGES v3.8.3 (build b209, 25.03.2026):
 *  FIX: dupa semnare STS, redirect la flow.html dupa 2.5s (ca upload local)
 *    Mesaj: 'Semnatură aplicată cu succes! Redirecționăm către Status...'
 *
 * CHANGES v3.8.2 (build b208, 25.03.2026):
 *  FIX: race condition la reincarcarea paginii dupa semnare STS
 *    Cauza: window.location.replace imediat → GET /flows poate citi date vechi
 *    Fix: parametru sts_signed=1 in URL de redirect
 *    La incarcare: daca sts_signed=1, blocam signBox si afisam mesaj succes
 *    indiferent de ce returneaza DB (evita race condition)
 *    URL curatat cu history.replaceState (fara reload)
 *
 * CHANGES v3.8.1 (build b207, 25.03.2026):
 *  FIX: migrare 041 - extinde constraint flows_pdfs_key_check
 *    Permite chei 'padesPdf_N' (temporare PAdES) in plus fata de cele 3 fixe
 *
 * CHANGES v3.8.0 (build b206, 25.03.2026):
 *  FEAT PRIORITY-0: PAdES (PDF Advanced Electronic Signatures) embedded
 *    server/signing/pades.mjs — modul nou:
 *      buildSignaturePdf() — PDF cu cartuș tabel server-side + ByteRange placeholder
 *      calcPadesHash() — SHA-256 pe bytes din afara Contents (standard PAdES)
 *      injectCmsSignature() — CMS STS injectat în placeholder → PDF QES valid
 *    cloud-signing.mjs:
 *      initiate: buildSignaturePdf + calcPadesHash → hash PAdES trimis la STS
 *      PDF cu placeholder stocat în flows_pdfs (nu JSONB — prea mare)
 *      poll: injectCmsSignature → signedPdfB64 conține PDF semnat real
 *      semnatar 2+: foloseste signedPdfB64 (cu sig anterioara) ca baza
 *    STSCloudProvider: foloseste padesHashBase64 in loc de hash simplu
 *    Trust Report: L1-L6 verificabil dupa implementarea PAdES
 *
 * CHANGES v3.7.6 (build b205, 25.03.2026):
 *  FIX: dupa poll STS signed, redirect complet la URL curat
 *    Cauza: loadFlow() in-page returna date vechi (semnatar inca current)
 *    window.location.replace forteaza fetch fresh — semnatar apare semnat
 *
 * CHANGES v3.7.5 (build b204, 25.03.2026):
 *  FIX BUG-STS-SIGNBYTE: signByte mereu lipsă din raspuns STS
 *    Cauza: cautam signList[i] unde i.id === stsOpId (JWT)
 *    dar STS returneaza signList cu propriul UUID intern, nu JWT-ul nostru
 *    Fix: luam primul element din signList care are signByte prezent
 *    (singleDocumentSigning — intotdeauna un singur element in signList)
 *
 * CHANGES v3.7.4 (build b203, 25.03.2026):
 *  FIX BUG-TLS: ERR_TLS_CERT_ALTNAME_INVALID la token exchange STS
 *    Cauza: b198 inlocuia hostname cu IP in URL -> certificat TLS invalid
 *    Certificatul STS e emis pe hostname (sign.stsisp.ro), nu pe IP
 *    Fix: dns.setDefaultResultOrder('ipv4first') — URL intact, DNS prefera IPv4
 *
 * CHANGES v3.7.3 (build b202, 25.03.2026):
 *  DEBUG: logging detaliat cand signByte lipseste din raspunsul STS
 *    Logam: signListLength, signListIds, eligible, errorCode
 *    pentru a intelege de ce STS nu returneaza signByte
 *
 * CHANGES v3.7.2 (build b201, 25.03.2026):
 *  FIX timeline email extern (flow.html):
 *    - Ordine cronologica corecta: Flux finalizat inainte de email daca asa s-a intamplat
 *    - Email complet afisat (nu trunchiat cu @...)
 *    - Nume expeditor in loc de email (din nameMap: initName + signers names)
 *
 * CHANGES v3.7.1 (build b200, 25.03.2026):
 *  FEAT: EMAIL_SENT + EMAIL_OPENED vizibile in timeline flux (flow.html)
 *    Afiseaza: catre cine, subiect, data trimitere
 *    Sub-pas: 'Deschis de destinatar' cu timestamp (cand pixelul a functionat)
 *    Sortare cronologica a pasilor intermediari dupa timestamp
 *
 * CHANGES v3.7.0 (build b199, 25.03.2026):
 *  FEAT: Badge email extern pe cardul fluxului din Fluxuri mele
 *    Backend: GET /flows/:flowId/email-stats -> { sent, opened, lastSentAt }
 *    Frontend: fetch asincron post-render, badge ✉️ apare doar daca s-a trimis
 *    Badge arata: nr emailuri trimise + nr deschideri (estimativ pixel tracking)
 *    Tooltip cu data ultimului email trimis
 *
 * CHANGES v3.6.8 (build b198, 25.03.2026):
 *  FIX BUG-STS-NET: fetch failed la token exchange STS
 *    Cauza suspectata: Railway outbound IPv6, idp.stsisp.ro nu suporta IPv6
 *    Fix: _fetchIPv4() rezolva DNS hostname explicit la IPv4 (family:4)
 *    si inlocuieste hostname cu IP in URL + seteaza Host header
 *    Aplicat pe toate request-urile STS: verify, token, sign, poll
 *
 * CHANGES v3.6.7 (build b197, 25.03.2026):
 *  DEBUG: logging detaliat pentru fetch failed la token exchange STS
 *    Logam fetchErr.cause.code (ECONNREFUSED/ENOTFOUND/etc) si idpUrl
 *    pentru a determina cauza exacta a erorii de retea pe Railway
 *
 * CHANGES v3.6.6 (build b196, 24.03.2026):
 *  FIX BUG-STS-07: 'PDF lipsa' in callback STS OAuth
 *    Cauza: callback facea SELECT direct din flows (fara JOIN flows_pdfs)
 *    pdfB64 e stocat in flows_pdfs (R-01 arhitectura) nu in JSONB data
 *    Fix: inlocuit SELECT raw cu getFlowData() care face JOIN corect
 *
 * CHANGES v3.6.5 (build b195, 24.03.2026):
 *  FIX BUG-ROUTE-01: GET /flows/sts-oauth-callback returna not_found
 *    Cauza: crudRouter montat primul, Express prindea 'sts-oauth-callback'
 *    ca :flowId parametru -> getFlowData('sts-oauth-callback') -> not_found
 *    Fix: cloudRouter mutat primul in flows/index.mjs
 *    Callback STS OAuth functioneaza acum corect
 *
 * CHANGES v3.6.4 (build b194, 24.03.2026):
 *  FIX BUG-ROOT-01: signing_providers_config mereu gol in DB
 *    Cauza radacina: saveOrgWebhook() nu apela saveOrgSigningProviders()
 *    dupa succes — config STS (clientId, kid, privateKeyPem) nu era
 *    niciodata trimis la server, indiferent cate ori apasai Salveaza
 *    Fix: un singur apel la saveOrgSigningProviders(_currentOrgId)
 *    adaugat in handler-ul de succes al saveOrgWebhook
 *
 * CHANGES v3.6.3 (build b193, 24.03.2026):
 *  FIX: logger.mjs citeste versiunea din package.json direct
 *    npm_package_version nu e setat de Railway → fallback 3.3.4 era mereu afisat
 *    Acum Railway logs arata versiunea corecta dupa fiecare deploy
 *
 * CHANGES v3.6.2 (build b192, 24.03.2026):
 *  FIX CSRF definitiv:
 *    - csrf_token cookie: expiry 2h → 24h (nu mai expira in timpul zilei)
 *    - GET /auth/csrf-token: endpoint nou — emite token proaspat fara side effects
 *    - window._csrfToken: variabila globala init la incarcarea paginii
 *    - Toate paginile (admin, signer, initiator, widget) folosesc getCsrf()
 *    - Retry csrf_invalid: /auth/csrf-token (rapid) → /auth/refresh (fallback)
 *
 * CHANGES v3.6.1 (build b191, 24.03.2026):
 *  DEBUG: logging providerConfig in initiate-cloud-signing
 *    client_id=undefined -> configKeys va arata ce e efectiv in DB
 *
 * CHANGES v3.6.0 (build b190, 24.03.2026):
 *  FIX BUG-STS-06: dupa selectare STS si Continua, aparea tot upload local
 *    Cauza: applyProviderToSignBox verifica p.mode === 'redirect'
 *    dar STSCloudProvider.mode returneaza 'hash-redirect'
 *    Fix: conditie extinsa la mode === 'redirect' || mode === 'hash-redirect'
 *  FIX BUG-CSRF-04: auto-retry CSRF adaugat in semdoc-signer.html si semdoc-initiator.html
 *    Paginile de semnare si initiere flux aveau shim-ul vechi fara auto-retry
 *    Acum toate paginile (admin, signer, initiator) au acelasi mecanism
 *
 * CHANGES v3.5.9 (build b189, 24.03.2026):
 *  FIX BUG-STS-05: STS Cloud aparea in UI dar nu era activat in signing_providers_enabled
 *    Cauza: saveOrgSigningProviders nu adauga sts-cloud in _selectedProviders cand
 *    se salveaza config-ul — endpoint signing-providers returna doar local-upload
 *    Fix: sts-cloud adaugat automat in _selectedProviders la salvarea config-ului
 *
 * CHANGES v3.5.8 (build b188, 24.03.2026):
 *  FIX BUG-CSRF-03: auto-retry csrf_invalid esua si la al 2-lea request
 *    Cauza: document.cookie nu era actualizat la timp dupa /auth/refresh
 *    (SameSite=Strict + timing async = cookie nou invizibil la citire imediata)
 *    Fix server: /auth/refresh returneaza csrfToken si in body JSON
 *    Fix client: notif-widget.js stocheaza _lastCsrfToken din body refresh
 *    Fix client: admin.html shim citeste csrfToken din response refresh
 *    Ambele preferă tokenul din body fata de document.cookie
 *
 * CHANGES v3.5.7 (build b187, 24.03.2026):
 *  FIX: STS verify timeout 8s → 20s (Railway staging latenta mai mare)
 *
 * CHANGES v3.5.6 (build b186, 23.03.2026):
 *  FIX BUG-STS-04: Butonul Verifica returna clientId lipsa desi era completat
 *    verifyProviderConfig() citea orgProviderApiUrl/apiKey (campuri generice)
 *    in loc de campurile STS-specifice (stsClientId, stsKid, stsPrivateKeyPem)
 *    Backend: verify endpoint incarca cheia privata din DB cand campul e gol
 *    (util dupa Salvare — nu trebuie reintrodusa cheia la fiecare Verificare)
 *
 * CHANGES v3.5.5 (build b185, 23.03.2026):
 *  FIX BUG-STS-03: Cheie publica RSA adaugata in configuratia STS
 *    UI: camp nou stsPublicKeyPem in formularul STS (teal, non-sensitiv)
 *    Backend: publicKeyPem inclus in configSafe (returnat complet, non-sensitiv)
 *    Backend: publicKeyPem salvat/restaurat prin acelasi mecanism ca ceilalti
 *    Generator: la generare pereche chei, populeaza si campul de stocare pubkey
 *
 * CHANGES v3.5.4 (build b184, 23.03.2026):
 *  FIX BUG-STS-02: Configuratia STS (clientId, kid, redirectUri) nu se salva/restora
 *    Backend: configSafe returneaza acum campurile non-sensitive STS (clientId, kid,
 *             redirectUri, idpUrl, apiUrl) + hasPrivateKey boolean
 *    Frontend: openProviderConfig repopuleaza campurile STS din configSafe la deschidere
 *    Frontend: saveOrgSigningProviders salveaza toate campurile STS-specifice
 *    Frontend: privateKeyPem trimis doar daca userul introduce o valoare noua
 *             (camp gol = pastreaza cheia existenta din DB)
 *    Frontend: placeholder indica daca exista cheie privata salvata
 *
 * CHANGES v3.5.3 (build b183, 23.03.2026):
 *  FIX BUG-CSRF-02: csrf_invalid nu mai necesita refresh manual al paginii
 *    apiFetch (notif-widget.js + shim admin.html) detecteaza 403 csrf_invalid
 *    si face automat /auth/refresh (care reseteaza csrf_token cookie) + retry
 *    Utilizatorul nu mai vede niciodata eroarea CSRF — totul e transparent
 *
 * CHANGES v3.5.2 (build b182, 23.03.2026):
 *  FIX BUG-JOIN-01: 'Eroare server' la org_admin pe /admin/flows/list
 *    Cauza: LEFT JOIN users u (b172) facea org_id = $1 ambiguu intre
 *    flows.org_id si users.org_id — PostgreSQL returna eroare de ambiguitate
 *    Fix: conditions folosesc f.org_id explicit
 *    Fix: COUNT query foloseste alias f (FROM flows f) pentru consistenta
 *
 * CHANGES v3.5.1 (build b181, 23.03.2026):
 *  FIX BUG-UI-02: genPwd() esua silentios fara mesaj de eroare
 *    Adaugat try/catch + else branch + loading state pe buton
 *    Eroarea (CSRF sau alta) e acum vizibila in campul eMsg din modal
 *
 * CHANGES v3.5.0 (build b180, 23.03.2026):
 *  FIX BUG-UI-01: Butonul Creat din Onboarding Wizard ramanea disabled dupa succes
 *    Dupa creare institutie, butonul e re-enabled si inchide modalul la click
 *    + reincarca lista organizatii
 *
 * CHANGES v3.4.9 (build b179, 23.03.2026):
 *  FIX BUG-CSRF-01: notif-widget.js apiFetch nu adauga CSRF token la POST/PUT/DELETE
 *    Cauza radacina: window.docflow.apiFetch (din widget) suprascria shim-ul din
 *    admin.html — versiunea din widget omitea x-csrf-token pentru mutatii.
 *    Fix: adaugat CSRF injection in notif-widget.js apiFetch (identic cu admin.html).
 *    Afectat: Salvează org, Test Webhook, orice mutatie POST/PUT/DELETE din admin.
 *
 * CHANGES v3.4.8 (build b178, 23.03.2026):
 *  FIX BUG-STS-01: csrfMiddleware eliminat de pe generate-keypair
 *    Endpoint genereaza chei RSA in memorie (zero modificari DB) — CSRF nu e necesar
 *    Cauza: butonul Generează chei returna eroare CSRF care aparea langa Verifică
 *
 * CHANGES v3.4.7 (build b177, 23.03.2026):
 *  UI: Semnatura email outreach — Departamentul tehnic + 0722.663.961
 *
 * CHANGES v3.4.6 (build b176, 23.03.2026):
 *  OUTREACH: Click tracking separat de deschideri (pixel)
 *    DB-040: coloane clicked_at + click_count in outreach_recipients
 *    Backend: click handler populeaza clicked_at/click_count distinct
 *    Backend: query campanii returneaza click_count ca metrica separata
 *    UI: coloana Clickuri in lista campanii + tabel recipients
 *    UI: banner explicativ pixel vs click (fiabilitate)
 *    UI: template conversational nou + 5 subiecte sugerate cu dropdown
 *
 * CHANGES v3.4.5 (build b175, 23.03.2026):
 *  SEC-03: TOTP backup codes stocate ca SHA-256 hash in DB (nu in clar)
 *          backward-compat: coduri plaintext vechi acceptate in continuare
 *  FEAT-06: ETag pe GET /flows/:flowId — cache 30s activ, 1h finalizat
 *           304 Not Modified cand fluxul nu s-a schimbat
 *  README: versiune actualizata la 3.4.5
 *
 * CHANGES v3.4.4 (build b174, 23.03.2026):
 *  UI: Timp mediu finalizare afisat ca 'X h si Y min' in loc de '2.1h'
 *      fmtDuration() adaugata in renderAnalytics() si exportAnalyticsHTML()
 *
 * CHANGES v3.4.3 (build b173, 23.03.2026):
 *  SEC-04: CSRF complet — 3 rute ramase (generate-keypair, gws-provision, send-credentials)
 *  SEC-05: e.message eliminat din 500 responses in toate fisierele (outreach, report, acroform,
 *          cloud-signing, email, auth) — zero expuneri interne in tot proiectul
 *  BUG:    archive-preview exclude fluxuri soft-deleted (deleted_at IS NULL)
 *
 * CHANGES v3.4.2 (build b172, 23.03.2026):
 *  BUG-04: getOptionalActor extras in auth.mjs — eliminat din 4 module flows/ duplicate
 *  BUG-05: Cross-org userMap fix — users filtrati per org_id in admin flows list
 *  PERF-01: LEFT JOIN users in SQL (admin/flows/list) — elimina SELECT ALL users in-memory
 *  SEC-05: e.message eliminat din toate raspunsurile 500 din admin.mjs
 *  FEAT-05: Cleanup notificari citite >90 zile la startup (non-fatal, logged)
 *  FEAT-07: Express upgrade 4.19.2 → 4.22.1 (latest 4.x, security patches)
 *  ARCH-04: pdf-lib import static in sign-trust-report.mjs (eliminat dynamic import)
 *
 * CHANGES v3.4.1 (build b171, 23.03.2026):
 *  SEC-01: flows/clean → soft delete (UPDATE deleted_at) — nu mai stergem fizic
 *  SEC-02: Rate limit 5/min pe POST /verify/signature (endpoint public, CPU-intensiv)
 *  SEC-04: csrfMiddleware adaugat pe 8 rute admin critice (orgs, signing, reset-pwd, etc.)
 *  SEC-05: e.message eliminat din raspunsuri 500 in verify.mjs — logat server-side
 *  BUG-01: Versiune citita din package.json in admin.mjs (nu mai e hardcodata 3.2.2)
 *  BUG-02: COUNT(*) flows cu deleted_at IS NULL in toate stats endpoints
 *  BUG-03: Date filter pe coloana TIMESTAMPTZ created_at (nu JSONB string)
 *  ARCH-01: Sters flows.legacy.mjs (2260 linii cod mort, -130KB din repo)
 *  ARCH-05: .railwayignore actualizat — tools/*.json/pdf/py excluse din deployment
 *  DB-039:  GIN index pe data->'signers' pentru STS OAuth callback (PERF-04)
 *
 * CHANGES v3.4.0 (build b170, 23.03.2026):
 *  FIX BUG-PDF-01: 413 Content Too Large la reinitiate-review si upload-signed-pdf
 *                  app-level express.json({limit:1mb}) respingea body INAINTE ca
 *                  route-level _largePdf sa ruleze. Fix: middleware adaptiv per path.
 *
 * CHANGES v3.3.9 (build din 20.03.2026):
 *  FIX SEC-02:  rawBody middleware pentru HMAC real pe /signing-callback
 *
 * CHANGES v3.3.8 (build din 20.03.2026):
 *  FIX BUG-01:  chainOk is not defined — crash la generare trust report
 *  FIX BUG-01b: Cache trust_reports ignorat — regenerare inutila la fiecare cerere
 *  FIX BUG-03:  createFlow fara requireAuth
 *  FIX BUG-04:  Stack trace expus in raspuns 500 la /report
 *  OPT-05:      Buton Raport conformitate adaugat in pagina semnatarului
 *  OPT-07:      Dynamic import → static import in report.mjs
 *  DB-033:      Migrare trust_reports — coloana report_pdf BYTEA pentru cache PDF
 *
 * CHANGES v3.3.7 b80:
 *  FIX BUG-N01: archive_jobs recovery la startup (status='processing' > 30min → reset 'pending')
 *  FIX BUG-N03: Swagger /api-docs + /api-docs.json protejate cu autentificare
 *  FIX CODE-N02: APP_VERSION citit din package.json (single source of truth)
 *  FIX PERF-04: Pool DB max: 10 → 20, idleTimeoutMillis: 30000
 */

import express from 'express';
import { readFileSync } from 'fs';
import cookieParser from 'cookie-parser';
import cors from 'cors';
import helmet from 'helmet';
import pg from 'pg';
import crypto from 'crypto';
import path from 'path';
import http from 'http';
import { fileURLToPath } from 'url';

// CODE-N02: versiune citită din package.json — single source of truth
const _pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url)));
const APP_VERSION = _pkg.version;

import { sendSignerEmail } from './mailer.mjs';
import { sendWaSignRequest, sendWaCompleted, sendWaRefused, isWhatsAppConfigured } from './whatsapp.mjs';
import { archiveFlow, verifyDrive } from './drive.mjs';
import jwt from 'jsonwebtoken';
import { WebSocketServer } from 'ws';
import { pushToUser } from './push.mjs';
import { fireWebhook, injectWebhookPool, injectWebhookBaseUrl } from './webhook.mjs';
import { emailYourTurn, emailGeneric } from './emailTemplates.mjs';
import { logger } from './middleware/logger.mjs';
import { incCounter, setGauge, renderMetrics } from './middleware/metrics.mjs';

let PDFLib = null;
try { PDFLib = await import('pdf-lib'); } catch(e) { logger.warn({ err: e }, 'pdf-lib not available - flow stamp disabled'); }

import { pool, DB_READY, DB_LAST_ERROR, initDbWithRetry, saveFlow, getFlowData, requireDb } from './db/index.mjs';
import { JWT_SECRET, JWT_EXPIRES, requireAuth, requireAdmin, hashPassword, verifyPassword, generatePassword, sha256Hex, escHtml, injectTokenVersionChecker } from './middleware/auth.mjs';

import authRouter from './routes/auth.mjs';
import { openApiSpec } from './swagger.mjs';
import { injectRateLimiter } from './routes/auth.mjs';
import { createRateLimiter } from './middleware/rateLimiter.mjs';
import { injectAdminRateLimiter } from './middleware/auth.mjs';
import notifRouter, { injectWsPush } from './routes/notifications.mjs';
import adminRouter, { injectWsSize } from './routes/admin.mjs';
import flowsRouter, { injectFlowDeps } from './routes/flows/index.mjs'; // ARCH-01: modularizat
import verifyRouter  from './routes/verify.mjs';
import reportRouter  from './routes/report.mjs';
import outreachRouter from './routes/admin/outreach.mjs';
import templatesRouter from './routes/templates.mjs';
import totpRouter from './routes/totp.mjs';     // 2FA TOTP // Q-06: extras din index.mjs

const app = express();
app.set('trust proxy', 1);

// SEC-01: cookie-parser — necesár pentru req.cookies.auth_token (JWT HttpOnly)
app.use(cookieParser());

// ── Security headers ──────────────────────────────────────────────────────
// Fallback manual dacă helmet nu e instalat încă (graceful degradation)
try {
  app.use(helmet({
    hidePoweredBy: true,  // ascunde X-Powered-By: Express (fingerprinting prevention)
    // SEC-05: CSP activat — protecție XSS
    contentSecurityPolicy: {
      directives: {
        defaultSrc:  ["'self'"],
        // SEC-03: nonce-based CSP — elimina 'unsafe-inline' din scriptSrc
        // scriptSrcAttr pastreaza 'unsafe-inline' pentru onclick= etc. (130+ handlere in admin.html)
        // Eliminarea completa a inline handlers ramane ca tech debt — sprint dedicat
        scriptSrc:    ["'self'", "'unsafe-inline'", 'https://unpkg.com', 'https://cdn.jsdelivr.net', 'https://cdnjs.cloudflare.com'],
        styleSrc:     ["'self'", "'unsafe-inline'"],
        scriptSrcAttr:["'unsafe-inline'"],
        imgSrc:      ["'self'", 'data:', 'blob:'],
        connectSrc:  ["'self'", 'wss:', 'ws:'],
        objectSrc:   ["'none'"],
        frameAncestors: ["'none'"],           // previne clickjacking (înlocuiește X-Frame-Options)
        upgradeInsecureRequests: [],
      },
    },
    crossOriginEmbedderPolicy: false,         // necesar pentru PDF viewer blob:
    frameguard: { action: 'deny' },           // X-Frame-Options: DENY
  }));
} catch(e) {
  logger.warn('helmet not installed - adaug manual security headers');
}
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  next();
});

// ── CORS ──────────────────────────────────────────────────────────────────
// FIX v3.2.2: origin:true cu credentials:true e periculos (accept orice domeniu).
// Fallback la domeniu explicit din PUBLIC_BASE_URL dacă CORS_ORIGIN nu e setat.
// FIX Q-01: fallback false în loc de true — blochează origini necunoscute.
//           Dacă nici CORS_ORIGIN nici PUBLIC_BASE_URL nu sunt setate în producție,
//           se loghează WARN (nu exit — Railway poate restarta înainte de env inject).
const corsOrigins = process.env.CORS_ORIGIN
  ? process.env.CORS_ORIGIN.split(',').map(o => o.trim())
  : (process.env.PUBLIC_BASE_URL ? [process.env.PUBLIC_BASE_URL.replace(/\/$/, '')] : false);
// Adaugam intotdeauna docflowai.ro pentru formularul de contact de pe landing
const corsOriginsWithLanding = Array.isArray(corsOrigins)
  ? [...new Set([...corsOrigins, 'https://docflowai.ro', 'https://www.docflowai.ro'])]
  : corsOrigins;
if (corsOrigins === false) {
  logger.warn('CORS_ORIGIN și PUBLIC_BASE_URL lipsesc — CORS blocat pentru toate originile externe. Setați cel puțin PUBLIC_BASE_URL.');
}
app.use(cors({ origin: corsOriginsWithLanding, credentials: true }));

// SEC-02: rawBody capture pentru HMAC real pe /signing-callback
// Trebuie să ruleze ÎNAINTE de express.json(), altfel body e deja parsat și bytes originali pierduți.
// Se salvează în req.rawBody DOAR pentru endpoint-ul callback — nu pentru tot traficul.
app.use((req, res, next) => {
  if (req.path && req.path.includes('/signing-callback')) {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => {
      req.rawBody = Buffer.concat(chunks);
      // Re-parse JSON manual ca să nu rupem express.json() downstream
      if (req.headers['content-type']?.includes('application/json') && req.rawBody.length > 0) {
        try { req.body = JSON.parse(req.rawBody.toString('utf8')); } catch { req.body = {}; }
      }
      next();
    });
    req.on('error', next);
  } else {
    next();
  }
});

// PERF-03: limita globala 1MB — previne body flood pe endpoint-urile cu JSON mic.
// FIX BUG-PDF-01: route-level expressJson({ limit:'50mb' }) NU funcționează dacă
// app-level parser a respins deja body-ul cu 413 înainte ca ruta să ruleze.
// Soluție: middleware adaptiv — detectăm path-urile PDF și aplicăm limita corectă.
const _LARGE_PDF_PATHS = [
  '/reinitiate-review',   // POST — upload document revizuit după review
  '/upload-signed-pdf',   // POST — upload PDF semnat de semnatar
  '/signing-callback',    // POST — callback provider cloud signing
  '/sign',                // POST — poate conține signedPdfB64
];
app.use((req, res, next) => {
  const needsLarge = _LARGE_PDF_PATHS.some(p => (req.path || '').includes(p));
  return express.json({ limit: needsLarge ? '50mb' : '1mb' })(req, res, next);
});

// ── Request ID + safe JSON error envelope ─────────────────────────────────
app.use((req, res, next) => {
  req.requestId = crypto.randomUUID();
  res.setHeader('x-request-id', req.requestId);
  const _json = res.json.bind(res);
  res.json = (body) => {
    try { if (body && typeof body === 'object' && body.error && !body.requestId) return _json({ ...body, requestId: req.requestId }); } catch(e) {}
    return _json(body);
  };
  next();
});

// ── Request log structurat ────────────────────────────────────────────────
app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    const ms = Date.now() - start;
    const lvl = res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info';
    logger[lvl]({
      method: req.method,
      url: req.originalUrl,
      status: res.statusCode,
      ms,
      requestId: req.requestId,
      ip: req.ip,
    }, 'request');
    incCounter('http_requests_total', { method: req.method, status_class: `${Math.floor(res.statusCode / 100)}xx` });
  });
  next();
});

process.on('unhandledRejection', (err) => logger.error({ err }, 'unhandledRejection'));
process.on('uncaughtException',  (err) => logger.error({ err }, 'uncaughtException'));

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PUBLIC_DIR = path.join(__dirname, '../public');
app.use(express.static(PUBLIC_DIR));

// SEC-03: sendHtmlWithNonce eliminat — revenit la sendFile simplu

app.get('/', (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'semdoc-initiator.html')));
app.get('/login', (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'login.html')));
app.get('/admin', (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'admin.html')));
app.get('/notifications', (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'notifications.html')));
app.get('/verifica', (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'verifica.html')));
app.get('/templates', (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'templates.html')));

// ── Health public ─────────────────────────────────────────────────────────
// ── API Docs — OpenAPI 3.0 ───────────────────────────────────────────────────
// GET /api-docs.json — spec JSON brut (Postman, Insomnia, integrări externe) — auth required
// GET /api-docs      — Swagger UI interactiv (browser) — auth required
// BUG-N03: protejat cu cookie auth — structura API nu trebuie expusă public
// FIX Q-02: verificare JWT completă (verify), nu doar existența cookie-ului.
//           Un cookie expirat sau manipulat era suficient pentru acces înainte.
function _isApiDocsAuthed(req) {
  const token = req.cookies?.auth_token;
  if (!token) return false;
  try { jwt.verify(token, JWT_SECRET); return true; } catch(e) { return false; }
}

app.get('/api-docs.json', (req, res) => {
  if (!_isApiDocsAuthed(req)) {
    return res.status(401).json({ error: 'auth_required', message: 'Autentificare necesară pentru API docs.' });
  }
  res.setHeader('Content-Type', 'application/json');
  res.json(openApiSpec);
});

app.get('/api-docs', (req, res) => {
  if (!_isApiDocsAuthed(req)) {
    return res.redirect('/login.html?redirect=/api-docs');
  }
  // URL relativ — funcționează pe orice domeniu fără a depinde de publicBaseUrl
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(`<!DOCTYPE html>
<html lang="ro">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>DocFlowAI API Docs</title>
  <link rel="stylesheet" href="https://unpkg.com/swagger-ui-dist@5/swagger-ui.css">
  <style>
    body { margin: 0; }
    .topbar { display: none !important; }
  </style>
</head>
<body>
  <div id="swagger-ui"></div>
  <script src="https://unpkg.com/swagger-ui-dist@5/swagger-ui-bundle.js"></script>
  <script>
    SwaggerUIBundle({
      url: '/api-docs.json',
      dom_id: '#swagger-ui',
      presets: [SwaggerUIBundle.presets.apis, SwaggerUIBundle.SwaggerUIStandalonePreset],
      layout: 'BaseLayout',
      deepLinking: true,
      defaultModelsExpandDepth: 1,
      defaultModelExpandDepth: 1,
    });
  </script>
</body>
</html>`);
});

app.get('/health', (req, res) => {
  const mem = process.memoryUsage();
  res.json({
    ok: true,
    service: 'DocFlowAI',
    version: APP_VERSION,
    ts: new Date().toISOString(),
    uptime: Math.floor(process.uptime()),
    memory: {
      rss: Math.round(mem.rss / 1024 / 1024) + 'MB',
      heapUsed: Math.round(mem.heapUsed / 1024 / 1024) + 'MB',
      heapTotal: Math.round(mem.heapTotal / 1024 / 1024) + 'MB',
    },
  });
});

// ── GET /admin/reminder-status — status job reminder si configuratie ────────
app.get('/admin/reminder-status', async (req, res) => {
  try {
    const actor = req.cookies?.auth_token ? (() => { try { return jwt.verify(req.cookies.auth_token, JWT_SECRET); } catch { return null; } })() : null;
    if (!actor || (actor.role !== 'admin' && actor.role !== 'org_admin'))
      return res.status(403).json({ error: 'forbidden' });

    let pendingCount = 0, overdueCount = 0;
    if (pool && DB_READY) {
      try {
        const orgFilter = actor.role === 'org_admin' ? `AND (data->>'orgId')::int = ${Number(actor.orgId)}` : '';
        const { rows } = await pool.query(`
          SELECT COUNT(*) FILTER (
            WHERE (data->>'completed') IS DISTINCT FROM 'true'
            AND (data->>'status') NOT IN ('cancelled','refused')
            AND deleted_at IS NULL
          ) AS pending,
          COUNT(*) FILTER (
            WHERE (data->>'completed') IS DISTINCT FROM 'true'
            AND (data->>'status') NOT IN ('cancelled','refused')
            AND deleted_at IS NULL
            AND updated_at < NOW() - INTERVAL '24 hours'
          ) AS overdue
          FROM flows WHERE 1=1 ${orgFilter}
        `);
        pendingCount = parseInt(rows[0]?.pending || 0);
        overdueCount = parseInt(rows[0]?.overdue || 0);
      } catch(e) { /* non-fatal */ }
    }

    res.json({
      ok: true,
      config: {
        intervalH:  parseInt(process.env.REMINDER_INTERVAL_HOURS || '6'),
        reminder1H: parseInt(process.env.REMINDER_1_HOURS || '24'),
        reminder2H: parseInt(process.env.REMINDER_2_HOURS || '48'),
        reminder3H: parseInt(process.env.REMINDER_3_HOURS || '72'),
      },
      stats: { pendingFlows: pendingCount, overdueFlows: overdueCount },
    });
  } catch(e) { res.status(500).json({ error: 'server_error' }); }
});

app.get('/admin/health', async (req, res) => {
  if (await requireAdmin(req, res)) return;
  let dbLatencyMs = null;
  if (pool && DB_READY) {
    const t0 = Date.now();
    try { await pool.query('SELECT 1'); dbLatencyMs = Date.now() - t0; } catch(_) {}
  }
  const mem = process.memoryUsage();
  res.json({
    ok: true,
    service: 'DocFlowAI',
    version: APP_VERSION,
    dbReady: !!DB_READY,
    dbLatencyMs,
    dbLastError: DB_LAST_ERROR ? String(DB_LAST_ERROR?.message || DB_LAST_ERROR) : null,
    wsClients: wsClients.size,
    uptime: Math.floor(process.uptime()),
    memory: {
      rss: Math.round(mem.rss / 1024 / 1024) + 'MB',
      heapUsed: Math.round(mem.heapUsed / 1024 / 1024) + 'MB',
    },
    ts: new Date().toISOString(),
  });
});

// ── METRICS-01: /metrics — Prometheus scrape endpoint ────────────────────
// Implicit: admin-only. Setați ENV METRICS_PUBLIC=1 pentru scrape extern.
app.get('/metrics', async (req, res) => {
  const isPublic = process.env.METRICS_PUBLIC === '1';
  if (!isPublic && await requireAdmin(req, res)) return;
  // Actualizăm gauge-ul WS clients înainte de render
  setGauge('ws_clients', wsClients.size);
  res.setHeader('Content-Type', 'text/plain; version=0.0.4; charset=utf-8');
  res.send(renderMetrics());
});

// ── Helpers ────────────────────────────────────────────────────────────────
// Q-06: Template API extras în server/routes/templates.mjs (montat mai jos)
// FIX v3.3.2: escHtml importat din middleware/auth.mjs — eliminat duplicatul local

function publicBaseUrl(req) {
  const envBase = process.env.PUBLIC_BASE_URL;
  if (envBase) return envBase.replace(/\/$/, '');
  const host = req.get('host');
  const proto = (req.get('x-forwarded-proto') || req.protocol || 'https').split(',')[0].trim();
  return `${proto}://${host}`;
}
function makeFlowId(institutie) {
  const words = (institutie || '').trim().split(/\s+/).filter(Boolean);
  const initials = words.length >= 2 ? words.slice(0, 4).map(w => w[0].toUpperCase()).join('') : (words[0] ? words[0].slice(0, 3).toUpperCase() : 'DOC');
  const rand = crypto.randomBytes(5).toString('hex').toUpperCase();
  return `${initials}_${rand}`;
}
function newFlowId(institutie) { return makeFlowId(institutie); }
function buildSignerLink(req, flowId, token) {
  return `${publicBaseUrl(req)}/semdoc-signer.html?flow=${encodeURIComponent(flowId)}&token=${encodeURIComponent(token)}`;
}
function stripPdfB64(data) {
  if (!data || typeof data !== 'object') return data;
  const { pdfB64, signedPdfB64, ...rest } = data;
  return { ...rest, hasPdf: !!pdfB64, hasSignedPdf: !!signedPdfB64 };
}
function stripSensitive(data, callerSignerToken = null) {
  if (!data || typeof data !== 'object') return data;
  const { pdfB64, signedPdfB64, ...rest } = data;
  return {
    ...rest, hasPdf: !!pdfB64,
    hasSignedPdf: !!(signedPdfB64 || (data.storage === 'drive' && (data.driveFileLinkFinal || data.driveFileIdFinal))),
    signers: (data.signers || []).map(s => {
      const { token, ...signerRest } = s;
      return callerSignerToken && s.token === callerSignerToken ? { ...signerRest, token } : signerRest;
    }),
  };
}

const SIGNER_TOKEN_EXPIRY_DAYS = parseInt(process.env.SIGNER_TOKEN_EXPIRY_DAYS || '90');
function isSignerTokenExpired(signer) {
  if (!signer.tokenCreatedAt) return false;
  const created = new Date(signer.tokenCreatedAt).getTime();
  return (Date.now() - created) > SIGNER_TOKEN_EXPIRY_DAYS * 24 * 60 * 60 * 1000;
}

// ── Stamp footer helper ────────────────────────────────────────────────────
// Footer stamp — linia de identificare pe ultima pagina.
// Pentru flowType 'ancore': salvare cu useObjectStreams:false pentru a nu degrada AcroForm/campuri semnatura.
// Pentru flowType 'tabel': comportament implicit (useObjectStreams:true).
async function stampFooterOnPdf(pdfB64, flowData) {
  if (!pdfB64 || !PDFLib) return pdfB64;
  try {
    const { PDFDocument, PDFName, PDFNumber, PDFString, rgb, StandardFonts } = PDFLib;
    const diacr = {'ă':'a','â':'a','î':'i','ș':'s','ț':'t','Ă':'A','Â':'A','Î':'I','Ș':'S','Ț':'T','ş':'s','ţ':'t','Ş':'S','Ţ':'T'};
    function ro(t) { return String(t || '').split('').map(ch => diacr[ch] || ch).join(''); }
    const clean = pdfB64.includes(',') ? pdfB64.split(',')[1] : pdfB64;
    const pdfDoc = await PDFDocument.load(Buffer.from(clean, 'base64'), { ignoreEncryption: true });
    const fontR = await pdfDoc.embedFont(StandardFonts.Helvetica);
    const fontB = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
    const lastPage = pdfDoc.getPages()[pdfDoc.getPageCount() - 1];
    const { width: pW, height: pH } = lastPage.getSize();
    const MARGIN = 40, footerY = 14, FONT_SIZE = 7;
    const createdDate = flowData.createdAt
      ? new Date(flowData.createdAt).toLocaleString('ro-RO', { timeZone: 'Europe/Bucharest' })
      : new Date().toLocaleString('ro-RO', { timeZone: 'Europe/Bucharest' });
    const parts = [ro(flowData.initName || ''), flowData.initFunctie ? ro(flowData.initFunctie) : null, flowData.institutie ? ro(flowData.institutie) : null, flowData.compartiment ? ro(flowData.compartiment) : null].filter(Boolean).join(', ');
    const footerLeft = createdDate + (parts ? '  |  ' + parts : '');
    const footerRight = ro(flowData.flowId || '') + '  |  DocFlowAI';
    const rightWidth = fontR.widthOfTextAtSize(footerRight, FONT_SIZE);
    const rightX = pW - MARGIN - rightWidth;
    const leftMaxWidth = rightX - MARGIN - 8;
    lastPage.drawLine({ start: { x: MARGIN, y: footerY + 10 }, end: { x: pW - MARGIN, y: footerY + 10 }, thickness: 0.4, color: rgb(0.75, 0.75, 0.75) });
    lastPage.drawText(footerLeft, { x: MARGIN, y: footerY, size: FONT_SIZE, font: fontR, color: rgb(0.5, 0.5, 0.5), opacity: 0.8, maxWidth: leftMaxWidth });
    lastPage.drawText(footerRight, { x: rightX, y: footerY, size: FONT_SIZE, font: fontR, color: rgb(0.5, 0.5, 0.5), opacity: 0.8 });

    // ── CARTUȘ VIZUAL + câmpuri AcroForm /Sig per semnatar (pentru STS PAdES) ─
    // Generat server-side O SINGURĂ DATĂ la creare flux.
    // Câmpurile /Sig sunt necesare pentru PAdES valid (incremental update).
    // Upload local: câmpurile /Sig sunt ignorate (utilizatorul semnează cu aplicație proprie).
    const signers = Array.isArray(flowData.signers) ? flowData.signers : [];
    const signersFieldNames = {};

    if (signers.length > 0 && flowData.flowType !== 'ancore') {
      const n     = signers.length;
      const cols  = Math.min(n, 3);
      const rows  = Math.ceil(n / cols);
      const cellW = (pW - MARGIN * 2) / cols;
      const cellH = 48;
      const titleH = 20;
      const cartusBottom = 36;
      const cartusH = rows * cellH + titleH;

      // Pagina nouă pentru cartuș
      const cartusPage = pdfDoc.addPage([pW, pH]);

      // Footer pe pagina cartuș
      cartusPage.drawLine({ start: { x: MARGIN, y: footerY + 10 }, end: { x: pW - MARGIN, y: footerY + 10 }, thickness: 0.4, color: rgb(0.75, 0.75, 0.75) });
      cartusPage.drawText(footerLeft, { x: MARGIN, y: footerY, size: FONT_SIZE, font: fontR, color: rgb(0.5, 0.5, 0.5), opacity: 0.8, maxWidth: leftMaxWidth });
      cartusPage.drawText(footerRight, { x: rightX, y: footerY, size: FONT_SIZE, font: fontR, color: rgb(0.5, 0.5, 0.5), opacity: 0.8 });

      // Bară titlu cartuș
      cartusPage.drawRectangle({ x: MARGIN, y: cartusBottom + cartusH - titleH, width: pW - MARGIN * 2, height: titleH, color: rgb(1,1,1), borderColor: rgb(0,0,0), borderWidth: 0.8 });
      cartusPage.drawText('SEMNAT SI APROBAT', { x: MARGIN + 8, y: cartusBottom + cartusH - titleH + 6, size: 7, font: fontB, color: rgb(0,0,0) });

      // AcroForm pentru câmpurile /Sig
      let acroForm;
      const acroFormRef = pdfDoc.catalog.get(PDFName.of('AcroForm'));
      if (acroFormRef) {
        acroForm = pdfDoc.context.lookup(acroFormRef);
        try { acroForm.set(PDFName.of('SigFlags'), PDFNumber.of(3)); } catch(e2) {}
      } else {
        const afObj = pdfDoc.context.obj({ Fields: pdfDoc.context.obj([]), SigFlags: PDFNumber.of(3), DA: PDFString.of('/Helv 0 Tf 0 g') });
        pdfDoc.catalog.set(PDFName.of('AcroForm'), pdfDoc.context.register(afObj));
        acroForm = afObj;
      }

      signers.forEach((s, idx) => {
        const row = Math.floor(idx / cols);
        const col = idx % cols;
        const cx  = MARGIN + col * cellW;
        const cy  = cartusBottom + (rows - 1 - row) * cellH;

        // Celulă vizuală
        cartusPage.drawRectangle({ x: cx, y: cy, width: cellW, height: cellH, color: rgb(.96,.96,.96), borderColor: rgb(.2,.2,.2), borderWidth: 1 });
        cartusPage.drawRectangle({ x: cx+1.5, y: cy+1.5, width: cellW-3, height: cellH-3, color: rgb(.96,.96,.96), borderColor: rgb(.2,.2,.2), borderWidth: .35 });
        cartusPage.drawText(ro(s.rol) || '—', { x: cx+6, y: cy+cellH-13, size: 7, font: fontB, color: rgb(.1,.1,.1), maxWidth: cellW-12 });
        const nameFunc = [ro(s.name), ro(s.functie)].filter(Boolean).join(' - ');
        if (nameFunc) cartusPage.drawText(nameFunc, { x: cx+6, y: cy+cellH-24, size: 7, font: fontR, color: rgb(.1,.1,.1), maxWidth: cellW-12 });
        const midY = cy + cellH/2 - 6;
        cartusPage.drawText('L.S.', { x: cx+6, y: midY+4, size: 6.5, font: fontB, color: rgb(.5,.5,.6) });
        cartusPage.drawText('Semnatura electronica', { x: cx+6, y: midY-5, size: 5.5, font: fontR, color: rgb(.6,.6,.6), maxWidth: cellW-12 });

        // Câmp AcroForm /Sig vizibil în celulă — necesar pentru PAdES
        const fieldName = `SIG_${(s.rol||'SEM').replace(/[^A-Za-z0-9]/g,'_').toUpperCase()}_${idx+1}`;
        signersFieldNames[idx] = fieldName;
        const sigRect = [cx, cy, cx + cellW, cy + cellH];
        const widgetRef = pdfDoc.context.register(pdfDoc.context.obj({
          Type: PDFName.of('Annot'), Subtype: PDFName.of('Widget'), FT: PDFName.of('Sig'),
          T: PDFString.of(fieldName),
          Rect: pdfDoc.context.obj(sigRect.map(n2 => PDFNumber.of(n2))),
          F: PDFNumber.of(132), P: cartusPage.ref,
        }));
        const ea = cartusPage.node.get(PDFName.of('Annots'));
        if (ea) { try { pdfDoc.context.lookup(ea).push(widgetRef); } catch(e2) { cartusPage.node.set(PDFName.of('Annots'), pdfDoc.context.obj([widgetRef])); } }
        else cartusPage.node.set(PDFName.of('Annots'), pdfDoc.context.obj([widgetRef]));
        try {
          const fref = acroForm.get(PDFName.of('Fields'));
          if (fref) pdfDoc.context.lookup(fref).push(widgetRef);
          else acroForm.set(PDFName.of('Fields'), pdfDoc.context.obj([widgetRef]));
        } catch(e2) {}
      });
    }

    const isAncore = flowData.flowType === 'ancore';
    const pdfBytes = Buffer.from(await pdfDoc.save({ useObjectStreams: !isAncore })).toString('base64');

    if (Object.keys(signersFieldNames).length > 0) {
      return { pdfB64: pdfBytes, signersFieldNames };
    }
    return pdfBytes;
  } catch(e) { logger.warn({ err: e }, 'stampFooterOnPdf error (non-fatal)'); return pdfB64; }
}

// ── WebSocket ──────────────────────────────────────────────────────────────
const wsClients = new Map();
function wsRegister(email, ws) { if (!wsClients.has(email)) wsClients.set(email, new Set()); wsClients.get(email).add(ws); }
function wsUnregister(email, ws) { wsClients.get(email)?.delete(ws); if (wsClients.get(email)?.size === 0) wsClients.delete(email); }
function wsPush(email, payload) {
  const conns = wsClients.get(email.toLowerCase()); if (!conns) return;
  const msg = JSON.stringify(payload);
  for (const ws of conns) { try { if (ws.readyState === 1) ws.send(msg); } catch(e) {} }
}

// ── Rate limiter (auth) ────────────────────────────────────────────────────
const LOGIN_MAX = parseInt(process.env.LOGIN_MAX || '10');
const LOGIN_WINDOW = parseInt(process.env.LOGIN_WINDOW_SEC || String(15 * 60));
const LOGIN_BLOCK = parseInt(process.env.LOGIN_BLOCK_SEC || String(15 * 60));

function loginRateKey(req, email) { return `${req.ip || ''}:${(email || '').toLowerCase()}`; }
async function checkLoginRate(req, email) {
  if (!pool || !DB_READY) return { blocked: false };
  const key = loginRateKey(req, email);
  try {
    const { rows } = await pool.query('SELECT count, first_at, blocked_until FROM login_blocks WHERE key=$1', [key]);
    if (!rows.length) return { blocked: false };
    const { blocked_until } = rows[0];
    if (blocked_until && new Date(blocked_until) > new Date()) { const remainSec = Math.ceil((new Date(blocked_until) - Date.now()) / 1000); return { blocked: true, remainSec }; }
    return { blocked: false };
  } catch(e) { logger.error({ err: e }, 'checkLoginRate error'); return { blocked: false }; }
}
async function recordLoginFail(req, email) {
  if (!pool || !DB_READY) return;
  const key = loginRateKey(req, email);
  try {
    await pool.query(`
      INSERT INTO login_blocks (key, count, first_at, updated_at) VALUES ($1, 1, NOW(), NOW())
      ON CONFLICT (key) DO UPDATE
        SET count = CASE WHEN login_blocks.first_at < NOW() - ($2 || ' seconds')::INTERVAL THEN 1 ELSE login_blocks.count + 1 END,
            first_at = CASE WHEN login_blocks.first_at < NOW() - ($2 || ' seconds')::INTERVAL THEN NOW() ELSE login_blocks.first_at END,
            blocked_until = CASE WHEN (CASE WHEN login_blocks.first_at < NOW() - ($2 || ' seconds')::INTERVAL THEN 1 ELSE login_blocks.count + 1 END) >= $3 THEN NOW() + ($4 || ' seconds')::INTERVAL ELSE NULL END,
            updated_at = NOW()
    `, [key, LOGIN_WINDOW, LOGIN_MAX, LOGIN_BLOCK]);
  } catch(e) { logger.error({ err: e }, 'recordLoginFail error'); }
}
async function clearLoginRate(req, email) {
  if (!pool || !DB_READY) return;
  try { await pool.query('DELETE FROM login_blocks WHERE key=$1', [loginRateKey(req, email)]); } catch(e) {}
}
const _loginBlocksCleanupInterval = setInterval(async () => {
  if (!pool || !DB_READY) return;
  try {
    const { rowCount } = await pool.query(`DELETE FROM login_blocks WHERE (blocked_until IS NULL OR blocked_until < NOW()) AND first_at < NOW() - ($1 || ' seconds')::INTERVAL`, [LOGIN_WINDOW * 2]);
    if (rowCount > 0) logger.info({ rowCount }, 'login_blocks: intrari expirate sterse');
  } catch(e) {}
}, 30 * 60 * 1000);

// ── R-04: Reminder automat semnatari inactivi ─────────────────────────────
// Configurabil via ENV: REMINDER_INTERVAL_HOURS (default: 24h), REMINDER_INACTIVITY_DAYS (default: 3)
// Trimite notificare REMINDER semnatarului curent dacă fluxul nu a avut activitate în N zile.
// ── R-04: Reminder automat — niveluri multiple (24h / 48h / 72h escaladare)
// ENV: REMINDER_INTERVAL_HOURS (default: 6h — cat de des verificam)
//      REMINDER_1_HOURS (default: 24), REMINDER_2_HOURS (default: 48), REMINDER_3_HOURS (default: 72)
const REMINDER_INTERVAL_MS = (parseInt(process.env.REMINDER_INTERVAL_HOURS || '6') * 3600_000);
const R1_MS = (parseInt(process.env.REMINDER_1_HOURS || '24') * 3600_000);
const R2_MS = (parseInt(process.env.REMINDER_2_HOURS || '48') * 3600_000);
const R3_MS = (parseInt(process.env.REMINDER_3_HOURS || '72') * 3600_000);

async function _runReminderJob() {
  if (!pool || !DB_READY) return;
  try {
    const cutoff1 = new Date(Date.now() - R1_MS).toISOString();
    const { rows } = await pool.query(
      `SELECT id, data FROM flows
       WHERE (data->>'completed') IS DISTINCT FROM 'true'
         AND (data->>'status') NOT IN ('refused','cancelled','review_requested')
         AND updated_at < $1
       LIMIT 300`,
      [cutoff1]
    );
    let reminded = 0;
    for (const row of rows) {
      const data = row.data;
      const flowId = row.id;
      const current = (data.signers || []).find(s => s.status === 'current');
      if (!current?.email) continue;

      const { rows: sentRows } = await pool.query(
        `SELECT COUNT(*) AS cnt FROM notifications WHERE user_email=$1 AND flow_id=$2 AND type='REMINDER'`,
        [current.email.toLowerCase(), flowId]
      );
      const sentCount = parseInt(sentRows[0]?.cnt || '0');

      const { rows: lastRows } = await pool.query(
        `SELECT created_at FROM notifications WHERE user_email=$1 AND flow_id=$2 AND type='REMINDER'
         ORDER BY created_at DESC LIMIT 1`,
        [current.email.toLowerCase(), flowId]
      );
      const lastSentAt = lastRows[0]?.created_at ? new Date(lastRows[0].created_at).getTime() : 0;
      // FIX Q-04: fallback la data crearii fluxului, nu la Date.now()-R1_MS.
      // Anterior: daca notifiedAt lipsea, inactiveMs era exact R1_MS => reminder trimis imediat
      // chiar si pe fluxuri create cu cateva minute in urma.
      const inactiveSince = current.notifiedAt
        ? new Date(current.notifiedAt).getTime()
        : new Date(data.createdAt || Date.now()).getTime();
      const inactiveMs = Date.now() - inactiveSince;
      const minGap = R1_MS - 3600_000; // anti-spam: minim R1-1h intre remindere

      if (sentCount === 0 && inactiveMs >= R1_MS && (Date.now() - lastSentAt) > minGap) {
        await notify({ userEmail: current.email, flowId, type: 'REMINDER',
          title: '⏳ Document în așteptare',
          message: `Documentul „${data.docName}" așteaptă semnătura ta de mai mult de 24 de ore.`,
          waParams: { signerName: current.name || current.email, docName: data.docName, signerToken: current.token, initName: data.initName, initFunctie: data.initFunctie, institutie: data.institutie, compartiment: data.compartiment },
          urgent: false });
        reminded++;
      } else if (sentCount === 1 && inactiveMs >= R2_MS && (Date.now() - lastSentAt) > minGap) {
        await notify({ userEmail: current.email, flowId, type: 'REMINDER',
          title: '⚠️ Acțiune necesară — document nesemnat',
          message: `Documentul „${data.docName}" este nesemnat de 2 zile. Te rugăm să acționezi.`,
          waParams: { signerName: current.name || current.email, docName: data.docName, signerToken: current.token, initName: data.initName, initFunctie: data.initFunctie, institutie: data.institutie, compartiment: data.compartiment },
          urgent: false });
        reminded++;
      } else if (sentCount === 2 && inactiveMs >= R3_MS && (Date.now() - lastSentAt) > minGap) {
        await notify({ userEmail: current.email, flowId, type: 'REMINDER',
          title: '🚨 Flux blocat — 3 zile fără acțiune',
          message: `Documentul „${data.docName}" este blocat de 3 zile. Semnează sau delegă urgent.`,
          waParams: { signerName: current.name || current.email, docName: data.docName, signerToken: current.token, initName: data.initName, initFunctie: data.initFunctie, institutie: data.institutie, compartiment: data.compartiment },
          urgent: true });
        // Escaladare: notifică și inițiatorul
        if (data.initEmail && data.initEmail.toLowerCase() !== current.email.toLowerCase()) {
          await notify({ userEmail: data.initEmail, flowId, type: 'REMINDER',
            title: '🚨 Flux blocat — intervenție necesară',
            message: `Documentul „${data.docName}" e blocat la ${current.name || current.email} [${current.rol || ''}] de 3 zile. Poți delega sau contacta semnatarul.`,
            waParams: { docName: data.docName, initName: data.initName }, urgent: true });
        }
        reminded++;
      }
    }
    if (reminded > 0) logger.info({ reminded }, 'Reminder job multi-level: notificari trimise');
  } catch(e) { logger.error({ err: e }, 'Reminder job error'); }
}
const _reminderInterval = setInterval(_runReminderJob, REMINDER_INTERVAL_MS);
logger.info({ intervalH: process.env.REMINDER_INTERVAL_HOURS || 6, r1h: 24, r2h: 48, r3h: 72 }, 'Reminder job (multi-level) pornit');

// ── ASYNC-01: Background processor pentru arhivare async ──────────────────
// Procesează jobs din tabelul archive_jobs în loturi de 10, evitând timeout Railway

async function _runArchiveJobProcessor() {
  if (!pool || !DB_READY) return;
  try {
    // Preluăm un job pending la un moment dat (SKIP LOCKED evită race condition)
    const { rows: jobs } = await pool.query(
      `UPDATE archive_jobs SET status='processing', started_at=NOW()
       WHERE id = (SELECT id FROM archive_jobs WHERE status='pending' ORDER BY created_at ASC LIMIT 1 FOR UPDATE SKIP LOCKED)
       RETURNING *`
    );
    if (!jobs.length) return;
    const job = jobs[0];
    const flowIds = Array.isArray(job.flow_ids) ? job.flow_ids : [];
    const results = [];
    let totalOk = 0, totalFail = 0;
    for (const flowId of flowIds) {
      try {
        const data = await getFlowData(flowId);
        if (!data) { results.push({ flowId, ok: false, error: 'not_found' }); totalFail++; continue; }
        if (data.storage === 'drive') { results.push({ flowId, ok: true, skipped: true }); continue; }
        if (!data.pdfB64 && !data.signedPdfB64) {
          data.storage = 'drive'; data.archivedAt = new Date().toISOString();
          await saveFlow(flowId, data);
          results.push({ flowId, ok: true, warning: 'no_pdf_marked_archived' }); totalOk++; continue;
        }
        const driveResult = await archiveFlow(data, pool);
        data.pdfB64 = null; data.signedPdfB64 = null; data.originalPdfB64 = null;
        data.storage = 'drive'; data.archivedAt = new Date().toISOString();
        Object.assign(data, driveResult);
        await saveFlow(flowId, data);
        results.push({ flowId, ok: true }); totalOk++;
        logger.info({ flowId }, 'Archive job: flux arhivat in Drive');
      } catch(e) {
        logger.error({ err: e, flowId }, 'Archive job: eroare flux');
        results.push({ flowId, ok: false, error: String(e.message || e) }); totalFail++;
      }
    }
    await pool.query(
      `UPDATE archive_jobs SET status='done', finished_at=NOW(), result=$1 WHERE id=$2`,
      [JSON.stringify({ results, totalOk, totalFail }), job.id]
    );
    logger.info({ jobId: job.id, totalOk, totalFail }, 'Archive job procesat');
  } catch(e) { logger.error({ err: e }, 'Archive job processor error'); }
}
const _archiveJobInterval = setInterval(_runArchiveJobProcessor, 30_000); // verifică la 30s
logger.info('Archive job processor pornit (interval: 30s)');

// ── Cleanup notificari vechi (max 500/user) ────────────────────────────────
// Rulat o data la 6 ore pentru a preveni cresterea nelimitata
const _notifsCleanupInterval = setInterval(async () => {
  if (!pool || !DB_READY) return;
  try {
    const { rowCount } = await pool.query(`
      DELETE FROM notifications
      WHERE id IN (
        SELECT id FROM (
          SELECT id, ROW_NUMBER() OVER (PARTITION BY user_email ORDER BY created_at DESC) AS rn
          FROM notifications
        ) ranked
        WHERE rn > 500
      )
    `);
    if (rowCount > 0) logger.info({ rowCount }, 'notifications: notificari vechi sterse (limita 500/user)');
  } catch(e) { logger.error({ err: e }, 'Cleanup notificari error'); }
}, 6 * 60 * 60 * 1000);

// ── Notify helper ──────────────────────────────────────────────────────────
// FIX: notif_email si notif_inapp sunt independente
async function notify({ userEmail, flowId, type, title, message, waParams = {}, urgent = false }) {
  if (!pool || !DB_READY) return;
  const email = (userEmail || '').toLowerCase();
  if (!email) return;
  const [uRow] = (await pool.query('SELECT phone, notif_inapp, notif_whatsapp, notif_email FROM users WHERE email=$1', [email])).rows;

  // FIX: fiecare canal evaluat independent
  const needsInApp = uRow?.notif_inapp !== false; // default TRUE
  const needsEmail = !!(uRow?.notif_email);       // FIX: independent de notif_inapp
  const needsWa = !!(isWhatsAppConfigured() && uRow?.notif_whatsapp && uRow?.phone);

  // Prefixăm titlul cu [URGENT] dacă e cazul
  const displayTitle = urgent ? `🚨 [URGENT] ${title}` : title;

  if (needsInApp) {
    const r = await pool.query(
      'INSERT INTO notifications (user_email,flow_id,type,title,message,urgent) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id',
      [email, flowId || null, type, displayTitle, message, !!urgent]
    );
    wsPush(email, { event: 'new_notification', notification: { id: r.rows[0]?.id, flow_id: flowId, type, title: displayTitle, message, read: false, created_at: new Date().toISOString(), urgent: !!urgent } });
    const { rows: cntRows } = await pool.query('SELECT COUNT(*) FROM notifications WHERE user_email=$1 AND read=FALSE', [email]);
    wsPush(email, { event: 'unread_count', count: parseInt(cntRows[0].count) });
  }

  pushToUser(pool, email, { title: displayTitle, body: message, icon: '/icon-192.png', badge: '/icon-72.png', data: { flowId, type, urgent: !!urgent } }).catch(() => {});

  const eventsToAdd = [];
  const appUrl = process.env.PUBLIC_BASE_URL || 'https://app.docflowai.ro';

  // CODE-N01: template-uri extrase în emailTemplates.mjs
  let emailSubject, emailHtml;
  if (type === 'YOUR_TURN' && waParams.signerToken) {
    const t = emailYourTurn({ appUrl, flowId, signerToken: waParams.signerToken,
      signerName: waParams.signerName, docName: waParams.docName,
      initName: waParams.initName, initFunctie: waParams.initFunctie,
      institutie: waParams.institutie, compartiment: waParams.compartiment,
      roundInfo: waParams.roundInfo, urgent });
    emailSubject = t.subject; emailHtml = t.html;
  } else {
    const t = emailGeneric({ appUrl, flowId, type, title, message, urgent });
    emailSubject = t.subject; emailHtml = t.html;
  }
  const [emailResult, waResult] = await Promise.allSettled([
    needsEmail ? sendSignerEmail({ to: email, subject: emailSubject, html: emailHtml }) : Promise.resolve({ ok: false, reason: 'disabled' }),
    needsWa ? (async () => {
      if (type === 'YOUR_TURN') return sendWaSignRequest({ phone: uRow.phone, signerName: waParams.signerName || '', docName: waParams.docName || '' });
      if (type === 'COMPLETED') return sendWaCompleted({ phone: uRow.phone, docName: waParams.docName || '' });
      if (type === 'REFUSED') return sendWaRefused({ phone: uRow.phone, docName: waParams.docName || '', refuserName: waParams.refuserName || '', reason: waParams.reason || '' });
      return { ok: false, reason: 'unknown_type' };
    })() : Promise.resolve({ ok: false, reason: 'disabled' }),
  ]);

  if (emailResult.status === 'fulfilled' && emailResult.value?.ok) eventsToAdd.push({ at: new Date().toISOString(), type: 'NOTIFY', channel: 'email', to: email, notifType: type });
  else if (needsEmail) eventsToAdd.push({ at: new Date().toISOString(), type: 'NOTIFY_FAILED', channel: 'email', to: email, reason: String(emailResult.reason || emailResult.value?.error || 'failed') });

  if (waResult.status === 'fulfilled' && waResult.value?.ok) eventsToAdd.push({ at: new Date().toISOString(), type: 'NOTIFY', channel: 'whatsapp', to: uRow?.phone || email, notifType: type });
  else if (needsWa) eventsToAdd.push({ at: new Date().toISOString(), type: 'NOTIFY_FAILED', channel: 'whatsapp', to: uRow?.phone || email, reason: String(waResult.reason || waResult.value?.reason || 'failed') });

  if (eventsToAdd.length && flowId) {
    try {
      const fd = await getFlowData(flowId);
      if (fd) { fd.events = [...(Array.isArray(fd.events) ? fd.events : []), ...eventsToAdd]; await saveFlow(flowId, fd); }
    } catch(e) { logger.error({ err: e, flowId }, 'notify event save error'); }
  }
}

// ── Inject dependencies ───────────────────────────────────────────────────
injectRateLimiter(checkLoginRate, recordLoginFail, clearLoginRate);
// SEC-03: rate limiter ADMIN_SECRET persistent în DB — reutilizează login_blocks
// Cheia e IP-ul (al doilea parametru), nu email — compatibil cu signatura checkLoginRate(req, key)
injectAdminRateLimiter(
  (req, ip) => checkLoginRate(req, ip),
  (req, ip) => recordLoginFail(req, ip),
  (req, ip) => clearLoginRate(req, ip)
);
// SEC-04: injectează funcția de verificare token_version din pool DB
injectTokenVersionChecker(async (userId) => {
  if (!pool || !DB_READY) return null;
  const { rows } = await pool.query('SELECT token_version FROM users WHERE id=$1', [userId]);
  return rows[0]?.token_version ?? null;
});
injectWsPush(wsPush);
injectWsSize(() => wsClients.size);
injectFlowDeps({ notify, wsPush, PDFLib, stampFooterOnPdf, isSignerTokenExpired, newFlowId, buildSignerLink, stripSensitive, stripPdfB64, sendSignerEmail, fireWebhook });
// FEAT-N01: webhook — injectăm pool-ul și URL-ul de bază
injectWebhookPool(pool);
injectWebhookBaseUrl(process.env.PUBLIC_BASE_URL || '');

// ── Mount routers ─────────────────────────────────────────────────────────
app.use('/', authRouter);
app.use('/', totpRouter);  // 2FA TOTP
app.use('/', notifRouter);
app.use('/', adminRouter);
// Rute publice verificare (fără autentificare)
app.use('/', verifyRouter);
app.use('/', reportRouter);
app.use('/', flowsRouter);

// ── Tracking routes neutre (fara 'email'/'click' in path — mai putin blocate de Yahoo/Outlook) ──
// /d/:trackingId — click tracking (d = document)
// /p/:trackingId — pixel tracking (p = pixel)
// Ambele sunt aliases pentru endpoint-urile din flows/email.mjs
app.get('/d/:trackingId', async (req, res) => {
  // Forward catre handler-ul email-click
  req.params.trackingId = req.params.trackingId;
  // Redirect cu flowId precompletat in /verifica?id= daca il gasim rapid
  let safeDest = 'https://www.docflowai.ro';
  try {
    const { rows: qr } = await pool.query(
      `SELECT id AS flow_id FROM flows WHERE data->'events' @> $1::jsonb LIMIT 1`,
      [JSON.stringify([{ trackingId: req.params.trackingId }])]
    ).catch(() => ({ rows: [] }));
    if (qr.length) {
      // Asiguram ca appBase are schema https:// — fara ea URL-ul devine relativ
      let appBase = process.env.PUBLIC_BASE_URL || `${req.protocol}://${req.get('host')}`;
      if (appBase && !appBase.startsWith('http')) appBase = 'https://' + appBase;
      appBase = appBase.replace(/\/+$/, ''); // eliminam trailing slash
      safeDest = `${appBase}/verifica?id=${encodeURIComponent(qr[0].flow_id)}`;
    }
  } catch { /* fallback la docflowai.ro */ }
  res.redirect(302, safeDest);
  // Procesam tracking async
  setImmediate(async () => {
    try {
      const { trackingId } = req.params;
      if (!trackingId) return;
      const { rows } = await pool.query(
        `SELECT id AS flow_id FROM flows WHERE data->'events' @> $1::jsonb LIMIT 1`,
        [JSON.stringify([{ trackingId }])]
      );
      if (!rows.length) return;
      const flowId = rows[0].flow_id;
      const data = await getFlowData(flowId);
      if (!data) return;
      const events = Array.isArray(data.events) ? data.events : [];
      const emailEv = events.find(e => e.trackingId === trackingId);
      if (!emailEv) return;
      if (events.some(e => e.type === 'EMAIL_OPENED' && e.trackingId === trackingId)) return;
      const now = new Date().toISOString();
      const ip  = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.ip || '—';
      const ua  = (req.headers['user-agent'] || '').substring(0, 200);
      data.events.push({ at: now, type: 'EMAIL_OPENED', trackingId, to: emailEv.to, by: emailEv.by, ip, userAgent: ua });
      data.updatedAt = now;
      await saveFlow(flowId, data);
      writeAuditEvent({ flowId, orgId: data.orgId, eventType: 'EMAIL_OPENED',
        actorEmail: emailEv.to, actorIp: ip,
        payload: { trackingId, sentBy: emailEv.by, via: 'click', userAgent: ua } });
      logger.info({ flowId, trackingId, ip }, '📬 Email deschis (click /d/)');
    } catch(e) { logger.warn({ err: e }, '/d/ tracking error'); }
  });
});

app.get('/p/:trackingId', async (req, res) => {
  // Pixel GIF 1x1 transparent
  const GIF = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7','base64');
  res.setHeader('Content-Type','image/gif');
  res.setHeader('Cache-Control','no-store,no-cache,must-revalidate');
  res.setHeader('Pragma','no-cache');
  res.end(GIF);
  setImmediate(async () => {
    try {
      const { trackingId } = req.params;
      if (!trackingId) return;
      const { rows } = await pool.query(
        `SELECT id AS flow_id FROM flows WHERE data->'events' @> $1::jsonb LIMIT 1`,
        [JSON.stringify([{ trackingId }])]
      );
      if (!rows.length) return;
      const flowId = rows[0].flow_id;
      const data = await getFlowData(flowId);
      if (!data) return;
      const events = Array.isArray(data.events) ? data.events : [];
      const emailEv = events.find(e => e.trackingId === trackingId);
      if (!emailEv) return;
      if (events.some(e => e.type === 'EMAIL_OPENED' && e.trackingId === trackingId)) return;
      const now = new Date().toISOString();
      const ip  = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.ip || '—';
      const ua  = (req.headers['user-agent'] || '').substring(0, 200);
      data.events.push({ at: now, type: 'EMAIL_OPENED', trackingId, to: emailEv.to, by: emailEv.by, ip, userAgent: ua });
      data.updatedAt = now;
      await saveFlow(flowId, data);
      writeAuditEvent({ flowId, orgId: data.orgId, eventType: 'EMAIL_OPENED',
        actorEmail: emailEv.to, actorIp: ip,
        payload: { trackingId, sentBy: emailEv.by, via: 'pixel', userAgent: ua } });
      logger.info({ flowId, trackingId, ip }, '📬 Email deschis (pixel /p/)');
    } catch(e) { logger.warn({ err: e }, '/p/ tracking error'); }
  });
});
app.use('/admin/outreach', outreachRouter);

// ── POST /api/contact — formular contact landing page ─────────────────────
// Rate limiting: 5 cereri/ora per IP — previne spam si abuz
const _contactRateLimit = createRateLimiter({ windowMs: 60 * 60 * 1000, max: 5,
  message: 'Prea multe solicitări. Încearcă din nou în 60 de minute.' });
app.post('/api/contact', _contactRateLimit, async (req, res) => {
  try {
    const { inst, name, email, phone, subject, msg } = req.body || {};
    if (!inst || !name || !email || !subject)
      return res.status(400).json({ error: 'Câmpuri obligatorii lipsesc.' });
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
      return res.status(400).json({ error: 'Email invalid.' });

    const RESEND_API_KEY = process.env.RESEND_API_KEY;
    const MAIL_FROM = process.env.MAIL_FROM || 'DocFlowAI <noreply@docflowai.ro>';
    if (!RESEND_API_KEY) return res.status(503).json({ error: 'Email neconfigurat pe server.' });

    const htmlBody = `
      <div style="font-family:sans-serif;max-width:600px;margin:0 auto;padding:24px;">
        <h2 style="color:#6c4ff0;">📋 Solicitare nouă — DocFlowAI Landing</h2>
        <table style="width:100%;border-collapse:collapse;font-size:14px;">
          <tr><td style="padding:8px;color:#666;width:160px;font-weight:600;">Instituție:</td><td style="padding:8px;">${inst}</td></tr>
          <tr><td style="padding:8px;color:#666;font-weight:600;">Persoană contact:</td><td style="padding:8px;">${name}</td></tr>
          <tr><td style="padding:8px;color:#666;font-weight:600;">Email:</td><td style="padding:8px;"><a href="mailto:${email}">${email}</a></td></tr>
          <tr><td style="padding:8px;color:#666;font-weight:600;">Telefon:</td><td style="padding:8px;">${phone || '—'}</td></tr>
          <tr><td style="padding:8px;color:#666;font-weight:600;">Solicitare:</td><td style="padding:8px;font-weight:700;color:#6c4ff0;">${subject}</td></tr>
          <tr><td style="padding:8px;color:#666;font-weight:600;vertical-align:top;">Detalii:</td><td style="padding:8px;">${msg || '—'}</td></tr>
        </table>
        <hr style="margin:20px 0;border:none;border-top:1px solid #eee;" />
        <p style="color:#999;font-size:12px;">Trimis automat din formularul de contact DocFlowAI · ${new Date().toLocaleString('ro-RO', { timeZone: 'Europe/Bucharest' })}</p>
      </div>`;

    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + RESEND_API_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: MAIL_FROM,
        to: 'contact@docflowai.ro',
        reply_to: email,
        subject: '[DocFlowAI Demo] ' + subject + ' — ' + inst,
        html: htmlBody,
      }),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) {
      logger.error({ err: j }, 'contact form send failed');
      return res.status(502).json({ error: 'Eroare la trimiterea emailului.' });
    }
    logger.info({ inst, email, subject }, '📋 Contact form trimis');
    return res.json({ ok: true });
  } catch(e) {
    logger.error({ err: e }, 'contact form error');
    return res.status(500).json({ error: 'Eroare server.' });
  }
});
app.use('/', templatesRouter);         // Q-06: Template CRUD

// ── HTTP Server + WebSocket ────────────────────────────────────────────────
const httpServer = http.createServer(app);
const wss = new WebSocketServer({ server: httpServer, path: '/ws' });

// FIX v3.2.2: heartbeat pentru detecție conexiuni zombie + timeout auth
const WS_AUTH_TIMEOUT_MS = 15_000;  // 15s să trimită auth
const WS_PING_INTERVAL_MS = 30_000; // ping la 30s

const wsHeartbeat = setInterval(() => {
  wss.clients.forEach(ws => {
    if (ws.isAlive === false) { ws.terminate(); return; }
    ws.isAlive = false;
    ws.ping();
  });
}, WS_PING_INTERVAL_MS);
wss.on('close', () => clearInterval(wsHeartbeat));

// SEC-01: helper — parsează cookie auth_token din header-ul de upgrade WS
function getWsCookieToken(req) {
  const cookieHeader = req.headers.cookie || '';
  const match = cookieHeader.match(/(?:^|;\s*)auth_token=([^;]+)/);
  return match ? decodeURIComponent(match[1]) : null;
}

wss.on('connection', (ws, req) => {
  let clientEmail = null;
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

  // SEC-01: încearcă auto-auth din cookie-ul HttpOnly trimis la upgrade
  const cookieToken = getWsCookieToken(req);
  if (cookieToken) {
    try {
      const decoded = jwt.verify(cookieToken, JWT_SECRET);
      clientEmail = decoded.email.toLowerCase();
      wsRegister(clientEmail, ws);
      ws.send(JSON.stringify({ event: 'auth_ok', email: clientEmail }));
      if (pool && DB_READY) {
        pool.query('SELECT COUNT(*) FROM notifications WHERE user_email=$1 AND read=FALSE', [clientEmail])
          .then(r => ws.send(JSON.stringify({ event: 'unread_count', count: parseInt(r.rows[0].count) })))
          .catch(() => {});
      }
      logger.info({ email: clientEmail }, 'WS auto-auth (cookie)');
    } catch(e) {
      // Cookie invalid/expirat — continuăm, clientul poate trimite auth manual
      logger.warn({ err: e }, 'WS cookie invalid');
    }
  }

  // Timeout dacă clientul nu a reușit auto-auth și nu trimite auth manual în 15s
  const authTimeout = setTimeout(() => {
    if (!clientEmail) {
      ws.send(JSON.stringify({ event: 'auth_timeout', message: 'Autentificare obligatorie în 15s.' }));
      ws.terminate();
    }
  }, WS_AUTH_TIMEOUT_MS);

  // Dacă auto-auth a reușit, anulăm timeout-ul
  if (clientEmail) clearTimeout(authTimeout);

  ws.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw.toString());
      // Fallback: auth manual cu token (compatibilitate tranziție)
      if (msg.type === 'auth' && msg.token) {
        try {
          const decoded = jwt.verify(msg.token, JWT_SECRET);
          clientEmail = decoded.email.toLowerCase();
          clearTimeout(authTimeout);
          wsRegister(clientEmail, ws);
          ws.send(JSON.stringify({ event: 'auth_ok', email: clientEmail }));
          if (pool && DB_READY) {
            pool.query('SELECT COUNT(*) FROM notifications WHERE user_email=$1 AND read=FALSE', [clientEmail])
              .then(r => ws.send(JSON.stringify({ event: 'unread_count', count: parseInt(r.rows[0].count) })))
              .catch(() => {});
          }
          logger.info({ email: clientEmail }, 'WS auth (token)');
        } catch(e) { ws.send(JSON.stringify({ event: 'auth_error', message: 'invalid_token' })); }
      }
      if (msg.type === 'ping') ws.send(JSON.stringify({ event: 'pong' }));
    } catch(e) {}
  });
  ws.on('close', () => { clearTimeout(authTimeout); if (clientEmail) { wsUnregister(clientEmail, ws); logger.info({ email: clientEmail }, 'WS connection closed'); } });
  ws.on('error', (e) => logger.error({ err: e }, 'WS error'));
});

// ── Graceful shutdown ─────────────────────────────────────────────────────
function shutdown(signal) {
  logger.info({ signal }, 'Shutdown signal received');
  // Oprim toate intervalele
  clearInterval(_loginBlocksCleanupInterval);
  clearInterval(_notifsCleanupInterval);
  clearInterval(_reminderInterval);
  clearInterval(_archiveJobInterval);
  clearInterval(wsHeartbeat);
  // FIX b80: închidem pool-ul DB înainte de process.exit —
  // previne "Connection reset by peer" în logurile Postgres la fiecare deploy Railway.
  httpServer.close(async () => {
    if (pool) { try { await pool.end(); } catch(_) {} }
    logger.info('Server closed.');
    process.exit(0);
  });
  setTimeout(() => process.exit(0), 10_000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

const PORT = process.env.PORT;
if (!PORT) { logger.error('PORT missing - setati variabila de mediu PORT'); process.exit(1); }
httpServer.listen(Number(PORT), '0.0.0.0', () => {
  logger.info({ port: PORT, version: APP_VERSION }, 'DocFlowAI server pornit');
  logger.info({ port: PORT }, 'WebSocket ready');
  initDbWithRetry().then(async () => {
    // BUG-N01: Recovery archive_jobs blocate în 'processing' după restart Railway
    // Job-urile rămase în processing > 30min nu vor fi niciodată reluate fără acest reset.
    try {
      const { rowCount } = await pool.query(`
        UPDATE archive_jobs
        SET status = 'pending', started_at = NULL
        WHERE status = 'processing'
          AND started_at < NOW() - INTERVAL '30 minutes'
      `);
      if (rowCount > 0) {
        logger.warn({ rowCount }, 'archive_jobs: reset jobs blocate (processing → pending)');
      }
    } catch(e) {
      logger.warn({ err: e }, 'archive_jobs recovery: eroare la startup (non-fatal)');
    }

    // FEAT-05: Cleanup notificări vechi — șterge notificările citite > 90 zile
    // Previne acumularea nelimitată în tabelul notifications pe instanțe longevive.
    try {
      const { rowCount: notifDeleted } = await pool.query(`
        DELETE FROM notifications
        WHERE read = TRUE
          AND created_at < NOW() - INTERVAL '90 days'
      `);
      if (notifDeleted > 0) {
        logger.info({ notifDeleted }, 'startup: cleanup notificări vechi (>90 zile citite)');
      }
    } catch(e) {
      logger.warn({ err: e }, 'startup: cleanup notificări vechi — eroare (non-fatal)');
    }
  }).catch(() => {}); // initDbWithRetry gestionează propriile erori intern
});
