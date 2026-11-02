"""
Written content that the site's data files carry: the version history and the source list.

To publish a new data version, add an entry at the top of VERSIONS, point it at its data file and rerun the build.
"""
from __future__ import annotations

REPO = "urielgalace/barangay-income-poverty"
SITE = "https://urielgalace.github.io/barangay-income-poverty/"
CURRENT = "v1.0"

VERSIONS = [
    dict(
        id="v1.0", date="2026-10-30", time_note=None, label="National dataset for 2025",
        summary="",
        scope="All 42,010 barangays, on 42,000 mapped units",
        levels_from="FIES 2025 income and PSA 2025 poverty, both preliminary; PSA's 2023 municipal small-area estimates",
        data="outputs/national_barangay_income_poverty_2025.csv",
        columns=("poverty_rate_2025", "income_k_2025", "population_2024"),
        changes=[
            ("Added", "Income and poverty estimates for every barangay, including 90% margins of error, as well as estimates for cities, municipalities, provinces, and regions."),
            ("Added", "Estimates benchmarked to official 2025 figures at the regional, provincial, and NCR district levels, and to the PSA’s 2023 small-area estimates at the city and municipal levels."),
            ("Added", "Barangay income estimates from a model trained on provincial and city-level FIES data, and poverty estimates from a model trained on door-to-door survey data covering 6,618 barangays."),
            ("Added", "Population and household counts taken directly from the official 2024 census."),
            ("Added", "Barangay classifications based on the PSA’s geographic codes for the third quarter of 2026, mapped onto 2023 boundaries."),
            ("Added", "Estimates are excluded for 12 barangays with no recorded residents in the 2024 census and 21 geographic polygons that do not correspond to barangays, including forests and parks."),
        ]),
]

# Dated log of what entered the project. File dates come from the files themselves, so the groups below only give them names.
LOG_GROUPS = [
    ("data/raw/2_2023 SAE_with PSGC_noHUC_06Feb2026.xlsx", "Municipal small-area estimates for 2018, 2021 and 2023", "PSA"),
    ("data/raw/Table 1. 2018*", "Household income by region and decile, 2018 to 2023", "PSA FIES"),
    ("data/raw/2023 Full Year Official Poverty Statistics_r2.xlsx", "Official poverty statistics, 2023 release", "PSA"),
    ("data/raw/PH_Adm4_BgySubMuns.shp.zip", "National barangay boundaries, 42,048 polygons (383 MB)", "PSGC shapefiles"),
    ("data/raw/popcen2024/popcen2024_ncr.csv", "2024 Census, population and households by barangay (18 tables)", "PSA OpenSTAT"),
    ("data/raw/rwi/phl_relative_wealth_index.csv", "Relative Wealth Index, for validation only", "Meta via HDX"),
    ("data/raw/openstat/poverty_population_prov_huc_2018_2021_2023.csv", "Poverty and FIES tables from the public API (6 tables)", "PSA OpenSTAT"),
    ("data/interim/features_static.csv", "Terrain, travel time and building form for every polygon", "Google Earth Engine"),
    ("data/raw/official_2025/2025 Full Year Official Poverty Statistics_24Aug2026_0.xlsx", "Official poverty statistics, 2025", "PSA"),
    ("data/raw/official_2025/FIES2025p_Table_1.xlsx", "FIES 2025 preliminary tables 1, 3, 4 and 8", "PSA FIES"),
    ("data/raw/psgc/PSGC-3Q-2026-Publication-Datafile.xlsx", "Geographic codes, 3Q 2026, with 2024 census population", "PSA"),
    ("data/raw/psgc/PSGC-3Q-2026-Summary-of-Changes_0.xlsx", "Official log of merges, new barangays and renames", "PSA"),
    ("data/interim/features_frame_2025.csv", "Satellite features for every polygon, 2025", "Google Earth Engine"),
    ("data/raw/cbms/PasayCity.pdf", "Door-to-door CBMS poverty reports (25 reports in 29 PDFs)", "PEP, Bacolod City"),
    ("data/interim/features_frame_2023.csv", "Satellite features for every polygon, 2023", "Google Earth Engine"),
    ("data/interim/features_frame_2021.csv", "Satellite features for every polygon, 2021", "Google Earth Engine"),
    ("data/interim/features_frame_2018.csv", "Satellite features for every polygon, 2018", "Google Earth Engine"),
]


def build_log(raw, root):
    """Dated entries from the files' own modification times, in project-local time."""
    import glob
    import pandas as pd
    rows = []
    for pat, label, source in LOG_GROUPS:
        hits = sorted(glob.glob(str(root / pat)))
        if not hits:
            continue
        ts = pd.Timestamp(max(__import__("os").path.getmtime(h) for h in hits), unit="s", tz="UTC").tz_convert("America/New_York")
        rows.append(dict(date=ts.strftime("%Y-%m-%d"), label=label, source=source))
    rows.sort(key=lambda r: r["date"], reverse=True)
    return rows


SOURCE_GROUPS = [
    dict(id="poverty", name="Official poverty statistics", publisher="Philippine Statistics Authority", url="https://psa.gov.ph/statistics/poverty", access="psa.gov.ph, in a browser. The site's human check blocks scripts.",
         use="Sets 2025 poverty levels for regions, provinces and NCR districts. Supplies the 2018 to 2025 trends, their confidence intervals, poverty lines and poor-population counts.",
         license="Official statistics, used with attribution",
         patterns=["data/raw/official_2025/2025 Full Year*", "data/raw/2023 Full Year*"]),
    dict(id="fies", name="Family Income and Expenditure Survey", publisher="Philippine Statistics Authority", url="https://psa.gov.ph/statistics/income-expenditure/fies", access="psa.gov.ph, in a browser.",
         use="Sets 2025 income levels for 82 provinces and 36 cities. Supplies income trends, income precision, deciles, income sources and Gini coefficients.",
         license="Official statistics, used with attribution",
         patterns=["data/raw/official_2025/FIES*", "data/raw/Table 1*"]),
    dict(id="sae", name="Municipal small-area poverty estimates", publisher="Philippine Statistics Authority", url="https://psa.gov.ph/statistics/poverty-sae", access="psa.gov.ph, in a browser.",
         use="Sets the pattern across municipalities inside each province. Latest round is 2023.",
         license="Official statistics, used with attribution",
         patterns=["data/raw/2_2023 SAE*"]),
    dict(id="census", name="2024 Census of Population and Housing", publisher="Philippine Statistics Authority", url="https://openstat.psa.gov.ph/", access="PSA OpenSTAT public API (PXWeb), one table per region.",
         use="Population, households and urban or rural status for every barangay. All weights in the dataset.",
         license="Official statistics, used with attribution",
         patterns=["data/raw/popcen2024/*"]),
    dict(id="openstat", name="Poverty and FIES tables on OpenSTAT", publisher="Philippine Statistics Authority", url="https://openstat.psa.gov.ph/", access="PSA OpenSTAT public API (PXWeb).",
         use="Cross-checks on the official workbooks, and the 2018 poverty line.",
         license="Official statistics, used with attribution",
         patterns=["data/raw/openstat/*"]),
    dict(id="psgc", name="Philippine Standard Geographic Code, 3Q 2026", publisher="Philippine Statistics Authority", url="https://psa.gov.ph/classification/psgc", access="psa.gov.ph, in a browser.",
         use="Current list of 42,010 barangays and 1,642 cities and municipalities. The Summary of Changes supplies merges, new barangays and renames.",
         license="Official statistics, used with attribution",
         patterns=["data/raw/psgc/*"]),
    dict(id="boundaries", name="Barangay boundaries, 2023", publisher="altcoder/philippines-psgc-shapefiles, now faeldon/philippines-psgc-shapefiles", url="https://github.com/faeldon/philippines-psgc-shapefiles", access="Direct download.",
         use="Polygons for the map and for all satellite extraction. No newer boundaries exist in this form.",
         license="MIT",
         patterns=["data/raw/PH_Adm4_BgySubMuns.shp.zip"]),
    dict(id="cbms", name="Community-Based Monitoring System poverty reports, 2005 to 2018", publisher="Partnership for Economic Policy; City of Bacolod", url="https://www.pep-net.org/", access="PDF downloads, read with pdftotext.",
         use="Trains and tests the barangay pattern. It is the only published barangay-level poverty data found. It is not redistributed here.",
         license="Publisher's terms; the parsed table is not republished",
         patterns=["data/raw/cbms/*"]),
    dict(id="rwi", name="Relative Wealth Index", publisher="Meta, via the Humanitarian Data Exchange", url="https://data.humdata.org/dataset/relative-wealth-index", access="Direct download.",
         use="An outside check on the estimates. It is not a model input and is not redistributed here.",
         license="CC BY-NC 4.0",
         patterns=["data/raw/rwi/*"]),
]

SATELLITE = [
    ("Nighttime lights", "NOAA/VIIRS/DNB/ANNUAL_V21, _V22", "Average radiance", "2018, 2021, 2023, 2025"),
    ("AlphaEarth embeddings", "GOOGLE/SATELLITE_EMBEDDING/V1/ANNUAL", "64 learned land-surface features", "2018, 2021, 2023, 2025"),
    ("Sentinel-2", "COPERNICUS/S2_SR_HARMONIZED", "NDVI, NDBI, NDWI, and greenness of built-up areas", "2021, 2023, 2025. Too sparse before 2019"),
    ("Open Buildings", "GOOGLE/Research/open-buildings-temporal/v1", "Building count, height, presence", "2018, 2021, 2023; 2023 stands in for 2025"),
    ("GHSL built surface and volume", "JRC/GHSL/P2023A/GHS_BUILT_S, GHS_BUILT_V", "Built-up area and volume", "Nearest five-year epoch"),
    ("GHSL population", "JRC/GHSL/P2023A/GHS_POP", "Satellite population, for ratios only", "Nearest five-year epoch"),
    ("MODIS land temperature", "MODIS/061/MOD11A2", "Mean daytime temperature", "2018, 2021, 2023, 2025"),
    ("GHSL settlement form", "JRC/GHSL/P2023A/GHS_BUILT_C, GHS_BUILT_H", "Residential density classes, roads, greenery, building height", "One time, 2018"),
    ("SRTM elevation", "USGS/SRTMGL1_003", "Elevation and slope", "One time"),
    ("Travel time", "Malaria Atlas Project accessibility layers", "Time to the nearest city and health facility", "2015, 2019"),
]
