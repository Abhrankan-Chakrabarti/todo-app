import cors from 'cors';
import express from 'express';
import { promises as fs } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DATA_FILE = path.join(__dirname, 'data.json');
const PORT = Number(process.env.PORT || 3001);

const app = express();
app.use(cors());
app.use(express.json());

async function readTasks() {
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

async function writeTasks(tasks) {
  await fs.writeFile(DATA_FILE, JSON.stringify(tasks, null, 2), 'utf8');
}

function makeId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

app.get('/api/tasks', async (_req, res) => {
  try {
    const tasks = await readTasks();
    res.json(tasks);
  } catch {
    res.status(500).json({ error: 'Failed to read tasks' });
  }
});

app.post('/api/tasks', async (req, res) => {
  try {
    const text = typeof req.body?.text === 'string' ? req.body.text.trim() : '';
    if (!text) return res.status(400).json({ error: 'Text is required' });
    const tasks = await readTasks();
    const task = { id: makeId(), text, done: false, createdAt: Date.now() };
    tasks.unshift(task);
    await writeTasks(tasks);
    res.status(201).json(task);
  } catch {
    res.status(500).json({ error: 'Failed to create task' });
  }
});

app.patch('/api/tasks/:id', async (req, res) => {
  try {
    const tasks = await readTasks();
    const idx = tasks.findIndex((t) => t.id === req.params.id);
    if (idx === -1) return res.status(404).json({ error: 'Task not found' });
    const updates = {};
    if (typeof req.body?.text === 'string') updates.text = req.body.text.trim();
    if (typeof req.body?.done === 'boolean') updates.done = req.body.done;
    if (updates.text === '') return res.status(400).json({ error: 'Text cannot be empty' });
    tasks[idx] = { ...tasks[idx], ...updates };
    await writeTasks(tasks);
    res.json(tasks[idx]);
  } catch {
    res.status(500).json({ error: 'Failed to update task' });
  }
});

app.delete('/api/tasks/:id', async (req, res) => {
  try {
    const tasks = await readTasks();
    const next = tasks.filter((t) => t.id !== req.params.id);
    if (next.length === tasks.length) return res.status(404).json({ error: 'Task not found' });
    await writeTasks(next);
    res.status(204).end();
  } catch {
    res.status(500).json({ error: 'Failed to delete task' });
  }
});

app.delete('/api/tasks', async (req, res) => {
  try {
    if (req.query.completed !== 'true') {
      return res.status(400).json({ error: 'Use ?completed=true to clear completed tasks' });
    }
    const tasks = await readTasks();
    const next = tasks.filter((t) => !t.done);
    await writeTasks(next);
    res.json(next);
  } catch {
    res.status(500).json({ error: 'Failed to clear tasks' });
  }
});

app.listen(PORT, () => {
  console.log(`Todo API listening on http://localhost:${PORT}`);
});
