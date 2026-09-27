from pathlib import Path

import httpx2
from corvid.cli import app
from corvid.forecasting.confidence import ForecastStatus, QualityReason
from corvid.forecasting.types import KnowledgeSetRequest
from corvid.services.assessment import (
    TARGET_METRIC,
    TARGET_SOURCE_KEY,
    AssessmentService,
)
from corvid.storage import Database, UnitOfWork
from corvid.storage.models import ForecastRow, ObservationRow
from sqlalchemy import func, select
from typer.testing import CliRunner


def _database_path(data_dir: Path) -> Path:
    return data_dir / "corvid.db"


def _counts(data_dir: Path) -> tuple[int, int]:
    from corvid.storage import Database

    database = Database(f"sqlite+pysqlite:///{_database_path(data_dir).as_posix()}")
    try:
        with database.session() as session:
            observations = session.scalar(
                select(func.count()).select_from(ObservationRow)
            )
            forecasts = session.scalar(select(func.count()).select_from(ForecastRow))
        return int(observations or 0), int(forecasts or 0)
    finally:
        database.dispose()


def test_demo_bootstrap_is_offline_labeled_and_idempotent(monkeypatch, tmp_path):
    def deny_network(*args, **kwargs):
        raise AssertionError("demo bootstrap attempted a network request")

    monkeypatch.setattr(httpx2.Client, "send", deny_network)
    runner = CliRunner()

    first = runner.invoke(app, ["demo", "load", "--data-dir", str(tmp_path)])
    assert first.exit_code == 0, first.output
    assert "DEMO" in first.output
    assert "not current surveillance" in first.output
    first_counts = _counts(tmp_path)
    assert first_counts[0] >= 200
    assert first_counts[1] >= 1

    second = runner.invoke(app, ["demo", "load", "--data-dir", str(tmp_path)])
    assert second.exit_code == 0, second.output
    assert _counts(tmp_path) == first_counts
    assert (tmp_path / "demo-metadata.json").is_file()

    database = Database(
        f"sqlite+pysqlite:///{_database_path(tmp_path).as_posix()}"
    )
    try:
        published = AssessmentService(database, mode="demo").latest_published("ma")
        assert published.published_at.isoformat() == "2025-02-14T23:00:00+00:00"
        assert published.mode == "demo"
        with UnitOfWork(database) as work:
            selected = work.observations.observations_as_known_at(
                KnowledgeSetRequest(
                    geography_id="ma",
                    metric=TARGET_METRIC,
                    source_key=TARGET_SOURCE_KEY,
                    as_of=published.published_at,
                    require_authentic_vintage=False,
                )
            )
        assert selected
        assert all(not item.observation.authentic_vintage for item in selected)
        hsa_publication = AssessmentService(
            database, mode="demo"
        ).latest_published("ma-hsa-22")
        assert hsa_publication.forecast_status is ForecastStatus.UNAVAILABLE
        assert hsa_publication.point_estimate is None
        assert hsa_publication.direction is None
        assert hsa_publication.selected_model_key is None
        assert hsa_publication.selected_model_version is None
        assert (
            QualityReason.EXPERIMENTAL_HSA_LIMIT
            in hsa_publication.quality_skill.reasons
        )
    finally:
        database.dispose()


def test_demo_and_live_default_runtime_paths_are_isolated():
    from corvid.config import Settings

    demo = Settings(mode="demo")
    live = Settings(mode="live")

    assert demo.data_dir == Path("data/runtime/demo")
    assert live.data_dir == Path("data/runtime/live")
    assert demo.database_url != live.database_url
