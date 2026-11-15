"""Add atomic, account-scoped receipts for workout replay."""

import sqlalchemy as sa
from alembic import op

revision = "49c73a76d1a4"
down_revision = "0153e917bf85"
branch_labels = None
depends_on = None


def upgrade():
    op.create_table(
        "workout_sync_receipts",
        sa.Column("user_id", sa.Integer(), sa.ForeignKey("users.id", ondelete="CASCADE"), primary_key=True),
        sa.Column("operation_id", sa.String(36), primary_key=True),
        sa.Column("fingerprint", sa.String(64), nullable=False),
        sa.Column("result", sa.JSON(), nullable=True),
    )


def downgrade():
    op.drop_table("workout_sync_receipts")
