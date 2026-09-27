from dataclasses import replace
from datetime import UTC, date, datetime, timedelta

from conftest import observation
from corvid.domain.enums import Direction, Disease
from corvid.domain.models import ForecastRecord
from corvid.storage.models import (
    EvidenceLinkRow,
    ForecastRow,
    ForecastRunRow,
    ObservationRow,
)
from corvid.storage.repositories import (
    ForecastRepository,
    ObservationRepository,
    ProvenanceConflictError,
)
from sqlalchemy import func, select
from sqlalchemy.exc import IntegrityError


def test_issue_versions_are_preserved(session):
    repo = ObservationRepository(session)
    repo.insert_many([observation(issue_date=date(2026, 1, 10), value=1.2)])
    repo.insert_many([observation(issue_date=date(2026, 1, 17), value=1.4)])

    assert repo.count() == 2


def test_revision_only_versions_are_preserved(session):
    repo = ObservationRepository(session)
    original = observation(issue_date=date(2026, 1, 10), value=1.2)

    repo.insert_many([replace(original, revision="1")])
    repo.insert_many([replace(original, revision="2", value=1.4)])

    assert repo.count() == 2


def test_reingesting_same_issue_is_idempotent(session):
    repo = ObservationRepository(session)
    record = observation(issue_date=date(2026, 1, 10), value=1.2)

    assert repo.insert_observations([record]) == 1
    assert repo.insert_observations([record]) == 0
    assert repo.count() == 1


def test_reingesting_same_issue_ignores_later_retrieval_timestamp(session):
    repo = ObservationRepository(session)
    record = observation(issue_date=date(2026, 1, 10), value=1.2)

    assert repo.insert_observations([record]) == 1
    assert repo.insert_observations(
        [replace(record, retrieved_at=datetime(2026, 1, 20, tzinfo=UTC))]
    ) == 0
    assert repo.count() == 1


def test_same_issue_identity_with_different_content_is_a_conflict(session):
    repo = ObservationRepository(session)
    record = observation(issue_date=date(2026, 1, 10), value=1.2)
    repo.insert_observations([record])

    try:
        repo.insert_observations([replace(record, value=9.9)])
    except ProvenanceConflictError:
        pass
    else:
        raise AssertionError("conflicting provenance was silently ignored")


def test_insert_does_not_misclassify_foreign_key_errors_as_duplicates(session):
    repo = ObservationRepository(session)
    invalid = replace(
        observation(issue_date=date(2026, 1, 10), value=1.2),
        source_key="missing-source",
    )

    try:
        repo.insert_observations([invalid])
    except IntegrityError:
        pass
    else:
        raise AssertionError("foreign key violation was silently ignored")


def test_observations_as_known_at_select_latest_available_issue(session):
    repo = ObservationRepository(session)
    repo.insert_many(
        [
            observation(issue_date=date(2026, 1, 10), value=1.2),
            observation(issue_date=date(2026, 1, 17), value=1.4),
            observation(
                issue_date=date(2026, 1, 12),
                value=2.0,
                upstream_id="2026-W02",
            ),
        ]
    )

    records = repo.observations_as_known_at("ma", datetime(2026, 1, 13, tzinfo=UTC))

    assert [(record.upstream_id, record.value) for record in records] == [
        ("2026-W01", 1.2),
        ("2026-W02", 2.0),
    ]
    assert repo.observations_as_known_at("ma", date(2026, 1, 13)) == records


def test_observations_as_known_at_excludes_same_day_later_retrieval(session):
    repo = ObservationRepository(session)
    repo.insert_many(
        [
            observation(
                issue_date=date(2026, 1, 3),
                value=1.0,
                retrieved_at=datetime(2026, 1, 3, 12, tzinfo=UTC),
            ),
            observation(
                issue_date=date(2026, 1, 10),
                value=9.0,
                retrieved_at=datetime(2026, 1, 10, 12, tzinfo=UTC),
            ),
        ]
    )

    before_retrieval = repo.observations_as_known_at(
        "ma", datetime(2026, 1, 10, 0, 1, tzinfo=UTC)
    )
    after_retrieval = repo.observations_as_known_at(
        "ma", datetime(2026, 1, 10, 12, 1, tzinfo=UTC)
    )

    assert [record.value for record in before_retrieval] == [1.0]
    assert [record.value for record in after_retrieval] == [9.0]


def test_latest_observation_returns_latest_interval_and_issue(session):
    repo = ObservationRepository(session)
    repo.insert_many(
        [
            observation(issue_date=date(2026, 1, 10), value=1.2),
            observation(issue_date=date(2026, 1, 17), value=1.4),
        ]
    )

    latest = repo.latest_observation("ma", "ed_visits_pct")

    assert latest is not None
    assert latest.value == 1.4


def test_forecast_run_and_evidence_are_idempotent(session, monkeypatch):
    observations = ObservationRepository(session)
    observations.insert_many([observation(issue_date=date(2026, 1, 10), value=1.2)])
    observation_id = session.scalar(select(ObservationRow.id))
    assert observation_id is not None
    forecast = ForecastRecord(
        geography_id="ma",
        target_start=date(2026, 1, 11),
        target_end=date(2026, 1, 17),
        point_estimate=1.3,
        direction=Direction.RISING,
        confidence=0.7,
        evidence_observation_ids=(observation_id,),
    )
    repository = ForecastRepository(session)
    arguments = {
        "run_key": "ma-2026-01-10-no-change-v1",
        "model_key": "no_change",
        "model_version": "1",
        "training_cutoff": datetime(2026, 1, 10, 12, tzinfo=UTC),
        "feature_set": {"metrics": ["ed_visits_pct"]},
        "configuration": {"threshold": 0.1},
        "code_version": "test",
        "forecasts": [forecast],
    }

    first_id = repository.save_forecast_run(**arguments)
    second_id = repository.save_forecast_run(**arguments)

    assert first_id == second_id
    assert session.scalar(select(func.count()).select_from(ForecastRunRow)) == 1
    assert session.scalar(select(func.count()).select_from(ForecastRow)) == 1
    assert session.scalar(select(func.count()).select_from(EvidenceLinkRow)) == 1

    racing_repository = ForecastRepository(session)
    real_find = racing_repository._find_run
    lookup_count = 0

    def miss_first_lookup(run_key):
        nonlocal lookup_count
        lookup_count += 1
        return None if lookup_count == 1 else real_find(run_key)

    monkeypatch.setattr(racing_repository, "_find_run", miss_first_lookup)
    assert racing_repository.save_forecast_run(**arguments) == first_id
    assert session.scalar(select(func.count()).select_from(ForecastRunRow)) == 1

    arguments["feature_set"]["metrics"].append("caller-mutation")
    persisted_run = session.scalar(select(ForecastRunRow))
    assert persisted_run is not None
    assert persisted_run.feature_set == {"metrics": ["ed_visits_pct"]}
    try:
        repository.save_forecast_run(**arguments)
    except ProvenanceConflictError:
        pass
    else:
        raise AssertionError("caller mutation bypassed replay-conflict detection")

    conflicting_arguments = dict(arguments)
    conflicting_arguments["configuration"] = {"threshold": 9.9}
    try:
        repository.save_forecast_run(**conflicting_arguments)
    except ProvenanceConflictError:
        pass
    else:
        raise AssertionError("conflicting forecast run was silently ignored")


def test_latest_published_filters_configuration_before_its_query_bound(session):
    target_created_at = datetime(2026, 1, 1, 12, tzinfo=UTC)
    target_run = ForecastRunRow(
        run_key="matching-covid-nowcast",
        model_key="test",
        model_version="1",
        training_cutoff=target_created_at,
        created_at=target_created_at,
        feature_set={},
        configuration={
            "target_source_key": "nssp",
            "target_metric": "ed_visits_pct",
            "target_disease": "covid-19",
            "forecast_horizon": 0,
            "forecast_label": "current-week nowcast",
        },
        code_version="test",
    )
    session.add(target_run)
    session.flush()
    target_forecast = ForecastRow(
        forecast_run_id=target_run.id,
        geography_id="ma",
        target_start=date(2026, 1, 4),
        target_end=date(2026, 1, 10),
        point_estimate=1.0,
        direction="stable",
        confidence=0.5,
        source_availability={},
        details={},
    )
    session.add(target_forecast)
    for index in range(100):
        created_at = target_created_at + timedelta(days=1, minutes=index)
        run = ForecastRunRow(
            run_key=f"newer-influenza-nowcast-{index}",
            model_key="test",
            model_version="1",
            training_cutoff=created_at,
            created_at=created_at,
            feature_set={},
            configuration={
                "target_source_key": "nssp",
                "target_metric": "ed_visits_pct",
                "target_disease": "influenza",
                "forecast_horizon": 0,
                "forecast_label": "current-week nowcast",
            },
            code_version="test",
        )
        session.add(run)
        session.flush()
        session.add(
            ForecastRow(
                forecast_run_id=run.id,
                geography_id="ma",
                target_start=date(2026, 1, 4),
                target_end=date(2026, 1, 10),
                point_estimate=2.0,
                direction="stable",
                confidence=0.5,
                source_availability={},
                details={},
            )
        )
    session.flush()

    published = ForecastRepository(session).latest_published(
        "ma",
        source_key="nssp",
        metric="ed_visits_pct",
        disease=Disease.COVID_19,
    )

    assert published is not None
    assert published[0].id == target_run.id
    assert published[1].id == target_forecast.id


def test_nested_metadata_mutation_cannot_change_replay_identity(session):
    metadata = {"method": {"codes": ["a"]}}
    record = replace(
        observation(issue_date=date(2026, 1, 10), value=1.2), metadata=metadata
    )
    repository = ObservationRepository(session)
    repository.insert_observations([record])

    metadata["method"]["codes"].append("mutated")

    assert record.metadata["method"]["codes"] == ("a",)
    assert repository.insert_observations([record]) == 0
