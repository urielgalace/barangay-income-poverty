"""
Render the site: templates plus the data files become static pages in docs/, ready for GitHub Pages.

Run after build_data.py. Figures quoted in the text come from the data files, so prose and numbers cannot drift apart.
"""
from __future__ import annotations
import hashlib
import json
import shutil
import sys
from datetime import datetime
from pathlib import Path

import numpy as np
from jinja2 import Environment, FileSystemLoader, StrictUndefined

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "website"))
import content as K  # noqa: E402

DOCS = ROOT / "docs"
DATA = DOCS / "data"
STATIC = ROOT / "website" / "static"
CACHE = ROOT / "website" / ".cache"
NAV = [("map", "Map"), ("trends", "Trends"), ("statistics", "Statistics"), ("calculator", "Calculator"), ("methodology", "Methodology"), ("versions", "Version History"), ("about", "About")]
PAGES = {
    "index": ("Barangay Income and Poverty Atlas", "Income and poverty estimates for all 42,010 barangays in the Philippines, based on official data from the Philippine Statistics Authority, satellite imagery and machine learning."),
    "map": ("Map", "Interactive map of household income and poverty in every Philippine barangay, city and municipality, with margins of error."),
    "trends": ("Trends", "Official household income, poverty, poverty line and inequality series from 2018 to 2025 for any Philippine region, province, city or municipality."),
    "statistics": ("Statistics", "Descriptive statistics on household income and poverty in the Philippines in 2025: regions, distribution, concentration, urban and rural, and full tables."),
    "calculator": ("Income Percentile Calculator", "See where your income ranks in the Philippines and in your area, which income class you belong to, and how your income compares with the living wage."),
    "methodology": ("Methodology", "How the barangay income and poverty estimates are made: the machine learning models, how they were tested, and every data source."),
    "versions": ("Version History", "The current version of the dataset and the data behind it. Future versions will be listed here."),
    "about": ("About", "About the Barangay Income and Poverty Atlas: common questions, how to report a problem, and credits."),
    "404": ("Page not found", "This page does not exist."),
}


def favicon():
    """A tiny silhouette of the archipelago, from the region layer's largest islands."""
    import shapely
    geo = json.load(open(DATA / "geo" / "region.json"))
    polys = []
    for parts in geo["geom"]:
        for rings in parts:
            a = np.array(rings[0], dtype=float)
            xy = np.cumsum(a.reshape(-1, 2), axis=0) / 1e4
            p = shapely.Polygon(xy)
            if p.is_valid and p.area > .12:
                polys.append(p)
    u = shapely.union_all(polys).simplify(.14)
    x0, y0, x1, y1 = u.bounds
    k = 27 / (y1 - y0)
    d = ""
    for p in shapely.get_parts(u):
        c = np.array(p.exterior.coords)[:-1]
        px = (c[:, 0] - x0) * k * .976 + (32 - (x1 - x0) * k * .976) / 2
        py = (y1 - c[:, 1]) * k + 2.5
        d += "M" + "L".join(f"{a:.1f},{b:.1f}" for a, b in zip(px, py)) + "Z"
    (DOCS / "assets" / "favicon.svg").write_text(f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="6" fill="#0a1c24"/><path d="{d}" fill="#fb794d"/></svg>')


def share_image(meta):
    """The picture a link preview shows."""
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    from matplotlib.path import Path as MPath
    from matplotlib.patches import PathPatch
    geo = json.load(open(DATA / "geo" / "home.json"))
    lg = json.load(open(DATA / "lgus.json"))
    values = {r[0]: r[lg["cols"].index("i")] for r in lg["rows"]}
    breaks, colors = [20000, 25000, 30000, 35000, 40000, 50000], ["#20385c", "#2b5087", "#376ab5", "#4685e2", "#64a3ff", "#91c2ff", "#c2e0ff"]
    fig = plt.figure(figsize=(12, 6.3), dpi=100, facecolor="#0a1c24")
    ax = fig.add_axes([.60, .02, .38, .96])
    ax.set_xlim(0, geo["w"]); ax.set_ylim(geo["h"], 0); ax.set_aspect("equal"); ax.axis("off")
    import re
    for i, d in zip(geo["ids"], geo["d"]):
        v = values.get(i)
        col = "#22323a" if v is None else colors[int(np.searchsorted(breaks, v, side="right"))]
        for ring in re.findall(r"M([^l]+)l([^z]*)z", d):
            x, y = map(float, ring[0].split(","))
            pts = [(x, y)]
            for tok in ring[1].split():
                a, b = map(float, tok.split(","))
                x, y = x + a, y + b
                pts.append((x, y))
            pts.append(pts[0])
            ax.add_patch(PathPatch(MPath(pts), facecolor=col, edgecolor="#0a1c24", lw=.1))
    family = ["Arial Narrow", "Helvetica Neue", "DejaVu Sans"]
    fig.text(.05, .74, "Income and poverty\nin every barangay", color="#e7f0f2", fontsize=46, fontweight="bold", family=family, va="center", linespacing=1.05)
    fig.text(.05, .47, f"Estimates for all {meta['barangays']:,} barangays in the Philippines,\nbased on official PSA data, satellite imagery\nand machine learning.", color="#a5bac1", fontsize=19, family=family, va="center", linespacing=1.3)
    fig.text(.05, .1, "Barangay Income and Poverty Atlas", color="#e7f0f2", fontsize=20, fontweight="bold", family=family)
    fig.savefig(DOCS / "assets" / "share.png", dpi=100, facecolor=fig.get_facecolor())
    plt.close(fig)


def main():
    (DOCS / "assets" / "js").mkdir(parents=True, exist_ok=True)
    h = hashlib.sha256()
    for f in sorted(STATIC.rglob("*")) + [DATA / "meta.json", DATA / "versions.json", DATA / "methodology.json", DATA / "calculator.json"]:
        if f.is_file():
            h.update(f.read_bytes())
    build = h.hexdigest()[:10]
    shutil.copy(STATIC / "site.css", DOCS / "assets" / "site.css")
    for f in (STATIC / "js").glob("*.js"):
        # modules import each other, so cache-busting has to run through their import lines
        text = f.read_text().replace('.js";', f'.js?b={build}";')
        (DOCS / "assets" / "js" / f.name).write_text(text)
    meta = json.load(open(DATA / "meta.json"))
    val = json.load(open(CACHE / "validation.json"))
    sources = json.load(open(CACHE / "sources.json"))
    n_versions = len(json.load(open(DATA / "versions.json"))["versions"])
    method = json.load(open(DATA / "methodology.json"))
    calc = json.load(open(DATA / "calculator.json"))

    env = Environment(loader=FileSystemLoader(ROOT / "website" / "templates"), autoescape=True, undefined=StrictUndefined, trim_blocks=False, lstrip_blocks=False)
    env.filters["num"] = lambda v: f"{int(round(float(v))):,}"
    env.filters["bytes"] = lambda v: f"{v / 1e6:.1f} MB" if v >= 1e6 else f"{v / 1e3:.0f} KB"
    env.filters["longdate"] = lambda s: datetime.strptime(s, "%Y-%m-%d").strftime("%-d %B %Y")
    common = dict(meta=meta, val=val, nav=NAV, site=K.SITE, repo=K.REPO, build=build, sources=sources, satellite=K.SATELLITE, n_versions=n_versions, method=method, calc=calc)
    for page, (title, desc) in PAGES.items():
        html = env.get_template(f"{page}.html.j2").render(page=page, page_title=title, description=desc, path="" if page == "index" else f"{page}.html", **common)
        (DOCS / f"{page}.html").write_text(html)
    (DOCS / ".nojekyll").write_text("")
    (DOCS / "robots.txt").write_text(f"User-agent: *\nAllow: /\nSitemap: {K.SITE}sitemap.xml\n")
    urls = "".join(f"<url><loc>{K.SITE}{'' if p == 'index' else p + '.html'}</loc></url>" for p in PAGES if p != "404")
    (DOCS / "sitemap.xml").write_text(f'<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">{urls}</urlset>')
    favicon()
    share_image(meta)
    print("built", len(PAGES), "pages, build", build)


if __name__ == "__main__":
    main()
