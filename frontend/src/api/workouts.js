import client from './axiosClient.js';
import { localId } from '../offline/workoutStore.js';
import {
  createLocalWorkout, editLocalWorkout, getLocalWorkout, listLocalWorkouts, remoteWorkoutId,
} from '../offline/workouts.js';

export const listWorkouts = listLocalWorkouts;
export const getWorkout = getLocalWorkout;
export const createWorkout = createLocalWorkout;

export function patchWorkout(id, payload) {
  return editLocalWorkout(id, (_, workout) => Object.assign(workout, payload));
}

export function deleteWorkout(id) {
  return editLocalWorkout(id, (row) => { row.workout = null; });
}

export function completeWorkout(id) {
  return editLocalWorkout(id, (_, workout) => {
    workout.ended_at ??= new Date().toISOString();
    return workout;
  });
}

export function addWorkoutExercise(id, exercise) {
  return editLocalWorkout(id, (_, workout) => {
    const item = { id: localId(), exercise, order_index: workout.exercises.length, sets: [] };
    workout.exercises.push(item);
    return item;
  });
}

export function deleteWorkoutExercise(id, exerciseId) {
  return editLocalWorkout(id, (_, workout) => {
    workout.exercises = workout.exercises
      .filter((item) => item.id !== exerciseId)
      .map((item, index) => ({ ...item, order_index: index }));
  });
}

export async function saveWorkoutAsTemplate(id, name) {
  return client.post('/workouts/' + await remoteWorkoutId(id) + '/save-as-template', name ? { name } : undefined);
}
