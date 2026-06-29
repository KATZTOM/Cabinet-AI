require('dotenv').config();
const express = require('express');
const multer = require('multer');
const { OpenAI } = require('openai');
const fs = require('fs');

async function extractPdfText(buffer) {
    const pdfjsLib = await import('pdfjs-dist/legacy/build/pdf.mjs');
    const loadingTask = pdfjsLib.getDocument({ data: new Uint8Array(buffer) });
    const pdf = await loadingTask.promise;
    let fullText = '';
    for (let i = 1; i <= pdf.numPages; i++) {
        const page = await pdf.getPage(i);
        const content = await page.getTextContent();
        fullText += content.items.map(item => item.str).join(' ') + '\n';
    }
    return fullText;
}

const app = express();
const upload = multer({ dest: 'uploads/' });

app.use(express.json());
app.use(express.static('.'));

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// --- MASTER CATALOG DICTIONARY INITIALIZATION ---
let catalogData = "{}";
const canonicalSkuLookup = new Map(); 

function buildInsensitiveValidationIndex(node) {
    if (!node || typeof node !== 'object') return;
    if (node.sku && typeof node.sku === 'string') {
        const originalSku = node.sku.trim();
        const ultraCleanKey = originalSku.toUpperCase().replace(/[\s\-\/\*]/g, '');
        canonicalSkuLookup.set(ultraCleanKey, originalSku);
    }
    for (let key in node) {
        if (node.hasOwnProperty(key)) {
            buildInsensitiveValidationIndex(node[key]);
        }
    }
}

try {
    catalogData = fs.readFileSync('./catalog.json', 'utf8');
    const parsedCatalog = JSON.parse(catalogData);
    buildInsensitiveValidationIndex(parsedCatalog);
    console.log(`[CATALOG ENGINE] Index Synced. Loaded ${canonicalSkuLookup.size} standard SKUs.`);
} catch (err) {
    console.error("CRITICAL ERROR: catalog.json missing or contains parsing errors!");
}

function cleanAndNormalizeSku(rawBaseSku) {
    let sku = rawBaseSku.toUpperCase().trim().replace(' KIT', '');
    
    const directOverrides = {
        "WF330": "AC-WF36",
        "WF342": "AC-WF42",
        "F336":  "AC-WF36",
        "F396":  "AC-F11/2 96",
        "CM4-1/2": "AC-CM 4 1/2",
        "CM2-1/2": "AC-CM 2 1/2"
    };
    if (directOverrides[sku]) return directOverrides[sku];

    if (/^(SM|TK|BF3|BF6|COV|QR|CM)\d*$/.test(sku)) {
        sku = sku.replace(/\d+$/, '');
    }

    let cleanLookupKey = sku.replace(/[\s\-\/\*]/g, '');

    if (canonicalSkuLookup.has(cleanLookupKey)) return canonicalSkuLookup.get(cleanLookupKey);
    if (canonicalSkuLookup.has('AC' + cleanLookupKey)) return canonicalSkuLookup.get('AC' + cleanLookupKey);

    if (cleanLookupKey.startsWith('DVB')) cleanLookupKey = cleanLookupKey.replace('DVB', 'VDB');
    if (cleanLookupKey.startsWith('SLB')) cleanLookupKey = cleanLookupKey.replace('SLB', 'BLS');
    if (canonicalSkuLookup.has(cleanLookupKey)) return canonicalSkuLookup.get(cleanLookupKey);
    if (canonicalSkuLookup.has('AC' + cleanLookupKey)) return canonicalSkuLookup.get('AC' + cleanLookupKey);

    return rawBaseSku; 
}

// --- ROUTE 1: Dual-Mode Vision Pipeline ---
app.post('/analyze', upload.single('image'), async (req, res) => {
    try {
        const imagePath = req.file.path;
        const base64Image = fs.readFileSync(imagePath, { encoding: 'base64' });
        const stylePrefix = req.body.prefix || "DW";

        const response = await openai.chat.completions.create({
            model: "gpt-4o",
            response_format: { type: "json_object" },
            messages: [
                {
                    role: "system",
                    content: `You are a professional Cabinetry Translation, Extraction, and Spatial Mapping Engine.
                    MASTER CATALOG UNIFIED REFERENCE: ${catalogData}

                    ### STEP 1: VERIFY FILE TYPE FIRST
                    Look closely at the image composition layout to detect its format:
                    - "SALES_LIST": A vertical document snippet containing typed text rows, invoices, or quotes on plain white space.
                    - "FLOOR_PLAN": An architectural schematic map drawing containing dimensional walls, room zones, and cabinet block shapes.

                    ### "SALES_LIST" PARSING PATHWAY:
                    1. Read down the text lines chronologically from top to bottom. 
                    2. TRACK COLOR HEADERS: Watch for category headers like "DW Shaker", "Blue Shaker", or "SC White". Items grouped below these blocks must be tagged with their respective style prefix (e.g. Items under "Blue Shaker" get "BS-", items under "DW Shaker" get "DW-").
                    3. TEXT MULTIPLIERS: Look directly for the "x" symbol to pull line quantities (e.g., "W3036 x 2" means quantity 2).
                    4. Leave the "boxes" coordinate array completely empty [] for this mode.

                    ### "FLOOR_PLAN" PARSING PATHWAY:
                    1. Ignore external margins, text metadata blocks, and client stamps (like "McKinley", "ZOEY II").
                    2. Every labeled cabinetry layout shape box drawn counts as a quantity of 1. Group duplicates and sum their total instances.
                    3. SPATIAL BOUNDING OVERLAYS: For every single box item counted on the blueprint drawing layout, you MUST calculate its precise bounding coordinates relative to the image borders as percentage strings ("top", "left", "width", "height").
                    4. Ensure your boxes wrap tightly around the target text labels and box boundaries on the drawing. Do not offset or skew them.
                    5. Use the workstation's default setting ("${stylePrefix}-") as the prefix for all blueprint entries.

                    OUTPUT FORMAT CONSTRAINTS:
                    Return ONLY a JSON object structured exactly with this schema:
                    {
                      "document_type": "SALES_LIST" or "FLOOR_PLAN",
                      "cabinets": [
                        {
                          "code": "PREFIX-UNIFIED_SKU",
                          "qty": 1,
                          "boxes": [
                            {"top": "15.5%", "left": "7.8%", "width": "10.5%", "height": "17.0%"}
                          ],
                          "reasoning": "Extracted item row standard verification details"
                        }
                      ]
                    }`
                },
                {
                    role: "user",
                    content: [
                        { type: "text", text: "Process this cabinetry file. Match all raw codes directly to their standard spacing and prefix formats." },
                        { type: "image_url", image_url: { url: `data:image/jpeg;base64,${base64Image}`, detail: "high" } }
                    ]
                }
            ]
        });

        fs.unlinkSync(imagePath);

        const aiOutput = JSON.parse(response.choices[0].message.content);
        const validPrefixes = ['DW', 'SC', 'GS', 'BS', 'SMS', 'SJ'];
        
        const aggregationMap = new Map();

        (aiOutput.cabinets || []).forEach(item => {
            let fullCode = item.code.toUpperCase().trim();
            let activePrefix = stylePrefix.toUpperCase();
            
            for (let p of validPrefixes) {
                if (fullCode.startsWith(`${p}-`)) {
                    activePrefix = p;
                    fullCode = fullCode.substring(p.length + 1);
                    break;
                }
            }

            let canonicalBaseSku = cleanAndNormalizeSku(fullCode);
            let structuralFinalCode = `${activePrefix}-${canonicalBaseSku}`;
            let extractedBoxes = item.boxes || [];

            if (aggregationMap.has(structuralFinalCode)) {
                let existingItem = aggregationMap.get(structuralFinalCode);
                existingItem.qty += parseInt(item.qty) || 1;
                if (Array.isArray(extractedBoxes)) {
                    existingItem.boxes.push(...extractedBoxes);
                }
            } else {
                aggregationMap.set(structuralFinalCode, {
                    code: structuralFinalCode,
                    qty: parseInt(item.qty) || 1,
                    boxes: Array.isArray(extractedBoxes) ? extractedBoxes : [],
                    reasoning: item.reasoning || 'Unified mapping validation'
                });
            }
        });

        const refinedCabinets = Array.from(aggregationMap.values()).filter(item => {
            const isAppliance = /DISH|IQ5|CKT|STOVE|REF|COOK|RANGE|FRIDGE/.test(item.code);
            return !isAppliance && !item.code.includes("MISSING");
        });

        res.json({ cabinets: refinedCabinets });

    } catch (error) {
        console.error("--- SCAN PIPELINE EXCEPTION ---");
        console.error(error);
        res.status(500).json({ error: "Document scanning execution failure", details: error.message });
    }
});

// --- ROUTE 2: PDF Text List Analysis ---
app.post('/analyze-pdf', upload.single('document'), async (req, res) => {
    try {
        if (!req.file) return res.status(400).send("No document file discovered.");
        const dataBuffer = fs.readFileSync(req.file.path);
        const stylePrefix = req.body.prefix || "DW";

        const rawText = await extractPdfText(dataBuffer);

        const response = await openai.chat.completions.create({
            model: "gpt-4o",
            response_format: { type: "json_object" },
            messages: [
                {
                    role: "system",
                    content: `Extract all item entries from this invoice text data. 
                    Output exact JSON alignment: {"cabinets": [{"code": "${stylePrefix}-SKU", "qty": 1, "boxes": [], "reasoning": "PDF Extraction"}]}`
                },
                {
                    role: "user",
                    content: `Extract from text context:\n\n${rawText}`
                }
            ]
        });

        fs.unlinkSync(req.file.path);
        res.json(JSON.parse(response.choices[0].message.content));

    } catch (error) {
        if (req.file && fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
        res.status(500).json({ error: error.message });
    }
});

// --- ROUTE 3: Push to Fishbowl ---
app.post('/push', async (req, res) => {
    const { items } = req.body;
    const { FISHBOWL_HOST, FISHBOWL_PORT, FISHBOWL_USER, FISHBOWL_PASS, FISHBOWL_DEFAULT_SO } = process.env;
    let token = null;

    try {
        const fallbackOrderNum = FISHBOWL_DEFAULT_SO || "10001";

        const loginRes = await fetch(`http://${FISHBOWL_HOST}:${FISHBOWL_PORT}/api/login`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ appName: "CabinetAI", appId: 1001, username: FISHBOWL_USER, password: FISHBOWL_PASS })
        });
        const loginData = await loginRes.json();
        token = loginData.token;

        if (!token) throw new Error("API handshake credential rejection.");

        const searchRes = await fetch(`http://${FISHBOWL_HOST}:${FISHBOWL_PORT}/api/sales-orders?num=${fallbackOrderNum}`, {
            headers: { 'Authorization': `Bearer ${token}` }
        });
        const orderArray = await searchRes.json();
        const order = orderArray ? orderArray[0] : null;

        if (!order) throw new Error(`Target open Order context space could not be reached inside client system.`);

        const newLines = items.map(i => ({
            productNumber: i.code,
            quantity: i.qty,
            uomCode: "ea",
            itemType: 10
        }));

        order.items = [...(order.items || []), ...newLines];

        await fetch(`http://${FISHBOWL_HOST}:${FISHBOWL_PORT}/api/sales-orders`, {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
            body: JSON.stringify(order)
        });

        res.json({ success: true, message: `Successfully pushed items into Fishbowl safely!` });

    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    } finally {
        if (token) fetch(`http://${FISHBOWL_HOST}:${FISHBOWL_PORT}/api/logout`, { method: 'POST', headers: { 'Authorization': `Bearer ${token}` } });
    }
});

app.listen(3000, () => console.log('Cabinet AI Unified Backend Server Online on port 3000'));