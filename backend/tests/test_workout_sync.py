from concurrent.futures import ThreadPoolExecutor
from uuid import uuid4

from tests.helpers import add_we, bench_id, empty_workout, err, get_workout, ok


def mutation(workout=None, **changes):
    result = {
        "operation_id": str(uuid4()),
        "started_at": "2026-11-15T12:00:00Z",
        "workout": workout or {"name": "Logged offline", "date": "2026-11-15"},
    }
    return {**result, **changes}


def sync(client, user, payload):
    return client.post("/api/workouts/sync", headers=user["headers"], json=payload)


def test_repeat_and_concurrent_delivery_are_atomic(client, user_a):
    payload = mutation({
        "name": "Logged offline",
        "date": "2026-11-15",
        "exercises": [{"exercise_id": bench_id(client, user_a["headers"]), "sets": [{"reps": 5}]}],
    }, ended_at="2026-11-15T13:00:00Z")
    with ThreadPoolExecutor(max_workers=2) as workers:
        first, second = list(workers.map(lambda _: ok(sync(client, user_a, payload)), range(2)))
    assert first == second
    body = first["workout"]
    assert body["ended_at"] == "2026-11-15T13:00:00Z"
    assert body["exercises"][0]["sets"][0]["reps"] == 5
    assert len(ok(client.get("/api/workouts", headers=user_a["headers"]))) == 1
    err(sync(client, user_a, {**payload, "ended_at": None}), 409)


def test_conflict_and_account_isolation(client, user_a, user_b):
    headers = user_a["headers"]
    workout = empty_workout(client, headers)
    baseline = get_workout(client, headers, workout["id"])
    payload = mutation(workout_id=workout["id"], base_revision=baseline["revision"])
    err(sync(client, user_b, payload), 404)
    add_we(client, headers, workout["id"], bench_id(client, headers))
    err(sync(client, user_a, payload), 409)
    assert len(get_workout(client, headers, workout["id"])["exercises"]) == 1


def test_failed_request_does_not_commit_receipt_or_partial_changes(client, user_a):
    headers = user_a["headers"]
    payload = mutation({
        "name": "Invalid",
        "date": "2026-11-15",
        "exercises": [{"exercise_id": bench_id(client, headers), "sets": [{"weight_kg": 50}]}],
    })
    err(sync(client, user_a, payload), 422)
    assert ok(client.get("/api/workouts", headers=headers)) == []
    payload["workout"]["exercises"][0]["sets"][0]["reps"] = 4
    result = ok(sync(client, user_a, payload))["workout"]
    assert result["exercises"][0]["sets"][0]["reps"] == 4


def test_existing_tree_updates_keep_ids_and_add_new_sets(client, user_a):
    headers = user_a["headers"]
    exercise_id = bench_id(client, headers)
    initial = ok(sync(client, user_a, mutation({
        "name": "Session", "date": "2026-11-15",
        "exercises": [{"exercise_id": exercise_id, "sets": [{"reps": 5}]}],
    })))["workout"]
    exercise = initial["exercises"][0]
    set_id = exercise["sets"][0]["id"]
    payload = mutation({
        "name": "Edited", "date": "2026-11-15",
        "exercises": [{
            "id": exercise["id"], "exercise_id": exercise_id,
            "sets": [{"id": set_id, "reps": 7}, {"reps": 8}],
        }],
    }, workout_id=initial["id"], base_revision=initial["revision"])
    updated = ok(sync(client, user_a, payload))["workout"]
    assert [(row["id"], row["reps"]) for row in updated["exercises"][0]["sets"]][0] == (set_id, 7)
    assert len(updated["exercises"][0]["sets"]) == 2
    assert updated["revision"] == get_workout(client, headers, initial["id"])["revision"]
    assert ok(sync(client, user_a, payload))["workout"] == updated
    deletion = mutation(workout_id=initial["id"], base_revision=updated["revision"])
    deletion["workout"] = None
    assert ok(sync(client, user_a, deletion)) == {"workout": None}
    assert ok(sync(client, user_a, deletion)) == {"workout": None}
