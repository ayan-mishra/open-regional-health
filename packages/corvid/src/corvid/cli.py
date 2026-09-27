from __future__ import annotations

from datetime import UTC, datetime
from pathlib import Path
from typing import Annotated

import typer
from alembic import command
from alembic.config import Config as AlembicConfig

from corvid.config import Settings
from corvid.ingestion.registry import default_registry
from corvid.ingestion.runner import IngestionRunner
from corvid.services.assessment import TARGET_METRIC, TARGET_SOURCE_KEY
from corvid.services.demo import load_demo_data
from corvid.services.pipeline import (
    PipelineOrchestrator,
    PipelineSummary,
    has_fresh_primary,
    publish_database_forecasts,
    publish_statewide_disease_assessments,
    run_database_backtests,
    run_database_backtests_for_diseases,
    target_geography_ids,
)
from corvid.storage import Database, LocalBlobStore

app = typer.Typer(
    name="corvid",
    help="Run Corvid's offline demo or explicit live surveillance workflow.",
    no_args_is_help=True,
)
db_app = typer.Typer(help="Manage the Corvid database schema.")
demo_app = typer.Typer(help="Manage deterministic offline demonstration data.")
app.add_typer(db_app, name="db")
app.add_typer(demo_app, name="demo")

DataDirOption = Annotated[
    Path | None,
    typer.Option("--data-dir", help="Runtime directory for this command."),
]
DatabaseUrlOption = Annotated[
    str | None,
    typer.Option("--database-url", help="SQLAlchemy database URL override."),
]

LIVE_SOURCE_KEY = TARGET_SOURCE_KEY
LIVE_TARGET_METRIC = TARGET_METRIC


@db_app.command("upgrade")
def db_upgrade(
    data_dir: DataDirOption = None,
    database_url: DatabaseUrlOption = None,
) -> None:


    settings = _settings(data_dir=data_dir, database_url=database_url)
    _upgrade(settings)
    typer.echo(f"database upgraded ({settings.mode}): {settings.data_dir}")


@demo_app.command("load")
def demo_load(
    data_dir: DataDirOption = None,
    database_url: DatabaseUrlOption = None,
) -> None:


    settings = _settings(data_dir=data_dir, database_url=database_url)
    if settings.mode != "demo":
        raise typer.BadParameter("demo load requires CORVID_MODE=demo")
    _upgrade(settings)
    database = Database(settings.database_url)
    try:
        summary = load_demo_data(
            database,
            data_dir=settings.data_dir,
            fixture_dir=_project_root() / "data" / "demo",
        )
    finally:
        database.dispose()
    typer.echo("DEMO dataset ready (offline, deterministic)")
    typer.echo(summary.disclaimer)
    typer.echo(
        "observations="
        f"{summary.inserted_observations} backtests={summary.inserted_backtests} "
        f"assessments={summary.published_assessments} as_of={summary.as_of.isoformat()}"
    )


@app.command("ingest")
def ingest(
    source: Annotated[
        str | None, typer.Option("--source", help="Fixed connector registry key.")
    ] = None,
    all_sources: Annotated[
        bool, typer.Option("--all", help="Run every fixed registry connector.")
    ] = False,
    data_dir: DataDirOption = None,
    database_url: DatabaseUrlOption = None,
) -> None:


    settings = _settings(data_dir=data_dir, database_url=database_url)
    _require_live(settings)
    if (source is None) == (not all_sources):
        raise typer.BadParameter("choose exactly one of --source or --all")
    registry = default_registry()
    source_keys = registry.keys() if all_sources else (source,)
    assert all(key is not None for key in source_keys)
    unknown = [key for key in source_keys if key not in registry.keys()]
    if unknown:
        raise typer.BadParameter(f"unknown source key: {unknown[0]}")
    _upgrade(settings)
    database = Database(settings.database_url)
    runner = IngestionRunner(
        database=database,
        blob_store=LocalBlobStore(settings.data_dir),
        registry=registry,
        timeout_seconds=settings.request_timeout_seconds,
        retry_attempts=settings.retry_attempts,
    )
    failed = False
    try:
        for source_key in source_keys:
            assert source_key is not None
            result = runner.run(source_key)
            typer.echo(
                f"source={source_key} status={result.status.value} "
                f"inserted={result.inserted_count}"
            )
            failed = failed or result.status.value != "succeeded"
    finally:
        database.dispose()
    if failed:
        raise typer.Exit(1)


@app.command("backtest")
def backtest(
    as_of: Annotated[
        str | None, typer.Option("--as-of", help="Aware ISO-8601 cutoff.")
    ] = None,
    data_dir: DataDirOption = None,
    database_url: DatabaseUrlOption = None,
) -> None:


    settings = _settings(data_dir=data_dir, database_url=database_url)
    _upgrade(settings)
    database = Database(settings.database_url)
    source_key, metric = _target_for_mode(settings.mode)
    try:
        count = run_database_backtests(
            database,
            geography_ids=target_geography_ids(
                database, source_key=source_key, metric=metric
            ),
            source_key=source_key,
            metric=metric,
            as_of=_as_of(as_of),
        )
    finally:
        database.dispose()
    typer.echo(f"backtest status=succeeded inserted={count}")


@app.command("forecast")
def forecast(
    as_of: Annotated[
        str | None, typer.Option("--as-of", help="Aware ISO-8601 publication time.")
    ] = None,
    data_dir: DataDirOption = None,
    database_url: DatabaseUrlOption = None,
) -> None:


    settings = _settings(data_dir=data_dir, database_url=database_url)
    _upgrade(settings)
    database = Database(settings.database_url)
    source_key, metric = _target_for_mode(settings.mode)
    try:
        cutoff = _as_of(as_of)
        count = (
            publish_statewide_disease_assessments(
                database,
                source_key=source_key,
                metric=metric,
                mode=settings.mode,
                as_of=cutoff,
            )
            if settings.mode == "live"
            else publish_database_forecasts(
                database,
                source_key=source_key,
                metric=metric,
                mode=settings.mode,
                as_of=cutoff,
            )
        )
    finally:
        database.dispose()
    if count == 0:
        typer.echo("forecast status=failed reason=no eligible target observations")
        raise typer.Exit(1)
    typer.echo(f"forecast status=succeeded assessments={count} mode={settings.mode}")


@app.command("pipeline")
def pipeline(
    as_of: Annotated[
        str | None, typer.Option("--as-of", help="Aware ISO-8601 publication time.")
    ] = None,
    data_dir: DataDirOption = None,
    database_url: DatabaseUrlOption = None,
) -> None:


    settings = _settings(data_dir=data_dir, database_url=database_url)
    _require_live(settings)
    _upgrade(settings)
    cutoff = _as_of(as_of)
    database = Database(settings.database_url)
    registry = default_registry()
    runner = IngestionRunner(
        database=database,
        blob_store=LocalBlobStore(settings.data_dir),
        registry=registry,
        timeout_seconds=settings.request_timeout_seconds,
        retry_attempts=settings.retry_attempts,
    )
    orchestrator = PipelineOrchestrator(
        runner=runner,
        primary_source_key=LIVE_SOURCE_KEY,
        has_valid_primary=lambda value: has_fresh_primary(
            database,
            source_key=LIVE_SOURCE_KEY,
            metric=LIVE_TARGET_METRIC,
            geography_id="ma",
            as_of=value,
        ),
        run_backtests=lambda value: run_database_backtests_for_diseases(
            database,
            source_key=LIVE_SOURCE_KEY,
            metric=LIVE_TARGET_METRIC,
            as_of=value,
        ),
        publish_forecasts=lambda value: publish_statewide_disease_assessments(
            database,
            source_key=LIVE_SOURCE_KEY,
            metric=LIVE_TARGET_METRIC,
            mode="live",
            as_of=value,
        ),
    )
    try:
        summary = orchestrator.run(registry.keys(), cutoff)
    finally:
        database.dispose()
    _print_pipeline(summary)
    if not summary.required_stages_succeeded:
        raise typer.Exit(1)


def _settings(*, data_dir: Path | None, database_url: str | None) -> Settings:
    if data_dir is not None and database_url is not None:
        settings = Settings(data_dir=data_dir, database_url=database_url)
    elif data_dir is not None:
        settings = Settings(data_dir=data_dir)
    elif database_url is not None:
        settings = Settings(database_url=database_url)
    else:
        settings = Settings()
    if data_dir is not None and database_url is None:
        database_path = (data_dir / "corvid.db").as_posix()
        settings.database_url = f"sqlite+pysqlite:///{database_path}"
    return settings


def _upgrade(settings: Settings) -> None:
    settings.data_dir.mkdir(parents=True, exist_ok=True)
    config = AlembicConfig(str(_project_root() / "packages" / "corvid" / "alembic.ini"))
    config.set_main_option("sqlalchemy.url", settings.database_url.replace("%", "%%"))
    command.upgrade(config, "head")


def _project_root() -> Path:
    working_directory = Path.cwd().resolve()
    if (working_directory / "pyproject.toml").is_file():
        return working_directory
    return Path(__file__).resolve().parents[4]


def _require_live(settings: Settings) -> None:
    if settings.mode != "live":
        typer.echo(
            "error: live mode is required for ingestion; "
            "set CORVID_MODE=live explicitly",
            err=True,
        )
        raise typer.Exit(2)


def _as_of(value: str | None) -> datetime:
    if value is None:
        return datetime.now(UTC)
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError as error:
        raise typer.BadParameter("--as-of must be ISO-8601") from error
    if parsed.tzinfo is None or parsed.utcoffset() is None:
        raise typer.BadParameter("--as-of must include a timezone")
    return parsed.astimezone(UTC)


def _target_for_mode(mode: str) -> tuple[str, str]:
    del mode
    return TARGET_SOURCE_KEY, TARGET_METRIC


def _print_pipeline(summary: PipelineSummary) -> None:
    for source_key, result in summary.source_results.items():
        typer.echo(
            f"source={source_key} status={result.status.value} inserted={result.count}"
        )
    typer.echo(
        f"backtest={summary.backtest.status.value} inserted={summary.backtest.count}"
    )
    typer.echo(
        f"forecast={summary.forecast.status.value} assessments={summary.forecast.count}"
    )
    for warning in summary.warnings:
        typer.echo(f"warning={warning}")
    typer.echo(f"pipeline={summary.status.value}")


def main() -> None:
    app()


if __name__ == "__main__":
    main()
