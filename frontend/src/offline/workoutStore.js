import { openDatabase } from './snapshots.js';

export async function accountTransaction(key, change) {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const tx = change
      ? db.transaction('workoutAccounts', 'readwrite', { durability: 'strict' })
      : db.transaction('workoutAccounts', 'readonly');
    const store = tx.objectStore('workoutAccounts');
    const request = store.get(key);
    let result;
    let failure;
    request.onsuccess = () => {
      const state = request.result ?? { workouts: {} };
      if (!change) {
        result = state;
        return;
      }
      try {
        result = change(state);
        store.put(state, key);
      } catch (error) {
        failure = error;
        tx.abort();
      }
    };
    tx.oncomplete = () => resolve(result);
    tx.onabort = () => reject(failure || tx.error);
  });
}

export function localId() {
  const [high, low] = crypto.getRandomValues(new Uint32Array(2));
  return -((high & 0xfffff) * 2 ** 32 + low + 1);
}

export function findWorkout(state, id) {
  return state.workouts[id] ?? Object.values(state.workouts).find(
    (row) => row.serverId === Number(id),
  );
}

export function putRemote(state, workout, baseline) {
  const existing = findWorkout(state, workout.id);
  if (existing?.dirty || existing?.version !== baseline?.version
      || existing?.revision !== baseline?.revision) return existing?.workout;
  const row = existing ?? { id: workout.id, serverId: workout.id, ids: {} };
  row.revision = workout.revision;
  row.workout = useLocalIds(row, workout);
  state.workouts[row.id] = row;
  return row.workout;
}

function useLocalIds(row, workout) {
  if (!workout) return null;
  // Child tables have independent id sequences, so qualify their mappings.
  const aliases = Object.fromEntries(
    Object.entries(row.ids).map(([key, id]) => [key[0] + id, Number(key.slice(1))]),
  );
  const alias = (kind, id) => aliases[kind + id] ?? id;
  return {
    ...workout,
    id: row.id,
    exercises: workout.exercises.map((exercise) => ({
      ...exercise,
      id: alias('e', exercise.id),
      sets: exercise.sets.map((set) => ({ ...set, id: alias('s', set.id) })),
    })),
  };
}

function mapping(row, prefix, id) {
  return id > 0 ? id : row.ids[prefix + id];
}

function operationId() {
  if (crypto.randomUUID) return crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (value) => value.toString(16).padStart(2, '0')).join('');
  return [hex.slice(0, 8), hex.slice(8, 12), hex.slice(12, 16), hex.slice(16, 20), hex.slice(20)].join('-');
}

export function prepareOperation(row) {
  if (row.operation) return row.operation;
  const source = row.workout;
  const workout = source && {
    name: source.name,
    date: source.date,
    exercises: source.exercises.map(({ exercise, sets, id, ...planned }, order_index) => ({
      ...planned,
      id: mapping(row, 'e', id),
      exercise_id: exercise.id,
      order_index,
      sets: sets.map((set, index) => ({
        ...set,
        id: mapping(row, 's', set.id),
        order_index: index,
      })),
    })),
  };
  // Preserve the historical exception for already-recorded sets missing a primary metric.
  for (const [index, exercise] of (workout?.exercises ?? []).entries()) {
    const kind = source.exercises[index].exercise.primary_tracking_type;
    const field = { reps: 'reps', duration: 'duration_seconds', distance: 'distance_meters' }[kind];
    for (const set of exercise.sets) {
      if (set.id && set[field] == null) delete set[field];
    }
  }
  row.operation = {
    version: row.version,
    source: structuredClone(source),
    body: JSON.parse(JSON.stringify({
      operation_id: operationId(),
      workout_id: row.serverId,
      base_revision: row.revision,
      workout,
      source_template_id: row.serverId ? undefined : source?.source_template_id,
      started_at: source?.started_at,
      ended_at: source?.ended_at,
    })),
  };
  return row.operation;
}

export function acknowledge(state, id, operation, workout) {
  const row = state.workouts[id];
  if (row?.operation?.body.operation_id !== operation.body.operation_id) return;
  if (workout) {
    row.serverId = workout.id;
    row.revision = workout.revision;
    for (const [index, exercise] of operation.source.exercises.entries()) {
      const remote = workout.exercises[index];
      if (exercise.id < 0) row.ids['e' + exercise.id] = remote.id;
      for (const [setIndex, set] of exercise.sets.entries()) {
        if (set.id < 0) row.ids['s' + set.id] = remote.sets[setIndex].id;
      }
    }
  }
  if (!workout && row.version === operation.version) {
    state.summaries = state.summaries?.filter((item) => item.id !== row.serverId);
    delete state.workouts[id];
    return;
  }
  if (row.version === operation.version) {
    row.workout = useLocalIds(row, workout);
    row.dirty = false;
    row.recent = Boolean(workout);
  }
  delete row.operation;
  delete row.problem;
  delete row.attempts;
  delete row.retryAt;
}
