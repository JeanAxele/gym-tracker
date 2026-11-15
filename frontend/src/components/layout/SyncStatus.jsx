import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import useAuth from '@/hooks/useAuth.js';
import {
  provisionWorkouts, resolveWorkoutConflict, retryRejectedWorkout,
  subscribeToSync, syncPendingWorkouts, workoutSyncState,
} from '@/offline/workouts.js';

export default function SyncStatus() {
  const { token, logout } = useAuth();
  const [online, setOnline] = useState(navigator.onLine);
  const [pending, setPending] = useState([]);
  const [expired, setExpired] = useState(false);
  const [setup, setSetup] = useState('loading');
  const [problem, setProblem] = useState('');

  useEffect(() => {
    let active = true;
    let provisioning = false;
    const readPending = () => {
      void workoutSyncState().then((rows) => {
        if (active) setPending(rows);
      }).catch(() => {});
    };
    const sync = () => {
      void syncPendingWorkouts().catch(() => {});
    };
    const provision = () => {
      if (!navigator.onLine || provisioning) return;
      provisioning = true;
      void provisionWorkouts().then(() => {
        if (active) setSetup('ready');
      }).catch((error) => {
        if (!active) return;
        setSetup('waiting');
        if (error.status === 401) setExpired(true);
      }).finally(() => { provisioning = false; });
    };
    const onConnection = () => {
      setOnline(navigator.onLine);
      if (navigator.onLine) {
        sync();
        provision();
      }
    };
    const unsubscribe = subscribeToSync((status) => {
      if (status === 'auth') setExpired(true);
      readPending();
    });
    readPending();
    sync();
    provision();
    void navigator.storage?.persist?.().catch(() => {});
    const timer = window.setInterval(() => {
      readPending();
      sync();
    }, expired ? 30_000 : 3000);
    window.addEventListener('online', onConnection);
    window.addEventListener('offline', onConnection);
    window.addEventListener('focus', sync);
    return () => {
      active = false;
      unsubscribe();
      window.clearInterval(timer);
      window.removeEventListener('online', onConnection);
      window.removeEventListener('offline', onConnection);
      window.removeEventListener('focus', sync);
    };
  }, [token, expired]);

  const act = async (callback) => {
    setProblem('');
    try {
      await callback();
    } catch (error) {
      setProblem(error.message);
    }
  };

  const blocked = pending.filter((row) => row.problem);
  if (online && !expired && !pending.length && setup === 'ready' && !problem) return null;
  return (
    <aside className="mx-auto w-full max-w-md space-y-2 px-4 py-2 text-sm">
      <p role="status">
        {!online ? 'Offline. Workout changes are saved on this device.' :
          expired ? 'Sign in again to sync your saved changes.' :
          pending.length ? `${pending.length} workout(s) awaiting sync.` :
          setup === 'loading' ? 'Downloading workout history for offline use…' :
          'Offline setup is waiting for the server.'}
      </p>
      {expired && <button type="button" className="underline" onClick={logout}>Sign in again</button>}
      {blocked.map((row) => (
        <div key={row.id} className="space-y-2 rounded-md border border-border p-2">
          <p>{row.workout?.name ?? 'Workout deletion'} · {row.problem.message}</p>
          <div className="flex flex-wrap gap-3">
            {row.workout && <Link className="underline" to={`/workouts/${row.id}/edit`}>Open local workout</Link>}
            {row.problem.status === 422 ? (
              <button type="button" className="underline" onClick={() => act(() => retryRejectedWorkout(row.id))}>Retry corrected workout</button>
            ) : (
              <>
                {row.workout && <button type="button" className="underline" onClick={() => act(() => resolveWorkoutConflict(row.id, true))}>Sync as a separate workout</button>}
                <button type="button" className="underline" onClick={() => {
                  if (window.confirm('Discard pending changes and keep the server version?')) {
                    void act(() => resolveWorkoutConflict(row.id, false));
                  }
                }}>Keep server version</button>
              </>
            )}
          </div>
        </div>
      ))}
      {problem && <p role="alert">{problem}</p>}
    </aside>
  );
}
