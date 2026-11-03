"""
Update docs/data/prices.json, the income calculator's price adjustment, from PSA's consumer price index for all items in the
Philippines (2018 = 100) on OpenSTAT. The calculator compares today's incomes with FIES 2025, so the factor is the latest
month's index over the 2025 average. Run by .github/workflows/update-prices.yml; it changes nothing if there is no new month.
"""
import csv
import io
import json
import subprocess
from pathlib import Path

TABLE = "https://openstat.psa.gov.ph/PXWeb/api/v1/en/DB/2M/PI/CPI/2018NEW/0012M4ACP22.px"
BASE_YEAR = "2025"
OUT = Path(__file__).resolve().parents[2] / "docs" / "data" / "prices.json"
MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]
NAMES = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"]


def fetch(body=None):
    # curl, because PSA's servers have refused some Python TLS clients
    cmd = ["curl", "-sS", "--fail", "--max-time", "90", "--retry", "3", TABLE]
    if body is not None:
        cmd += ["-X", "POST", "-H", "Content-Type: application/json", "-d", json.dumps(body)]
    return subprocess.run(cmd, check=True, capture_output=True).stdout.decode("utf-8-sig")


def main():
    variables = {v["code"]: v for v in json.loads(fetch())["variables"]}
    years = variables["Year"]
    geo, item = variables["Geolocation"], variables["Commodity Description"]
    assert geo["valueTexts"][0] == "PHILIPPINES" and item["valueTexts"][0].endswith("ALL ITEMS"), "the table's layout has changed"
    query = {"query": [{"code": "Geolocation", "selection": {"filter": "item", "values": [geo["values"][0]]}},
                       {"code": "Commodity Description", "selection": {"filter": "item", "values": [item["values"][0]]}},
                       {"code": "Year", "selection": {"filter": "item", "values": [c for c, y in zip(years["values"], years["valueTexts"]) if y >= BASE_YEAR]}}],
             "response": {"format": "csv"}}
    header, row = list(csv.reader(io.StringIO(fetch(query))))[:2]
    index = {}
    for col, value in zip(header, row):
        parts = col.split()
        if len(parts) == 2 and parts[0].isdigit() and value.strip() not in ("", ".."):
            index[(parts[0], parts[1])] = float(value)
    base = index[(BASE_YEAR, "Ave")]
    year, month = max((k for k in index if k[1] in MONTHS), key=lambda k: (k[0], MONTHS.index(k[1])))
    factor = index[(year, month)] / base
    prices = {"month": f"{year}-{MONTHS.index(month) + 1:02d}", "label": f"{NAMES[MONTHS.index(month)]} {year}", "index": index[(year, month)],
              "base": round(base, 4), "factor": round(factor, 5), "pct": round((factor - 1) * 100, 1)}
    if OUT.exists() and json.loads(OUT.read_text()) == prices:
        print("No new month:", prices["label"])
        return
    OUT.write_text(json.dumps(prices, indent=1) + "\n")
    print("Updated to", prices["label"], "factor", prices["factor"])


if __name__ == "__main__":
    main()
