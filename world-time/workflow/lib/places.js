"use strict";

// Pure offline place search and ranking over data/places.json.

function normalizeQuery(text) {
  if (!text) return "";
  return text
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[._]+/g, " ")
    .replace(/[^a-z0-9/+\-\s,]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function createPlaceIndex(raw) {
  const tzs = raw.tzs || [];
  const countries = raw.countries || {};
  const cities = raw.cities || [];
  const aliases = raw.aliases || {};
  const multiZoneCountries = raw.multiZoneCountries || {};

  // Pre-build normalized lookup structures once per run (~2ms)
  const countryList = [];
  const countryByNorm = new Map();
  for (const cc of Object.keys(countries)) {
    const [name, tzIdx] = countries[cc];
    const norm = normalizeQuery(name);
    const entry = { cc, name, norm, tz: tzs[tzIdx] };
    countryList.push(entry);
    countryByNorm.set(norm, entry);
  }

  const tzByNorm = new Map();
  for (let i = 0; i < tzs.length; i++) {
    tzByNorm.set(tzs[i].toLowerCase(), tzs[i]);
  }

  const aliasEntries = [];
  for (const key of Object.keys(aliases)) {
    const [label, cc, tzIdx] = aliases[key];
    aliasEntries.push({ key, label, cc, tz: tzs[tzIdx] });
  }

  function makePlace(label, cc, tz, kind, countryName) {
    const resolvedCountry = countryName || (cc && countries[cc] ? countries[cc][0] : "");
    return {
      label,
      countryCode: cc || "",
      countryName: resolvedCountry,
      tz,
      kind,
    };
  }

  function formatCityDisplay(name, cc) {
    const cname = cc && countries[cc] ? countries[cc][0] : "";
    return cname ? `${name}, ${cname}` : name;
  }

  function expandCountry(entry) {
    const multi = multiZoneCountries[entry.cc];
    if (multi && multi.length > 0) {
      return multi.map(([label, tzIdx]) =>
        makePlace(`${label}, ${entry.name}`, entry.cc, tzs[tzIdx], "country", entry.name)
      );
    }
    return [makePlace(entry.name, entry.cc, entry.tz, "country", entry.name)];
  }

  /**
   * Search for places matching `rawQuery`. Returns up to `limit` ranked results.
   */
  function searchPlaces(rawQuery, limit = 8) {
    const q = normalizeQuery(rawQuery);
    if (!q) return [];

    // Check for "city, country" or "city country" split
    let cityPart = q;
    let countryFilterCc = null;
    if (q.includes(",")) {
      const [left, right] = q.split(",").map((s) => s.trim());
      if (left && right) {
        const ccUpper = right.toUpperCase();
        if (countries[ccUpper]) {
          cityPart = left;
          countryFilterCc = ccUpper;
        } else if (countryByNorm.has(right)) {
          cityPart = left;
          countryFilterCc = countryByNorm.get(right).cc;
        }
      }
    }

    const candidates = [];
    const seen = new Set();

    function push(place, score) {
      const dedupKey = `${place.label.toLowerCase()}|${place.tz}`;
      if (seen.has(dedupKey)) return;
      seen.add(dedupKey);
      candidates.push({ place, score });
    }

    // 1. Exact IANA timezone (e.g. "Asia/Kolkata")
    const ianaExact = tzByNorm.get(q.replace(/\s+/g, "_"));
    if (ianaExact) {
      const cityLabel = ianaExact.split("/").pop().replace(/_/g, " ");
      push(makePlace(cityLabel, "", ianaExact, "iana", ""), 1000);
    }

    // 2. Exact alias match (e.g. "sf", "ist", "ldn", "jfk", "uk", "usa")
    if (aliases[q]) {
      const [label, cc, tzIdx] = aliases[q];
      if ((q === "us" || q === "usa") && multiZoneCountries.US) {
        const entry = countryByNorm.get("united states");
        if (entry) {
          const expanded = expandCountry(entry);
          expanded.forEach((p, idx) => push(p, 980 - idx));
        }
      } else {
        push(makePlace(label, cc, tzs[tzIdx], "alias"), 990);
      }
    }

    // 3. Exact country match (e.g. "india", "china", "japan", "united states")
    const exactCountry = countryByNorm.get(q);
    if (exactCountry) {
      const expanded = expandCountry(exactCountry);
      expanded.forEach((p, idx) => push(p, 970 - idx));
    }

    // 4. Scan cities (already sorted by population descending!)
    const target = cityPart;
    const isShort = target.length <= 2;
    let exactCityCount = 0;
    let prefixCityCount = 0;
    let containsCityCount = 0;

    for (let i = 0; i < cities.length; i++) {
      const row = cities[i];
      const name = row[0];
      const cc = row[1];
      const tzIdx = row[2];
      const norm = row.length >= 4 ? row[3] : name.toLowerCase();

      if (countryFilterCc && cc !== countryFilterCc) continue;

      // Population bonus: earlier rows have higher population (0..120 range)
      const popBonus = Math.max(0, 120 - Math.floor(i / 110));

      if (norm === target) {
        push(makePlace(formatCityDisplay(name, cc), cc, tzs[tzIdx], "city"), 950 + popBonus);
        exactCityCount++;
        if (exactCityCount >= 6) continue;
      } else if (norm.startsWith(target)) {
        if (prefixCityCount < 20) {
          push(makePlace(formatCityDisplay(name, cc), cc, tzs[tzIdx], "city"), 700 + popBonus);
          prefixCityCount++;
        }
      } else if (!isShort && containsCityCount < 10) {
        const idx = norm.indexOf(target);
        if (idx > 0 && norm[idx - 1] === " ") {
          push(makePlace(formatCityDisplay(name, cc), cc, tzs[tzIdx], "city"), 520 + popBonus);
          containsCityCount++;
        }
      }
    }

    // 5. Prefix matches on countries (e.g. "ind" -> India, Indonesia)
    if (!countryFilterCc && q.length >= 2) {
      for (let i = 0; i < countryList.length; i++) {
        const c = countryList[i];
        if (c.norm !== q && c.norm.startsWith(q)) {
          push(makePlace(c.name, c.cc, c.tz, "country", c.name), 780);
        }
      }
    }

    // 6. Prefix matches on aliases (only for length >= 2 to avoid noise)
    if (!countryFilterCc && q.length >= 2) {
      for (let i = 0; i < aliasEntries.length; i++) {
        const a = aliasEntries[i];
        if (a.key !== q && a.key.startsWith(q)) {
          push(makePlace(a.label, a.cc, a.tz, "alias"), 740);
        }
      }
    }

    // 7. Substring fallback on cities if we still have very few results
    if (candidates.length < 3 && target.length >= 3) {
      let subCount = 0;
      for (let i = 0; i < cities.length && subCount < 8; i++) {
        const row = cities[i];
        const name = row[0];
        const cc = row[1];
        const tzIdx = row[2];
        const norm = row.length >= 4 ? row[3] : name.toLowerCase();
        if (countryFilterCc && cc !== countryFilterCc) continue;
        if (norm.includes(target)) {
          const popBonus = Math.max(0, 80 - Math.floor(i / 160));
          push(makePlace(formatCityDisplay(name, cc), cc, tzs[tzIdx], "city"), 350 + popBonus);
          subCount++;
        }
      }
    }

    // 8. If query is "city country" without comma (e.g. "hyderabad pakistan" or "paris texas")
    if (candidates.length === 0 && !countryFilterCc && q.includes(" ")) {
      const tokens = q.split(" ");
      for (let split = tokens.length - 1; split >= 1; split--) {
        const left = tokens.slice(0, split).join(" ");
        const right = tokens.slice(split).join(" ");
        const ccUpper = right.toUpperCase();
        let matchedCc = null;
        if (countries[ccUpper]) matchedCc = ccUpper;
        else if (countryByNorm.has(right)) matchedCc = countryByNorm.get(right).cc;
        else if (aliases[right] && aliases[right][1]) matchedCc = aliases[right][1];

        if (matchedCc) {
          for (let i = 0; i < cities.length; i++) {
            const row = cities[i];
            if (row[1] !== matchedCc) continue;
            const norm = row.length >= 4 ? row[3] : row[0].toLowerCase();
            if (norm === left || norm.startsWith(left)) {
              const popBonus = Math.max(0, 100 - Math.floor(i / 130));
              push(
                makePlace(formatCityDisplay(row[0], row[1]), row[1], tzs[row[2]], "city"),
                (norm === left ? 900 : 680) + popBonus
              );
            }
          }
          if (candidates.length > 0) break;
        }
      }
    }

    candidates.sort((a, b) => b.score - a.score);
    return candidates.slice(0, limit).map((c) => c.place);
  }

  /**
   * Resolve a place query to its single best match, or null if not found.
   */
  function resolvePlace(rawQuery) {
    const matches = searchPlaces(rawQuery, 1);
    return matches.length > 0 ? matches[0] : null;
  }

  return { searchPlaces, resolvePlace, normalizeQuery };
}

const placesModule = { createPlaceIndex, normalizeQuery };

if (typeof module !== "undefined" && module.exports) {
  module.exports = placesModule;
}
