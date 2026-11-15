"""Keep the final recorded set when a session is completed."""

from tests.helpers import add_set, add_we, bench_id, empty_workout, get_workout, ok


def test_latest_set_edit_survives_completion_and_reload(client, user_a):
    headers = user_a["headers"]
    workout = empty_workout(client, headers)
    exercise = add_we(client, headers, workout["id"], bench_id(client, headers))
    first_set = add_set(client, headers, exercise["id"], {"reps": 10, "weight_kg": 40})
    last_set = add_set(client, headers, exercise["id"], {"reps": 8, "weight_kg": 40})

    saved = ok(
        client.patch(
            f"/api/sets/{last_set['id']}",
            headers=headers,
            json={"reps": 9, "weight_kg": 42.5},
        )
    )
    assert (saved["reps"], saved["weight_kg"]) == (9, 42.5)

    workout_path = f"/api/workouts/{workout['id']}"
    completed = ok(client.post(f"{workout_path}/complete", headers=headers))
    assert completed["ended_at"] is not None

    reloaded = get_workout(client, headers, workout["id"])
    assert reloaded["ended_at"] == completed["ended_at"]
    sets = reloaded["exercises"][0]["sets"]
    assert [(row["id"], row["reps"], row["weight_kg"]) for row in sets] == [
        (first_set["id"], 10, 40),
        (last_set["id"], 9, 42.5),
    ]
