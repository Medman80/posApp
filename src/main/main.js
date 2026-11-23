process.env.ELECTRON_DISABLE_SECURITY_WARNINGS = 'true';
const { app, BrowserWindow, ipcMain, dialog, shell, net } = require('electron');
const path = require('path');
const fs = require('fs');
const { initMobileServer, getQrCodeForProduct, getGeneralQrCode } = require('./mobile-server');

// ─── GLOBAL ERROR HANDLERS ────────────────────────────────────
// Catch uncaught exceptions to prevent silent crashes (blank screen)
process.on('uncaughtException', (error) => {
  console.error('[FATAL] Uncaught Exception:', error);
  try {
    const errLog = path.join(app.getPath('userData'), 'crash.log');
    fs.appendFileSync(errLog, `\n[${new Date().toISOString()}] UNCAUGHT: ${error.stack || error}\n`);
  } catch (e) { /* ignore logging failures */ }
  if (app.isReady()) {
    dialog.showErrorBox('Application Error', `An unexpected error occurred:\n${error.message}\n\nThe app will try to continue.`);
  }
});

process.on('unhandledRejection', (reason) => {
  console.error('[FATAL] Unhandled Rejection:', reason);
  try {
    const errLog = path.join(app.getPath('userData'), 'crash.log');
    fs.appendFileSync(errLog, `\n[${new Date().toISOString()}] REJECTION: ${reason}\n`);
  } catch (e) { /* ignore logging failures */ }
});

// Database and store setup
let db;
let mainWindow;

// Initialize SQLite database
function initDatabase() {
  const Database = require('better-sqlite3');
  const userDataPath = app.getPath('userData');
  const dbPath = path.join(userDataPath, 'business.db');

  db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  // Create tables
  db.exec(`
    CREATE TABLE IF NOT EXISTS products (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      price REAL NOT NULL DEFAULT 0,
      cost REAL NOT NULL DEFAULT 0,
      wholesale_price REAL NOT NULL DEFAULT 0,
      quantity REAL NOT NULL DEFAULT 0,
      low_stock_alert INTEGER NOT NULL DEFAULT 5,
      category TEXT DEFAULT 'General',
      barcode TEXT,
      is_weight_based INTEGER DEFAULT 0,
      unit_type TEXT DEFAULT 'unit',
      deleted INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS customers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      phone TEXT,
      credit REAL DEFAULT 0,
      notes TEXT,
      deleted INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS sales (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      customer_id INTEGER REFERENCES customers(id),
      total REAL NOT NULL DEFAULT 0,
      paid REAL NOT NULL DEFAULT 0,
      payment_type TEXT DEFAULT 'cash',
      notes TEXT,
      canceled INTEGER NOT NULL DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS sale_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      sale_id INTEGER NOT NULL REFERENCES sales(id) ON DELETE CASCADE,
      product_id INTEGER REFERENCES products(id),
      product_name TEXT NOT NULL,
      quantity INTEGER NOT NULL DEFAULT 1,
      price REAL NOT NULL DEFAULT 0,
      cost REAL NOT NULL DEFAULT 0,
      canceled INTEGER NOT NULL DEFAULT 0,
      canceled_at DATETIME
    );

    CREATE TABLE IF NOT EXISTS expenses (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      description TEXT NOT NULL,
      amount REAL NOT NULL DEFAULT 0,
      category TEXT DEFAULT 'General',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT
    );

    CREATE TABLE IF NOT EXISTS checks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      person_name TEXT NOT NULL,
      phone TEXT,
      amount REAL DEFAULT 0,
      paid REAL DEFAULT 0,
      status TEXT DEFAULT 'pending',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS suppliers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      phone TEXT,
      email TEXT,
      address TEXT,
      debt REAL DEFAULT 0,
      notes TEXT,
      deleted INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);

  // Enable WAL mode for better performance and to prevent locking during backups
  db.pragma('journal_mode = WAL');

  // Migrations for existing tables
  try { db.prepare('ALTER TABLE products ADD COLUMN is_weight_based INTEGER DEFAULT 0').run(); } catch (e) { }
  try { db.prepare('ALTER TABLE products ADD COLUMN unit_type TEXT DEFAULT "unit"').run(); } catch (e) { }
  try { db.prepare('ALTER TABLE products ADD COLUMN wholesale_price REAL NOT NULL DEFAULT 0').run(); } catch (e) { }
  try { db.prepare('ALTER TABLE sales ADD COLUMN canceled INTEGER NOT NULL DEFAULT 0').run(); } catch (e) { }
  try { db.prepare('ALTER TABLE sale_items ADD COLUMN canceled INTEGER NOT NULL DEFAULT 0').run(); } catch (e) { }
  try { db.prepare('ALTER TABLE sale_items ADD COLUMN canceled_at DATETIME').run(); } catch (e) { }
  try { db.prepare('ALTER TABLE products MODIFY COLUMN quantity REAL').run(); } catch (e) {
    // sqlite doesn't support MODIFY COLUMN easily, but REAL is compatible with INTEGER
  }

  // Ensure existing records are not NULL
  db.prepare('UPDATE products SET deleted = 0 WHERE deleted IS NULL').run();
  db.prepare('UPDATE customers SET deleted = 0 WHERE deleted IS NULL').run();
  db.prepare('UPDATE sale_items SET canceled = 0 WHERE canceled IS NULL').run();

  // Insert default settings if not exist
  const insertSetting = db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)');
  insertSetting.run('business_name', 'My Business');
  insertSetting.run('currency', 'MAD');
  insertSetting.run('language', 'fr');
  insertSetting.run('low_stock_threshold', '5');
  insertSetting.run('receipt_footer', 'Merci de votre visite!');

  return db;
}

// Auto backup function
function autoBackup() {
  try {
    const userDataPath = app.getPath('userData');
    const dbPath = path.join(userDataPath, 'business.db');
    const backupDir = path.join(userDataPath, 'backups');

    if (!fs.existsSync(backupDir)) {
      fs.mkdirSync(backupDir, { recursive: true });
    }

    const date = new Date().toISOString().split('T')[0];
    const backupPath = path.join(backupDir, `backup_${date}.db`);

    // Only backup once per day
    if (!fs.existsSync(backupPath)) {
      fs.copyFileSync(dbPath, backupPath);

      // Keep only last 7 backups
      const backups = fs.readdirSync(backupDir)
        .filter(f => f.startsWith('backup_'))
        .sort()
        .reverse();

      if (backups.length > 7) {
        backups.slice(7).forEach(f => {
          fs.unlinkSync(path.join(backupDir, f));
        });
      }
    }
  } catch (err) {
    console.error('Backup failed:', err);
  }
}

async function instantBackup() {
  try {
    const userDataPath = app.getPath('userData');
    const dbPath = path.join(userDataPath, 'business.db');
    const backupDir = path.join(userDataPath, 'backups');
    if (!fs.existsSync(backupDir)) fs.mkdirSync(backupDir, { recursive: true });
    const backupPath = path.join(backupDir, `latest_sync.db`);

    // Use asynchronous copy to avoid blocking the main thread
    await fs.promises.copyFile(dbPath, backupPath);
  } catch (err) {
    console.error('Instant backup failed:', err);
  }
}

function createWindow(page = 'activation') {
  mainWindow = new BrowserWindow({
    width: page === 'activation' ? 500 : 1280,
    height: page === 'activation' ? 600 : 800,
    minWidth: page === 'activation' ? 500 : 900,
    minHeight: page === 'activation' ? 500 : 600,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js'),
    },
    titleBarStyle: 'hidden',
    frame: false,
    backgroundColor: '#0f1117',
    show: false,
    icon: process.platform === 'win32'
      ? path.join(__dirname, '../../assets/icon.ico')
      : path.join(__dirname, '../../assets/logo.png'),
  });

  mainWindow.loadFile(path.join(__dirname, `../renderer/${page}.html`));

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
  });

  // Forward console logs to terminal for debugging, ignoring noisy warnings
  mainWindow.webContents.on('console-message', (event, level, message, line, sourceId) => {
    if (level === 1) return; // Skip warnings (0: info, 1: warning, 2: error, 3: debug)
    if (message.includes('Electron Security Warning') || message.includes('non-passive event listener')) {
      return;
    }
    console.log(`[Renderer] ${message} (line ${line})`);
  });
}

// IPC Handlers - License (Mocked for free version)
// IPC Handlers - Products
ipcMain.handle('get-products', async (event, search) => {
  let query = 'SELECT * FROM products WHERE deleted = 0';
  const params = [];
  if (search) {
    query += ' AND (name LIKE ? OR barcode = ?)';
    params.push(`%${search}%`, search);
  }
  query += ' ORDER BY name ASC';
  const products = db.prepare(query).all(...params);
  const baseDir = path.join(app.getPath('userData'), 'product_images');
  return products.map(p => {
    const pDir = path.join(baseDir, String(p.id));
    let firstImage = null;
    if (fs.existsSync(pDir)) {
      try {
        const files = fs.readdirSync(pDir).filter(f => /\.(jpg|jpeg|png|gif|webp)$/i.test(f));
        if (files.length > 0) {
          firstImage = `file://${path.join(pDir, files[0]).replace(/\\/g, '/')}`;
        }
      } catch (e) {}
    }
    return { ...p, image_url: firstImage };
  });
});

ipcMain.handle('add-product', async (event, product) => {
  const stmt = db.prepare(`
    INSERT INTO products (name, price, cost, wholesale_price, quantity, low_stock_alert, category, barcode, is_weight_based, unit_type)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const result = stmt.run(
    product.name, product.price, product.cost || 0, product.wholesale_price || 0,
    product.quantity, product.low_stock_alert || 5,
    product.category || 'General', product.barcode || null,
    product.is_weight_based ? 1 : 0, product.unit_type || 'unit'
  );
  instantBackup();
  return { id: result.lastInsertRowid };
});

ipcMain.handle('update-product', async (event, product) => {
  const stmt = db.prepare(`
    UPDATE products SET name=?, price=?, cost=?, wholesale_price=?, quantity=?, 
    low_stock_alert=?, category=?, barcode=?, is_weight_based=?, unit_type=?, updated_at=CURRENT_TIMESTAMP
    WHERE id=?
  `);
  stmt.run(product.name, product.price, product.cost || 0, product.wholesale_price || 0, product.quantity,
    product.low_stock_alert || 5, product.category || 'General',
    product.barcode || null, product.is_weight_based ? 1 : 0,
    product.unit_type || 'unit', product.id);
  instantBackup();
  return { success: true };
});

ipcMain.handle('delete-product', async (event, id) => {
  try {
    db.prepare('UPDATE products SET deleted = 1 WHERE id = ?').run(id);
    instantBackup();
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle('get-low-stock', async () => {
  return db.prepare('SELECT * FROM products WHERE quantity <= low_stock_alert AND quantity >= 0 AND deleted = 0 ORDER BY quantity ASC').all();
});

ipcMain.handle('get-product-qr', async (event, productId, lang) => {
  return await getQrCodeForProduct(productId, lang);
});

ipcMain.handle('get-general-qr', async (event, lang) => {
  return await getGeneralQrCode(lang);
});

ipcMain.handle('get-product-images', async (event, productId) => {
  const imagesDir = path.join(app.getPath('userData'), 'product_images', String(productId));
  if (!fs.existsSync(imagesDir)) return [];
  try {
    const files = fs.readdirSync(imagesDir);
    return files.filter(file => /\.(jpg|jpeg|png|gif|webp)$/i.test(file)).map(file => {
      // return a local file protocol url for frontend
      return `file://${path.join(imagesDir, file).replace(/\\/g, '/')}`;
    });
  } catch (e) {
    console.error('Failed to get images', e);
    return [];
  }
});

// IPC Handlers - Sales
ipcMain.handle('create-sale', async (event, saleData) => {
  const insertSale = db.transaction((sale) => {
    const saleResult = db.prepare(`
      INSERT INTO sales (customer_id, total, paid, payment_type, notes)
      VALUES (?, ?, ?, ?, ?)
    `).run(sale.customer_id || null, sale.total, sale.paid, sale.payment_type || 'cash', sale.notes || null);

    const saleId = saleResult.lastInsertRowid;

    for (const item of sale.items) {
      db.prepare(`
        INSERT INTO sale_items (sale_id, product_id, product_name, quantity, price, cost)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(saleId, item.product_id || null, item.product_name, item.quantity, item.price, item.cost || 0);

      // Update stock
      if (item.product_id) {
        db.prepare('UPDATE products SET quantity = quantity - ? WHERE id = ?')
          .run(item.quantity, item.product_id);
      }
    }

    // Update customer credit if credit sale
    if (sale.customer_id && sale.payment_type === 'credit') {
      const creditAmount = sale.total - sale.paid;
      db.prepare('UPDATE customers SET credit = credit + ? WHERE id = ?')
        .run(creditAmount, sale.customer_id);
    }

    return saleId;
  });

  const saleId = insertSale(saleData);
  instantBackup();
  return { id: saleId };
});

ipcMain.handle('get-sales', async (event, filters) => {
  let query = `
    SELECT s.*, c.name as customer_name, c.phone as customer_phone,
    (SELECT COUNT(*) FROM sale_items WHERE sale_id = s.id AND canceled = 0) as item_count
    FROM sales s LEFT JOIN customers c ON s.customer_id = c.id
  `;
  const params = [];
  const conditions = [];

  if (filters?.date) {
    conditions.push("DATE(s.created_at) = ?");
    params.push(filters.date);
  }
  if (filters?.dateFrom) {
    conditions.push("DATE(s.created_at) >= ?");
    params.push(filters.dateFrom);
  }
  if (filters?.dateTo) {
    conditions.push("DATE(s.created_at) <= ?");
    params.push(filters.dateTo);
  }

  if (conditions.length) query += ' WHERE ' + conditions.join(' AND ');
  query += ' ORDER BY s.created_at DESC';
  if (filters?.limit) {
    query += ' LIMIT ?';
    params.push(filters.limit);
  }

  return db.prepare(query).all(...params);
});

ipcMain.handle('get-sale-items', async (event, saleId) => {
  return db.prepare('SELECT * FROM sale_items WHERE sale_id = ? ORDER BY canceled ASC, id ASC').all(saleId);
});

ipcMain.handle('cancel-sale', async (event, saleId) => {
  const sale = db.prepare('SELECT * FROM sales WHERE id = ?').get(saleId);
  if (!sale) return { success: false, error: 'Sale not found' };
  if (sale.canceled) return { success: false, error: 'Sale already canceled' };

  const saleItems = db.prepare('SELECT * FROM sale_items WHERE sale_id = ? AND canceled = 0').all(saleId);
  const cancelTx = db.transaction(() => {
    for (const item of saleItems) {
      if (item.product_id) {
        db.prepare('UPDATE products SET quantity = quantity + ? WHERE id = ?')
          .run(item.quantity, item.product_id);
      }
    }

    db.prepare('UPDATE sale_items SET canceled = 1, canceled_at = CURRENT_TIMESTAMP WHERE sale_id = ? AND canceled = 0').run(saleId);

    if (sale.customer_id && sale.payment_type === 'credit') {
      const creditAmount = Math.max(0, sale.total - sale.paid);
      db.prepare('UPDATE customers SET credit = MAX(0, credit - ?) WHERE id = ?')
        .run(creditAmount, sale.customer_id);
    }

    db.prepare('UPDATE sales SET canceled = 1 WHERE id = ?').run(saleId);
  });

  cancelTx();
  instantBackup();
  return { success: true };
});

ipcMain.handle('cancel-sale-item', async (event, itemId) => {
  const item = db.prepare(`
    SELECT
      si.*,
      s.customer_id,
      s.payment_type,
      s.total as sale_total,
      s.paid as sale_paid,
      s.canceled as sale_canceled
    FROM sale_items si
    JOIN sales s ON s.id = si.sale_id
    WHERE si.id = ?
  `).get(itemId);

  if (!item) return { success: false, error: 'Sale item not found' };
  if (item.sale_canceled) return { success: false, error: 'Sale is already canceled' };
  if (item.canceled) return { success: false, error: 'Item is already canceled' };

  const cancelItemTx = db.transaction(() => {
    const lineTotal = Math.max(0, Number(item.quantity || 0) * Number(item.price || 0));
    const oldTotal = Math.max(0, Number(item.sale_total || 0));
    const oldPaid = Math.max(0, Number(item.sale_paid || 0));
    const newTotal = Math.max(0, oldTotal - lineTotal);
    const newPaid = Math.min(oldPaid, newTotal);
    const oldDebt = Math.max(0, oldTotal - oldPaid);
    const newDebt = Math.max(0, newTotal - newPaid);
    const creditReduction = Math.max(0, oldDebt - newDebt);

    if (item.product_id) {
      db.prepare('UPDATE products SET quantity = quantity + ? WHERE id = ?')
        .run(item.quantity, item.product_id);
    }

    db.prepare('UPDATE sale_items SET canceled = 1, canceled_at = CURRENT_TIMESTAMP WHERE id = ?')
      .run(item.id);

    const activeCount = db.prepare('SELECT COUNT(*) as count FROM sale_items WHERE sale_id = ? AND canceled = 0')
      .get(item.sale_id).count;

    db.prepare('UPDATE sales SET total = ?, paid = ?, canceled = ? WHERE id = ?')
      .run(newTotal, newPaid, activeCount === 0 ? 1 : 0, item.sale_id);

    if (item.customer_id && item.payment_type === 'credit' && creditReduction > 0) {
      db.prepare('UPDATE customers SET credit = MAX(0, credit - ?) WHERE id = ?')
        .run(creditReduction, item.customer_id);
    }

    return { newTotal, newPaid, saleCanceled: activeCount === 0 };
  });

  const result = cancelItemTx();
  instantBackup();
  return { success: true, ...result };
});

// IPC Handlers - Customers
ipcMain.handle('get-customers', async (event, search) => {
  let query = 'SELECT * FROM customers WHERE deleted = 0';
  const params = [];
  if (search) {
    query += ' AND (name LIKE ? OR phone LIKE ?)';
    params.push(`%${search}%`, `%${search}%`);
  }
  query += ' ORDER BY name ASC';
  return db.prepare(query).all(...params);
});

ipcMain.handle('add-customer', async (event, customer) => {
  const result = db.prepare(`
    INSERT INTO customers (name, phone, credit, notes)
    VALUES (?, ?, ?, ?)
  `).run(customer.name, customer.phone || null, customer.credit || 0, customer.notes || null);
  instantBackup();
  return { id: result.lastInsertRowid };
});

ipcMain.handle('update-customer', async (event, customer) => {
  // ⚠️  Do NOT override credit here — credit is managed via sales and pay-customer-credit
  db.prepare(`
    UPDATE customers SET name=?, phone=?, notes=? WHERE id=?
  `).run(customer.name, customer.phone || null, customer.notes || null, customer.id);
  instantBackup();
  return { success: true };
});

ipcMain.handle('delete-customer', async (event, id) => {
  try {
    db.prepare('UPDATE customers SET deleted = 1 WHERE id = ?').run(id);
    instantBackup();
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle('pay-customer-credit', async (event, { customerId, amount }) => {
  db.prepare('UPDATE customers SET credit = MAX(0, credit - ?) WHERE id = ?').run(amount, customerId);
  instantBackup();
  return { success: true };
});

// IPC Handlers - Suppliers
ipcMain.handle('get-suppliers', async (event, search) => {
  let query = 'SELECT * FROM suppliers WHERE deleted = 0';
  const params = [];
  if (search) {
    query += ' AND (name LIKE ? OR phone LIKE ?)';
    params.push(`%${search}%`, `%${search}%`);
  }
  query += ' ORDER BY name ASC';
  return db.prepare(query).all(...params);
});

ipcMain.handle('add-supplier', async (event, supplier) => {
  const result = db.prepare(`
    INSERT INTO suppliers (name, phone, email, address, debt, notes)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(supplier.name, supplier.phone || null, supplier.email || null, supplier.address || null, supplier.debt || 0, supplier.notes || null);
  instantBackup();
  return { id: result.lastInsertRowid };
});

ipcMain.handle('update-supplier', async (event, supplier) => {
  db.prepare(`
    UPDATE suppliers SET name=?, phone=?, email=?, address=?, debt=?, notes=? WHERE id=?
  `).run(supplier.name, supplier.phone || null, supplier.email || null, supplier.address || null, supplier.debt || 0, supplier.notes || null, supplier.id);
  instantBackup();
  return { success: true };
});

ipcMain.handle('delete-supplier', async (event, id) => {
  try {
    db.prepare('UPDATE suppliers SET deleted = 1 WHERE id = ?').run(id);
    instantBackup();
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

// IPC Handlers - Expenses
ipcMain.handle('get-expenses', async (event, filters) => {
  let query = 'SELECT * FROM expenses';
  const params = [];
  if (filters?.date) {
    query += ' WHERE DATE(created_at) = ?';
    params.push(filters.date);
  }
  query += ' ORDER BY created_at DESC';
  return db.prepare(query).all(...params);
});

ipcMain.handle('add-expense', async (event, expense) => {
  const result = db.prepare(`
    INSERT INTO expenses (description, amount, category) VALUES (?, ?, ?)
  `).run(expense.description, expense.amount, expense.category || 'General');
  instantBackup();
  return { id: result.lastInsertRowid };
});

ipcMain.handle('delete-expense', async (event, id) => {
  try {
    db.prepare('DELETE FROM expenses WHERE id = ?').run(id);
    instantBackup();
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

// IPC Handlers - Reports
ipcMain.handle('get-dashboard-stats', async () => {
  const today = new Date().toISOString().split('T')[0];

  const todaySales = db.prepare(`
    SELECT COALESCE(SUM(total), 0) as total, COUNT(*) as count FROM sales WHERE DATE(created_at) = ? AND canceled = 0
  `).get(today);

  const todayExpenses = db.prepare(`
    SELECT COALESCE(SUM(amount), 0) as total FROM expenses WHERE DATE(created_at) = ?
  `).get(today);

  const todayProfit = db.prepare(`
    SELECT COALESCE(SUM(si.quantity * (si.price - si.cost)), 0) as profit
    FROM sale_items si JOIN sales s ON si.sale_id = s.id WHERE DATE(s.created_at) = ? AND s.canceled = 0 AND si.canceled = 0
  `).get(today);

  const monthSales = db.prepare(`
    SELECT COALESCE(SUM(total), 0) as total FROM sales 
    WHERE strftime('%Y-%m', created_at) = strftime('%Y-%m', 'now') AND canceled = 0
  `).get();

  const monthExpenses = db.prepare(`
    SELECT COALESCE(SUM(amount), 0) as total FROM expenses 
    WHERE strftime('%Y-%m', created_at) = strftime('%Y-%m', 'now')
  `).get();

  const monthProfit = db.prepare(`
    SELECT COALESCE(SUM(si.quantity * (si.price - si.cost)), 0) as profit
    FROM sale_items si JOIN sales s ON si.sale_id = s.id
    WHERE strftime('%Y-%m', s.created_at) = strftime('%Y-%m', 'now') AND s.canceled = 0 AND si.canceled = 0
  `).get();

  const lowStock = db.prepare(`
    SELECT COUNT(*) as count FROM products WHERE quantity <= low_stock_alert AND deleted = 0
  `).get();

  const totalCredit = db.prepare(`
    SELECT COALESCE(SUM(credit), 0) as total FROM customers WHERE credit > 0 AND deleted = 0
  `).get();

  const stockValue = db.prepare(`
    SELECT COALESCE(SUM(quantity * cost), 0) as cost_total,
           COALESCE(SUM(quantity * price), 0) as price_total
    FROM products WHERE deleted = 0
  `).get();

  const recentSales = db.prepare(`
    SELECT s.*, c.name as customer_name FROM sales s 
    LEFT JOIN customers c ON s.customer_id = c.id
    WHERE s.canceled = 0
    ORDER BY s.created_at DESC LIMIT 5
  `).all();

  return {
    todaySales: todaySales.total,
    todaySalesCount: todaySales.count,
    todayExpenses: todayExpenses.total,
    todayProfit: todayProfit.profit,
    monthSales: monthSales.total,
    monthExpenses: monthExpenses.total,
    monthProfit: monthProfit.profit,
    lowStockCount: lowStock.count,
    totalCredit: totalCredit.total,
    stockValueCost: stockValue.cost_total,
    stockValuePrice: stockValue.price_total,
    recentSales,
  };
});

ipcMain.handle('get-sales-report', async (event, { dateFrom, dateTo }) => {
  // ── Daily summary (grouped by date) ─────────────────────────
  const sales = db.prepare(`
    SELECT DATE(created_at) as date,
    SUM(total) as total_sales,
    COUNT(*) as sale_count,
    SUM(paid) as total_paid
    FROM sales WHERE DATE(created_at) BETWEEN ? AND ? AND canceled = 0
    GROUP BY DATE(created_at) ORDER BY date ASC
  `).all(dateFrom, dateTo);

  // ── Per-transaction detail (every single sale) ───────────────
  const transactions = db.prepare(`
    SELECT
      s.id,
      DATE(s.created_at) as date,
      TIME(s.created_at) as time,
      c.name as customer_name,
      s.total,
      s.paid,
      ROUND(s.total - s.paid, 2) as remaining,
      s.payment_type,
      COALESCE(SUM(si.quantity * (si.price - si.cost)), 0) as profit
    FROM sales s
    LEFT JOIN customers c ON s.customer_id = c.id
    LEFT JOIN sale_items si ON si.sale_id = s.id AND si.canceled = 0
    WHERE DATE(s.created_at) BETWEEN ? AND ? AND s.canceled = 0
    GROUP BY s.id
    ORDER BY s.created_at ASC
  `).all(dateFrom, dateTo);

  // ── Expense detail (every expense) ───────────────────────────
  const expenseDetail = db.prepare(`
    SELECT
      DATE(created_at) as date,
      TIME(created_at) as time,
      description,
      category,
      amount
    FROM expenses
    WHERE DATE(created_at) BETWEEN ? AND ?
    ORDER BY created_at ASC
  `).all(dateFrom, dateTo);

  // ── Gross profit total ────────────────────────────────────────
  const profit = db.prepare(`
    SELECT COALESCE(SUM(si.quantity * (si.price - si.cost)), 0) as profit
    FROM sale_items si JOIN sales s ON si.sale_id = s.id
    WHERE DATE(s.created_at) BETWEEN ? AND ? AND s.canceled = 0 AND si.canceled = 0
  `).get(dateFrom, dateTo);

  // ── Total expenses ────────────────────────────────────────────
  const expenses = db.prepare(`
    SELECT COALESCE(SUM(amount), 0) as total FROM expenses
    WHERE DATE(created_at) BETWEEN ? AND ?
  `).get(dateFrom, dateTo);

  // ── Top products ──────────────────────────────────────────────
  const topProducts = db.prepare(`
    SELECT si.product_name, SUM(si.quantity) as total_qty, SUM(si.quantity * si.price) as total_revenue,
    COALESCE(SUM(si.quantity * (si.price - si.cost)), 0) as total_profit
    FROM sale_items si JOIN sales s ON si.sale_id = s.id
    WHERE DATE(s.created_at) BETWEEN ? AND ? AND s.canceled = 0 AND si.canceled = 0
    GROUP BY si.product_name ORDER BY total_qty DESC LIMIT 10
  `).all(dateFrom, dateTo);

  const saleItemDetail = db.prepare(`
    SELECT
      s.id as sale_id,
      DATE(s.created_at) as date,
      TIME(s.created_at) as time,
      c.name as customer_name,
      si.product_name,
      si.quantity,
      si.price,
      si.cost,
      ROUND(si.quantity * si.price, 2) as line_total,
      ROUND(si.quantity * (si.price - si.cost), 2) as line_profit,
      s.payment_type
    FROM sale_items si
    JOIN sales s ON si.sale_id = s.id
    LEFT JOIN customers c ON s.customer_id = c.id
    WHERE DATE(s.created_at) BETWEEN ? AND ? AND s.canceled = 0 AND si.canceled = 0
    ORDER BY s.created_at ASC, si.id ASC
  `).all(dateFrom, dateTo);

  const paymentSummary = db.prepare(`
    SELECT
      payment_type,
      COUNT(*) as sale_count,
      ROUND(SUM(total), 2) as total_revenue,
      ROUND(SUM(paid), 2) as total_paid,
      ROUND(SUM(total - paid), 2) as total_remaining
    FROM sales
    WHERE DATE(created_at) BETWEEN ? AND ? AND canceled = 0
    GROUP BY payment_type
    ORDER BY total_revenue DESC
  `).all(dateFrom, dateTo);

  const totalRevenue = sales.reduce((s, d) => s + d.total_sales, 0);
  const totalSales = sales.reduce((s, d) => s + d.sale_count, 0);
  const grossProfit = profit.profit;

  return {
    sales,
    transactions,
    expenseDetail,
    saleItemDetail,
    paymentSummary,
    profit: grossProfit,
    expenses: expenses.total,
    topProducts,
    summary: {
      totalRevenue,
      grossProfit,
      totalExpenses: expenses.total,
      netProfit: grossProfit - expenses.total,
      totalSales,
      averageSale: totalSales ? totalRevenue / totalSales : 0,
      profitMargin: totalRevenue ? (grossProfit / totalRevenue) * 100 : 0,
      dateFrom,
      dateTo
    }
  };
});

// IPC Handlers - Settings
ipcMain.handle('get-settings', async () => {
  const rows = db.prepare('SELECT key, value FROM settings').all();
  const settings = {};
  rows.forEach(r => settings[r.key] = r.value);
  return settings;
});

ipcMain.handle('save-settings', async (event, settings) => {
  const stmt = db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)');
  for (const [key, value] of Object.entries(settings)) {
    stmt.run(key, value);
  }
  instantBackup();
  return { success: true };
});

function safeSheetName(name) {
  return String(name || 'Sheet')
    .replace(/[\\/?*[\]:]/g, ' ')
    .trim()
    .substring(0, 31) || 'Sheet';
}

function isNumericValue(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

function getWorksheetStylePlan(data = [], metadata = [], includeTotals = true) {
  const rows = Array.isArray(data) ? data : [];
  const headers = rows.length ? Object.keys(rows[0]) : [];
  let hasTotals = false;

  if (includeTotals && rows.length) {
    hasTotals = headers.some(header => {
      const values = rows.map(row => row[header]);
      return values.length && values.every(value => value === '' || value === null || value === undefined || isNumericValue(value));
    });
  }

  const baseRows = 1 + (metadata.length || 1) + 1 + 1 + rows.length;
  return {
    metadataCount: metadata.length || 1,
    totalRow: hasTotals ? baseRows + 1 : null
  };
}

function buildStyledWorksheet(XLSX, { name, data = [], title, metadata = [], includeTotals = true }) {
  const rows = Array.isArray(data) ? data : [];
  const headers = rows.length ? Object.keys(rows[0]) : [];
  const aoa = [];
  const sheetTitle = title || name || 'Export';

  aoa.push([sheetTitle]);
  if (metadata.length) {
    metadata.forEach(item => aoa.push([item.label, item.value]));
  } else {
    aoa.push(['Generated at', new Date().toLocaleString()]);
  }
  aoa.push([]);
  aoa.push(headers);

  rows.forEach(row => {
    aoa.push(headers.map(header => row[header]));
  });

  const numericTotals = {};
  if (includeTotals && rows.length) {
    headers.forEach(header => {
      const values = rows.map(row => row[header]);
      if (values.length && values.every(value => value === '' || value === null || value === undefined || isNumericValue(value))) {
        numericTotals[header] = values.reduce((sum, value) => sum + (isNumericValue(value) ? value : 0), 0);
      }
    });

    if (Object.keys(numericTotals).length) {
      aoa.push([]);
      aoa.push(headers.map((header, index) => {
        if (index === 0) return 'TOTAL';
        return Object.prototype.hasOwnProperty.call(numericTotals, header) ? numericTotals[header] : '';
      }));
    }
  }

  const ws = XLSX.utils.aoa_to_sheet(aoa);
  const range = XLSX.utils.decode_range(ws['!ref'] || 'A1:A1');
  const headerRow = metadata.length ? metadata.length + 2 : 3;
  const dataStartRow = headerRow + 1;
  const totalRow = Object.keys(numericTotals).length ? range.e.r : -1;
  const titleStyle = {
    font: { bold: true, sz: 18, color: { rgb: 'FFFFFF' } },
    fill: { fgColor: { rgb: '1F4E78' } },
    alignment: { horizontal: 'center', vertical: 'center' }
  };
  const metaStyle = {
    font: { bold: true, color: { rgb: '334155' } },
    fill: { fgColor: { rgb: 'E2E8F0' } },
    alignment: { vertical: 'center' }
  };
  const headerStyle = {
    font: { bold: true, color: { rgb: 'FFFFFF' } },
    fill: { fgColor: { rgb: '2563EB' } },
    alignment: { horizontal: 'center', vertical: 'center', wrapText: true },
    border: {
      top: { style: 'thin', color: { rgb: 'CBD5E1' } },
      bottom: { style: 'thin', color: { rgb: 'CBD5E1' } },
      left: { style: 'thin', color: { rgb: 'CBD5E1' } },
      right: { style: 'thin', color: { rgb: 'CBD5E1' } }
    }
  };
  const totalStyle = {
    font: { bold: true, color: { rgb: '111827' } },
    fill: { fgColor: { rgb: 'FEF3C7' } },
    border: { top: { style: 'medium', color: { rgb: 'F59E0B' } } }
  };
  const moneyFormat = '#,##0.00';

  ws['!merges'] = [{ s: { r: 0, c: 0 }, e: { r: 0, c: Math.max(headers.length - 1, 1) } }];
  ws['!rows'] = [{ hpt: 28 }];
  ws['!freeze'] = { xSplit: 0, ySplit: headerRow + 1 };
  ws['!autofilter'] = {
    ref: XLSX.utils.encode_range({
      s: { r: headerRow, c: 0 },
      e: { r: Math.max(headerRow, range.e.r), c: Math.max(headers.length - 1, 0) }
    })
  };

  const widths = headers.map((header, colIndex) => {
    const maxLength = Math.max(
      String(header || '').length,
      ...rows.map(row => String(row[header] ?? '').length),
      10
    );
    return { wch: Math.min(Math.max(maxLength + 3, 12), 36) };
  });
  ws['!cols'] = widths.length ? widths : [{ wch: 24 }, { wch: 24 }];

  for (let row = range.s.r; row <= range.e.r; row += 1) {
    for (let col = range.s.c; col <= range.e.c; col += 1) {
      const addr = XLSX.utils.encode_cell({ r: row, c: col });
      const cell = ws[addr];
      if (!cell) continue;

      if (row === 0) {
        cell.s = titleStyle;
      } else if (row > 0 && row < headerRow - 1) {
        cell.s = metaStyle;
      } else if (row === headerRow) {
        cell.s = headerStyle;
      } else if (row === totalRow) {
        cell.s = totalStyle;
      } else {
        const header = headers[col];
        const value = rows[row - dataStartRow]?.[header];
        cell.s = {
          alignment: { vertical: 'top', wrapText: true },
          fill: { fgColor: { rgb: row % 2 === 0 ? 'F8FAFC' : 'FFFFFF' } },
          border: {
            bottom: { style: 'thin', color: { rgb: 'E5E7EB' } }
          }
        };
        if (isNumericValue(value)) {
          cell.z = moneyFormat;
          cell.s.alignment = { horizontal: 'right', vertical: 'top' };
          if (value < 0) {
            cell.s.font = { color: { rgb: 'DC2626' }, bold: true };
          }
        }
      }
    }
  }

  return ws;
}

function getExcelStyleXml() {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes">
  <fonts count="4">
    <font><sz val="11"/><color rgb="FF111827"/><name val="Calibri"/><family val="2"/></font>
    <font><b/><sz val="18"/><color rgb="FFFFFFFF"/><name val="Calibri"/><family val="2"/></font>
    <font><b/><sz val="11"/><color rgb="FFFFFFFF"/><name val="Calibri"/><family val="2"/></font>
    <font><b/><sz val="11"/><color rgb="FF111827"/><name val="Calibri"/><family val="2"/></font>
  </fonts>
  <fills count="7">
    <fill><patternFill patternType="none"/></fill>
    <fill><patternFill patternType="gray125"/></fill>
    <fill><patternFill patternType="solid"><fgColor rgb="FF1F4E78"/><bgColor indexed="64"/></patternFill></fill>
    <fill><patternFill patternType="solid"><fgColor rgb="FFE2E8F0"/><bgColor indexed="64"/></patternFill></fill>
    <fill><patternFill patternType="solid"><fgColor rgb="FF2563EB"/><bgColor indexed="64"/></patternFill></fill>
    <fill><patternFill patternType="solid"><fgColor rgb="FFF8FAFC"/><bgColor indexed="64"/></patternFill></fill>
    <fill><patternFill patternType="solid"><fgColor rgb="FFFEF3C7"/><bgColor indexed="64"/></patternFill></fill>
  </fills>
  <borders count="2">
    <border><left/><right/><top/><bottom/><diagonal/></border>
    <border><left style="thin"><color rgb="FFE5E7EB"/></left><right style="thin"><color rgb="FFE5E7EB"/></right><top style="thin"><color rgb="FFE5E7EB"/></top><bottom style="thin"><color rgb="FFE5E7EB"/></bottom><diagonal/></border>
  </borders>
  <cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
  <cellXfs count="7">
    <xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>
    <xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf>
    <xf numFmtId="0" fontId="3" fillId="3" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment vertical="center"/></xf>
    <xf numFmtId="0" fontId="2" fillId="4" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center" wrapText="1"/></xf>
    <xf numFmtId="0" fontId="0" fillId="5" borderId="1" xfId="0" applyFill="1" applyBorder="1" applyAlignment="1"><alignment vertical="top" wrapText="1"/></xf>
    <xf numFmtId="0" fontId="0" fillId="0" borderId="1" xfId="0" applyBorder="1" applyAlignment="1"><alignment vertical="top" wrapText="1"/></xf>
    <xf numFmtId="0" fontId="3" fillId="6" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1"/>
  </cellXfs>
  <cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>
  <dxfs count="0"/>
  <tableStyles count="0" defaultTableStyle="TableStyleMedium9" defaultPivotStyle="PivotStyleMedium4"/>
</styleSheet>`;
}

function setCellStyle(cellXml, styleId) {
  return cellXml.replace(/<c\b([^>]*)>/g, (match, attrs) => {
    const cleanAttrs = attrs.replace(/\s+s="[^"]*"/, '');
    return `<c${cleanAttrs} s="${styleId}">`;
  });
}

function styleWorksheetXml(xml, plan) {
  const metaCount = plan.metadataCount || 0;
  const headerRow = metaCount ? metaCount + 3 : 4;
  const totalRow = plan.totalRow ? plan.totalRow + 1 : -1;

  return xml.replace(/<row\b([^>]*)\br="(\d+)"([^>]*)>([\s\S]*?)<\/row>/g, (match, before, rowNoText, after, content) => {
    const rowNo = Number(rowNoText);
    let styleId = 0;
    let rowAttrs = `${before} r="${rowNoText}"${after}`;

    if (rowNo === 1) {
      styleId = 1;
      rowAttrs = rowAttrs.replace(/\s+ht="[^"]*"/, '').replace(/\s+customHeight="[^"]*"/, '');
      rowAttrs += ' ht="28" customHeight="1"';
    } else if (rowNo >= 2 && rowNo <= metaCount + 1) {
      styleId = 2;
    } else if (rowNo === headerRow) {
      styleId = 3;
    } else if (rowNo === totalRow) {
      styleId = 6;
    } else if (rowNo > headerRow) {
      styleId = rowNo % 2 === 0 ? 4 : 5;
    }

    if (!styleId) return match;
    return `<row${rowAttrs}>${setCellStyle(content, styleId)}</row>`;
  });
}

async function zipDirectory(sourceDir, outputPath) {
  const archiver = require('archiver');
  await new Promise((resolve, reject) => {
    const output = fs.createWriteStream(outputPath);
    const archive = archiver('zip', { zlib: { level: 9 } });

    output.on('close', resolve);
    archive.on('error', reject);
    archive.pipe(output);
    archive.directory(sourceDir, false);
    archive.finalize();
  });
}

async function enhanceXlsxStyles(filePath, plans) {
  if (!filePath || !filePath.toLowerCase().endsWith('.xlsx')) return;
  if (!plans.length) return;

  const extract = require('extract-zip');
  const os = require('os');
  const tempDir = path.join(os.tmpdir(), `pos-xlsx-${Date.now()}-${Math.round(Math.random() * 100000)}`);
  const styledPath = path.join(os.tmpdir(), `pos-xlsx-styled-${Date.now()}.xlsx`);

  try {
    fs.mkdirSync(tempDir, { recursive: true });
    await extract(filePath, { dir: tempDir });

    const stylesPath = path.join(tempDir, 'xl', 'styles.xml');
    if (fs.existsSync(stylesPath)) {
      fs.writeFileSync(stylesPath, getExcelStyleXml(), 'utf8');
    }

    plans.forEach((plan, index) => {
      const sheetPath = path.join(tempDir, 'xl', 'worksheets', `sheet${index + 1}.xml`);
      if (!fs.existsSync(sheetPath)) return;
      const xml = fs.readFileSync(sheetPath, 'utf8');
      fs.writeFileSync(sheetPath, styleWorksheetXml(xml, plan), 'utf8');
    });

    await zipDirectory(tempDir, styledPath);
    fs.copyFileSync(styledPath, filePath);
  } catch (err) {
    console.error('Excel styling post-process failed:', err);
  } finally {
    try { if (fs.existsSync(tempDir)) fs.rmSync(tempDir, { recursive: true, force: true }); } catch (e) { }
    try { if (fs.existsSync(styledPath)) fs.unlinkSync(styledPath); } catch (e) { }
  }
}

// IPC Handlers - Export
ipcMain.handle('export-data', async (event, { type, data, sheets, metadata }) => {
  const XLSX = require('xlsx');
  const { filePath } = await dialog.showSaveDialog(mainWindow, {
    defaultPath: `${type}_${new Date().toISOString().split('T')[0]}.xlsx`,
    filters: [{ name: 'Excel', extensions: ['xlsx'] }, { name: 'CSV', extensions: ['csv'] }],
  });

  if (!filePath) return { success: false };

  const wb = XLSX.utils.book_new();
  wb.Props = {
    Title: type,
    Subject: 'Business Manager POS export',
    Author: 'Business Manager POS',
    CreatedDate: new Date()
  };
  const stylePlans = [];

  if (sheets && Array.isArray(sheets)) {
    // Multi-sheet export
    for (const sheet of sheets) {
      const sheetMetadata = sheet.metadata || metadata || [];
      const includeTotals = sheet.includeTotals !== false;
      const ws = buildStyledWorksheet(XLSX, {
        name: sheet.name,
        data: sheet.data,
        title: sheet.title || sheet.name,
        metadata: sheetMetadata,
        includeTotals
      });
      stylePlans.push(getWorksheetStylePlan(sheet.data, sheetMetadata, includeTotals));
      XLSX.utils.book_append_sheet(wb, ws, safeSheetName(sheet.name));
    }
  } else {
    // Single-sheet export (backward compat)
    const singleMetadata = metadata || [];
    const ws = buildStyledWorksheet(XLSX, {
      name: type,
      data: data || [],
      title: type,
      metadata: singleMetadata
    });
    stylePlans.push(getWorksheetStylePlan(data || [], singleMetadata, true));
    XLSX.utils.book_append_sheet(wb, ws, safeSheetName(type));
  }

  XLSX.writeFile(wb, filePath, { cellStyles: true, bookSST: true });
  await enhanceXlsxStyles(filePath, stylePlans);
  shell.showItemInFolder(filePath);
  return { success: true, filePath };
});

ipcMain.handle('export-pdf', async (event, { name, html }) => {
  const fs = require('fs');
  let defaultName = name;
  if (!name.includes('_FAC-') && !name.includes('_DEV-') && !name.toLowerCase().endsWith('.pdf')) {
    defaultName = `${name}_${new Date().toISOString().split('T')[0]}.pdf`;
  } else if (!defaultName.toLowerCase().endsWith('.pdf')) {
    defaultName += '.pdf';
  }

  const { filePath } = await dialog.showSaveDialog(mainWindow, {
    defaultPath: defaultName,
    filters: [{ name: 'PDF', extensions: ['pdf'] }],
  });

  if (!filePath) return { success: false };

  try {
    // If HTML content is provided, render it in an offscreen window for a clean PDF
    if (html) {
      const { BrowserWindow: BW } = require('electron');
      const pdfWin = new BW({
        show: false,
        width: 794,  // A4 width in px at 96dpi
        height: 1123, // A4 height in px at 96dpi
        webPreferences: { nodeIntegration: false, contextIsolation: true }
      });

      // Full standalone HTML page for the PDF
      const fullHtml = `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { background: white; font-family: 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; }
  </style>
</head>
<body>${html}</body>
</html>`;

      await pdfWin.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(fullHtml)}`);
      // Wait for images/fonts to load
      await new Promise(r => setTimeout(r, 800));

      const pdfData = await pdfWin.webContents.printToPDF({
        printBackground: true,
        pageSize: 'A4',
        margins: { top: 0, bottom: 0, left: 0, right: 0, marginType: 'custom' }
      });
      pdfWin.destroy();
      fs.writeFileSync(filePath, pdfData);
      shell.showItemInFolder(filePath);
      return { success: true, filePath };
    }

    // Fallback: print the current window (legacy behavior)
    const pdfData = await mainWindow.webContents.printToPDF({
      printBackground: true,
      pageSize: 'A4',
      margins: { marginType: 'printableArea' }
    });
    fs.writeFileSync(filePath, pdfData);
    shell.showItemInFolder(filePath);
    return { success: true, filePath };
  } catch (error) {
    console.error('PDF generation failed:', error);
    return { success: false, error: error.message };
  }
});

ipcMain.handle('window-minimize', () => mainWindow.minimize());
ipcMain.handle('window-maximize', () => {
  if (mainWindow.isMaximized()) mainWindow.unmaximize();
  else mainWindow.maximize();
});
ipcMain.handle('window-close', () => mainWindow.close());

ipcMain.handle('get-printers', async () => {
  return await mainWindow.webContents.getPrintersAsync();
});

ipcMain.handle('print-silent', async (event, options = {}) => {
  return new Promise((resolve, reject) => {
    mainWindow.webContents.print({
      silent: true,
      deviceName: options.deviceName || '',
      printBackground: true,
      ...options
    }, (success, failureReason) => {
      if (success) resolve({ success: true });
      else resolve({ success: false, error: failureReason });
    });
  });
});

ipcMain.handle('print-html', async (event, { html, deviceName, pageSize = 'A4', pageMargin = '0', center = false }) => {
  return new Promise(async (resolve) => {
    try {
      const { BrowserWindow: BW } = require('electron');
      const printWin = new BW({
        show: false,
        width: 794,
        height: 1123,
        webPreferences: { nodeIntegration: false, contextIsolation: true }
      });

      const fullHtml = `<!DOCTYPE html>
<html><head>
  <meta charset="UTF-8">
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    html, body { width: 100%; height: 100%; background: white; font-family: 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; }
    @page { size: ${pageSize}; margin: ${pageMargin}; }
    body { ${center ? 'display: flex; align-items: center; justify-content: center;' : 'display: block;'} padding: 0; }
  </style>
</head><body>${html}</body></html>`;

      await printWin.loadURL(
        `data:text/html;charset=utf-8,${encodeURIComponent(fullHtml)}`
      );
      // Allow fonts/images to load
      await new Promise(r => setTimeout(r, 700));

      printWin.webContents.print({
        silent: true,
        deviceName: deviceName || '',
        printBackground: true,
      }, (success, failureReason) => {
        printWin.destroy();
        if (success) resolve({ success: true });
        else resolve({ success: false, error: failureReason });
      });
    } catch (err) {
      console.error('print-html failed:', err);
      resolve({ success: false, error: err.message });
    }
  });
});

ipcMain.handle('navigate-to-main', async () => {
  const bounds = mainWindow.getBounds();
  if (bounds.width < 900) {
    mainWindow.setSize(1280, 800);
    mainWindow.center();
  }
  mainWindow.loadFile(path.join(__dirname, '../renderer/app.html'));
});


// IPC Handlers - Checks
ipcMain.handle('get-checks', async (event, query = '') => {
  if (query) {
    return db.prepare('SELECT * FROM checks WHERE person_name LIKE ? OR phone LIKE ? ORDER BY created_at DESC')
      .all(`%${query}%`, `%${query}%`);
  }
  return db.prepare('SELECT * FROM checks ORDER BY created_at DESC').all();
});

ipcMain.handle('add-check', async (event, check) => {
  const result = db.prepare(`
    INSERT INTO checks (person_name, phone, amount, paid, status) VALUES (?, ?, ?, ?, ?)
  `).run(check.person_name, check.phone, check.amount, check.paid, check.status || 'pending');
  instantBackup();
  return { id: result.lastInsertRowid };
});

ipcMain.handle('update-check', async (event, check) => {
  const result = db.prepare(`
    UPDATE checks SET person_name = ?, phone = ?, amount = ?, paid = ?, status = ? WHERE id = ?
  `).run(check.person_name, check.phone, check.amount, check.paid, check.status, check.id);
  instantBackup();
  return { success: result.changes > 0 };
});

ipcMain.handle('delete-check', async (event, id) => {
  try {
    db.prepare('DELETE FROM checks WHERE id = ?').run(id);
    instantBackup();
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

// Disable hardware acceleration to avoid GPU driver warnings on some Linux systems
if (process.platform === 'linux') {
  app.disableHardwareAcceleration();
}
if (process.platform === 'linux') {
  app.commandLine.appendSwitch('disable-gpu');
  app.commandLine.appendSwitch('disable-software-rasterizer');
  app.commandLine.appendSwitch('disable-gpu-compositing');
  app.commandLine.appendSwitch('disable-gpu-rasterization');
  app.commandLine.appendSwitch('disable-gpu-sandbox');
  app.commandLine.appendSwitch('ignore-gpu-blocklist');
}
app.commandLine.appendSwitch('log-level', '3');

app.whenReady().then(async () => {
  try {
    initDatabase();
    autoBackup();

    // Initialize mobile server
    try {
      initMobileServer(db);
    } catch (mobileErr) {
      console.error('[Mobile Server] Failed to start:', mobileErr);
      // Non-fatal: continue without mobile server
    }

    createWindow('app');

    // Auto backup every 24 hours
    setInterval(autoBackup, 24 * 60 * 60 * 1000);
  } catch (err) {
    console.error('[FATAL] App initialization failed:', err);
    dialog.showErrorBox(
      'Startup Error',
      `The application failed to start:\n${err.message}\n\n${err.stack}`
    );
    app.quit();
  }
}).catch(err => {
  console.error('[FATAL] app.whenReady() failed:', err);
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
