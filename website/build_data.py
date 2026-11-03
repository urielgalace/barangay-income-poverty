"""
Build every data file the website reads, from the pipeline's outputs and PSA's own workbooks.

Run after build_geometry.py. Nothing here changes an estimate: it only reshapes published results for the browser.

All income leaves this script in pesos per month.

Output (docs/data/):
  meta.json            headline figures and site facts
  lgus.json            one row per city or municipality
  areas.json           one row per province-level area, plus regions
  chunks.json          which province file covers which part of the map
  bgy/<chunk>.json     barangay values, in the same order as bgy/<chunk>.geo.json
  search.json          every barangay and LGU name, for the search box
  suggest.json         a sample of distinctive barangay names, for the search box's suggestion
  series.json          official time series for every area
  stats.json           tables behind the statistics page
  versions.json        the version history
  methodology.json     held-out model scores and input importance, for the methodology page

Also writes validation.json and sources.json to website/.cache/, for the methodology page.
"""
from __future__ import annotations
import glob
import hashlib
import io
import json
import re
import shutil
import sys
from pathlib import Path

import numpy as np
import pandas as pd
from scipy.interpolate import PchipInterpolator
from scipy.optimize import minimize
from scipy.special import betainc, gammaln
from scipy.stats import spearmanr

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))
sys.path.insert(0, str(ROOT / "website"))
from build_official_stats import classify, norm_area, num  # noqa: E402
import content as K  # noqa: E402

OUT = ROOT / "docs" / "data"
CACHE = ROOT / "website" / ".cache"
OUTPUTS = ROOT / "outputs"
PROCESSED = ROOT / "data" / "processed"
RAW = ROOT / "data" / "raw"
POV25 = RAW / "official_2025" / "2025 Full Year Official Poverty Statistics_24Aug2026_0.xlsx"
POV23 = glob.glob(str(RAW / "2023 Full Year Official Poverty*.xlsx"))[0]
FIES1, FIES3, FIES4, FIES8 = [RAW / "official_2025" / f"FIES2025p_Table_{n}.xlsx" for n in (1, 3, 4, 8)]

SHORT = {
    "National Capital Region (NCR)": "NCR", "Cordillera Administrative Region (CAR)": "CAR", "Region I (Ilocos Region)": "Ilocos",
    "Region II (Cagayan Valley)": "Cagayan Valley", "Region III (Central Luzon)": "Central Luzon", "Region IV-A (CALABARZON)": "CALABARZON",
    "MIMAROPA Region": "MIMAROPA", "Region V (Bicol Region)": "Bicol", "Region VI (Western Visayas)": "Western Visayas",
    "Negros Island Region (NIR)": "Negros Island", "Region VII (Central Visayas)": "Central Visayas", "Region VIII (Eastern Visayas)": "Eastern Visayas",
    "Region IX (Zamboanga Peninsula)": "Zamboanga Peninsula", "Region X (Northern Mindanao)": "Northern Mindanao", "Region XI (Davao Region)": "Davao",
    "Region XII (SOCCSKSARGEN)": "SOCCSKSARGEN", "Region XIII (Caraga)": "Caraga", "Bangsamoro Autonomous Region In Muslim Mindanao (BARMM)": "BARMM"}


def canon(kind, key):
    """PSA spells regions differently from table to table. Use the poverty tables' spelling everywhere."""
    if kind != "region":
        return key
    m = re.match(r"region (iva|iv a|ivb|xiii|xii|xi|x|ix|viii|vii|vi|v|iv|iii|ii|i)\b", key)
    if m:
        return "region " + m.group(1).replace("iva", "iv a")
    if key.startswith("caraga"):
        return "region xiii"
    if "negros island" in key:
        return "negros island region"
    if key.startswith("bangsamoro"):
        return "bangsamoro autonomous region in muslim mindanao"
    if key.startswith("cordillera"):
        return "cordillera administrative region"
    return key


def area_key(n):
    n = re.sub(r"^CAR\s*-\s*", "", str(n).strip())
    kind = classify(n)
    return kind, canon(kind, norm_area(n))


def area_item_key(level, name):
    """Series key of a province-level area. Isabela and Cotabato are each both a province and a city with official figures."""
    return f"a:{norm_area(name)}{' city' if level == 'city' else ''}"


def monthly(k):
    """₱ thousand per year, as PSA publishes it, to ₱ per month."""
    return k * 1000 / 12


def clean(v, nd=None):
    """Plain JSON value: no numpy types, no NaN."""
    if v is None:
        return None
    if isinstance(v, (float, np.floating)):
        if np.isnan(v) or np.isinf(v):
            return None
        v = float(v)
        if nd == 0:
            return int(round(v))
        return round(v, nd) if nd is not None else v
    if isinstance(v, (int, np.integer)):
        return int(v)
    return v


def dump(name, obj, folder=OUT):
    path = folder / name
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, "w") as f:
        json.dump(obj, f, separators=(",", ":"), ensure_ascii=False, allow_nan=False)
    return path.stat().st_size


def table(df, cols, nd=None):
    nd = nd or {}
    return {"cols": cols, "rows": [[clean(v, nd.get(c)) for c, v in zip(cols, r)] for r in df[cols].itertuples(index=False, name=None)]}


def wavg(x, w):
    x, w = np.asarray(x, float), np.asarray(w, float)
    ok = ~np.isnan(x) & ~np.isnan(w) & (w > 0)
    return float(np.average(x[ok], weights=w[ok])) if ok.any() else np.nan


# ------------------------------------------------------------------------------------------------- current data
def load_current():
    d = pd.read_csv(OUTPUTS / "national_barangay_income_poverty_2025.csv", low_memory=False,
                    dtype={c: str for c in ("bgy_pcode", "psgc_2026", "city_psgc", "prov_psgc", "reg_psgc")})
    idx = pd.read_csv(CACHE / "geometry_index.csv", dtype={"bgy_pcode": str, "chunk": str})
    d = d.merge(idx, on="bgy_pcode", how="left")
    d["width"] = d.poverty_pi_hi - d.poverty_pi_lo
    d["reg_short"] = d.reg_name.map(SHORT)
    return d, d[d.poverty_rate_2025.notna()].copy()


def write_lgus(d, e):
    t = pd.read_csv(OUTPUTS / "national_city_municipal_income_poverty_2025.csv", dtype={"city_psgc": str})
    pts = pd.read_csv(CACHE / "lgu_points.csv", dtype={"city_psgc": str, "reg_psgc": str})
    t = t.merge(pts, on="city_psgc", how="left")
    extra = e.groupby("city_psgc").agg(src=("municipal_prior_source", "first"), reg=("reg_short", "first"), area=("area_km2", "sum"), income_class=("city_income_class", "first")).reset_index()
    extra["w"] = extra.city_psgc.map({k: wavg(s.width, s.population_2024) for k, s in e.groupby("city_psgc")})
    t = t.merge(extra, on="city_psgc", how="left")
    t["reg"] = t.reg.fillna(t.reg_name.map(SHORT))
    t["city_class"] = t.city_class.fillna("")
    t["prov_name"] = t.prov_name.fillna("")
    t["density"] = t.population_2024 / t.area.clip(lower=1e-3)
    t = t.sort_values("city_psgc").reset_index(drop=True)
    for c in ("income_k_2025", "barangay_income_min", "barangay_income_max"):
        t[c] = monthly(t[c])
    t = t.rename(columns={"city_psgc": "id", "city_name": "name", "city_class": "cls", "prov_name": "prov", "population_2024": "pop", "households_2024": "hh",
                          "poverty_rate_2025": "p", "poverty_rate_strict_official": "ps", "poor_persons_2025": "poor", "income_k_2025": "i", "barangay_units": "nb",
                          "barangay_poverty_min": "pmin", "barangay_poverty_max": "pmax", "barangay_income_min": "imin", "barangay_income_max": "imax", "area_key": "parent"})
    cols = ["id", "name", "cls", "prov", "reg", "parent", "pop", "hh", "p", "ps", "poor", "i", "nb", "pmin", "pmax", "imin", "imax", "density", "lon", "lat", "src", "w"]
    dump("lgus.json", table(t, cols, {"p": 2, "ps": 2, "i": 0, "pmin": 2, "pmax": 2, "imin": 0, "imax": 0, "density": 0, "w": 1}))
    return t


def write_areas(d, e):
    rec = pd.read_csv(OUTPUTS / "national_area_reconciliation_2025.csv")
    pr = rec[rec.measure == "poverty %"]
    ir = rec[rec.measure == "family income k"]
    pts = pd.read_csv(CACHE / "area_points.csv")
    g = e.groupby("poverty_anchor_area")
    a = g.agg(pop=("population_2024", "sum"), hh=("households_2024", "sum"), nb=("bgy_pcode", "size"), poor=("poor_persons_2025", "sum"), reg=("reg_short", "first")).reset_index()
    a["i"] = [monthly(wavg(s.income_k_2025, s.households_2024.clip(lower=1))) for _, s in g]
    a = a.merge(pr[["area", "official_2025", "cv", "dataset", "strict", "level"]], left_on="poverty_anchor_area", right_on="area", how="left").merge(pts, left_on="poverty_anchor_area", right_on="area_key", how="left")
    a["sga"] = a.area.str.startswith("Special Geographic")
    a = a.rename(columns={"poverty_anchor_area": "id", "official_2025": "official", "dataset": "p", "strict": "ps"})
    a["name"] = a.id
    prov = table(a, ["id", "name", "reg", "level", "pop", "hh", "nb", "poor", "official", "cv", "p", "ps", "i", "lon", "lat"], {"official": 2, "cv": 1, "p": 2, "ps": 2, "i": 0})

    rp = pd.read_csv(CACHE / "region_points.csv", dtype={"reg_psgc": str})
    g = e.groupby("reg_psgc")
    r = g.agg(pop=("population_2024", "sum"), hh=("households_2024", "sum"), nb=("bgy_pcode", "size"), poor=("poor_persons_2025", "sum"), name=("reg_name", "first"), short=("reg_short", "first")).reset_index()
    r["official"] = r.name.map(pr[pr.level == "region"].set_index("area").official_2025)
    r["p"] = r.name.map(pr[pr.level == "region"].set_index("area").dataset)
    r["i_official"] = monthly(r.name.map(ir[ir.level == "region"].set_index("area").official_2025))
    r["i"] = monthly(r.name.map(ir[ir.level == "region"].set_index("area").dataset))
    r = r.merge(rp, on="reg_psgc", how="left").rename(columns={"reg_psgc": "id"})
    reg = table(r, ["id", "name", "short", "pop", "hh", "nb", "poor", "official", "p", "i_official", "i", "lon", "lat"], {"p": 2, "i": 0, "i_official": 0})
    dump("areas.json", {"province": prov, "region": reg})
    return a, r


def write_chunks(d):
    ch = pd.read_csv(CACHE / "chunks.csv", dtype={"chunk": str})
    dump("chunks.json", table(ch, ["chunk", "n", "x0", "y0", "x1", "y1"]))
    src_order = sorted(d.municipal_prior_source.dropna().unique())
    for chunk, s in d.groupby("chunk"):
        geo = json.load(open(OUT / "bgy" / f"{chunk}.geo.json"))
        s = s.set_index("bgy_pcode").reindex(geo["ids"])
        rows = {
            "ids": geo["ids"], "n": s.bgy_name.fillna("").tolist(), "c": s.city_psgc.tolist(), "psgc": [None if pd.isna(v) else v for v in s.psgc_2026],
            "t": s.unit_type.map({"barangay": 0, "barangay_split": 1, "barangay_merged": 2, "non_barangay_area": 3}).astype(int).tolist(),
            "u": s.urban_2024.map({"U": 1, "R": 0}).astype(object).where(s.urban_2024.notna(), None).tolist(),
            "m": s.name_match.fillna("").tolist(),
            "p": [clean(v, 2) for v in s.poverty_rate_2025], "pl": [clean(v, 1) for v in s.poverty_pi_lo], "ph": [clean(v, 1) for v in s.poverty_pi_hi],
            "ps": [clean(v, 2) for v in s.poverty_rate_strict_official],
            "i": [clean(monthly(v), 0) for v in s.income_k_2025], "il": [clean(monthly(v), 0) for v in s.income_pi_lo], "ih": [clean(monthly(v), 0) for v in s.income_pi_hi],
            "h": [clean(v) if pd.notna(v) else None for v in s.population_2024], "f": [clean(v) if pd.notna(v) else None for v in s.households_2024],
            "a": [clean(v, 2) for v in s.area_km2],
            "x": [clean(v, 4) for v in s.lon], "y": [clean(v, 4) for v in s.lat],
        }
        dump(f"bgy/{chunk}.json", rows)
    return src_order


def write_search(d, lgus):
    """Compact name index. Barangays point at their LGU by position, so city and province names repeat only once."""
    lpos = {k: i for i, k in enumerate(lgus.id)}
    b = d[d.unit_type != "non_barangay_area"].sort_values("bgy_name")
    rows = [[n, lpos[c], ch, lon, lat, pc] for n, c, ch, lon, lat, pc in zip(b.bgy_name, b.city_psgc, b.chunk, b.lon, b.lat, b.bgy_pcode) if c in lpos]
    dump("search.json", {"b": rows})


def write_suggest(d):
    """Names for the search box's random suggestion: distinctive, short, and with residents."""
    b = d[(d.unit_type == "barangay") & d.poverty_rate_2025.notna()]
    uses = b.bgy_name.value_counts()
    keep = uses[uses <= 3].index
    names = [n for n in keep if len(n) <= 22 and not re.match(r"(barangay|bgy|zone|poblacion|district|purok|sector)\b", n, re.I) and not re.search(r"\d", n)]
    rng = np.random.default_rng(42)
    dump("suggest.json", sorted(rng.choice(names, size=min(600, len(names)), replace=False).tolist()))


# ------------------------------------------------------------------------------------------------- time series
def parse_ci_tab2():
    t = pd.read_excel(POV25, sheet_name="tab2", header=None)
    out = {}
    thresholds = {}
    for _, r in t.iloc[7:].iterrows():
        n = r[0]
        if pd.isna(n) or str(n).strip().lower().startswith(("notes", "r1", "r2", "1/", "2/", "a/", "b/", "c/", "source")):
            continue
        key = area_key(n)
        for yr, (lo, hi) in {2021: (13, 14), 2023: (15, 16), 2025: (17, 18)}.items():
            out.setdefault((*key, yr), (num(r[lo]), num(r[hi])))
        for yr, c in {2021: 1, 2023: 2, 2025: 3}.items():
            if pd.notna(num(r[c])):
                thresholds.setdefault(key, {})[yr] = float(num(r[c]))
    return out, thresholds


def parse_magnitude():
    """Poor population in thousands, 2021-2025 from the 2025 workbook, 2018 from the 2023 workbook."""
    out = {}
    t = pd.read_excel(POV25, sheet_name="tab6", header=None)
    for _, r in t.iloc[6:].iterrows():
        n = r[0]
        if pd.isna(n) or pd.isna(num(r[1])):
            continue
        key = area_key(n)
        for yr, (v, lo, hi) in {2021: (1, 10, 11), 2023: (2, 12, 13), 2025: (3, 14, 15)}.items():
            if pd.notna(num(r[v])):
                out.setdefault(key, {}).setdefault(yr, (float(num(r[v])), num(r[lo]), num(r[hi])))
    t = pd.read_excel(POV23, sheet_name="tab6", header=None)
    for _, r in t.iloc[6:].iterrows():
        n = r[0]
        if pd.isna(n) or pd.isna(num(r[1])) or re.search(r"w/o", str(n)):
            continue
        key = area_key(n)
        if key in out and 2018 not in out[key]:
            out[key][2018] = (float(num(r[1])), np.nan, np.nan)
    return out


def parse_fies_extra():
    """Expenditure (Table 1), income precision and deciles (Table 3), Gini (Table 8), income sources (Table 4)."""
    expend, cv, deciles, gini, sources = {}, {}, {}, {}, {}
    t = pd.read_excel(FIES1, header=None)
    for _, r in t.iloc[6:].iterrows():
        n = r[1]
        if pd.isna(n) or pd.isna(num(r[8])):
            continue
        key = area_key(n)
        if key not in expend:
            expend[key] = {2021: float(num(r[8])), 2023: float(num(r[9])), 2025: float(num(r[10]))}
    t = pd.read_excel(FIES3, header=None)
    cur = None
    for _, r in t.iloc[6:].iterrows():
        if pd.notna(r[1]) and str(r[2]).strip() == "All Income Groups":
            cur = area_key(r[1])
            if cur not in cv:
                cv[cur] = {2021: num(r[6]), 2023: num(r[7]), 2025: num(r[8])}
                deciles[cur] = []
            else:
                cur = None
        elif cur is not None and "Decile" in str(r[2]):
            deciles[cur].append([clean(monthly(num(r[3])), 0), clean(monthly(num(r[4])), 0), clean(monthly(num(r[5])), 0), clean(num(r[8]), 2)])
    t = pd.read_excel(FIES8, header=None)
    for _, r in t.iloc[5:].iterrows():
        n = r[0]
        if pd.isna(n) or pd.isna(num(r[1])) and pd.isna(num(r[3])):
            continue
        key = area_key(n)
        if key not in gini:
            gini[key] = {y: clean(num(r[c]), 3) for y, c in {2021: 1, 2023: 2, 2025: 3}.items()}
    t = pd.read_excel(FIES4, header=None)
    cur = None
    for _, r in t.iloc[6:].iterrows():
        label = r[1]
        if pd.isna(label):
            continue
        label = re.sub(r"\s+", " ", str(label)).strip()
        if pd.isna(num(r[2])) and pd.isna(num(r[4])):
            if not label.lower().startswith(("notes", "p -", "details", "1/", "2/", "3/", "source")):
                cur = area_key(label)
                if cur in sources:
                    cur = None
                else:
                    sources[cur] = {}
            continue
        if cur is not None and label != "Share to Family Income":
            sources[cur][label] = [clean(num(r[2]), 2), clean(num(r[3]), 2), clean(num(r[4]), 2)]
    return expend, cv, deciles, gini, sources


def write_series(lgus, areas, regions):
    pov = pd.read_csv(PROCESSED / "official_poverty.csv")
    inc = pd.read_csv(PROCESSED / "official_income.csv")
    for t in (pov, inc):
        t["area_key"] = [canon(a, b) for a, b in zip(t.area_type, t.area_key)]
    pov = pov.drop_duplicates(["area_type", "area_key", "year"], keep="first")
    inc = inc.drop_duplicates(["area_type", "area_key", "year"], keep="first")
    sae = pd.read_csv(PROCESSED / "sae_municipal.csv", dtype={"corr6": str})
    amap = pd.read_csv(PROCESSED / "lgu_anchor_map.csv", dtype={"city_psgc": str, "sae_corr6": str})
    ci, thresholds = parse_ci_tab2()
    mag = parse_magnitude()
    expend, cvs, deciles, gini, sources = parse_fies_extra()

    def poverty_of(kind, key):
        s = pov[(pov.area_type == kind) & (pov.area_key == key)].sort_values("year")
        out = []
        for r in s.itertuples():
            lo, hi = ci.get((kind, key, r.year), (np.nan, np.nan))
            if pd.isna(lo) and pd.notna(r.se):
                lo, hi = max(r.poverty_rate - 1.96 * r.se, 0), r.poverty_rate + 1.96 * r.se
            out.append([int(r.year), clean(r.poverty_rate, 2), clean(lo, 2), clean(hi, 2), clean(r.cv, 1)])
        return out

    def income_of(kind, key):
        s = inc[(inc.area_type == kind) & (inc.area_key == key)].sort_values("year")
        out = []
        for r in s.itertuples():
            cv = cvs.get((kind, key), {}).get(r.year, np.nan)
            m = monthly(r.income_k)
            se = m * cv / 100 if pd.notna(cv) else np.nan
            out.append([int(r.year), clean(m, 0), clean(m - 1.96 * se, 0), clean(m + 1.96 * se, 0), clean(cv, 2)])
        return out

    def add_official(rec, kind, key, inc_kind=None, inc_key=None):
        rec["pov"] = poverty_of(kind, key)
        ik = (inc_kind or kind, inc_key or key)
        rec["inc"] = income_of(*ik)
        if ik in expend:
            rec["exp"] = [[y, clean(monthly(v), 0)] for y, v in sorted(expend[ik].items())]
        if ik in gini:
            rec["gini"] = [[y, v] for y, v in sorted(gini[ik].items()) if v is not None]
        if (kind, key) in mag:
            rec["poor"] = [[y, clean(v[0], 1), clean(v[1], 1), clean(v[2], 1)] for y, v in sorted(mag[(kind, key)].items())]
        if (kind, key) in thresholds:
            rec["line"] = [[y, clean(v, 0)] for y, v in sorted(thresholds[(kind, key)].items())]
        if ik in deciles and deciles[ik]:
            rec["dec"] = deciles[ik]

    xhuc = set(pov[pov.area_type == "province_xhuc"].area_key)
    items = {}
    ph = {"name": "Philippines", "type": "national"}
    add_official(ph, "national", "philippines")
    ph["line"] = [[2018, 25814]] + ph.get("line", [])     # 2018 threshold from PSA OpenSTAT
    items["ph"] = ph
    for r in regions.itertuples():
        key = canon("region", norm_area(r.name))
        rec = {"name": r.name, "short": r.short, "type": "region", "id2": r.id}
        add_official(rec, "region", key)
        items[f"r:{key}"] = rec
    for r in areas.itertuples():
        if r.sga:
            continue
        kind, key = r.level, norm_area(r.id)
        rec = {"name": r.id, "type": kind, "reg": r.reg, "est": clean(r.p, 2)}
        add_official(rec, kind, key)
        if kind == "province" and key in xhuc:
            rec["note"] = "PSA's poverty figures for this province include its highly urbanized cities. FIES income and spending figures leave them out."
        items[area_item_key(kind, r.id)] = rec
    parent_key = {r.id: area_item_key(r.level, r.id) for r in areas.itertuples()}
    sae_by = {k: s.sort_values("year") for k, s in sae.groupby("corr6")}
    am = amap.set_index("city_psgc")
    for r in lgus.itertuples():
        a = am.loc[r.id]
        rec = {"name": r.name, "type": "lgu", "prov": r.prov, "reg": r.reg, "est": clean(r.p, 2), "esti": clean(r.i, 0), "parent": parent_key.get(r.parent, f"a:{norm_area(r.parent)}")}
        own = (a.city_class in ("HUC", "ICC") or r.name in ("Pateros", "City of Isabela")) and len(poverty_of("city", a.city_key)) > 0
        if own:
            add_official(rec, "city", a.city_key)
            rec["src"] = "city"
            if a.inc_area_type == "city" and not rec["inc"]:
                rec["inc"] = income_of("city", a.inc_area_key)
        elif a.has_sae:
            s = sae_by[a.sae_corr6]
            rec["pov"] = [[int(x.year), clean(x.poverty_rate, 2), clean(x.ci_lo, 2), clean(x.ci_hi, 2), clean(x.cv, 1)] for x in s.itertuples()]
            rec["src"] = "sae"
            if a.inc_area_type == "city":
                rec["inc"] = income_of("city", a.inc_area_key)
                ik = ("city", a.inc_area_key)
                if ik in gini:
                    rec["gini"] = [[y, v] for y, v in sorted(gini[ik].items()) if v is not None]
        else:
            rec["pov"] = []
            rec["src"] = "none"
        items[f"m:{r.id}"] = rec
    NOT_COMPARABLE_2018 = {"r:bangsamoro autonomous region in muslim mindanao", "r:region ix"}
    for k in NOT_COMPARABLE_2018:
        items[k]["pov"] = [r for r in items[k]["pov"] if r[0] != 2018]
        items[k]["inc"] = [r for r in items[k]["inc"] if r[0] != 2018]
        if "poor" in items[k]:
            items[k]["poor"] = [r for r in items[k]["poor"] if r[0] != 2018]
        items[k]["note"] = "Figures for 2018 are excluded because Sulu was transferred from BARMM to Region IX in 2025, and the PSA revised only the 2021 and 2023 poverty estimates to reflect this change."
    items["r:region xii"]["note"] = "63 barangays moved from North Cotabato to BARMM. PSA revised 2021 poverty to match, but FIES 2021 income still counts them in this region."
    embo = "The 10 EMBO barangays moved from Makati to Taguig. PSA's 2021 and 2023 figures still count them in Makati, so each city's series is not comparable across that change."
    for k, q in items.items():
        if q.get("type") == "lgu" and q["name"] in ("City of Makati", "City of Taguig"):
            q["note"] = embo
    dump("series.json", items)
    return items, sources, deciles


# ------------------------------------------------------------------------------------------------- statistics
SOURCE_GROUPS = [("Wages and salaries", ["Wage/Salaries"]), ("Household businesses", ["Entrepreneurial Activities"]), ("Money from abroad", ["Cash Receipts from Abroad"]),
                 ("Money from within the country", ["Cash Receipts from Domestic Sources", "Received as Gifts", "Pension"]),
                 ("Imputed rent", ["Imputed Rent"]),
                 ("Everything else", ["Rentals Received", "Interest", "Dividends", "Other Source of Income, NEC", "Net Share of Crops, Aquaculture Products or Livestock Raised", "Net Receipt from Family Sustenance Activities"])]


def write_stats(d, e, lgus, areas, regions, items, sources, deciles):
    pop = e.population_2024.sum()
    poor = e.poor_persons_2025.sum()

    def group(s):
        return dict(n=len(s), pop=clean(s.population_2024.sum()), hh=clean(s.households_2024.sum()), poor=clean(s.poor_persons_2025.sum()),
                    p=clean(wavg(s.poverty_rate_2025, s.population_2024), 2), i=clean(monthly(wavg(s.income_k_2025, s.households_2024.clip(lower=1))), 0))

    # regions, with their urban and rural parts
    reg_rows = []
    for r in regions.itertuples():
        s = e[e.reg_psgc == r.id]
        u, v = s[s.urban_2024 == "U"], s[s.urban_2024 == "R"]
        key = f"r:{canon('region', norm_area(r.name))}"
        reg_rows.append(dict(id=r.id, name=r.name, short=r.short, key=key, pop=clean(r.pop), hh=clean(r.hh), nb=clean(r.nb), poor=clean(r.poor), p=clean(r.official, 2), i=clean(r.i_official, 0),
                             share_pop=clean(r.pop / pop * 100, 1), share_poor=clean(r.poor / poor * 100, 1), p_urban=clean(wavg(u.poverty_rate_2025, u.population_2024), 2),
                             p_rural=clean(wavg(v.poverty_rate_2025, v.population_2024), 2), urban_share=clean(u.population_2024.sum() / r.pop * 100, 1),
                             gini=(items.get(key, {}).get("gini") or [[None, None]])[-1][1]))

    # distribution of barangays, and of the people in them
    pov_bins = [0, 2, 5, 10, 15, 20, 30, 40, 50, 101]
    pov_labels = ["Under 2%", "2-5%", "5-10%", "10-15%", "15-20%", "20-30%", "30-40%", "40-50%", "50% or more"]
    inc_bins = [0, 15000, 20000, 25000, 30000, 35000, 40000, 50000, 65000, 500000]
    inc_labels = ["Under ₱15k", "₱15-20k", "₱20-25k", "₱25-30k", "₱30-35k", "₱35-40k", "₱40-50k", "₱50-65k", "₱65k or more"]
    e = e.assign(income_month=monthly(e.income_k_2025))

    def hist(col, bins, labels, weight):
        c = pd.cut(e[col], bins, right=False, labels=labels)
        g = e.groupby(c, observed=False)
        return [dict(label=k, n=int(len(s)), w=clean(s[weight].sum())) for k, s in g]

    # how concentrated are poor people?
    def curve(values):
        v = np.sort(np.asarray(values, float))[::-1]
        cum = np.cumsum(v) / v.sum()
        pick = np.unique(np.round(np.geomspace(1, v.size, 90)).astype(int))
        return dict(n=int(v.size), x=[int(i) for i in pick], y=[round(float(cum[i - 1]) * 100, 2) for i in pick],
                    half=int(np.searchsorted(cum, .5) + 1), eighty=int(np.searchsorted(cum, .8) + 1), tenth=round(float(cum[max(int(v.size * .1) - 1, 0)]) * 100, 1))

    # type of place
    kinds = []
    for label, mask in [("Metro Manila cities", e.reg_name.str.startswith("National Capital")),
                        ("Other highly urbanized and independent cities", e.city_class.isin(["HUC", "ICC"]) & ~e.reg_name.str.startswith("National Capital")),
                        ("Component cities", e.city_class.eq("CC")), ("Municipalities", e.city_class.isna() & ~e.reg_name.str.startswith("National Capital"))]:
        kinds.append(dict(label=label, **group(e[mask])))
    urban = [dict(label="Urban barangays", **group(e[e.urban_2024 == "U"])), dict(label="Rural barangays", **group(e[e.urban_2024 == "R"]))]

    # income sources, regions and country, 2025
    def source_row(key, name):
        s = sources.get(key)
        if not s:
            return None
        return dict(name=name, shares=[round(sum((s.get(c) or [0, 0, 0])[2] or 0 for c in cats), 2) for _, cats in SOURCE_GROUPS],
                    shares21=[round(sum((s.get(c) or [0, 0, 0])[0] or 0 for c in cats), 2) for _, cats in SOURCE_GROUPS])
    src_rows = [source_row(("national", "philippines"), "Philippines")]
    for r in regions.itertuples():
        row = source_row(("region", canon("region", norm_area(r.name))), r.short)
        if row:
            src_rows.append(row)
    src_rows = [r for r in src_rows if r]

    # thresholds in everyday terms
    line = dict(items["ph"]["line"])
    lines = {y: dict(year=y, per_person=v, family5_month=round(v * 5 / 12)) for y, v in line.items()}

    dump("stats.json", dict(
        regions=reg_rows, urban=urban, kinds=kinds,
        hist=dict(poverty=dict(labels=pov_labels, rows=hist("poverty_rate_2025", pov_bins, pov_labels, "population_2024")), income=dict(labels=inc_labels, rows=hist("income_month", inc_bins, inc_labels, "households_2024"))),
        concentration=dict(lgu=curve(lgus.poor), bgy=curve(e.poor_persons_2025)),
        sources=dict(groups=[g for g, _ in SOURCE_GROUPS], rows=src_rows),
        deciles=deciles[("national", "philippines")], lines=list(lines.values())))
    return reg_rows


def write_meta(d, e, items, reg_rows):
    ph = items["ph"]
    pov = {r[0]: r for r in ph["pov"]}
    inc = {r[0]: r for r in ph["inc"]}
    poor = {r[0]: r for r in ph["poor"]}
    t = pd.read_excel(POV25, sheet_name="tab1", header=None)
    fam = t[t[0].astype(str).str.strip() == "PHILIPPINES"].iloc[0]
    lines = dict(ph["line"])
    rec = pd.read_csv(OUTPUTS / "national_area_reconciliation_2025.csv")
    r0 = rec[(rec.measure == "poverty %") & (rec.level == "national")].iloc[0]
    i0 = rec[(rec.measure == "family income k") & (rec.level == "national")].iloc[0]
    meta = dict(
        version=K.CURRENT, version_date=K.VERSIONS[0]["date"], repo=K.REPO, site=K.SITE,
        poverty=pov[2025][1], poverty_lo=pov[2025][2], poverty_hi=pov[2025][3], poverty_2023=pov[2023][1], poverty_families=clean(num(fam[6]), 1),
        poor_official_m=round(poor[2025][1] / 1000, 2), poor_dataset_m=round(e.poor_persons_2025.sum() / 1e6, 2), poverty_dataset=round(float(r0.dataset), 2),
        income=inc[2025][1], income_2023=inc[2023][1], income_dataset=round(monthly(float(i0.dataset))), gini=(ph.get("gini") or [[0, None]])[-1][1],
        population=int(e.population_2024.sum()), population_official=112729484, households=int(e.households_2024.sum()), barangays=42010, units=int((d.unit_type != "non_barangay_area").sum()),
        lgus=1642, regions=18, provinces=82, polygons=len(d), blank=int(d[(d.unit_type != "non_barangay_area") & d.poverty_rate_2025.isna()].shape[0]), nonbarangay=int((d.unit_type == "non_barangay_area").sum()),
        line_per_person=lines[2025], line_family5_month=round(lines[2025] * 5 / 12), median_pi=round(float((e.poverty_pi_hi - e.poverty_pi_lo).median()), 1),
        median_poverty=round(float(e.poverty_rate_2025.median()), 1), median_income=round(monthly(float(e.income_k_2025.median()))))
    dump("meta.json", meta)
    return meta


# ------------------------------------------------------------------------------------------------- validation
def parse_logs():
    logs = PROCESSED / "experiment_logs"
    out = {}
    s = (logs / "smoothing_out_of_time.log").read_text()
    rows = re.findall(r"(\d{4}) smoothed with (\d{4}) as prior, scored on official (\d{4}): (\d+) areas.*?moved over 1 pp (\d+)\n\s+mean error: raw ([\d.]+) pp, smoothed ([\d.]+) pp, difference ([+-][\d.]+) \[([+-][\d.]+),([+-][\d.]+)\] \| closer in (\d+) of (\d+)", s)
    out["smoothing"] = [dict(year=int(a), prior=int(b), scored=int(c), areas=int(d_), moved=int(m), raw=float(r), smooth=float(sm), diff=float(df), lo=float(lo), hi=float(hi), closer=int(cl), of=int(of)) for a, b, c, d_, m, r, sm, df, lo, hi, cl, of in rows]
    m = re.search(r"over 1 pp from shrinkage alone (\d+) \| after re-benchmarking (\d+), ([\d.]+)M people", s)
    v = re.search(r"variant, impute only the four provinces and re-benchmark: over 1 pp (\d+) areas, ([\d.]+)M people", s)
    out["smoothing_moves"] = dict(shrink=int(m.group(1)), after=int(m.group(2)), after_m=float(m.group(3)), variant=int(v.group(1)), variant_m=float(v.group(2)))
    s = (logs / "municipal_pattern_vs_cbms.log").read_text()
    sec2 = s.split("=== 2.")[1].split("=== 3.")[0]
    out["municipal"] = [dict(name=a.strip(), rho=float(b), gain=float(c), lo=float(d_), hi=float(e_), better=int(f), of=int(g)) for a, b, c, d_, e_, f, g in re.findall(r"^ (.+?)\s+rank corr ([\d.]+) \| vs used ([+-][\d.]+) \[([+-][\d.]+),([+-][\d.]+)\] \| better in (\d+) of (\d+)", sec2, re.M)]
    sec3 = s.split("=== 3.")[1]
    out["barangay_in_province"] = [dict(name=a.strip(), rho=float(b), gain=float(c), lo=float(d_), hi=float(e_)) for a, b, c, d_, e_ in re.findall(r"^ (.+?)\s+rank corr ([\d.]+) \| vs used ([+-][\d.]+) \[([+-][\d.]+),([+-][\d.]+)\]\s*$", sec3, re.M)]
    h = re.search(r"barangay pattern alone ([\d.]+) \| true CBMS municipal rates \+ pattern \(ceiling\) ([\d.]+)", sec3)
    out["pattern_alone"], out["ceiling"] = float(h.group(1)), float(h.group(2))
    sec1 = s.split("=== 1.")[1].split("=== 2.")[0]
    out["forward"] = [dict(name=a.strip(), r2=float(b), rho=float(c)) for a, b, c in re.findall(r"^ (.+?): within-province R2 ([\d.]+) \| mean rank corr ([\d.]+)", sec1, re.M)]
    s = (logs / "seed_stability.log").read_text()
    m = re.search(r"pairwise corr: mean ([\d.]+)", s)
    a = re.search(r"across seeds: rho ([\d.]+) \(range ([\d.]+)-([\d.]+)\).*cities rho ([\d.]+) \(([\d.]+)-([\d.]+)\)", s)
    out["seed"] = dict(pair_corr=float(m.group(1)), rho=float(a.group(1)), lo=float(a.group(2)), hi=float(a.group(3)), city=float(a.group(4)), city_lo=float(a.group(5)), city_hi=float(a.group(6)),
                       cities=[dict(name=x.strip(), lo=float(y), hi=float(z)) for x, y, z in re.findall(r"^\s+(Pasay City|City of Bacolod|Naga City|City of Marikina|Olongapo City)\s+range ([\d.]+)-([\d.]+)", s, re.M)])
    return out


def write_validation(d):
    st = pd.read_csv(PROCESSED / "pattern_stats.csv", index_col=0).iloc[:, 0]
    hs = pd.read_csv(PROCESSED / "hindcast_stats.csv", index_col=0).iloc[:, 0]
    h = pd.read_csv(PROCESSED / "hindcast_municipal.csv")
    logit = lambda p: np.log(np.clip(p / 100, 1e-4, 1 - 1e-4) / (1 - np.clip(p / 100, 1e-4, 1 - 1e-4)))
    dev = lambda c: logit(h[c]) - logit(h[c]).groupby(h.prov_key).transform("mean")
    hx, hy = dev("pred").round(3), dev("p1").round(3)
    keep = h.groupby("prov_key").p1.transform("size") > 1
    hind = dict(x=hx[keep].tolist(), y=hy[keep].tolist(), n=h.city_name[keep].tolist())

    o = pd.read_csv(PROCESSED / "pattern_oof.csv", dtype={"bgy_pcode": str, "city_psgc": str})
    o["bin"] = pd.qcut(o.pred, 20, duplicates="drop")
    bins = o.groupby("bin", observed=True).agg(x=("pred", "mean"), y=("ydev", "mean"), n=("pred", "size"))
    # a density grid rather than raw points: the CBMS tables are the reports' own to publish
    xe = np.linspace(-2.5, 2.5, 41)
    ye = np.linspace(-4, 4, 41)
    grid, _, _ = np.histogram2d(o.pred, o.ydev, bins=[xe, ye])
    q = o[o.groupby("city_psgc").ydev.transform("size") >= 5]
    cb = pd.read_csv(PROCESSED / "cbms_barangay.csv", dtype={"bgy_pcode": str, "city_psgc": str})
    years = cb.groupby("area").year.first().astype(str)
    reports = []
    for g_, s in q.groupby("group"):
        rm = lambda c: s.groupby("city_psgc").apply(lambda z: spearmanr(z.ydev, z[c]).correlation, include_groups=False).mean()
        reports.append(dict(name=g_.replace("Province of ", ""), year=years.get(g_), n=len(s), rho=clean(rm("pred"), 3), city=bool(re.search("City", g_))))
    reports.sort(key=lambda r: -r["rho"])

    rec = pd.read_csv(OUTPUTS / "national_area_reconciliation_2025.csv")
    pa = rec[(rec.measure == "poverty %") & rec.level.isin(["province", "district", "city"])]
    official = table(pa, ["area", "official_2025", "cv", "dataset", "strict"], {"dataset": 2, "strict": 2})
    audit = pd.read_csv(OUTPUTS / "audit_results_2025.csv").fillna("")
    t = cb.merge(d[["bgy_pcode", "reg_name"]], on="bgy_pcode")
    cover = {SHORT[k]: int(v) for k, v in t.groupby("reg_name").size().items()}
    nreports = cb.area.nunique()
    y = cb.groupby("area").year.first().astype(str).str[:4].astype(int)
    ncr = sorted(t[t.reg_name.str.startswith("National Capital")].area.unique())
    logs = parse_logs()
    dump("validation.json", folder=CACHE, obj=dict(
        stats={k: clean(float(v), 4) for k, v in st.items()}, hindcast=hind, hindcast_stats={k: clean(float(v), 4) for k, v in hs.items()},
        calibration=dict(x=bins.x.round(3).tolist(), y=bins.y.round(3).tolist(), n=bins.n.tolist()), density=dict(x=[round(v, 3) for v in xe.tolist()], y=[round(v, 3) for v in ye.tolist()], z=grid.astype(int).tolist()),
        reports=reports, official=official, audit=table(audit, ["section", "check", "result", "basis", "detail"]),
        coverage=dict(regions=cover, n_reports=int(nreports), n_barangays=int(len(cb)), year_min=int(y.min()), year_max=int(y.max()), ncr=ncr),
        tests=logs))
    return logs


# ------------------------------------------------------------------------------------------------- versions
def sha(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for block in iter(lambda: f.read(1 << 20), b""):
            h.update(block)
    return h.hexdigest()


def load_version(v, current):
    """One row per current unit: poverty, income, weight. Merged units take a weighted average of their old polygons."""
    f = ROOT / v["data"]
    t = pd.read_csv(f, low_memory=False, dtype={"bgy_pcode": str})
    p, i, w = v["columns"]
    t = t.rename(columns={p: "_p", i: "_i", w: "_w"})
    keep = ["bgy_pcode", "_p", "_i", "_w"] + [c for c in ("poverty_pi_lo", "poverty_pi_hi") if c in t]
    if "bgy_name" in t:
        keep.append("bgy_name")
    t = t[keep]
    merged = current[current.merged_from.notna()]
    rows = []
    for r in merged.itertuples():
        parts = t[t.bgy_pcode.isin(r.merged_from.split(";"))]
        if len(parts) and r.bgy_pcode not in set(parts.bgy_pcode[parts.bgy_pcode == r.bgy_pcode]) or len(parts) > 1:
            rows.append(dict(bgy_pcode=r.bgy_pcode, _p=wavg(parts._p, parts._w), _i=wavg(parts._i, parts._w), _w=parts._w.sum()))
    if rows:
        over = pd.DataFrame(rows).set_index("bgy_pcode")
        t = t.set_index("bgy_pcode")
        t.loc[over.index, ["_p", "_i", "_w"]] = over[["_p", "_i", "_w"]]
        t = t.reset_index()
    t = t[t.bgy_pcode.isin(set(current.bgy_pcode))]
    return t


def describe_version(t):
    s = t[t._p.notna()]
    out = dict(rows=len(t), with_estimates=len(s), income=clean(monthly(wavg(s._i, s._w)), 0), poverty=clean(wavg(s._p, s._w), 2), population=clean(s._w.sum()),
               income_median=clean(monthly(s._i.median()), 0), poverty_median=clean(s._p.median(), 2))
    if "poverty_pi_lo" in s:
        out["pi_width_median"] = clean((s.poverty_pi_hi - s.poverty_pi_lo).median(), 1)
    return out


def diff_versions(a, b, current):
    """b relative to a, on the barangays both contain."""
    m = a.merge(b, on="bgy_pcode", suffixes=("_a", "_b"))
    m = m[m._p_a.notna() & m._p_b.notna()]
    dp, di = m._p_b - m._p_a, (m._i_b / m._i_a - 1) * 100
    dpop = (m._w_b / m._w_a.replace(0, np.nan) - 1) * 100
    out = dict(matched=len(m), poverty=dict(median=clean(dp.abs().median(), 2), p90=clean(dp.abs().quantile(.9), 2), p99=clean(dp.abs().quantile(.99), 2), max=clean(dp.abs().max(), 2), mean=clean(dp.mean(), 2),
                                            over1=int((dp.abs() > 1).sum()), over5=int((dp.abs() > 5).sum()), rank=clean(spearmanr(m._p_a, m._p_b).correlation, 3)),
               income=dict(median=clean(di.abs().median(), 2), p90=clean(di.abs().quantile(.9), 2), p99=clean(di.abs().quantile(.99), 2), max=clean(di.abs().max(), 2), mean=clean(di.mean(), 2),
                           over5=int((di.abs() > 5).sum()), over25=int((di.abs() > 25).sum()), rank=clean(spearmanr(m._i_a, m._i_b).correlation, 3)),
               population=dict(median=clean(dpop.abs().median(), 1), over50=int((dpop.abs() > 50).sum())))
    edges = [-100, -20, -10, -5, -2, -1, -.25, .25, 1, 2, 5, 10, 20, 100]
    labels = ["-20 or more", "-20 to -10", "-10 to -5", "-5 to -2", "-2 to -1", "-1 to -0.25", "within 0.25", "0.25 to 1", "1 to 2", "2 to 5", "5 to 10", "10 to 20", "20 or more"]
    out["hist"] = dict(labels=labels, counts=np.histogram(dp, bins=edges)[0].astype(int).tolist())
    edges_i = [-1000, -25, -10, -5, -2, -.5, .5, 2, 5, 10, 25, 10000]
    labels_i = ["-25% or more", "-25 to -10%", "-10 to -5%", "-5 to -2%", "-2 to -0.5%", "within 0.5%", "0.5 to 2%", "2 to 5%", "5 to 10%", "10 to 25%", "25% or more"]
    out["hist_income"] = dict(labels=labels_i, counts=np.histogram(di, bins=edges_i)[0].astype(int).tolist())
    reg = current[["bgy_pcode", "reg_short"]].merge(m[["bgy_pcode", "_p_a", "_p_b", "_w_b", "_i_a", "_i_b"]], on="bgy_pcode")
    out["regions"] = [dict(name=k, a=clean(wavg(s._p_a, s._w_b), 2), b=clean(wavg(s._p_b, s._w_b), 2), ia=clean(monthly(wavg(s._i_a, s._w_b)), 0), ib=clean(monthly(wavg(s._i_b, s._w_b)), 0)) for k, s in reg.groupby("reg_short")]
    if "bgy_name_a" in m and "bgy_name_b" in m:
        out["renamed"] = int((m.bgy_name_a.astype(str) != m.bgy_name_b.astype(str)).sum())
    return out


def write_versions(d):
    current = d[["bgy_pcode", "city_psgc", "chunk", "merged_from", "reg_short"]].copy()
    versions = K.VERSIONS
    frames = {v["id"]: load_version(v, current) for v in versions}
    lgus = json.load(open(OUT / "lgus.json"))
    lgu_ids = [r[0] for r in lgus["rows"]]
    shutil.rmtree(OUT / "versions", ignore_errors=True)
    out = []
    for v in versions:
        t = frames[v["id"]]
        rec = {k: v[k] for k in ("id", "date", "time_note", "label", "summary", "scope", "levels_from", "changes", "fixed", "docs", "no_new_inputs") if k in v}
        rec["stats"] = describe_version(t)
        out.append(rec)
        if len(versions) == 1:   # the site's own files already hold it
            continue
        # values for the map, aligned with the current geometry files
        vdir = f"versions/{v['id']}"
        x = current[["bgy_pcode", "chunk", "city_psgc"]].merge(t, on="bgy_pcode", how="left")
        for chunk, s in x.groupby("chunk"):
            geo = json.load(open(OUT / "bgy" / f"{chunk}.geo.json"))
            s = s.set_index("bgy_pcode").reindex(geo["ids"])
            if s._p.notna().any():
                dump(f"{vdir}/{chunk}.json", {"p": [clean(a, 2) for a in s._p], "i": [clean(monthly(a), 0) for a in s._i], "h": [None if pd.isna(a) else int(round(a)) for a in s._w]})
        g = x[x._p.notna()].groupby("city_psgc")
        lp = {k: (wavg(s._p, s._w), monthly(wavg(s._i, s._w))) for k, s in g}
        dump(f"{vdir}/lgu.json", {"p": [clean(lp[k][0], 2) if k in lp else None for k in lgu_ids], "i": [clean(lp[k][1], 0) if k in lp else None for k in lgu_ids]})
    diffs = {}
    ids = [v["id"] for v in versions]
    for i, a in enumerate(ids):
        for b in ids[:i]:
            diffs[f"{a}..{b}"] = diff_versions(frames[a], frames[b], current)
    dump("versions.json", dict(current=K.CURRENT, versions=out, diffs=diffs, log=K.build_log(RAW, ROOT)))


def pair_share(o, col):
    """How often a prediction orders two barangays of one municipality the same way the survey does."""
    right = total = 0
    for _, g in o[o.groupby("city_psgc").ydev.transform("size") >= 5].groupby("city_psgc"):
        i, j = np.triu_indices(len(g), 1)
        a, b = g.ydev.to_numpy()[i] - g.ydev.to_numpy()[j], g[col].to_numpy()[i] - g[col].to_numpy()[j]
        keep = a != 0
        right += int((np.sign(a[keep]) == np.sign(b[keep])).sum())
        total += int(keep.sum())
    return right / total


IMPORTANCE_LABELS = {"Buildings and settlement form": "Buildings and settlements", "AlphaEarth satellite embeddings": "AlphaEarth embeddings", "Terrain and access": "Terrain and accessibility"}


def write_methodology(e):
    """Every score here comes from data the model did not see in training."""
    st = pd.read_csv(PROCESSED / "pattern_stats.csv", index_col=0).iloc[:, 0]
    o = pd.read_csv(PROCESSED / "pattern_oof.csv", dtype={"bgy_pcode": str, "city_psgc": str})
    cb = pd.read_csv(PROCESSED / "cbms_barangay.csv")
    pc = pd.read_csv(PROCESSED / "disagg_comparison.csv")
    pa, pu = pc[pc.subset == "all CBMS"].set_index("model"), pc[pc.subset == "cities only"].set_index("model")
    ic = pd.read_csv(PROCESSED / "income_model_comparison.csv").set_index("model")
    ti = pd.read_csv(PROCESSED / "income_training_v2.csv")
    imp = pd.read_csv(PROCESSED / "feature_importance.csv")
    cov = e[e.city_psgc.isin(set(o.city_psgc))]
    mk = e[e.city_name == "City of Makati"].sort_values("income_k_2025", ascending=False).reset_index(drop=True)
    poverty_row = lambda label, key: dict(label=label, value=clean(pa.at[key, "rho_within"], 3), r2=clean(pa.at[key, "r2_within"], 3), cities=clean(pu.at[key, "rho_within"], 3))
    income_row = lambda label, key: dict(label=label, value=clean(ic.at[key, "r2_log"], 3), error=clean(ic.at[key, "mae_pct"], 1), ncr=clean(ic.at[key, "ncr_rho_2025"], 2))
    importance = lambda model: [dict(label=IMPORTANCE_LABELS.get(r.group, r.group), value=clean(r.drop, 3), score=clean(r.score, 3), inputs=int(r.n_inputs))
                                for r in imp[(imp.model == model) & (imp.group != "All inputs intact")].sort_values("drop", ascending=False).itertuples()]
    dump("methodology.json", dict(
        poverty=dict(rho=clean(st["rho_within"], 3), r2=clean(st["r2_within"], 3), pair=clean(pair_share(o, "pred") * 100, 1), share_positive=clean(st["share_positive"] * 100, 1),
                     rho_cities=clean(st["rho_within_cities"], 3), rho_2025=clean(st["rho_within_2025"], 3), coverage=clean(st["coverage_90_heldout"] * 100, 1),
                     cross_rho=clean(st["cross_rho"], 2), cross_provinces=int(st["cross_provinces"]), cross_n=int(st["cross_n"]), n=int(st["n_cbms"]), munis=int(st["n_munis"]), reports=int(o.group.nunique()),
                     lights=clean(pa.at["nightlights alone (reversed)", "rho_within"], 3), lights_cities=clean(pu.at["nightlights alone (reversed)", "rho_within"], 3),
                     municipal=clean(pa.at["A municipal-trained (v2 features)", "rho_within"], 3)),
        income=dict(r2=clean(st["income_r2"], 3), error=clean(st["income_mape"] * 100, 1), gap_corr=clean(st["income_gap_corr"], 2), gap_ratio=clean(st["income_gap_mae"] / st["income_gap_naive_mae"], 2),
                    gap_cities=int(st["income_gap_cities"]), rows=len(ti), poverty_alone=clean(ic.at["poverty only, Ridge", "r2_log"], 3), boost=clean(ic.at["poverty + all, HGB", "r2_log"], 3), ridge=clean(ic.at["poverty + all, Ridge", "r2_log"], 3),
                    ncr_ridge=clean(ic.at["poverty + all, Ridge", "ncr_rho_2025"], 2), ncr_boost=clean(ic.at["poverty + all, HGB", "ncr_rho_2025"], 2)),
        coverage=dict(people=clean(cov.population_2024.sum() / e.population_2024.sum() * 100, 1), regions=int(cov.reg_name.nunique()), regions_total=int(e.reg_name.nunique()),
                      early=clean((cb.y0 <= 2008).mean() * 100, 1), year_min=int(cb.y0.min()), year_max=int(cb.y0.max())),
        forbes=dict(rank=int(mk.index[mk.bgy_name == "Forbes Park"][0]) + 1, of=len(mk)),
        income_models=[dict(label="Ridge + boosting (used)", value=clean(st["income_r2"], 3), error=clean(st["income_mape"] * 100, 1), used=True),
                       income_row("Gradient boosting", "poverty + all, HGB"), income_row("Extremely randomized trees", "poverty + all, ExtraTrees"), income_row("Ridge regression", "poverty + all, Ridge"),
                       income_row("Poverty rate alone", "poverty only, Ridge"), income_row("Satellite and census alone", "all features, Ridge")],
        poverty_models=[dict(label="Gradient boosting (used)", value=clean(st["rho_within"], 3), r2=clean(st["r2_within"], 3), cities=clean(st["rho_within_cities"], 3), used=True),
                        poverty_row("Ridge regression", "B barangay-trained Ridge"), poverty_row("Extremely randomized trees", "B barangay-trained ExtraTrees"),
                        dict(label="Nighttime lights alone", value=clean(pa.at["nightlights alone (reversed)", "rho_within"], 3), cities=clean(pu.at["nightlights alone (reversed)", "rho_within"], 3)),
                        poverty_row("Trained on municipal data", "A municipal-trained (v2 features)"),
                        dict(label="Population density alone", value=clean(pa.at["density alone (reversed)", "rho_within"], 3), cities=clean(pu.at["density alone (reversed)", "rho_within"], 3)),
                        dict(label="Relative Wealth Index", value=clean(pa.at["Meta RWI (reversed)", "rho_within"], 3), cities=clean(pu.at["Meta RWI (reversed)", "rho_within"], 3))],
        importance=dict(income=importance("income"), poverty=importance("poverty")),
    ))


def write_sources():
    rows = []
    for g in K.SOURCE_GROUPS:
        files = []
        seen = set()
        for pat in g["patterns"]:
            for f in sorted(glob.glob(str(ROOT / pat))):
                p = Path(f)
                if p.is_file() and p.suffix != ".txt" and p not in seen:
                    seen.add(p)
                    st = p.stat()
                    files.append(dict(name=p.name, size=st.st_size, added=pd.Timestamp(st.st_mtime, unit="s", tz="UTC").tz_convert("America/New_York").strftime("%Y-%m-%d"), sha256=sha(p)))
        rows.append({**{k: g[k] for k in ("id", "name", "publisher", "url", "access", "use", "license") if k in g}, "files": files})
    dump("sources.json", rows, folder=CACHE)


# ------------------------------------------------------------------------------------------------- income calculator
# FIES ranks families by income per person but reports their average family income, so comparing a person's income with it
# takes the size of the families in each income group. These pairs give the share of families and the share of people below
# the same point: official poverty among families and among the population in 2025, 2023, 2021 and 2018...
POOR_FAMILIES_PEOPLE = [(6.4, 9.7), (10.9, 15.5), (13.2, 18.1), (12.1, 16.7)]
# ...and PIDS's counts of families and persons (millions) in each income class in 2018 (Albert et al. 2020, slide 17).
PIDS_2018_FAMILIES = [2.9, 8.4, 7.6, 3.1, 1.2, .358, .143]
PIDS_2018_PERSONS = [17.7, 40.7, 31.0, 11.2, 3.8, 1.0, .36]


def person_bands():
    """Each family decile's share of people, as cumulative edges from 0 to 1."""
    fam, per = np.cumsum(PIDS_2018_FAMILIES) / sum(PIDS_2018_FAMILIES) * 100, np.cumsum(PIDS_2018_PERSONS) / sum(PIDS_2018_PERSONS) * 100
    pairs = sorted([(0, 0), (100, 100), *POOR_FAMILIES_PEOPLE, *zip(fam[1:6], per[1:6])])
    return PchipInterpolator(*zip(*pairs))(np.arange(0, 101, 10.)) / 100


def share_below(y, a, b, p):
    """The Dagum curve: the share of people with income per person below y."""
    return np.exp(-p * np.log1p((y / b) ** -a))


def fit_income_curve(means, edges, anchor=None):
    """Dagum curve matching the average income per person in each band of people and, softly, an official poverty rate."""
    width = np.diff(edges)

    def band_means(a, b, p):
        mean = b * np.exp(gammaln(p + 1 / a) + gammaln(1 - 1 / a) - gammaln(p))
        return mean * np.diff(betainc(p + 1 / a, 1 - 1 / a, edges ** (1 / p))) / width

    def loss(theta):
        a, b, p = np.exp(theta)
        if not (1.3 < a < 9 and .15 < p < 40):
            return 1e6
        err = (width * (np.log(band_means(a, b, p)) - np.log(means)) ** 2).sum()
        if anchor:
            err += .1 * (np.log(share_below(anchor[0], a, b, p)) - np.log(anchor[1])) ** 2
        return err

    starts = [(3, .8), (2.5, 1.4), (3.5, 3.)]
    fits = [minimize(loss, [np.log(a0), np.log(np.median(means)), np.log(p0)], method="Nelder-Mead", options=dict(xatol=2e-3, fatol=1e-8, maxiter=1200)) for a0, p0 in starts]
    return np.exp(min(fits, key=lambda r: r.fun).x)


def survey_family_sizes():
    """Average family size by area from FIES 2023 Table 10, counting families of seven or more as eight people."""
    raw = (RAW / "openstat" / "fies2023_table10_family_size.csv").read_bytes().decode("latin-1").lstrip("ï»¿")
    t = pd.read_csv(io.StringIO(raw))
    t.columns = ["area", "size", "total", "average", "x", "y"]
    size = dict(zip(["One person", "Two persons", "Three persons", "Four persons", "Five persons", "Six persons", "Seven persons or more"], [1, 2, 3, 4, 5, 6, 8]))
    t = t[t["size"].isin(size)]
    t["families"] = (pd.to_numeric(t.total, errors="coerce") / pd.to_numeric(t.average, errors="coerce")).fillna(0)
    t["people"] = t.families * t["size"].map(size)
    g = t.groupby("area", sort=False)[["families", "people"]].sum()
    out = {}
    for name, r in g.iterrows():
        name = re.sub(r"\d/$", "", str(name).strip().lstrip(".").strip())
        out["ph" if name == "PHILIPPINES" else area_key(name)] = r.people / r.families
    return out


def write_calculator(lgus, areas, regions, items, meta):
    edges = person_bands()
    size_share = np.diff(edges) * 10        # a decile's average family size, relative to all families
    # price index, all items: the latest month against the 2025 average
    cpi = pd.read_csv(io.StringIO((RAW / "openstat" / "cpi_all_items_2018base_2025_2026.csv").read_bytes().decode("utf-8-sig"))).iloc[0]
    cpi = {k: float(v) for k, v in cpi.items() if k[:4].isdigit() and v != ".."}
    latest = [k for k in cpi if k.startswith("2026")][-1]
    factor = cpi[latest] / cpi["2025 Ave"]
    prices = pd.Timestamp(f"{latest[5:]} {latest[:4]}").strftime("%B %Y")
    line = meta["line_per_person"] / 12

    # average family size: PSA's population base over FIES families nationally, and census and survey sizes for the differences between areas
    t = pd.read_excel(FIES1, header=None)
    fam = t[t[1].astype(str).str.strip() == "Philippines"].iloc[0]
    poor = {r[0]: r[1] for r in items["ph"]["poor"]}
    rate = {r[0]: r[1] for r in items["ph"]["pov"]}
    national_size = {y: poor[y] / rate[y] * 100 / num(fam[c]) for y, c in ((2023, 3), (2025, 4))}
    national_size[2018] = sum(PIDS_2018_PERSONS) / sum(PIDS_2018_FAMILIES)
    survey = survey_family_sizes()
    census_nat = meta["population"] / meta["households"]
    census = {"ph": census_nat}
    census.update({f"r:{canon('region', norm_area(r.name))}": r.pop / r.hh for r in regions.itertuples()})
    census.update({area_item_key(r.level, r.id): r.pop / r.hh for r in areas.itertuples() if r.hh > 0})
    census.update({f"m:{r.id}": r.pop / r.hh for r in lgus.itertuples() if r.hh > 0})
    ids = {"ph": "ph"}
    ids.update({f"r:{canon('region', norm_area(r.name))}": r.short for r in regions.itertuples()})
    ids.update({area_item_key(r.level, r.id): r.id for r in areas.itertuples()})
    ids.update({f"m:{r.id}": r.id for r in lgus.itertuples()})

    dist, tests = [], []
    for k, it in items.items():
        if "dec" not in it:
            continue
        m = np.array([r[2] for r in it["dec"]], dtype=float)
        s = survey.get("ph" if k == "ph" else area_key(it["name"]))
        relative = census[k] / census_nat * (s / survey["ph"] if s else census[k] / census_nat)
        means = m / (national_size[2025] * relative ** .5 * size_share)
        pov = {r[0]: r[1] for r in it.get("pov", [])}.get(2025)
        ann = dict(it.get("line") or []).get(2025)
        anchor = (ann / 12, pov / 100) if pov and ann else None
        a, b, p = fit_income_curve(means, edges, anchor)
        dist.append(dict(id=ids[k], a=round(float(a), 4), b=round(float(b), 1), p=round(float(p), 4), i=round(float(m.mean())), z=round(float(census[k]), 3)))
        if anchor:
            tests.append(dict(key=k, type=it["type"], official=pov, fit=100 * float(share_below(ann / 12, *fit_income_curve(means, edges)))))
    tests = pd.DataFrame(tests)
    err = (tests.fit - tests.official).abs()
    ph = {d["id"]: d for d in dist}["ph"]

    # the same method on 2023 and 2018, where nothing was tuned to the poverty line, and against PIDS's class shares for 2018
    t1 = pd.read_excel(glob.glob(str(RAW / "Table 1. 2018*"))[0], header=None)
    m18 = t1[t1[0].astype(str).str.strip() == "PHILIPPINES"].iloc[0, 2:12].to_numpy(float) * 1000 / 12
    m23 = np.array([r[1] for r in items["ph"]["dec"]], dtype=float)
    fit18 = fit_income_curve(m18 / (national_size[2018] * size_share), edges)
    fit23 = fit_income_curve(m23 / (national_size[2023] * size_share), edges)
    lines = dict(items["ph"]["line"])
    multiples = [c[1] for c in K.PIDS_CLASSES[1:]]
    pids_fit = np.diff([0, *(100 * share_below(lines[2018] / 12 * x, *fit18) for x in multiples), 100])
    pids_pub = np.array(PIDS_2018_PERSONS) / sum(PIDS_2018_PERSONS) * 100
    ph_test = tests[tests.key == "ph"].fit.iloc[0]
    check = dict(
        n=len(tests), mae=round(float(err.mean()), 1), mae_region=round(float(err[tests.type == "region"].mean()), 1), mae_province=round(float(err[tests.type == "province"].mean()), 1),
        corr=round(float(np.corrcoef(tests.fit, tests.official)[0, 1]), 2), ph_2025=round(float(ph_test), 1), ph_2023=round(float(100 * share_below(lines[2023] / 12, *fit23)), 1),
        ph_2018=round(float(100 * share_below(lines[2018] / 12, *fit18)), 1), pids_fit=[round(float(v), 2) for v in pids_fit], pids_published=[round(float(v), 2) for v in pids_pub],
        pids_max_gap=round(float(np.abs(pids_fit - pids_pub).max()), 1))

    index = {d["id"]: i for i, d in enumerate(dist)}
    region_of = {r.short: index[r.short] for r in regions.itertuples()}
    key_id = {area_item_key(r.level, r.id): r.id for r in areas.itertuples()}
    parent_key = {r.id: area_item_key(r.level, r.id) for r in areas.itertuples()}
    prov = {r.id: index.get(r.id, region_of[r.reg]) for r in areas.itertuples()}
    lgu = {}
    for r in lgus.itertuples():
        up = key_id.get(parent_key.get(r.parent))
        lgu[r.id] = index.get(r.id, index.get(up, region_of[r.reg]))
    classes = []
    for name, lo, hi in K.PIDS_CLASSES:
        below = lambda x: 100 * float(share_below(line * x, ph["a"], ph["b"], ph["p"])) if x else 0.
        classes.append(dict(name=name, lo=lo, hi=hi, share=round((below(hi) if hi else 100.) - below(lo), 2)))
    per_month = lambda d: round(d * K.IBON_DAYS / 12)
    wage = {"ph": dict(flw=K.IBON_NATIONAL["flw_month"], mw=K.IBON_NATIONAL["mw_month"], label="the Philippines")}
    for short, (label, mw, flw) in K.IBON_WAGES.items():
        wage[short] = dict(flw=per_month(flw) if flw else None, mw=per_month(mw), label=label)
    dump("calculator.json", dict(
        prices=prices, cpi_pct=round((factor - 1) * 100, 1), factor=round(factor, 5), line=round(line, 2), line_now=round(line * factor), line_year=meta["line_per_person"],
        line_now_family5=round(line * factor) * 5, classes=classes, wage=wage, negros=K.IBON_NEGROS, ibon_as_of=K.IBON_AS_OF, dist=dist, reg=region_of, prov=prov, lgu=lgu, check=check))
    print("calculator:", {k: check[k] for k in ("n", "mae", "mae_region", "mae_province", "corr", "ph_2025", "ph_2023", "ph_2018", "pids_max_gap")})
    print("  PIDS 2018 class shares, fitted", check["pids_fit"], "published", check["pids_published"])
    print("  2025 class shares", [c["share"] for c in classes], "curve", {k: ph[k] for k in "abp"}, "share of people below the line", round(100 * float(share_below(line, ph["a"], ph["b"], ph["p"])), 1))


def main():
    d, e = load_current()
    lgus = write_lgus(d, e)
    areas, regions = write_areas(d, e)
    write_chunks(d)
    write_search(d, lgus)
    write_suggest(d)
    items, sources, deciles = write_series(lgus, areas, regions)
    reg_rows = write_stats(d, e, lgus, areas, regions, items, sources, deciles)
    meta = write_meta(d, e, items, reg_rows)
    logs = write_validation(d)
    write_versions(d)
    write_methodology(e)
    write_calculator(lgus, areas, regions, items, meta)
    write_sources()
    print({k: meta[k] for k in ("poverty", "poverty_lo", "poverty_hi", "poor_official_m", "income", "gini", "line_family5_month", "poverty_families")})
    print("smoothing:", logs["smoothing"])
    sizes = {p.name: round(p.stat().st_size / 1e6, 2) for p in OUT.glob("*.json")}
    print(sizes)


if __name__ == "__main__":
    main()
