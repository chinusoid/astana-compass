"""Fixed diagnostic identifiers; never log validation payloads or exception text."""
from functools import lru_cache
from astana_contracts import ContractValidationError, load_schema

# Literal canonical invariant messages are mapped to opaque fixed codes. Unknown
# messages (including adapter-controlled exception text) are never logged.
_RULES = {
    'constraint outcome does not match known place fact': 'invariant_1',
    'constraint references missing place evidence': 'invariant_2',
    'constraint strength changed': 'invariant_3',
    'every requested constraint must have exactly one evaluation': 'invariant_4',
    'fact references missing place evidence': 'invariant_5',
    'initial release must return unsupported_transport ErrorResponse': 'invariant_6',
    'itinerary must preserve all selected place IDs in requested order': 'invariant_7',
    'itinerary total must include every visit and complete route': 'invariant_8',
    'journey stage must cite the original query': 'invariant_9',
    'known constraint evaluation must cite supporting fact evidence': 'invariant_10',
    'named journey destination must be quoted by the user': 'invariant_11',
    'nonzero travel distance requires nonzero travel duration': 'invariant_12',
    'optional ideas need a core result and available stop slots': 'invariant_13',
    'place synthetic marker does not match its evidence': 'invariant_14',
    'recommendation total must include visit and all travel': 'invariant_15',
    'recommendations/stops must have contiguous ordered ranks': 'invariant_16',
    'recommended place references and returned places must resolve exactly': 'invariant_17',
    'required constraint is not verified satisfied': 'invariant_18',
    'response exceeds requested limit': 'invariant_19',
    'retrieval hit references missing fact': 'invariant_20',
    'retrieval hits and returned places must resolve exactly': 'invariant_21',
    'route return flag does not match request': 'invariant_22',
    'route transport does not match request': 'invariant_23',
    'selected place count exceeds request limit': 'invariant_24',
    'synthetic place id must be marked synthetic': 'invariant_25',
}
_CODES = frozenset({"unknown_definition", "invalid_json", "contract_schema_violation", "contract_invariant_violation"})

@lru_cache(maxsize=1)
def _vocabulary():
    schema = load_schema()
    fields = set()
    def visit(item):
        if isinstance(item, dict):
            fields.update(item.get("properties", {}))
            for child in item.values(): visit(child)
        elif isinstance(item, list):
            for child in item: visit(child)
    visit(schema)
    return frozenset(schema["$defs"]), frozenset(fields)

def diagnostic(error: ContractValidationError) -> dict[str, object]:
    definitions, fields = _vocabulary()
    path = [part if (type(part) is int and 0 <= part <= 10000) or (type(part) is str and part in fields) else "other"
            for part in error.path[:10]] if type(error.path) in (tuple, list) else []
    return {
        "definition": error.definition if type(error.definition) is str and error.definition in definitions else "other",
        "code": error.code if type(error.code) is str and error.code in _CODES else "other",
        "stage": error.stage if type(error.stage) is str and error.stage in {"schema", "invariant"} else "other",
        "path": ".".join(map(str, path)) or "root",
        "rule": _RULES.get(error.message, "other") if type(error.message) is str else "other",
    }
