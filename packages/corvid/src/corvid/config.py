from pathlib import Path
from typing import Literal

from pydantic import model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):


    model_config = SettingsConfigDict(
        env_prefix="CORVID_",
        env_file=".env",
        extra="ignore",
    )

    mode: Literal["demo", "live"] = "demo"
    data_dir: Path = Path()
    database_url: str = ""
    request_timeout_seconds: float = 20.0
    retry_attempts: int = 3
    cors_origins: list[str] = ["http://localhost:3000"]

    @model_validator(mode="after")
    def select_mode_specific_storage(self) -> "Settings":


        if self.data_dir == Path():
            self.data_dir = Path("data/runtime") / self.mode
        if not self.database_url:
            database_path = self.data_dir / "corvid.db"
            self.database_url = f"sqlite+pysqlite:///{database_path.as_posix()}"
        return self
