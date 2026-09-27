from sqlite3 import Connection
from types import TracebackType
from typing import Literal, cast

from sqlalchemy import event
from sqlalchemy.engine import create_engine
from sqlalchemy.orm import Session, sessionmaker

from corvid.storage.models import Base
from corvid.storage.repositories import (
    BacktestRepository,
    ForecastRepository,
    GeographyRepository,
    IngestionRunRepository,
    ObservationRepository,
    SnapshotRepository,
    SourceRepository,
)


class Database:


    def __init__(self, database_url: str) -> None:
        self.engine = create_engine(database_url)
        if self.engine.dialect.name == "sqlite":
            event.listen(self.engine, "connect", _enable_sqlite_foreign_keys)
        self.session = sessionmaker(
            bind=self.engine,
            class_=Session,
            expire_on_commit=False,
        )

    def create_schema(self) -> None:


        Base.metadata.create_all(self.engine)

    def dispose(self) -> None:
        self.engine.dispose()


def _enable_sqlite_foreign_keys(dbapi_connection: object, _: object) -> None:
    cursor = cast(Connection, dbapi_connection).cursor()
    try:
        cursor.execute("PRAGMA foreign_keys=ON")
    finally:
        cursor.close()


class UnitOfWork:


    def __init__(self, database: Database) -> None:
        self._database = database
        self.session: Session | None = None
        self.sources: SourceRepository
        self.geographies: GeographyRepository
        self.observations: ObservationRepository
        self.snapshots: SnapshotRepository
        self.ingestion_runs: IngestionRunRepository
        self.forecasts: ForecastRepository
        self.backtests: BacktestRepository

    def __enter__(self) -> "UnitOfWork":
        session = self._database.session()
        self.session = session
        self.sources = SourceRepository(session)
        self.geographies = GeographyRepository(session)
        self.observations = ObservationRepository(session)
        self.snapshots = SnapshotRepository(session)
        self.ingestion_runs = IngestionRunRepository(session)
        self.forecasts = ForecastRepository(session)
        self.backtests = BacktestRepository(session)
        return self

    def __exit__(
        self,
        exception_type: type[BaseException] | None,
        exception: BaseException | None,
        traceback: TracebackType | None,
    ) -> Literal[False]:
        del exception, traceback
        if self.session is None:
            return False
        try:
            if exception_type is None:
                self.session.commit()
            else:
                self.session.rollback()
        finally:
            self.session.close()
            self.session = None
        return False
