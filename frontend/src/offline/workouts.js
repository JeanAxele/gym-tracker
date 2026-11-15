import client from '../api/axiosClient.js';
import { getToken } from '../utils/storage.js';
import { toDateInputValue } from '../utils/format.js';
import { getLocalProfile, readSnapshot } from './snapshots.js';
import { accountTransaction, findWorkout, localId, putRemote } from './workoutStore.js';
import { replayWorkouts } from './workoutSync.js';

const listeners = new Set();
let replay;
let rejectedToken;

function notify(status) {
  for (const listener of listeners) listener(status);
}

export function subscribeToSync(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function account() {
  const profile = getLocalProfile();
  if (!profile) throw new Error('Sign in online to set up workout storage.');
  return {
    key: [client.defaults.baseURL, profile.id, profile.email],
    token: getToken(),
    userId: profile.id,
  };
}

function isCurrent(scope) {
  return scope.token === getToken() && scope.userId === getLocalProfile()?.id;
}

function online(scope, method, url, data, options = {}) {
  if (!isCurrent(scope)) throw new Error('Account changed');
  return client.request({ method, url, data, gymToken: scope.token, ...options });
}

export async function syncPendingWorkouts() {
  if (replay) return replay;
  const scope = account();
  if (scope.token === rejectedToken) return;
  replay = replayWorkouts(
    scope.key,
    (body) => online(scope, 'post', '/workouts/sync', body),
    () => isCurrent(scope) && navigator.onLine !== false,
    (status) => {
      if (!isCurrent(scope)) return;
      if (status === 'auth') rejectedToken = scope.token;
      notify(status);
    },
  ).finally(() => { replay = undefined; });
  return replay;
}

function triggerSync() {
  notify();
  void syncPendingWorkouts().catch(() => {});
}

function localUnavailable(error) {
  return !error.status || error.status === 401 || error.status >= 500;
}

export async function getLocalWorkout(id) {
  const scope = account();
  const state = await accountTransaction(scope.key);
  const row = findWorkout(state, id);
  const serverId = row?.serverId ?? Number(id);
  if (row?.dirty || (row && !row.workout) || (serverId < 0 && !row?.serverId) || (row?.workout && navigator.onLine === false)) {
    if (row?.workout) return row.workout;
    throw new Error('Workout unavailable on this device.');
  }
  const path = '/workouts/' + serverId;
  try {
    if (navigator.onLine === false) throw new Error('Offline');
    const workout = await online(scope, 'get', path, undefined, { gymNetworkOnly: true });
    return await accountTransaction(scope.key, (current) => putRemote(current, workout, row));
  } catch (error) {
    if (localUnavailable(error)) {
      if (row?.workout) return row.workout;
      const cached = await readSnapshot({
        baseURL: scope.key[0], gymAccount: scope.userId, method: 'get', url: path,
      });
      if (cached) return accountTransaction(scope.key, (current) => putRemote(current, cached, row));
    }
    throw error;
  }
}

export async function listLocalWorkouts() {
  const scope = account();
  let summaries;
  let failure;
  try {
    if (navigator.onLine !== false) {
      summaries = await online(scope, 'get', '/workouts', undefined, { gymNetworkOnly: true });
    }
  } catch (error) {
    if (!localUnavailable(error)) throw error;
    failure = error;
  }
  if (summaries) {
    await accountTransaction(scope.key, (state) => {
      state.summaries = summaries;
      state.ready = true;
      for (const row of Object.values(state.workouts)) {
        if (summaries.some((item) => item.id === row.serverId)) delete row.recent;
      }
    });
  }
  const state = await accountTransaction(scope.key);
  const remote = new Map((state.summaries ?? []).map((item) => [item.id, item]));
  if (!state.ready && !Object.keys(state.workouts).length && failure) throw failure;
  const result = [];
  for (const row of Object.values(state.workouts)) {
    const summary = remote.get(row.serverId);
    remote.delete(row.serverId);
    if (!row.workout) continue;
    if (row.dirty || row.recent) result.push(row.workout);
    else if (summary) result.push({ ...summary, id: row.id });
  }
  result.push(...remote.values());
  return result.sort((a, b) => b.date.localeCompare(a.date) || b.created_at.localeCompare(a.created_at));
}

export async function provisionWorkouts() {
  const scope = account();
  const summaries = await online(scope, 'get', '/workouts', undefined, { gymNetworkOnly: true });
  await accountTransaction(scope.key, (state) => {
    state.ready = true;
    state.summaries = summaries;
    for (const row of Object.values(state.workouts)) {
      if (summaries.some((item) => item.id === row.serverId)) delete row.recent;
    }
  });
  const queue = [...summaries];
  const worker = async () => {
    while (queue.length && isCurrent(scope)) {
      const item = queue.shift();
      try {
        const baseline = findWorkout(await accountTransaction(scope.key), item.id);
        const workout = await online(scope, 'get', '/workouts/' + item.id, undefined, { gymNetworkOnly: true });
        await accountTransaction(scope.key, (state) => putRemote(state, workout, baseline));
      } catch (error) {
        if (error.status !== 404) throw error;
      }
    }
  };
  await Promise.all([
    online(scope, 'get', '/exercises'),
    provisionTemplates(scope),
    ...Array.from({ length: Math.min(3, queue.length) }, worker),
  ]);
}

async function provisionTemplates(scope) {
  const templates = await online(scope, 'get', '/templates');
  for (const template of templates) {
    if (!isCurrent(scope)) return;
    try {
      await online(scope, 'get', '/templates/' + template.id, undefined, { gymNetworkOnly: true });
    } catch (error) {
      if (error.status !== 404) throw error;
    }
  }
}

export async function createLocalWorkout({ name, date, exercises = [], source_template_id = null }) {
  const scope = account();
  const now = new Date().toISOString();
  const workout = {
    id: localId(), user_id: scope.userId, name, date: date || toDateInputValue(),
    created_at: now, started_at: now, ended_at: null, exercises, source_template_id,
  };
  await accountTransaction(scope.key, (state) => {
    state.workouts[workout.id] = {
      id: workout.id, workout, version: 1, dirty: true, recent: true, ids: {},
    };
  });
  triggerSync();
  return workout;
}

export async function editLocalWorkout(id, edit) {
  const scope = account();
  const state = await accountTransaction(scope.key);
  if (!findWorkout(state, id)?.revision && !findWorkout(state, id)?.dirty) await getLocalWorkout(id);
  if (!isCurrent(scope)) throw new Error('Account changed');
  const result = await accountTransaction(scope.key, (current) => {
    const row = findWorkout(current, id);
    if (!row?.workout || (row.serverId && !row.revision)) {
      throw new Error('Open the workout online once to enable offline editing.');
    }
    const result = edit(row, row.workout);
    row.version = (row.version ?? 0) + 1;
    row.dirty = true;
    if (!row.serverId && !row.operation && !row.workout) delete current.workouts[row.id];
    return result;
  });
  triggerSync();
  return result;
}

export async function workoutSyncState() {
  const scope = account();
  const state = await accountTransaction(scope.key);
  return Object.values(state.workouts).filter((row) => row.dirty);
}

export async function resolveWorkoutConflict(id, keepCopy) {
  const scope = account();
  await accountTransaction(scope.key, (state) => {
    const row = state.workouts[id];
    if (![404, 409].includes(row?.problem?.status)) throw new Error('No workout conflict to resolve.');
    if (row.serverId && row.problem.status === 404) {
      state.summaries = state.summaries?.filter((item) => item.id !== row.serverId);
    }
    if (keepCopy && row.workout) {
      const workout = {
        ...row.workout,
        id: localId(),
        exercises: row.workout.exercises.map((exercise) => ({
          ...exercise,
          id: localId(),
          sets: exercise.sets.map((set) => ({ ...set, id: localId() })),
        })),
      };
      state.workouts[workout.id] = {
        id: workout.id, workout, version: 1, dirty: true, recent: true, ids: {},
      };
    }
    delete state.workouts[id];
  });
  triggerSync();
}

export async function retryRejectedWorkout(id) {
  const scope = account();
  await accountTransaction(scope.key, (state) => {
    const row = state.workouts[id];
    if (row?.problem?.status !== 422) return;
    delete row.operation;
    delete row.problem;
  });
  triggerSync();
}

export async function remoteWorkoutContext(id, exerciseId) {
  const scope = account();
  const row = findWorkout(await accountTransaction(scope.key), id);
  if (row?.dirty || (Number(id) < 0 && !row?.serverId)) {
    throw new Error('Wait for the workout to sync before using this feature.');
  }
  return {
    workoutId: row?.serverId ?? Number(id),
    exerciseId: exerciseId < 0 ? row?.ids['e' + exerciseId] : exerciseId,
  };
}

export async function remoteWorkoutId(id) {
  return (await remoteWorkoutContext(id)).workoutId;
}
