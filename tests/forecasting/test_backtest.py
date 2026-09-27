from datetime import UTC, date, datetime, timedelta

import pytest
from corvid.domain.enums import Disease, GeographyType
from corvid.domain.models import GeographyRecord, ObservationRecord, SourceRecord
from corvid.forecasting.backtest import Backtester, ForecastOrigin
from corvid.forecasting.baselines import NoChange
from corvid.forecasting.types import (
    EpiWeek,
    EvaluationTargetPolicy,
    KnowledgeSetRequest,
)
from corvid.storage.database import Database
from corvid.storage.repositories import (
    GeographyRepository,
    ObservationRepository,
    SourceRepository,
)


@pytest.fixture
def repository(tmp_path):
    database = Database(f"sqlite+pysqlite:///{tmp_path / 'backtest.db'}")
    database.create_schema()
    with database.session() as session:
        SourceRepository(session).upsert_source(
            SourceRecord("nssp_ed", "CDC NSSP", "CDC", "https://cdc.example/nssp")
        )
        GeographyRepository(session).upsert_geography(
            GeographyRecord("ma", GeographyType.STATE, "Massachusetts", "MA")
        )
        yield ObservationRepository(session), session
    database.dispose()


def _observation(week, value, retrieved_at, issue_identity):
    return ObservationRecord(
        source_key="nssp_ed",
        upstream_id=f"week-{week.year}-{week.week}",
        disease=Disease.INFLUENZA,
        metric="ed_visit_percent",
        value=value,
        unit="percentage_points",
        geography_id="ma",
        observation_start=week.start_date(),
        observation_end=week.end_date(),
        issue_date=None,
        issue_identity=issue_identity,
        retrieved_at=retrieved_at,
        metadata={"vintage_kind": "authentic"},
    )


def test_later_collected_revision_cannot_enter_earlier_origin(repository):
    repo, session = repository
    week = EpiWeek.from_end_date(date(2025, 1, 4))
    repo.insert_observations(
        [
            _observation(week, 1.0, datetime(2025, 1, 10, tzinfo=UTC), "v1"),
            _observation(week, 9.0, datetime(2025, 2, 10, tzinfo=UTC), "v2"),
        ]
    )
    session.flush()
    request = KnowledgeSetRequest(
        "ma",
        "ed_visit_percent",
        "nssp_ed",
        datetime(2025, 1, 15, tzinfo=UTC),
    )
    history = Backtester(repo).knowledge_set(request)
    assert [point.value for point in history.points] == [1.0]


def test_backtest_uses_named_56_day_vintage_and_separate_direction_truth(repository):
    repo, session = repository
    target = EpiWeek.from_end_date(date(2025, 2, 1))
    origin = datetime(2025, 1, 31, 23, tzinfo=UTC)
    weeks = [
        target.previous().previous().previous(),
        target.previous().previous(),
        target.previous(),
    ]
    repo.insert_observations(
        [
            _observation(week, value, origin - timedelta(days=1), f"origin-{index}")
            for index, (week, value) in enumerate(
                zip(weeks, [0.8, 0.9, 1.0], strict=True)
            )
        ]
    )
    evaluation_at = EvaluationTargetPolicy().evaluation_as_of(target)
    repo.insert_observations(
        [
            _observation(
                target.previous(),
                1.2,
                evaluation_at - timedelta(days=2),
                "fixed-current",
            ),
            _observation(
                target, 1.15, evaluation_at - timedelta(days=1), "fixed-target"
            ),
            _observation(target, 9.0, evaluation_at + timedelta(days=1), "too-late"),
        ]
    )
    session.flush()
    request = KnowledgeSetRequest("ma", "ed_visit_percent", "nssp_ed", origin)
    results = Backtester(repo).run(
        (NoChange(),), request, (ForecastOrigin(origin, target),)
    )
    assert len(results) == 1
    result = results[0]
    assert result.evaluation_policy_key == "nssp-fixed-lag-56d-v1"
    assert result.observed_value == 1.15
    assert result.observed_direction.value == "rising"
    assert result.fixed_lag_trajectory_direction.value == "stable"
