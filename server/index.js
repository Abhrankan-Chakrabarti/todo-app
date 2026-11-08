import cors from 'cors';
import express from 'express';
import { promises as fs } from 'fs';
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

const app = express();
app.use(cors());
app.use(express.json());

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
    CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY,
      text TEXT NOT NULL,
      done BOOLEAN NOT NULL DEFAULT FALSE,
      created_at BIGINT NOT NULL
    )
  `);
}

function makeId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

function rowToTask(row) {
  return {
    id: row.id,
    text: row.text,
    done: Boolean(row.done),
    createdAt: Number(row.created_at),
  };
}

// JSON file fallback (local dev when DATABASE_URL is not set)
async function readTasksFile() {
  try {
    const raw = await fs.readFile(DATA_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (err) {
    if (err && err.code === 'ENOENT') {
      await fs.writeFile(DATA_FILE, '[]', 'utf8');
      return [];
    }
    throw err;
  }
}

async function writeTasksFile(tasks) {
  await fs.writeFile(DATA_FILE, JSON.stringify(tasks, null, 2), 'utf8');
}

async function listTasks() {
  const db = getPool();
  if (db) {
    const { rows } = await db.query(
      'SELECT id, text, done, created_at FROM tasks ORDER BY created_at DESC'
    );
    return rows.map(rowToTask);
  }
  return readTasksFile();
}

async function createTask(text) {
  const task = { id: makeId(), text, done: false, createdAt: Date.now() };
  const db = getPool();
  if (db) {
    await db.query(
      'INSERT INTO tasks (id, text, done, created_at) VALUES ($1, $2, $3, $4)',
      [task.id, task.text, task.done, task.createdAt]
    );
    return task;
  }
  const tasks = await readTasksFile();
  tasks.unshift(task);
  await writeTasksFile(tasks);
  return task;
}

async function updateTask(id, updates) {
  const db = getPool();
  if (db) {
    const { rows } = await db.query('SELECT id, text, done, created_at FROM tasks WHERE id = $1', [id]);
    if (rows.length === 0) return null;
    const current = rowToTask(rows[0]);
    const next = {
      ...current,
      ...(typeof updates.text === 'string' ? { text: updates.text } : {}),
      ...(typeof updates.done === 'boolean' ? { done: updates.done } : {}),
    };
    await db.query('UPDATE tasks SET text = $1, done = $2 WHERE id = $3', [next.text, next.done, id]);
    return next;
  }
  const tasks = await readTasksFile();
  const idx = tasks.findIndex((t) => t.id === id);
  if (idx === -1) return null;
  tasks[idx] = {
    ...tasks[idx],
    ...(typeof updates.text === 'string' ? { text: updates.text } : {}),
    ...(typeof updates.done === 'boolean' ? { done: updates.done } : {}),
  };
  await writeTasksFile(tasks);
  return tasks[idx];
}

async function deleteTask(id) {
  const db = getPool();
  if (db) {
    const { rowCount } = await db.query('DELETE FROM tasks WHERE id = $1', [id]);
    return rowCount > 0;
  }
  const tasks = await readTasksFile();
  const next = tasks.filter((t) => t.id !== id);
  if (next.length === tasks.length) return false;
  await writeTasksFile(next);
  return true;
}

async function clearCompletedTasks() {
  const db = getPool();
  if (db) {
    await db.query('DELETE FROM tasks WHERE done = TRUE');
    return listTasks();
  }
  const tasks = await readTasksFile();
  const next = tasks.filter((t) => !t.done);
  await writeTasksFile(next);
  return next;
}

app.get('/api/tasks', async (_req, res) => {
  try {
    res.json(await listTasks());
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to read tasks' });
  }
});

app.post('/api/tasks', async (req, res) => {
  try {
    const text = typeof req.body?.text === 'string' ? req.body.text.trim() : '';
    if (!text) return res.status(400).json({ error: 'Text is required' });
    res.status(201).json(await createTask(text));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to create task' });
  }
});

app.patch('/api/tasks/:id', async (req, res) => {
  try {
    const updates = {};
    if (typeof req.body?.text === 'string') updates.text = req.body.text.trim();
    if (typeof req.body?.done === 'boolean') updates.done = req.body.done;
    if (updates.text === '') return res.status(400).json({ error: 'Text cannot be empty' });
    const task = await updateTask(req.params.id, updates);
    if (!task) return res.status(404).json({ error: 'Task not found' });
    res.json(task);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to update task' });
  }
});

app.delete('/api/tasks/:id', async (req, res) => {
  try {
    const ok = await deleteTask(req.params.id);
    if (!ok) return res.status(404).json({ error: 'Task not found' });
    res.status(204).end();
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to delete task' });
  }
});

app.delete('/api/tasks', async (req, res) => {
  try {
    if (req.query.completed !== 'true') {
      return res.status(400).json({ error: 'Use ?completed=true to clear completed tasks' });
    }
    res.json(await clearCompletedTasks());
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to clear tasks' });
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
    app.listen(PORT, () => {
      console.log(`Server listening on http://localhost:${PORT}`);
    });
  } catch (err) {
    console.error('Failed to start server:', err);
    process.exit(1);
  }
}

start();
