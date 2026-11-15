> **STALE / dangerous.** `POST /sets` and `PUT /sets/{id}` do **not** exist.
> Authoritative surface: `docs/AI_HANDOFF.md` §2.6. Granular Set APIs only.

# API Contract

Base URL: /api

Auth: POST /auth/register POST /auth/login GET /auth/me

Exercises: GET /exercises

Workouts: GET /workouts POST /workouts GET /workouts/{id} PUT
/workouts/{id} DELETE /workouts/{id}

Sets: POST /sets PUT /sets/{id} DELETE /sets/{id}

Response Format:

{ "success": true, "data": {}, "error": null }

## Offline workout synchronization

`GET /api/workouts/{id}` includes an opaque `revision` for the workout and its recorded sets. `POST /api/workouts/sync` accepts a JWT-scoped operation with:

- `operation_id`, a UUID that the client keeps unchanged across retries.
- `workout`, the full `WorkoutUpdate` snapshot, or `null` to delete. Existing child IDs are explicit. Omitted child IDs create new rows.
- `workout_id` and `base_revision` for an existing workout. Omit both for creation and provide `started_at`. The optional `ended_at` records completion. `source_template_id` may be supplied on creation.

The response envelope contains `data.workout`, the canonical workout with its new revision, or `null` after a delete. The mutation and receipt commit in one transaction. The same UUID and payload return the original result. A stale revision or a UUID reused with different data returns HTTP 409. A missing or inaccessible workout returns HTTP 404. The client retains pending changes for recovery.
