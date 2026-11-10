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
    pool = new Pool({
      connectionString: DATABASE_URL,
      ssl,
      connectionTimeoutMillis: 10000,
      idleTimeoutMillis: 30000,
      max: 10,
    });
  }
  return pool;
}

async function initDb() {
  const db = getPool();
  if (!db) return;
  await db.query('SELECT 1');
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
    CREATE TABLE IF NOT EXISTS teams (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at BIGINT NOT NULL
    )
  `);
  await db.query(`
    CREATE TABLE IF NOT EXISTS team_members (
      team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      role TEXT NOT NULL DEFAULT 'member',
      joined_at BIGINT NOT NULL,
      PRIMARY KEY (team_id, user_id)
    )
  `);
  await db.query(`
    CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY,
      user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
      team_id TEXT REFERENCES teams(id) ON DELETE CASCADE,
      assignee_id TEXT REFERENCES users(id) ON DELETE SET NULL,
      text TEXT NOT NULL,
      done BOOLEAN NOT NULL DEFAULT FALSE,
      created_at BIGINT NOT NULL,
      due_at BIGINT,
      progress INTEGER NOT NULL DEFAULT 0
    )
  `);
  await db.query(`ALTER TABLE tasks ADD COLUMN IF NOT EXISTS user_id TEXT REFERENCES users(id) ON DELETE CASCADE`);
  await db.query(`ALTER TABLE tasks ADD COLUMN IF NOT EXISTS team_id TEXT REFERENCES teams(id) ON DELETE CASCADE`);
  await db.query(`ALTER TABLE tasks ADD COLUMN IF NOT EXISTS assignee_id TEXT REFERENCES users(id) ON DELETE SET NULL`);
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
  await db.query(`CREATE INDEX IF NOT EXISTS tasks_team_id_idx ON tasks(team_id)`);
  await db.query(`CREATE INDEX IF NOT EXISTS team_members_user_id_idx ON team_members(user_id)`);
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
  if (!user) return null;
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

// JSON store fallback
async function readStoreFile() {
  try {
    const raw = await fs.readFile(DATA_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      return { users: [], teams: [], teamMembers: [], tasks: parsed.map((t) => normalizeTask(t, null, null)) };
    }
    return {
      users: Array.isArray(parsed?.users) ? parsed.users : [],
      teams: Array.isArray(parsed?.teams) ? parsed.teams : [],
      teamMembers: Array.isArray(parsed?.teamMembers) ? parsed.teamMembers : [],
      tasks: Array.isArray(parsed?.tasks) ? parsed.tasks.map((t) => normalizeTask(t, t.userId ?? null, t.teamId ?? null)) : [],
    };
  } catch (err) {
    if (err && err.code === 'ENOENT') {
      const empty = { users: [], teams: [], teamMembers: [], tasks: [] };
      await fs.writeFile(DATA_FILE, JSON.stringify(empty, null, 2), 'utf8');
      return empty;
    }
    throw err;
  }
}
async function writeStoreFile(store) {
  await fs.writeFile(DATA_FILE, JSON.stringify({
    users: store.users || [],
    teams: store.teams || [],
    teamMembers: store.teamMembers || [],
    tasks: (store.tasks || []).map((t) => normalizeTask(t, t.userId ?? null, t.teamId ?? null)),
  }, null, 2), 'utf8');
}

function normalizeTask(task, userId, teamId) {
  return {
    id: String(task.id),
    userId: task.userId ?? userId ?? null,
    teamId: task.teamId ?? teamId ?? null,
    assigneeId: task.assigneeId ?? null,
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
    const { rows } = await db.query('SELECT id, name, email, password_hash, created_at FROM users WHERE LOWER(email) = $1', [email]);
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

function rowToUpdate(row) {
  return { id: row.id, taskId: row.task_id, text: row.text, progressAt: clampProgress(row.progress_at, 0), createdAt: Number(row.created_at) };
}

async function attachTaskDetails(rows, dbUsersById = null) {
  // rows from tasks query; for db path enrich with assignee and updates
  return rows;
}

function taskToClient(task, usersById = {}) {
  const assignee = task.assigneeId ? usersById[task.assigneeId] : null;
  return {
    id: task.id,
    text: task.text,
    done: Boolean(task.done),
    createdAt: Number(task.createdAt),
    dueAt: task.dueAt == null ? null : Number(task.dueAt),
    progress: clampProgress(task.progress, 0),
    teamId: task.teamId || null,
    assigneeId: task.assigneeId || null,
    assigneeName: assignee ? assignee.name : (task.assigneeName || null),
    assigneeEmail: assignee ? assignee.email : (task.assigneeEmail || null),
    updates: Array.isArray(task.updates) ? task.updates : [],
  };
}

// Team helpers
async function getMembership(teamId, userId) {
  const db = getPool();
  if (db) {
    const { rows } = await db.query('SELECT team_id, user_id, role, joined_at FROM team_members WHERE team_id = $1 AND user_id = $2', [teamId, userId]);
    return rows[0] || null;
  }
  const store = await readStoreFile();
  return store.teamMembers.find((m) => m.teamId === teamId && m.userId === userId) || null;
}
async function requireTeamMember(req, res, next) {
  const m = await getMembership(req.params.teamId, req.user.id);
  if (!m) return res.status(403).json({ error: 'Not a member of this team' });
  req.membership = m;
  next();
}

async function listTeamsForUser(userId) {
  const db = getPool();
  if (db) {
    const { rows } = await db.query(`
      SELECT t.id, t.name, t.owner_id, t.created_at, tm.role
      FROM teams t
      JOIN team_members tm ON tm.team_id = t.id
      WHERE tm.user_id = $1
      ORDER BY t.created_at DESC
    `, [userId]);
    const teams = [];
    for (const r of rows) {
      const members = await db.query(`
        SELECT u.id, u.name, u.email, tm.role
        FROM team_members tm JOIN users u ON u.id = tm.user_id
        WHERE tm.team_id = $1 ORDER BY tm.joined_at ASC
      `, [r.id]);
      teams.push({ id: r.id, name: r.name, ownerId: r.owner_id, createdAt: Number(r.created_at), role: r.role, members: members.rows.map((m) => ({ id: m.id, name: m.name, email: m.email, role: m.role })) });
    }
    return teams;
  }
  const store = await readStoreFile();
  const my = store.teamMembers.filter((m) => m.userId === userId);
  return my.map((m) => {
    const team = store.teams.find((t) => t.id === m.teamId);
    if (!team) return null;
    const members = store.teamMembers.filter((tm) => tm.teamId === team.id).map((tm) => {
      const u = store.users.find((x) => x.id === tm.userId);
      return u ? { id: u.id, name: u.name, email: u.email, role: tm.role } : null;
    }).filter(Boolean);
    return { id: team.id, name: team.name, ownerId: team.ownerId, createdAt: Number(team.createdAt), role: m.role, members };
  }).filter(Boolean).sort((a, b) => b.createdAt - a.createdAt);
}

async function getTeamForMember(teamId, userId) {
  const teams = await listTeamsForUser(userId);
  return teams.find((t) => t.id === teamId) || null;
}

// Task queries
async function listPersonalTasks(userId) {
  const db = getPool();
  if (db) {
    const tasksRes = await db.query(
      'SELECT id, user_id, team_id, assignee_id, text, done, created_at, due_at, progress FROM tasks WHERE user_id = $1 AND team_id IS NULL ORDER BY created_at DESC',
      [userId]
    );
    const ids = tasksRes.rows.map((r) => r.id);
    let byTask = new Map();
    let usersById = {};
    if (ids.length) {
      const updatesRes = await db.query('SELECT id, task_id, text, progress_at, created_at FROM task_updates WHERE task_id = ANY($1::text[]) ORDER BY created_at DESC', [ids]);
      for (const row of updatesRes.rows) {
        const list = byTask.get(row.task_id) || [];
        list.push(rowToUpdate(row));
        byTask.set(row.task_id, list);
      }
    }
    return tasksRes.rows.map((row) => taskToClient({ id: row.id, userId: row.user_id, teamId: row.team_id, assigneeId: row.assignee_id, text: row.text, done: row.done, createdAt: row.created_at, dueAt: row.due_at, progress: row.progress, updates: byTask.get(row.id) || [] }, usersById));
  }
  const store = await readStoreFile();
  return store.tasks.filter((t) => t.userId === userId && !t.teamId).sort((a, b) => b.createdAt - a.createdAt).map((t) => taskToClient(t, {}));
}

async function listTeamTasks(teamId) {
  const db = getPool();
  if (db) {
    const tasksRes = await db.query(
      'SELECT id, user_id, team_id, assignee_id, text, done, created_at, due_at, progress FROM tasks WHERE team_id = $1 ORDER BY created_at DESC',
      [teamId]
    );
    const ids = tasksRes.rows.map((r) => r.id);
    let byTask = new Map();
    const usersById = {};
    if (ids.length) {
      const updatesRes = await db.query('SELECT id, task_id, text, progress_at, created_at FROM task_updates WHERE task_id = ANY($1::text[]) ORDER BY created_at DESC', [ids]);
      for (const row of updatesRes.rows) {
        const list = byTask.get(row.task_id) || [];
        list.push(rowToUpdate(row));
        byTask.set(row.task_id, list);
      }
    }
    const assigneeIds = [...new Set(tasksRes.rows.map((r) => r.assignee_id).filter(Boolean))];
    if (assigneeIds.length) {
      const ures = await db.query('SELECT id, name, email FROM users WHERE id = ANY($1::text[])', [assigneeIds]);
      for (const u of ures.rows) usersById[u.id] = u;
    }
    return tasksRes.rows.map((row) => taskToClient({ id: row.id, userId: row.user_id, teamId: row.team_id, assigneeId: row.assignee_id, text: row.text, done: row.done, createdAt: Number(row.created_at), dueAt: row.due_at == null ? null : Number(row.due_at), progress: row.progress, updates: byTask.get(row.id) || [] }, usersById));
  }
  const store = await readStoreFile();
  const usersById = Object.fromEntries(store.users.map((u) => [u.id, u]));
  return store.tasks.filter((t) => t.teamId === teamId).sort((a, b) => b.createdAt - a.createdAt).map((t) => taskToClient(t, usersById));
}

function buildTaskPayload({ text, dueAt, progress, teamId, userId, assigneeId }) {
  const p = clampProgress(progress, 0);
  return {
    id: makeId(),
    userId: userId || null,
    teamId: teamId || null,
    assigneeId: assigneeId || null,
    text,
    done: p >= 100,
    createdAt: Date.now(),
    dueAt: normalizeDueAt(dueAt),
    progress: p,
    updates: [],
  };
}

async function resolveAssigneeId(teamId, assigneeEmailOrId) {
  if (!assigneeEmailOrId) return null;
  const val = String(assigneeEmailOrId).trim();
  if (!val) return null;
  // try as email
  const user = val.includes('@') ? await getUserByEmail(normalizeEmail(val)) : await getUserById(val);
  if (!user) return { error: 'No account found for this email' };
  const member = await getMembership(teamId, user.id);
  if (!member) return { error: 'Assignee must be a member of this team' };
  return { id: user.id };
}

async function createPersonalTask(userId, body) {
  const task = buildTaskPayload({ text: body.text, dueAt: body.dueAt, progress: body.progress, teamId: null, userId, assigneeId: null });
  const db = getPool();
  if (db) {
    await db.query(
      'INSERT INTO tasks (id, user_id, team_id, assignee_id, text, done, created_at, due_at, progress) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)',
      [task.id, userId, null, null, task.text, task.done, task.createdAt, task.dueAt, task.progress]
    );
    return taskToClient(task, {});
  }
  const store = await readStoreFile();
  store.tasks.unshift(task);
  await writeStoreFile(store);
  return taskToClient(task, {});
}

async function createTeamTask(teamId, creatorId, body) {
  let assigneeId = null;
  if (body.assigneeEmail || body.assigneeId) {
    const r = await resolveAssigneeId(teamId, body.assigneeEmail || body.assigneeId);
    if (r?.error) return { error: r.error };
    assigneeId = r?.id || null;
  }
  const task = buildTaskPayload({ text: body.text, dueAt: body.dueAt, progress: body.progress, teamId, userId: creatorId, assigneeId });
  const db = getPool();
  if (db) {
    await db.query(
      'INSERT INTO tasks (id, user_id, team_id, assignee_id, text, done, created_at, due_at, progress) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)',
      [task.id, creatorId, teamId, assigneeId, task.text, task.done, task.createdAt, task.dueAt, task.progress]
    );
  } else {
    const store = await readStoreFile();
    store.tasks.unshift(task);
    await writeStoreFile(store);
  }
  const usersById = {};
  if (assigneeId) { const u = await getUserById(assigneeId); if (u) usersById[assigneeId] = publicUser(u); }
  return taskToClient(task, usersById);
}

async function findTaskForUserScope(taskId, userId, teamId = null) {
  const db = getPool();
  if (db) {
    if (teamId) {
      const { rows } = await db.query('SELECT * FROM tasks WHERE id = $1 AND team_id = $2', [taskId, teamId]);
      return rows[0] || null;
    }
    const { rows } = await db.query('SELECT * FROM tasks WHERE id = $1 AND user_id = $2 AND team_id IS NULL', [taskId, userId]);
    return rows[0] || null;
  }
  const store = await readStoreFile();
  if (teamId) return store.tasks.find((t) => t.id === taskId && t.teamId === teamId) || null;
  return store.tasks.find((t) => t.id === taskId && t.userId === userId && !t.teamId) || null;
}

async function enrichTaskRow(row, teamIdContext = null) {
  const db = getPool();
  let updates = [];
  const usersById = {};
  if (db) {
    const ures = await db.query('SELECT id, task_id, text, progress_at, created_at FROM task_updates WHERE task_id = $1 ORDER BY created_at DESC', [row.id]);
    updates = ures.rows.map(rowToUpdate);
    if (row.assignee_id) {
      const a = await db.query('SELECT id, name, email FROM users WHERE id = $1', [row.assignee_id]);
      if (a.rows[0]) usersById[a.rows[0].id] = a.rows[0];
    }
  } else {
    updates = row.updates || [];
  }
  const base = { id: row.id, userId: row.user_id ?? row.userId, teamId: row.team_id ?? row.teamId, assigneeId: row.assignee_id ?? row.assigneeId, text: row.text, done: row.done, createdAt: Number(row.created_at ?? row.createdAt), dueAt: row.due_at ?? row.dueAt, progress: row.progress, updates };
  return taskToClient(base, usersById);
}

async function updateTaskScoped(taskId, scope, body) {
  // scope: { userId, teamId } teamId means team task
  const db = getPool();
  const row = await findTaskForUserScope(taskId, scope.userId, scope.teamId || null);
  if (!row) return null;
  let assigneeId = row.assignee_id ?? row.assigneeId ?? null;
  if (scope.teamId && (Object.prototype.hasOwnProperty.call(body, 'assigneeEmail') || Object.prototype.hasOwnProperty.call(body, 'assigneeId'))) {
    const r = await resolveAssigneeId(scope.teamId, body.assigneeEmail ?? body.assigneeId ?? null);
    if (r?.error) return { error: r.error };
    assigneeId = r ? r.id : null;
  }
  const updates = {};
  if (typeof body.text === 'string') updates.text = body.text.trim();
  if (typeof body.done === 'boolean') updates.done = body.done;
  if (Object.prototype.hasOwnProperty.call(body, 'dueAt')) updates.dueAt = normalizeDueAt(body.dueAt);
  if (typeof body.progress === 'number') updates.progress = clampProgress(body.progress, row.progress);
  if (updates.text === '') return { error: 'Text cannot be empty' };

  if (db) {
    let next = await enrichTaskRow(row);
    // apply
    let text = updates.text ?? row.text;
    let done = typeof updates.done === 'boolean' ? updates.done : Boolean(row.done);
    let dueAt = Object.prototype.hasOwnProperty.call(updates, 'dueAt') ? updates.dueAt : (row.due_at == null ? null : Number(row.due_at));
    let progress = typeof updates.progress === 'number' ? updates.progress : clampProgress(row.progress, 0);
    if (typeof updates.done === 'boolean') { done = updates.done; if (done) progress = 100; else if (progress >= 100 && !Object.prototype.hasOwnProperty.call(updates, 'progress')) progress = 99; }
    if (progress >= 100) done = true;
    await db.query('UPDATE tasks SET text=$1, done=$2, due_at=$3, progress=$4, assignee_id=$5 WHERE id=$6', [text, done, dueAt, progress, assigneeId, taskId]);
    const fresh = await findTaskForUserScope(taskId, scope.userId, scope.teamId || null);
    return await enrichTaskRow(fresh);
  } else {
    const store = await readStoreFile();
    const idx = store.tasks.findIndex((t) => t.id === taskId && (scope.teamId ? t.teamId === scope.teamId : (t.userId === scope.userId && !t.teamId)));
    if (idx === -1) return null;
    let t = { ...store.tasks[idx] };
    if (typeof updates.text === 'string') t.text = updates.text;
    if (Object.prototype.hasOwnProperty.call(updates, 'dueAt')) t.dueAt = updates.dueAt;
    if (typeof updates.progress === 'number') t.progress = updates.progress;
    if (typeof updates.done === 'boolean') { t.done = updates.done; if (t.done) t.progress = 100; else if (t.progress >= 100 && !Object.prototype.hasOwnProperty.call(updates, 'progress')) t.progress = 99; }
    if (t.progress >= 100) t.done = true;
    t.assigneeId = assigneeId;
    store.tasks[idx] = t;
    await writeStoreFile(store);
    const usersById = Object.fromEntries(store.users.map((u) => [u.id, u]));
    return taskToClient(store.tasks[idx], usersById);
  }
}

async function deleteTaskScoped(taskId, scope) {
  const db = getPool();
  if (db) {
    const q = scope.teamId
      ? await db.query('DELETE FROM tasks WHERE id=$1 AND team_id=$2', [taskId, scope.teamId])
      : await db.query('DELETE FROM tasks WHERE id=$1 AND user_id=$2 AND team_id IS NULL', [taskId, scope.userId]);
    return q.rowCount > 0;
  }
  const store = await readStoreFile();
  const before = store.tasks.length;
  store.tasks = store.tasks.filter((t) => !(t.id === taskId && (scope.teamId ? t.teamId === scope.teamId : (t.userId === scope.userId && !t.teamId))));
  if (store.tasks.length === before) return false;
  await writeStoreFile(store);
  return true;
}

async function clearCompletedScoped(scope) {
  const db = getPool();
  if (db) {
    if (scope.teamId) await db.query('DELETE FROM tasks WHERE team_id=$1 AND done=TRUE', [scope.teamId]);
    else await db.query('DELETE FROM tasks WHERE user_id=$1 AND team_id IS NULL AND done=TRUE', [scope.userId]);
    return scope.teamId ? listTeamTasks(scope.teamId) : listPersonalTasks(scope.userId);
  }
  const store = await readStoreFile();
  store.tasks = store.tasks.filter((t) => {
    const inScope = scope.teamId ? t.teamId === scope.teamId : (t.userId === scope.userId && !t.teamId);
    return !(inScope && t.done);
  });
  await writeStoreFile(store);
  return scope.teamId ? listTeamTasks(scope.teamId) : listPersonalTasks(scope.userId);
}

async function addTaskUpdateScoped(taskId, scope, { text, progressAt }) {
  const row = await findTaskForUserScope(taskId, scope.userId, scope.teamId || null);
  if (!row) return null;
  const update = { id: makeId(), taskId, text, progressAt: clampProgress(progressAt, 0), createdAt: Date.now() };
  const db = getPool();
  if (db) {
    await db.query('INSERT INTO task_updates (id, task_id, text, progress_at, created_at) VALUES ($1,$2,$3,$4,$5)', [update.id, update.taskId, update.text, update.progressAt, update.createdAt]);
    await db.query('UPDATE tasks SET progress=$1, done=$2 WHERE id=$3', [update.progressAt, update.progressAt >= 100, taskId]);
    return update;
  }
  const store = await readStoreFile();
  const idx = store.tasks.findIndex((t) => t.id === taskId && (scope.teamId ? t.teamId === scope.teamId : (t.userId === scope.userId && !t.teamId)));
  if (idx === -1) return null;
  store.tasks[idx].updates = [update, ...(store.tasks[idx].updates || [])];
  store.tasks[idx].progress = update.progressAt;
  store.tasks[idx].done = update.progressAt >= 100;
  await writeStoreFile(store);
  return update;
}

// Routes
app.get('/api/health', (_req, res) => res.json({ ok: true }));

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
      await db.query('INSERT INTO users (id, name, email, password_hash, created_at) VALUES ($1,$2,$3,$4,$5)', [user.id, user.name, user.email, user.password_hash, user.created_at]);
    } else {
      const store = await readStoreFile();
      store.users.push(user);
      await writeStoreFile(store);
    }
    const pub = publicUser(user);
    setAuthCookie(res, signToken(pub));
    res.status(201).json({ user: pub });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Failed to create account' }); }
});

app.post('/api/auth/login', async (req, res) => {
  try {
    const email = normalizeEmail(req.body?.email);
    const password = String(req.body?.password || '');
    if (!email || !password) return res.status(400).json({ error: 'Email and password are required' });
    const user = await getUserByEmail(email);
    if (!user || !(await bcrypt.compare(password, user.password_hash))) return res.status(401).json({ error: 'Invalid email or password' });
    const pub = publicUser(user);
    setAuthCookie(res, signToken(pub));
    res.json({ user: pub });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Failed to sign in' }); }
});

app.post('/api/auth/logout', (_req, res) => { clearAuthCookie(res); res.status(204).end(); });

app.get('/api/auth/me', async (req, res) => {
  try {
    const token = req.cookies?.[COOKIE_NAME];
    if (!token) return res.status(401).json({ error: 'Not authenticated' });
    const payload = jwt.verify(token, JWT_SECRET);
    const user = await getUserById(payload.sub);
    if (!user) { clearAuthCookie(res); return res.status(401).json({ error: 'Not authenticated' }); }
    res.json({ user: publicUser(user) });
  } catch { clearAuthCookie(res); res.status(401).json({ error: 'Not authenticated' }); }
});

// Teams
app.get('/api/teams', authRequired, async (req, res) => {
  try { res.json(await listTeamsForUser(req.user.id)); }
  catch (err) { console.error(err); res.status(500).json({ error: 'Failed to load teams' }); }
});

app.post('/api/teams', authRequired, async (req, res) => {
  try {
    const name = String(req.body?.name || '').trim();
    if (!name) return res.status(400).json({ error: 'Team name is required' });
    const team = { id: makeId(), name, ownerId: req.user.id, createdAt: Date.now() };
    const member = { teamId: team.id, userId: req.user.id, role: 'owner', joinedAt: Date.now() };
    const db = getPool();
    if (db) {
      await db.query('INSERT INTO teams (id, name, owner_id, created_at) VALUES ($1,$2,$3,$4)', [team.id, team.name, team.ownerId, team.createdAt]);
      await db.query('INSERT INTO team_members (team_id, user_id, role, joined_at) VALUES ($1,$2,$3,$4)', [member.teamId, member.userId, member.role, member.joinedAt]);
    } else {
      const store = await readStoreFile();
      store.teams.push(team);
      store.teamMembers.push(member);
      await writeStoreFile(store);
    }
    res.status(201).json(await getTeamForMember(team.id, req.user.id));
  } catch (err) { console.error(err); res.status(500).json({ error: 'Failed to create team' }); }
});

app.get('/api/teams/:teamId', authRequired, requireTeamMember, async (req, res) => {
  try { res.json(await getTeamForMember(req.params.teamId, req.user.id)); }
  catch (err) { console.error(err); res.status(500).json({ error: 'Failed to load team' }); }
});

app.post('/api/teams/:teamId/members', authRequired, requireTeamMember, async (req, res) => {
  try {
    // allow owner (and members in collaborative mode) to add; keeping permissive for "members collaborate"
    const email = normalizeEmail(req.body?.email);
    if (!email) return res.status(400).json({ error: 'Email is required' });
    const user = await getUserByEmail(email);
    if (!user) return res.status(404).json({ error: 'No account found for this email. The person must sign up first.' });
    const existing = await getMembership(req.params.teamId, user.id);
    if (existing) return res.status(409).json({ error: 'This user is already a member of the team' });
    const member = { teamId: req.params.teamId, userId: user.id, role: 'member', joinedAt: Date.now() };
    const db = getPool();
    if (db) {
      await db.query('INSERT INTO team_members (team_id, user_id, role, joined_at) VALUES ($1,$2,$3,$4)', [member.teamId, member.userId, member.role, member.joinedAt]);
    } else {
      const store = await readStoreFile();
      store.teamMembers.push(member);
      await writeStoreFile(store);
    }
    res.status(201).json(await getTeamForMember(req.params.teamId, req.user.id));
  } catch (err) { console.error(err); res.status(500).json({ error: 'Failed to add member' }); }
});

// Personal tasks
app.get('/api/tasks', authRequired, async (req, res) => {
  try { res.json(await listPersonalTasks(req.user.id)); }
  catch (err) { console.error(err); res.status(500).json({ error: 'Failed to read tasks' }); }
});
app.post('/api/tasks', authRequired, async (req, res) => {
  try {
    const text = typeof req.body?.text === 'string' ? req.body.text.trim() : '';
    if (!text) return res.status(400).json({ error: 'Text is required' });
    res.status(201).json(await createPersonalTask(req.user.id, { text, dueAt: req.body?.dueAt, progress: req.body?.progress }));
  } catch (err) { console.error(err); res.status(500).json({ error: 'Failed to create task' }); }
});
app.patch('/api/tasks/:id', authRequired, async (req, res) => {
  try {
    const updates = { ...req.body };
    if (typeof updates.text === 'string') updates.text = updates.text.trim();
    if (updates.text === '') return res.status(400).json({ error: 'Text cannot be empty' });
    const task = await updateTaskScoped(req.params.id, { userId: req.user.id }, updates);
    if (!task) return res.status(404).json({ error: 'Task not found' });
    if (task.error) return res.status(400).json({ error: task.error });
    res.json(task);
  } catch (err) { console.error(err); res.status(500).json({ error: 'Failed to update task' }); }
});
app.delete('/api/tasks/:id', authRequired, async (req, res) => {
  try {
    const ok = await deleteTaskScoped(req.params.id, { userId: req.user.id });
    if (!ok) return res.status(404).json({ error: 'Task not found' });
    res.status(204).end();
  } catch (err) { console.error(err); res.status(500).json({ error: 'Failed to delete task' }); }
});
app.delete('/api/tasks', authRequired, async (req, res) => {
  try {
    if (req.query.completed !== 'true') return res.status(400).json({ error: 'Use ?completed=true to clear completed tasks' });
    res.json(await clearCompletedScoped({ userId: req.user.id }));
  } catch (err) { console.error(err); res.status(500).json({ error: 'Failed to clear tasks' }); }
});
app.post('/api/tasks/:id/updates', authRequired, async (req, res) => {
  try {
    const text = typeof req.body?.text === 'string' ? req.body.text.trim() : '';
    if (!text) return res.status(400).json({ error: 'Update text is required' });
    const update = await addTaskUpdateScoped(req.params.id, { userId: req.user.id }, { text, progressAt: req.body?.progressAt });
    if (!update) return res.status(404).json({ error: 'Task not found' });
    res.status(201).json(update);
  } catch (err) { console.error(err); res.status(500).json({ error: 'Failed to add update' }); }
});

// Team tasks
app.get('/api/teams/:teamId/tasks', authRequired, requireTeamMember, async (req, res) => {
  try { res.json(await listTeamTasks(req.params.teamId)); }
  catch (err) { console.error(err); res.status(500).json({ error: 'Failed to read team tasks' }); }
});
app.post('/api/teams/:teamId/tasks', authRequired, requireTeamMember, async (req, res) => {
  try {
    const text = typeof req.body?.text === 'string' ? req.body.text.trim() : '';
    if (!text) return res.status(400).json({ error: 'Text is required' });
    const task = await createTeamTask(req.params.teamId, req.user.id, { text, dueAt: req.body?.dueAt, progress: req.body?.progress, assigneeEmail: req.body?.assigneeEmail, assigneeId: req.body?.assigneeId });
    if (task?.error) return res.status(400).json({ error: task.error });
    res.status(201).json(task);
  } catch (err) { console.error(err); res.status(500).json({ error: 'Failed to create team task' }); }
});
app.patch('/api/teams/:teamId/tasks/:id', authRequired, requireTeamMember, async (req, res) => {
  try {
    const updates = { ...req.body };
    if (typeof updates.text === 'string') updates.text = updates.text.trim();
    if (updates.text === '') return res.status(400).json({ error: 'Text cannot be empty' });
    const task = await updateTaskScoped(req.params.id, { userId: req.user.id, teamId: req.params.teamId }, updates);
    if (!task) return res.status(404).json({ error: 'Task not found' });
    if (task.error) return res.status(400).json({ error: task.error });
    res.json(task);
  } catch (err) { console.error(err); res.status(500).json({ error: 'Failed to update team task' }); }
});
app.delete('/api/teams/:teamId/tasks/:id', authRequired, requireTeamMember, async (req, res) => {
  try {
    const ok = await deleteTaskScoped(req.params.id, { userId: req.user.id, teamId: req.params.teamId });
    if (!ok) return res.status(404).json({ error: 'Task not found' });
    res.status(204).end();
  } catch (err) { console.error(err); res.status(500).json({ error: 'Failed to delete team task' }); }
});
app.delete('/api/teams/:teamId/tasks', authRequired, requireTeamMember, async (req, res) => {
  try {
    if (req.query.completed !== 'true') return res.status(400).json({ error: 'Use ?completed=true to clear completed tasks' });
    res.json(await clearCompletedScoped({ userId: req.user.id, teamId: req.params.teamId }));
  } catch (err) { console.error(err); res.status(500).json({ error: 'Failed to clear team tasks' }); }
});
app.post('/api/teams/:teamId/tasks/:id/updates', authRequired, requireTeamMember, async (req, res) => {
  try {
    const text = typeof req.body?.text === 'string' ? req.body.text.trim() : '';
    if (!text) return res.status(400).json({ error: 'Update text is required' });
    const update = await addTaskUpdateScoped(req.params.id, { userId: req.user.id, teamId: req.params.teamId }, { text, progressAt: req.body?.progressAt });
    if (!update) return res.status(404).json({ error: 'Task not found' });
    res.status(201).json(update);
  } catch (err) { console.error(err); res.status(500).json({ error: 'Failed to add update' }); }
});

// Static frontend
app.use(express.static(DIST_DIR));
app.use(async (req, res, next) => {
  if (req.method !== 'GET' || req.path.startsWith('/api')) return next();
  try {
    await fs.access(path.join(DIST_DIR, 'index.html'));
    res.sendFile(path.join(DIST_DIR, 'index.html'));
  } catch { next(); }
});

async function start() {
  try {
    await initDb();
    if (DATABASE_URL) console.log('Using Postgres storage (DATABASE_URL).');
    else console.log('DATABASE_URL not set; using local JSON file storage (server/data.json).');
    if (!process.env.JWT_SECRET) console.warn('JWT_SECRET not set; using insecure development fallback.');
    app.listen(PORT, () => console.log(`Server listening on http://localhost:${PORT}`));
  } catch (err) {
    console.error('Failed to start server:', err);
    process.exit(1);
  }
}

start();
