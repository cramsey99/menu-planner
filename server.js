const express = require('express');
const path = require('path');
const fs = require('fs');
const initSqlJs = require('sql.js');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

let db;

async function initDB() {
    const SQL = await initSqlJs();
    const dbPath = path.join(__dirname, 'data', 'menu.db');
    const dataDir = path.join(__dirname, 'data');
    
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

    db.run(`CREATE TABLE IF NOT EXISTS meal_plan (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        menu_item_id INTEGER NOT NULL,
        plan_date TEXT NOT NULL,
        meal_type TEXT DEFAULT 'dinner',
        FOREIGN KEY (menu_item_id) REFERENCES menu_items(id) ON DELETE CASCADE
    )`);

    saveDB();
    console.log('Database initialized');
}

function saveDB() {
    const data = db.export();
    const buffer = Buffer.from(data);
    fs.writeFileSync(path.join(__dirname, 'data', 'menu.db'), buffer);
}

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
    res.json(row);
});

app.post('/api/menu-items', (req, res) => {
    const { name, description, category, ingredients } = req.body;
    if (!name) return res.status(400).json({ error: 'Name required' });

    db.run(`INSERT INTO menu_items (name, description, category) VALUES (?, ?, ?)`,
        [name, description || '', category || 'Main']);
    const idResult = db.exec(`SELECT last_insert_rowid() as id`);
    const id = idResult[0].values[0][0];

    if (ingredients && ingredients.length) {
        for (const ing of ingredients) {
            db.run(`INSERT INTO ingredients (menu_item_id, name, quantity, unit) VALUES (?, ?, ?, ?)`,
                [id, ing.name, ing.quantity || null, ing.unit || '']);
        }
    }
    saveDB();
    res.json({ id, name, description, category });
});

app.put('/api/menu-items/:id', (req, res) => {
    const { name, description, category, ingredients } = req.body;
    db.run(`UPDATE menu_items SET name=?, description=?, category=? WHERE id=?`,
        [name, description || '', category || 'Main', req.params.id]);

    // Replace all ingredients
    db.run(`DELETE FROM ingredients WHERE menu_item_id = ?`, [req.params.id]);
    if (ingredients && ingredients.length) {
        for (const ing of ingredients) {
            db.run(`INSERT INTO ingredients (menu_item_id, name, quantity, unit) VALUES (?, ?, ?, ?)`,
                [req.params.id, ing.name, ing.quantity || null, ing.unit || '']);
        }
    }
    saveDB();
    res.json({ success: true });
});

app.delete('/api/menu-items/:id', (req, res) => {
    db.run(`DELETE FROM ingredients WHERE menu_item_id = ?`, [req.params.id]);
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

// ── Serve HTML ──
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

initDB().then(() => {
    app.listen(PORT, () => console.log(`Menu Planner running on port ${PORT}`));
});
