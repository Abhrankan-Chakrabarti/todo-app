import bcrypt from 'bcryptjs';
import cookieParser from 'cookie-parser';
import cors from 'cors';
import express from 'express';
import { promises as fs } from 'fs';
import jwt from 'jsonwebtoken';
import path from 'path';
import { fileURLToPath } from 'url';
import pg from 'pg';

const { Pool } = pg;
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DATA_FILE = path.join(__dirname, 'data.json');
const DIST_DIR = path.join(__dirname, '..', 'dist');
const PORT = Number(process.env.PORT || 3001);
const DATABASE_URL = process.env.DATABASE_URL;
const JWT_SECRET = process.env.JWT_SECRET || 'dev-insecure-change-me';
const COOKIE_NAME = 'todo_token';
const IS_PROD = process.env.NODE_ENV === 'production';

const app = express();
app.set('trust proxy', 1);
app.use(cors({ origin: true, credentials: true }));
app.use(express.json());
app.use(cookieParser());

let pool = null;

function getPool() {
  if (!DATABASE_URL) return null;
  if (!pool) {
    const ssl =
      process.env.DATABASE_SSL === 'false' || DATABASE_URL.includes('localhost')
        ? undefined
        : { rejectUnauthorized: false };
    pool = new Pool({ connectionString: DATABASE_URL, ssl });
  }
  return pool;
}

async function initDb() {
  const db = getPool();
  if (!db) return;
  await db.query(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      email TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      created_at BIGINT NOT NULL
    )
  `);
  await db.query(`
    CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY,
      user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
      text TEXT NOT NULL,
      done BOOLEAN NOT NULL DEFAULT FALSE,
      created_at BIGINT NOT NULL,
      due_at BIGINT,
      progress INTEGER NOT NULL DEFAULT 0
    )
  `);
  await db.query(`ALTER TABLE tasks ADD COLUMN IF NOT EXISTS user_id TEXT REFERENCES users(id) ON DELETE CASCADE`);
  await db.query(`ALTER TABLE tasks ADD COLUMN IF NOT EXISTS due_at BIGINT`);
  await db.query(`ALTER TABLE tasks ADD COLUMN IF NOT EXISTS progress INTEGER NOT NULL DEFAULT 0`);
  await db.query(`
    CREATE TABLE IF NOT EXISTS task_updates (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      text TEXT NOT NULL,
      progress_at INTEGER NOT NULL DEFAULT 0,
      created_at BIGINT NOT NULL
    )
  `);
  await db.query(`CREATE INDEX IF NOT EXISTS task_updates_task_id_idx ON task_updates(task_id)`);
  await db.query(`CREATE INDEX IF NOT EXISTS tasks_user_id_idx ON tasks(user_id)`);
}

function makeId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

function clampProgress(value, fallback = 0) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(0, Math.min(100, Math.round(n)));
}

function normalizeDueAt(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.round(n);
}

function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}

function publicUser(user) {
  return { id: user.id, name: user.name, email: user.email, createdAt: Number(user.created_at || user.createdAt) };
}

function signToken(user) {
  return jwt.sign({ sub: user.id, email: user.email }, JWT_SECRET, { expiresIn: '7d' });
}

function setAuthCookie(res, token) {
  res.cookie(COOKIE_NAME, token, {
    httpOnly: true,
    secure: IS_PROD || process.env.COOKIE_SECURE === 'true',
    sameSite: 'lax',
    maxAge: 7 * 24 * 60 * 60 * 1000,
    path: '/',
  });
}

function clearAuthCookie(res) {
  res.clearCookie(COOKIE_NAME, {
    httpOnly: true,
    secure: IS_PROD || process.env.COOKIE_SECURE === 'true',
    sameSite: 'lax',
    path: '/',
  });
}

async function getUserById(id) {
  const db = getPool();
  if (db) {
    const { rows } = await db.query('SELECT id, name, email, password_hash, created_at FROM users WHERE id = $1', [id]);
    return rows[0] || null;
  }
  const store = await readStoreFile();
  return store.users.find((u) => u.id === id) || null;
}

async function getUserByEmail(email) {
  const db = getPool();
  if (db) {
    const { rows } = await db.query('SELECT id, name, email, password_hash, created_at FROM users WHERE email = $1', [email]);
    return rows[0] || null;
  }
  const store = await readStoreFile();
  return store.users.find((u) => normalizeEmail(u.email) === email) || null;
}

async function authRequired(req, res, next) {
  try {
    const token = req.cookies?.[COOKIE_NAME];
    if (!token) return res.status(401).json({ error: 'Authentication required' });
    const payload = jwt.verify(token, JWT_SECRET);
    const user = await getUserById(payload.sub);
    if (!user) {
      clearAuthCookie(res);
      return res.status(401).json({ error: 'Authentication required' });
    }
    req.user = publicUser(user);
    next();
  } catch {
    clearAuthCookie(res);
    return res.status(401).json({ error: 'Authentication required' });
  }
}

// JSON file fallback (local dev when DATABASE_URL is not set)
async function readStoreFile() {
  try {
    const raw = await fs.readFile(DATA_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      return { users: [], tasks: parsed.map((t) => normalizeTask(t, null)) };
    }
    return {
      users: Array.isArray(parsed?.users) ? parsed.users : [],
      tasks: Array.isArray(parsed?.tasks) ? parsed.tasks.map((t) => normalizeTask(t, t.userId ?? null)) : [],
    };
  } catch (err) {
    if (err && err.code === 'ENOENT') {
      const empty = { users: [], tasks: [] };
      await fs.writeFile(DATA_FILE, JSON.stringify(empty, null, 2), 'utf8');
      return empty;
    }
    throw err;
  }
}

async function writeStoreFile(store) {
  await fs.writeFile(DATA_FILE, JSON.stringify({ users: store.users || [], tasks: (store.tasks || []).map((t) => normalizeTask(t, t.userId ?? null)) }, null, 2), 'utf8');
}

function normalizeTask(task, userId) {
  return {
    id: String(task.id),
    userId: task.userId ?? userId ?? null,
    text: String(task.text ?? ''),
    done: Boolean(task.done),
    createdAt: Number(task.createdAt) || Date.now(),
    dueAt: normalizeDueAt(task.dueAt),
    progress: clampProgress(task.progress, task.done ? 100 : 0),
    updates: Array.isArray(task.updates)
      ? task.updates.map((u) => ({
          id: String(u.id),
          taskId: String(u.taskId ?? task.id),
          text: String(u.text ?? ''),
          progressAt: clampProgress(u.progressAt, 0),
          createdAt: Number(u.createdAt) || Date.now(),
        }))
      : [],
  };
}

function rowToTask(row, updates = []) {
  return {
    id: row.id,
    text: row.text,
    done: Boolean(row.done),
    createdAt: Number(row.created_at),
    dueAt: row.due_at == null ? null : Number(row.due_at),
    progress: clampProgress(row.progress, 0),
    updates,
  };
}

function rowToUpdate(row) {
  return {
    id: row.id,
    taskId: row.task_id,
    text: row.text,
    progressAt: clampProgress(row.progress_at, 0),
    createdAt: Number(row.created_at),
  };
}

function toClientTask(task) {
  const { userId, ...rest } = task;
  void userId;
  return rest;
}

async function listTasks(userId) {
  const db = getPool();
  if (db) {
    const tasksRes = await db.query(
      'SELECT id, text, done, created_at, due_at, progress FROM tasks WHERE user_id = $1 ORDER BY created_at DESC',
      [userId]
    );
    const ids = tasksRes.rows.map((r) => r.id);
    let byTask = new Map();
    if (ids.length) {
      const updatesRes = await db.query(
        'SELECT id, task_id, text, progress_at, created_at FROM task_updates WHERE task_id = ANY($1::text[]) ORDER BY created_at DESC',
        [ids]
      );
      byTask = new Map();
      for (const row of updatesRes.rows) {
        const list = byTask.get(row.task_id) || [];
        list.push(rowToUpdate(row));
        byTask.set(row.task_id, list);
      }
    }
    return tasksRes.rows.map((row) => rowToTask(row, byTask.get(row.id) || []));
  }
  const store = await readStoreFile();
  return store.tasks.filter((t) => t.userId === userId).sort((a, b) => b.createdAt - a.createdAt).map(toClientTask);
}

async function createTask(userId, { text, dueAt, progress }) {
  const p = clampProgress(progress, 0);
  const task = {
    id: makeId(),
    userId,
    text,
    done: p >= 100,
    createdAt: Date.now(),
    dueAt: normalizeDueAt(dueAt),
    progress: p,
    updates: [],
  };
  const db = getPool();
  if (db) {
    await db.query(
      'INSERT INTO tasks (id, user_id, text, done, created_at, due_at, progress) VALUES ($1, $2, $3, $4, $5, $6, $7)',
      [task.id, userId, task.text, task.done, task.createdAt, task.dueAt, task.progress]
    );
    return toClientTask(task);
  }
  const store = await readStoreFile();
  store.tasks.unshift(task);
  await writeStoreFile(store);
  return toClientTask(task);
}

async function getOwnedTask(userId, id) {
  const db = getPool();
  if (db) {
    const { rows } = await db.query(
      'SELECT id, text, done, created_at, due_at, progress FROM tasks WHERE id = $1 AND user_id = $2',
      [id, userId]
    );
    return rows[0] || null;
  }
  const store = await readStoreFile();
  return store.tasks.find((t) => t.id === id && t.userId === userId) || null;
}

async function updateTask(userId, id, updates) {
  const db = getPool();
  if (db) {
    const row = await getOwnedTask(userId, id);
    if (!row) return null;
    let next = rowToTask(row);
    if (typeof updates.text === 'string') next.text = updates.text;
    if (Object.prototype.hasOwnProperty.call(updates, 'dueAt')) next.dueAt = normalizeDueAt(updates.dueAt);
    if (typeof updates.progress === 'number') next.progress = clampProgress(updates.progress, next.progress);
    if (typeof updates.done === 'boolean') {
      next.done = updates.done;
      if (updates.done) next.progress = 100;
      else if (next.progress >= 100 && !Object.prototype.hasOwnProperty.call(updates, 'progress')) next.progress = 99;
    }
    if (next.progress >= 100) next.done = true;
    await db.query(
      'UPDATE tasks SET text = $1, done = $2, due_at = $3, progress = $4 WHERE id = $5 AND user_id = $6',
      [next.text, next.done, next.dueAt, next.progress, id, userId]
    );
    const updatesRes = await db.query(
      'SELECT id, task_id, text, progress_at, created_at FROM task_updates WHERE task_id = $1 ORDER BY created_at DESC',
      [id]
    );
    next.updates = updatesRes.rows.map(rowToUpdate);
    return next;
  }
  const store = await readStoreFile();
  const idx = store.tasks.findIndex((t) => t.id === id && t.userId === userId);
  if (idx === -1) return null;
  let next = { ...toClientTask(store.tasks[idx]) };
  if (typeof updates.text === 'string') next.text = updates.text;
  if (Object.prototype.hasOwnProperty.call(updates, 'dueAt')) next.dueAt = normalizeDueAt(updates.dueAt);
  if (typeof updates.progress === 'number') next.progress = clampProgress(updates.progress, next.progress);
  if (typeof updates.done === 'boolean') {
    next.done = updates.done;
    if (updates.done) next.progress = 100;
    else if (next.progress >= 100 && !Object.prototype.hasOwnProperty.call(updates, 'progress')) next.progress = 99;
  }
  if (next.progress >= 100) next.done = true;
  store.tasks[idx] = { ...store.tasks[idx], ...next, userId };
  await writeStoreFile(store);
  return toClientTask(store.tasks[idx]);
}

async function deleteTask(userId, id) {
  const db = getPool();
  if (db) {
    const { rowCount } = await db.query('DELETE FROM tasks WHERE id = $1 AND user_id = $2', [id, userId]);
    return rowCount > 0;
  }
  const store = await readStoreFile();
  const before = store.tasks.length;
  store.tasks = store.tasks.filter((t) => !(t.id === id && t.userId === userId));
  if (store.tasks.length === before) return false;
  await writeStoreFile(store);
  return true;
}

async function clearCompletedTasks(userId) {
  const db = getPool();
  if (db) {
    await db.query('DELETE FROM tasks WHERE user_id = $1 AND done = TRUE', [userId]);
    return listTasks(userId);
  }
  const store = await readStoreFile();
  store.tasks = store.tasks.filter((t) => !(t.userId === userId && t.done));
  await writeStoreFile(store);
  return listTasks(userId);
}

async function addTaskUpdate(userId, taskId, { text, progressAt }) {
  const update = {
    id: makeId(),
    taskId,
    text,
    progressAt: clampProgress(progressAt, 0),
    createdAt: Date.now(),
  };
  const db = getPool();
  if (db) {
    const owned = await getOwnedTask(userId, taskId);
    if (!owned) return null;
    await db.query(
      'INSERT INTO task_updates (id, task_id, text, progress_at, created_at) VALUES ($1, $2, $3, $4, $5)',
      [update.id, update.taskId, update.text, update.progressAt, update.createdAt]
    );
    await db.query('UPDATE tasks SET progress = $1, done = $2 WHERE id = $3 AND user_id = $4', [
      update.progressAt,
      update.progressAt >= 100,
      taskId,
      userId,
    ]);
    return update;
  }
  const store = await readStoreFile();
  const idx = store.tasks.findIndex((t) => t.id === taskId && t.userId === userId);
  if (idx === -1) return null;
  store.tasks[idx].updates = [update, ...(store.tasks[idx].updates || [])];
  store.tasks[idx].progress = update.progressAt;
  store.tasks[idx].done = update.progressAt >= 100;
  await writeStoreFile(store);
  return update;
}

// Auth
app.post('/api/auth/register', async (req, res) => {
  try {
    const name = String(req.body?.name || '').trim();
    const email = normalizeEmail(req.body?.email);
    const password = String(req.body?.password || '');
    if (!name) return res.status(400).json({ error: 'Name is required' });
    if (!email || !email.includes('@')) return res.status(400).json({ error: 'A valid email is required' });
    if (password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });

    const existing = await getUserByEmail(email);
    if (existing) return res.status(409).json({ error: 'Account with this email already exists' });

    const passwordHash = await bcrypt.hash(password, 10);
    const user = { id: makeId(), name, email, password_hash: passwordHash, created_at: Date.now() };
    const db = getPool();
    if (db) {
      await db.query(
        'INSERT INTO users (id, name, email, password_hash, created_at) VALUES ($1, $2, $3, $4, $5)',
        [user.id, user.name, user.email, user.password_hash, user.created_at]
      );
    } else {
      const store = await readStoreFile();
      store.users.push(user);
      await writeStoreFile(store);
    }

    const pub = publicUser(user);
    setAuthCookie(res, signToken(pub));
    res.status(201).json({ user: pub });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to create account' });
  }
});

app.post('/api/auth/login', async (req, res) => {
  try {
    const email = normalizeEmail(req.body?.email);
    const password = String(req.body?.password || '');
    if (!email || !password) return res.status(400).json({ error: 'Email and password are required' });
    const user = await getUserByEmail(email);
    if (!user || !(await bcrypt.compare(password, user.password_hash))) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }
    const pub = publicUser(user);
    setAuthCookie(res, signToken(pub));
    res.json({ user: pub });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to sign in' });
  }
});

app.post('/api/auth/logout', (_req, res) => {
  clearAuthCookie(res);
  res.status(204).end();
});

app.get('/api/auth/me', async (req, res) => {
  try {
    const token = req.cookies?.[COOKIE_NAME];
    if (!token) return res.status(401).json({ error: 'Not authenticated' });
    const payload = jwt.verify(token, JWT_SECRET);
    const user = await getUserById(payload.sub);
    if (!user) {
      clearAuthCookie(res);
      return res.status(401).json({ error: 'Not authenticated' });
    }
    res.json({ user: publicUser(user) });
  } catch {
    clearAuthCookie(res);
    res.status(401).json({ error: 'Not authenticated' });
  }
});

// Tasks (protected)
app.get('/api/tasks', authRequired, async (req, res) => {
  try {
    res.json(await listTasks(req.user.id));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to read tasks' });
  }
});

app.post('/api/tasks', authRequired, async (req, res) => {
  try {
    const text = typeof req.body?.text === 'string' ? req.body.text.trim() : '';
    if (!text) return res.status(400).json({ error: 'Text is required' });
    res.status(201).json(
      await createTask(req.user.id, { text, dueAt: req.body?.dueAt, progress: req.body?.progress })
    );
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to create task' });
  }
});

app.patch('/api/tasks/:id', authRequired, async (req, res) => {
  try {
    const updates = {};
    if (typeof req.body?.text === 'string') updates.text = req.body.text.trim();
    if (typeof req.body?.done === 'boolean') updates.done = req.body.done;
    if (Object.prototype.hasOwnProperty.call(req.body || {}, 'dueAt')) updates.dueAt = req.body.dueAt;
    if (typeof req.body?.progress === 'number') updates.progress = req.body.progress;
    if (updates.text === '') return res.status(400).json({ error: 'Text cannot be empty' });
    const task = await updateTask(req.user.id, req.params.id, updates);
    if (!task) return res.status(404).json({ error: 'Task not found' });
    res.json(task);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to update task' });
  }
});

app.delete('/api/tasks/:id', authRequired, async (req, res) => {
  try {
    const ok = await deleteTask(req.user.id, req.params.id);
    if (!ok) return res.status(404).json({ error: 'Task not found' });
    res.status(204).end();
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to delete task' });
  }
});

app.delete('/api/tasks', authRequired, async (req, res) => {
  try {
    if (req.query.completed !== 'true') {
      return res.status(400).json({ error: 'Use ?completed=true to clear completed tasks' });
    }
    res.json(await clearCompletedTasks(req.user.id));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to clear tasks' });
  }
});

app.post('/api/tasks/:id/updates', authRequired, async (req, res) => {
  try {
    const text = typeof req.body?.text === 'string' ? req.body.text.trim() : '';
    if (!text) return res.status(400).json({ error: 'Update text is required' });
    const update = await addTaskUpdate(req.user.id, req.params.id, {
      text,
      progressAt: req.body?.progressAt,
    });
    if (!update) return res.status(404).json({ error: 'Task not found' });
    res.status(201).json(update);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to add update' });
  }
});

// Serve built frontend in production (Render, etc.)
app.use(express.static(DIST_DIR));
app.use(async (req, res, next) => {
  if (req.method !== 'GET' || req.path.startsWith('/api')) return next();
  try {
    await fs.access(path.join(DIST_DIR, 'index.html'));
    res.sendFile(path.join(DIST_DIR, 'index.html'));
  } catch {
    next();
  }
});

async function start() {
  try {
    await initDb();
    if (DATABASE_URL) console.log('Using Postgres storage (DATABASE_URL).');
    else console.log('DATABASE_URL not set; using local JSON file storage (server/data.json).');
    if (!process.env.JWT_SECRET) console.warn('JWT_SECRET not set; using insecure development fallback.');
    app.listen(PORT, () => {
      console.log(`Server listening on http://localhost:${PORT}`);
    });
  } catch (err) {
    console.error('Failed to start server:', err);
    process.exit(1);
  }
}

start();
