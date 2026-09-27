from datetime import UTC, datetime, timedelta, timezone

from corvid.storage.blobs import LocalBlobStore

UTC_NOW = datetime(2026, 1, 17, 12, tzinfo=UTC)


def test_blob_store_is_content_addressed(tmp_path):
    store = LocalBlobStore(tmp_path)

    first = store.put("nssp", UTC_NOW, b'{"ok":true}')
    first_mtime = first.path.stat().st_mtime_ns
    second = store.put("nssp", UTC_NOW, b'{"ok":true}')

    assert first.sha256 == second.sha256
    assert first.path == second.path
    assert second.path.stat().st_mtime_ns == first_mtime
    assert second.path.read_bytes() == b'{"ok":true}'


def test_blob_store_rejects_unsafe_source_keys(tmp_path):
    store = LocalBlobStore(tmp_path)

    for unsafe_key in ("../escape", "nested/source", "", "."):
        try:
            store.put(unsafe_key, UTC_NOW, b"unsafe")
        except ValueError:
            pass
        else:
            raise AssertionError(f"accepted unsafe source key: {unsafe_key!r}")


def test_blob_store_uses_utc_calendar_buckets(tmp_path):
    store = LocalBlobStore(tmp_path)
    retrieved_at = datetime(2026, 8, 1, 1, tzinfo=timezone(timedelta(hours=2)))

    reference = store.put("nssp", retrieved_at, b"utc")

    assert reference.path.parts[-4:-1] == ("nssp", "2026", "07")
