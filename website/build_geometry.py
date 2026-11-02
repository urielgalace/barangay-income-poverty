"""
Turn the 308 MB barangay GeoPackage into small JSON files the web map can load.

Neighbouring polygons have to keep one common border after simplification, or thin gaps open between them
on the map. So each coverage is broken into arcs at every junction, each arc is simplified once, and the
polygons are rebuilt from the simplified arcs (the idea behind TopoJSON).

Rings are written as flat integer arrays on a 0.0001 degree grid: x0, y0, then deltas. The browser
closes each ring when it decodes it.

Input : outputs/national_barangay_income_poverty_2025.gpkg
Output: docs/data/geo/{region,province,lgu}.json, docs/data/geo/home.json, docs/data/bgy/<chunk>.geo.json,
        website/.cache/geometry_index.csv
"""
from __future__ import annotations
import json
import sys
import time
from pathlib import Path

import geopandas as gpd
import numpy as np
import pandas as pd
import shapely

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "docs" / "data"
CACHE = ROOT / "website" / ".cache"
GRID = 1e-4                  # degrees, about 11 m
BITS = 21                    # lon * 1e4 and lat * 1e4 both fit in 21 bits


def ring_area2(p):
    """Twice the signed area of a closed ring, by the shoelace formula."""
    x, y = p[:, 0], p[:, 1]
    return float(np.dot(x[:-1], y[1:]) - np.dot(x[1:], y[:-1]))


def simplify_coverage(geoms, tol, min_island=0.0, min_hole=0.0):
    """Simplify polygons that share borders. tol and the areas are in grid units. Returns, per input geometry,
    a list of parts, each a list of closed Nx2 integer rings with the exterior first."""
    geoms = np.asarray(geoms, dtype=object)
    parts, part_geom = shapely.get_parts(geoms, return_index=True)
    rings, ring_part = shapely.get_rings(parts, return_index=True)
    coords, coord_ring = shapely.get_coordinates(rings, return_index=True)
    xy = np.rint(coords / GRID).astype(np.int64)
    codes = (xy[:, 0] << BITS) | xy[:, 1]
    uniq, inv = np.unique(codes, return_inverse=True)
    n_v = uniq.size
    vx, vy = uniq >> BITS, uniq & ((1 << BITS) - 1)

    # a vertex where the boundary branches (not exactly two distinct neighbours) ends an arc
    same = coord_ring[:-1] == coord_ring[1:]
    a, b = inv[:-1][same], inv[1:][same]
    keep = a != b
    a, b = a[keep], b[keep]
    edges = np.unique(np.r_[a * n_v + b, b * n_v + a])
    junction = np.bincount(edges // n_v, minlength=n_v) != 2

    starts = np.flatnonzero(np.r_[True, coord_ring[1:] != coord_ring[:-1]])
    ends = np.r_[starts[1:], coord_ring.size]
    arc_of, arcs, ring_arcs = {}, [], []

    def arc_id(ids):
        """Same arc in either direction gets one id. Returns (id, walked backwards?)."""
        rev = ids[0] > ids[-1] or (ids[0] == ids[-1] and ids.size > 2 and ids[1] > ids[-2])
        canon = ids[::-1] if rev else ids
        key = canon.tobytes()
        i = arc_of.get(key)
        if i is None:
            i = arc_of[key] = len(arcs)
            arcs.append(canon)
        return i, rev

    for s, e in zip(starts, ends):
        cyc = inv[s:e - 1]
        if cyc.size > 1:
            cyc = cyc[np.r_[True, cyc[1:] != cyc[:-1]]]
        if cyc.size > 1 and cyc[0] == cyc[-1]:
            cyc = cyc[:-1]
        jpos = np.flatnonzero(junction[cyc])
        if jpos.size == 0:
            k = int(np.argmin(cyc))
            ring_arcs.append([arc_id(np.r_[np.roll(cyc, -k), cyc[k]])])
            continue
        rot = np.roll(cyc, -int(jpos[0]))
        cuts = np.r_[jpos - jpos[0], rot.size]
        walk = np.r_[rot, rot[0]]
        ring_arcs.append([arc_id(walk[cuts[i]:cuts[i + 1] + 1]) for i in range(cuts.size - 1)])

    # simplify every distinct arc once; closed arcs keep at least a triangle
    lens = np.array([x.size for x in arcs])
    flat = np.concatenate(arcs)
    lines = shapely.linestrings(np.column_stack([vx[flat], vy[flat]]).astype(float), indices=np.repeat(np.arange(len(arcs)), lens))
    closed = np.array([x[0] == x[-1] for x in arcs])
    out = lines.copy()
    out[~closed] = shapely.simplify(lines[~closed], tol, preserve_topology=False)
    out[closed] = shapely.simplify(lines[closed], tol, preserve_topology=True)
    c2, idx = shapely.get_coordinates(out, return_index=True)
    split = np.flatnonzero(np.r_[True, idx[1:] != idx[:-1]])
    simple = np.split(np.rint(c2).astype(np.int64), split[1:])

    # rebuild rings; tiny islets and holes can go, but every geometry keeps its largest part
    n_geom = len(geoms)
    result = [[] for _ in range(n_geom)]
    first_ring = np.r_[True, ring_part[1:] != ring_part[:-1]]
    built = {}
    for r, chain in enumerate(ring_arcs):
        pts = [simple[i][::-1] if rev else simple[i] for i, rev in chain]
        p = np.vstack([pts[0]] + [q[1:] for q in pts[1:]])
        built.setdefault(int(ring_part[r]), []).append((bool(first_ring[r]), p))
    for pid, rs in built.items():
        ext = rs[0][1]
        area = abs(ring_area2(ext)) / 2
        holes = [p for flag, p in rs[1:] if p.shape[0] >= 4 and abs(ring_area2(p)) / 2 > min_hole]
        result[int(part_geom[pid])].append((area, [ext] + holes))
    final = []
    for g, items in zip(geoms, result):
        items = sorted(items, key=lambda t: -t[0])
        kept = [rs for area, rs in items if rs[0].shape[0] >= 4 and area > min_island]
        if not kept and items:
            best = items[0][1]
            if best[0].shape[0] < 4 or ring_area2(best[0]) == 0:
                # collapsed: fall back to the bounding box of the original geometry, on the grid
                x0, y0, x1, y1 = np.rint(np.array(shapely.bounds(g)) / GRID).astype(np.int64)
                x1, y1 = max(x1, x0 + 1), max(y1, y0 + 1)
                best = [np.array([[x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0]], dtype=np.int64)]
            kept = [best]
        final.append(kept)
    print(f"    arcs {len(arcs):,} | vertices {lens.sum():,} -> {sum(s.shape[0] for s in simple):,}", flush=True)
    return final


def encode(parts):
    """Flat delta-coded rings, without the closing point."""
    out = []
    for rings in parts:
        enc = []
        for r in rings:
            r = r[:-1]
            d = np.diff(r, axis=0)
            flat = np.r_[r[0], d.ravel()]
            enc.append([int(v) for v in flat])
        out.append(enc)
    return out


def dump(path, obj):
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, "w") as f:
        json.dump(obj, f, separators=(",", ":"))
    return path.stat().st_size


def coverage_file(path, ids, geoms, tol, **kw):
    parts = simplify_coverage(geoms, tol, **kw)
    size = dump(path, {"ids": list(ids), "geom": [encode(p) for p in parts]})
    print(f"  {path.name}: {len(ids)} units, {size / 1e6:.2f} MB", flush=True)
    return parts


def home_svg(ids, parts, width=620):
    """A light SVG version of the city and municipal map for the home page."""
    lat0 = np.deg2rad(12.5)
    k = None
    pts = np.vstack([r for p in parts for rs in p for r in rs[:1]]) * GRID
    # the far-west Kalayaan islets would squeeze the country into half the frame
    lon0, lon1 = 116.8, pts[:, 0].max() + .05
    lat1, lat0_ = pts[:, 1].max() + .05, pts[:, 1].min() - .05
    k = width / ((lon1 - lon0) * np.cos(lat0))
    height = (lat1 - lat0_) * k
    paths = []
    for p in parts:
        d = []
        for rs in p:
            for r in rs:
                x = (r[:, 0] * GRID - lon0) * np.cos(lat0) * k
                y = (lat1 - r[:, 1] * GRID) * k
                if x.max() < 0:
                    continue
                xy = np.rint(np.column_stack([x, y]) * 4).astype(int)
                xy = xy[np.r_[True, np.any(xy[1:] != xy[:-1], axis=1)]]
                if xy.shape[0] < 4:
                    continue
                rel = np.diff(xy[:-1], axis=0)
                seg = "".join(f"{a / 4:g},{b / 4:g} " for a, b in rel).strip()
                d.append(f"M{xy[0, 0] / 4:g},{xy[0, 1] / 4:g}l{seg}z")
        paths.append("".join(d))
    return {"w": width, "h": round(height, 1), "ids": list(ids), "d": paths}


def main():
    t0 = time.time()
    d = pd.read_csv(ROOT / "outputs" / "national_barangay_income_poverty_2025.csv", dtype=str, low_memory=False,
                    usecols=["bgy_pcode", "city_psgc", "prov_psgc", "reg_psgc", "reg_name", "unit_type", "poverty_anchor_area"])
    g = gpd.read_file(ROOT / "outputs" / "national_barangay_income_poverty_2025.gpkg", columns=["bgy_pcode", "geometry"]).merge(d, on="bgy_pcode")
    print(f"read {len(g):,} polygons, {time.time() - t0:.0f}s", flush=True)
    # non-barangay polygons carry no codes of their own; they belong to the LGU that contains them
    named = g[g.city_psgc.notna()]
    tree = shapely.STRtree(named.geometry.values)
    lost = g.city_psgc.isna()
    if lost.any():
        near = tree.nearest(shapely.point_on_surface(g.geometry[lost].values))
        for c in ["city_psgc", "reg_psgc", "reg_name"]:
            g.loc[lost, c] = named[c].values[near]
    g["chunk"] = g.prov_psgc.fillna(g.city_psgc)
    area_of = g[g.poverty_anchor_area.notna()].groupby("city_psgc").poverty_anchor_area.first()
    g["area_key"] = g.city_psgc.map(area_of)

    print("snapping to the grid", flush=True)
    snapped = shapely.set_precision(g.geometry.values, GRID, mode="valid_output")
    g["geometry"] = snapped

    print("barangays by chunk", flush=True)
    parts = simplify_coverage(snapped, tol=2.0, min_island=1.0, min_hole=1.0)
    g["_p"] = parts
    total = 0
    index = []
    for chunk, s in g.groupby("chunk"):
        total += dump(OUT / "bgy" / f"{chunk}.geo.json", {"ids": s.bgy_pcode.tolist(), "geom": [encode(p) for p in s._p]})
        x0, y0, x1, y1 = shapely.total_bounds(s.geometry.values)
        index.append(dict(chunk=chunk, n=len(s), x0=round(x0, 3), y0=round(y0, 3), x1=round(x1, 3), y1=round(y1, 3)))
    pd.DataFrame(index).to_csv(CACHE / "chunks.csv", index=False)
    print(f"  {len(index)} chunks, {total / 1e6:.1f} MB, {time.time() - t0:.0f}s", flush=True)
    pts = shapely.point_on_surface(snapped)
    pd.DataFrame({"bgy_pcode": g.bgy_pcode, "chunk": g.chunk, "lon": np.round(shapely.get_x(pts), 4), "lat": np.round(shapely.get_y(pts), 4)}).to_csv(CACHE / "geometry_index.csv", index=False)

    print("dissolving to cities and municipalities", flush=True)
    by_city = {k: shapely.union_all(s, grid_size=GRID) for k, s in g.groupby("city_psgc").geometry}
    ids = sorted(by_city)
    city_geoms = np.array([by_city[k] for k in ids], dtype=object)
    lgu_parts = coverage_file(OUT / "geo" / "lgu.json", ids, city_geoms, tol=6.0, min_island=25.0, min_hole=25.0)
    lp = shapely.point_on_surface(city_geoms)
    pd.DataFrame({"city_psgc": ids, "lon": np.round(shapely.get_x(lp), 4), "lat": np.round(shapely.get_y(lp), 4), "area_key": [area_of.get(k) for k in ids],
                  "reg_psgc": [g[g.city_psgc == k].reg_psgc.iloc[0] for k in ids]}).to_csv(CACHE / "lgu_points.csv", index=False)
    print(f"  {time.time() - t0:.0f}s", flush=True)

    print("province-level areas and regions", flush=True)
    cm = pd.DataFrame({"city_psgc": ids, "geometry": city_geoms})
    cm["area_key"] = cm.city_psgc.map(area_of)
    cm["reg_psgc"] = cm.city_psgc.map(g.groupby("city_psgc").reg_psgc.first())
    areas = cm.groupby("area_key").geometry.apply(lambda s: shapely.union_all(s.values, grid_size=GRID))
    regs = cm.groupby("reg_psgc").geometry.apply(lambda s: shapely.union_all(s.values, grid_size=GRID))
    coverage_file(OUT / "geo" / "province.json", areas.index.tolist(), areas.values, tol=12.0, min_island=100.0, min_hole=100.0)
    coverage_file(OUT / "geo" / "region.json", regs.index.tolist(), regs.values, tol=20.0, min_island=200.0, min_hole=200.0)
    ap = shapely.point_on_surface(areas.values)
    pd.DataFrame({"area_key": areas.index, "lon": np.round(shapely.get_x(ap), 3), "lat": np.round(shapely.get_y(ap), 3)}).to_csv(CACHE / "area_points.csv", index=False)
    rp = shapely.point_on_surface(regs.values)
    pd.DataFrame({"reg_psgc": regs.index, "lon": np.round(shapely.get_x(rp), 3), "lat": np.round(shapely.get_y(rp), 3)}).to_csv(CACHE / "region_points.csv", index=False)

    print("home page map", flush=True)
    home_parts = simplify_coverage(city_geoms, tol=55.0, min_island=1200.0, min_hole=1200.0)
    size = dump(OUT / "geo" / "home.json", home_svg(ids, home_parts))
    print(f"  home.json {size / 1e6:.2f} MB, total {time.time() - t0:.0f}s", flush=True)


if __name__ == "__main__":
    main()
