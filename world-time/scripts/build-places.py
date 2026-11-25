#!/usr/bin/env python3
"""Build compact offline places.json from GeoNames cities15000 + countryInfo.

Usage:
  python3 world-time/scripts/build-places.py
  python3 world-time/scripts/build-places.py --cities /path/to/cities15000.txt --countries /path/to/countryInfo.txt
"""

from __future__ import annotations

import argparse
import io
import json
import os
import sys
import unicodedata
import urllib.request
import zipfile
from collections import Counter, defaultdict
from pathlib import Path
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

GEONAMES_CITIES_URL = "https://download.geonames.org/export/dump/cities15000.zip"
GEONAMES_COUNTRIES_URL = "https://download.geonames.org/export/dump/countryInfo.txt"

MIN_POPULATION = 50_000
KEEP_FEATURE_CODES = {"PPLC", "PPLA"}

# Curated aliases: key (normalized lowercase) -> (display_name, country_code, iana_tz)
# Country code "" is used for non-country zones like UTC/GMT.
CURATED_ALIASES: dict[str, tuple[str, str, str]] = {
    # Timezone abbreviations
    "utc": ("UTC", "", "UTC"),
    "gmt": ("GMT / UTC", "", "UTC"),
    "z": ("UTC (Zulu)", "", "UTC"),
    "zulu": ("UTC (Zulu)", "", "UTC"),
    "pt": ("Pacific Time", "US", "America/Los_Angeles"),
    "pst": ("Pacific Time (PT)", "US", "America/Los_Angeles"),
    "pdt": ("Pacific Time (PT)", "US", "America/Los_Angeles"),
    "pacific": ("Pacific Time", "US", "America/Los_Angeles"),
    "mt": ("Mountain Time", "US", "America/Denver"),
    "mst": ("Mountain Time (MT)", "US", "America/Denver"),
    "mdt": ("Mountain Time (MT)", "US", "America/Denver"),
    "mountain": ("Mountain Time", "US", "America/Denver"),
    "ct": ("Central Time", "US", "America/Chicago"),
    "cst": ("Central Time (CT)", "US", "America/Chicago"),
    "cdt": ("Central Time (CT)", "US", "America/Chicago"),
    "central": ("Central Time", "US", "America/Chicago"),
    "et": ("Eastern Time", "US", "America/New_York"),
    "est": ("Eastern Time (ET)", "US", "America/New_York"),
    "edt": ("Eastern Time (ET)", "US", "America/New_York"),
    "eastern": ("Eastern Time", "US", "America/New_York"),
    "ast": ("Atlantic Time", "CA", "America/Halifax"),
    "adt": ("Atlantic Time", "CA", "America/Halifax"),
    "akst": ("Alaska Time", "US", "America/Anchorage"),
    "akdt": ("Alaska Time", "US", "America/Anchorage"),
    "hst": ("Hawaii Time", "US", "Pacific/Honolulu"),
    "bst": ("London (UK)", "GB", "Europe/London"),
    "wet": ("Western European Time", "PT", "Europe/Lisbon"),
    "west": ("Western European Time", "PT", "Europe/Lisbon"),
    "cet": ("Central European Time", "FR", "Europe/Paris"),
    "cest": ("Central European Time", "FR", "Europe/Paris"),
    "eet": ("Eastern European Time", "GR", "Europe/Athens"),
    "eest": ("Eastern European Time", "GR", "Europe/Athens"),
    "ist": ("India Standard Time (IST)", "IN", "Asia/Kolkata"),
    "pkt": ("Pakistan Standard Time", "PK", "Asia/Karachi"),
    "bdt": ("Bangladesh Standard Time", "BD", "Asia/Dhaka"),
    "npt": ("Nepal Time", "NP", "Asia/Kathmandu"),
    "ict": ("Indochina Time", "TH", "Asia/Bangkok"),
    "sgt": ("Singapore Time", "SG", "Asia/Singapore"),
    "myt": ("Malaysia Time", "MY", "Asia/Kuala_Lumpur"),
    "hkt": ("Hong Kong Time", "HK", "Asia/Hong_Kong"),
    "pht": ("Philippine Time", "PH", "Asia/Manila"),
    "wib": ("Western Indonesian Time", "ID", "Asia/Jakarta"),
    "wita": ("Central Indonesian Time", "ID", "Asia/Makassar"),
    "wit": ("Eastern Indonesian Time", "ID", "Asia/Jayapura"),
    "jst": ("Japan Standard Time", "JP", "Asia/Tokyo"),
    "kst": ("Korea Standard Time", "KR", "Asia/Seoul"),
    "awst": ("Australian Western Time", "AU", "Australia/Perth"),
    "acst": ("Australian Central Time", "AU", "Australia/Adelaide"),
    "acdt": ("Australian Central Time", "AU", "Australia/Adelaide"),
    "aest": ("Australian Eastern Time", "AU", "Australia/Sydney"),
    "aedt": ("Australian Eastern Time", "AU", "Australia/Sydney"),
    "aet": ("Australian Eastern Time", "AU", "Australia/Sydney"),
    "nzst": ("New Zealand Time", "NZ", "Pacific/Auckland"),
    "nzdt": ("New Zealand Time", "NZ", "Pacific/Auckland"),
    "nzt": ("New Zealand Time", "NZ", "Pacific/Auckland"),
    "gst": ("Gulf Standard Time", "AE", "Asia/Dubai"),
    "msk": ("Moscow Time", "RU", "Europe/Moscow"),
    "trt": ("Turkey Time", "TR", "Europe/Istanbul"),
    "sast": ("South Africa Time", "ZA", "Africa/Johannesburg"),
    "wat": ("West Africa Time", "NG", "Africa/Lagos"),
    "eat": ("East Africa Time", "KE", "Africa/Nairobi"),
    "brt": ("Brasilia Time", "BR", "America/Sao_Paulo"),
    "art": ("Argentina Time", "AR", "America/Argentina/Buenos_Aires"),
    # City nicknames & alternate names
    "sf": ("San Francisco", "US", "America/Los_Angeles"),
    "bay area": ("San Francisco Bay Area", "US", "America/Los_Angeles"),
    "silicon valley": ("Silicon Valley", "US", "America/Los_Angeles"),
    "nyc": ("New York", "US", "America/New_York"),
    "ny": ("New York", "US", "America/New_York"),
    "la": ("Los Angeles", "US", "America/Los_Angeles"),
    "dc": ("Washington, D.C.", "US", "America/New_York"),
    "washington dc": ("Washington, D.C.", "US", "America/New_York"),
    "philly": ("Philadelphia", "US", "America/New_York"),
    "vegas": ("Las Vegas", "US", "America/Los_Angeles"),
    "chi": ("Chicago", "US", "America/Chicago"),
    "ldn": ("London", "GB", "Europe/London"),
    "hk": ("Hong Kong", "HK", "Asia/Hong_Kong"),
    "sg": ("Singapore", "SG", "Asia/Singapore"),
    "kl": ("Kuala Lumpur", "MY", "Asia/Kuala_Lumpur"),
    "bkk": ("Bangkok", "TH", "Asia/Bangkok"),
    "saigon": ("Ho Chi Minh City", "VN", "Asia/Ho_Chi_Minh"),
    "hcmc": ("Ho Chi Minh City", "VN", "Asia/Ho_Chi_Minh"),
    "bangalore": ("Bengaluru", "IN", "Asia/Kolkata"),
    "bengaluru": ("Bengaluru", "IN", "Asia/Kolkata"),
    "blr": ("Bengaluru", "IN", "Asia/Kolkata"),
    "bombay": ("Mumbai", "IN", "Asia/Kolkata"),
    "madras": ("Chennai", "IN", "Asia/Kolkata"),
    "calcutta": ("Kolkata", "IN", "Asia/Kolkata"),
    "trivandrum": ("Thiruvananthapuram", "IN", "Asia/Kolkata"),
    "cochin": ("Kochi", "IN", "Asia/Kolkata"),
    "peking": ("Beijing", "CN", "Asia/Shanghai"),
    "canton": ("Guangzhou", "CN", "Asia/Shanghai"),
    "cdmx": ("Mexico City", "MX", "America/Mexico_City"),
    "rio": ("Rio de Janeiro", "BR", "America/Sao_Paulo"),
    "sp": ("São Paulo", "BR", "America/Sao_Paulo"),
    "joburg": ("Johannesburg", "ZA", "Africa/Johannesburg"),
    "jhb": ("Johannesburg", "ZA", "Africa/Johannesburg"),
    "cpt": ("Cape Town", "ZA", "Africa/Johannesburg"),
    "dxb": ("Dubai", "AE", "Asia/Dubai"),
    "syd": ("Sydney", "AU", "Australia/Sydney"),
    "mel": ("Melbourne", "AU", "Australia/Melbourne"),
    "akl": ("Auckland", "NZ", "Pacific/Auckland"),
    "tor": ("Toronto", "CA", "America/Toronto"),
    "van": ("Vancouver", "CA", "America/Vancouver"),
    "mtl": ("Montreal", "CA", "America/Toronto"),
    # Major international airports (IATA)
    "jfk": ("New York (JFK)", "US", "America/New_York"),
    "lga": ("New York (LGA)", "US", "America/New_York"),
    "ewr": ("Newark (EWR)", "US", "America/New_York"),
    "sfo": ("San Francisco (SFO)", "US", "America/Los_Angeles"),
    "sjc": ("San Jose (SJC)", "US", "America/Los_Angeles"),
    "oak": ("Oakland (OAK)", "US", "America/Los_Angeles"),
    "lax": ("Los Angeles (LAX)", "US", "America/Los_Angeles"),
    "ord": ("Chicago (ORD)", "US", "America/Chicago"),
    "atl": ("Atlanta (ATL)", "US", "America/New_York"),
    "dfw": ("Dallas (DFW)", "US", "America/Chicago"),
    "iah": ("Houston (IAH)", "US", "America/Chicago"),
    "sea": ("Seattle (SEA)", "US", "America/Los_Angeles"),
    "bos": ("Boston (BOS)", "US", "America/New_York"),
    "mia": ("Miami (MIA)", "US", "America/New_York"),
    "den": ("Denver (DEN)", "US", "America/Denver"),
    "phx": ("Phoenix (PHX)", "US", "America/Phoenix"),
    "las": ("Las Vegas (LAS)", "US", "America/Los_Angeles"),
    "iad": ("Washington Dulles (IAD)", "US", "America/New_York"),
    "dca": ("Washington Reagan (DCA)", "US", "America/New_York"),
    "aus": ("Austin (AUS)", "US", "America/Chicago"),
    "msp": ("Minneapolis (MSP)", "US", "America/Chicago"),
    "dtw": ("Detroit (DTW)", "US", "America/Detroit"),
    "phl": ("Philadelphia (PHL)", "US", "America/New_York"),
    "hnl": ("Honolulu (HNL)", "US", "Pacific/Honolulu"),
    "yyz": ("Toronto (YYZ)", "CA", "America/Toronto"),
    "yvr": ("Vancouver (YVR)", "CA", "America/Vancouver"),
    "yul": ("Montreal (YUL)", "CA", "America/Toronto"),
    "yyc": ("Calgary (YYC)", "CA", "America/Edmonton"),
    "lhr": ("London Heathrow (LHR)", "GB", "Europe/London"),
    "lgw": ("London Gatwick (LGW)", "GB", "Europe/London"),
    "cdg": ("Paris (CDG)", "FR", "Europe/Paris"),
    "ams": ("Amsterdam (AMS)", "NL", "Europe/Amsterdam"),
    "fra": ("Frankfurt (FRA)", "DE", "Europe/Berlin"),
    "muc": ("Munich (MUC)", "DE", "Europe/Berlin"),
    "ber": ("Berlin (BER)", "DE", "Europe/Berlin"),
    "zrh": ("Zurich (ZRH)", "CH", "Europe/Zurich"),
    "gva": ("Geneva (GVA)", "CH", "Europe/Zurich"),
    "mad": ("Madrid (MAD)", "ES", "Europe/Madrid"),
    "bcn": ("Barcelona (BCN)", "ES", "Europe/Madrid"),
    "fco": ("Rome (FCO)", "IT", "Europe/Rome"),
    "mxp": ("Milan (MXP)", "IT", "Europe/Rome"),
    "dub": ("Dublin (DUB)", "IE", "Europe/Dublin"),
    "lis": ("Lisbon (LIS)", "PT", "Europe/Lisbon"),
    "vie": ("Vienna (VIE)", "AT", "Europe/Vienna"),
    "cph": ("Copenhagen (CPH)", "DK", "Europe/Copenhagen"),
    "arn": ("Stockholm (ARN)", "SE", "Europe/Stockholm"),
    "osl": ("Oslo (OSL)", "NO", "Europe/Oslo"),
    "hel": ("Helsinki (HEL)", "FI", "Europe/Helsinki"),
    "waw": ("Warsaw (WAW)", "PL", "Europe/Warsaw"),
    "prg": ("Prague (PRG)", "CZ", "Europe/Prague"),
    "ath": ("Athens (ATH)", "GR", "Europe/Athens"),
    "auh": ("Abu Dhabi (AUH)", "AE", "Asia/Dubai"),
    "doh": ("Doha (DOH)", "QA", "Asia/Qatar"),
    "ruh": ("Riyadh (RUH)", "SA", "Asia/Riyadh"),
    "tlv": ("Tel Aviv (TLV)", "IL", "Asia/Jerusalem"),
    "del": ("Delhi (DEL)", "IN", "Asia/Kolkata"),
    "bom": ("Mumbai (BOM)", "IN", "Asia/Kolkata"),
    "maa": ("Chennai (MAA)", "IN", "Asia/Kolkata"),
    "hyd": ("Hyderabad (HYD)", "IN", "Asia/Kolkata"),
    "ccu": ("Kolkata (CCU)", "IN", "Asia/Kolkata"),
    "cok": ("Kochi (COK)", "IN", "Asia/Kolkata"),
    "amd": ("Ahmedabad (AMD)", "IN", "Asia/Kolkata"),
    "pnq": ("Pune (PNQ)", "IN", "Asia/Kolkata"),
    "sin": ("Singapore (SIN)", "SG", "Asia/Singapore"),
    "kul": ("Kuala Lumpur (KUL)", "MY", "Asia/Kuala_Lumpur"),
    "hkg": ("Hong Kong (HKG)", "HK", "Asia/Hong_Kong"),
    "tpe": ("Taipei (TPE)", "TW", "Asia/Taipei"),
    "nrt": ("Tokyo Narita (NRT)", "JP", "Asia/Tokyo"),
    "hnd": ("Tokyo Haneda (HND)", "JP", "Asia/Tokyo"),
    "kix": ("Osaka (KIX)", "JP", "Asia/Tokyo"),
    "icn": ("Seoul Incheon (ICN)", "KR", "Asia/Seoul"),
    "pek": ("Beijing (PEK)", "CN", "Asia/Shanghai"),
    "pkx": ("Beijing Daxing (PKX)", "CN", "Asia/Shanghai"),
    "pvg": ("Shanghai Pudong (PVG)", "CN", "Asia/Shanghai"),
    "can": ("Guangzhou (CAN)", "CN", "Asia/Shanghai"),
    "szx": ("Shenzhen (SZX)", "CN", "Asia/Shanghai"),
    "mnl": ("Manila (MNL)", "PH", "Asia/Manila"),
    "cgk": ("Jakarta (CGK)", "ID", "Asia/Jakarta"),
    "dps": ("Bali (DPS)", "ID", "Asia/Makassar"),
    "sgn": ("Ho Chi Minh City (SGN)", "VN", "Asia/Ho_Chi_Minh"),
    "han": ("Hanoi (HAN)", "VN", "Asia/Ho_Chi_Minh"),
    "gru": ("São Paulo (GRU)", "BR", "America/Sao_Paulo"),
    "mex": ("Mexico City (MEX)", "MX", "America/Mexico_City"),
    "bog": ("Bogotá (BOG)", "CO", "America/Bogota"),
    "lim": ("Lima (LIM)", "PE", "America/Lima"),
    "scl": ("Santiago (SCL)", "CL", "America/Santiago"),
    "eze": ("Buenos Aires (EZE)", "AR", "America/Argentina/Buenos_Aires"),
    "cai": ("Cairo (CAI)", "EG", "Africa/Cairo"),
    "nbo": ("Nairobi (NBO)", "KE", "Africa/Nairobi"),
    "los": ("Lagos (LOS)", "NG", "Africa/Lagos"),
    # Country & region aliases
    "usa": ("United States (ET)", "US", "America/New_York"),
    "us": ("United States (ET)", "US", "America/New_York"),
    "uk": ("United Kingdom", "GB", "Europe/London"),
    "britain": ("United Kingdom", "GB", "Europe/London"),
    "great britain": ("United Kingdom", "GB", "Europe/London"),
    "england": ("England", "GB", "Europe/London"),
    "scotland": ("Scotland", "GB", "Europe/London"),
    "wales": ("Wales", "GB", "Europe/London"),
    "uae": ("United Arab Emirates", "AE", "Asia/Dubai"),
    "korea": ("South Korea", "KR", "Asia/Seoul"),
    "holland": ("Netherlands", "NL", "Europe/Amsterdam"),
    "czechia": ("Czechia", "CZ", "Europe/Prague"),
    "czech republic": ("Czechia", "CZ", "Europe/Prague"),
    "turkiye": ("Turkey", "TR", "Europe/Istanbul"),
    "bali": ("Bali", "ID", "Asia/Makassar"),
    # US States
    "california": ("California", "US", "America/Los_Angeles"),
    "washington": ("Washington", "US", "America/Los_Angeles"),
    "oregon": ("Oregon", "US", "America/Los_Angeles"),
    "nevada": ("Nevada", "US", "America/Los_Angeles"),
    "arizona": ("Arizona", "US", "America/Phoenix"),
    "colorado": ("Colorado", "US", "America/Denver"),
    "utah": ("Utah", "US", "America/Denver"),
    "new mexico": ("New Mexico", "US", "America/Denver"),
    "montana": ("Montana", "US", "America/Denver"),
    "wyoming": ("Wyoming", "US", "America/Denver"),
    "idaho": ("Idaho", "US", "America/Boise"),
    "texas": ("Texas", "US", "America/Chicago"),
    "illinois": ("Illinois", "US", "America/Chicago"),
    "minnesota": ("Minnesota", "US", "America/Chicago"),
    "wisconsin": ("Wisconsin", "US", "America/Chicago"),
    "missouri": ("Missouri", "US", "America/Chicago"),
    "louisiana": ("Louisiana", "US", "America/Chicago"),
    "tennessee": ("Tennessee", "US", "America/Chicago"),
    "alabama": ("Alabama", "US", "America/Chicago"),
    "oklahoma": ("Oklahoma", "US", "America/Chicago"),
    "kansas": ("Kansas", "US", "America/Chicago"),
    "nebraska": ("Nebraska", "US", "America/Chicago"),
    "iowa": ("Iowa", "US", "America/Chicago"),
    "arkansas": ("Arkansas", "US", "America/Chicago"),
    "mississippi": ("Mississippi", "US", "America/Chicago"),
    "new york state": ("New York", "US", "America/New_York"),
    "massachusetts": ("Massachusetts", "US", "America/New_York"),
    "florida": ("Florida", "US", "America/New_York"),
    "georgia": ("Georgia", "US", "America/New_York"),
    "virginia": ("Virginia", "US", "America/New_York"),
    "north carolina": ("North Carolina", "US", "America/New_York"),
    "south carolina": ("South Carolina", "US", "America/New_York"),
    "pennsylvania": ("Pennsylvania", "US", "America/New_York"),
    "ohio": ("Ohio", "US", "America/New_York"),
    "michigan": ("Michigan", "US", "America/Detroit"),
    "indiana": ("Indiana", "US", "America/Indiana/Indianapolis"),
    "new jersey": ("New Jersey", "US", "America/New_York"),
    "connecticut": ("Connecticut", "US", "America/New_York"),
    "maryland": ("Maryland", "US", "America/New_York"),
    "delaware": ("Delaware", "US", "America/New_York"),
    "vermont": ("Vermont", "US", "America/New_York"),
    "new hampshire": ("New Hampshire", "US", "America/New_York"),
    "maine": ("Maine", "US", "America/New_York"),
    "rhode island": ("Rhode Island", "US", "America/New_York"),
    "kentucky": ("Kentucky", "US", "America/New_York"),
    "west virginia": ("West Virginia", "US", "America/New_York"),
    "hawaii": ("Hawaii", "US", "Pacific/Honolulu"),
    "alaska": ("Alaska", "US", "America/Anchorage"),
    # Canadian provinces, Australian states, Indian states
    "ontario": ("Ontario", "CA", "America/Toronto"),
    "quebec": ("Quebec", "CA", "America/Toronto"),
    "british columbia": ("British Columbia", "CA", "America/Vancouver"),
    "alberta": ("Alberta", "CA", "America/Edmonton"),
    "manitoba": ("Manitoba", "CA", "America/Winnipeg"),
    "nova scotia": ("Nova Scotia", "CA", "America/Halifax"),
    "nsw": ("New South Wales", "AU", "Australia/Sydney"),
    "new south wales": ("New South Wales", "AU", "Australia/Sydney"),
    "victoria": ("Victoria", "AU", "Australia/Melbourne"),
    "queensland": ("Queensland", "AU", "Australia/Brisbane"),
    "western australia": ("Western Australia", "AU", "Australia/Perth"),
    "south australia": ("South Australia", "AU", "Australia/Adelaide"),
    "tamil nadu": ("Tamil Nadu", "IN", "Asia/Kolkata"),
    "karnataka": ("Karnataka", "IN", "Asia/Kolkata"),
    "maharashtra": ("Maharashtra", "IN", "Asia/Kolkata"),
    "kerala": ("Kerala", "IN", "Asia/Kolkata"),
    "telangana": ("Telangana", "IN", "Asia/Kolkata"),
    "andhra pradesh": ("Andhra Pradesh", "IN", "Asia/Kolkata"),
    "gujarat": ("Gujarat", "IN", "Asia/Kolkata"),
    "west bengal": ("West Bengal", "IN", "Asia/Kolkata"),
    "rajasthan": ("Rajasthan", "IN", "Asia/Kolkata"),
    "punjab": ("Punjab", "IN", "Asia/Kolkata"),
    "goa": ("Goa", "IN", "Asia/Kolkata"),
}

# Countries with multiple major timezones shown when searching by country name
MULTI_ZONE_COUNTRIES: dict[str, list[tuple[str, str]]] = {
    "US": [
        ("New York (ET)", "America/New_York"),
        ("Chicago (CT)", "America/Chicago"),
        ("Denver (MT)", "America/Denver"),
        ("San Francisco (PT)", "America/Los_Angeles"),
        ("Honolulu (HT)", "Pacific/Honolulu"),
    ],
    "CA": [
        ("Toronto (ET)", "America/Toronto"),
        ("Vancouver (PT)", "America/Vancouver"),
        ("Edmonton (MT)", "America/Edmonton"),
        ("Halifax (AT)", "America/Halifax"),
    ],
    "AU": [
        ("Sydney (AET)", "Australia/Sydney"),
        ("Brisbane (AEST)", "Australia/Brisbane"),
        ("Adelaide (ACT)", "Australia/Adelaide"),
        ("Perth (AWST)", "Australia/Perth"),
    ],
    "RU": [
        ("Moscow", "Europe/Moscow"),
        ("Yekaterinburg", "Asia/Yekaterinburg"),
        ("Novosibirsk", "Asia/Novosibirsk"),
        ("Vladivostok", "Asia/Vladivostok"),
    ],
    "BR": [
        ("São Paulo", "America/Sao_Paulo"),
        ("Manaus", "America/Manaus"),
    ],
    "MX": [
        ("Mexico City", "America/Mexico_City"),
        ("Tijuana", "America/Tijuana"),
    ],
    "ID": [
        ("Jakarta (WIB)", "Asia/Jakarta"),
        ("Bali / Makassar (WITA)", "Asia/Makassar"),
    ],
}


def normalize(text: str) -> str:
    decomposed = unicodedata.normalize("NFKD", text)
    ascii_only = "".join(ch for ch in decomposed if not unicodedata.combining(ch))
    return " ".join(ascii_only.lower().strip().split())


def is_valid_tz(tz: str) -> bool:
    if not tz:
        return False
    try:
        ZoneInfo(tz)
        return True
    except ZoneInfoNotFoundError:
        return False


def download_bytes(url: str) -> bytes:
    with urllib.request.urlopen(url, timeout=60) as resp:
        return resp.read()


def load_countries(path: Path | None) -> dict[str, str]:
    if path is not None:
        raw = path.read_text(encoding="utf-8")
    else:
        raw = download_bytes(GEONAMES_COUNTRIES_URL).decode("utf-8")
    countries: dict[str, str] = {}
    for line in raw.splitlines():
        if not line or line.startswith("#"):
            continue
        parts = line.split("\t")
        if len(parts) >= 5:
            code, name = parts[0].strip(), parts[4].strip()
            if code and name:
                countries[code] = name
    return countries


def load_cities(path: Path | None) -> list[dict]:
    if path is not None:
        raw = path.read_text(encoding="utf-8")
    else:
        data = download_bytes(GEONAMES_CITIES_URL)
        with zipfile.ZipFile(io.BytesIO(data)) as zf:
            raw = zf.read("cities15000.txt").decode("utf-8")

    rows: list[dict] = []
    for line in raw.splitlines():
        if not line:
            continue
        parts = line.split("\t")
        if len(parts) < 18:
            continue
        name = parts[1].strip()
        ascii_name = parts[2].strip() or name
        feature_code = parts[7].strip()
        country_code = parts[8].strip()
        pop = int(parts[14] or 0)
        tz = parts[17].strip()
        if not is_valid_tz(tz):
            continue
        if pop < MIN_POPULATION and feature_code not in KEEP_FEATURE_CODES:
            continue
        rows.append(
            {
                "name": name,
                "ascii": ascii_name,
                "cc": country_code,
                "pop": pop,
                "tz": tz,
                "capital": feature_code == "PPLC",
            }
        )
    return rows


def build_index(cities_path: Path | None, countries_path: Path | None) -> dict:
    country_names = load_countries(countries_path)
    raw_cities = load_cities(cities_path)

    # Sort by population descending, capitals boosted slightly on ties
    raw_cities.sort(key=lambda r: (r["pop"], 1 if r["capital"] else 0), reverse=True)

    # Deduplicate by (normalized_name, cc, tz) keeping highest population
    seen: set[tuple[str, str, str]] = set()
    cities_dedup: list[dict] = []
    country_tz_weights: dict[str, Counter] = defaultdict(Counter)

    for row in raw_cities:
        key = (normalize(row["ascii"]), row["cc"], row["tz"])
        country_tz_weights[row["cc"]][row["tz"]] += max(row["pop"], 1)
        if key in seen:
            continue
        seen.add(key)
        cities_dedup.append(row)

    # Collect unique valid timezones
    tz_set: set[str] = {"UTC"}
    for row in cities_dedup:
        tz_set.add(row["tz"])
    for _, _, tz in CURATED_ALIASES.values():
        if is_valid_tz(tz):
            tz_set.add(tz)
    for zones in MULTI_ZONE_COUNTRIES.values():
        for _, tz in zones:
            if is_valid_tz(tz):
                tz_set.add(tz)

    tz_list = sorted(tz_set)
    tz_to_idx = {tz: i for i, tz in enumerate(tz_list)}

    # Build compact cities list: [name, cc, tzIdx] or [name, cc, tzIdx, asciiLower]
    compact_cities: list[list] = []
    for row in cities_dedup:
        name = row["name"]
        norm_name = normalize(name)
        norm_ascii = normalize(row["ascii"])
        entry: list = [name, row["cc"], tz_to_idx[row["tz"]]]
        if norm_ascii != name.lower() or norm_name != name.lower():
            entry.append(norm_ascii if norm_ascii else norm_name)
        compact_cities.append(entry)

    # Build compact countries map: cc -> [countryName, primaryTzIdx]
    compact_countries: dict[str, list] = {}
    for cc, cname in sorted(country_names.items()):
        weights = country_tz_weights.get(cc)
        if not weights:
            continue
        primary_tz = weights.most_common(1)[0][0]
        compact_countries[cc] = [cname, tz_to_idx[primary_tz]]

    # Build compact aliases map: key -> [displayName, cc, tzIdx]
    compact_aliases: dict[str, list] = {}
    for key, (display, cc, tz) in sorted(CURATED_ALIASES.items()):
        if tz in tz_to_idx:
            compact_aliases[normalize(key)] = [display, cc, tz_to_idx[tz]]

    # Build multi-zone countries map: cc -> [[label, tzIdx], ...]
    compact_multi: dict[str, list] = {}
    for cc, zones in MULTI_ZONE_COUNTRIES.items():
        compact_multi[cc] = [[label, tz_to_idx[tz]] for label, tz in zones if tz in tz_to_idx]

    return {
        "tzs": tz_list,
        "countries": compact_countries,
        "cities": compact_cities,
        "aliases": compact_aliases,
        "multiZoneCountries": compact_multi,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="Build places.json for World Time")
    parser.add_argument("--cities", type=Path, default=None, help="Path to local cities15000.txt")
    parser.add_argument("--countries", type=Path, default=None, help="Path to local countryInfo.txt")
    parser.add_argument(
        "--output",
        type=Path,
        default=Path(__file__).resolve().parent.parent / "workflow" / "data" / "places.json",
        help="Output JSON path",
    )
    args = parser.parse_args()

    index = build_index(args.cities, args.countries)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    serialized = json.dumps(index, ensure_ascii=False, separators=(",", ":"))
    args.output.write_text(serialized, encoding="utf-8")

    print(
        f"Wrote {args.output} "
        f"({len(serialized) / 1024:.1f} KB): "
        f"{len(index['cities'])} cities, "
        f"{len(index['countries'])} countries, "
        f"{len(index['aliases'])} aliases, "
        f"{len(index['tzs'])} timezones"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
