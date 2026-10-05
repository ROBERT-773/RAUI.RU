"""Bounded stdin/stdout protocol used by the durable Node trust worker; no DB access."""
import json
import sys
from .duplicates import score_pair

def main():
    raw = sys.stdin.buffer.read(256001)
    if len(raw) > 256000:
        raise ValueError("input_limit")
    request = json.loads(raw)
    if request.get("schemaVersion") != 1 or not isinstance(request.get("candidates"), list) or len(request["candidates"]) > 100:
        raise ValueError("invalid_contract")
    result = {"schemaVersion": 1, "candidates": [{"id": candidate["id"], **score_pair(request["subject"], candidate)} for candidate in request["candidates"]]}
    sys.stdout.write(json.dumps(result, ensure_ascii=False))

if __name__ == "__main__":
    try:
        main()
    except (ValueError, KeyError, TypeError):
        sys.stderr.write("trust_worker_invalid_input\n")
        sys.exit(1)
