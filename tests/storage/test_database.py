from datetime import date

from conftest import observation
from corvid.domain.enums import GeographyType
from corvid.domain.models import GeographyRecord, SourceRecord
from corvid.storage.database import Database, UnitOfWork
from corvid.storage.models import GeographyRow
from corvid.storage.repositories import ObservationRepository
from sqlalchemy import inspect, select


def test_unit_of_work_commits_only_on_success(database: Database):
    with UnitOfWork(database) as uow:
        uow.geographies.upsert_geography(
            GeographyRecord(
                id="ma",
                geography_type=GeographyType.STATE,
                display_name="Massachusetts",
                state_code="MA",
            )
        )

    with database.session() as session:
        assert session.get(GeographyRow, "ma") is not None


def test_unit_of_work_rolls_back_on_exception(database: Database):
    try:
        with UnitOfWork(database) as uow:
            uow.geographies.upsert_geography(
                GeographyRecord(
                    id="rollback",
                    geography_type=GeographyType.STATE,
                    display_name="Rollback",
                    state_code="MA",
                )
            )
            raise RuntimeError("abort")
    except RuntimeError:
        pass

    with database.session() as session:
        assert (
            session.scalar(select(GeographyRow).where(GeographyRow.id == "rollback"))
            is None
        )


def test_alembic_upgrade_downgrade_and_reupgrade(tmp_path):
    from alembic import command
    from alembic.config import Config

    package_dir = (
        __import__("pathlib").Path(__file__).parents[2] / "packages" / "corvid"
    )
    config = Config(str(package_dir / "alembic.ini"))
    database_path = tmp_path / "migration.db"
    config.set_main_option("sqlalchemy.url", f"sqlite+pysqlite:///{database_path}")

    command.upgrade(config, "head")
    database = Database(f"sqlite+pysqlite:///{database_path}")
    assert "observations" in inspect(database.engine).get_table_names()
    observation_indexes = {
        index["name"] for index in inspect(database.engine).get_indexes("observations")
    }
    backtest_indexes = {
        index["name"]
        for index in inspect(database.engine).get_indexes("backtest_results")
    }
    assert "ix_observations_raw_snapshot_id" in observation_indexes
    assert "ix_backtests_geography_id" in backtest_indexes
    with UnitOfWork(database) as uow:
        uow.sources.upsert_source(
            SourceRecord(
                key="nssp",
                name="CDC NSSP",
                organization="CDC",
                landing_page_url="https://www.cdc.gov/nssp/",
            )
        )
        uow.geographies.upsert_geography(
            GeographyRecord(
                id="ma",
                geography_type=GeographyType.STATE,
                display_name="Massachusetts",
                state_code="MA",
            )
        )
        uow.observations.insert_observations(
            [observation(issue_date=date(2026, 1, 10), value=1.2)]
        )
    with database.session() as session:
        assert ObservationRepository(session).count() == 1
    database.dispose()

    command.downgrade(config, "base")
    database = Database(f"sqlite+pysqlite:///{database_path}")
    assert "observations" not in inspect(database.engine).get_table_names()
    database.dispose()

    command.upgrade(config, "head")
    database = Database(f"sqlite+pysqlite:///{database_path}")
    assert "observations" in inspect(database.engine).get_table_names()
    database.dispose()
