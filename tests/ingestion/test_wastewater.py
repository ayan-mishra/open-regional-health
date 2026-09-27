from datetime import UTC, datetime

import pytest
from corvid.domain import QualityFlag
from corvid.ingestion.base import SourceSchemaError
from corvid.ingestion.source_policies import SourcePolicy
from corvid.ingestion.wastewater import WastewaterConnector

from tests.ingestion.conftest import load_json_fixture

RETRIEVED_AT = datetime(2026, 7, 25, 10, 32, 8, tzinfo=UTC)


def test_wastewater_preserves_non_detect_and_compatibility_boundaries() -> None:
    connector = WastewaterConnector(mode="commercial")
    rows = connector.parse_json(load_json_fixture("nwss_influenza_a_ma.json"))
    records = connector.normalize(rows, retrieved_at=RETRIEVED_AT)

    assert len(records) == 2
    assert {record.value for record in records} == {0.0}
    assert all(record.metadata["non_detect"] is True for record in records)
    assert all(QualityFlag.NON_DETECT in record.quality_flags for record in records)
    assert len({record.metadata["compatibility_key"] for record in records}) == 2
    assert {record.unit for record in records} == {
        "copies/g dry sludge",
        "copies/l wastewater",
    }
    assert all("license" not in record.metadata for record in records)


def test_source_policies_apply_documented_source_level_rules() -> None:
    assert SourcePolicy.for_source("nwss_influenza_a").is_allowed("research")
    assert SourcePolicy.for_source("nwss_influenza_a").is_allowed("commercial")
    assert not SourcePolicy.for_source("future_restricted").is_allowed("research")
    assert not SourcePolicy.for_source("future_restricted").is_allowed("commercial")
    assert not SourcePolicy.for_source("mass_dph_archive").is_allowed("commercial")


def test_wastewater_rejects_negative_concentrations() -> None:
    row = dict(load_json_fixture("nwss_influenza_a_ma.json")[0])
    row["pcr_target_avg_conc"] = "-0.01"

    with pytest.raises(SourceSchemaError, match="nonnegative"):
        WastewaterConnector().parse_json([row])
