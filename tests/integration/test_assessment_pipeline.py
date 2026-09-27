from datetime import UTC, datetime, timedelta

from corvid.domain.enums import Disease, GeographyType
from corvid.domain.models import GeographyRecord, ObservationRecord, SourceRecord
from corvid.forecasting.confidence import ForecastStatus
from corvid.forecasting.types import EpiWeek
from corvid.services.assessment import AssessmentService
from corvid.services.pipeline import publish_statewide_disease_assessments
from corvid.storage.database import Database, UnitOfWork
from corvid.storage.models import ForecastRow, ForecastRunRow
from sqlalchemy import func, select


def _database_with_current_history(tmp_path):
    database = Database(f"sqlite+pysqlite:///{tmp_path / 'assessment.db'}")
    database.create_schema()
    as_of = datetime(2025, 2, 14, 23, tzinfo=UTC)
    latest = EpiWeek.from_end_date(as_of.date() + timedelta(days=1)).previous()
    weeks = [
        latest.previous().previous().previous(),
        latest.previous().previous(),
        latest.previous(),
        latest,
    ]
    with UnitOfWork(database) as work:
        work.sources.upsert_source(
            SourceRecord("nssp_ed", "CDC NSSP", "CDC", "https://cdc.example/official")
        )
        work.geographies.upsert_geography(
            GeographyRecord("ma", GeographyType.STATE, "Massachusetts", "MA")
        )
        work.observations.insert_observations(
            [
                ObservationRecord(
                    source_key="nssp_ed",
                    upstream_id=f"{disease.value}-week-{week.year}-{week.week}",
                    disease=disease,
                    metric="ed_visit_percent",
                    value=1.0 + disease_index + index / 10,
                    unit="percentage_points",
                    geography_id="ma",
                    observation_start=week.start_date(),
                    observation_end=week.end_date(),
                    issue_date=None,
                    issue_identity=f"v{index}",
                    retrieved_at=as_of - timedelta(hours=1),
                    reporting_coverage=0.95,
                    metadata={"vintage_kind": "authentic"},
                )
                for disease_index, disease in enumerate(Disease)
                for index, week in enumerate(weeks)
            ]
        )
    return database, as_of


def test_assessment_is_horizon_zero_deterministic_and_persisted(tmp_path):
    database, as_of = _database_with_current_history(tmp_path)
    assessment = AssessmentService(database).publish_latest("ma", as_of)
    assert assessment.forecast_status is ForecastStatus.AVAILABLE
    assert assessment.horizon == 0
    assert assessment.forecast_label == "current-week nowcast"
    assert assessment.selected_model_key == "no_change"
    assert assessment.direction.value == "stable"
    assert assessment.forecast_run_id is not None
    assert assessment.target_metric == "ed_visit_percent"
    assert (
        assessment.evidence[0].source_landing_page_url == "https://cdc.example/official"
    )
    with database.session() as session:
        assert session.scalar(select(func.count()).select_from(ForecastRunRow)) == 1
        assert session.scalar(select(func.count()).select_from(ForecastRow)) == 1
    persisted = AssessmentService(database).latest_published("ma")
    assert persisted.published_at == as_of
    assert persisted.forecast_run_id == assessment.forecast_run_id
    assert persisted.latest_observation == assessment.latest_observation
    database.dispose()


def test_later_unavailable_publication_replaces_latest_available_state(tmp_path):
    database, first_origin = _database_with_current_history(tmp_path)
    service = AssessmentService(database)
    available = service.publish_latest("ma", first_origin)

    next_origin = first_origin + timedelta(days=7)
    unavailable = service.publish_latest("ma", next_origin)

    assert available.forecast_status is ForecastStatus.AVAILABLE
    assert unavailable.forecast_status is ForecastStatus.UNAVAILABLE
    assert unavailable.point_estimate is None
    assert unavailable.direction is None
    assert unavailable.forecast_run_id is not None
    persisted = service.latest_published("ma")
    assert persisted.id == unavailable.id
    assert persisted.published_at == next_origin
    assert persisted.forecast_status is ForecastStatus.UNAVAILABLE
    assert persisted.point_estimate is None
    assert persisted.direction is None
    assert persisted.selected_model_key is None
    assert persisted.latest_observation == available.latest_observation
    with database.session() as session:
        assert session.scalar(select(func.count()).select_from(ForecastRunRow)) == 2
        assert session.scalar(select(func.count()).select_from(ForecastRow)) == 2
    database.dispose()


def test_same_scheduled_week_retry_is_idempotent_across_invocation_times(tmp_path):
    database, scheduled_origin = _database_with_current_history(tmp_path)
    service = AssessmentService(database)
    first_invocation = scheduled_origin + timedelta(hours=1)

    first = service.publish_latest("ma", first_invocation)
    retry = service.publish_latest("ma", scheduled_origin + timedelta(days=2))

    assert retry.forecast_run_id == first.forecast_run_id
    assert first.published_at == first_invocation
    assert retry.published_at == first_invocation
    with database.session() as session:
        assert session.scalar(select(func.count()).select_from(ForecastRunRow)) == 1
        assert session.scalar(select(func.count()).select_from(ForecastRow)) == 1
    database.dispose()


def test_live_late_retrieval_is_visible_but_missing_expected_week_withholds_nowcast(
    tmp_path,
):
    database = Database(f"sqlite+pysqlite:///{tmp_path / 'late-live.db'}")
    database.create_schema()
    actual_publication = datetime(2025, 2, 17, 15, tzinfo=UTC)
    observed_week = EpiWeek.from_end_date(
        actual_publication.date() - timedelta(days=9)
    ).previous()
    with UnitOfWork(database) as work:
        work.sources.upsert_source(
            SourceRecord("nssp_ed", "CDC NSSP", "CDC", "https://cdc.example/official")
        )
        work.geographies.upsert_geography(
            GeographyRecord("ma", GeographyType.STATE, "Massachusetts", "MA")
        )
        work.observations.insert_observations(
            [
                ObservationRecord(
                    source_key="nssp_ed",
                    upstream_id="late-retrieval",
                    disease=Disease.INFLUENZA,
                    metric="ed_visit_percent",
                    value=1.2,
                    unit="percentage_points",
                    geography_id="ma",
                    observation_start=observed_week.start_date(),
                    observation_end=observed_week.end_date(),
                    issue_date=None,
                    issue_identity="late-snapshot",
                    retrieved_at=actual_publication - timedelta(hours=1),
                )
            ]
        )

    assessment = AssessmentService(database, mode="live").publish_latest(
        "ma", actual_publication
    )

    assert assessment.latest_observation.epiweek == observed_week
    assert assessment.latest_observation.retrieved_at > datetime(
        2025, 2, 14, 23, tzinfo=UTC
    )
    assert assessment.forecast_status is ForecastStatus.UNAVAILABLE
    assert assessment.point_estimate is None
    persisted = AssessmentService(database, mode="live").latest_published("ma")
    assert persisted.latest_observation == assessment.latest_observation
    database.dispose()


def test_pipeline_publishes_one_statewide_assessment_per_disease(tmp_path):
    database, as_of = _database_with_current_history(tmp_path)

    count = publish_statewide_disease_assessments(
        database,
        source_key="nssp_ed",
        metric="ed_visit_percent",
        mode="live",
        as_of=as_of,
    )

    assert count == 3
    for disease in Disease:
        assessment = AssessmentService(
            database, mode="live", disease=disease
        ).latest_published("ma")
        assert assessment.disease is disease
        assert assessment.geography_type is GeographyType.STATE
        label = {
            Disease.INFLUENZA: "influenza",
            Disease.RSV: "RSV",
            Disease.COVID_19: "COVID-19",
        }[disease]
        assert any(label in item for item in assessment.limitations)
    database.dispose()
