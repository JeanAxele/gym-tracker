import { editLocalWorkout } from '../offline/workouts.js';

function editExercise(workoutId, exerciseId, edit) {
  return editLocalWorkout(workoutId, (_, workout) => {
    const exercise = workout.exercises.find((row) => row.id === exerciseId);
    if (!exercise) throw new Error('Exercise no longer exists.');
    return edit(exercise);
  });
}

export function saveSet(workoutId, exerciseId, setId, payload) {
  return editExercise(workoutId, exerciseId, (exercise) => {
    const existing = exercise.sets.find((row) => row.id === setId);
    if (existing) return Object.assign(existing, payload);
    if (setId > 0) throw new Error('Set no longer exists.');
    const set = { id: setId, set_type: 'working', ...payload, order_index: exercise.sets.length };
    exercise.sets.push(set);
    return set;
  });
}

export function deleteSet(workoutId, exerciseId, setId) {
  return editExercise(workoutId, exerciseId, (exercise) => {
    exercise.sets = exercise.sets
      .filter((set) => set.id !== setId)
      .map((set, index) => ({ ...set, order_index: index }));
  });
}
