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

## Notes
- This app requires the backend for task storage, so a static host like GitHub Pages cannot serve the full app functionality.
- `server/data.json` is ignored by git (local runtime data). An empty example is in `server/data.example.json`.
