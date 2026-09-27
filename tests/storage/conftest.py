from collections.abc import Iterator
from datetime import UTC, date, datetime

import pytest
from corvid.domain.enums import Disease, GeographyType
from corvid.domain.models import GeographyRecord, ObservationRecord, SourceRecord
from corvid.storage.database import Database
from corvid.storage.repositories import GeographyRepository, SourceRepository
from sqlalchemy.orm import Session


@pytest.fixture
def database(tmp_path) -> Iterator[Database]:
    database = Database(f"sqlite+pysqlite:///{tmp_path / 'corvid.db'}")
    database.create_schema()
    yield database
    database.dispose()


@pytest.fixture
def session(database: Database) -> Iterator[Session]:
    with database.session() as session:
        SourceRepository(session).upsert_source(
            SourceRecord(
                key="nssp",
                name="CDC NSSP",
                organization="CDC",
                landing_page_url="https://www.cdc.gov/nssp/",
            )
        )
        GeographyRepository(session).upsert_geography(
            GeographyRecord(
                id="ma",
                geography_type=GeographyType.STATE,
                display_name="Massachusetts",
                state_code="MA",
            )
        )
        session.commit()
        yield session


def observation(
    *,
    issue_date: date,
    value: float,
    upstream_id: str = "2026-W01",
    retrieved_at: datetime | None = None,
) -> ObservationRecord:
    return ObservationRecord(
        source_key="nssp",
        upstream_id=upstream_id,
        disease=Disease.INFLUENZA,
        metric="ed_visits_pct",
        value=value,
        unit="percent",
        geography_id="ma",
        observation_start=date(2026, 1, 4),
        observation_end=date(2026, 1, 10),
        issue_date=issue_date,
        retrieved_at=retrieved_at
        or datetime.combine(issue_date, datetime.min.time(), tzinfo=UTC).replace(
            hour=12
        ),
    )
