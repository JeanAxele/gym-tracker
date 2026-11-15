import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { ArrowLeft, Loader2, AlertCircle, Mic, RotateCw } from 'lucide-react';

import {
  addWorkoutExercise,
  completeWorkout,
  deleteWorkoutExercise,
  getWorkout,
  patchWorkout,
} from '@/api/workouts.js';
import { remoteWorkoutContext } from '@/offline/workouts.js';
import { localId } from '@/offline/workoutStore.js';
import { getLastWeights } from '@/api/exercises.js';
import { saveSet, deleteSet } from '@/api/sets.js';
import useAsync from '@/hooks/useAsync.js';
import { toDateInputValue } from '@/utils/format.js';
import {
  emptyDraftRow,
  hasPrimaryValue,
  lastWeightMap,
  shouldPersistSet,
  rowsForWorkoutExercise,
  setWritePayload,
  trackingOf,
} from '@/lib/tracking.js';
import PageContainer from '@/components/ui/PageContainer.jsx';
import StatusView from '@/components/ui/StatusView.jsx';
import AppButton from '@/components/ui/AppButton.jsx';
import WorkoutForm from '@/components/workouts/WorkoutForm.jsx';
import SaveAsTemplateDialog from '@/components/workouts/SaveAsTemplateDialog.jsx';
import VoiceAssistantSheet from '@/components/assistant/VoiceAssistantSheet.jsx';
import {
  createdWorkoutId,
  didFinishSession,
  shouldReloadSession,
} from '@/lib/assistant.js';

function sortExercises(exercises = []) {
  return [...exercises].sort((a, b) => a.order_index - b.order_index);
}

function buildBlocks(workout, weights) {
  return sortExercises(workout.exercises).map((we) => ({
    workout_exercise_id: we.id,
    exercise: we.exercise,
    planned_sets: we.planned_sets,
    planned_reps_min: we.planned_reps_min,
    planned_reps_max: we.planned_reps_max,
    planned_duration_seconds_min: we.planned_duration_seconds_min,
    planned_duration_seconds_max: we.planned_duration_seconds_max,
    planned_distance_meters_min: we.planned_distance_meters_min,
    planned_distance_meters_max: we.planned_distance_meters_max,
    rows: rowsForWorkoutExercise(we, weights[we.exercise.id]),
  }));
}

export default function WorkoutEditorPage() {
  const navigate = useNavigate();
  const { id } = useParams();

  const fetcher = useCallback(() => getWorkout(id), [id]);
  const { data: workout, error, loading, reload, setData } = useAsync(fetcher, [id]);

  const [name, setName] = useState('');
  const [date, setDate] = useState('');
  const [blocks, setBlocks] = useState([]);
  const [weights, setWeights] = useState({});
  const [serverError, setServerError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [saveOpen, setSaveOpen] = useState(false);
  const [assistantOpen, setAssistantOpen] = useState(false);
  const [assistantContext, setAssistantContext] = useState(null);
  const blocksRef = useRef([]);
  const draftIds = useRef(new Map());
  const pendingWrites = useRef(new Map());
  const lastWrites = useRef(new Map());
  const touchedRows = useRef(new Set());

  useEffect(() => {
    if (!workout) return undefined;
    setName(workout.name);
    setDate(toDateInputValue(workout.date));
    let cancelled = false;
    if (pendingWrites.current.size === 0) {
      const next = buildBlocks(workout, {});
      blocksRef.current = next;
      setBlocks(next);
    }
    const ids = (workout.exercises || []).map((we) => we.exercise.id);
    getLastWeights(ids, workout.id).then((rows) => {
      if (cancelled) return;
      const map = lastWeightMap(rows);
      setWeights(map);
      const next = blocksRef.current.map((block) => ({
        ...block,
        rows: block.rows.map((row) => {
          const suggested = map[block.exercise.id];
          if (row.set_id || touchedRows.current.has(row.clientKey) || suggested == null) return row;
          return { ...row, weight_kg: suggested };
        }),
      }));
      blocksRef.current = next;
      setBlocks(next);
    }).catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [workout?.id]);

  const isActive = workout?.ended_at == null;

  const replaceBlock = (workoutExerciseId, updater) => {
    const next = blocksRef.current.map((block) =>
      block.workout_exercise_id === workoutExerciseId ? updater(block) : block
    );
    blocksRef.current = next;
    setBlocks(next);
  };

  const handleMetaBlur = async () => {
    if (!workout) return false;
    const trimmed = name.trim();
    if (!trimmed) {
      setServerError('Workout name is required');
      return false;
    }
    if (trimmed === workout.name && date === toDateInputValue(workout.date)) return true;
    try {
      setServerError(null);
      await patchWorkout(id, { name: trimmed, date });
      return true;
    } catch (err) {
      setServerError(err?.message || 'Could not save name or date.');
      return false;
    }
  };

  const handleAddExercise = async (exercise) => {
    setBusy(true);
    setServerError(null);
    try {
      const created = await addWorkoutExercise(id, exercise);
      const next = [...blocksRef.current, ...buildBlocks({ exercises: [created] }, weights)];
      blocksRef.current = next;
      setBlocks(next);
      void getLastWeights([exercise.id], id)
        .then((rows) => setWeights((current) => ({ ...current, ...lastWeightMap(rows) })))
        .catch(() => {});
    } catch (err) {
      setServerError(err?.message || 'Could not add the exercise.');
    } finally {
      setBusy(false);
    }
  };

  const handleRemoveExercise = async (workoutExerciseId) => {
    setBusy(true);
    setServerError(null);
    try {
      await deleteWorkoutExercise(id, workoutExerciseId);
      const next = blocksRef.current.filter((block) => block.workout_exercise_id !== workoutExerciseId);
      blocksRef.current = next;
      setBlocks(next);
    } catch (err) {
      setServerError(err?.message || 'Could not remove the exercise.');
    } finally {
      setBusy(false);
    }
  };

  const handleRowChange = (workoutExerciseId, setIndex, patch) => {
    replaceBlock(workoutExerciseId, (block) => ({
      ...block,
      rows: block.rows.map((row, index) => {
        if (index !== setIndex) return row;
        touchedRows.current.add(row.clientKey);
        return { ...row, ...patch };
      }),
    }));
    void handleRowCommit(workoutExerciseId, setIndex);
  };

  const handleRowCommit = (workoutExerciseId, setIndex) => {
    const block = blocksRef.current.find((item) => item.workout_exercise_id === workoutExerciseId);
    const row = block?.rows[setIndex];
    if (!row) return Promise.resolve(true);
    const tracking = trackingOf(block.exercise);
    if (!shouldPersistSet(row, tracking)) return Promise.resolve(true);

    const primaryOk = hasPrimaryValue(row, tracking.primary);
    const payload = primaryOk ? setWritePayload(row, tracking) : { weight_kg: Number(row.weight_kg) };
    const key = row.clientKey;
    const signature = JSON.stringify(payload);
    if (lastWrites.current.get(key) === signature) return pendingWrites.current.get(key) ?? Promise.resolve(true);
    lastWrites.current.set(key, signature);
    const setId = row.set_id ?? draftIds.current.get(key) ?? localId();
    draftIds.current.set(key, setId);
    const previous = pendingWrites.current.get(key) ?? Promise.resolve();
    const write = previous.then(async () => {
      try {
        await saveSet(id, workoutExerciseId, setId, payload);
        replaceBlock(workoutExerciseId, (current) => ({
          ...current,
          rows: current.rows.map((item) => item.clientKey === key ? { ...item, set_id: setId } : item),
        }));
        setServerError(null);
        return true;
      } catch (error) {
        if (lastWrites.current.get(key) === signature) lastWrites.current.delete(key);
        setServerError(error.message || 'Could not save the set.');
        return false;
      }
    });
    pendingWrites.current.set(key, write);
    void write.then((success) => {
      if (success && pendingWrites.current.get(key) === write) pendingWrites.current.delete(key);
    });
    return write;
  };

  const handleRowRemove = async (workoutExerciseId, setIndex) => {
    const block = blocksRef.current.find(
      (item) => item.workout_exercise_id === workoutExerciseId
    );
    if (!block) return;
    const row = block.rows[setIndex];
    if (!row) return;
    await pendingWrites.current.get(row.clientKey);
    const setId = row.set_id ?? draftIds.current.get(row.clientKey);
    const stored = blocksRef.current.find((item) => item.workout_exercise_id === workoutExerciseId)
      ?.rows.find((item) => item.clientKey === row.clientKey)?.set_id;
    pendingWrites.current.delete(row.clientKey);
    draftIds.current.delete(row.clientKey);
    lastWrites.current.delete(row.clientKey);
    touchedRows.current.delete(row.clientKey);

    if (!stored) {
      replaceBlock(workoutExerciseId, (current) => ({
        ...current,
        rows:
          current.rows.length === 1
            ? [emptyDraftRow(current.exercise, current, weights[current.exercise.id])]
            : current.rows.filter((_, index) => index !== setIndex),
      }));
      return;
    }

    setBusy(true);
    setServerError(null);
    try {
      await deleteSet(id, workoutExerciseId, setId);
      replaceBlock(workoutExerciseId, (current) => {
        const next = current.rows.filter((_, index) => index !== setIndex);
        return {
          ...current,
          rows:
            next.length === 0
              ? [emptyDraftRow(current.exercise, current, weights[current.exercise.id])]
              : next,
        };
      });
    } catch (err) {
      setServerError(err?.message || 'Could not delete the set.');
    } finally {
      setBusy(false);
    }
  };

  const handleAddRow = (workoutExerciseId) => {
    replaceBlock(workoutExerciseId, (block) => ({
      ...block,
      rows: [
        ...block.rows,
        emptyDraftRow(block.exercise, {}, weights[block.exercise.id]),
      ],
    }));
  };

  const handleFinish = async () => {
    if (!(await Promise.all(pendingWrites.current.values())).every(Boolean)) return;
    const metaOk = await handleMetaBlur();
    if (!metaOk) return;
    setBusy(true);
    setServerError(null);
    try {
      const updated = await completeWorkout(id);
      setData(updated);
      navigate(`/workouts/${id}`, { replace: true });
    } catch (err) {
      setServerError(err?.message || 'Could not finish the workout.');
      setBusy(false);
    }
  };

  const openAssistant = async (workoutExerciseId = null) => {
    try {
      if (!navigator.onLine) throw new Error('The voice assistant requires a connection.');
      const context = await remoteWorkoutContext(id, workoutExerciseId);
      setAssistantContext(context);
      setAssistantOpen(true);
    } catch (error) {
      setServerError(error.message);
    }
  };

  const handleAssistantExecuted = async (executeResult) => {
    const created = createdWorkoutId(executeResult);
    if (created && String(created) !== String(assistantContext?.workoutId)) {
      navigate(`/workouts/${created}/edit`, { replace: true });
      return;
    }
    if (didFinishSession(executeResult)) {
      try {
        const updated = await getWorkout(id);
        setData(updated);
        if (updated.ended_at) {
          navigate(`/workouts/${id}`, { replace: true });
        }
      } catch {
        reload();
      }
      return;
    }
    if (shouldReloadSession(executeResult)) {
      try {
        const updated = await getWorkout(id);
        const next = buildBlocks(updated, weights);
        blocksRef.current = next;
        setBlocks(next);
        setData(updated);
      } catch {
        reload();
      }
    }
  };

  const selectedLabel = useMemo(
    () => (isActive ? 'Active session' : 'Completed session'),
    [isActive]
  );

  return (
    <PageContainer className="flex flex-col gap-6">
      <header className="flex items-center gap-2">
        <button
          type="button"
          onClick={() => navigate(`/workouts/${id}`)}
          aria-label="Back"
          className="inline-flex h-10 w-10 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <ArrowLeft className="h-5 w-5" aria-hidden="true" />
        </button>
        <div className="min-w-0 flex-1">
          <h1 className="text-2xl font-bold tracking-tight">Edit workout</h1>
          <p className="text-xs text-muted-foreground">{selectedLabel}</p>
        </div>
        <button
          type="button"
          onClick={() => openAssistant(null)}
          aria-label="Voice assistant"
          className="inline-flex h-10 w-10 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <Mic className="h-5 w-5" aria-hidden="true" />
        </button>
      </header>

      {loading ? (
        <StatusView
          icon={Loader2}
          spinIcon
          title="Loading workout…"
          description="Fetching the session details."
        />
      ) : error ? (
        <StatusView
          icon={AlertCircle}
          tone="destructive"
          title="Couldn't load workout"
          description={error}
        >
          <AppButton variant="outline" onClick={reload}>
            <RotateCw className="h-4 w-4" aria-hidden="true" />
            Try again
          </AppButton>
        </StatusView>
      ) : (
        <>
          <WorkoutForm
            name={name}
            date={date}
            onNameChange={setName}
            onDateChange={setDate}
            onMetaBlur={handleMetaBlur}
            exercises={blocks}
            onAddExercise={handleAddExercise}
            onRemoveExercise={handleRemoveExercise}
            onRowChange={handleRowChange}
            onRowCommit={handleRowCommit}
            onRowRemove={handleRowRemove}
            onAddRow={handleAddRow}
            onAskAssistant={openAssistant}
            onFinish={handleFinish}
            onSaveAsTemplate={() => setSaveOpen(true)}
            isActive={isActive}
            busy={busy}
            serverError={serverError}
          />
          <SaveAsTemplateDialog
            open={saveOpen}
            workoutId={id}
            workoutName={name}
            onClose={() => setSaveOpen(false)}
            onSaved={(template) => navigate(`/templates/${template.id}`)}
          />
          <VoiceAssistantSheet
            open={assistantOpen}
            onClose={() => setAssistantOpen(false)}
            workoutId={assistantContext?.workoutId}
            focusWorkoutExerciseId={assistantContext?.exerciseId}
            onExecuted={handleAssistantExecuted}
          />
        </>
      )}
    </PageContainer>
  );
}
