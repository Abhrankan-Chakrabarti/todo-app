import { useEffect, useMemo, useState } from 'react'
import type { FormEvent } from 'react'
import './App.css'

type User = { id: string; name: string; email: string }
type Member = { id: string; name: string; email: string; role: string }
type Team = { id: string; name: string; ownerId: string; createdAt: number; role: string; members: Member[] }
type TaskUpdate = { id: string; taskId: string; text: string; progressAt: number; createdAt: number }
type Task = {
  id: string; text: string; done: boolean; createdAt: number; dueAt: number | null; progress: number;
  teamId: string | null; assigneeId: string | null; assigneeName: string | null; assigneeEmail: string | null;
  updates: TaskUpdate[]
}
type Filter = 'all' | 'pending' | 'overdue' | 'completed'
type View = { kind: 'personal' } | { kind: 'team'; teamId: string }

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    credentials: 'include',
    headers: { 'Content-Type': 'application/json', ...(init?.headers || {}) },
    ...init,
  })
  if (!res.ok) {
    let message = 'Request failed'
    try { const data = (await res.json()) as { error?: string }; if (data?.error) message = data.error } catch {}
    const err = new Error(message) as Error & { status?: number }
    err.status = res.status
    throw err
  }
  if (res.status === 204) return undefined as T
  return (await res.json()) as T
}

function fromDateTimeLocal(value: string): number | null {
  if (!value) return null
  const ms = new Date(value).getTime()
  return Number.isFinite(ms) ? ms : null
}
function formatDateTime(ms: number): string {
  return new Date(ms).toLocaleString(undefined, { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' })
}
function formatTime(ms: number): string {
  return new Date(ms).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
}
function startOfDay(d: Date): Date { const x = new Date(d); x.setHours(0, 0, 0, 0); return x }
function dueLabel(dueAt: number | null, done: boolean): { text: string; tone: string } | null {
  if (dueAt == null) return null
  if (done) return { text: `Due ${formatDateTime(dueAt)}`, tone: 'done' }
  const now = new Date(); const due = new Date(dueAt); const diffMs = dueAt - now.getTime()
  if (diffMs < 0) return { text: `Overdue · ${formatDateTime(dueAt)}`, tone: 'overdue' }
  const dayDiff = Math.round((startOfDay(due).getTime() - startOfDay(now).getTime()) / 86400000)
  const time = formatTime(dueAt)
  if (dayDiff === 0) return { text: `Due today at ${time}`, tone: 'soon' }
  if (dayDiff === 1) return { text: `Due tomorrow at ${time}`, tone: 'soon' }
  if (dayDiff > 1 && dayDiff <= 7) return { text: `Due in ${dayDiff} days · ${formatDateTime(dueAt)}`, tone: 'normal' }
  return { text: `Due ${formatDateTime(dueAt)}`, tone: 'normal' }
}
function normalizeTask(t: Partial<Task>): Task {
  return {
    id: String(t.id ?? ''), text: String(t.text ?? ''), done: Boolean(t.done), createdAt: Number(t.createdAt) || Date.now(),
    dueAt: t.dueAt == null ? null : Number(t.dueAt), progress: Math.max(0, Math.min(100, Number(t.progress) || 0)),
    teamId: t.teamId ?? null, assigneeId: t.assigneeId ?? null, assigneeName: t.assigneeName ?? null, assigneeEmail: t.assigneeEmail ?? null,
    updates: Array.isArray(t.updates) ? (t.updates as TaskUpdate[]) : [],
  }
}

function AuthScreen({ onAuth }: { onAuth: (user: User) => void }) {
  const [mode, setMode] = useState<'signin' | 'create'>('signin')
  const [name, setName] = useState(''); const [email, setEmail] = useState(''); const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null); const [submitting, setSubmitting] = useState(false)

  async function submit(e: FormEvent) {
    e.preventDefault(); setError(null); setSubmitting(true)
    try {
      const path = mode === 'create' ? '/api/auth/register' : '/api/auth/login'
      const body = mode === 'create' ? { name, email, password } : { email, password }
      const data = await api<{ user: User }>(path, { method: 'POST', body: JSON.stringify(body) })
      onAuth(data.user)
    } catch (e) { setError(e instanceof Error ? e.message : 'Authentication failed') }
    finally { setSubmitting(false) }
  }

  return (
    <main className="app auth-app">
      <h1>To-Do List</h1>
      <p className="subtitle">Sign in to access your personal and team tasks.</p>
      <div className="auth-tabs">
        <button type="button" className={mode === 'signin' ? 'filter-btn active' : 'filter-btn'} onClick={() => { setMode('signin'); setError(null) }}>Sign In</button>
        <button type="button" className={mode === 'create' ? 'filter-btn active' : 'filter-btn'} onClick={() => { setMode('create'); setError(null) }}>Create Account</button>
      </div>
      <form className="auth-form" onSubmit={submit}>
        {mode === 'create' && <label className="field"><span>Name</span><input type="text" value={name} onChange={(e) => setName(e.target.value)} required /></label>}
        <label className="field"><span>Email</span><input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required /></label>
        <label className="field"><span>Password</span><input type="password" value={password} onChange={(e) => setPassword(e.target.value)} required minLength={mode === 'create' ? 6 : undefined} /></label>
        {error && <p className="error" role="alert">{error}</p>}
        <button className="btn-primary" type="submit" disabled={submitting}>{submitting ? 'Please wait…' : mode === 'create' ? 'Create Account' : 'Sign In'}</button>
      </form>
    </main>
  )
}

function TaskPanel({ view, team, onTeamsChanged }: { view: View; team: Team | null; onTeamsChanged: () => void }) {
  const isTeam = view.kind === 'team'
  const base = isTeam ? `/api/teams/${view.teamId}/tasks` : '/api/tasks'
  const [tasks, setTasks] = useState<Task[]>([])
  const [input, setInput] = useState(''); const [dueInput, setDueInput] = useState(''); const [progressInput, setProgressInput] = useState(0)
  const [assigneeEmail, setAssigneeEmail] = useState('')
  const [filter, setFilter] = useState<Filter>('all')
  const [loading, setLoading] = useState(true); const [error, setError] = useState<string | null>(null)
  const [openTaskId, setOpenTaskId] = useState<string | null>(null)
  const [updateText, setUpdateText] = useState<Record<string, string>>({})
  const [updateProgress, setUpdateProgress] = useState<Record<string, number>>({})
  const [memberEmail, setMemberEmail] = useState(''); const [memberMsg, setMemberMsg] = useState<string | null>(null); const [memberErr, setMemberErr] = useState<string | null>(null)

  async function load() {
    setLoading(true); setError(null)
    try {
      const data = await api<Task[]>(base)
      setTasks(Array.isArray(data) ? data.map(normalizeTask) : [])
    } catch (e) { setError(e instanceof Error ? e.message : 'Failed to load tasks') }
    finally { setLoading(false) }
  }

  useEffect(() => { setFilter('all'); setOpenTaskId(null); load() }, [base])

  const visible = useMemo(() => {
    const now = Date.now()
    if (filter === 'pending') return tasks.filter((t) => !t.done && !(t.dueAt != null && t.dueAt < now))
    if (filter === 'overdue') return tasks.filter((t) => !t.done && t.dueAt != null && t.dueAt < now)
    if (filter === 'completed') return tasks.filter((t) => t.done)
    return tasks
  }, [tasks, filter])
  const remaining = tasks.filter((t) => !t.done).length

  async function onAdd(e: FormEvent) {
    e.preventDefault(); const text = input.trim(); if (!text) return
    setError(null)
    try {
      const body: Record<string, unknown> = { text, dueAt: fromDateTimeLocal(dueInput), progress: progressInput }
      if (isTeam && assigneeEmail) body.assigneeEmail = assigneeEmail
      const task = await api<Task>(base, { method: 'POST', body: JSON.stringify(body) })
      setTasks((prev) => [normalizeTask(task), ...prev])
      setInput(''); setDueInput(''); setProgressInput(0); setAssigneeEmail('')
    } catch (e) { setError(e instanceof Error ? e.message : 'Failed to add task') }
  }
  async function patchTask(id: string, body: Record<string, unknown>) {
    setError(null)
    try {
      const updated = await api<Task>(`${base}/${id}`, { method: 'PATCH', body: JSON.stringify(body) })
      const task = normalizeTask(updated)
      setTasks((prev) => prev.map((t) => (t.id === task.id ? task : t)))
    } catch (e) { setError(e instanceof Error ? e.message : 'Failed to update task') }
  }
  async function onDelete(id: string) {
    setError(null)
    try { await api<void>(`${base}/${id}`, { method: 'DELETE' }); setTasks((prev) => prev.filter((t) => t.id !== id)) }
    catch (e) { setError(e instanceof Error ? e.message : 'Failed to delete task') }
  }
  async function onClearCompleted() {
    setError(null)
    try { const next = await api<Task[]>(`${base}?completed=true`, { method: 'DELETE' }); setTasks(Array.isArray(next) ? next.map(normalizeTask) : []) }
    catch (e) { setError(e instanceof Error ? e.message : 'Failed to clear completed tasks') }
  }
  async function onAddUpdate(task: Task) {
    const text = (updateText[task.id] || '').trim(); if (!text) return
    setError(null)
    try {
      await api<TaskUpdate>(`${base}/${task.id}/updates`, { method: 'POST', body: JSON.stringify({ text, progressAt: updateProgress[task.id] ?? task.progress }) })
      setUpdateText((prev) => ({ ...prev, [task.id]: '' }))
      await load()
    } catch (e) { setError(e instanceof Error ? e.message : 'Failed to add update') }
  }
  async function addMember(e: FormEvent) {
    e.preventDefault(); if (!team) return
    setMemberErr(null); setMemberMsg(null)
    try {
      await api<Team>(`/api/teams/${team.id}/members`, { method: 'POST', body: JSON.stringify({ email: memberEmail }) })
      setMemberMsg('Member added.')
      setMemberEmail('')
      onTeamsChanged()
    } catch (e) { setMemberErr(e instanceof Error ? e.message : 'Failed to add member') }
  }

  return (
    <section className="main-panel">
      <div className="panel-head">
        <div>
          <h1>{isTeam ? team?.name || 'Team' : 'My Tasks'}</h1>
          <p className="subtitle">{isTeam ? 'Shared team workspace — everyone can monitor and update team tasks.' : 'Your personal tasks (private).'}</p>
        </div>
      </div>

      {isTeam && team && (
        <div className="team-card">
          <div className="team-card-head">
            <strong>Team members</strong>
            <span className="meta">{team.members.length} member{team.members.length === 1 ? '' : 's'}</span>
          </div>
          <ul className="members-list">
            {team.members.map((m) => (
              <li key={m.id}><span className="member-name">{m.name}</span> <span className="member-email">{m.email}</span> <span className="role-pill">{m.role}</span></li>
            ))}
          </ul>
          <form className="inline-form" onSubmit={addMember}>
            <input type="email" value={memberEmail} onChange={(e) => setMemberEmail(e.target.value)} placeholder="Add member by registered email" required />
            <button type="submit" className="btn-primary">Add member</button>
          </form>
          {memberMsg && <p className="success">{memberMsg}</p>}
          {memberErr && <p className="error" role="alert">{memberErr}</p>}
        </div>
      )}

      <form className="add-form" onSubmit={onAdd}>
        <input type="text" value={input} onChange={(e) => setInput(e.target.value)} placeholder={isTeam ? 'Add a team task…' : 'What needs to be done?'} aria-label="New task" className="task-input" />
        <div className="add-grid">
          <label className="field"><span>Deadline (optional)</span><input type="datetime-local" value={dueInput} onChange={(e) => setDueInput(e.target.value)} /></label>
          <label className="field"><span>Progress: {progressInput}%</span><input type="range" min={0} max={100} value={progressInput} onChange={(e) => setProgressInput(Number(e.target.value))} /></label>
          {isTeam && team && (
            <label className="field"><span>Assign to (optional)</span>
              <select value={assigneeEmail} onChange={(e) => setAssigneeEmail(e.target.value)}>
                <option value="">Unassigned</option>
                {team.members.map((m) => <option key={m.id} value={m.email}>{m.name} ({m.email})</option>)}
              </select>
            </label>
          )}
        </div>
        <button className="btn-primary" type="submit">Add task</button>
      </form>

      {error && <p className="error" role="alert">{error}</p>}

      <div className="toolbar">
        <div className="filters">
          {(['all', 'pending', 'overdue', 'completed'] as const).map((f) => (
            <button key={f} type="button" className={filter === f ? 'filter-btn active' : 'filter-btn'} onClick={() => setFilter(f)}>{f[0].toUpperCase() + f.slice(1)}</button>
          ))}
        </div>
        <div className="meta">{remaining} {remaining === 1 ? 'task' : 'tasks'} left</div>
      </div>

      {loading ? <p className="empty">Loading…</p> : visible.length === 0 ? (
        <p className="empty">{tasks.length ? 'No tasks in this view.' : 'No tasks yet. Add one above.'}</p>
      ) : (
        <ul className="list">
          {visible.map((task) => {
            const due = dueLabel(task.dueAt, task.done)
            const open = openTaskId === task.id
            return (
              <li key={task.id} className="item">
                <div className="item-main">
                  <input type="checkbox" checked={task.done} onChange={() => patchTask(task.id, { done: !task.done })} aria-label="Mark task complete" />
                  <div className="item-body">
                    <div className="item-title-row">
                      <span className={task.done ? 'task-text done' : 'task-text'}>{task.text}</span>
                      <span className="progress-pill">{task.progress}%</span>
                    </div>
                    <div className="progress-bar"><div className="progress-fill" style={{ width: `${task.progress}%` }} /></div>
                    <div className="item-meta">
                      {isTeam && <span className="assignee">Assigned to: {task.assigneeName ? `${task.assigneeName} (${task.assigneeEmail})` : 'Unassigned'}</span>}
                      {due && <span className={`due due-${due.tone}`}>{due.text}</span>}
                      <button type="button" className="small-btn" onClick={() => { setOpenTaskId(open ? null : task.id); setUpdateProgress((p) => ({ ...p, [task.id]: p[task.id] ?? task.progress })) }}>
                        {open ? 'Hide updates' : `Updates (${task.updates?.length || 0})`}
                      </button>
                    </div>
                    <label className="inline-progress"><span>Adjust progress</span><input type="range" min={0} max={100} value={task.progress} onChange={(e) => patchTask(task.id, { progress: Number(e.target.value) })} /></label>
                    {isTeam && team && (
                      <label className="inline-progress"><span>Assign</span>
                        <select value={task.assigneeEmail || ''} onChange={(e) => patchTask(task.id, { assigneeEmail: e.target.value || null })}>
                          <option value="">Unassigned</option>
                          {team.members.map((m) => <option key={m.id} value={m.email}>{m.name} ({m.email})</option>)}
                        </select>
                      </label>
                    )}
                  </div>
                  <button type="button" className="delete-btn" onClick={() => onDelete(task.id)}>Delete</button>
                </div>
                {open && (
                  <div className="updates">
                    <form className="update-form" onSubmit={(e) => { e.preventDefault(); onAddUpdate(task) }}>
                      <label className="field"><span>Progress update</span><input type="text" value={updateText[task.id] || ''} onChange={(e) => setUpdateText((p) => ({ ...p, [task.id]: e.target.value }))} placeholder="e.g., 35% completed — milestone note" /></label>
                      <label className="field"><span>Checkpoint: {updateProgress[task.id] ?? task.progress}%</span><input type="range" min={0} max={100} value={updateProgress[task.id] ?? task.progress} onChange={(e) => setUpdateProgress((p) => ({ ...p, [task.id]: Number(e.target.value) }))} /></label>
                      <button type="submit" className="btn-primary">Post update</button>
                    </form>
                    <div className="updates-list">
                      {(task.updates || []).length === 0 ? <p className="empty small">No milestone updates yet.</p> : (
                        <ul>{task.updates.map((u) => (<li key={u.id} className="update-item"><div className="update-head"><strong>{u.progressAt}%</strong><span>{formatDateTime(u.createdAt)}</span></div><div>{u.text}</div></li>))}</ul>
                      )}
                    </div>
                  </div>
                )}
              </li>
            )
          })}
        </ul>
      )}

      <div className="footer"><button type="button" className="link-btn" onClick={onClearCompleted}>Clear completed</button></div>
    </section>
  )
}

function Workspace({ user, onLogout }: { user: User; onLogout: () => void }) {
  const [teams, setTeams] = useState<Team[]>([])
  const [view, setView] = useState<View>({ kind: 'personal' })
  const [teamName, setTeamName] = useState(''); const [teamErr, setTeamErr] = useState<string | null>(null)

  async function loadTeams() {
    try { const data = await api<Team[]>('/api/teams'); setTeams(Array.isArray(data) ? data : []) }
    catch { /* ignore */ }
  }
  useEffect(() => { loadTeams() }, [])

  const selectedTeam = view.kind === 'team' ? teams.find((t) => t.id === view.teamId) || null : null

  async function createTeam(e: FormEvent) {
    e.preventDefault(); setTeamErr(null)
    const name = teamName.trim(); if (!name) return
    try {
      const team = await api<Team>('/api/teams', { method: 'POST', body: JSON.stringify({ name }) })
      setTeamName('')
      await loadTeams()
      setView({ kind: 'team', teamId: team.id })
    } catch (e) { setTeamErr(e instanceof Error ? e.message : 'Failed to create team') }
  }

  async function logout() { try { await api<void>('/api/auth/logout', { method: 'POST' }) } catch {} onLogout() }

  return (
    <div className="layout">
      <aside className="sidebar">
        <div className="sidebar-top">
          <div className="sidebar-user"><strong>{user.name}</strong><span>{user.email}</span></div>
          <button type="button" className="small-btn" onClick={logout}>Sign out</button>
        </div>
        <nav className="nav">
          <button type="button" className={view.kind === 'personal' ? 'nav-item active' : 'nav-item'} onClick={() => setView({ kind: 'personal' })}>My Tasks</button>
          <div className="nav-section">Teams</div>
          {teams.map((t) => (
            <button key={t.id} type="button" className={view.kind === 'team' && view.teamId === t.id ? 'nav-item active' : 'nav-item'} onClick={() => setView({ kind: 'team', teamId: t.id })}>
              {t.name}
            </button>
          ))}
        </nav>
        <form className="create-team" onSubmit={createTeam}>
          <label className="field"><span>Create team</span><input type="text" value={teamName} onChange={(e) => setTeamName(e.target.value)} placeholder="Team name (e.g., samagra)" /></label>
          {teamErr && <p className="error">{teamErr}</p>}
          <button type="submit" className="btn-primary">Create team</button>
        </form>
      </aside>
      <main className="content">
        <TaskPanel key={view.kind === 'team' ? `team:${view.teamId}` : 'personal'} view={view} team={selectedTeam} onTeamsChanged={loadTeams} />
      </main>
    </div>
  )
}

function App() {
  const [user, setUser] = useState<User | null>(null)
  const [checking, setChecking] = useState(true)
  useEffect(() => {
    let cancelled = false
    api<{ user: User }>('/api/auth/me')
      .then((d) => { if (!cancelled) setUser(d.user) })
      .catch(() => { if (!cancelled) setUser(null) })
      .finally(() => { if (!cancelled) setChecking(false) })
    return () => { cancelled = true }
  }, [])
  if (checking) return <main className="app"><p className="empty">Loading…</p></main>
  if (!user) return <AuthScreen onAuth={setUser} />
  return <Workspace user={user} onLogout={() => setUser(null)} />
}

export default App
