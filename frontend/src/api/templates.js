// Templates API. Globals are immutable; personal templates are owner-only.

import client from './axiosClient.js';
import { createLocalWorkout } from '../offline/workouts.js';
import { localId } from '../offline/workoutStore.js';

export async function listTemplates() {
  return client.get('/templates');
}

export async function getTemplate(id) {
  return client.get(`/templates/${id}`);
}

export async function createTemplate(payload) {
  return client.post('/templates', payload);
}

export async function updateTemplate(id, payload) {
  return client.patch(`/templates/${id}`, payload);
}

export async function deleteTemplate(id) {
  return client.delete(`/templates/${id}`);
}

export async function personalizeTemplate(id, name) {
  const body = name ? { name } : undefined;
  return client.post(`/templates/${id}/personalize`, body);
}

export async function startTemplate(id) {
  const template = await getTemplate(id);
  const exercises = template.exercises.map(({ exercise, order_index, ...targets }) => ({
    id: localId(),
    exercise,
    order_index,
    sets: [],
    ...Object.fromEntries(Object.entries(targets)
      .filter(([key]) => key.startsWith('target_'))
      .map(([key, value]) => [key.replace('target_', 'planned_'), value])),
  }));
  if (exercises.some((item) => item.exercise.is_active === false)) {
    throw new Error('This template contains an archived exercise.');
  }
  return createLocalWorkout({ name: template.name, exercises, source_template_id: template.id });
}
