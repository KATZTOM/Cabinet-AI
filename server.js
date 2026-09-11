require('dotenv').config();
const express = require('express');
const cors = require('cors');
const multer = require('multer');
const { OpenAI } = require('openai');
const fs = require('fs');
const path = require('path');
const { exec, execSync } = require('child_process');

const app = express();

// Enable Cross-Origin Requests & JSON Parsing
app.use(cors());
app.use(express.json());
app.use(express.static('.'));
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// --- PERSISTENT FISHBOWL SESSION MANAGER ---
let cachedToken = null;
let tokenExpiry = 0;
let loginPromise = null;

async function getFishbowlToken() {
    const now = Date.now();
    if (cachedToken && now < tokenExpiry) {
        return cachedToken;
    }

    if (loginPromise) {
        return await loginPromise;
    }

    loginPromise = (async () => {
        try {
            const { FISHBOWL_HOST, FISHBOWL_PORT, FISHBOWL_USER, FISHBOWL_PASS } = process.env;
            const baseUrl = `http://${FISHBOWL_HOST}:${FISHBOWL_PORT}/api`;

            const loginRes = await fetch(`${baseUrl}/login`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    appName: "OrderPortalAI",
                    appId: 1001,
                    username: FISHBOWL_USER,
                    password: FISHBOWL_PASS
                })
            });

            if (!loginRes.ok) {
                const errText = await loginRes.text();
                throw new Error(`Fishbowl Login Failed (${loginRes.status}): ${errText}`);
            }

            const loginData = await loginRes.json();
            cachedToken = loginData.token;
            tokenExpiry = Date.now() + (10 * 60 * 1000);
            console.log("[FISHBOWL SESSION] Authenticated new token:", cachedToken.substring(0, 8) + "...");
            return cachedToken;
        } finally {
            loginPromise = null;
        }
    })();

    return await loginPromise;
}

async function executeFishbowlRequest(endpoint, options = {}) {
    const { FISHBOWL_HOST, FISHBOWL_PORT } = process.env;
    const baseUrl = `http://${FISHBOWL_HOST}:${FISHBOWL_PORT}/api`;

    let token = await getFishbowlToken();
    const targetUrl = endpoint.startsWith('http') ? endpoint : `${baseUrl}${endpoint}`;

    let response = await fetch(targetUrl, {
        ...options,
        headers: {
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'application/json',
            ...(options.headers || {})
        }
    });

    if (response.status === 401) {
        console.warn("[FISHBOWL SESSION] Token rejected (401). Re-authenticating...");
        cachedToken = null;
        token = await getFishbowlToken();
        response = await fetch(targetUrl, {
            ...options,
            headers: {
                'Authorization': `Bearer ${token}`,
                'Content-Type': 'application/json',
                ...(options.headers || {})
            }
        });
    }

    if (!response.ok) {
        const errText = await response.text();
        throw new Error(`Fishbowl API Error (${response.status}): ${errText}`);
    }

    return await response.json();
}

// REGISTER FISHBOWL ENGINE ON EXPRESS BEFORE MOUNTING ROUTES
app.set('executeFishbowlRequest', executeFishbowlRequest);
app.set('fishbowl', executeFishbowlRequest);

const scanRoutes = require('./routes/scanRoutes');
app.use('/api', scanRoutes);

// --- ROBUST MULTI-STRATEGY PDF TEXT EXTRACTION ENGINE ---
async function extractPdfText(buffer) {
    let fullText = '';
    try {
        const pdfParse = require('pdf-parse');
        const parsed = await pdfParse(buffer);
        if (parsed && parsed.text && parsed.text.trim().length > 0) {
            return parsed.text;
        }
    } catch (e) { }

    try {
        let pdfjsLib;
        try {
            pdfjsLib = require('pdfjs-dist/legacy/build/pdf.js');
        } catch (e1) {
            pdfjsLib = await import('pdfjs-dist/legacy/build/pdf.mjs');
        }
        if (pdfjsLib && pdfjsLib.default) pdfjsLib = pdfjsLib.default;

        const loadingTask = pdfjsLib.getDocument({
            data: new Uint8Array(buffer),
            useSystemFonts: true,
            disableFontFace: true
        });
        const pdf = await loadingTask.promise;
        for (let i = 1; i <= pdf.numPages; i++) {
            const page = await pdf.getPage(i);
            const content = await page.getTextContent();
            const pageText = content.items.map(item => item.str).join(' ');
            fullText += pageText + '\n';
        }
        return fullText;
    } catch (err) {
        console.error("[PDF ENGINE ERROR]", err.message);
        return '';
    }
}

const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        const dir = 'uploads/';
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        cb(null, dir);
    },
    filename: (req, file, cb) => {
        cb(null, file.originalname);
    }
});
const upload = multer({ storage: storage }).single('image');

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// --- MASTER CATALOG DICTIONARY INITIALIZATION ---
let catalogData = "{}";
const canonicalSkuLookup = new Map();

function buildInsensitiveValidationIndex(node) {
    if (!node || typeof node !== 'object') return;
    if (node.sku && typeof node.sku === 'string') {
        const originalSku = node.sku.trim();
        const ultraCleanKey = originalSku.toUpperCase().replace(/[\s\-\/*]/g, '');
        canonicalSkuLookup.set(ultraCleanKey, originalSku);
    }
    for (let key in node) {
        if (node.hasOwnProperty(key)) buildInsensitiveValidationIndex(node[key]);
    }
}

try {
    const rawCatalog = fs.readFileSync('./catalog.json', 'utf8');
    let parsedCatalog = [];
    try {
        parsedCatalog = JSON.parse(rawCatalog);
    } catch (e) {
        const blocks = rawCatalog.match(/\{[^{}]*\"sku\"\s*:[^{}]*\}/g) || [];
        blocks.forEach(block => {
            const sku_m = block.match(/\"sku\"\s*:\s*\"([^\"]+)\"/);
            if (sku_m) parsedCatalog.push({ sku: sku_m[1] });
        });
    }
    catalogData = JSON.stringify(parsedCatalog);
    buildInsensitiveValidationIndex(parsedCatalog);
    console.log(`[CATALOG ENGINE] Index Synced. Loaded ${canonicalSkuLookup.size} SKUs.`);
} catch (err) {
    console.error("CRITICAL ERROR: catalog.json cannot be indexed.");
}

// --- COLOR ALIAS MAP & SKU NORMALIZATION MATRIX ---
const COLOR_ALIAS_MAP = {
    'BLUE': 'BS', 'BS': 'BS', 'BLUE SHAKER': 'BS', 'BLUE_SHAKER': 'BS',
    'WHITE': 'DW', 'DW': 'DW', 'NW': 'DW', 'NEW WHITE': 'DW', 'NEW WHITE SHAKER': 'DW', 'NEW_WHITE': 'DW',
    'GREY': 'GS', 'GRAY': 'GS', 'GS': 'GS', 'GREY SHAKER': 'GS', 'GRAY SHAKER': 'GS',
    'CREAM': 'SC', 'SC': 'SC', 'SLIM CREAM': 'SC', 'SLIM_CREAM': 'SC',
    'JAVA': 'SJ', 'SJ': 'SJ', 'SLIM JAVA': 'SJ', 'SLIM_JAVA': 'SJ',
    'SMS': 'SMS', 'SUNNY': 'SMS', 'SUNNY MAPLE': 'SMS', 'SUNNY_MAPLE': 'SMS',
    'CDSH': 'CDSH', 'CINDER': 'CDSH', 'CINDER GREY': 'CDSH'
};

const SKU_DIRECT_OVERRIDES = {
    "FILLER336": "WF36", "FILLER3036": "WF36", "FILLER36": "WF36", "F336": "WF36",
    "AC-WF330": "WF36", "WF330": "WF36", "FILLER342": "WF42", "WF342": "WF42",
    "FILLER396": "F3 96", "F396": "F3 96", "F11/296": "F11/2 96",
    "COVE MOLDING 8": "COV", "COVE MOLDING": "COV", "COVEMOLDING8": "COV", "COVEMOLDING": "COV", "COV8": "COV",
    "SM8": "SM", "TK8": "TK", "QR8": "QRM",
    "VDB15-3": "VDB15", "VDB18-3": "VDB18", "VDB21-3": "VDB21", "VDB24-3": "VDB24",
    "DB12-3": "DB12", "DB15-3": "DB15", "DB18-3": "DB18", "DB21-3": "DB21", "DB24-3": "DB24", "DB30-3": "DB30", "DB36-3": "DB36",
    "CM4-1/2": "CM 4 1/2", "CM2-1/2": "CM 2 1/2"
};

function parseColorAndSku(rawCode, defaultPrefix = "DW") {
    if (!rawCode) return { color: defaultPrefix.toUpperCase(), sku: "" };

    let str = rawCode.trim().toUpperCase();
    let extractedColor = defaultPrefix.toUpperCase();

    for (const [alias, colorCode] of Object.entries(COLOR_ALIAS_MAP)) {
        if (str.startsWith(alias + '-') || str.startsWith(alias + '_') || str.startsWith(alias + ' ')) {
            extractedColor = colorCode;
            str = str.substring(alias.length + 1).trim();
            break;
        }
    }

    const prefixMatch = str.match(/^([A-Z\s_]+)[-_\s]+(.+)$/);
    if (prefixMatch) {
        const potentialColor = prefixMatch[1].trim();
        if (COLOR_ALIAS_MAP[potentialColor]) {
            extractedColor = COLOR_ALIAS_MAP[potentialColor];
            str = prefixMatch[2].trim();
        }
    }

    let sku = str.replace(' KIT', '').trim();

    if (SKU_DIRECT_OVERRIDES[sku]) {
        sku = SKU_DIRECT_OVERRIDES[sku];
    } else {
        const cleanKey = sku.replace(/[\s\-\/*]/g, '');
        if (SKU_DIRECT_OVERRIDES[cleanKey]) {
            sku = SKU_DIRECT_OVERRIDES[cleanKey];
        } else if (/^(SM|TK|BF3|BF6|COV|QR|QRM|CM)\d+$/.test(cleanKey)) {
            const baseLetters = cleanKey.match(/^([A-Z]+)/)[1];
            sku = (baseLetters === 'QR') ? 'QRM' : baseLetters;
        }
    }

    const cleanLookupKey = sku.replace(/[\s\-\/*]/g, '');

    if (canonicalSkuLookup.has(cleanLookupKey)) {
        sku = canonicalSkuLookup.get(cleanLookupKey);
    } else if (canonicalSkuLookup.has('AC' + cleanLookupKey)) {
        sku = canonicalSkuLookup.get('AC' + cleanLookupKey);
    }

    if (sku.toUpperCase().startsWith('AC-') || sku.toUpperCase().startsWith('AC')) {
        const cleanBase = sku.replace(/^AC-?/i, '').trim();
        const isAccessory = /^(WF|BF|COV|CM|F3|F1|TK|SM|QR)/i.test(cleanBase);
        if (!isAccessory) {
            sku = cleanBase;
        }
    }

    return { color: extractedColor, sku: sku };
}

function parsePdfTextLocally(rawText, stylePrefix = "DW") {
    if (!rawText || typeof rawText !== 'string') return [];

    const lines = rawText.split('\n');
    const aggregationMap = new Map();

    for (let line of lines) {
        const lineClean = line.trim();
        if (!lineClean) continue;

        const tokens = lineClean.split(/[\s,\t]+/);
        if (!tokens || tokens.length === 0) continue;

        let skuIdx = -1;
        let parsedResult = null;

        for (let idx = 0; idx < tokens.length; idx++) {
            let token = tokens[idx].trim();
            let parsed = parseColorAndSku(token, stylePrefix);
            let cleanKey = parsed.sku.replace(/[\s\-\/*]/g, '').toUpperCase();

            if (cleanKey && (canonicalSkuLookup.has(cleanKey) || canonicalSkuLookup.has('AC' + cleanKey))) {
                skuIdx = idx;
                parsedResult = parsed;
                break;
            }
        }

        if (skuIdx === -1 || !parsedResult || !parsedResult.sku) continue;

        let qty = null;
        for (let idx = 0; idx < tokens.length; idx++) {
            if (idx === skuIdx) continue;
            let token = tokens[idx];
            let match = token.match(/^(?:QTY[:=]?)?[xX]?(\d+)(?:ea|EA|x|X)?$/);
            if (match) {
                if (/[xXeaEAQTYqty]/.test(token)) {
                    qty = parseInt(match[1]);
                    break;
                }
            }
        }

        if (qty === null) {
            if (skuIdx + 1 < tokens.length && /^\d+$/.test(tokens[skuIdx + 1])) {
                qty = parseInt(tokens[skuIdx + 1]);
            } else if (skuIdx - 1 >= 0 && /^\d+$/.test(tokens[skuIdx - 1])) {
                qty = parseInt(tokens[skuIdx - 1]);
            } else {
                qty = 1;
            }
        }

        if (!qty || qty <= 0 || qty > 500) qty = 1;

        const fullCode = `${parsedResult.color}-${parsedResult.sku}`;
        if (/DISH|IQ5|CKT|STOVE|REF|COOK|RANGE|FRIDGE/.test(fullCode.toUpperCase())) continue;

        if (aggregationMap.has(fullCode)) {
            let existing = aggregationMap.get(fullCode);
            existing.qty += qty;
        } else {
            aggregationMap.set(fullCode, {
                code: fullCode,
                qty: qty,
                boxes: [],
                reasoning: "Local Deterministic Catalog & Pattern Parser"
            });
        }
    }

    return Array.from(aggregationMap.values());
}

// --- FISHBOWL PORTAL PROXY ENDPOINTS ---

app.get('/api/portal/orders', async (req, res) => {
    try {
        const getVal = (obj, key) => {
            if (!obj) return '';
            const foundKey = Object.keys(obj).find(k => k.toLowerCase() === key.toLowerCase());
            return foundKey ? obj[foundKey] : '';
        };

        const sqlQuery = `
            SELECT 
                so.id AS id, so.num AS num, c.name AS customerName,
                so.statusId AS statusId, ost.name AS statusName,
                COALESCE(so.salesman, 'House') AS salesman,
                COALESCE(so.subTotal, 0) AS total,
                (SELECT COALESCE(SUM(soi.qtyOrdered), 0) FROM soitem soi WHERE soi.soId = so.id) AS itemCount
            FROM so
            JOIN customer c ON so.customerId = c.id
            LEFT JOIN sostatus ost ON so.statusId = ost.id
            WHERE so.statusId != 90
            ORDER BY so.id DESC
            LIMIT 100
        `;

        const queryRes = await executeFishbowlRequest(`/data-query?query=${encodeURIComponent(sqlQuery)}`);
        const list = Array.isArray(queryRes) ? queryRes : (queryRes.results || queryRes.data || []);

        const orders = list.map(o => ({
            id: String(getVal(o, 'id') || '0'),
            num: String(getVal(o, 'num') || `SO ${getVal(o, 'id')}`),
            customerName: String(getVal(o, 'customerName') || 'General Account'),
            statusId: Number(getVal(o, 'statusId') || 10),
            statusName: String(getVal(o, 'statusName') || 'Estimate'),
            salesman: String(getVal(o, 'salesman') || 'House'),
            total: Number(getVal(o, 'total') || 0),
            itemCount: Number(getVal(o, 'itemCount') || 1)
        }));

        res.json({ success: true, count: orders.length, orders });
    } catch (err) {
        console.error("[PORTAL API ERROR] /orders:", err.message);
        res.status(500).json({ success: false, error: err.message, orders: [] });
    }
});

app.get('/api/portal/orders/:num/items', async (req, res) => {
    try {
        const { num } = req.params;
        const sqlQuery = `
            SELECT 
                soi.productNum AS productNumber,
                soi.qtyOrdered AS quantity,
                soi.description AS description
            FROM soitem soi
            JOIN so ON soi.soId = so.id
            WHERE so.num = '${num.replace(/'/g, "''")}'
            ORDER BY soi.id ASC
        `;
        const endpoint = `/data-query?query=${encodeURIComponent(sqlQuery)}`;
        const queryRes = await executeFishbowlRequest(endpoint);
        const list = Array.isArray(queryRes) ? queryRes : (queryRes.results || queryRes.data || []);

        res.json({ success: true, count: list.length, items: list });
    } catch (err) {
        console.warn("[PORTAL API ERROR] /orders/:num/items:", err.message);
        res.json({ success: false, items: [] });
    }
});

app.get('/api/portal/customers', async (req, res) => {
    try {
        const getVal = (obj, key) => {
            if (!obj) return '';
            const foundKey = Object.keys(obj).find(k => k.toLowerCase() === key.toLowerCase());
            return foundKey ? obj[foundKey] : '';
        };

        const sqlQuery = `
            SELECT 
                c.id AS id, 
                c.name AS name
            FROM customer c
            ORDER BY c.name ASC
            LIMIT 200
        `;

        const endpoint = `/data-query?query=${encodeURIComponent(sqlQuery)}`;
        const queryRes = await executeFishbowlRequest(endpoint);
        const list = Array.isArray(queryRes) ? queryRes : (queryRes.results || queryRes.data || []);

        const customers = list.map(c => ({
            id: String(getVal(c, 'id') || '0'),
            name: String(getVal(c, 'name') || 'Customer')
        }));

        res.json({ success: true, count: customers.length, customers });
    } catch (err) {
        console.warn("[PORTAL API ERROR] /customers:", err.message);
        res.json({ success: false, customers: [] });
    }
});

app.post('/api/stock-check', async (req, res) => {
    const { skus } = req.body;
    if (!skus || !skus.length) return res.json({ success: true, stockMap: {} });

    try {
        const searchNums = new Set();

        skus.forEach(s => {
            if (!s) return;
            const upper = s.trim().toUpperCase();
            searchNums.add(upper);

            const dashIdx = upper.indexOf('-');
            if (dashIdx !== -1) {
                const color = upper.substring(0, dashIdx);
                const clean = upper.substring(dashIdx + 1);
                searchNums.add(`${color}-AC-${clean}`);
                searchNums.add(`AC-${clean}`);
                searchNums.add(clean);
            } else {
                searchNums.add(`AC-${upper}`);
            }
        });

        const sqlNums = Array.from(searchNums).map(n => `'${n.replace(/'/g, "''")}'`).join(',');

        const sqlQuery = `
            SELECT 
                UPPER(p.num) AS partNumber,
                (SELECT COALESCE(SUM(q.qty), 0) FROM qtyonhand q WHERE q.partId = p.id) - 
                (SELECT COALESCE(SUM(a.qty), 0) FROM qtyallocated a WHERE a.partId = p.id) AS qtyAvailable,
                (SELECT COALESCE(SUM(q.qty), 0) FROM qtyonhand q WHERE q.partId = p.id) AS qtyOnHand
            FROM part p
            WHERE UPPER(p.num) IN (${sqlNums})
        `;

        const endpoint = `/data-query?query=${encodeURIComponent(sqlQuery)}`;
        const response = await executeFishbowlRequest(endpoint);
        const list = Array.isArray(response) ? response : (response.results || response.data || []);

        const stockMap = {};
        skus.forEach(fullSku => {
            const upperFull = fullSku.trim().toUpperCase();
            const dashIdx = upperFull.indexOf('-');
            const color = dashIdx !== -1 ? upperFull.substring(0, dashIdx) : '';
            const clean = dashIdx !== -1 ? upperFull.substring(dashIdx + 1) : upperFull;

            const match = list.find(i => i.partNumber === upperFull) ||
                list.find(i => i.partNumber === `${color}-AC-${clean}`) ||
                list.find(i => i.partNumber === `AC-${clean}`) ||
                list.find(i => i.partNumber === clean);

            stockMap[fullSku] = {
                available: match ? Number(match.qtyAvailable || 0) : 0,
                onHand: match ? Number(match.qtyOnHand || 0) : 0,
                offline: false
            };
        });

        res.json({ success: true, stockMap });
    } catch (err) {
        console.warn("[STOCK CHECK ERROR]:", err.message);
        res.json({ success: false, stockMap: {} });
    }
});

app.get('/api/portal/users', async (req, res) => {
    try {
        const data = await executeFishbowlRequest('/users');
        const list = Array.isArray(data) ? data : (data.users || data.results || []);
        res.json({ success: true, users: list });
    } catch (err) {
        console.error("[PORTAL API ERROR] /users:", err.message);
        res.status(500).json({ success: false, error: err.message });
    }
});

app.post('/analyze', (req, res) => {
    upload(req, res, async function (err) {
        if (err) return res.status(400).json({ error: "File upload error: " + err.message });

        try {
            let filePath = req.file ? req.file.path : null;
            let originalName = req.file ? req.file.originalname : req.body.fileName;
            let mimetype = req.file ? req.file.mimetype : '';

            if (!filePath && originalName) {
                filePath = path.join('uploads', originalName);
                mimetype = originalName.toLowerCase().endsWith('.pdf') ? 'application/pdf' : 'image/jpeg';
            }

            if (!filePath || !fs.existsSync(filePath)) {
                return res.status(400).json({ error: `Document file "${originalName || ''}" not found on server disk.` });
            }

            const stylePrefix = req.body.prefix || "DW";
            const isPdf = (mimetype === 'application/pdf') || (originalName && originalName.toLowerCase().endsWith('.pdf'));
            let openAiPayload;

            if (isPdf) {
                const dataBuffer = fs.readFileSync(filePath);
                const rawText = await extractPdfText(dataBuffer);

                if (rawText && rawText.trim().length >= 5) {
                    const localResults = parsePdfTextLocally(rawText, stylePrefix);
                    if (localResults && localResults.length > 0) {
                        return res.json({ cabinets: localResults, scan_method: "LOCAL_DETERMINISTIC_ALGORITHM" });
                    }

                    openAiPayload = {
                        model: "gpt-4o",
                        response_format: { type: "json_object" },
                        messages: [
                            {
                                role: "system",
                                content: `You are a professional Cabinetry Invoice and Sales List Extraction Engine. Master Catalog: ${catalogData}. Extract all valid cabinet lines from text. Respond in JSON format only matching this schema: {"document_type": "SALES_LIST", "cabinets": [{"code": "${stylePrefix}-SKU", "qty": 1, "boxes": [], "reasoning": "PDF Extraction"}]}`
                            },
                            { role: "user", content: `Process this cabinetry invoice text data in JSON format:\n\n${rawText}` }
                        ]
                    };
                } else {
                    try {
                        const outputPngPath = path.join('uploads', originalName + '_converted.png');
                        let pyCmd = 'python';
                        try {
                            execSync('python --version', { stdio: 'ignore' });
                        } catch (e) {
                            pyCmd = 'py';
                        }

                        execSync(`${pyCmd} pdf_convert.py "${filePath}" "${outputPngPath}"`);

                        if (!fs.existsSync(outputPngPath)) {
                            throw new Error("Converted PNG image was not created.");
                        }

                        const base64Image = fs.readFileSync(outputPngPath, { encoding: 'base64' });

                        openAiPayload = {
                            model: "gpt-4o",
                            response_format: { type: "json_object" },
                            messages: [
                                {
                                    role: "system",
                                    content: `You are a professional Cabinetry Spatial Mapping Engine. Master Catalog: ${catalogData}. Respond in JSON format only matching this schema: {"document_type": "FLOOR_PLAN", "cabinets": [{"code": "PREFIX-SKU", "qty": 1, "boxes": [{"top": "10%", "left": "5%", "width": "5%", "height": "5%"}], "reasoning": "Blueprint vision scan"}]}`
                                },
                                {
                                    role: "user",
                                    content: [
                                        { type: "text", text: "Process this cabinetry layout file and output the detected items in JSON format." },
                                        { type: "image_url", image_url: { url: `data:image/png;base64,${base64Image}`, detail: "high" } }
                                    ]
                                }
                            ]
                        };
                    } catch (convErr) {
                        return res.status(400).json({
                            error: `Failed to process scanned PDF: ${convErr.message}. Make sure 'pip install pymupdf' is installed.`
                        });
                    }
                }
            } else {
                const base64Image = fs.readFileSync(filePath, { encoding: 'base64' });
                openAiPayload = {
                    model: "gpt-4o",
                    response_format: { type: "json_object" },
                    messages: [
                        {
                            role: "system",
                            content: `You are a professional Cabinetry Spatial Mapping Engine. Master Catalog: ${catalogData}. Respond in JSON format only matching this schema: {"document_type": "FLOOR_PLAN", "cabinets": [{"code": "PREFIX-SKU", "qty": 1, "boxes": [{"top": "10%", "left": "5%", "width": "5%", "height": "5%"}], "reasoning": "Blueprint vision scan"}]}`
                        },
                        {
                            role: "user",
                            content: [
                                { type: "text", text: "Process this cabinetry layout file and output the detected items in JSON format." },
                                { type: "image_url", image_url: { url: `data:image/jpeg;base64,${base64Image}`, detail: "high" } }
                            ]
                        }
                    ]
                };
            }

            const response = await openai.chat.completions.create(openAiPayload);
            const aiOutput = JSON.parse(response.choices[0].message.content);
            const aggregationMap = new Map();

            (aiOutput.cabinets || []).forEach(item => {
                let parsed = parseColorAndSku(item.code || '', stylePrefix);
                let structuralFinalCode = `${parsed.color}-${parsed.sku}`;
                let extractedBoxes = item.boxes || [];
                if (aggregationMap.has(structuralFinalCode)) {
                    let existingItem = aggregationMap.get(structuralFinalCode);
                    existingItem.qty += parseInt(item.qty) || 1;
                    if (Array.isArray(extractedBoxes)) existingItem.boxes.push(...extractedBoxes);
                } else {
                    aggregationMap.set(structuralFinalCode, {
                        code: structuralFinalCode, qty: parseInt(item.qty) || 1,
                        boxes: Array.isArray(extractedBoxes) ? extractedBoxes : [],
                        reasoning: item.reasoning || 'Unified mapping validation'
                    });
                }
            });

            res.json({ cabinets: Array.from(aggregationMap.values()).filter(item => !/DISH|IQ5|CKT|STOVE|REF|COOK|RANGE|FRIDGE/.test(item.code) && !item.code.includes("MISSING")) });
        } catch (error) { res.status(500).json({ error: error.message }); }
    });
});

app.post('/push', async (req, res) => {
    const { items } = req.body;
    const { FISHBOWL_DEFAULT_SO } = process.env;
    try {
        const fallbackOrderNum = FISHBOWL_DEFAULT_SO || "10001";
        const orderArray = await executeFishbowlRequest(`/sales-orders?num=${fallbackOrderNum}`);
        const order = Array.isArray(orderArray) ? orderArray[0] : orderArray;

        if (!order) throw new Error(`Target open order not reached.`);
        order.items = [...(order.items || []), ...items.map(i => ({ productNumber: i.code, quantity: i.qty, uomCode: "ea", itemType: 10 }))];

        await executeFishbowlRequest(`/sales-orders`, {
            method: 'POST',
            body: JSON.stringify(order)
        });

        res.json({ success: true, message: `Successfully pushed items into Fishbowl!` });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// --- WORKSPACE STAGING ENDPOINTS ---
app.post(['/api/stage-workspace', '/api/stage-order'], (req, res) => {
    try {
        const payload = req.body;
        fs.writeFileSync('./staged_workspace.json', JSON.stringify(payload, null, 2), 'utf8');
        const itemsOnly = Array.isArray(payload) ? payload : (payload.items || []);
        fs.writeFileSync('./staged_order.json', JSON.stringify(itemsOnly, null, 2), 'utf8');
        res.json({ success: true });
    } catch (error) { res.status(500).json({ success: false, error: error.message }); }
});

app.get(['/api/stage-workspace', '/api/stage-order'], (req, res) => {
    try {
        if (fs.existsSync('./staged_workspace.json')) {
            res.json(JSON.parse(fs.readFileSync('./staged_workspace.json', 'utf8')));
        } else if (fs.existsSync('./staged_order.json')) {
            res.json({ items: JSON.parse(fs.readFileSync('./staged_order.json', 'utf8')), files: [] });
        } else {
            res.json({ items: [], files: [] });
        }
    } catch (error) { res.status(500).json({ error: error.message }); }
});

app.get('/api/uploaded-files', (req, res) => {
    const dir = './uploads';
    if (!fs.existsSync(dir)) return res.json([]);
    fs.readdir(dir, (err, files) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(files.filter(f => !f.startsWith('.')).map(f => ({ name: f, url: `/uploads/${f}` })));
    });
});

app.post('/api/upload-file', (req, res) => {
    upload(req, res, function (err) {
        if (err) return res.status(400).json({ error: err.message });
        if (!req.file) return res.status(400).json({ error: "No file uploaded" });
        res.json({ success: true, name: req.file.originalname, url: `/uploads/${req.file.originalname}` });
    });
});

app.delete('/api/uploaded-files/:filename', (req, res) => {
    try {
        const filename = path.basename(req.params.filename);
        const filePath = path.join(__dirname, 'uploads', filename);
        if (fs.existsSync(filePath)) {
            fs.unlinkSync(filePath);
        }
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// --- 3D WAREHOUSE DIGITAL TWIN INVENTORY API ---
app.get('/api/warehouse/inventory', async (req, res) => {
    try {
        const sqlQuery = `
            SELECT 
                l.id AS locationId,
                l.name AS locationName,
                p.num AS sku,
                COALESCE(p.description, '') AS description,
                SUM(t.qty) AS qtyOnHand
            FROM tag t
            JOIN location l ON t.locationId = l.id
            JOIN part p ON t.partId = p.id
            WHERE t.qty > 0
            GROUP BY l.id, l.name, p.num, p.description
            ORDER BY l.name ASC
        `;

        const endpoint = `/data-query?query=${encodeURIComponent(sqlQuery)}`;
        const queryRes = await executeFishbowlRequest(endpoint);
        const list = Array.isArray(queryRes) ? queryRes : (queryRes.results || queryRes.data || []);

        if (!list || list.length === 0) {
            throw new Error("No inventory items returned from database.");
        }

        const inventory = list.map(item => ({
            locationId: item.locationId || item.LOCATIONID,
            locationName: item.locationName || item.LOCATIONNAME || 'Unassigned',
            sku: item.sku || item.SKU,
            description: item.description || item.DESCRIPTION || '',
            qty: Number(item.qtyOnHand || item.QTYONHAND || 0)
        }));

        res.json({ success: true, count: inventory.length, inventory });
    } catch (err) {
        console.warn('[WAREHOUSE API WARNING]', err.message, "-> Loading offline fallback inventory.");
        
        // Sample fallback data so the 3D map renders occupied racks when offline
        const fallbackInventory = [
            { locationName: "A-01-1", sku: "DW-B12", description: "Base Cabinet 12\"", qty: 15 },
            { locationName: "A-01-2", sku: "DW-B24", description: "Base Cabinet 24\"", qty: 8 },
            { locationName: "B-02-1", sku: "SC-W3030", description: "Wall Cabinet 30\"", qty: 22 },
            { locationName: "B-02-2", sku: "GS-DB15", description: "Drawer Base 15\"", qty: 10 }
        ];

        res.json({ success: true, count: fallbackInventory.length, inventory: fallbackInventory, offlineFallback: true });
    }
});

// SERVE MAIN WORKSTATION APP AT ROOT
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// SERVE STANDALONE 3D WAREHOUSE COMPONENT
app.get('/map', (req, res) => {
    res.sendFile(path.join(__dirname, 'warehouse_map.html'));
});

// --- PALLET PACKING CALCULATOR API ---
app.post('/api/calculate-pallets', async (req, res) => {
    try {
        const { items, assembly_mode, ai_recommendation, ai_config } = req.body;

        let aiConfig = ai_config || {
            force_lie_flat: false,
            custom_max_h: 70.0,
            target_pallet_count: null
        };
        let aiExplanation = "";

        // 1. CALL OPENAI GPT MODEL TO REASON ABOUT THE USER'S PACKING PROMPT
        if (ai_recommendation && ai_recommendation.trim().length > 0) {
            try {
                const aiResponse = await openai.chat.completions.create({
                    model: "gpt-4o-mini",
                    messages: [
                        {
                            role: "system",
                            content: `You are an expert 3D Warehouse Logistics Copilot. Analyze the user's packing request and output JSON with:
              1. "target_pallet_count": (integer or null, e.g. 2 for "make 2 pallets")
              2. "custom_max_h": (number, default 70.0, max height in inches)
              3. "force_lie_flat": (boolean)
              4. "reply": (A short, intelligent explanation of what you decided to do)`
                        },
                        {
                            role: "user",
                            content: `Order Items: ${JSON.stringify(items)}\nUser Request: "${ai_recommendation}"`
                        }
                    ],
                    response_format: { type: "json_object" }
                });

                const aiParsed = JSON.parse(aiResponse.choices[0].message.content);
                aiConfig = {
                    target_pallet_count: aiParsed.target_pallet_count || aiConfig.target_pallet_count,
                    custom_max_h: aiParsed.custom_max_h || aiConfig.custom_max_h,
                    force_lie_flat: aiParsed.force_lie_flat || aiConfig.force_lie_flat
                };
                aiExplanation = aiParsed.reply;
            } catch (aiErr) {
                console.warn("[AI COPILOT WARNING] GPT processing skipped:", aiErr.message);
            }
        }

        // 2. PASS AI-GENERATED MATH CONSTRAINTS TO PYTHON PACKING ENGINE
        const payload = {
            items: items || [],
            assembly_mode: assembly_mode || 'flat_pack',
            ai_config: aiConfig
        };

        const tempFile = path.join(__dirname, `temp_payload_${Date.now()}.json`);
        fs.writeFileSync(tempFile, JSON.stringify(payload, null, 2));

        exec(`python packer_engine.py "${tempFile}"`, (error, stdout, stderr) => {
            if (fs.existsSync(tempFile)) fs.unlinkSync(tempFile); // Cleanup

            if (error) {
                console.error("[PACKER ENGINE ERROR]", stderr || error.message);
                return res.status(500).json({ error: "Pallet engine execution failed." });
            }

            try {
                const result = JSON.parse(stdout);
                if (aiExplanation) {
                    result.ai_explanation = aiExplanation;
                }
                res.json(result);
            } catch (parseErr) {
                res.status(500).json({ error: "Failed to parse pallet engine output." });
            }
        });

    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.listen(3001, () => console.log('Cabinet AI Backend Server Running on port 3001'));