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
      created_at BIGINT NOT NULL,
      due_at BIGINT,
      progress INTEGER NOT NULL DEFAULT 0
    )
  `);
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

function normalizeTask(task) {
  return {
    id: String(task.id),
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

// JSON file fallback (local dev when DATABASE_URL is not set)
async function readTasksFile() {
  try {
    const raw = await fs.readFile(DATA_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    const tasks = Array.isArray(parsed) ? parsed : [];
    return tasks.map(normalizeTask).sort((a, b) => b.createdAt - a.createdAt);
  } catch (err) {
    if (err && err.code === 'ENOENT') {
      await fs.writeFile(DATA_FILE, '[]', 'utf8');
      return [];
    }
    throw err;
  }
}

async function writeTasksFile(tasks) {
  await fs.writeFile(DATA_FILE, JSON.stringify(tasks.map(normalizeTask), null, 2), 'utf8');
}

async function listTasks() {
  const db = getPool();
  if (db) {
    const tasksRes = await db.query(
      'SELECT id, text, done, created_at, due_at, progress FROM tasks ORDER BY created_at DESC'
    );
    const updatesRes = await db.query(
      'SELECT id, task_id, text, progress_at, created_at FROM task_updates ORDER BY created_at DESC'
    );
    const byTask = new Map();
    for (const row of updatesRes.rows) {
      const list = byTask.get(row.task_id) || [];
      list.push(rowToUpdate(row));
      byTask.set(row.task_id, list);
    }
    return tasksRes.rows.map((row) => rowToTask(row, byTask.get(row.id) || []));
  }
  return readTasksFile();
}

async function createTask({ text, dueAt, progress }) {
  const p = clampProgress(progress, 0);
  const task = {
    id: makeId(),
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
      'INSERT INTO tasks (id, text, done, created_at, due_at, progress) VALUES ($1, $2, $3, $4, $5, $6)',
      [task.id, task.text, task.done, task.createdAt, task.dueAt, task.progress]
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
    const { rows } = await db.query(
      'SELECT id, text, done, created_at, due_at, progress FROM tasks WHERE id = $1',
      [id]
    );
    if (rows.length === 0) return null;
    const current = rowToTask(rows[0]);
    let next = { ...current };
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
      'UPDATE tasks SET text = $1, done = $2, due_at = $3, progress = $4 WHERE id = $5',
      [next.text, next.done, next.dueAt, next.progress, id]
    );
    const updatesRes = await db.query(
      'SELECT id, task_id, text, progress_at, created_at FROM task_updates WHERE task_id = $1 ORDER BY created_at DESC',
      [id]
    );
    next.updates = updatesRes.rows.map(rowToUpdate);
    return next;
  }
  const tasks = await readTasksFile();
  const idx = tasks.findIndex((t) => t.id === id);
  if (idx === -1) return null;
  let next = { ...tasks[idx] };
  if (typeof updates.text === 'string') next.text = updates.text;
  if (Object.prototype.hasOwnProperty.call(updates, 'dueAt')) next.dueAt = normalizeDueAt(updates.dueAt);
  if (typeof updates.progress === 'number') next.progress = clampProgress(updates.progress, next.progress);
  if (typeof updates.done === 'boolean') {
    next.done = updates.done;
    if (updates.done) next.progress = 100;
    else if (next.progress >= 100 && !Object.prototype.hasOwnProperty.call(updates, 'progress')) next.progress = 99;
  }
  if (next.progress >= 100) next.done = true;
  tasks[idx] = next;
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

async function addTaskUpdate(taskId, { text, progressAt }) {
  const db = getPool();
  const update = {
    id: makeId(),
    taskId,
    text,
    progressAt: clampProgress(progressAt, 0),
    createdAt: Date.now(),
  };
  if (db) {
    const exists = await db.query('SELECT 1 FROM tasks WHERE id = $1', [taskId]);
    if (exists.rowCount === 0) return null;
    await db.query(
      'INSERT INTO task_updates (id, task_id, text, progress_at, created_at) VALUES ($1, $2, $3, $4, $5)',
      [update.id, update.taskId, update.text, update.progressAt, update.createdAt]
    );
    await db.query('UPDATE tasks SET progress = $1, done = $2 WHERE id = $3', [
      update.progressAt,
      update.progressAt >= 100,
      taskId,
    ]);
    return update;
  }
  const tasks = await readTasksFile();
  const idx = tasks.findIndex((t) => t.id === taskId);
  if (idx === -1) return null;
  tasks[idx].updates = [update, ...(tasks[idx].updates || [])];
  tasks[idx].progress = update.progressAt;
  tasks[idx].done = update.progressAt >= 100;
  await writeTasksFile(tasks);
  return update;
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
    res.status(201).json(
      await createTask({ text, dueAt: req.body?.dueAt, progress: req.body?.progress })
    );
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
    if (Object.prototype.hasOwnProperty.call(req.body || {}, 'dueAt')) updates.dueAt = req.body.dueAt;
    if (typeof req.body?.progress === 'number') updates.progress = req.body.progress;
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

app.post('/api/tasks/:id/updates', async (req, res) => {
  try {
    const text = typeof req.body?.text === 'string' ? req.body.text.trim() : '';
    if (!text) return res.status(400).json({ error: 'Update text is required' });
    const update = await addTaskUpdate(req.params.id, {
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
    app.listen(PORT, () => {
      console.log(`Server listening on http://localhost:${PORT}`);
    });
  } catch (err) {
    console.error('Failed to start server:', err);
    process.exit(1);
  }
}

start();
