import { accountTransaction, acknowledge, prepareOperation } from './workoutStore.js';

function isRunnable(row) {
  return row.dirty && !row.problem && !(row.retryAt > Date.now());
}

export async function replayWorkouts(key, send, stillActive, notify = () => {}) {
  while (stillActive()) {
    const state = await accountTransaction(key);
    if (!Object.values(state.workouts).some(isRunnable)) return;
    const next = await accountTransaction(key, (state) => {
      const row = Object.values(state.workouts).find(isRunnable);
      if (!row) return null;
      return { id: row.id, operation: prepareOperation(row) };
    });
    if (!next || !stillActive()) return;
    const { id, operation } = next;
    try {
      const response = await send(operation.body);
      await accountTransaction(key, (state) => acknowledge(state, id, operation, response.workout));
      notify();
    } catch (error) {
      if (error.status === 401) {
        notify('auth');
        return;
      }
      await accountTransaction(key, (state) => {
        const row = state.workouts[id];
        if (row?.operation?.body.operation_id !== operation.body.operation_id) return;
        if ([404, 409, 422].includes(error.status)) {
          row.problem = { status: error.status, message: error.message };
        } else {
          row.attempts = (row.attempts ?? 0) + 1;
          row.retryAt = Date.now() + Math.min(120_000, 1000 * 2 ** Math.min(row.attempts, 7));
        }
      });
      notify();
    }
  }
}
