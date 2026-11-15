# Gym Tracker

A simple, mobile-first workout tracking web app for personal use. Full-stack scaffold:
a FastAPI modular monolith backend and a Vite + React JavaScript frontend.

> Canonical project state: [docs/AI_HANDOFF.md](docs/AI_HANDOFF.md).
> Current status: **Phase 8 (AI Readiness) and Phase 9 (Voice Assistant) are implemented.**

---

## 1. Repository layout

```
gym-tracker-app/
├── backend/                 FastAPI modular monolith (Python 3.12+)
│   ├── app/
│   │   ├── core/            config, db, security, deps, response envelope, exceptions
│   │   ├── auth/            User model, JWT register/login/me
│   │   ├── exercises/       seeded catalog and personal exercises
│   │   ├── workouts/        Workout, WorkoutExercise, Set + CRUD
│   │   ├── templates/       workout templates and session creation
│   │   ├── commands/        validated commands for workout logging
│   │   ├── assistant/       assistant interpretation and execution
│   │   ├── seed/            predefined exercises + idempotent seeder
│   │   └── main.py          FastAPI app factory
│   ├── alembic/             migration environment + versions/
│   ├── alembic.ini          Alembic config (URL comes from app settings)
│   ├── scripts/seed_db.py   CLI: python -m scripts.seed_db
│   ├── requirements.txt
│   ├── Dockerfile
│   ├── docker-compose.yml
│   └── .env.example
├── frontend/                React (Vite, JavaScript)
│   ├── src/
│   │   ├── api/             Axios client + per-resource modules
│   │   ├── context/         AuthContext, ThemeContext
│   │   ├── hooks/           useAuth, useTheme, useAsync
│   │   ├── routes/          AppRoutes, ProtectedRoute
│   │   ├── pages/           Login, Register, Home, WorkoutEditor, WorkoutDetail, 404
│   │   ├── components/      layout, auth, workouts, ui
│   │   ├── styles/          theme.css (CSS vars), global.css (mobile-first)
│   │   └── utils/           storage.js, format.js
│   ├── index.html
│   ├── vite.config.js
│   ├── package.json
│   └── .env.example
├── PRD.md                   product requirements
├── architecture.md          architecture + DB schema
├── api_contract.md          REST endpoints + envelope
├── agents.md                agent ownership boundaries
└── README.md                this file
```

---

## 2. Architecture decisions

### Backend - modular monolith

- **Pattern**: each core domain (auth, exercises, workouts, templates) is a self-contained module
  owning its own `models.py`, `schemas.py`, `service.py`, `routes.py`. Cross-cutting
  concerns live in `core/` (config, database, security, dependencies, response, exceptions).
- **Why**: the PRD scope is small (personal use) and a monolith is the simplest
  thing that works. The strict module boundaries make it trivial to extract any
  module into its own service later if needed.
- **Response envelope**: every endpoint returns `{ success, data, error }` per
  `api_contract.md`. `core/response.py` provides `ok(data)` / `fail(error)` helpers,
  and `core/exceptions.py` registers handlers that wrap thrown exceptions in the
  same envelope - so business code never has to format JSON manually.
- **Database**: SQLAlchemy 2.x with SQLite for local development. The engine
  applies the `check_same_thread=False` SQLite-specific arg conditionally, so
  pointing `DATABASE_URL` at PostgreSQL is the only change needed at the code
  level (see "Migration to PostgreSQL" below).
- **Auth**: JWT bearer tokens via `python-jose`, password hashing via `passlib[bcrypt]`.
  A single `get_current_user` dependency is reused by every protected route.
- **Seed mechanism**: `app/seed/exercises_seed.py` is the single source of truth for
  the predefined exercise catalog. `app/seed/seeder.py:run_seed(db)` is idempotent
  (skips existing rows by name) and is invoked from `scripts/seed_db.py`.
- **Config**: `pydantic-settings` reads `.env`, never hardcodes secrets. Only
  `.env.example` is committed.

### Frontend - React + Vite (JavaScript), mobile-first

- **Why JavaScript**: the V1 PRD is small and personal; TypeScript adds
  scaffolding cost we don't yet need. The folder structure is designed to make
  a future TS migration mechanical.
- **Mobile-first**: target device is the Galaxy S21 (360x800). The CSS uses
  `dvh` units, safe-area insets, and a 480px max-width container. All tap
  targets are at least 44px tall.
- **Dark mode**: a `ThemeContext` flips `data-theme` on `<html>` and persists
  the choice in `localStorage`. All colors come from CSS variables in
  `styles/theme.css`, so adding/refining themes never touches components.
- **HTTP layer**: a single Axios instance in `api/axiosClient.js` attaches the
  JWT bearer, unwraps the `{success,data,error}` envelope, and handles 401
  globally. Per-resource modules (`auth.js`, `workouts.js`, ...) are thin.
- **Routing**: `react-router-dom` v6 nested routes; a `ProtectedRoute` guard
  redirects to `/login` when there is no token.
- **Tests**: backend `pytest` (isolated SQLite) and frontend `npm test` (Vitest). See below.

---

## 3. Setup

### Backend

```bash
cd backend
python -m venv .venv
.venv\Scripts\activate   # Windows
# source .venv/bin/activate  # macOS/Linux
pip install -r requirements.txt
copy .env.example .env   # then edit JWT_SECRET, etc.
alembic upgrade head     # creates/updates the schema (required before seeding)
python -m scripts.seed_db
uvicorn app.main:app --reload
```

API will be available at `http://localhost:8000` (docs at `/docs`).

### Database migrations (Alembic)

The schema is owned by Alembic. The app no longer calls
`Base.metadata.create_all()` at startup, so `alembic upgrade head` must be run
after cloning and after pulling any change that adds a revision.

```bash
cd backend
alembic upgrade head      # apply migrations
alembic current           # revision the local DB is on
alembic heads             # latest revision available
alembic check             # fail if models drifted from migrations
alembic revision --autogenerate -m "describe the change"
```

Alembic reads `DATABASE_URL` through `app/core/config.py`, the same source the
application uses, so the two can never point at different databases. Always run
these commands from `backend/`, because the default SQLite URL is relative.

`sqlite:///./gym.db` holds real data and is git-ignored. Back it up before any
migration that rewrites a table:

```powershell
Copy-Item gym.db "gym.db.backup-$(Get-Date -Format yyyyMMdd-HHmmss)"
```

### Frontend

```bash
cd frontend
npm install
copy .env.example .env   # then adjust VITE_API_BASE_URL if needed
npm run dev
```

App will be available at `http://localhost:5173`.
The Vite dev server proxies `/api` to `http://localhost:8000`.

### Tests

Never pointed at `backend/gym.db`.

```powershell
# Backend — from backend/
.\.venv\Scripts\python.exe -m pytest

# Frontend — from frontend/
npm test
npm run build
```

### Docker (backend)

```bash
cd backend
docker compose up --build
```

The compose file currently runs only the `api` service against SQLite. The
`db` (PostgreSQL) service is included as a commented-out block and can be
enabled when you migrate.

---

## 4. API contract (recap)

Selected endpoints are listed below. The running backend exposes the full API at `/docs`.

All responses follow `{ success: boolean, data: any, error: string | null }`.
Pydantic request-validation 422 also includes a `details` array (intentional exception).

| Method | Path | Auth | Notes |
| --- | --- | --- | --- |
| GET | `/api/health` | no | Liveness probe |
| POST | `/api/auth/register` | no | Create account |
| POST | `/api/auth/login` | no | Returns JWT |
| GET | `/api/auth/me` | yes | Current user |
| GET | `/api/exercises` | yes | List visible exercises |
| POST | `/api/exercises` | yes | Create a personal exercise |
| POST | `/api/exercises/resolve` | yes | Resolve an exercise name |
| GET | `/api/workouts` | yes | List the user's sessions |
| GET | `/api/workouts/active` | yes | List active sessions |
| POST | `/api/workouts` | yes | Create a session |
| GET | `/api/workouts/{workout_id}` | yes | Get a session |
| PUT | `/api/workouts/{workout_id}` | yes | Update a session with nested exercises and sets |
| PATCH | `/api/workouts/{workout_id}` | yes | Update session metadata |
| DELETE | `/api/workouts/{workout_id}` | yes | Delete a session |
| POST | `/api/workouts/{workout_id}/complete` | yes | Complete a session |
| POST | `/api/workouts/{workout_id}/exercises` | yes | Add an exercise to a session |
| POST | `/api/workout-exercises/{workout_exercise_id}/sets` | yes | Create a set for a session exercise |
| POST | `/api/workout-exercises/{workout_exercise_id}/sets/reorder` | yes | Reorder sets for a session exercise |
| PATCH | `/api/sets/{set_id}` | yes | Partially update a set |
| DELETE | `/api/sets/{set_id}` | yes | Delete a set |
| GET | `/api/templates` | yes | List visible templates |
| POST | `/api/templates/resolve` | yes | Resolve a template name |
| POST | `/api/templates/{template_id}/start` | yes | Start a session from a template |
| POST | `/api/workouts/{workout_id}/save-as-template` | yes | Save a session as a personal template |
| POST | `/api/assistant/interpret` | yes | Interpret text and preview commands |
| POST | `/api/assistant/execute` | yes | Run validated commands |

Authentication: `Authorization: Bearer <jwt>`.

---

## 5. Migration to PostgreSQL

When you outgrow SQLite (per `architecture.md` Future Scalability):

1. Uncomment `psycopg2-binary` in [backend/requirements.txt](backend/requirements.txt)
   and reinstall.
2. Set `DATABASE_URL=postgresql+psycopg2://user:pass@host:5432/gym` in `.env`.
3. Run `alembic upgrade head` against the new database. Alembic is already
   configured and picks up `DATABASE_URL` automatically; the baseline revision
   recreates the full schema on an empty PostgreSQL instance. Note that the
   SQLite-only `render_as_batch` in `alembic/env.py` switches itself off for
   non-SQLite URLs.
4. Uncomment the `db` service and `depends_on` block in
   [backend/docker-compose.yml](backend/docker-compose.yml).

The application code itself - models, services, routes - does not change.

---

## 6. Module ownership

Per [agents.md](agents.md):

- **Backend agent** owns everything under `backend/`.
- **Frontend agent** owns everything under `frontend/`.
- **Refactor agent** is allowed to touch both, but only for cleanup,
  type-safety, naming consistency, and de-duplication.

---

## 7. Feature status

- **Workout tracking** supports sessions, granular exercise and set editing, and reusable templates.
- **Phase 8 — AI Readiness** adds exercise and template name resolution, active session lookup, and validated commands for workout logging.
- **Phase 9 — Voice Assistant** accepts speech in supported browsers or typed text from Home and the session editor. The assistant previews commands before the user confirms execution. Interpretation uses OpenAI and requires `OPENAI_API_KEY` in the backend environment.

See [docs/AI_HANDOFF.md](docs/AI_HANDOFF.md) §§2.16–2.17 for implementation details and §8 for the roadmap.
