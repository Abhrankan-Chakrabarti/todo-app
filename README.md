# To-Do List (React + Vite + TypeScript)

A to-do list app built with **React**, **Vite**, and **TypeScript**. Tasks are stored in **Render Postgres** when `DATABASE_URL` is set (recommended for Render), with a local JSON-file fallback (`server/data.json`) when it is not.

## Features
- Add, complete, and delete tasks
- Optional deadlines (date & time) with relative due labels (e.g., overdue, due tomorrow)
- Task progress (0–100%) with a progress bar/slider
- Timestamped milestone/progress updates per task (with progress checkpoints)
- Filter by All / Active / Completed
- Clear completed tasks
- Durable storage on Render via Postgres (`DATABASE_URL`)

## Requirements
- Node.js + npm
- Optional for local dev: a Postgres database (`DATABASE_URL`), otherwise local JSON fallback is used

## Setup
```bash
npm install
```

## Run locally (frontend + backend)
```bash
npm run dev:all
```
- Frontend (Vite): http://localhost:5173
- Backend API: http://localhost:3001 (`/api/tasks`)

You can also run them separately:
```bash
npm run server
npm run dev
```

## Build
```bash
npm run build
npm run preview
```

## Deploy on Render (data preserved)
This repo includes `render.yaml` to provision a web service and a Postgres database.

1. Push this repo to GitHub.
2. In [Render](https://render.com), create a new **Blueprint** and select this repo. The blueprint creates/links `todo-db` and sets `DATABASE_URL` for the web service.
3. If you deploy manually (without the blueprint), create a **Postgres** instance and a **Web Service**, then add an environment variable:
   - `DATABASE_URL` = your Render Postgres connection string
4. Web Service settings (manual):
   - **Build Command:** `npm install && npm run build`
   - **Start Command:** `npm start`

The server creates the `tasks` table automatically on startup.

## Notes
- **Data preservation:** with `DATABASE_URL` configured, tasks are stored in Postgres and preserved across deploys/restarts.
- Without `DATABASE_URL`, the server falls back to `server/data.json` (local/dev use; not durable on Render).
- The production server serves the `dist/` frontend and the `/api/*` backend from the same service.
- `server/data.json` is ignored by git. An empty example is in `server/data.example.json`.
