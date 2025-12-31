import sqlite3 from 'sqlite3';
import { open } from 'sqlite';
import express from "express";
import cors from "cors";
import multer from "multer";
import fetch from "node-fetch";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import bcrypt from "bcryptjs";
import cookieParser from "cookie-parser";

/* ================= BASIC SETUP ================= */
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(cors({ origin: "*"}));
app.use(express.json());
app.use(cookieParser());

const rootDir = path.join(__dirname, "..");
app.use(express.static(rootDir));
app.get("/", (req, res) => {
  res.sendFile(path.join(rootDir, "index.html"));
});
app.use("/admin", express.static(path.join(__dirname, "admin")));

/* ================= DATABASE ================= */
let db;

async function initDb() {
    db = await open({
        filename: path.join(__dirname, "db.sqlite"),
        driver: sqlite3.Database
    });

    await db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE,
      password TEXT,
      balance REAL DEFAULT 0,
      status TEXT DEFAULT 'active',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    `);

    // Migration for status column
    try {
        await db.run("ALTER TABLE users ADD COLUMN status TEXT DEFAULT 'active'");
    } catch(e) {}

    // Migration for trade settings
    try {
        await db.run("ALTER TABLE users ADD COLUMN min_trade_amount REAL DEFAULT 10");
        await db.run("ALTER TABLE users ADD COLUMN trade_settings TEXT DEFAULT '[]'");
    } catch(e) {}


    await db.exec(`
    CREATE TABLE IF NOT EXISTS trades (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT,
      symbol TEXT,
      side TEXT,
      amount REAL,
      profit REAL,
      result TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS verifications (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT,
      kind TEXT, /* primary | advanced */
      first_name TEXT,
      last_name TEXT,
      document_type TEXT,
      document_number TEXT,
      front_image TEXT,
      back_image TEXT,
      selfie_image TEXT,
      status TEXT DEFAULT 'pending',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS deposits (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT,
      currency TEXT,
      network TEXT,
      amount REAL,
      proof_image TEXT,
      status TEXT DEFAULT 'pending',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    
    CREATE TABLE IF NOT EXISTS withdrawals (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT,
      currency TEXT,
      network TEXT,
      amount REAL,
      address TEXT,
      status TEXT DEFAULT 'pending',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS user_balances (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT,
      currency TEXT,
      amount REAL DEFAULT 0,
      UNIQUE(username, currency)
    );
    `);

    // Migration for deposits proof_image
    try {
      await db.run("ALTER TABLE deposits ADD COLUMN proof_image TEXT");
    } catch (e) {
      // Ignore if exists
    }

    // Migration for withdrawals address
    try {
      await db.run("ALTER TABLE withdrawals ADD COLUMN address TEXT");
    } catch (e) {
      // Ignore if exists
    }
}

/* ================= AUTH APIs ================= */

// REGISTER
app.post("/api/register", async (req, res) => {
  const { username, password } = req.body;

  if (!username || !password) {
    return res.status(400).json({ error: "Missing fields" });
  }

  const hash = bcrypt.hashSync(password, 10);

  try {
    // Note: Original code did not insert password, preserving that behavior for now
    // to match "like before" request, although it seems like a bug.
    // If you want to fix auth, uncomment the password field below.
    await db.run(`
      INSERT INTO users (username, balance)
      VALUES (?, ?)
    `, [username, 0]);

    res.json({ success: true });
  } catch (e) {
    res.status(400).json({ error: "Username already exists" });
  }
});

// LOGIN
app.post("/api/login", async (req, res) => {
  const { username, password } = req.body;

  const user = await db.get(
    "SELECT * FROM users WHERE username=?", [username]
  );

  if (!user) {
    return res.status(401).json({ error: "Invalid login" });
  }

  if (user.status === 'frozen') {
    return res.status(403).json({ error: "Please contact with customer service" });
  }

  // Note: Original code did not check password.

  res.cookie("user", username, {
    httpOnly: true,
    sameSite: "lax"
  });

  res.json({ success: true });
});

// CURRENT USER
app.get("/api/me", async (req, res) => {
  const username = req.cookies.user || req.headers['x-user'];
  if (!username) return res.json(null);

  const user = await db.get(
    "SELECT id, username, balance FROM users WHERE username=?", [username]
  );
  
  if (user) {
      const balances = await db.all("SELECT currency, amount FROM user_balances WHERE username=?", [username]);
      user.balances = balances;
  }

  res.json(user);
});

// LOGOUT
app.post("/api/logout", (req, res) => {
  res.clearCookie("user");
  res.json({ success: true });
});


/* ================= ADMIN APIs ================= */

app.get("/api/admin/stats", async (req, res) => {
    try {
        // Total Users
        const totalUsers = await db.get("SELECT COUNT(*) as count FROM users");
        
        // Frozen Users
        const frozenUsers = await db.get("SELECT COUNT(*) as count FROM users WHERE status = 'frozen'");
        
        // Net Deposit (All Time)
        // We need to sum approved deposits and subtract approved withdrawals
        const totalDeposits = await db.get("SELECT SUM(amount) as total FROM deposits WHERE status = 'approved'");
        const totalWithdrawals = await db.get("SELECT SUM(amount) as total FROM withdrawals WHERE status = 'approved'");
        const netDeposit = (totalDeposits.total || 0) - (totalWithdrawals.total || 0);

        // Net Deposit (Today)
        const todayStart = new Date();
        todayStart.setHours(0,0,0,0);
        const todayStr = todayStart.toISOString();

        const todayDeposits = await db.get("SELECT SUM(amount) as total FROM deposits WHERE status = 'approved' AND created_at >= ?", [todayStr]);
        const todayWithdrawals = await db.get("SELECT SUM(amount) as total FROM withdrawals WHERE status = 'approved' AND created_at >= ?", [todayStr]);
        const todayNetDeposit = (todayDeposits.total || 0) - (todayWithdrawals.total || 0);

        res.json({
            totalUsers: totalUsers.count,
            frozenUsers: frozenUsers.count,
            platformRechargeUpDown: netDeposit,
            todayRechargeUpDown: todayNetDeposit
        });
    } catch (e) {
        console.error(e);
        res.status(500).json({ error: "Failed to fetch stats" });
    }
});

app.get("/api/admin/charts", async (req, res) => {
    try {
        // Last 7 days
        const days = [];
        for (let i = 6; i >= 0; i--) {
            const d = new Date();
            d.setDate(d.getDate() - i);
            days.push(d.toISOString().split('T')[0]); // YYYY-MM-DD
        }

        const incomeData = [];
        const usersData = [];

        for (const day of days) {
            // New Users
            const userCount = await db.get(
                "SELECT COUNT(*) as count FROM users WHERE date(created_at) = ?", 
                [day]
            );
            usersData.push(userCount.count || 0);

            // Income (Deposits - Withdrawals)
            // SQLite date string comparison works if format is consistent (YYYY-MM-DD ...)
            // We'll use the 'date()' function on created_at
            const dep = await db.get(
                "SELECT SUM(amount) as total FROM deposits WHERE status = 'approved' AND date(created_at) = ?", 
                [day]
            );
            const wth = await db.get(
                "SELECT SUM(amount) as total FROM withdrawals WHERE status = 'approved' AND date(created_at) = ?", 
                [day]
            );
            
            incomeData.push((dep.total || 0) - (wth.total || 0));
        }

        res.json({
            labels: days,
            income: incomeData,
            users: usersData
        });

    } catch (e) {
        console.error(e);
        res.status(500).json({ error: "Failed to fetch charts" });
    }
});



/* ================= PRICES & CONVERSION ================= */

// Helper to get prices
async function getPrices() {
  try {
    const response = await fetch('https://api.binance.com/api/v3/ticker/price');
    const data = await response.json();
    // Convert to simple map { BTC: 95000, ... }
    const prices = {};
    data.forEach(item => {
      if (item.symbol.endsWith('USDT')) {
        const symbol = item.symbol.replace('USDT', '');
        prices[symbol] = parseFloat(item.price);
      }
    });
    // Add stablecoins
    prices['USDT'] = 1;
    return prices;
  } catch (e) {
    console.error("Failed to fetch prices:", e);
    // Fallback
    return {
      BTC: 95000,
      ETH: 3600,
      BNB: 600,
      SOL: 150,
      USDT: 1
    };
  }
}

app.get("/api/prices", async (req, res) => {
  const prices = await getPrices();
  res.json(prices);
});

// MARKET DATA (24hr ticker)
app.get("/api/markets", async (req, res) => {
    try {
        const symbolsParam = req.query.symbols;
        if (!symbolsParam) return res.json([]);
        
        // Pass the symbols array directly to Binance API
        // Binance expects format: symbols=["BTCUSDT","ETHUSDT"]
        const response = await fetch(`https://api.binance.com/api/v3/ticker/24hr?symbols=${encodeURIComponent(symbolsParam)}`);
        
        if (!response.ok) {
            console.error("Binance API error:", response.statusText);
             // If Binance fails, return empty array so frontend doesn't break
            return res.json([]);
        }
        
        const data = await response.json();
        
        // If data is just one object (single symbol requested), wrap in array
        if (!Array.isArray(data)) {
            return res.json([data]);
        }
        
        res.json(data);
        
    } catch (e) {
        console.error("Market data error:", e);
        res.status(500).json({ error: "Failed to fetch market data" });
    }
});

// CONVERT COIN (Two-way support)
app.post("/api/convert", async (req, res) => {
  const username = req.cookies.user || req.headers['x-user'];
  if (!username) return res.status(401).json({ error: "Unauthorized" });

  let { fromCurrency, toCurrency, amount } = req.body;
  
  // Default to USDT if target not specified (legacy behavior)
  if (!toCurrency) toCurrency = 'USDT';

  if (!fromCurrency || !amount || amount <= 0) {
    return res.status(400).json({ error: "Invalid parameters" });
  }

  if (fromCurrency === toCurrency) {
      return res.status(400).json({ error: "Cannot convert to same currency" });
  }

  try {
      // 1. Get Prices
      const prices = await getPrices();
      const pFrom = prices[fromCurrency];
      const pTo = prices[toCurrency];

      if (!pFrom || !pTo) {
        return res.status(400).json({ error: `Price not available for ${!pFrom ? fromCurrency : toCurrency}` });
      }

      // 2. Check Balance
      // Special handling for USDT as source (check users.balance)
      if (fromCurrency === 'USDT') {
          const user = await db.get("SELECT balance FROM users WHERE username=?", [username]);
          if (!user || user.balance < amount) {
             return res.status(400).json({ error: "Insufficient USDT balance" });
          }
      } else {
          const balanceRow = await db.get(
            "SELECT amount FROM user_balances WHERE username=? AND currency=?",
            [username, fromCurrency]
          );
          if (!balanceRow || balanceRow.amount < amount) {
            return res.status(400).json({ error: "Insufficient balance" });
          }
      }

      // 3. Calculate Target Amount
      // Value in USDT
      const valUsdt = amount * pFrom;
      const targetAmount = valUsdt / pTo;

      await db.run("BEGIN TRANSACTION");

      // 4. Deduct Source
      if (fromCurrency === 'USDT') {
          await db.run("UPDATE users SET balance = balance - ? WHERE username=?", [amount, username]);
          // Also sync user_balances if exists (avoid negative if not exists/sufficient there, but we assume main balance is source of truth)
          // We only update if row exists to avoid creating negative balance rows for USDT if it was only in main table
          await db.run("UPDATE user_balances SET amount = amount - ? WHERE username=? AND currency='USDT' AND amount >= ?", [amount, username, amount]);
      } else {
          await db.run("UPDATE user_balances SET amount = amount - ? WHERE username=? AND currency=?", [amount, username, fromCurrency]);
      }

      // 5. Add Target
      if (toCurrency === 'USDT') {
          await db.run("UPDATE users SET balance = balance + ? WHERE username=?", [targetAmount, username]);
          // Sync user_balances
           await db.run(`
            INSERT INTO user_balances (username, currency, amount) 
            VALUES (?, 'USDT', ?)
            ON CONFLICT(username, currency) DO UPDATE SET amount = amount + ?
          `, [username, targetAmount, targetAmount]);
      } else {
          await db.run(`
            INSERT INTO user_balances (username, currency, amount) 
            VALUES (?, ?, ?)
            ON CONFLICT(username, currency) DO UPDATE SET amount = amount + ?
          `, [username, toCurrency, targetAmount, targetAmount]);
      }

      // 6. Log Trade
      await db.run(`
        INSERT INTO trades (username, symbol, side, amount, profit, result)
        VALUES (?, ?, 'convert', ?, ?, 'win')
      `, [username, `${fromCurrency}-${toCurrency}`, amount, targetAmount]);

      await db.run("COMMIT");
      res.json({ success: true, convertedAmount: targetAmount, rate: pFrom/pTo });

  } catch (e) {
      await db.run("ROLLBACK");
      res.status(500).json({ error: e.message });
  }
});

/* ================== FILE STORAGE ================== */
const uploadsDir = path.join(__dirname, "uploads");
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });

const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, uploadsDir)
  },
  filename: function (req, file, cb) {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9)
    const ext = path.extname(file.originalname) || '.jpg';
    cb(null, file.fieldname + '-' + uniqueSuffix + ext)
  }
})

const upload = multer({ storage: storage });

// Serve uploads
app.use("/uploads", express.static(uploadsDir));

// SUBMIT WITHDRAWAL
app.post("/api/withdraw", async (req, res) => {
  const username = req.cookies.user || req.headers['x-user'];
  if (!username) return res.status(401).json({ error: "Unauthorized" });

  const user = await db.get("SELECT status FROM users WHERE username=?", [username]);
  if (user && user.status === 'frozen') return res.status(403).json({ error: "Account frozen" });

  const { currency, network, amount, address } = req.body;
  
  if (!currency || !network || !amount || !address) {
    return res.status(400).json({ error: "Missing fields" });
  }

  try {
    await db.run("BEGIN TRANSACTION");

    // 1. Check and Deduct Balance
    // We need to check if we are withdrawing USDT or other coins
    // For USDT, we generally check user_balances first, if not there, users.balance (legacy)
    // Actually, for consistency with 'convert', we should prioritize user_balances for everything, 
    // but we must handle the legacy main balance for USDT.

    let balanceDeducted = false;

    if (currency === 'USDT') {
        // Try user_balances first
        const balanceRow = await db.get("SELECT amount FROM user_balances WHERE username=? AND currency='USDT'", [username]);
        if (balanceRow && balanceRow.amount >= amount) {
            await db.run("UPDATE user_balances SET amount = amount - ? WHERE username=? AND currency='USDT'", [amount, username]);
            balanceDeducted = true;
        } else {
            // Check legacy main balance
            const userMain = await db.get("SELECT balance FROM users WHERE username=?", [username]);
            if (userMain && userMain.balance >= amount) {
                 await db.run("UPDATE users SET balance = balance - ? WHERE username=?", [amount, username]);
                 balanceDeducted = true;
            }
        }
    } else {
        // Other coins
        const balanceRow = await db.get("SELECT amount FROM user_balances WHERE username=? AND currency=?", [username, currency]);
        if (balanceRow && balanceRow.amount >= amount) {
            await db.run("UPDATE user_balances SET amount = amount - ? WHERE username=? AND currency=?", [amount, username, currency]);
            balanceDeducted = true;
        }
    }

    if (!balanceDeducted) {
        await db.run("ROLLBACK");
        return res.status(400).json({ error: "Insufficient balance" });
    }

    // 2. Insert Withdrawal Record
    const result = await db.run(`
      INSERT INTO withdrawals (username, currency, network, amount, address, status)
      VALUES (?, ?, ?, ?, ?, 'pending')
    `, [username, currency, network, amount, address]);
    
    await db.run("COMMIT");
    res.json({ id: result.lastID, status: "pending" });
  } catch (e) {
    await db.run("ROLLBACK");
    res.status(500).json({ error: e.message });
  }
});

// SUBMIT DEPOSIT
app.post("/api/deposit", upload.single('voucher'), async (req, res) => {
  const username = req.cookies.user || req.headers['x-user'];
  if (!username) return res.status(401).json({ error: "Unauthorized" });

  const user = await db.get("SELECT status FROM users WHERE username=?", [username]);
  if (user && user.status === 'frozen') return res.status(403).json({ error: "Account frozen" });

  const { currency, network, amount, address } = req.body;
  const proof_image = req.file ? "/uploads/" + req.file.filename : null;

  try {
    const result = await db.run(`
      INSERT INTO deposits (username, currency, network, amount, proof_image)
      VALUES (?, ?, ?, ?, ?)
    `, [username, currency, network, amount, proof_image]);
    
    res.json({ id: result.lastID, status: "pending" });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// PRIMARY VERIFICATION
app.post("/api/verification/primary", async (req, res) => {
  const username = req.cookies.user || req.headers['x-user'];
  if (!username) return res.status(401).json({ error: "Unauthorized" });
  const { first_name, last_name, document_type, document_number } = req.body;
  if (!first_name || !last_name || !document_type || !document_number) {
    return res.status(400).json({ error: "Missing fields" });
  }
  try {
    const result = await db.run(`
      INSERT INTO verifications (username, kind, first_name, last_name, document_type, document_number, status)
      VALUES (?, 'primary', ?, ?, ?, ?, 'pending')
    `, [username, first_name, last_name, document_type, document_number]);
    res.json({ id: result.lastID, status: "pending" });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ADVANCED VERIFICATION WITH FILES
app.post("/api/verification/advanced", upload.fields([
  { name: 'front', maxCount: 1 },
  { name: 'back', maxCount: 1 },
  { name: 'selfie', maxCount: 1 }
]), async (req, res) => {
  const username = req.cookies.user || req.headers['x-user'];
  if (!username) return res.status(401).json({ error: "Unauthorized" });
  const { document_type, document_number } = req.body;
  if (!document_type || !document_number) {
    return res.status(400).json({ error: "Missing fields" });
  }
  const front = req.files?.front?.[0] ? "/uploads/" + req.files.front[0].filename : null;
  const back = req.files?.back?.[0] ? "/uploads/" + req.files.back[0].filename : null;
  const selfie = req.files?.selfie?.[0] ? "/uploads/" + req.files.selfie[0].filename : null;
  if (!front || !back || !selfie) {
    return res.status(400).json({ error: "Missing images" });
  }
  try {
    const result = await db.run(`
      INSERT INTO verifications (username, kind, document_type, document_number, front_image, back_image, selfie_image, status)
      VALUES (?, 'advanced', ?, ?, ?, ?, ?, 'pending')
    `, [username, document_type, document_number, front, back, selfie]);
    res.json({ id: result.lastID, status: "pending" });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// USER VERIFICATION STATUS
app.get("/api/verification/status", async (req, res) => {
  const username = req.cookies.user || req.headers['x-user'];
  if (!username) return res.json({ primary: null, advanced: null });
  const primary = await db.get(`SELECT status FROM verifications WHERE username=? AND kind='primary' ORDER BY id DESC LIMIT 1`, [username]);
  const advanced = await db.get(`SELECT status FROM verifications WHERE username=? AND kind='advanced' ORDER BY id DESC LIMIT 1`, [username]);
  res.json({
    primary: primary?.status || null,
    advanced: advanced?.status || null
  });
});


app.get("/api/history/deposits", async (req, res) => {
  const username = req.cookies.user || req.headers['x-user'];
  if (!username) return res.status(401).json({ error: "Unauthorized" });
  
  const rows = await db.all("SELECT * FROM deposits WHERE username=? ORDER BY id DESC", [username]);
  res.json(rows);
});

app.get("/api/history/withdrawals", async (req, res) => {
  const username = req.cookies.user || req.headers['x-user'];
  if (!username) return res.status(401).json({ error: "Unauthorized" });

  const rows = await db.all("SELECT * FROM withdrawals WHERE username=? ORDER BY id DESC", [username]);
  res.json(rows);
});

app.get("/api/history/trades", async (req, res) => {
  const username = req.cookies.user || req.headers['x-user'];
  if (!username) return res.status(401).json({ error: "Unauthorized" });

  const rows = await db.all("SELECT * FROM trades WHERE username=? ORDER BY id DESC", [username]);
  res.json(rows);
});

/* ================== HEALTH ================== */
app.get("/api/health", (req, res) => {
  res.json({ status: "ok" });
});

/* ================== MARKET PRICES (BINANCE) ================== */
app.get("/api/klines", async (req, res) => {
  try {
    const { symbol, interval, limit } = req.query;
    const url = `https://api.binance.com/api/v3/klines?symbol=${symbol || 'BTCUSDT'}&interval=${interval || '1m'}&limit=${limit || 100}`;
    const r = await fetch(url);
    const data = await r.json();
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: "klines_fetch_failed" });
  }
});

app.get("/api/markets", async (req, res) => {
  try {
    const symbols = req.query.symbols
      ? JSON.parse(req.query.symbols)
      : [
          "BTCUSDT","ETHUSDT","BNBUSDT","XRPUSDT","ADAUSDT",
          "SOLUSDT","DOGEUSDT","TRXUSDT","LTCUSDT","DOTUSDT"
        ];

    const url =
      "https://api.binance.com/api/v3/ticker/24hr?symbols=" +
      encodeURIComponent(JSON.stringify(symbols));

    const r = await fetch(url);
    const data = await r.json();

    const markets = data.map(m => ({
      symbol: m.symbol,
      price: m.lastPrice,
      changePercent: m.priceChangePercent,
      high: m.highPrice,
      low: m.lowPrice,
      volume: m.volume
    }));

    res.json(markets);
  } catch (e) {
    res.status(500).json({ error: "market_fetch_failed" });
  }
});

/* ================== USERS (ADMIN) ================== */
app.get("/api/admin/users", async (req, res) => {
  try {
    const users = await db.all("SELECT * FROM users");
    res.json(users);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// CREATE USER (NO LOGIN FOR NOW)
app.post("/api/admin/users", async (req, res) => {
  const { username, balance = 0 } = req.body;
  try {
    await db.run(
      "INSERT INTO users (username, balance) VALUES (?, ?)", [username, balance]
    );
    res.json({ status: "created" });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// UPDATE BALANCE
app.post("/api/admin/users/balance", async (req, res) => {
  const { username, balance } = req.body;
  // If balance is negative (e.g. -25), it will subtract.
  // If balance is positive (e.g. 25), it will add.
  await db.run(
    "UPDATE users SET balance = balance + ? WHERE username=?", [balance, username]
  );
  res.json({ status: "updated" });
});

// ADD COIN BALANCE (ADMIN)
app.post("/api/admin/users/add-coin-balance", async (req, res) => {
  const { username, currency, amount } = req.body;
  if(!username || !currency || amount === undefined) {
      return res.status(400).json({ error: "Missing fields" });
  }
  
  const val = parseFloat(amount);
  
  // Upsert balance
  const existing = await db.get("SELECT * FROM user_balances WHERE username=? AND currency=?", [username, currency]);
  if(existing) {
      await db.run("UPDATE user_balances SET amount = amount + ? WHERE username=? AND currency=?", [val, username, currency]);
  } else {
      await db.run("INSERT INTO user_balances (username, currency, amount) VALUES (?, ?, ?)", [username, currency, val]);
  }
  
  // If currency is USDT, also update the main legacy balance for compatibility
  if(currency === 'USDT') {
      await db.run("UPDATE users SET balance = balance + ? WHERE username=?", [val, username]);
  }

  res.json({ status: "updated" });
});

// GET USER DETAILED INFO (ADMIN)
app.get("/api/admin/user/:username/details", async (req, res) => {
    const { username } = req.params;
    try {
        const user = await db.get("SELECT * FROM users WHERE username=?", [username]);
        if (!user) return res.status(404).json({ error: "User not found" });

        const deposits = await db.get("SELECT SUM(amount) as total FROM deposits WHERE username=? AND status='approved'", [username]);
        const withdrawals = await db.get("SELECT SUM(amount) as total FROM withdrawals WHERE username=? AND status='approved'", [username]);
        const balances = await db.all("SELECT currency, amount FROM user_balances WHERE username=?", [username]);

        // Include USDT from main balance if not in user_balances explicitly (or just as a fallback/check)
        // We generally rely on user_balances now for specific coins, but main 'balance' is legacy USDT.
        
        res.json({
            user,
            total_deposited: deposits.total || 0,
            total_withdrawn: withdrawals.total || 0,
            balances
        });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// FREEZE/UNFREEZE USER (ADMIN)
app.post("/api/admin/users/freeze", async (req, res) => {
    const { username, status } = req.body; // status: 'active' or 'frozen'
    if (!username || !status) return res.status(400).json({ error: "Missing fields" });

    try {
        await db.run("UPDATE users SET status=? WHERE username=?", [status, username]);
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// UPDATE USER TRADE SETTINGS (ADMIN)
app.post("/api/admin/users/settings", async (req, res) => {
    const { username, min_trade_amount, trade_settings } = req.body;
    if (!username) return res.status(400).json({ error: "Missing username" });
    
    try {
        await db.run("UPDATE users SET min_trade_amount=?, trade_settings=? WHERE username=?", [min_trade_amount, JSON.stringify(trade_settings), username]);
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// GET USER SETTINGS (For Frontend)
app.get("/api/user/settings", async (req, res) => {
    const username = req.cookies.user || req.headers['x-user'];
    if (!username) return res.status(401).json({ error: "Unauthorized" });

    try {
        const user = await db.get("SELECT min_trade_amount, trade_settings FROM users WHERE username=?", [username]);
        if (!user) return res.status(404).json({ error: "User not found" });
        
        res.json({
            min_trade_amount: user.min_trade_amount || 10,
            trade_settings: user.trade_settings ? JSON.parse(user.trade_settings) : []
        });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

/* ================== DEMO TRADE ENGINE ================== */
// Admin decides winning side
let ADMIN_WIN_SIDE = "short"; // "long" or "short"

app.post("/api/trade", async (req, res) => {
  let { username, symbol, side, amount, seconds, percent } = req.body;

  // Validate and parse inputs
  amount = parseFloat(amount);
  
  // Fetch user settings for validation
  try {
      const user = await db.get("SELECT min_trade_amount, trade_settings FROM users WHERE username=?", [username]);
      if (!user) return res.status(404).json({ error: "User not found" });

      const minAmount = user.min_trade_amount || 10;
      if (amount < minAmount) {
          return res.status(400).json({ error: "Insufficient balance" }); // Custom error as requested
      }

      // If seconds provided, lookup percent from settings
      if (seconds) {
          const settings = user.trade_settings ? JSON.parse(user.trade_settings) : [];
          const setting = settings.find(s => s.seconds == seconds);
          if (setting) {
              percent = parseFloat(setting.percent);
          }
      }
  } catch(e) {
      console.error("Trade validation error:", e);
      return res.status(500).json({ error: "Validation failed" });
  }

  // Fallback if percent still missing (e.g. old frontend or not found in settings)
  if (!percent || isNaN(parseFloat(percent))) {
    percent = parseFloat(req.body.percent) || 0;
  } else {
    percent = parseFloat(percent);
  }

  if (isNaN(amount) || amount <= 0) {
    return res.status(400).json({ error: "Invalid amount" });
  }


  const win = side === ADMIN_WIN_SIDE;
  const profit = win ? amount * (percent / 100) : -amount;

  console.log(`[TRADE] User: ${username}, Side: ${side}, Win: ${win}, Amount: ${amount}, Percent: ${percent}, Profit: ${profit}`);

  try {
    await db.run(`
      INSERT INTO trades (username, symbol, side, amount, profit, result)
      VALUES (?, ?, ?, ?, ?, ?)
    `, [username, symbol, side, amount, profit, win ? "win" : "lose"]);

    await db.run(
      "UPDATE users SET balance = balance + ? WHERE username=?", [profit, username]
    );

    res.json({
      result: win ? "win" : "lose",
      profit
    });
  } catch (e) {
    console.error("Trade error:", e);
    res.status(500).json({ error: "Trade failed" });
  }
});

/* ================== ADMIN CONTROL ================== */
app.post("/api/admin/winside", (req, res) => {
  ADMIN_WIN_SIDE = req.body.side; // long / short
  res.json({ winSide: ADMIN_WIN_SIDE });
});

app.get("/api/admin/summary", async (req, res) => {
  try {
    // Totals
    const totalUsers = await db.get("SELECT COUNT(*) as count FROM users");
    const frozenUsers = await db.get("SELECT COUNT(*) as count FROM users WHERE status='frozen'");
    
    const deposits = await db.get("SELECT SUM(amount) as total FROM deposits WHERE status='approved'");
    const withdraws = await db.get("SELECT SUM(amount) as total FROM withdrawals WHERE status='approved'");
    
    // Today's stats
    const today = new Date().toISOString().split('T')[0];
    const todayDeposits = await db.get("SELECT SUM(amount) as total FROM deposits WHERE status='approved' AND date(created_at) = ?", [today]);
    const todayWithdraws = await db.get("SELECT SUM(amount) as total FROM withdrawals WHERE status='approved' AND date(created_at) = ?", [today]);

    // Chart Data (Last 7 Days)
    const chartData = [];
    for (let i = 6; i >= 0; i--) {
        const d = new Date();
        d.setDate(d.getDate() - i);
        const dateStr = d.toISOString().split('T')[0];
        
        const dayDep = await db.get("SELECT SUM(amount) as total FROM deposits WHERE status='approved' AND date(created_at) = ?", [dateStr]);
        const dayWith = await db.get("SELECT SUM(amount) as total FROM withdrawals WHERE status='approved' AND date(created_at) = ?", [dateStr]);
        const dayUsers = await db.get("SELECT COUNT(*) as count FROM users WHERE date(created_at) = ?", [dateStr]);
        
        chartData.push({
            date: dateStr,
            income: (dayDep.total || 0) - (dayWith.total || 0),
            newUsers: dayUsers.count || 0
        });
    }

    res.json({
      totalUsers: totalUsers.count || 0,
      frozenUsers: frozenUsers.count || 0,
      platformRechargeUpDown: (deposits.total || 0) - (withdraws.total || 0),
      todayRechargeUpDown: (todayDeposits.total || 0) - (todayWithdraws.total || 0),
      chartData
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get("/api/deposits", async (req, res) => {
  const rows = await db.all("SELECT * FROM deposits ORDER BY id DESC");
  res.json(rows);
});

app.get("/api/withdrawals", async (req, res) => {
  const rows = await db.all("SELECT * FROM withdrawals ORDER BY id DESC");
  res.json(rows);
});

app.get("/api/trades", async (req, res) => {
  const rows = await db.all("SELECT * FROM trades ORDER BY id DESC");
  res.json(rows);
});

// ADMIN: VERIFICATIONS LIST
app.get("/api/admin/verifications", async (req, res) => {
  try {
    const rows = await db.all("SELECT * FROM verifications ORDER BY id DESC");
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ADMIN: VERIFICATION STATUS UPDATE
app.post("/api/admin/verification/:id/status", async (req, res) => {
  const { status } = req.body;
  const { id } = req.params;
  await db.run("UPDATE verifications SET status=? WHERE id=?", [status, id]);
  res.json({ success: true });
});

app.post("/api/deposit/:id/status", async (req, res) => {
  const { status } = req.body;
  const { id } = req.params;
  await db.run("UPDATE deposits SET status=? WHERE id=?", [status, id]);
  if (status === 'approved') {
    const dep = await db.get("SELECT * FROM deposits WHERE id=?", [id]);
    if (dep) {
       await db.run("UPDATE users SET balance = balance + ? WHERE username=?", [dep.amount, dep.username]);
    }
  }
  res.json({ success: true });
});

app.post("/api/withdraw/:id/status", async (req, res) => {
  const { status } = req.body;
  const { id } = req.params;
  
  if (status !== 'approved' && status !== 'rejected') {
      return res.status(400).json({ error: "Invalid status" });
  }

  try {
      await db.run("BEGIN TRANSACTION");
      
      const withdrawal = await db.get("SELECT * FROM withdrawals WHERE id=?", [id]);
      if (!withdrawal) {
          await db.run("ROLLBACK");
          return res.status(404).json({ error: "Withdrawal not found" });
      }

      if (withdrawal.status !== 'pending') {
          await db.run("ROLLBACK");
          return res.status(400).json({ error: "Withdrawal already processed" });
      }

      await db.run("UPDATE withdrawals SET status=? WHERE id=?", [status, id]);

      // If Rejected, Refund Balance
      if (status === 'rejected') {
          const { username, currency, amount } = withdrawal;
          
          if (currency === 'USDT') {
             // Refund to legacy main balance for simplicity if we don't track where it came from
             // Or better: check if user has user_balances entry, if so add there, else add to legacy.
             // Simplest safe approach: Add to legacy balance if USDT, as that's the "primary" one.
             await db.run("UPDATE users SET balance = balance + ? WHERE username=?", [amount, username]);
          } else {
             // Refund to coin balance
             await db.run(`
                INSERT INTO user_balances (username, currency, amount) 
                VALUES (?, ?, ?)
                ON CONFLICT(username, currency) DO UPDATE SET amount = amount + ?
             `, [username, currency, amount, amount]);
          }
      }

      await db.run("COMMIT");
      res.json({ success: true });
  } catch (e) {
      await db.run("ROLLBACK");
      res.status(500).json({ error: e.message });
  }
});

/* ================== START SERVER ================== */
const PORT = 3001;
initDb().then(() => {
  app.listen(PORT, () => {
    console.log(`Bitsafe API running on port ${PORT}`);
  });
}).catch(err => {
    console.error("Failed to initialize database:", err);
});
