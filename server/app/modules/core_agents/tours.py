"""Туры «Вокруг света» для агентов «Ядра»: каталог vs-travel.ru, поиск, карточка, направления.

Шар сам забирает открытый каталог сайта (vs-travel.ru/ajax/tour-search — то же, что видит посетитель): все туры с
выездами — даты, цены, свободные места, праздники. Снимок хранится в базе и обновляется лениво: агент спросил, а снимку
больше SNAPSHOT_TTL — обновление идёт в фоне, ответ из прежнего; снимка нет — забираем сразу (≈8 запросов по 100 туров).

Направление тура, сегмент и «свой / партнёрский» считаются так же, как в анализаторе ассортимента MBOX (код перенесён,
связи с MBOX нет): свой тур — признак tota («Сделано в «Вокруг света»»); направление однодневки — главное место маршрута,
многодневного — регион, куда относится большинство мест (география — tours_geo.json).
"""
from __future__ import annotations

import json
import logging
import re
import threading
import time
from collections import Counter
from datetime import date, datetime, timezone
from pathlib import Path
from typing import Any, Optional

import requests

from app.core import schema
from app.core.db import db
from app.core.db.connection import Json

log = logging.getLogger("shar.core.tours")

SEARCH_URL = "https://vs-travel.ru/ajax/tour-search"
DICT_URL = "https://vs-travel.ru/new_dict.json"
TOUR_URL = "https://vs-travel.ru/tour?id={id}"
PAGE_SIZE = 100
SNAPSHOT_TTL = 6 * 3600
USER_AGENT = "Mozilla/5.0 (Shar agents; +https://vokrug-sveta.shar-os.ru)"
KEEP = ["id", "route_name", "tour_name", "duration_val", "duration_val2", "duration_type", "type", "guide_name", "cities_names",
        "tour_topics", "free_places", "tota", "TopFilter_russia", "has_free_places", "razdel", "price", "currency", "is_novelty",
        "action", "hit", "can_by_online", "min_date", "max_date"]
SEGMENTS = {"one_day": "однодневные", "multi_day": "многодневные по России", "abroad": "ближнее зарубежье"}
TYPES = {"one_day_bus": "автобусная однодневка", "walking": "пешеходная", "bus": "автобусный", "railway": "ЖД", "avia": "авиа"}

schema.register("core_tours", """
CREATE TABLE IF NOT EXISTS core_tours_snapshots (
    day TEXT PRIMARY KEY,
    fetched_at TIMESTAMPTZ NOT NULL,
    tours_count INTEGER NOT NULL,
    payload JSONB NOT NULL
);
""")


class ToursError(RuntimeError):
    pass


# ── каталог ──────────────────────────────────────────────────────────────────

def _get_json(url: str, params: Optional[dict] = None) -> Any:
    last: Exception | None = None
    for attempt in range(3):
        try:
            res = requests.get(url, params=params, headers={"user-agent": USER_AGENT}, timeout=60)
            res.raise_for_status()
            return json.loads(res.text)  # tour-search отдаёт JSON с Content-Type text/html
        except (requests.RequestException, ValueError) as exc:
            last = exc
            time.sleep(1.5 * (attempt + 1))
    raise ToursError(f"Сайт vs-travel.ru не ответил: {last.__class__.__name__ if last else ''}")


def _trim(raw: dict) -> dict:
    out = {k: raw[k] for k in KEEP if k in raw}
    out["sheets"] = [{k: s.get(k) for k in ("day", "price", "free_places", "holiday", "can_by_online", "discount_client")}
                     for s in raw.get("tour_sheets") or [] if s and s.get("day")]
    return out


def fetch_catalog() -> dict:
    tours: dict[Any, dict] = {}
    total = None
    for page in range(1, 201):
        data = _get_json(SEARCH_URL, {"hitsPerPage": PAGE_SIZE, "p": page})
        total = data.get("totalHits", total)
        hits = data.get("hits") or []
        for hit in hits:
            tours[hit["id"]] = _trim(hit)
        if not hits or page >= (data.get("totalPages") or page):
            break
    if total is not None and len(tours) != total:
        raise ToursError(f"Каталог собран не полностью: {len(tours)} из {total}")
    if len(tours) < 50:
        raise ToursError(f"В каталоге подозрительно мало туров ({len(tours)})")
    try:
        dictionary = _get_json(DICT_URL)
    except ToursError:
        dictionary = {}
    return {"tours": list(tours.values()), "topics": {str(t["id"]): t["name"] for t in dictionary.get("topics") or []},
            "holidays": {str(h["id"]): h["name"] for h in dictionary.get("holidays") or []}}


_refreshing = threading.Lock()
_cache: dict[str, Any] = {"at": None, "index": None}


def refresh() -> dict:
    """Забрать каталог и сохранить снимком дня. Параллельный вызов не запускает второй."""
    if not _refreshing.acquire(blocking=False):
        raise ToursError("Каталог уже обновляется — попробуйте через минуту")
    try:
        payload = fetch_catalog()
        now = datetime.now(timezone.utc)
        day = now.astimezone().strftime("%Y-%m-%d")
        db.conn.execute_query(
            "INSERT INTO core_tours_snapshots (day, fetched_at, tours_count, payload) VALUES (%s, %s, %s, %s) "
            "ON CONFLICT (day) DO UPDATE SET fetched_at = EXCLUDED.fetched_at, tours_count = EXCLUDED.tours_count, payload = EXCLUDED.payload",
            (day, now, len(payload["tours"]), Json(payload)))
        db.conn.execute_query("DELETE FROM core_tours_snapshots WHERE day NOT IN (SELECT day FROM core_tours_snapshots ORDER BY day DESC LIMIT 14)")
        _cache["at"] = None
        return {"tours": len(payload["tours"]), "fetchedAt": now.isoformat()}
    finally:
        _refreshing.release()


def _latest() -> Optional[dict]:
    return db.conn.fetch_one("SELECT fetched_at, payload FROM core_tours_snapshots ORDER BY day DESC LIMIT 1")


def catalog() -> dict:
    """Индекс туров. Снимок старше SNAPSHOT_TTL — обновление в фоне; снимка нет — забираем сразу."""
    row = _latest()
    if not row:
        refresh()
        row = _latest()
    if not row:
        raise ToursError("Каталог туров пока не загружен")
    age = (datetime.now(timezone.utc) - row["fetched_at"]).total_seconds()
    if age > SNAPSHOT_TTL and not _refreshing.locked():
        threading.Thread(target=lambda: _safe_refresh(), daemon=True).start()
    if _cache["at"] != row["fetched_at"]:
        _cache["index"] = _build(row["payload"])
        _cache["at"] = row["fetched_at"]
    return {"fetchedAt": row["fetched_at"].isoformat(), **_cache["index"]}


def _safe_refresh() -> None:
    try:
        refresh()
    except Exception as exc:  # noqa: BLE001 — фоновое обновление не должно ронять запрос
        log.warning("tours: refresh failed: %s", exc)


# ── география и модель тура (перенос из assortment-engine MBOX) ─────────────────

GEO = json.loads((Path(__file__).with_name("tours_geo.json")).read_text(encoding="utf-8"))


def norm(text: str) -> str:
    return re.sub(r"[^0-9a-zа-я]+", " ", (text or "").lower().replace("ё", "е")).strip()


def _stem(w: str) -> str:
    return w if len(w) <= 4 else w[:max(4, len(w) - 2)]


class Geo:
    def __init__(self, raw_tours: list[dict]):
        self.region_re = re.compile(GEO["region_regex"], re.I)
        self.countries, self.regions, self.macro = set(GEO["countries"]), set(GEO["regions"]), set(GEO["macro"])
        self.override = dict(GEO.get("place_region") or {})
        df: Counter = Counter()
        co: dict[str, Counter] = {}
        for t in sorted(raw_tours, key=lambda r: r["id"]):
            names = set(t.get("cities_names") or [])
            df.update(names)
            areas = [n for n in names if self.level(n) in ("region", "country")]
            for n in names:
                if self.level(n) == "place":
                    co.setdefault(n, Counter()).update(areas)
        self.place_region: dict[str, str] = {}
        for place, areas in co.items():
            if place in self.override:
                self.place_region[place] = self.override[place]
            elif areas:
                region, hits = sorted(areas.items(), key=lambda kv: (-kv[1], kv[0]))[0]
                if hits / df[place] >= 0.5:
                    self.place_region[place] = region

    def level(self, name: str) -> str:
        if name in self.macro:
            return "macro"
        if name in self.countries:
            return "country"
        if name in self.regions or self.region_re.search(name):
            return "region"
        return "place"

    def region_of(self, place: str) -> Optional[str]:
        return self.override.get(place) or self.place_region.get(place)


def _segment(r: dict) -> str:
    if r.get("duration_type") == "hour" or r.get("razdel") == "odnodnevnye" or r.get("duration_val2") == 1:
        return "one_day"
    if r.get("TopFilter_russia") == 2:
        return "abroad"
    return "multi_day"


def _anchor(route: str, places: list[str]) -> Optional[str]:
    text = " " + norm(route) + " "
    best, pos = None, None
    for p in places:
        i = text.find(" " + _stem(norm(p)))
        if i >= 0 and (pos is None or i < pos):
            best, pos = p, i
    return best


def _direction(r: dict, geo: Geo, segment: str) -> str:
    names = list(dict.fromkeys(r.get("cities_names") or []))
    places = [n for n in names if geo.level(n) == "place"]
    regions = [n for n in names if geo.level(n) == "region"]
    countries = [n for n in names if geo.level(n) == "country"]
    macros = [n for n in names if geo.level(n) == "macro"]
    anchor = _anchor(r.get("route_name") or "", places) or (places[0] if places else None) or next(iter(regions + countries + macros), "—")
    if segment == "one_day":
        if not places and anchor not in ("Москва", "Санкт-Петербург"):
            return f"{anchor} (место не указано)"
        return anchor
    score = Counter(x for x in (geo.region_of(p) for p in places) if x)
    if segment == "abroad":
        only = Counter({k: v for k, v in score.items() if geo.level(k) == "country"})
        score = only or Counter(countries)
    if not score:
        score = Counter(regions or macros or countries)
    if not score:
        return anchor
    top = max(score.values())
    leaders = sorted(k for k, v in score.items() if v == top)
    if len(leaders) > 1 and macros and segment == "multi_day":
        return macros[0]
    anchor_region = geo.region_of(anchor) or anchor
    return anchor_region if anchor_region in leaders else leaders[0]


def _build(payload: dict) -> dict:
    raw = payload.get("tours") or []
    geo = Geo(raw)
    topics, holidays = payload.get("topics") or {}, payload.get("holidays") or {}
    today = date.today().isoformat()
    tours = []
    for r in raw:
        segment = _segment(r)
        sheets = sorted((s for s in r.get("sheets") or [] if (s.get("day") or "") >= today), key=lambda s: s["day"])
        prices = [s["price"] for s in sheets if isinstance(s.get("price"), (int, float)) and s["price"] > 0]
        tours.append({
            "id": r["id"], "name": r.get("tour_name") or "", "route": r.get("route_name") or "", "own": bool(r.get("tota")),
            "segment": segment, "type": r.get("type") or "", "direction": _direction(r, geo, segment),
            "days": 1 if r.get("duration_type") == "hour" else int(r.get("duration_val2") or 1),
            "duration": (f"{r.get('duration_val')} ч" if r.get("duration_type") == "hour" else
                         f"{r.get('duration_val2') or 1} дн."), "guide": r.get("guide_name") or "",
            "places": [n for n in r.get("cities_names") or []], "topics": [topics.get(str(t), str(t)) for t in r.get("tour_topics") or []],
            "novelty": bool(r.get("is_novelty")), "promo": bool(r.get("action")), "hit": bool(r.get("hit")),
            "currency": r.get("currency") or "RUB", "priceFrom": min(prices) if prices else (r.get("price") or None),
            "departures": [{"date": s["day"], "price": s.get("price"), "free": s.get("free_places"),
                            "holiday": holidays.get(str(s.get("holiday")), s.get("holiday")) if s.get("holiday") else None,
                            "online": bool(s.get("can_by_online"))} for s in sheets],
            "search": norm(" ".join([r.get("tour_name") or "", r.get("route_name") or "", " ".join(r.get("cities_names") or []),
                                     r.get("guide_name") or "", " ".join(topics.get(str(t), "") for t in r.get("tour_topics") or [])])),
        })
    return {"tours": tours, "topics": sorted(set(topics.values())), "holidays": sorted(set(holidays.values()))}


# ── то, что видит агент ───────────────────────────────────────────────────────

def _row(t: dict, *, departures: int = 3) -> dict:
    deps = t["departures"]
    return {"id": t["id"], "name": t["name"], "route": t["route"], "direction": t["direction"], "segment": SEGMENTS[t["segment"]],
            "own": t["own"], "duration": t["duration"], "type": TYPES.get(t["type"], t["type"]), "priceFrom": t["priceFrom"],
            "currency": t["currency"], "departuresAhead": len(deps), "freeSeats": sum(d["free"] or 0 for d in deps),
            "next": [{"date": d["date"], "price": d["price"], "free": d["free"], **({"holiday": d["holiday"]} if d["holiday"] else {})}
                     for d in deps[:departures]],
            **({"marks": [m for m, on in (("новинка", t["novelty"]), ("акция", t["promo"]), ("хит", t["hit"])) if on]}
               if t["novelty"] or t["promo"] or t["hit"] else {}),
            "url": TOUR_URL.format(id=t["id"])}


def search(*, query: str = "", direction: str = "", segment: str = "", own: Optional[bool] = None, days_min: int = 0,
           days_max: int = 0, date_from: str = "", date_to: str = "", price_max: float = 0, topic: str = "", holiday: str = "",
           free_only: bool = False, limit: int = 20, offset: int = 0) -> dict:
    cat = catalog()
    words = [_stem(w) for w in norm(query).split() if len(w) > 1]
    dir_q, topic_q, hol_q = norm(direction), norm(topic), norm(holiday)
    found = []
    for t in cat["tours"]:
        if words and not all(" " + w in " " + t["search"] for w in words):
            continue
        if dir_q and dir_q not in norm(t["direction"]) and not any(dir_q in norm(p) for p in t["places"]):
            continue
        if segment and t["segment"] != segment:
            continue
        if own is not None and t["own"] != own:
            continue
        if days_min and t["days"] < days_min or days_max and t["days"] > days_max:
            continue
        if topic_q and not any(topic_q in norm(x) for x in t["topics"]):
            continue
        deps = [d for d in t["departures"] if (not date_from or d["date"] >= date_from) and (not date_to or d["date"] <= date_to)
                and (not free_only or (d["free"] or 0) > 0) and (not price_max or (d["price"] or 0) <= price_max)
                and (not hol_q or (d["holiday"] and hol_q in norm(d["holiday"])))]
        if (date_from or date_to or free_only or price_max or hol_q) and not deps:
            continue
        found.append({**t, "departures": deps or t["departures"]})
    found.sort(key=lambda t: (t["departures"][0]["date"] if t["departures"] else "9999", t["id"]))
    limit = max(1, min(int(limit or 20), 50))
    return {"total": len(found), "tours": [_row(t) for t in found[offset:offset + limit]],
            "nextOffset": offset + limit if offset + limit < len(found) else None, "catalogAt": cat["fetchedAt"],
            "note": "Цены, места и даты — из каталога сайта на момент снимка; перед ответом клиенту сверяйте на странице тура (url)."}


def tour(tour_id: int) -> dict:
    cat = catalog()
    t = next((x for x in cat["tours"] if x["id"] == int(tour_id)), None)
    if not t:
        raise ToursError(f"Тура {tour_id} нет в каталоге сайта (снят или опечатка в номере)")
    same = [x for x in cat["tours"] if x["direction"] == t["direction"] and x["segment"] == t["segment"] and x["id"] != t["id"]]
    return {**_row(t, departures=60), "places": t["places"], "topics": t["topics"], "guide": t["guide"],
            "sameDirection": {"total": len(same), "own": sum(1 for x in same if x["own"]),
                              "tours": [{"id": x["id"], "name": x["name"], "own": x["own"], "duration": x["duration"]} for x in same[:15]]},
            "catalogAt": cat["fetchedAt"],
            "program": f"Программа по дням — на странице тура: {TOUR_URL.format(id=t['id'])} (WebFetch)."}


def directions(segment: str = "", query: str = "") -> dict:
    cat = catalog()
    q = norm(query)
    groups: dict[tuple[str, str], list[dict]] = {}
    for t in cat["tours"]:
        if segment and t["segment"] != segment:
            continue
        groups.setdefault((t["direction"], t["segment"]), []).append(t)
    rows = []
    for (name, seg), ts in groups.items():
        if q and q not in norm(name):
            continue
        dates = sorted(d["date"] for t in ts for d in t["departures"])
        rows.append({"direction": name, "segment": SEGMENTS[seg], "tours": len(ts), "own": sum(1 for t in ts if t["own"]),
                     "partner": sum(1 for t in ts if not t["own"]), "departuresAhead": len(dates), "nearest": dates[0] if dates else None})
    rows.sort(key=lambda r: (-r["tours"], r["direction"]))
    return {"total": len(rows), "directions": rows[:200], "catalogAt": cat["fetchedAt"]}


def overview() -> dict:
    cat = catalog()
    ts = cat["tours"]
    by_segment = Counter(SEGMENTS[t["segment"]] for t in ts)
    return {"tours": len(ts), "own": sum(1 for t in ts if t["own"]), "partner": sum(1 for t in ts if not t["own"]),
            "bySegment": dict(by_segment), "withDepartures": sum(1 for t in ts if t["departures"]),
            "novelties": sum(1 for t in ts if t["novelty"]), "promo": sum(1 for t in ts if t["promo"]),
            "topics": cat["topics"], "holidays": cat["holidays"], "catalogAt": cat["fetchedAt"],
            "source": "vs-travel.ru — открытый каталог сайта"}


# ── REST: сводка и обновление по кнопке (администратор) ────────────────────────

from fastapi import APIRouter, Depends, HTTPException  # noqa: E402

from app.core.security import Identity, current_identity, require_admin  # noqa: E402

router = APIRouter(tags=["core-tours"])


@router.get("/api/core/tours/overview")
def tours_overview(me: Identity = Depends(current_identity)):
    try:
        return overview()
    except ToursError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc


@router.post("/api/core/tours/refresh")
def tours_refresh(me: Identity = Depends(require_admin)):
    try:
        return refresh()
    except ToursError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc
