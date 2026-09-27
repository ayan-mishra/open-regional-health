from corvid.config import Settings


def test_settings_default_to_demo_mode(tmp_path):
    settings = Settings(data_dir=tmp_path)

    assert settings.mode == "demo"
    assert settings.database_url.startswith("sqlite")
