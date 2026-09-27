from datetime import date, datetime
from io import BytesIO

import pytest
from corvid.ingestion.base import SourceSchemaError
from corvid.ingestion.mass_dph import DphWorkbookSignature, MassDphConnector
from openpyxl import Workbook

SIGNATURE = DphWorkbookSignature(
    season="captured-test-only",
    sheet_names=("Influenza",),
    required_headers_by_sheet={"Influenza": ("Week End", "Metric")},
    date_column_by_sheet={"Influenza": "Week End"},
    metric_columns_by_sheet={"Influenza": ("Metric",)},
    expected_date_type_by_sheet={"Influenza": "date"},
)


def test_dph_parser_requires_manually_supplied_matching_signature() -> None:
    payload = _workbook_bytes(headers=("Week End", "Renamed"))
    connector = MassDphConnector(signature=SIGNATURE)
    with pytest.raises(SourceSchemaError, match="required header"):
        connector.parse_workbook(
            payload,
            content_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        )


def test_dph_parser_rejects_html_and_parses_only_signed_rows() -> None:
    connector = MassDphConnector(signature=SIGNATURE)
    with pytest.raises(SourceSchemaError, match="XLSX"):
        connector.parse_workbook(b"<html>blocked</html>", content_type="text/html")

    rows = connector.parse_workbook(
        _workbook_bytes(headers=("Week End", "Metric")),
        content_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    )
    assert rows[0].date_cell_value == datetime(2026, 7, 18)
    assert rows[0].raw_value_text == "1.25"


def _workbook_bytes(*, headers: tuple[str, str]) -> bytes:
    workbook = Workbook()
    sheet = workbook.active
    sheet.title = "Influenza"
    sheet.append(headers)
    sheet.append((date(2026, 7, 18), 1.25))
    buffer = BytesIO()
    workbook.save(buffer)
    return buffer.getvalue()
