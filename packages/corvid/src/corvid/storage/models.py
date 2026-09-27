from datetime import UTC, date, datetime
from typing import Any

from sqlalchemy import (
    JSON,
    BigInteger,
    Boolean,
    Date,
    DateTime,
    Float,
    ForeignKey,
    Index,
    Integer,
    String,
    Text,
    UniqueConstraint,
)
from sqlalchemy.engine import Dialect
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column
from sqlalchemy.types import TypeDecorator


def utc_now() -> datetime:


    return datetime.now(UTC)


class UTCDateTime(TypeDecorator[datetime]):


    impl = DateTime(timezone=True)
    cache_ok = True

    def process_bind_param(
        self, value: datetime | None, dialect: Dialect
    ) -> datetime | None:
        del dialect
        if value is None:
            return None
        if value.tzinfo is None or value.utcoffset() is None:
            raise ValueError("timestamps must be timezone-aware")
        return value.astimezone(UTC)

    def process_result_value(
        self, value: datetime | None, dialect: Dialect
    ) -> datetime | None:
        del dialect
        if value is None:
            return None
        if value.tzinfo is None:
            return value.replace(tzinfo=UTC)
        return value.astimezone(UTC)


class Base(DeclarativeBase):
    pass


PRIMARY_KEY_TYPE = BigInteger().with_variant(Integer, "sqlite")


class SourceRow(Base):
    __tablename__ = "sources"

    key: Mapped[str] = mapped_column(String(128), primary_key=True)
    name: Mapped[str] = mapped_column(Text, nullable=False)
    organization: Mapped[str] = mapped_column(Text, nullable=False)
    landing_page_url: Mapped[str] = mapped_column(Text, nullable=False)
    endpoint_url: Mapped[str | None] = mapped_column(Text)
    update_cadence: Mapped[str | None] = mapped_column(Text)
    license_name: Mapped[str | None] = mapped_column(Text)
    allowed_use: Mapped[str | None] = mapped_column(Text)
    known_delay: Mapped[str | None] = mapped_column(Text)
    revision_policy: Mapped[str | None] = mapped_column(Text)
    created_at: Mapped[datetime] = mapped_column(UTCDateTime(), default=utc_now)
    updated_at: Mapped[datetime] = mapped_column(
        UTCDateTime(), default=utc_now, onupdate=utc_now
    )


class RawSnapshotRow(Base):
    __tablename__ = "raw_snapshots"
    __table_args__ = (
        UniqueConstraint(
            "source_key", "retrieved_at", "sha256", name="uq_raw_snapshot_retrieval"
        ),
        Index("ix_raw_snapshots_source_retrieved", "source_key", "retrieved_at"),
    )

    id: Mapped[int] = mapped_column(
        PRIMARY_KEY_TYPE, primary_key=True, autoincrement=True
    )
    source_key: Mapped[str] = mapped_column(
        ForeignKey("sources.key", ondelete="RESTRICT"), nullable=False
    )
    retrieved_at: Mapped[datetime] = mapped_column(UTCDateTime(), nullable=False)
    request_url: Mapped[str] = mapped_column(Text, nullable=False)
    request_parameters: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)
    http_status: Mapped[int | None] = mapped_column(Integer)
    response_headers: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)
    sha256: Mapped[str] = mapped_column(String(64), nullable=False)
    blob_path: Mapped[str] = mapped_column(Text, nullable=False)
    parser_version: Mapped[str] = mapped_column(Text, nullable=False)
    status: Mapped[str] = mapped_column(String(32), nullable=False)
    error_message: Mapped[str | None] = mapped_column(Text)


class IngestionRunRow(Base):
    __tablename__ = "ingestion_runs"
    __table_args__ = (
        Index("ix_ingestion_runs_source_started", "source_key", "started_at"),
    )

    id: Mapped[int] = mapped_column(
        PRIMARY_KEY_TYPE, primary_key=True, autoincrement=True
    )
    source_key: Mapped[str] = mapped_column(
        ForeignKey("sources.key", ondelete="RESTRICT"), nullable=False
    )
    started_at: Mapped[datetime] = mapped_column(UTCDateTime(), nullable=False)
    finished_at: Mapped[datetime | None] = mapped_column(UTCDateTime())
    status: Mapped[str] = mapped_column(String(32), nullable=False)
    parser_version: Mapped[str] = mapped_column(Text, nullable=False)
    inserted_count: Mapped[int] = mapped_column(Integer, default=0)
    rejected_count: Mapped[int] = mapped_column(Integer, default=0)
    warnings: Mapped[list[Any]] = mapped_column(JSON, default=list)
    most_recent_observation_date: Mapped[date | None] = mapped_column(Date)
    error_message: Mapped[str | None] = mapped_column(Text)


class GeographyRow(Base):
    __tablename__ = "geographies"
    __table_args__ = (
        Index("ix_geographies_type_state", "geography_type", "state_code"),
    )

    id: Mapped[str] = mapped_column(String(128), primary_key=True)
    geography_type: Mapped[str] = mapped_column(String(32), nullable=False)
    display_name: Mapped[str] = mapped_column(Text, nullable=False)
    state_code: Mapped[str] = mapped_column(String(2), nullable=False)
    upstream_identifiers: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)
    member_counties: Mapped[list[str]] = mapped_column(JSON, default=list)
    experimental: Mapped[bool] = mapped_column(Boolean, default=False)


class ObservationRow(Base):
    __tablename__ = "observations"
    __table_args__ = (
        UniqueConstraint(
            "source_key",
            "upstream_id",
            "geography_id",
            "metric",
            "observation_start",
            "observation_end",
            "issue_identity",
            name="uq_observation_issue_version",
        ),
        Index(
            "ix_observations_latest",
            "geography_id",
            "metric",
            "observation_end",
            "issue_date",
        ),
        Index("ix_observations_source_upstream", "source_key", "upstream_id"),
        Index("ix_observations_retrieved_at", "retrieved_at"),
        Index("ix_observations_raw_snapshot_id", "raw_snapshot_id"),
    )

    id: Mapped[int] = mapped_column(
        PRIMARY_KEY_TYPE, primary_key=True, autoincrement=True
    )
    source_key: Mapped[str] = mapped_column(
        ForeignKey("sources.key", ondelete="RESTRICT"), nullable=False
    )
    upstream_id: Mapped[str] = mapped_column(Text, nullable=False)
    disease: Mapped[str] = mapped_column(String(64), nullable=False)
    metric: Mapped[str] = mapped_column(String(128), nullable=False)
    value: Mapped[float] = mapped_column(Float, nullable=False)
    unit: Mapped[str] = mapped_column(String(64), nullable=False)
    geography_id: Mapped[str] = mapped_column(
        ForeignKey("geographies.id", ondelete="RESTRICT"), nullable=False
    )
    observation_start: Mapped[date] = mapped_column(Date, nullable=False)
    observation_end: Mapped[date] = mapped_column(Date, nullable=False)
    issue_date: Mapped[date | None] = mapped_column(Date)
    issue_identity: Mapped[str] = mapped_column(Text, nullable=False)
    retrieved_at: Mapped[datetime] = mapped_column(UTCDateTime(), nullable=False)
    raw_snapshot_id: Mapped[int | None] = mapped_column(
        ForeignKey("raw_snapshots.id", ondelete="RESTRICT")
    )
    revision: Mapped[str | None] = mapped_column(Text)
    quality_flags: Mapped[list[str]] = mapped_column(JSON, default=list)
    reporting_coverage: Mapped[float | None] = mapped_column(Float)
    details: Mapped[dict[str, Any]] = mapped_column("metadata", JSON, default=dict)


class ForecastRunRow(Base):
    __tablename__ = "forecast_runs"
    __table_args__ = (
        Index("ix_forecast_runs_model_created", "model_key", "created_at"),
        UniqueConstraint("run_key", name="uq_forecast_runs_run_key"),
    )

    id: Mapped[int] = mapped_column(
        PRIMARY_KEY_TYPE, primary_key=True, autoincrement=True
    )
    run_key: Mapped[str] = mapped_column(String(128), nullable=False)
    model_key: Mapped[str] = mapped_column(String(128), nullable=False)
    model_version: Mapped[str] = mapped_column(String(128), nullable=False)
    training_cutoff: Mapped[datetime] = mapped_column(UTCDateTime(), nullable=False)
    created_at: Mapped[datetime] = mapped_column(UTCDateTime(), default=utc_now)
    feature_set: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)
    configuration: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)
    code_version: Mapped[str] = mapped_column(String(128), nullable=False)


class ForecastRow(Base):
    __tablename__ = "forecasts"
    __table_args__ = (
        UniqueConstraint(
            "forecast_run_id",
            "geography_id",
            "target_start",
            "target_end",
            name="uq_forecast_run_target",
        ),
        Index("ix_forecasts_geo_target", "geography_id", "target_end"),
    )

    id: Mapped[int] = mapped_column(
        PRIMARY_KEY_TYPE, primary_key=True, autoincrement=True
    )
    forecast_run_id: Mapped[int] = mapped_column(
        ForeignKey("forecast_runs.id", ondelete="CASCADE"), nullable=False
    )
    geography_id: Mapped[str] = mapped_column(
        ForeignKey("geographies.id", ondelete="RESTRICT"), nullable=False
    )
    target_start: Mapped[date] = mapped_column(Date, nullable=False)
    target_end: Mapped[date] = mapped_column(Date, nullable=False)
    point_estimate: Mapped[float | None] = mapped_column(Float)
    direction: Mapped[str] = mapped_column(String(32), nullable=False)
    confidence: Mapped[float] = mapped_column(Float, nullable=False)
    source_availability: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)
    details: Mapped[dict[str, Any]] = mapped_column("metadata", JSON, default=dict)


class EvidenceLinkRow(Base):
    __tablename__ = "evidence_links"
    __table_args__ = (
        UniqueConstraint(
            "forecast_id", "observation_id", name="uq_evidence_forecast_observation"
        ),
        Index("ix_evidence_observation", "observation_id"),
    )

    id: Mapped[int] = mapped_column(
        PRIMARY_KEY_TYPE, primary_key=True, autoincrement=True
    )
    forecast_id: Mapped[int] = mapped_column(
        ForeignKey("forecasts.id", ondelete="CASCADE"), nullable=False
    )
    observation_id: Mapped[int] = mapped_column(
        ForeignKey("observations.id", ondelete="RESTRICT"), nullable=False
    )
    rank: Mapped[int] = mapped_column(Integer, nullable=False)


class BacktestResultRow(Base):
    __tablename__ = "backtest_results"
    __table_args__ = (
        UniqueConstraint(
            "model_key",
            "model_version",
            "geography_id",
            "disease",
            "metric",
            "forecast_origin",
            "target_end",
            name="uq_backtest_model_origin_target",
        ),
        Index(
            "ix_backtests_model_geo_origin",
            "model_key",
            "geography_id",
            "forecast_origin",
        ),
        Index("ix_backtests_geography_id", "geography_id"),
    )

    id: Mapped[int] = mapped_column(
        PRIMARY_KEY_TYPE, primary_key=True, autoincrement=True
    )
    model_key: Mapped[str] = mapped_column(String(128), nullable=False)
    model_version: Mapped[str] = mapped_column(String(128), nullable=False)
    geography_id: Mapped[str] = mapped_column(
        ForeignKey("geographies.id", ondelete="RESTRICT"), nullable=False
    )
    disease: Mapped[str] = mapped_column(String(64), nullable=False)
    metric: Mapped[str] = mapped_column(String(128), nullable=False)
    evaluation_start: Mapped[date] = mapped_column(Date, nullable=False)
    evaluation_end: Mapped[date] = mapped_column(Date, nullable=False)
    forecast_origin: Mapped[datetime] = mapped_column(UTCDateTime(), nullable=False)
    target_end: Mapped[date] = mapped_column(Date, nullable=False)
    predicted_value: Mapped[float | None] = mapped_column(Float)
    observed_value: Mapped[float | None] = mapped_column(Float)
    predicted_direction: Mapped[str] = mapped_column(String(32), nullable=False)
    observed_direction: Mapped[str | None] = mapped_column(String(32))
    direction_correct: Mapped[bool | None] = mapped_column(Boolean)
    absolute_error: Mapped[float | None] = mapped_column(Float)
    squared_error: Mapped[float | None] = mapped_column(Float)
    confidence: Mapped[float | None] = mapped_column(Float)
    baseline_metadata: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)
