import json
from collections import Counter
from pathlib import Path


DATASET = Path(__file__).with_name("requirements-v0.1.jsonl")
EXPECTED_FIELDS = {
    "topic": str,
    "geography": str,
    "time_coverage": str,
    "minimum_records": int,
    "required_features": list,
    "target": str,
    "preferences": list,
    "constraints": list,
}
REQUIRED_CATEGORIES = {
    "domain",
    "geography",
    "time",
    "size",
    "multiple_requirements",
    "ambiguous",
    "no_match",
    "source_specific",
    "typo_synonym",
    "adversarial",
}


def validate() -> list[str]:
    errors = []
    cases = []
    for line_number, line in enumerate(DATASET.read_text(encoding="utf-8").splitlines(), 1):
        try:
            case = json.loads(line)
        except json.JSONDecodeError as error:
            errors.append(f"line {line_number}: invalid JSON: {error.msg}")
            continue
        if not isinstance(case, dict):
            errors.append(f"line {line_number}: case must be an object")
            continue
        cases.append((line_number, case))

    identifiers = [case.get("case_id") for _, case in cases]
    duplicates = [case_id for case_id, count in Counter(identifiers).items() if count > 1]
    if duplicates:
        errors.append(f"duplicate case IDs: {', '.join(map(str, duplicates))}")
    if len(cases) != 50:
        errors.append(f"expected 50 cases, found {len(cases)}")

    split_counts = Counter(case.get("split") for _, case in cases)
    if split_counts != Counter({"development": 40, "held_out": 10}):
        errors.append(f"expected 40 development and 10 held_out cases, found {dict(split_counts)}")

    categories = {
        category
        for _, case in cases
        for category in (case.get("categories") if isinstance(case.get("categories"), list) else [])
        if isinstance(category, str)
    }
    missing_categories = REQUIRED_CATEGORIES - categories
    if missing_categories:
        errors.append(f"missing category coverage: {', '.join(sorted(missing_categories))}")

    for line_number, case in cases:
        if not isinstance(case.get("case_id"), str) or not case["case_id"]:
            errors.append(f"line {line_number}: case_id must be a non-empty string")
        if case.get("split") not in {"development", "held_out"}:
            errors.append(f"line {line_number}: split must be development or held_out")
        query = case.get("input")
        if not isinstance(query, str) or not query.strip():
            errors.append(f"line {line_number}: input must be a non-empty string")
            query = ""
        if not isinstance(case.get("categories"), list) or not all(
            isinstance(category, str) for category in case["categories"]
        ):
            errors.append(f"line {line_number}: categories must be an array of strings")

        expected = case.get("expected")
        evidence = case.get("evidence")
        if not isinstance(expected, dict) or set(expected) != set(EXPECTED_FIELDS):
            errors.append(f"line {line_number}: expected must contain exactly {sorted(EXPECTED_FIELDS)}")
            continue
        if not isinstance(evidence, dict):
            errors.append(f"line {line_number}: evidence must be an object")
            continue
        if set(evidence) - set(EXPECTED_FIELDS):
            errors.append(f"line {line_number}: evidence contains unknown fields")

        for field, expected_type in EXPECTED_FIELDS.items():
            value = expected[field]
            if field == "minimum_records":
                valid_type = value is None or (type(value) is int and value >= 0)
            elif expected_type is str:
                valid_type = value is None or isinstance(value, str)
            else:
                valid_type = isinstance(value, list) and all(isinstance(item, str) for item in value)
            if not valid_type:
                errors.append(f"line {line_number}: invalid value for expected.{field}")
                continue

            snippets = evidence.get(field, [])
            if not isinstance(snippets, list) or not all(isinstance(item, str) for item in snippets):
                errors.append(f"line {line_number}: evidence.{field} must be an array of strings")
                continue
            if value is None or value == []:
                if snippets:
                    errors.append(f"line {line_number}: empty expected.{field} cannot have evidence")
            elif not snippets:
                errors.append(f"line {line_number}: expected.{field} requires evidence snippets")
            for snippet in snippets:
                if not snippet or snippet not in query:
                    errors.append(f"line {line_number}: evidence snippet for {field} is absent from input")

    return errors


if __name__ == "__main__":
    validation_errors = validate()
    if validation_errors:
        for validation_error in validation_errors:
            print(f"ERROR: {validation_error}")
        raise SystemExit(1)
    print(f"PASS: {DATASET.name}: 50 cases; development=40; held_out=10")
    print("NOTE: structural validation only; annotations and model quality are not certified.")
