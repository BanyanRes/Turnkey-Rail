# BuildCore

Construction management software for our construction company.
Standalone app; will later sync approved invoices / pay apps to CloudLedger.

## Stack
- Backend: Node + Express + better-sqlite3
- Frontend: React (Vite)
- Deploy target: Railway (mirroring CloudLedger)

## Layout
```
BuildCore/
  backend/         Express API
    server.js
    db/            SQLite connection + schema
    routes/        Route modules
    data/          SQLite file (gitignored)
  frontend/        Vite + React
```

## Run locally
Backend:
```
cd backend
npm run dev
```

Frontend:
```
cd frontend
npm run dev
```

Backend serves on `http://localhost:4000`, frontend on `http://localhost:5173`.

## Roadmap
1. Projects + Job Costing (Budget vs Actual)
2. Subcontractors + Pay Applications (AIA G702/G703 style)
3. Scheduling & Tasks
4. Document / Drawing Management
5. CloudLedger sync (push approved invoices/pay apps)
