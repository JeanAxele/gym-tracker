import 'fake-indexeddb/auto';
import axios, { AxiosError } from 'axios';
import { createHmac, randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';

const url = process.env.GYM_SYNC_TEST_URL;
const secret = process.env.GYM_SYNC_TEST_SECRET;
const browserStorage = new Map();
const connectivity = { onLine: true };

async function request(path, { method = 'GET', token, data } = {}) {
  const response = await fetch(url + '/api' + path, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: 'Bearer ' + token } : {}),
    },
    body: data === undefined ? undefined : JSON.stringify(data),
  });
  const envelope = await response.json();
  if (!response.ok) throw Object.assign(new Error(envelope.error), { status: response.status });
  return envelope.data;
}

async function register() {
  const user = { email: randomUUID() + '@gmail.com', password: 'password12' };
  const profile = await request('/auth/register', { method: 'POST', data: user });
  return {
    profile,
    async login() {
      return (await request('/auth/login', { method: 'POST', data: user })).access_token;
    },
  };
}

function expiredToken(id) {
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const body = encode({ alg: 'HS256', typ: 'JWT' }) + '.' + encode({ sub: String(id), exp: 1 });
  return body + '.' + createHmac('sha256', secret).update(body).digest('base64url');
}

async function openApp() {
  const { default: client } = await import('../api/axiosClient.js');
  const network = axios.getAdapter(axios.defaults.adapter);
  client.defaults.adapter = (config) => {
    if (!connectivity.onLine) return Promise.reject(new AxiosError('Offline', 'ERR_NETWORK', config));
    return network(config);
  };
  return {
    ...await import('../api/exercises.js'),
    ...await import('../api/templates.js'),
    ...await import('../api/workouts.js'),
    ...await import('../api/sets.js'),
    ...await import('./workouts.js'),
    ...await import('./workoutStore.js'),
    ...await import('./workoutSync.js'),
    ...await import('./snapshots.js'),
    ...await import('../utils/storage.js'),
  };
}

async function reopen(app) {
  (await app.openDatabase()).close();
  vi.resetModules();
  return openApp();
}

function signIn(app, profile, token) {
  app.setToken(token);
  app.setLocalProfile(profile);
}

afterEach(() => {
  browserStorage.clear();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe.skipIf(!url || !secret)('IndexedDB through FastAPI', () => {
  it('persists offline edits, replays a lost acknowledgement once, and isolates expired accounts', async () => {
    vi.stubEnv('VITE_API_BASE_URL', url + '/api');
    vi.stubGlobal('navigator', connectivity);
    vi.stubGlobal('localStorage', {
      getItem: (key) => browserStorage.get(key) ?? null,
      setItem: (key, value) => browserStorage.set(key, value),
      removeItem: (key) => browserStorage.delete(key),
    });
    const person = await register();
    const other = await register();
    const token = await person.login();
    const otherToken = await other.login();
    let app = await openApp();
    signIn(app, person.profile, token);
    await app.provisionWorkouts();
    const bench = (await app.listExercises()).find((item) => item.name === 'Bench Press');
    const key = [url + '/api', person.profile.id, person.profile.email];

    connectivity.onLine = false;
    expect((await app.listExercises()).some((item) => item.id === bench.id)).toBe(true);
    const session = await app.createWorkout({ name: 'Offline lift', date: '2026-11-15' });
    const exercise = await app.addWorkoutExercise(session.id, bench);
    const setId = app.localId();
    await app.saveSet(session.id, exercise.id, setId, { reps: 5, weight_kg: 60 });
    await app.completeWorkout(session.id);
    app = await reopen(app);

    expect((await app.listWorkouts()).map((item) => item.id)).toEqual([session.id]);
    const local = await app.getWorkout(session.id);
    expect(local.exercises[0].sets[0]).toMatchObject({ id: setId, reps: 5, weight_kg: 60 });
    expect(local.ended_at).not.toBeNull();

    let firstOperation;
    const send = (body) => request('/workouts/sync', { method: 'POST', token, data: body });
    await app.replayWorkouts(key, async (body) => {
      firstOperation = body.operation_id;
      await send(body);
      throw new Error('Connection dropped after server committed');
    }, () => true);
    expect((await app.workoutSyncState())[0]).toMatchObject({ attempts: 1, dirty: true });
    const notYet = vi.fn(send);
    await app.replayWorkouts(key, notYet, () => true);
    expect(notYet).not.toHaveBeenCalled();

    await app.patchWorkout(session.id, { name: 'Offline lift revised' });
    await app.saveSet(session.id, exercise.id, setId, { reps: 8, weight_kg: 62.5 });
    app = await reopen(app);
    await app.accountTransaction(key, (state) => { state.workouts[session.id].retryAt = 0; });
    signIn(app, person.profile, expiredToken(person.profile.id));
    expect((await app.getWorkout(session.id)).exercises[0].sets[0].reps).toBe(8);
    const expired = vi.fn();
    const unsubscribe = app.subscribeToSync(expired);
    connectivity.onLine = true;
    await app.syncPendingWorkouts();
    expect(expired).toHaveBeenCalledWith('auth');
    expect((await app.workoutSyncState())[0].operation.body.operation_id).toBe(firstOperation);
    unsubscribe();

    signIn(app, other.profile, otherToken);
    await app.syncPendingWorkouts();
    expect(await app.workoutSyncState()).toEqual([]);
    await expect(app.getWorkout(session.id)).rejects.toThrow();
    expect(await request('/workouts', { token: otherToken })).toEqual([]);

    signIn(app, person.profile, await person.login());
    await app.syncPendingWorkouts();
    expect(await app.workoutSyncState()).toEqual([]);
    const [summary, ...duplicates] = await request('/workouts', { token });
    expect(duplicates).toEqual([]);
    const saved = await request('/workouts/' + summary.id, { token });
    expect(saved.name).toBe('Offline lift revised');
    expect(Date.parse(saved.ended_at)).toBe(Date.parse(local.ended_at));
    expect(saved.exercises[0].sets).toMatchObject([{ reps: 8, weight_kg: 62.5 }]);
    expect((await app.getWorkout(session.id)).exercises[0].sets[0].id).toBe(setId);

    connectivity.onLine = false;
    await app.saveSet(session.id, exercise.id, setId, { reps: 9 });
    await request('/workouts/' + summary.id, { method: 'PATCH', token, data: { name: 'Remote edit' } });
    connectivity.onLine = true;
    await app.syncPendingWorkouts();
    expect((await app.workoutSyncState())[0].problem.status).toBe(409);
    expect((await app.getWorkout(session.id)).exercises[0].sets[0].reps).toBe(9);
    expect((await request('/workouts/' + summary.id, { token })).name).toBe('Remote edit');
    await app.resolveWorkoutConflict(session.id, true);
    await app.syncPendingWorkouts();
    expect(await app.workoutSyncState()).toEqual([]);
    const all = await request('/workouts', { token });
    expect(all).toHaveLength(2);
    expect(all.map((item) => item.name).sort()).toEqual(['Offline lift revised', 'Remote edit']);

    const template = await request('/templates', {
      token, method: 'POST', data: {
        name: 'Offline template',
        exercises: [{ exercise_id: bench.id, target_sets: 2, target_reps_min: 6, target_reps_max: 8 }],
      },
    });
    await app.provisionWorkouts();
    connectivity.onLine = false;
    const fromTemplate = await app.startTemplate(template.id);
    expect(fromTemplate.source_template_id).toBe(template.id);
    expect(fromTemplate.exercises[0]).toMatchObject({ planned_sets: 2, planned_reps_min: 6 });
    app = await reopen(app);
    expect((await app.getWorkout(fromTemplate.id)).exercises[0].planned_reps_max).toBe(8);
    connectivity.onLine = true;
    await app.syncPendingWorkouts();
    expect(await app.workoutSyncState()).toEqual([]);
    const syncedTemplate = (await request('/workouts', { token })).find((item) => item.name === template.name);
    const syncedDetail = await request('/workouts/' + syncedTemplate.id, { token });
    expect(syncedDetail.source_template_id).toBe(template.id);
    expect(syncedDetail.exercises[0].planned_sets).toBe(2);
  }, 30_000);
});
