const express = require('express');
const path = require('path');
const fs = require('fs');
const initSqlJs = require('sql.js');
const multer = require('multer');

const PARSE_PROMPT = `Extract ALL recipes from this document. For each recipe, return a JSON array of objects with these exact fields:
- "name": string (recipe name)
- "description": string (brief description or cooking notes)
- "category": string (one of: Main, Side, Breakfast, Soup, Salad, Dessert, Snack, Drink)
- "ingredients": array of {"name": string, "quantity": number or null, "unit": string}
- "steps": array of strings, each string is one instruction step in order

Return ONLY valid JSON array, no markdown, no explanation. If quantities are written as fractions like "1/2", convert to decimal (0.5). If no quantity is specified, use null. If no steps/instructions are found, use an empty array.`;

const app = express();
const PORT = process.env.PORT || 3000;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || '';

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

app.use(express.json({ limit: '5mb' }));
app.use(express.static(path.join(__dirname, 'public')));

let db;

async function initDB() {
    const SQL = await initSqlJs();
    const dbPath = process.env.DB_PATH || path.join(__dirname, 'data', 'menu.db');
    const dataDir = path.dirname(dbPath);
    dbFilePath = dbPath;
    
    console.log('DB_PATH env:', process.env.DB_PATH || '(not set)');
    console.log('Using database at:', dbPath);
    console.log('Data dir exists:', fs.existsSync(dataDir));
    console.log('DB file exists:', fs.existsSync(dbPath));
    
    if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
    
    if (fs.existsSync(dbPath)) {
        const buffer = fs.readFileSync(dbPath);
        db = new SQL.Database(buffer);
    } else {
        db = new SQL.Database();
    }

    db.run(`CREATE TABLE IF NOT EXISTS menu_items (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        description TEXT,
        category TEXT DEFAULT 'Main',
        easy INTEGER DEFAULT 0,
        created_at TEXT DEFAULT (datetime('now'))
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS ingredients (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        menu_item_id INTEGER NOT NULL,
        name TEXT NOT NULL,
        quantity REAL,
        unit TEXT,
        FOREIGN KEY (menu_item_id) REFERENCES menu_items(id) ON DELETE CASCADE
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS steps (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        menu_item_id INTEGER NOT NULL,
        step_number INTEGER NOT NULL,
        instruction TEXT NOT NULL,
        FOREIGN KEY (menu_item_id) REFERENCES menu_items(id) ON DELETE CASCADE
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS meal_plan (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        menu_item_id INTEGER NOT NULL,
        plan_date TEXT NOT NULL,
        meal_type TEXT DEFAULT 'dinner',
        FOREIGN KEY (menu_item_id) REFERENCES menu_items(id) ON DELETE CASCADE
    )`);

    // Migration: add easy column if it doesn't exist
    try { db.run(`ALTER TABLE menu_items ADD COLUMN easy INTEGER DEFAULT 0`); } catch(e) {}

    saveDB();
    console.log('Database initialized');
}

let dbFilePath;

function saveDB() {
    const data = db.export();
    const buffer = Buffer.from(data);
    fs.writeFileSync(dbFilePath, buffer);
}

// ── Debug ──
app.get('/api/debug', (req, res) => {
    const info = {
        DB_PATH_env: process.env.DB_PATH || '(not set)',
        dbFilePath: dbFilePath,
        dbFileExists: fs.existsSync(dbFilePath),
        dataDir: path.dirname(dbFilePath),
        dataDirExists: fs.existsSync(path.dirname(dbFilePath)),
        dataDirContents: fs.existsSync(path.dirname(dbFilePath)) ? fs.readdirSync(path.dirname(dbFilePath)) : [],
        menuItemCount: 0
    };
    try {
        const result = db.exec('SELECT COUNT(*) as cnt FROM menu_items');
        if (result.length) info.menuItemCount = result[0].values[0][0];
    } catch(e) { info.dbError = e.message; }
    res.json(info);
});

// ── Menu Items CRUD ──

app.get('/api/menu-items', (req, res) => {
    const items = db.exec(`SELECT * FROM menu_items ORDER BY name`);
    if (!items.length) return res.json([]);
    const cols = items[0].columns;
    const rows = items[0].values.map(r => Object.fromEntries(cols.map((c, i) => [c, r[i]])));
    res.json(rows);
});

app.get('/api/menu-items/:id', (req, res) => {
    const item = db.exec(`SELECT * FROM menu_items WHERE id = ?`, [req.params.id]);
    if (!item.length || !item[0].values.length) return res.status(404).json({ error: 'Not found' });
    const cols = item[0].columns;
    const row = Object.fromEntries(cols.map((c, i) => [c, item[0].values[0][i]]));

    const ings = db.exec(`SELECT * FROM ingredients WHERE menu_item_id = ? ORDER BY name`, [req.params.id]);
    row.ingredients = [];
    if (ings.length) {
        const icols = ings[0].columns;
        row.ingredients = ings[0].values.map(r => Object.fromEntries(icols.map((c, i) => [c, r[i]])));
    }

    const stps = db.exec(`SELECT * FROM steps WHERE menu_item_id = ? ORDER BY step_number`, [req.params.id]);
    row.steps = [];
    if (stps.length) {
        const scols = stps[0].columns;
        row.steps = stps[0].values.map(r => Object.fromEntries(scols.map((c, i) => [c, r[i]])));
    }
    res.json(row);
});

app.post('/api/menu-items', (req, res) => {
    const { name, description, category, easy, ingredients, steps } = req.body;
    if (!name) return res.status(400).json({ error: 'Name required' });

    db.run(`INSERT INTO menu_items (name, description, category, easy) VALUES (?, ?, ?, ?)`,
        [name, description || '', category || 'Main', easy ? 1 : 0]);
    const idResult = db.exec(`SELECT last_insert_rowid() as id`);
    const id = idResult[0].values[0][0];

    if (ingredients && ingredients.length) {
        for (const ing of ingredients) {
            db.run(`INSERT INTO ingredients (menu_item_id, name, quantity, unit) VALUES (?, ?, ?, ?)`,
                [id, ing.name, ing.quantity || null, ing.unit || '']);
        }
    }
    if (steps && steps.length) {
        for (let i = 0; i < steps.length; i++) {
            const instruction = typeof steps[i] === 'string' ? steps[i] : steps[i].instruction;
            if (instruction) {
                db.run(`INSERT INTO steps (menu_item_id, step_number, instruction) VALUES (?, ?, ?)`,
                    [id, i + 1, instruction]);
            }
        }
    }
    saveDB();
    res.json({ id, name, description, category });
});

app.put('/api/menu-items/:id', (req, res) => {
    const { name, description, category, easy, ingredients, steps } = req.body;
    db.run(`UPDATE menu_items SET name=?, description=?, category=?, easy=? WHERE id=?`,
        [name, description || '', category || 'Main', easy ? 1 : 0, req.params.id]);

    // Replace all ingredients
    db.run(`DELETE FROM ingredients WHERE menu_item_id = ?`, [req.params.id]);
    if (ingredients && ingredients.length) {
        for (const ing of ingredients) {
            db.run(`INSERT INTO ingredients (menu_item_id, name, quantity, unit) VALUES (?, ?, ?, ?)`,
                [req.params.id, ing.name, ing.quantity || null, ing.unit || '']);
        }
    }
    // Replace all steps
    db.run(`DELETE FROM steps WHERE menu_item_id = ?`, [req.params.id]);
    if (steps && steps.length) {
        for (let i = 0; i < steps.length; i++) {
            const instruction = typeof steps[i] === 'string' ? steps[i] : steps[i].instruction;
            if (instruction) {
                db.run(`INSERT INTO steps (menu_item_id, step_number, instruction) VALUES (?, ?, ?)`,
                    [req.params.id, i + 1, instruction]);
            }
        }
    }
    saveDB();
    res.json({ success: true });
});

app.delete('/api/menu-items/:id', (req, res) => {
    db.run(`DELETE FROM ingredients WHERE menu_item_id = ?`, [req.params.id]);
    db.run(`DELETE FROM steps WHERE menu_item_id = ?`, [req.params.id]);
    db.run(`DELETE FROM meal_plan WHERE menu_item_id = ?`, [req.params.id]);
    db.run(`DELETE FROM menu_items WHERE id = ?`, [req.params.id]);
    saveDB();
    res.json({ success: true });
});

// ── Meal Plan ──

app.get('/api/meal-plan', (req, res) => {
    const { start, end } = req.query;
    let query = `SELECT mp.*, mi.name as menu_item_name, mi.category 
                 FROM meal_plan mp 
                 JOIN menu_items mi ON mp.menu_item_id = mi.id`;
    const params = [];
    if (start && end) {
        query += ` WHERE mp.plan_date >= ? AND mp.plan_date <= ?`;
        params.push(start, end);
    }
    query += ` ORDER BY mp.plan_date, mp.meal_type`;

    const results = db.exec(query, params);
    if (!results.length) return res.json([]);
    const cols = results[0].columns;
    res.json(results[0].values.map(r => Object.fromEntries(cols.map((c, i) => [c, r[i]]))));
});

app.post('/api/meal-plan', (req, res) => {
    const { menu_item_id, plan_date, meal_type } = req.body;
    if (!menu_item_id || !plan_date) return res.status(400).json({ error: 'menu_item_id and plan_date required' });

    db.run(`INSERT INTO meal_plan (menu_item_id, plan_date, meal_type) VALUES (?, ?, ?)`,
        [menu_item_id, plan_date, meal_type || 'dinner']);
    const idResult = db.exec(`SELECT last_insert_rowid() as id`);
    saveDB();
    res.json({ id: idResult[0].values[0][0], menu_item_id, plan_date, meal_type });
});

app.delete('/api/meal-plan/:id', (req, res) => {
    db.run(`DELETE FROM meal_plan WHERE id = ?`, [req.params.id]);
    saveDB();
    res.json({ success: true });
});

// Move a meal plan entry to a different date
app.put('/api/meal-plan/:id', (req, res) => {
    const { plan_date, meal_type } = req.body;
    db.run(`UPDATE meal_plan SET plan_date=?, meal_type=? WHERE id=?`,
        [plan_date, meal_type || 'dinner', req.params.id]);
    saveDB();
    res.json({ success: true });
});

// ── Shopping List ──

app.get('/api/shopping-list', (req, res) => {
    const { start, end } = req.query;
    if (!start || !end) return res.status(400).json({ error: 'start and end dates required' });

    // Get all planned meals in range
    const meals = db.exec(`
        SELECT mp.plan_date, mp.meal_type, mi.name as menu_item_name, mi.id as menu_item_id
        FROM meal_plan mp
        JOIN menu_items mi ON mp.menu_item_id = mi.id
        WHERE mp.plan_date >= ? AND mp.plan_date <= ?
        ORDER BY mp.plan_date
    `, [start, end]);

    const mealList = [];
    if (meals.length) {
        const cols = meals[0].columns;
        meals[0].values.forEach(r => {
            mealList.push(Object.fromEntries(cols.map((c, i) => [c, r[i]])));
        });
    }

    // Get aggregated ingredients
    const ings = db.exec(`
        SELECT i.name, i.unit, SUM(i.quantity) as total_quantity
        FROM meal_plan mp
        JOIN ingredients i ON i.menu_item_id = mp.menu_item_id
        WHERE mp.plan_date >= ? AND mp.plan_date <= ?
        GROUP BY LOWER(i.name), LOWER(i.unit)
        ORDER BY i.name
    `, [start, end]);

    const ingredients = [];
    if (ings.length) {
        const cols = ings[0].columns;
        ings[0].values.forEach(r => {
            ingredients.push(Object.fromEntries(cols.map((c, i) => [c, r[i]])));
        });
    }

    res.json({ meals: mealList, ingredients });
});

// ── Recipe Import (Claude AI) ──

app.post('/api/import-recipes', upload.single('file'), async (req, res) => {
    if (!ANTHROPIC_API_KEY) {
        return res.status(500).json({ error: 'ANTHROPIC_API_KEY not configured on server' });
    }
    if (!req.file) {
        return res.status(400).json({ error: 'No file uploaded' });
    }

    try {
        let textContent = '';
        let messages = [];
        const mime = req.file.mimetype;

        // Extract text based on file type
        if (mime === 'application/pdf') {
            // Send PDF directly to Claude as a document
            const base64 = req.file.buffer.toString('base64');
            messages = [{
                role: 'user',
                content: [
                    {
                        type: 'document',
                        source: { type: 'base64', media_type: 'application/pdf', data: base64 }
                    },
                    {
                        type: 'text',
                        text: PARSE_PROMPT
                    }
                ]
            }];
        } else if (mime.startsWith('text/') || mime === 'application/json') {
            textContent = req.file.buffer.toString('utf-8');
        } else if (mime.startsWith('image/')) {
            // Send image directly to Claude as base64
            const base64 = req.file.buffer.toString('base64');
            const mediaType = mime === 'image/jpg' ? 'image/jpeg' : mime;
            messages = [{
                role: 'user',
                content: [
                    {
                        type: 'image',
                        source: { type: 'base64', media_type: mediaType, data: base64 }
                    },
                    {
                        type: 'text',
                        text: PARSE_PROMPT
                    }
                ]
            }];
        } else if (mime === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' ||
                   mime === 'application/msword') {
            // Send Word docs directly to Claude as base64 documents
            const base64 = req.file.buffer.toString('base64');
            const mediaType = mime === 'application/msword'
                ? 'application/msword'
                : 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
            messages = [{
                role: 'user',
                content: [
                    {
                        type: 'document',
                        source: { type: 'base64', media_type: mediaType, data: base64 }
                    },
                    {
                        type: 'text',
                        text: PARSE_PROMPT
                    }
                ]
            }];
        } else {
            // Try to read as text anyway
            textContent = req.file.buffer.toString('utf-8');
        }

        // Build messages for text-based content
        if (!messages.length) {
            if (!textContent.trim()) {
                return res.status(400).json({ error: 'Could not extract text from file. Try PDF, TXT, or an image.' });
            }
            messages = [{
                role: 'user',
                content: `${PARSE_PROMPT}

---
${textContent}
---`
            }];
        }

        // Call Claude API
        const response = await fetch('https://api.anthropic.com/v1/messages', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-api-key': ANTHROPIC_API_KEY,
                'anthropic-version': '2023-06-01'
            },
            body: JSON.stringify({
                model: 'claude-haiku-4-5-20251001',
                max_tokens: 4096,
                messages
            })
        });

        if (!response.ok) {
            const errBody = await response.text();
            console.error('Claude API error:', response.status, errBody);
            return res.status(500).json({ error: `Claude API error: ${response.status}`, details: errBody });
        }

        const data = await response.json();
        const text = data.content.map(c => c.text || '').join('');
        
        // Parse JSON from Claude's response (strip any markdown fences just in case)
        const cleaned = text.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();
        let recipes;
        try {
            recipes = JSON.parse(cleaned);
        } catch (parseErr) {
            console.error('Failed to parse Claude response:', cleaned);
            return res.status(500).json({ error: 'Failed to parse recipes from AI response', raw: cleaned });
        }

        if (!Array.isArray(recipes)) {
            recipes = [recipes];
        }

        // Insert into database
        const inserted = [];
        for (const recipe of recipes) {
            if (!recipe.name) continue;
            db.run(`INSERT INTO menu_items (name, description, category) VALUES (?, ?, ?)`,
                [recipe.name, recipe.description || '', recipe.category || 'Main']);
            const idResult = db.exec(`SELECT last_insert_rowid() as id`);
            const id = idResult[0].values[0][0];

            if (recipe.ingredients && recipe.ingredients.length) {
                for (const ing of recipe.ingredients) {
                    if (!ing.name) continue;
                    db.run(`INSERT INTO ingredients (menu_item_id, name, quantity, unit) VALUES (?, ?, ?, ?)`,
                        [id, ing.name, ing.quantity || null, ing.unit || '']);
                }
            }
            if (recipe.steps && recipe.steps.length) {
                for (let i = 0; i < recipe.steps.length; i++) {
                    const instruction = typeof recipe.steps[i] === 'string' ? recipe.steps[i] : recipe.steps[i].instruction;
                    if (instruction) {
                        db.run(`INSERT INTO steps (menu_item_id, step_number, instruction) VALUES (?, ?, ?)`,
                            [id, i + 1, instruction]);
                    }
                }
            }
            inserted.push({ id, name: recipe.name, ingredientCount: (recipe.ingredients || []).length });
        }
        saveDB();

        res.json({ success: true, imported: inserted });

    } catch (err) {
        console.error('Import error:', err);
        res.status(500).json({ error: 'Import failed: ' + err.message });
    }
});

// ── Serve HTML ──
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

initDB().then(() => {
    app.listen(PORT, () => console.log(`Menu Planner running on port ${PORT}`));
});
