#!/usr/bin/env python3
"""Regenerate `tests/fixtures/lambda-routes.json` from the pinned AWS models.

The Coolify fixture is extracted from Coolify's own `routes/api.php` at a pinned
commit. AWS has no single PHP route file, so the equivalent authoritative source
is botocore's per-service model (`service-2.json`), which is what every AWS SDK
is generated from: it names each operation's HTTP method and request URI. Pinning
a botocore commit and reading the model from it gives the same property the
Coolify fixture gives — an adapter path that AWS does not document fails the
build instead of failing in production.

Two services are covered, and their protocols differ, which the fixture records:

  * `lambda` is `rest-json`: the operation is named by method + URI path.
  * `logs` is `json`: every operation is `POST /` and the operation is named by
    the `X-Amz-Target` header. The fixture keeps `targetPrefix` so the test can
    assert the adapter sends `Logs_20140328.FilterLogEvents`.

Run: `python3 scripts/fetch-aws-routes.py`
"""

import json
import urllib.request
from pathlib import Path

# Pinned botocore commit. Bump deliberately, then regenerate and re-run the test.
BOTOCORE_COMMIT = "86201a3e9c58a61369b8bcf4b658bfd4463fc41f"
RAW = f"https://raw.githubusercontent.com/boto/botocore/{BOTOCORE_COMMIT}/botocore/data"

OUT = Path(__file__).resolve().parent.parent / "tests" / "fixtures" / "lambda-routes.json"

SERVICES = {
    "lambda": "lambda/2015-03-31/service-2.json",
    "logs": "logs/2014-03-28/service-2.json",
}


def fetch(path: str) -> dict:
    with urllib.request.urlopen(f"{RAW}/{path}") as response:
        return json.load(response)


def main() -> None:
    services: dict[str, dict] = {}
    for name, path in SERVICES.items():
        model = fetch(path)
        metadata = model["metadata"]
        operations = []
        for operation_name, operation in model["operations"].items():
            http = operation["http"]
            operations.append(
                {
                    "name": operation_name,
                    "method": http["method"],
                    "requestUri": http.get("requestUri", "/"),
                }
            )
        operations.sort(key=lambda entry: entry["name"])
        services[name] = {
            "apiVersion": metadata.get("apiVersion"),
            "protocol": metadata.get("protocol"),
            "targetPrefix": metadata.get("targetPrefix"),
            "operations": operations,
        }

    fixture = {
        "_source": "boto/botocore service models (botocore/data/*/service-2.json)",
        "_commit": BOTOCORE_COMMIT,
        "_note": (
            "Verbatim HTTP method + request URI for every operation of each service, "
            "taken from the pinned botocore commit. Any path or X-Amz-Target the Cloud "
            "Wai serverless adapter calls must appear here. Regenerate with "
            "`python3 scripts/fetch-aws-routes.py`."
        ),
        "services": services,
    }
    OUT.write_text(json.dumps(fixture, indent=2) + "\n")
    for name, service in services.items():
        print(f"{name}: {len(service['operations'])} operations ({service['protocol']})")


if __name__ == "__main__":
    main()
