import { useEffect, useMemo, useState } from 'react'
import type { FormEvent } from 'react'
import './App.css'

type Task = {
  id: string
  text: string
  done: boolean
  createdAt: number
}

type Filter = 'all' | 'active' | 'completed'

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json', ...(init?.headers || {}) },
    ...init,
  })
  if (!res.ok) {
    let message = 'Request failed'
    try {
      const data = (await res.json()) as { error?: string }
      if (data?.error) message = data.error
    } catch {
      /* ignore */
    }
    throw new Error(message)
  }
  if (res.status === 204) return undefined as T
  return (await res.json()) as T
}

function App() {
  const [tasks, setTasks] = useState<Task[]>([])
  const [input, setInput] = useState('')
  const [filter, setFilter] = useState<Filter>('all')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    api<Task[]>('/api/tasks')
      .then((data) => {
        if (!cancelled) setTasks(Array.isArray(data) ? data : [])
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(e instanceof Error ? e.message : 'Failed to load tasks')
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [])

  const visible = useMemo(() => {
    if (filter === 'active') return tasks.filter((t) => !t.done)
    if (filter === 'completed') return tasks.filter((t) => t.done)
    return tasks
  }, [tasks, filter])

  const remaining = tasks.filter((t) => !t.done).length

  async function onAdd(e: FormEvent) {
    e.preventDefault()
    const text = input.trim()
    if (!text) return
    setError(null)
    try {
      const task = await api<Task>('/api/tasks', {
        method: 'POST',
        body: JSON.stringify({ text }),
      })
      setTasks((prev) => [task, ...prev])
      setInput('')
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to add task')
    }
  }

  async function onToggle(task: Task) {
    setError(null)
    try {
      const updated = await api<Task>(`/api/tasks/${task.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ done: !task.done }),
      })
      setTasks((prev) => prev.map((t) => (t.id === updated.id ? updated : t)))
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to update task')
    }
  }

  async function onDelete(id: string) {
    setError(null)
    try {
      await api<void>(`/api/tasks/${id}`, { method: 'DELETE' })
      setTasks((prev) => prev.filter((t) => t.id !== id))
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to delete task')
    }
  }

  async function onClearCompleted() {
    setError(null)
    try {
      const next = await api<Task[]>('/api/tasks?completed=true', { method: 'DELETE' })
      setTasks(next)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to clear completed tasks')
    }
  }

  return (
    <main className="app">
      <h1>To-Do List</h1>
      <p className="subtitle">React + Vite + TypeScript, with tasks saved to the backend (Postgres when configured).</p>

      <form className="row" onSubmit={onAdd}>
        <input
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="What needs to be done?"
          aria-label="New task"
        />
        <button className="btn-primary" type="submit">
          Add
        </button>
      </form>

      {error && <p className="error" role="alert">{error}</p>}

      <div className="toolbar">
        <div className="filters" role="tablist" aria-label="Filters">
          {(['all', 'active', 'completed'] as const).map((f) => (
            <button
              key={f}
              type="button"
              className={filter === f ? 'filter-btn active' : 'filter-btn'}
              onClick={() => setFilter(f)}
            >
              {f[0].toUpperCase() + f.slice(1)}
            </button>
          ))}
        </div>
        <div className="meta">{remaining} {remaining === 1 ? 'task' : 'tasks'} left</div>
      </div>

      {loading ? (
        <p className="empty">Loading…</p>
      ) : visible.length === 0 ? (
        <p className="empty">{tasks.length ? 'No tasks in this view.' : 'No tasks yet. Add one above.'}</p>
      ) : (
        <ul className="list">
          {visible.map((task) => (
            <li key={task.id} className="item">
              <input
                type="checkbox"
                checked={task.done}
                onChange={() => onToggle(task)}
                aria-label="Mark task complete"
              />
              <span className={task.done ? 'task-text done' : 'task-text'}>{task.text}</span>
              <button type="button" className="delete-btn" onClick={() => onDelete(task.id)}>
                Delete
              </button>
            </li>
          ))}
        </ul>
      )}

      <div className="footer">
        <button type="button" className="link-btn" onClick={onClearCompleted}>
          Clear completed
        </button>
      </div>
    </main>
  )
}

export default App
