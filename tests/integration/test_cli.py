from click.utils import strip_ansi
from corvid.cli import app
from typer.testing import CliRunner


def test_demo_mode_rejects_live_ingestion(tmp_path):
    result = CliRunner().invoke(
        app,
        ["ingest", "--source", "nssp_ed", "--data-dir", str(tmp_path)],
        env={"CORVID_MODE": "demo"},
    )

    assert result.exit_code != 0
    assert "live mode" in result.output.lower()


def test_ingest_accepts_only_fixed_registry_source_keys(tmp_path):
    result = CliRunner().invoke(
        app,
        [
            "ingest",
            "--source",
            "nssp_ed",
            "--url",
            "https://evil.example/source",
            "--data-dir",
            str(tmp_path),
        ],
        env={"CORVID_MODE": "live"},
    )

    assert result.exit_code != 0
    assert "No such option" in result.output


def test_ingest_requires_exactly_one_source_selection(tmp_path):
    result = CliRunner().invoke(
        app,
        ["ingest", "--data-dir", str(tmp_path)],
        env={"CORVID_MODE": "live", "COLUMNS": "120", "NO_COLOR": "1"},
        color=False,
        terminal_width=120,
    )

    assert result.exit_code != 0
    normalized_output = " ".join(strip_ansi(result.output).split())
    assert "choose exactly one of --source or --all" in normalized_output
