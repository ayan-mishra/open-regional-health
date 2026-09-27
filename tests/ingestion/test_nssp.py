from datetime import UTC, date, datetime

import pytest
from corvid.domain import Disease
from corvid.ingestion.base import SourceSchemaError
from corvid.ingestion.nssp import NsspConnector
from corvid.normalization.geography import GeographyResolutionError

from tests.ingestion.conftest import load_json_fixture

RETRIEVED_AT = datetime(2026, 7, 25, 10, 32, 8, tzinfo=UTC)


def test_nssp_deduplicates_repeated_county_rows_into_stable_hsa() -> None:
    connector = NsspConnector()
    rows = connector.parse_json(load_json_fixture("nssp_ma.json"))
    observations = connector.normalize(rows, retrieved_at=RETRIEVED_AT)

    hsa = [
        row
        for row in observations
        if row.geography_id == "ma-hsa-22"
        and row.disease is Disease.INFLUENZA
        and row.metric == "ed_visit_percent"
    ]
    assert len(hsa) == 1
    assert hsa[0].unit == "percentage_points"
    assert hsa[0].observation_start == date(2026, 7, 12)
    assert hsa[0].metadata["hsa_counties"] == (
        "Barnstable, Dukes, Middlesex, Nantucket, Norfolk, Plymouth, Suffolk"
    )


def test_nssp_rejects_conflicting_hsa_duplicates() -> None:
    connector = NsspConnector()
    payload = load_json_fixture("nssp_ma.json")
    conflicting = dict(payload[2], percent_visits_influenza="9.99")
    rows = connector.parse_json([*payload, conflicting])
    with pytest.raises(SourceSchemaError, match="conflicting duplicate"):
        connector.normalize(rows, retrieved_at=RETRIEVED_AT)


def test_nssp_rejects_unknown_hsa() -> None:
    connector = NsspConnector()
    payload = load_json_fixture("nssp_ma.json")
    unknown = dict(payload[1], hsa_nci_id="999", hsa="Unmapped")
    with pytest.raises(GeographyResolutionError):
        connector.normalize(connector.parse_json([unknown]), retrieved_at=RETRIEVED_AT)


def test_nssp_uses_confirmed_massachusetts_query() -> None:
    assert "geography='Massachusetts'" in NsspConnector().request_parameters["$where"]


def test_nssp_rejects_impossible_raw_and_smoothed_percentages() -> None:
    connector = NsspConnector()
    payload = load_json_fixture("nssp_ma.json")
    with pytest.raises(SourceSchemaError, match="between 0 and 100"):
        connector.parse_json([dict(payload[0], percent_visits_influenza="101")])
    with pytest.raises(SourceSchemaError, match="between 0 and 100"):
        connector.parse_json([dict(payload[0], percent_visits_smoothed_1="-0.1")])


def test_nssp_normalizes_raw_smoothed_and_trajectory_for_each_disease() -> None:
    connector = NsspConnector()
    rows = connector.parse_json(load_json_fixture("nssp_ma.json"))

    observations = connector.normalize(rows[:1], retrieved_at=RETRIEVED_AT)

    assert {(row.disease, row.metric) for row in observations} == {
        (disease, metric)
        for disease in Disease
        for metric in ("ed_visit_percent", "ed_visit_percent_smoothed")
    }
    assert {
        (row.disease, row.metadata["upstream_trajectory"])
        for row in observations
        if row.metric == "ed_visit_percent"
    } == {
        (Disease.INFLUENZA, "stable"),
        (Disease.COVID_19, "rising"),
        (Disease.RSV, "falling"),
    }
