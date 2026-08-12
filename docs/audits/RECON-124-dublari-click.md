# RECON #124 — dublări din click repetat

**Data:** 2026-08-12 · **Branch:** `develop` @ v3.9.753 · **Tip:** READ-ONLY, zero cod de producție
**Metodă:** analiză statică pe cod. Fiecare afirmație are ancoră `fișier:linie`. Unde nu s-a putut
determina static, e scris explicit „nedeterminat".

---

## Rezumat executiv

| Măsură | Valoare |
|---|---|
| Apeluri de mutație inventariate (`public/`) | **144** (143 `fetch`/`_apiFetch` + 1 `XMLHttpRequest`) |
| Din care **CREEAZĂ obiect** | **43** |
| Din care **risc M** (creează + fără gardă efectivă) | **13** |
| Rute de server care creează **fără cheie de deduplicare** | **9** |

**Cele trei constatări care contează:**

1. **`btnCreate` (lansare flux) nu are NICIO gardă** — `semdoc-initiator/main.js:2195`. Nici
   `disabled`, nici flag in-flight; doar un text de status. `POST /flows` mintește un `flowId` nou
   la fiecare apel. Comentariul din `crud.mjs:450-457` documentează deja incidentul real
   („ORD 42719: 3 fluxuri în 4s") și consemnează **decizia de produs** că fluxul nou se creează
   oricum — protejat e doar *pointerul* documentului, nu crearea. Ăsta e vectorul #1 de dublări
   vizibile, inclusiv pe calea de semnare (fiecare flux paralel își trimite propriile emailuri).

2. **`reinitiatedAs` e o gardă fantomă pe server.** `lifecycle.mjs:131` scrie
   `data.reinitiatedAs = newFlowId2` cu comentariul „previne reinițializare dublă", dar valoarea
   **nu e citită niciodată** în handler. Singura verificare e în frontend
   (`semdoc-initiator/main.js:1210`, la randarea listei). Precondiția server rămâne `hasRefused`,
   care e adevărată în continuare pe fluxul PĂRINTE (semnatarul refuzat e eliminat doar din
   fluxul COPIL) ⇒ al doilea clic pe „Reinițiază" creează un **al doilea flux copil**.

3. **Cheia de idempotență a registraturii e generată pe server, deci inutilă.**
   `registratura.mjs:203` face `const _sursaId = randomUUID()` la fiecare cerere; serviciul
   (`services/registratura.mjs:59-76`) chiar are dedup pe `(org_id, registru, sursa_tip, sursa_id)`
   — dar cheia e alta la fiecare clic. Un dublu-clic pe „Salvează" consumă **două numere de
   registru**, ceea ce are consecință juridică, nu doar cosmetică. Mecanismul corect există deja
   în cod; îi lipsește doar ca `sursa_id` să vină de la client.

---

## Secțiunea A — inventarul apelurilor de mutație

**Legendă risc:** **M** = creează obiect ȘI n-are gardă efectivă · **m** = creează dar are gardă,
sau nu creează dar e vizibil deranjant · **–** = tranziție/update idempotent prin construcție.

**Legendă gardă:** `dis` = `.disabled=true` pe butonul clicat · `fin` = reset în `finally` ·
`flag` = variabilă in-flight cu ieșire timpurie · `confirm` = `confirm()`/`prompt()` sincron
(serializează, dar NU acoperă al doilea clic după acceptare) · `srv` = poarta reală e pe server.

> `confirm()` **nu** e o gardă. Blochează firul UI cât e deschis, dar după „OK" butonul rămâne
> activ cât timp cererea e în zbor. Îl notez fiindcă reduce probabilitatea, nu fiindcă o elimină.

### `public/js/admin/admin.js`
| fișier:linie | met | endpoint | funcție | declanșator | gardă | creează | risc |
|---|---|---|---|---|---|---|---|
| :42 | POST | `/auth/logout` | `logout` | meniu utilizator „Ieșire" | niciuna | nu | – |
| :82 | DELETE | `/admin/users/:id` | `delUser` | `onclick="delUser(...)"` listă utilizatori | niciuna | nu | – |
| :102 | POST | `/admin/users/:id/reactivate` | `reactivateUser` | `onclick="reactivateUser(...)"` | niciuna | nu | – |
| :128 | POST | `/auth/logout` | (inline HTML) | buton „Ieșire" inline | niciuna | nu | – |

### `public/js/admin/archive.js`
| fișier:linie | met | endpoint | funcție | declanșator | gardă | creează | risc |
|---|---|---|---|---|---|---|---|
| :140 | POST | `/admin/flows/archive` | `doArchive` | `onclick="doArchive()"` | dis | da (fișiere Drive) | m |
| :184 | POST | `/admin/flows/archive-async` | `doArchiveAsync` | `onclick="doArchiveAsync()"` | dis+reset | da (`archive_jobs`) | m |
| :258 | POST | `/admin/db/vacuum` | `runVacuum` | `onclick="runVacuum()"` | reset | nu | – |
| :286 | POST | `/admin/db/cleanup-orphans` | `cleanupOrphans` | `onclick="cleanupOrphans()"` | reset | nu | – |
| :481 | POST | `/admin/flows/clean` | `executePendingDelete` | `onclick="executePendingDelete()"` | dis+fin | nu (șterge) | – |

### `public/js/admin/core.js` · `public/js/df-apifetch-shim-full.js`
| fișier:linie | met | endpoint | funcție | declanșator | gardă | creează | risc |
|---|---|---|---|---|---|---|---|
| core.js:29 | POST | `/auth/refresh` | `_apiFetch` | automat la 401 | niciuna | nu | – |
| shim-full.js:41 | POST | `/auth/refresh` | `_apiFetch` | automat la 401 | niciuna | nu | – |

### `public/js/admin/flows.js`
| fișier:linie | met | endpoint | funcție | declanșator | gardă | creează | risc |
|---|---|---|---|---|---|---|---|
| :222 | DELETE | `/flows/:id` | `adminDeleteFlow` | `onclick="adminDeleteFlow(...)"` | confirm | nu | – |
| :232 | DELETE | `/flows/:id` | `deleteFlow` | `onclick="deleteFlow(...)"` | confirm | nu | – |
| :244 | POST | `/flows/:id/resend` | `resendNotif` | `onclick="resendNotif(...)"` | niciuna | nu (email dublu) | m |
| :255 | POST | `/flows/:id/regenerate-token` | `regenerateToken` | `onclick="regenerateToken(...)"` | niciuna | nu | – |

### `public/js/admin/organizations.js`
| fișier:linie | met | endpoint | funcție | declanșator | gardă | creează | risc |
|---|---|---|---|---|---|---|---|
| :62 | POST | `/auth/change-password` | `submitChangePwd` | `onclick="submitChangePwd()"` | dis+reset | nu | – |
| :292 | PUT | `/admin/users/:id/assign-org` | `doAssignOrg` | `onclick="doAssignOrg()"` | dis+fin | nu | – |
| :348 | POST | `/admin/onboarding` | `doOnboarding` | `onclick="doOnboarding()"` | dis+fin | **da** (org+users) | m |
| :399 | POST | `/admin/users/bulk-import` | `doBulkImport` | `onclick="doBulkImport()"` | dis+reset | **da** (users) | m |
| :454 | POST | `/auth/totp/setup` | `open2FASetup` | `onclick="open2FASetup()"` | reset | nu | – |
| :473 | POST | `/auth/totp/confirm` | `confirm2FASetup` | `onclick="confirm2FASetup()"` | niciuna | nu | – |
| :497 | POST | `/auth/totp/disable` | `do2FADisable` | `onclick="do2FADisable()"` | niciuna | nu | – |
| :529 | PUT | `/admin/organizations/:id` | `doRenameOrg` | `onclick="doRenameOrg()"` | dis+fin | nu | – |
| :552 | POST | `/admin/organizations/:id/reactivate` | `reactivateOrg` | `onclick="reactivateOrg(...)"` | dis+fin | nu | – |
| :600 | DELETE | `/admin/organizations/:id` | `doDeleteOrg` | `onclick="doDeleteOrg()"` | dis+fin | nu | – |
| :751 | POST | `/admin/signing/sts/generate-keypair` | `generateStsKeyPair` | `onclick="generateStsKeyPair()"` | dis+fin | da (keypair) | m |
| :811 | POST | `/admin/signing/verify` | `verifyProviderConfig` | `onclick="verifyProviderConfig()"` | reset+fin | nu | – |
| :863 | PUT | `/admin/organizations/:id/signing` | `saveOrgSigningProviders` | nedeterminat (apel intern) | niciuna | nu | – |
| :878 | POST | `/admin/signing/verify` | `verifySigningProvider` | nedeterminat | niciuna | nu | – |
| :914 | PUT | `/admin/organizations/:id/signing` | `saveOrgWebhookWithSigning` | nedeterminat | niciuna | nu | – |
| :1082 | PUT | `/admin/organizations/:id` | `saveOrgWebhook` | `onclick="saveOrgWebhook()"` | niciuna | nu | – |
| :1111 | PUT | `/admin/organizations/:id` | `saveOrgGeneral` | `onclick="saveOrgGeneral()"` | niciuna | nu | – |
| :1137 | PUT | `/admin/organizations/:id` | `saveOrgSigningOnly` | `onclick="saveOrgSigningOnly()"` | niciuna | nu | – |
| :1159 | PUT | `/admin/organizations/:id` | `orgTestWebhook` | `onclick="orgTestWebhook()"` | niciuna | nu | – |
| :1163 | POST | `/admin/organizations/:id/test-webhook` | `orgTestWebhook` | idem | niciuna | nu (webhook dublu) | m |

### `public/js/admin/outreach.js`
| fișier:linie | met | endpoint | funcție | declanșator | gardă | creează | risc |
|---|---|---|---|---|---|---|---|
| :236 | POST | `/admin/outreach/campaigns` | `orCreateCampaign` | `onclick="orCreateCampaign()"` | **niciuna** | **da** (campanie) | **M** |
| :271 | POST | `.../campaigns/:id/recipients` | `orAddRecipients` | `onclick="orAddRecipients()"` | niciuna | da, dar `ON CONFLICT (campaign_id,email) DO NOTHING` (`outreach.mjs:622`) | – |
| :291 | DELETE | `.../recipients/:rid` | `orDeleteRecipient` | `onclick="orDeleteRecipient(...)"` | dis | nu | – |
| :306 | POST | `.../campaigns/:id/send` | `orSendBatch` | `onclick="orSendBatch()"` | dis+fin | nu (emailuri) | m |
| :329 | POST | `.../reset-errors` | `orResetErrors` | `onclick="orResetErrors()"` | dis+fin | nu | – |
| :344 | DELETE | `.../campaigns/:id` | `orDeleteCampaign` | `onclick="orDeleteCampaign()"` | dis+fin | nu | – |

### `public/js/admin/primarii.js`
| fișier:linie | met | endpoint | funcție | declanșator | gardă | creează | risc |
|---|---|---|---|---|---|---|---|
| :158 | POST | `.../campaigns/:id/recipients` | `prAddSelected` | `onclick="prAddSelected()"` | dis+fin | da, `ON CONFLICT DO NOTHING` | – |
| :231 | DELETE | `/admin/outreach/primarii/:id` | `prDeleteRow` | `onclick="prDeleteRow(...)"` | niciuna | nu | – |
| :333 | POST | `/admin/outreach/primarii/import` | `prDoImport` | `onclick="prDoImport()"` | niciuna | da, `ON CONFLICT (email) DO NOTHING` (`outreach.mjs:167`) | – |

### `public/js/admin/users.js`
| fișier:linie | met | endpoint | funcție | declanșator | gardă | creează | risc |
|---|---|---|---|---|---|---|---|
| :457 | POST | `/admin/users` | `createUser` | `onclick="createUser()"` | dis+reset | **da** (user; `users.email` e UNIQUE ⇒ al 2-lea eșuează) | m |
| :561 | POST | `/admin/users/:id/gws-provision` | `gwsRetry` | `onclick="gwsRetry(...)"` | dis+reset | da (cont GWS) | m |
| :628 | POST | `/admin/users/:id/reset-password` | `genPwd` | `onclick="genPwd()"` | dis+fin | nu | – |
| :673 | PUT | `/admin/users/:id` | `saveEdit` | `onclick="saveEdit()"` | dis+fin | nu | – |
| :683 | POST | `/admin/users/:id/send-credentials` | `sendCreds` | `onclick="sendCreds(...)"` | dis+fin | nu (email) | m |
| :811 | PUT | `/admin/users/:id/leave` | `adminSaveLeave` | `onclick="adminSaveLeave()"` | niciuna | da (`delegations`, `ON CONFLICT DO NOTHING` `users.mjs:895`) | – |
| :832 | DELETE | `/admin/users/:id/leave` | `adminClearLeave` | `onclick="adminClearLeave()"` | niciuna | nu | – |

### `public/js/bulk-signer/bulk-signer.js`
| fișier:linie | met | endpoint | funcție | declanșator | gardă | creează | risc |
|---|---|---|---|---|---|---|---|
| :181 | POST | `/bulk-signing/initiate` | `initiateBulk` | `onclick="initiateBulk()"` (`btnSign`) | dis+reset | **da** (`bulk_signing_sessions`) | m |

### `public/js/chat/chat.js`
| fișier:linie | met | endpoint | funcție | declanșator | gardă | creează | risc |
|---|---|---|---|---|---|---|---|
| :235 | POST | `/api/chat/conversations/:id/read` | `markRead` | deschidere conversație | flag | nu | – |
| :249 | POST | `.../messages` | `sendMessage` | `chat-send` | **flag `_sending` + dis + fin** (`chat.js:236`) | **da** (mesaj) | m |
| :376 | POST | `/api/chat/conversations` | `createConversation` | buton conversație nouă | dis+fin | da, dar dedup 1:1 server (`chat.mjs:235-246`) | – |

> `chat.js:236` (`if (_sending || !_active) return;` + `disabled` + `finally`) e **cel mai curat
> tipar din tot codul**. E modelul pentru `df.once()` din Secțiunea E.2.

### `public/js/components/`
| fișier:linie | met | endpoint | funcție | declanșator | gardă | creează | risc |
|---|---|---|---|---|---|---|---|
| opme-report-drawer.js:234 | POST | `/api/opme/imports/:id/rematch` | `rematch` | buton „Re-rulează" din drawer | dis | nu (rescrie match) | – |
| opme-import-modal.js:179 (**XHR**) | POST | `/api/opme/import` | `upload` | `df-opme-btn-upload` | dis (ambele butoane) + `file_hash` UNIQUE/org ⇒ 409 | da (`opme_imports`) | – |
| registratura-action-modal.js:187 | POST | `/api/registratura/intrari/:id/status` | `submit` | buton confirmare modal | **niciuna** | nu (tranziție, `TRANZITII` server) | – |

### `public/js/df-email-modal.js` · `df-shell.js` · `df-transmit-modal.js` · `df-user-modals.js`
| fișier:linie | met | endpoint | funcție | declanșator | gardă | creează | risc |
|---|---|---|---|---|---|---|---|
| df-email-modal.js:315 | POST | `/flows/:id/send-email` | (submit modal) | buton „Trimite" | dis+reset | nu (**email dublu**) | m |
| df-email-modal.js:426 | POST | `/admin/outreach/primarii/suggest` | `doSuggestSave` | buton sugestie | dis | da, `ON CONFLICT DO UPDATE` (`outreach.mjs:260`) | – |
| df-shell.js:35 | POST | `/auth/logout` | `logout` | meniu utilizator | niciuna | nu | – |
| df-transmit-modal.js:184 | POST | `/flows/:id/transmit` | (submit modal) | buton „Transmite" | dis+reset | da, `ON CONFLICT DO NOTHING` (`flow-transmit.mjs:67`) | – |
| df-user-modals.js:84 | POST | `/auth/change-password` | `submitChangePwd` | `onclick="submitChangePwd()"` | dis+reset | nu | – |
| df-user-modals.js:376 | PUT | `/api/users/me/leave` | `submitSaveLeave` | `onclick="submitSaveLeave()"` | dis+fin | nu | – |
| df-user-modals.js:406 | DELETE | `/api/users/me/leave` | `submitClearLeave` | `onclick="submitClearLeave()"` | dis+fin | nu | – |

### `public/js/flow/flow.js`
| fișier:linie | met | endpoint | funcție | declanșator | gardă | creează | risc |
|---|---|---|---|---|---|---|---|
| :713 | POST | `/flows/:id/cancel` | (handler `btnCancelFlow`) | „🚫 Anulează" | prompt+confirm+dis+fin | nu | – |
| :738 | POST | `/flows/:id/admin-cancel` | (handler `btnAdminCancelFlow`) | „Anulare administrativă" | prompt+confirm+dis+fin | nu | – |
| :824 | POST | `/api/convert-to-pdf` | (handler `btnUploadRev`) | „Încarcă revizuit" | dis | nu (stateless) | – |
| :838 | POST | `/flows/:id/reinitiate-review` | idem | idem | dis+reset | nu (server 409 dacă `status!=='review_requested'`, `lifecycle.mjs:257`) | – |
| :991 | POST | `/flows/:id/reinitiate` | `reinitiateFlow` | `onclick="reinitiateFlow(...)"` | dis+fin | **da (flux nou)** | m |

### `public/js/formular/alop.js`
| fișier:linie | met | endpoint | funcție | declanșator | gardă | creează | risc |
|---|---|---|---|---|---|---|---|
| :38 | POST | `/api/alop/:id/link-{df,ord}` | `_alopLinkDoc` | automat după save/autosave | niciuna (SQL guard idempotent) | nu | – |
| :328 | POST | `/api/alop` | `createAlop` | buton „Creează" din `alop-modal` | **niciuna** | **da (dosar ALOP)** | **M** |
| :393 | POST | `/api/alop/:id/titlu` | `alopSaveTitlu` | `onclick="alopSaveTitlu(...)"` | niciuna | nu | – |
| :825 | POST | `/api/alop/:id/noua-lichidare` | `startNouaLichidare` | „🔄 Nouă ordonanțare parțială" (`:790`) | confirm; **srv: `FOR UPDATE` + `status='completed'`** (`alop.mjs:1652,1662`) | **da** (`alop_ord_cicluri`) | m |
| :876 | POST | `.../link-df` | `alopDeschideDF` | „Completează DF" (`:625`) | **flag `_dfOpenInFlight` + dis + fin** (`:24,837`) | nu | – |
| :967 | POST | `.../link-df` | `alopLaunchDfFlow` | **nedeterminat** — funcția e doar pe `window`, fără `onclick` în UI curentă | fin | nu | – |
| :996 | POST | `.../link-ord` | `alopLaunchOrdFlow` | **nedeterminat** — idem | niciuna | nu | – |
| :1017 | POST | `.../df-completed` | `alopDfCompleted` | **nedeterminat** — doar `window.alopDfCompleted` (`:1248`), fără `onclick` | confirm; srv `WHERE status='angajare'` | nu | – |
| :1064 | POST | `.../confirma-lichidare` | `confirmLichidare` | buton modal lichidare | niciuna; srv idempotent (`status IN ('lichidare','ordonantare')`) | nu | – |
| :1080 | POST | `.../ord-completed` | `alopOrdCompleted` | „Marchează ORD semnat complet" (`:649`) | confirm; srv guard status | nu | – |
| :1124 | POST | `.../confirma-plata` | `confirmPlata` | buton modal plată | niciuna; srv `FOR UPDATE` | nu | – |
| :1140 | POST | `.../cancel` | `cancelAlop` | „🗑 Șterge" (`:268,662`) | confirm | nu | – |
| :1181 | POST | `/api/formulare-df/:id/revizuieste` | `confirmRevizie` | buton modal revizie | **niciuna** | **da (revizie DF)** | **M** |

### `public/js/formular/clasa8.js` · `core.js`
| fișier:linie | met | endpoint | funcție | declanșator | gardă | creează | risc |
|---|---|---|---|---|---|---|---|
| clasa8.js:431 | POST | `/api/clasa8/buget/import` | `_doImport` | buton import buget | dis+fin | da (`clasa8_buget_versions`, `MAX+1`) | m |
| clasa8.js:454 | DELETE | `/api/clasa8/buget` | `_clearBuget` | buton golire | dis+fin | nu | – |
| core.js:496 | POST | `/api/formulare/generate` | `genPdf` | `onclick="genPdf(...)"` | dis+fin | nu (PDF) | – |

### `public/js/formular/doc.js`
| fișier:linie | met | endpoint | funcție | declanșator | gardă | creează | risc |
|---|---|---|---|---|---|---|---|
| :1025 | POST | `/api/formulare-{df,ord}` | `saveDoc` | „💾 Salvează" (`doc.js:674`) | **niciuna** | **da (DF/ORD)** | **M** |
| :1033 | PUT | `/api/formulare-{df,ord}/:id` | `saveDoc` | idem | niciuna | nu | – |
| :1091 | POST | `/api/formulare-capturi/...?slot=N` | `uploadCaptura` | automat din save/autosave | niciuna; srv DELETE-then-INSERT per slot (`shared.mjs:73-83`) ⇒ idempotent | nu | – |
| :1130 | POST | `/api/formulare-atasamente/...?slot=N` | `uploadAttachments` | automat din save/autosave | **niciuna; srv INSERT pur** (`shared.mjs:176`) | **da (atașament)** | **M** |
| :1240 | DELETE | `/api/formulare-atasamente/.../:attId` | `remAttServer` | buton ✕ pe atașament | niciuna | nu | – |
| :1518 | POST | `.../submit` | `confirmP2` | buton confirmare modal P2 | `closeModal()` înainte de POST | nu (tranziție) | – |
| :1612 | POST | `.../complete` | `completeAsP2` | buton „Finalizează" | **niciuna**; srv guard status | nu | – |
| :1651 | PUT | `.../:id` | `resetDocToP1` | buton reset | confirm | nu | – |
| :1684 | POST | `.../returneaza` | `confirmReturn` | buton modal returnare | dis+fin | nu | – |

### `public/js/formular/list.js` · `formular.js` · `verif.js`
| fișier:linie | met | endpoint | funcție | declanșator | gardă | creează | risc |
|---|---|---|---|---|---|---|---|
| list.js:43 | POST | `/api/formulare-{df,ord}` | `_autoSaveDb` | **autosave, debounce 800 ms** (`list.js:109`) | **niciuna** | **da (DF/ORD)** | **M** |
| list.js:59 | PUT | `.../:id` | `_autoSaveDb` | idem | niciuna | nu | – |
| list.js:328 | POST | `/api/beneficiari` | `_saveBeneficiarIfNew` | automat la submit ORD | niciuna; srv dedup pe `cif` (`shared.mjs:369`) | da | – |
| list.js:647 | POST | `/api/formulare-:type/:id/sterge` | `stergeDoc` | `onclick="stergeDoc(...)"` | niciuna | nu | – |
| formular.js:20 | POST | `/auth/logout` | (inline) | buton „Ieșire" | niciuna | nu | – |
| verif.js:265 | POST | nedeterminat (URL construit dinamic) | (verificare) | buton verificare | dis+fin | nu | – |

### `public/js/login/login.js` · `notifications/notifications.js`
| fișier:linie | met | endpoint | funcție | declanșator | gardă | creează | risc |
|---|---|---|---|---|---|---|---|
| login.js:24 | POST | `/auth/login` | `login` | buton „Autentificare" | dis | nu | – |
| notifications.js:246 | POST | `/flows/:id/acknowledge` | (handler listă primite) | buton „Am luat la cunoștință" | dis+reset | da, `ON CONFLICT (flow_id,user_id) DO NOTHING` (`flow-transmit.mjs:221`) | – |
| notifications.js:273 | POST | `/api/notifications/:id/read` | `markRead` | click pe notificare | dis+reset | nu | – |
| notifications.js:280 | DELETE | `/api/notifications/:id` | `deleteNotif` | buton ✕ | dis+reset | nu | – |
| notifications.js:287 | POST | `/api/notifications/read-all` | (buton bulk) | „Marchează toate citite" | dis+reset | nu | – |
| notifications.js:300 | POST | `/api/notifications/delete-bulk` | (buton bulk) | „Șterge toate" | reset | nu | – |

### `public/js/registratura/main.js`
| fișier:linie | met | endpoint | funcție | declanșator | gardă | creează | risc |
|---|---|---|---|---|---|---|---|
| :278 | POST | `/api/registratura/intrari/:id/status` | `doStatus` | delegare `data-act="status"` (`:358`) | **niciuna**; srv `TRANZITII` | nu | – |
| :297 | POST | `.../leaga-raspuns` | `doLink` | `data-act="link"` (`:359`) | **niciuna** | nu | – |
| :334 | POST | `.../atasament` | `doAttach` | `data-act="atas"` (`:360`) | **niciuna** | **da (atașament)** | **M** |
| :431 | POST | `/api/registratura/intrari` | `saveModal` | `regin-modal-save` (`:472`) | **niciuna** | **da (poziție de registru + număr)** | **M** |
| :446 | POST | `.../atasament` | `saveModal` | idem (post-creare) | niciuna | da | m |

### `public/js/semdoc-initiator/main.js`
| fișier:linie | met | endpoint | funcție | declanșator | gardă | creează | risc |
|---|---|---|---|---|---|---|---|
| :290 | POST | `/api/convert-to-pdf` | (handler fișier) | selectare fișier non-PDF | niciuna | nu | – |
| :1397 | POST | `/flows/:id/reinitiate` | `reinitiateFlow` | buton „Reinițiază" din listă | **niciuna** | **da (flux nou)** | **M** |
| :1435 | POST | `/flows/:id/reinitiate-review` | `submitReviewUpload` | `onclick="submitReviewUpload()"` | niciuna; srv 409 pe status | nu | – |
| :1451 | DELETE | `/flows/:id` | `deleteFlow` | `onclick="deleteFlow(...)"` | niciuna | nu | – |
| :1466 | POST | `/flows/:id/cancel` | `cancelFlow` | `onclick="cancelFlow(...)"` | niciuna | nu | – |
| :1968 | POST | `/flows/detect-acroform-fields` | `detectAncoreFields` | `btnDetectFields` (`:2082`) | dis | nu | – |
| :2124 | POST | `/flows/:id/attachments` | `_uploadAttachments` | lanț post-`btnCreate` | **niciuna** | **da (atașament flux)** | **M** |
| :2239 | POST | `/flows` | (handler `btnCreate`, `:2195`) | **„Pornește fluxul"** | **NICIUNA** | **da (FLUX)** | **M** |
| :2271 | POST | `/api/formulare-{df,ord}/:id/link-flow` | idem | lanț post-creare | niciuna; guard `already_on_flow` server | nu | – |
| :2298 | POST | `/api/alop/:id/link-{df,ord}` | idem | lanț post-creare | niciuna; idempotent SQL | nu | – |
| :2314 | POST | `/api/alop/:id/link-{df,ord}-flow` | idem | lanț post-creare | niciuna; `checkFlowLinkable` (#122) | nu | – |

### `public/js/semdoc-signer/` (detaliu în Secțiunea D)
| fișier:linie | met | endpoint | funcție | declanșator | gardă | creează | risc |
|---|---|---|---|---|---|---|---|
| main.js:38 | POST | `/auth/logout` | (inline) | „Ieșire" | niciuna | nu | – |
| main.js:361 | POST | `/flows/:id/initiate-cloud-signing` | `initiateCloudSigning` | `btnSignCloud` (`:339`) | dis (+reset doar pe eroare) | **da (sesiune STS)** | m |
| main.js:741 | POST | `/flows/:id/sign` | (handler `btnUploadSignedPdf`) | „Încarcă PDF semnat" | dis (`:728`) | nu; srv `status!=='current'` ⇒ 409 (`signing.mjs:57`) | – |
| main.js:756 | POST | `.../upload-signed-pdf` | idem | idem | dis | nu | – |
| main.js:842 | POST | `.../register-download` | (handler descărcare) | „Descarcă pentru semnare" | dis+reset | nu | – |
| main.js:870 | POST | `.../register-download` | idem (ramura cartuș) | idem | **niciuna** pe ramura asta | nu | – |
| main.js:1354 | POST | `/flows/:id/refuse` | (handler `btnRefuzConfirm`) | „Confirmă refuzul" | dis+reset pe eroare | nu; srv guard status | – |
| modals.js:24 | POST | `/auth/change-password` | `submitChangePwd` | buton modal | dis+reset | nu | – |
| post-dom-handlers.js:66 | POST | `/flows/:id/delegate` | (handler `btnDelegateConfirm`) | „Confirmă delegarea" | dis+reset pe eroare | nu | – |
| post-dom-handlers.js:122 | POST | `/flows/:id/request-review` | (handler `btnReviewConfirm`) | „Confirmă trimiterea spre revizuire" | dis+reset pe eroare | nu | – |

### `public/js/setari/entitlements.js` · `templates/templates.js` · `verifica/verifica.js` · `notif-widget.js`
| fișier:linie | met | endpoint | funcție | declanșator | gardă | creează | risc |
|---|---|---|---|---|---|---|---|
| entitlements.js:272 | DELETE | `/api/admin/entitlements?...` | `_onSave` | buton „Salvează" | dis+reset | nu | – |
| entitlements.js:277 | PUT | `/api/admin/entitlements` | `_onSave` | idem | dis+reset | da, `ON CONFLICT DO UPDATE` (`entitlements.mjs:118`) | – |
| templates.js:240 | POST | `/api/templates` | `saveTemplate` | `onclick="saveTemplate()"` | dis+reset | **da (șablon)** | m |
| templates.js:341 | PUT | `/api/templates/:id` | `saveEdit` | `onclick="saveEdit()"` | **niciuna** | nu | – |
| templates.js:350 | PUT | `/api/templates/:id` | `toggleShared` | `onclick="toggleShared(...)"` | **niciuna** | nu | – |
| templates.js:359 | DELETE | `/api/templates/:id` | `deleteTemplate` | `onclick="deleteTemplate(...)"` | confirm | nu | – |
| templates.js:372 | POST | `/api/templates` | `copyTemplate` | `onclick="copyTemplate(...)"` | prompt | **da (șablon)** | **M** |
| verifica.js:80 | POST | `/verify/signature` | `verifyByPdf` | `onclick="verifyByPdf()"` | fin | nu | – |
| notif-widget.js:139 | POST | `/auth/refresh` | `refreshToken` | automat la 401 | **dedup prin `_refreshPromise`** (`:129`) | nu | – |
| notif-widget.js:176 | POST | `/auth/logout` | `redirectLogin` | automat | fin | nu | – |
| notif-widget.js:558 | POST | `/api/push/subscribe` | `subscribePush` | activare notificări | niciuna; `ON CONFLICT DO UPDATE` (`notifications.mjs:225`) | nu | – |

### Cele 13 poziții cu risc M (lista scurtă)

| # | Loc | Ce se dublează |
|---|---|---|
| 1 | `semdoc-initiator/main.js:2239` (`btnCreate`) | **flux de semnare** (+ emailuri către semnatari) |
| 2 | `semdoc-initiator/main.js:1397` (`reinitiateFlow`) | **flux copil la reinițiere** |
| 3 | `formular/alop.js:328` (`createAlop`) | **dosar ALOP** |
| 4 | `formular/alop.js:1181` (`confirmRevizie`) | **revizie DF** (doar cursa paralelă — vezi B) |
| 5 | `formular/doc.js:1025` (`saveDoc`) | **DF/ORD** |
| 6 | `formular/list.js:43` (`_autoSaveDb`) | **DF/ORD** (fără dublu-clic — vezi B, cursa autosave) |
| 7 | `formular/doc.js:1130` (`uploadAttachments`) | **atașament formular** |
| 8 | `semdoc-initiator/main.js:2124` (`_uploadAttachments`) | **atașament flux** |
| 9 | `registratura/main.js:431` (`saveModal`) | **poziție de registru + număr consumat** |
| 10 | `registratura/main.js:334` (`doAttach`) | **atașament registratură** |
| 11 | `admin/outreach.js:236` (`orCreateCampaign`) | **campanie outreach** |
| 12 | `templates/templates.js:372` (`copyTemplate`) | **șablon** |
| 13 | `formular/doc.js:1612` + `registratura-action-modal.js:187` (fără gardă, dar tranziții) | — *incluse ca „fără gardă, salvate doar de server"; nu creează* |

> Poziția 13 e listată ca avertisment: sunt fără gardă client, iar siguranța lor depinde EXCLUSIV
> de garda de status server-side. Dacă acel guard slăbește vreodată, devin M imediat.

---

## Secțiunea B — rute de server care creează fără cheie de deduplicare

| Rută | Tabel | `SELECT` dedup? | Index unic? | Ancoră naturală disponibilă |
|---|---|---|---|---|
| `POST /flows` (`crud.mjs:583`) | `flows` (`db/index.mjs:2705`) | **nu** | nu (`id` = UUID nou/apel) | `meta.dfId`/`meta.ordId` (când există), altfel niciuna |
| `POST /api/alop` (`alop.mjs:437`) | `alop_instances` (`:477`) | **nu** | nu | **niciuna** — vezi discuția de mai jos |
| `POST /api/formulare-ord` (`ord.mjs:~232`) | `formulare_ord` (`:280`) | doar pe `nr_ordonant_pl` (`:252`), care e NULL la creare | **nu** | **`source_alop_id`** (persistat la INSERT, `:270`) |
| `POST /api/formulare-df` (`df.mjs:~200`) | `formulare_df` (`:288`) | **da** pe `source_alop_id` (`:262`) | **da** — `df_source_alop_revizie_uniq` (mig. 095) | acoperit; DF **fără** `source_alop_id` rămâne neprotejat |
| `POST /api/formulare-df/:id/revizuieste` (`df.mjs:492`) | `formulare_df` (`:580`) | `MAX(revizie_nr)+1` citit **în afara tranzacției**, fără `FOR UPDATE` (`:521`) | parțial — indexul 095 prinde cursa **doar dacă** `source_alop_id` e non-NULL, dar **fără `catch` pe 23505** ⇒ 500 | `(nr_unic_inreg, org_id, revizie_nr)` |
| `POST /flows/:id/reinitiate` (`lifecycle.mjs:43`) | `flows` | **nu** | nu | `data.reinitiatedAs` — **scris (`:132`) dar necitit** |
| `POST /api/registratura/intrari` (`registratura.mjs:~200`) | `registru_intrari` (`services/registratura.mjs:101`) | **da**, pe `(org_id,registru,sursa_tip,sursa_id)` (`:59`) | **da**, `ON CONFLICT` (`:108`) | mecanismul e corect, dar `sursa_id = randomUUID()` **pe server** (`registratura.mjs:203`) ⇒ inutil |
| `POST /api/formulare-atasamente/:type/:id` (`shared.mjs:176`) | `formulare_atasamente` | nu | nu | `(form_type, form_id, slot, filename, size_bytes)` |
| `POST /api/templates` (`templates.mjs:68`) | `templates` | nu | nu | `(user_email, name)` |

**Rute care NU au nevoie de intervenție** (dedup deja prezent, verificat): `beneficiari`
(`shared.mjs:369`), `conversations` (`chat.mjs:235`), `flow_recipients` +
`flow_recipient_acks` (`flow-transmit.mjs:67,221`), `outreach_recipients`/`outreach_primarii`
(`outreach.mjs:89,167,260,622`), `module_entitlements` (`entitlements.mjs:118`),
`push_subscriptions` (`notifications.mjs:225`), `opme_imports` (`file_hash` UNIQUE/org),
`conversation_participants` (`chat.mjs:264`), `delegations` (`users.mjs:895`),
`formulare_capturi` (DELETE-then-INSERT per slot, `shared.mjs:73`).

### Ancore propuse pentru `POST /api/alop` (opțiuni, FĂRĂ alegere)

Un dosar ALOP nou nu are părinte, deci nu există câmp natural care să existe „din prima
milisecundă" așa cum e `source_alop_id` la DF. Trei opțiuni:

**Opțiunea 1 — `(org_id, created_by, titlu, fereastră de timp)`**
Dedup pe „același utilizator, aceeași organizație, același titlu, în ultimele N secunde".
- *Pro:* zero schimbări de contract API; funcționează retroactiv pe clienți vechi; fereastra
  scurtă (5–10 s) acoperă exact dublu-clicul, care e problema raportată.
- *Contra:* nu se poate exprima ca index unic (predicat temporal) ⇒ **nu prinde cursa paralelă**,
  doar cea secvențială; titlul default e `'ALOP nou'` (`alop.mjs:485`) ⇒ doi utilizatori... nu,
  dar **același** utilizator care creează legitim două dosare goale la 3 secunde distanță e
  blocat tăcut. Fereastra e un compromis arbitrar.

**Opțiunea 2 — cheie de idempotență generată de client, trimisă în body**
Frontend-ul mintește un UUID la deschiderea modalului (`openAlopModal`, `alop.js:~300`) și îl
trimite ca `idempotency_key`; coloană nouă + index unic parțial `(org_id, idempotency_key)`.
- *Pro:* semantică exactă — „aceeași intenție de utilizator", nu „conținut asemănător".
  Se poate impune ca index unic ⇒ **acoperă și cursa paralelă**. Reutilizabil identic la
  `POST /flows`, `registratura`, `templates` — un singur tipar pentru toate rutele din tabel.
  E deja tiparul folosit intern de registratură (`sursa_id`), doar că acolo cheia e mintită
  pe server, unde nu ajută.
- *Contra:* migrație + schimbare de contract API; clienții vechi (tab lăsat deschis peste
  deploy) trimit `null` ⇒ trebuie o cale de fallback (index parțial `WHERE key IS NOT NULL`),
  deci protecția nu e universală din prima zi; cheia trebuie regenerată la închiderea
  modalului, altfel un al doilea dosar legitim din același modal e refuzat.

**Opțiunea 3 — nicio cheie pe server; doar gardă de UI + „dosar gol" ștergibil**
Se acceptă că un ALOP duplicat e ieftin de șters (`cancelAlop` există, `alop.js:1140`) și se
investește doar în stratul 2 (`df.once`).
- *Pro:* zero migrații, zero risc pe schema de producție; ALOP-ul gol chiar e ieftin.
- *Contra:* nu rezolvă nimic dacă utilizatorul nu observă duplicatul; dosarul duplicat poate
  primi între timp un DF (`cancel_blocked_df_exists`, `alop.js:1143`) și devine nemuritor.

⛔ Decizia e a lui Mircea. Nu recomand niciuna aici.

---

## Secțiunea C — interacțiuni rapide LEGITIME (lista de excepții pentru #124c)

O gardă care nu cunoaște lista asta produce regresii. Fiecare rând: elementul, de ce e legitim,
ce se rupe dacă îl blocăm.

| # | Element | De ce e legitim | Ce s-ar rupe |
|---|---|---|---|
| 1 | **Paginare** — `.pg-btn` ◀/▶/numere (`shared/pagin.js:108,129,140`) | Utilizatorul dă next-next-next ca să ajungă la pagina 5 | Fiecare clic e o intenție nouă; blocarea „un clic o dată" face navigarea să pară înghețată. Apelurile sunt **GET**, deci un dedup pe mutații nu le atinge — dar o gardă generică „un clic pe buton o dată" DA. |
| 2 | **`.badd` / `.bdel`** — adăugare/ștergere rânduri în tabelele DF/ORD (`formular.html:931,1103,1152,1216`; `core.js:129,153,164,179`) | Se adaugă 8 rânduri la rând, rapid | **Pur DOM, ZERO fetch** — nicio gardă de rețea nu-i atinge. Dar sunt exact butoanele pe care le-ar prinde o gardă globală de tip „delegare pe `<button>`". Consecință: nu se mai pot adăuga rânduri. |
| 3 | **Autosave DF/ORD cu conținut diferit** (`list.js:109`, debounce 800 ms) | Utilizatorul tastează continuu; fiecare salvare are alt body | Un dedup pe `method+url+hash(body)` le lasă să treacă (body diferit) — **corect**. Un lock „o mutație în zbor pe URL" le-ar serializa și ar pierde ultima stare tastată. |
| 4 | **Mesaje de chat identice consecutive** (`chat.js:249`) | „ok", apoi „ok" din nou — e limbaj natural, nu o greșeală | ⚠️ **Cazul cel mai neevident.** Un dedup pe `method+url+hash(body)` cu fereastră de timp ar **înghiți al doilea „ok"**. Body identic + URL identic + interval scurt = exact semnătura pe care ar prinde-o. |
| 5 | **Marcare citite / ștergere pe mai multe notificări** (`notifications.js:273,280`) | Se dă clic pe 5 notificări în 2 secunde | URL-uri diferite (`/:id`) ⇒ dedup pe cheie e OK. Un lock global „o mutație o dată" ar face lista să pară blocată. |
| 6 | **Adăugare/ștergere rânduri semnatari** — `btnAdd` (`semdoc-initiator/main.js:928`), `.btnDel` per rând (`:661`) | Se construiește o listă de 6 semnatari | Pur DOM, fără fetch. Aceeași capcană ca #2 pentru o gardă generică pe butoane. |
| 7 | **Selectare provider / carduri** — `selectProvider` (`semdoc-signer/main.js:300`), `.provider-card` | Utilizatorul se răzgândește și schimbă providerul de 2-3 ori | Pur DOM. Blocarea ar îngheța selecția pe prima alegere. |
| 8 | **Bifare fluxuri în bulk-signer** — `_selected` (`bulk-signer.js:~170`) | Se bifează 15 documente rapid | Pur DOM. |
| 9 | **Ștergere mai multe atașamente la rând** — `remAttServer` (`doc.js:1240`) | Se curăță 4 anexe greșite | URL diferit per `attId` ⇒ OK pe cheie; **nu** pe un lock global. |
| 10 | **Comutare sub-taburi** — `switchListTab`, `ltab-df`/`ltab-ord`, `switchOrgSubTab`, `switchTab` | Navigare normală înainte-înapoi | GET-uri; aceeași observație ca #1. |
| 11 | **Căutare/filtrare cu debounce** — `_lstDebTimer`, `_benefTimer` (`list.js`) | Tastare continuă în câmpul de căutare | GET-uri cu query diferit; un dedup pe cheie e transparent. |
| 12 | **Reîmprospătare manuală** — `alopRefreshCurrent` (`alop.js:373`), `loadFlow`, `loadAlop` | Utilizatorul apasă „Reîmprospătează" de două ori fiindcă nu s-a schimbat nimic | GET-uri; un dedup ar returna răspunsul vechi din prima cerere, ceea ce e **exact contrariul** intenției utilizatorului. |
| 13 | **Reîncercare după eroare** — orice buton care afișează „❌ Eroare" și rămâne activ | A doua încercare e intenționată | O gardă cu fereastră de timp (nu cu reset la răspuns) ar bloca retry-ul legitim. Garda trebuie să se reseteze la **finalizarea cererii**, nu la expirarea unui timer. |
| 14 | **Re-emiterea automată la 401 / 403 csrf_invalid** — `notif-widget.js:213,224` | Recuperarea de sesiune re-trimite **exact aceeași** cerere | ⚠️ Vezi Secțiunea E.1 — un dedup naiv o consideră duplicat și rupe reautentificarea pe toată platforma. |

Elemente #4, #12, #13 și #14 sunt cele **neevidente**. Restul sunt intuitive.

---

## Secțiunea D — calea de semnare

Analiză **strict statică**. Nimic nu a fost rulat împotriva STS.

| Buton / element | Fișier:linie | Gardă client | Ce se întâmplă la al doilea clic |
|---|---|---|---|
| **„Pornește fluxul"** (`btnCreate`) | `semdoc-initiator/main.js:2195` | **NICIUNA** | **Al doilea flux complet.** `POST /flows` (`crud.mjs:583`) generează `flowId` nou; ambele fluxuri trimit email primului semnatar. Pointerul documentului e protejat (`crud.mjs:459-473` ia documentul doar dacă e liber/al fluxului curent/mort) ⇒ al doilea flux rămâne **orfan dar VIU**. Singurul plafon e `_flowCreateRateLimit` 30/min (`crud.mjs:36`) — irelevant pentru 2 clicuri. Detectat de clasa D din `flow-link-audit.mjs` (#120) **după fapt**. |
| „Reinițiază" (după refuz) | `semdoc-initiator/main.js:1397` | **NICIUNA** | **Al doilea flux copil.** `reinitiatedAs` (`lifecycle.mjs:132`) e scris dar necitit; precondiția `hasRefused` (`:54`) rămâne adevărată pe părinte. Varianta din `flow.js:991` are `dis+fin`, deci e protejată **doar acolo**. |
| „Semnează cu \<provider\>" (`btnSignCloud`) | `semdoc-signer/main.js:339` → `initiateCloudSigning` (`:356`) | `dis` la intrare; reset **doar pe eroare** (`:373`) | Al doilea clic **nu ajunge** la handler cât timp cererea e în zbor. Pe succes urmează `location.href = j.signingUrl` (`:368`), deci butonul nu mai revine niciodată. **Gardă corectă.** Am verificat identitatea elementului: butonul creat dinamic primește chiar `id='btnSignCloud'` (`:339`), deci `$('btnSignCloud')` din gardă e **același element** care a fost clicat — nu e un no-op. |
| „Descarcă pentru semnare" → `register-download` | `semdoc-signer/main.js:842` (semnatar 2+) și `:870` (ramura cartuș) | `dis+reset` pe ramura :842; **niciuna** pe ramura :870 | `register-download` (`signing.mjs:250`) reemite `uploadToken` pentru același semnatar. Al doilea apel rescrie tokenul. **Nedeterminat static** dacă un `uploadToken` obținut înainte de rescriere mai e acceptat la upload ⇒ **necesită test manual: descarcă documentul, apoi apasă „Descarcă" a doua oară, apoi încarcă PDF-ul semnat obținut din PRIMA descărcare — dacă upload-ul e respins cu eroare de token, garda e necesară.** |
| „Încarcă PDF semnat" (`btnUploadSignedPdf`) | `semdoc-signer/main.js:726` | `dis` la intrare (`:728`) | Poarta reală e serverul: `/sign` respinge cu 409 `not_current_signer` dacă semnatarul nu mai e `current` (`signing.mjs:57`); upload-ul are `_uploadRateLimit` 5/min (`signing.mjs:21`). **Nicio semnătură dublă.** ⚠️ `signFlow` face read-modify-write pe blobul JSONB fără lock de rând — două cereri **strict paralele** ar putea ambele să citească `current`. Rezultatul nu e o semnătură duplicată, ci o **suprascriere** a blobului `data` (lost update). Vezi Constatări colaterale. |
| „Confirmă refuzul" (`btnRefuzConfirm`) | `semdoc-signer/main.js:1342` | `dis`, reset doar pe eroare | Al doilea clic blocat client; serverul are guard de status. **OK.** |
| „Confirmă delegarea" (`btnDelegateConfirm`) | `post-dom-handlers.js:55` | `dis`, reset doar pe eroare | **OK.** |
| „Confirmă trimiterea spre revizuire" (`btnReviewConfirm`) | `post-dom-handlers.js:113` | `dis`, reset doar pe eroare | **OK.** |
| „Încarcă revizuit" (`btnUploadRev`) | `flow/flow.js:~810` | `dis` | Server: `reinitiate-review` 409 dacă `status !== 'review_requested'` (`lifecycle.mjs:257`) + guard `same_document` pe hash (`:266`). **OK.** |
| „Semnează documentele selectate" (`btnSign`, bulk) | `bulk-signer.js:168` | `dis+reset` pe eroare; succes ⇒ redirect | Server `_bulkRateLimit` (`bulk-signing.mjs:114`). **Nedeterminat static** dacă un al doilea `bulk_signing_sessions` pentru aceleași fluxuri e refuzat sau doar creat în paralel ⇒ **necesită test manual: deschide bulk-signer în două taburi cu aceeași selecție și apasă „Semnează" în ambele — verifică dacă apar două rânduri în `bulk_signing_sessions` pentru aceleași `flowId`-uri.** (Fișierul e NO-TOUCH; testul e doar de observare.) |
| „Anulează" / „Anulare administrativă" | `flow/flow.js:706,730` | `prompt`+`confirm`+`dis`+`fin` | **Cele mai bine protejate butoane din aplicație.** Model de referință. |

**Concluzia D:** pe calea propriu-zisă de *semnare* (signer, bulk), gărzile există și sunt
corecte; poarta reală e mașina de stări server-side, care e solidă. Problema NU e în semnare —
e în **lansare** (`btnCreate`, `reinitiate`), unde se nasc fluxurile paralele care ajung apoi
pe calea de semnare ca documente duplicate.

---

## Secțiunea E — recomandare pe trei straturi

### E.1 — Dedup la nivel de `fetch` global (`df-utils.js`)

**Ideea:** împachetăm `window.fetch` în `df-utils.js` (încărcat de toate cele 15 pagini,
verificat: `admin/bulk-signer/chat/flow/formular/login/notafd-invest-form/notifications/
refnec-form/registratura/semdoc-initiator/semdoc-signer/setari/templates/verifica`, și e în
`PRECACHE_ASSETS`, `sw.js:23`). Cheie `method + url + hash(body)`; o cerere identică deja în
zbor returnează aceeași promisiune.

**Verdict: NU o recomand ca strat principal.** Motivele, în ordinea gravității:

1. **`response.clone()` NU acoperă complet.** Ideea „dăm fiecărui apelant un `clone()`" e
   corectă în principiu, dar are trei fisuri reale în codul ăsta:
   - **`clone()` se face pe un `Response` al cărui body nu a fost încă citit.** Dacă apelantul
     A citește `.json()` înainte ca apelantul B să primească promisiunea, `clone()` pentru B
     eșuează. Ordinea depinde de microtask-uri, deci **eșecul e nedeterminist** — cel mai prost
     mod de a rupe o platformă.
   - **Memoria.** `clone()` pe un răspuns necitit forțează browserul să bufereze **întregul
     body** până când ambele ramuri sunt consumate. Aici se descarcă PDF-uri semnate de zeci de
     MB (`/flows/:id/signed-pdf`, `/pdf`). Un `clone()` pe un răspuns de 50 MB dublează
     consumul.
   - **Body-uri necitibile la calcularea cheii.** `hash(body)` presupune că body-ul e
     serializabil. Nu e cazul pentru: `FormData` (`/api/convert-to-pdf`,
     `semdoc-initiator/main.js:290` și `flow/flow.js:824`) — nu se poate hasha fără să-l
     consumi; `XMLHttpRequest` (`opme-import-modal.js:179`) — **nu trece deloc prin `fetch`**,
     deci stratul e orb la el; upload-urile de atașamente care trimit bytes bruți în body cu
     `x-filename` în header (`shared.mjs:161-173`).
2. **Coliziune directă cu recuperarea de sesiune.** `notif-widget.js:213` și `:224`
   **re-emit exact aceeași cerere** (`fetch(url, {...options, headers, credentials})`) după
   `refreshToken()` la 401, respectiv după token CSRF nou la 403. Un dedup naiv cu fereastră de
   timp ar întoarce răspunsul 401 memorat ⇒ **bucla de reautentificare se rupe pe toată
   platforma**. Ar trebui o listă de excepții pe URL (`/auth/refresh`, `/auth/csrf-token`) ȘI un
   mecanism de invalidare a intrării la 401/403 — adică exact complexitatea pe care stratul
   pretindea că o evită. (`refreshToken` are deja dedup propriu prin `_refreshPromise`,
   `notif-widget.js:129` — corect făcut, la nivelul potrivit.)
3. **Fals-pozitive documentate în Secțiunea C** — mesajul de chat identic (#4), reîmprospătarea
   manuală (#12), retry-ul după eroare (#13).
4. **Raza de acțiune vs. beneficiu.** Un bug aici lovește *toate* cele 144 de apeluri, inclusiv
   calea de semnare STS. Beneficiul e o gardă pe care oricum trebuie s-o dublezi pe server
   pentru cursa multi-tab.

**Dacă totuși se face**, condițiile minime: doar `POST`/`PUT`/`PATCH`, doar body `string`
(sări peste `FormData`/`Blob`/`ArrayBuffer`), listă de excludere explicită
(`/auth/*`, `/api/chat/*`), fereastră legată de **finalizarea cererii** (nu un timer), și
`clone()` făcut **imediat**, o dată per apelant suplimentar, înainte de orice citire.

### E.2 — Helper `df.once(btn, fn)`

Generalizarea tiparului care există deja și funcționează: `chat.js:236` (`_sending` + `disabled`
+ `finally`) și `alop.js:24,837` (`_dfOpenInFlight` + `disabled` + reset în `finally`).

Semantica: dezactivează butonul, afișează stare vizibilă („Se salvează…"), execută, **restaurează
în `finally`** (nu pe timer, ca să nu rupă excepția C#13).

- **Acoperă:** toate cele 13 poziții cu risc M din Secțiunea A; dă **și** feedback vizual, care
  e cauza rădăcină raportată de utilizatori („platforma nu-mi dă niciun semnal că lucrează").
- **NU acoperă:** două taburi deschise, cursa autosave↔save manual (`list.js:43` vs
  `doc.js:1025` — nu e un buton), reîncercări din alt dispozitiv, apelurile automate din lanțuri
  (`_uploadAttachments`, `semdoc-initiator/main.js:2124`).
- **Risc:** mic și local. Se aplică incremental, buton cu buton, cu verificare vizuală.
  Lista de excepții din Secțiunea C (#2, #6, #7, #8) trebuie respectată: `df.once` se aplică
  **explicit**, per buton, **niciodată** prin delegare globală pe `<button>`.

### E.3 — Idempotență pe server (rutele din Secțiunea B)

Oglindirea tiparului deja validat la DF (`df.mjs:255-273` + index 095 + `catch 23505`):
`SELECT` de dedup care întoarce obiectul existent **tăcut (200)** + index unic parțial ca poartă
durabilă + `catch` pe `23505` pentru cursa paralelă.

- **Acoperă:** tot ce E.2 nu acoperă — multi-tab, retry de rețea, clienți vechi din cache,
  curse paralele reale.
- **NU acoperă:** feedback-ul vizual (cauza rădăcină a comportamentului utilizatorului) și
  cazurile fără ancoră naturală (`POST /api/alop` — vezi discuția din B).
- **Risc:** cel mai mare — atinge schema. Fiecare index unic nou poate eșua la creare pe
  duplicate existente în producție (exact ce a pățit migrarea 095, care are `RAISE WARNING`
  tocmai pentru asta, `db/index.mjs:2135`). De aceea Livrabilul 2 (scriptul SQL) trebuie rulat
  **înainte** de orice migrație din acest lot.

### Ordinea de livrare recomandată

**E.2 → E.3 → (E.1 doar dacă mai e nevoie, probabil nu).**

E.2 rezolvă cauza raportată (lipsa de feedback) cu riscul cel mai mic și dă rezultate vizibile
imediat. E.3 închide definitiv ce rămâne, dar are nevoie de datele din scriptul SQL ca să știe
dacă indexurile se pot crea. E.1 e un multiplicator de risc pe toată platforma pentru un câștig
marginal peste E.2+E.3.

---

## Secțiunea F — ordinea de atac propusă

| Lot | Conținut | Risc | Note |
|---|---|---|---|
| **#124b** | Rulare `recon-124-duplicate-check.sql` pe producție + decizia pe rezultate | **zero** (read-only) | Blocant pentru orice lot cu migrații. Dacă ORD are duplicate, lotul #124e are nevoie de curățare prealabilă. |
| **#124c** | `df.once()` în `df-utils.js` + aplicare pe **cele 5 poziții financiare**: `btnCreate` (`:2195`), `createAlop` (`alop.js:328`), `confirmRevizie` (`alop.js:1181`), `saveModal` registratură (`:405`), `reinitiateFlow` (`semdoc-initiator:1397`) | **mic** | Un singur deploy, 5 call-site-uri, verificabile vizual. Lista de excepții din Secțiunea C e obligatorie în review. |
| **#124d** | `df.once()` pe restul pozițiilor M (8) + pe cele fără gardă din admin/outreach/templates | **mic** | Mecanic după ce #124c a validat helperul. |
| **#124e** | Idempotență ORD: `SELECT` dedup pe `source_alop_id` + index unic parțial + `catch 23505` — **oglindă exactă a `df.mjs:255-305`** ⚠️ `formulare_ord` **NU are `revizie_nr`** (`db/index.mjs:939-970`); cheia e `(source_alop_id)` cu `WHERE source_alop_id IS NOT NULL AND deleted_at IS NULL`. NU presupune simetria cu DF. | **mediu** | Depinde de #124b. Necesită test de caracterizare DB înainte (regula din CLAUDE.md). |
| **#124f** | `reinitiate`: **citește** `reinitiatedAs` în `lifecycle.mjs:43` și întoarce fluxul copil existent (200) în loc să creeze al doilea | **mic** | Fix punctual, gardă deja scrisă, doar necitită. Cel mai bun raport efect/risc din tot lotul. |
| **#124g** | Registratură: `sursa_id` mintit de client în loc de `randomUUID()` server (`registratura.mjs:203`) | **mediu** | Schimbare de contract API; mecanismul de dedup din serviciu (`services/registratura.mjs:59`) devine funcțional fără nicio migrație. |
| **#124h** | `POST /flows` + `POST /api/alop` — cheie de idempotență (decizia lui Mircea din Secțiunea B) | **mare** | Atinge calea de creare a fluxurilor. Ultimul, cu staging 24h. |
| **#124i** | Atașamente (`formulare_atasamente`, `flow_attachments`) — dedup pe `(form_id, slot, filename, size_bytes)` | **mic** | Opțional; impact vizual, nu financiar. |

⛔ Niciun cod scris în acest prompt.

---

## Constatări colaterale

1. **Comentariu fals în cod — `lifecycle.mjs:131`.** „FIX: Marchează fluxul original cu
   `reinitiatedAs` — previne reinițializare dublă". Nu previne nimic pe server; `reinitiatedAs`
   e citit exclusiv în frontend (`semdoc-initiator/main.js:1210`) și doar expus prin DTO
   (`crud.mjs:910`). Un comentariu care afirmă o protecție inexistentă e mai periculos decât
   lipsa protecției — următorul dezvoltator îl crede.

2. **Lost update pe blobul JSONB al fluxului (concurență, nu dublare).** `signFlow`
   (`signing.mjs:41-83`), `refuse`, `delegate` și restul rutelor de lifecycle fac
   `getFlowData()` → mutează în JS → `saveFlow()`, **fără `FOR UPDATE`** pe rândul din `flows`.
   Două cereri paralele care ating fluxuri diferite ale aceluiași document, sau două acțiuni
   simultane pe același flux (semnare + anulare), se suprascriu integral — ultima câștigă tot
   blobul, inclusiv câmpuri pe care nu voia să le atingă. `alop.mjs` a rezolvat deja asta corect
   pentru ALOP (`FOR UPDATE`, `alop.mjs:1652`, comentat „P0.2"); `flows` n-a primit același
   tratament. **Nu e o dublare**, deci nu intră în lotul #124 — dar merită un task propriu.
   ⚠️ Rutele afectate ating zona de semnare; orice intervenție acolo cere confirmarea lui Mircea.

3. **`/revizuieste` poate întoarce 500 în loc de 200 la cursă paralelă.** `df.mjs:521-537`
   calculează `MAX(revizie_nr)+1` în afara tranzacției. Dacă DF-ul are `source_alop_id`, indexul
   095 respinge al doilea INSERT cu `23505` — dar spre deosebire de calea de creare
   (`df.mjs:292-305`), aici **nu există `catch` pe 23505**, deci utilizatorul vede „Eroare la
   creare revizie" în loc de revizia câștigătoare. Dacă DF-ul **nu** are `source_alop_id`,
   indexul nu se aplică și se creează **două R1**.

4. **Trei funcții exportate pe `window` fără niciun apelant în UI:** `alopLaunchDfFlow`
   (`alop.js:962,1246`), `alopLaunchOrdFlow` (`:983,1247`), `alopDfCompleted` (`:1013,1248`).
   Verificat prin căutare în tot `public/`: zero `onclick`, zero `addEventListener`. Sunt
   apelabile din consolă și `alopDfCompleted` avansează faza ALOP `angajare → lichidare`.
   Poarta reală rămâne serverul (`checkFlowSigned`, #122), deci nu e o breșă — dar e suprafață
   moartă care ar trebui fie recablată, fie ștearsă.

5. **`register-download` fără gardă pe ramura cartuș** (`semdoc-signer/main.js:870`) —
   vezi testul manual din Secțiunea D.
