from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0002"
down_revision: str | None = "0001"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    with op.batch_alter_table("backtest_results") as batch:
        batch.drop_constraint("uq_backtest_model_origin_target", type_="unique")
        batch.add_column(
            sa.Column(
                "disease",
                sa.String(length=64),
                nullable=False,
                server_default="influenza",
            )
        )
        batch.add_column(
            sa.Column(
                "metric",
                sa.String(length=128),
                nullable=False,
                server_default="ed_visit_percent",
            )
        )
        batch.create_unique_constraint(
            "uq_backtest_model_origin_target",
            (
                "model_key",
                "model_version",
                "geography_id",
                "disease",
                "metric",
                "forecast_origin",
                "target_end",
            ),
        )


def downgrade() -> None:
    with op.batch_alter_table("backtest_results") as batch:
        batch.drop_constraint("uq_backtest_model_origin_target", type_="unique")
        batch.drop_column("metric")
        batch.drop_column("disease")
        batch.create_unique_constraint(
            "uq_backtest_model_origin_target",
            (
                "model_key",
                "model_version",
                "geography_id",
                "forecast_origin",
                "target_end",
            ),
        )
