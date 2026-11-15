"""Optimistic workout synchronization using an atomic write receipt."""

from hashlib import sha256
import json
from uuid import UUID

from pydantic import AwareDatetime, BaseModel, Field, model_validator
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.core.exceptions import ConflictError, NotFoundError
from app.templates import service as templates_service
from app.workouts import service
from app.workouts.models import Workout, WorkoutSyncReceipt
from app.workouts.schemas import WorkoutCreate, WorkoutDetail, WorkoutUpdate


class WorkoutMutation(BaseModel):
    operation_id: UUID
    workout_id: int | None = Field(default=None, gt=0)
    base_revision: str | None = Field(default=None, pattern=r"^[0-9a-f]{64}$")
    source_template_id: int | None = Field(default=None, gt=0)
    started_at: AwareDatetime | None = None
    ended_at: AwareDatetime | None = None
    workout: WorkoutUpdate | None = None

    @model_validator(mode="after")
    def validate_operation(self):
        if self.workout_id is None:
            if self.workout is None or self.started_at is None or self.base_revision:
                raise ValueError("A new workout needs its initial snapshot and start time")
        elif not self.base_revision:
            raise ValueError("An existing workout needs a base revision")
        if self.ended_at and self.started_at and self.ended_at < self.started_at:
            raise ValueError("End time must follow start time")
        return self


def fingerprint(value: dict) -> str:
    return sha256(json.dumps(value, sort_keys=True, separators=(",", ":")).encode()).hexdigest()


def detail_with_revision(workout: Workout) -> dict:
    detail = WorkoutDetail.model_validate(workout).model_dump(mode="json")
    content = {
        **detail,
        "exercises": [
            {**exercise, "exercise": exercise["exercise"]["id"]}
            for exercise in detail["exercises"]
        ],
    }
    return {**detail, "revision": fingerprint(content)}


def apply_mutation(db: Session, user_id: int, payload: WorkoutMutation) -> dict:
    operation_id = str(payload.operation_id)
    digest = fingerprint(payload.model_dump(mode="json", exclude_unset=True))
    receipt = WorkoutSyncReceipt(user_id=user_id, operation_id=operation_id, fingerprint=digest)
    try:
        # Insert before reading the workout. This takes the SQLite write lock
        # and serializes concurrent deliveries of the same key on PostgreSQL.
        db.add(receipt)
        db.flush()
    except IntegrityError:
        db.rollback()
        existing = db.get(WorkoutSyncReceipt, (user_id, operation_id))
        if existing is None:
            raise
        if existing.fingerprint != digest:
            raise ConflictError("Operation id was already used for different data")
        return existing.result

    if payload.workout_id is not None:
        row = db.scalar(
            select(Workout.id)
            .where(Workout.id == payload.workout_id, Workout.user_id == user_id)
            .with_for_update()
        )
        if row is None:
            raise NotFoundError("Workout was deleted or is unavailable")
        workout = service.get_workout(db, user_id, row)
        if detail_with_revision(workout)["revision"] != payload.base_revision:
            raise ConflictError("Workout changed on the server")
        if payload.workout is None:
            db.delete(workout)
            receipt.result = {"workout": None}
            db.commit()
            return {"workout": None}
        workout = service.update_workout(
            db, user_id, row, payload.workout, commit=False, strict_ids=True
        )
        if workout.ended_at is None and payload.ended_at is not None:
            workout.ended_at = max(workout.started_at, payload.ended_at)
    else:
        workout = service.create_workout(
            db, user_id, WorkoutCreate.model_validate(payload.workout.model_dump(exclude_unset=True)),
            commit=False,
        )
        if payload.source_template_id:
            try:
                template = templates_service.get_template(db, user_id, payload.source_template_id)
            except NotFoundError:
                # The frozen plan is still useful after the template is deleted.
                pass
            else:
                workout.source_template_id = template.id
        workout.started_at = payload.started_at
        workout.ended_at = payload.ended_at

    db.flush()
    result = {"workout": detail_with_revision(workout)}
    receipt.result = result
    db.commit()
    return result
