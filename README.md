# To-Do List (React + Vite + TypeScript)

A to-do list app built with **React**, **Vite**, and **TypeScript**. Tasks are stored in a **local JSON file** via a small **Node/Express** backend (`server/data.json`).

## Features
- Add, complete, and delete tasks
- Filter by All / Active / Completed
- Clear completed tasks
- Persists tasks to `server/data.json` through the backend API

## Requirements
- Node.js + npm

## Setup
```bash
npm install
```

## Run (frontend + backend)
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

## Deploy on Render
This repo includes `render.yaml` and the Express server serves the built Vite frontend in production.

1. Push this repo to GitHub (already set up in this project).
2. In [Render](https://render.com), create a new **Blueprint** and select this repo (or create a **Web Service**).
3. Use these settings if configuring manually:
   - **Build Command:** `npm install && npm run build`
   - **Start Command:** `npm start`
4. Deploy. Render provides `PORT` automatically.

## Notes
- The production server serves the `dist/` frontend and the `/api/*` backend from the same service.
- **Persistence on Render:** tasks are stored in `server/data.json` on the service filesystem. On Render, the filesystem is ephemeral (data can be lost on redeploys/restarts/instance changes). For durable storage, use a database or a Render Persistent Disk and update the server accordingly.
- `server/data.json` is ignored by git (local runtime data). An empty example is in `server/data.example.json`.
