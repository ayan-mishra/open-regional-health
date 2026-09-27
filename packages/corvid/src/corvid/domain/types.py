from collections.abc import Mapping, Sequence
from types import MappingProxyType

type JsonScalar = str | int | float | bool | None
type JsonValue = JsonScalar | Sequence[JsonValue] | Mapping[str, JsonValue]
type JsonObject = Mapping[str, JsonValue]


def freeze_json(value: JsonValue) -> JsonValue:


    if isinstance(value, Mapping):
        return MappingProxyType({key: freeze_json(item) for key, item in value.items()})
    if isinstance(value, Sequence) and not isinstance(value, str):
        return tuple(freeze_json(item) for item in value)
    return value


def freeze_json_object(value: JsonObject) -> JsonObject:


    return MappingProxyType({key: freeze_json(item) for key, item in value.items()})


def thaw_json(value: JsonValue) -> JsonValue:


    if isinstance(value, Mapping):
        return {key: thaw_json(item) for key, item in value.items()}
    if isinstance(value, Sequence) and not isinstance(value, str):
        return [thaw_json(item) for item in value]
    return value


def thaw_json_object(value: JsonObject) -> dict[str, JsonValue]:


    return {key: thaw_json(item) for key, item in value.items()}
