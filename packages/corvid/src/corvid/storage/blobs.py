import hashlib
import os
import re
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from tempfile import NamedTemporaryFile

_SAFE_SOURCE_KEY = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]*$")


@dataclass(frozen=True, slots=True)
class BlobRef:


    sha256: str
    path: Path
    size_bytes: int


class LocalBlobStore:


    def __init__(self, data_dir: Path) -> None:
        self._data_dir = data_dir

    def put(self, source_key: str, retrieved_at: datetime, content: bytes) -> BlobRef:


        if _SAFE_SOURCE_KEY.fullmatch(source_key) is None:
            raise ValueError(
                "source_key must contain only letters, numbers, '.', '_', '-'"
            )
        if retrieved_at.tzinfo is None or retrieved_at.utcoffset() is None:
            raise ValueError("retrieved_at must be timezone-aware")
        retrieved_at = retrieved_at.astimezone(UTC)

        digest = hashlib.sha256(content).hexdigest()
        destination = (
            self._data_dir
            / "raw"
            / source_key
            / f"{retrieved_at:%Y}"
            / f"{retrieved_at:%m}"
            / f"{digest}.bin"
        )
        destination.parent.mkdir(parents=True, exist_ok=True)

        if destination.exists():
            if destination.read_bytes() != content:
                raise RuntimeError("content hash collision at existing blob path")
            return BlobRef(digest, destination, len(content))

        temporary_name: str | None = None
        try:
            with NamedTemporaryFile(dir=destination.parent, delete=False) as temporary:
                temporary.write(content)
                temporary.flush()
                os.fsync(temporary.fileno())
                temporary_name = temporary.name
            try:
                os.link(temporary_name, destination)
            except FileExistsError as error:
                if destination.read_bytes() != content:
                    raise RuntimeError(
                        "content hash collision at existing blob path"
                    ) from error
        finally:
            if temporary_name is not None:
                Path(temporary_name).unlink(missing_ok=True)

        return BlobRef(digest, destination, len(content))
