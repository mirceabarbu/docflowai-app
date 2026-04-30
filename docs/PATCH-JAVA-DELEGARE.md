# Patch Java Signing Service — Suport delegare în cartuș (b254)

Modificările pentru repo `docflowai-signing-service` ca să afișeze
'delegat de Nume - Funcție' în cartușul PAdES la STS Cloud.

## 1. Adaugă câmp în PrepareRequest.java

În `src/main/java/ro/docflowai/signing/dto/PrepareRequest.java`, la final
înainte de }, adaugă:

```java
    // b254: text delegare — afișat ca linie 7 în cartuș dacă != null
    public String delegatedFromText;
```

## 2. Modifică PadesPrepareService.java — drawCustomCartus

În `src/main/java/ro/docflowai/signing/service/PadesPrepareService.java`,
în metoda `drawCustomCartus`, după blocul `Linia 6: FOOTER`, înainte de
`canvas.release()`, adaugă:

```java
            // Linia 7 (b254): DELEGARE — italic mic, violet (dacă există)
            if (req.delegatedFromText != null && !req.delegatedFromText.isBlank()) {
                String txtDeleg = normalize(req.delegatedFromText);
                PdfFont fontItalic = PdfFontFactory.createFont(StandardFonts.HELVETICA_OBLIQUE);
                DeviceRgb C_PURPLE = new DeviceRgb(0.38f, 0.18f, 0.58f);
                float y7 = y6 - LINE_H;
                canvas.beginText()
                      .setFontAndSize(fontItalic, 5.5f)
                      .setFillColor(C_PURPLE)
                      .moveText(PAD_X, y7)
                      .showText(truncate(txtDeleg, w - PAD_X * 2, fontItalic, 5.5f))
                      .endText();
            }
```

Și ajustează `borderBottom` să cuprindă și linia 7. Localizează:
```java
            float borderBottom = y6 - 2.5f;
```
Înlocuiește cu:
```java
            boolean hasDeleg = req.delegatedFromText != null && !req.delegatedFromText.isBlank();
            float borderBottom = hasDeleg ? (y6 - LINE_H - 2.5f) : (y6 - 2.5f);
```

## 3. Mărește h (înălțime cartuș) când e delegare

În Node `cloud-signing.mjs` deja transmitem `height`. Pentru linie nouă
trebuie ~10pt în plus. Modifică în `cloud-signing.mjs`:

```javascript
const _extraH = _delegFromText ? 10 : 0;
...
height: 50 + _extraH,  // în loc de height: 50
```

Aplică în AMBELE apariții javaPreparePades.

## 4. Build + deploy

```bash
cd docflowai-signing-service
./gradlew build
# Push pe Railway, sau redeploy manual.
```

După deploy, fluxurile NOI cu delegare vor avea în cartuș linia 7 violet
'delegat de Nume - Funcție'. Fluxurile semnate ÎNAINTE rămân nemodificate.
