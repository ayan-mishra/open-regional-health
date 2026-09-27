from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0001"
down_revision: str | None = None
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:


    op.create_table(
        "forecast_runs",
        sa.Column(
            "id",
            sa.BigInteger().with_variant(sa.Integer(), "sqlite"),
            autoincrement=True,
            nullable=False,
        ),
        sa.Column("run_key", sa.String(length=128), nullable=False),
        sa.Column("model_key", sa.String(length=128), nullable=False),
        sa.Column("model_version", sa.String(length=128), nullable=False),
        sa.Column("training_cutoff", sa.DateTime(timezone=True), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("feature_set", sa.JSON(), nullable=False),
        sa.Column("configuration", sa.JSON(), nullable=False),
        sa.Column("code_version", sa.String(length=128), nullable=False),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("run_key", name="uq_forecast_runs_run_key"),
    )
    op.create_index(
        "ix_forecast_runs_model_created",
        "forecast_runs",
        ["model_key", "created_at"],
        unique=False,
    )
    op.create_table(
        "geographies",
        sa.Column("id", sa.String(length=128), nullable=False),
        sa.Column("geography_type", sa.String(length=32), nullable=False),
        sa.Column("display_name", sa.Text(), nullable=False),
        sa.Column("state_code", sa.String(length=2), nullable=False),
        sa.Column("upstream_identifiers", sa.JSON(), nullable=False),
        sa.Column("member_counties", sa.JSON(), nullable=False),
        sa.Column("experimental", sa.Boolean(), nullable=False),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(
        "ix_geographies_type_state",
        "geographies",
        ["geography_type", "state_code"],
        unique=False,
    )
    op.create_table(
        "sources",
        sa.Column("key", sa.String(length=128), nullable=False),
        sa.Column("name", sa.Text(), nullable=False),
        sa.Column("organization", sa.Text(), nullable=False),
        sa.Column("landing_page_url", sa.Text(), nullable=False),
        sa.Column("endpoint_url", sa.Text(), nullable=True),
        sa.Column("update_cadence", sa.Text(), nullable=True),
        sa.Column("license_name", sa.Text(), nullable=True),
        sa.Column("allowed_use", sa.Text(), nullable=True),
        sa.Column("known_delay", sa.Text(), nullable=True),
        sa.Column("revision_policy", sa.Text(), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.PrimaryKeyConstraint("key"),
    )
    op.create_table(
        "backtest_results",
        sa.Column(
            "id",
            sa.BigInteger().with_variant(sa.Integer(), "sqlite"),
            autoincrement=True,
            nullable=False,
        ),
        sa.Column("model_key", sa.String(length=128), nullable=False),
        sa.Column("model_version", sa.String(length=128), nullable=False),
        sa.Column("geography_id", sa.String(length=128), nullable=False),
        sa.Column("evaluation_start", sa.Date(), nullable=False),
        sa.Column("evaluation_end", sa.Date(), nullable=False),
        sa.Column("forecast_origin", sa.DateTime(timezone=True), nullable=False),
        sa.Column("target_end", sa.Date(), nullable=False),
        sa.Column("predicted_value", sa.Float(), nullable=True),
        sa.Column("observed_value", sa.Float(), nullable=True),
        sa.Column("predicted_direction", sa.String(length=32), nullable=False),
        sa.Column("observed_direction", sa.String(length=32), nullable=True),
        sa.Column("direction_correct", sa.Boolean(), nullable=True),
        sa.Column("absolute_error", sa.Float(), nullable=True),
        sa.Column("squared_error", sa.Float(), nullable=True),
        sa.Column("confidence", sa.Float(), nullable=True),
        sa.Column("baseline_metadata", sa.JSON(), nullable=False),
        sa.ForeignKeyConstraint(
            ["geography_id"], ["geographies.id"], ondelete="RESTRICT"
        ),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint(
            "model_key",
            "model_version",
            "geography_id",
            "forecast_origin",
            "target_end",
            name="uq_backtest_model_origin_target",
        ),
    )
    op.create_index(
        "ix_backtests_model_geo_origin",
        "backtest_results",
        ["model_key", "geography_id", "forecast_origin"],
        unique=False,
    )
    op.create_index(
        "ix_backtests_geography_id",
        "backtest_results",
        ["geography_id"],
        unique=False,
    )
    op.create_table(
        "forecasts",
        sa.Column(
            "id",
            sa.BigInteger().with_variant(sa.Integer(), "sqlite"),
            autoincrement=True,
            nullable=False,
        ),
        sa.Column(
            "forecast_run_id",
            sa.BigInteger().with_variant(sa.Integer(), "sqlite"),
            nullable=False,
        ),
        sa.Column("geography_id", sa.String(length=128), nullable=False),
        sa.Column("target_start", sa.Date(), nullable=False),
        sa.Column("target_end", sa.Date(), nullable=False),
        sa.Column("point_estimate", sa.Float(), nullable=True),
        sa.Column("direction", sa.String(length=32), nullable=False),
        sa.Column("confidence", sa.Float(), nullable=False),
        sa.Column("source_availability", sa.JSON(), nullable=False),
        sa.Column("metadata", sa.JSON(), nullable=False),
        sa.ForeignKeyConstraint(
            ["forecast_run_id"], ["forecast_runs.id"], ondelete="CASCADE"
        ),
        sa.ForeignKeyConstraint(
            ["geography_id"], ["geographies.id"], ondelete="RESTRICT"
        ),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint(
            "forecast_run_id",
            "geography_id",
            "target_start",
            "target_end",
            name="uq_forecast_run_target",
        ),
    )
    op.create_index(
        "ix_forecasts_geo_target",
        "forecasts",
        ["geography_id", "target_end"],
        unique=False,
    )
    op.create_table(
        "ingestion_runs",
        sa.Column(
            "id",
            sa.BigInteger().with_variant(sa.Integer(), "sqlite"),
            autoincrement=True,
            nullable=False,
        ),
        sa.Column("source_key", sa.String(length=128), nullable=False),
        sa.Column("started_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("finished_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("status", sa.String(length=32), nullable=False),
        sa.Column("parser_version", sa.Text(), nullable=False),
        sa.Column("inserted_count", sa.Integer(), nullable=False),
        sa.Column("rejected_count", sa.Integer(), nullable=False),
        sa.Column("warnings", sa.JSON(), nullable=False),
        sa.Column("most_recent_observation_date", sa.Date(), nullable=True),
        sa.Column("error_message", sa.Text(), nullable=True),
        sa.ForeignKeyConstraint(["source_key"], ["sources.key"], ondelete="RESTRICT"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(
        "ix_ingestion_runs_source_started",
        "ingestion_runs",
        ["source_key", "started_at"],
        unique=False,
    )
    op.create_table(
        "raw_snapshots",
        sa.Column(
            "id",
            sa.BigInteger().with_variant(sa.Integer(), "sqlite"),
            autoincrement=True,
            nullable=False,
        ),
        sa.Column("source_key", sa.String(length=128), nullable=False),
        sa.Column("retrieved_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("request_url", sa.Text(), nullable=False),
        sa.Column("request_parameters", sa.JSON(), nullable=False),
        sa.Column("http_status", sa.Integer(), nullable=True),
        sa.Column("response_headers", sa.JSON(), nullable=False),
        sa.Column("sha256", sa.String(length=64), nullable=False),
        sa.Column("blob_path", sa.Text(), nullable=False),
        sa.Column("parser_version", sa.Text(), nullable=False),
        sa.Column("status", sa.String(length=32), nullable=False),
        sa.Column("error_message", sa.Text(), nullable=True),
        sa.ForeignKeyConstraint(["source_key"], ["sources.key"], ondelete="RESTRICT"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint(
            "source_key", "retrieved_at", "sha256", name="uq_raw_snapshot_retrieval"
        ),
    )
    op.create_index(
        "ix_raw_snapshots_source_retrieved",
        "raw_snapshots",
        ["source_key", "retrieved_at"],
        unique=False,
    )
    op.create_table(
        "observations",
        sa.Column(
            "id",
            sa.BigInteger().with_variant(sa.Integer(), "sqlite"),
            autoincrement=True,
            nullable=False,
        ),
        sa.Column("source_key", sa.String(length=128), nullable=False),
        sa.Column("upstream_id", sa.Text(), nullable=False),
        sa.Column("disease", sa.String(length=64), nullable=False),
        sa.Column("metric", sa.String(length=128), nullable=False),
        sa.Column("value", sa.Float(), nullable=False),
        sa.Column("unit", sa.String(length=64), nullable=False),
        sa.Column("geography_id", sa.String(length=128), nullable=False),
        sa.Column("observation_start", sa.Date(), nullable=False),
        sa.Column("observation_end", sa.Date(), nullable=False),
        sa.Column("issue_date", sa.Date(), nullable=True),
        sa.Column("issue_identity", sa.Text(), nullable=False),
        sa.Column("retrieved_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column(
            "raw_snapshot_id",
            sa.BigInteger().with_variant(sa.Integer(), "sqlite"),
            nullable=True,
        ),
        sa.Column("revision", sa.Text(), nullable=True),
        sa.Column("quality_flags", sa.JSON(), nullable=False),
        sa.Column("reporting_coverage", sa.Float(), nullable=True),
        sa.Column("metadata", sa.JSON(), nullable=False),
        sa.ForeignKeyConstraint(
            ["geography_id"], ["geographies.id"], ondelete="RESTRICT"
        ),
        sa.ForeignKeyConstraint(
            ["raw_snapshot_id"], ["raw_snapshots.id"], ondelete="RESTRICT"
        ),
        sa.ForeignKeyConstraint(["source_key"], ["sources.key"], ondelete="RESTRICT"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint(
            "source_key",
            "upstream_id",
            "geography_id",
            "metric",
            "observation_start",
            "observation_end",
            "issue_identity",
            name="uq_observation_issue_version",
        ),
    )
    op.create_index(
        "ix_observations_latest",
        "observations",
        ["geography_id", "metric", "observation_end", "issue_date"],
        unique=False,
    )
    op.create_index(
        "ix_observations_retrieved_at", "observations", ["retrieved_at"], unique=False
    )
    op.create_index(
        "ix_observations_raw_snapshot_id",
        "observations",
        ["raw_snapshot_id"],
        unique=False,
    )
    op.create_index(
        "ix_observations_source_upstream",
        "observations",
        ["source_key", "upstream_id"],
        unique=False,
    )
    op.create_table(
        "evidence_links",
        sa.Column(
            "id",
            sa.BigInteger().with_variant(sa.Integer(), "sqlite"),
            autoincrement=True,
            nullable=False,
        ),
        sa.Column(
            "forecast_id",
            sa.BigInteger().with_variant(sa.Integer(), "sqlite"),
            nullable=False,
        ),
        sa.Column(
            "observation_id",
            sa.BigInteger().with_variant(sa.Integer(), "sqlite"),
            nullable=False,
        ),
        sa.Column("rank", sa.Integer(), nullable=False),
        sa.ForeignKeyConstraint(["forecast_id"], ["forecasts.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(
            ["observation_id"], ["observations.id"], ondelete="RESTRICT"
        ),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint(
            "forecast_id", "observation_id", name="uq_evidence_forecast_observation"
        ),
    )
    op.create_index(
        "ix_evidence_observation", "evidence_links", ["observation_id"], unique=False
    )



def downgrade() -> None:


    op.drop_index("ix_evidence_observation", table_name="evidence_links")
    op.drop_table("evidence_links")
    op.drop_index("ix_observations_source_upstream", table_name="observations")
    op.drop_index("ix_observations_raw_snapshot_id", table_name="observations")
    op.drop_index("ix_observations_retrieved_at", table_name="observations")
    op.drop_index("ix_observations_latest", table_name="observations")
    op.drop_table("observations")
    op.drop_index("ix_raw_snapshots_source_retrieved", table_name="raw_snapshots")
    op.drop_table("raw_snapshots")
    op.drop_index("ix_ingestion_runs_source_started", table_name="ingestion_runs")
    op.drop_table("ingestion_runs")
    op.drop_index("ix_forecasts_geo_target", table_name="forecasts")
    op.drop_table("forecasts")
    op.drop_index("ix_backtests_model_geo_origin", table_name="backtest_results")
    op.drop_index("ix_backtests_geography_id", table_name="backtest_results")
    op.drop_table("backtest_results")
    op.drop_table("sources")
    op.drop_index("ix_geographies_type_state", table_name="geographies")
    op.drop_table("geographies")
    op.drop_index("ix_forecast_runs_model_created", table_name="forecast_runs")
    op.drop_table("forecast_runs")
