"use strict";

// Pure Alfred Script Filter evaluator:
//   evaluateQuery(rawQuery, nowDate, config, placeIndex, deps) -> { items, rerun? }

const DEFAULT_PINNED = [
  "San Francisco",
  "New York",
  "London",
  "India",
  "Tokyo",
  "UTC",
];

function parsePinnedConfig(rawPinned) {
  if (typeof rawPinned !== "string" || !rawPinned.trim()) {
    return DEFAULT_PINNED;
  }
  return rawPinned
    .split(/[\n,]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function resolveDateInZone(dateSpec, nowDate, timeZone, tz) {
  const nowParts = tz.getZoneParts(nowDate, timeZone);
  if (!dateSpec) {
    return { year: nowParts.year, month: nowParts.month, day: nowParts.day };
  }
  if (dateSpec.kind === "relative") {
    const shifted = new Date(
      Date.UTC(nowParts.year, nowParts.month - 1, nowParts.day + dateSpec.dayOffset)
    );
    return {
      year: shifted.getUTCFullYear(),
      month: shifted.getUTCMonth() + 1,
      day: shifted.getUTCDate(),
    };
  }
  return {
    year: dateSpec.year || nowParts.year,
    month: dateSpec.month,
    day: dateSpec.day,
  };
}

function formatDayBadge(dayDelta) {
  if (dayDelta === 0) return "";
  return dayDelta > 0 ? ` (+${dayDelta}d)` : ` (${dayDelta}d)`;
}

function makePlaceLabelShort(place) {
  // "Chennai, India" -> "Chennai" for compact hero conversion titles
  const comma = place.label.indexOf(",");
  return comma > 0 ? place.label.slice(0, comma) : place.label;
}

function buildClockItem(date, place, opts, tz) {
  const {
    localTz,
    baseTz,
    baseLabel,
    timeFormat,
    isHome = false,
    prefixTitle = "",
  } = opts;

  const refTz = baseTz || localTz;
  const refLabel = baseLabel || "local";

  const timeStr = tz.formatTime(date, place.tz, timeFormat);
  const dateStr = tz.formatShortDate(date, place.tz);
  const abbrev = tz.getZoneAbbrev(date, place.tz);
  const offsetMin = tz.getOffsetMinutes(date, place.tz);
  const utcStr = tz.formatUtcOffset(offsetMin);
  const refOffsetMin = tz.getOffsetMinutes(date, refTz);
  const diffMin = offsetMin - refOffsetMin;
  const dayDelta = tz.getCalendarDayDelta(date, place.tz, refTz);
  const dayBadge = formatDayBadge(dayDelta);
  const flag = tz.countryCodeToFlag(place.countryCode);

  const tzTag = abbrev === utcStr || abbrev.startsWith("GMT") ? utcStr : `${abbrev} (${utcStr})`;
  const title = `${prefixTitle}${timeStr}${dayBadge} · ${place.label}`;

  let subtitle;
  if (isHome) {
    subtitle = `🏠 Local · ${dateStr} · ${tzTag}`;
  } else {
    const relStr = tz.formatRelativeDiff(diffMin, refLabel);
    subtitle = `${flag} ${dateStr} · ${tzTag} · ${relStr}`;
  }

  const copySummary = `${timeStr} ${abbrev} · ${place.label} (${dateStr})`;
  const isoStr = tz.formatIso8601(date, place.tz);
  const unixStr = String(Math.floor(date.getTime() / 1000));

  return {
    title,
    subtitle,
    arg: copySummary,
    valid: true,
    icon: { path: isHome ? "icons/home.png" : tz.getDayPhaseIcon(date, place.tz) },
    text: {
      copy: copySummary,
      largetype: `${timeStr}${dayBadge}\n${place.label}\n${dateStr} · ${tzTag}`,
    },
    mods: {
      cmd: {
        valid: true,
        arg: timeStr,
        subtitle: `Copy time only: ${timeStr}`,
      },
      alt: {
        valid: true,
        arg: isoStr,
        subtitle: `Copy ISO 8601: ${isoStr}`,
      },
      ctrl: {
        valid: true,
        arg: unixStr,
        subtitle: `Copy Unix timestamp: ${unixStr}`,
      },
    },
  };
}

function buildConversionHeroItem(date, fromPlace, toPlace, timeFormat, tz) {
  const fromTime = tz.formatTime(date, fromPlace.tz, timeFormat);
  const toTime = tz.formatTime(date, toPlace.tz, timeFormat);
  const fromDate = tz.formatShortDate(date, fromPlace.tz);
  const toDate = tz.formatShortDate(date, toPlace.tz);
  const fromAbbrev = tz.getZoneAbbrev(date, fromPlace.tz);
  const toAbbrev = tz.getZoneAbbrev(date, toPlace.tz);
  const fromShort = makePlaceLabelShort(fromPlace);
  const toShort = makePlaceLabelShort(toPlace);

  const diffMin =
    tz.getOffsetMinutes(date, toPlace.tz) - tz.getOffsetMinutes(date, fromPlace.tz);
  const dayDelta = tz.getCalendarDayDelta(date, toPlace.tz, fromPlace.tz);
  const dayBadge = formatDayBadge(dayDelta);

  const fromFlag = tz.countryCodeToFlag(fromPlace.countryCode);
  const toFlag = tz.countryCodeToFlag(toPlace.countryCode);
  const relStr = tz.formatRelativeDiff(diffMin, fromShort);

  const title = `${fromTime} ${fromShort} → ${toTime}${dayBadge} ${toShort}`;
  const subtitle = `${fromFlag} ${fromDate} (${fromAbbrev}) → ${toFlag} ${toDate} (${toAbbrev}) · ${relStr}`;
  const copySummary = `${fromTime} ${fromAbbrev} (${fromShort}) → ${toTime} ${toAbbrev} (${toShort}, ${toDate})`;
  const isoStr = tz.formatIso8601(date, toPlace.tz);
  const unixStr = String(Math.floor(date.getTime() / 1000));

  return {
    title,
    subtitle,
    arg: copySummary,
    valid: true,
    icon: { path: "icons/convert.png" },
    text: {
      copy: copySummary,
      largetype: `${fromTime} ${fromShort}\n↓\n${toTime}${dayBadge} ${toShort}\n${toDate} · ${toAbbrev}`,
    },
    mods: {
      cmd: {
        valid: true,
        arg: toTime,
        subtitle: `Copy target time only: ${toTime}`,
      },
      alt: {
        valid: true,
        arg: isoStr,
        subtitle: `Copy target ISO 8601: ${isoStr}`,
      },
      ctrl: {
        valid: true,
        arg: unixStr,
        subtitle: `Copy Unix timestamp: ${unixStr}`,
      },
    },
  };
}

function buildNotFoundItem(query) {
  return {
    title: `No location found for "${query}"`,
    subtitle: "Try a city (Chennai, Beijing), country (India), airport (JFK), or timezone (IST, PST)",
    valid: false,
    icon: { path: "icon.png" },
  };
}

function makeLocalPlace(localTz) {
  const city = localTz.includes("/") ? localTz.split("/").pop().replace(/_/g, " ") : localTz;
  return {
    label: city,
    countryCode: "",
    countryName: "",
    tz: localTz,
    kind: "local",
  };
}

function getPinnedPlaces(config, placeIndex) {
  const names = parsePinnedConfig(config.pinnedLocations);
  const places = [];
  const seen = new Set();
  for (let i = 0; i < names.length; i++) {
    const match = placeIndex.resolvePlace(names[i]);
    if (match) {
      const key = `${match.label}|${match.tz}`;
      if (!seen.has(key)) {
        seen.add(key);
        places.push(match);
      }
    }
  }
  return places;
}

function evaluateQuery(rawQuery, nowDate, config, placeIndex, deps) {
  const { tz, parser } = deps;
  const localTz = config.localTz || tz.getLocalTimeZone();
  const timeFormat = config.timeFormat || "12h";
  const liveRefresh = config.liveRefresh !== false;
  const rerunSeconds =
    timeFormat === "12h_sec" || timeFormat === "24h_sec" ? 1 : 10;

  const localPlace = makeLocalPlace(localTz);
  const parsed = parser.parseQuery(rawQuery);
  const items = [];
  let shouldRerun = false;

  if (parsed.kind === "pinned") {
    shouldRerun = true;
    items.push(
      buildClockItem(nowDate, localPlace, { localTz, timeFormat, isHome: true }, tz)
    );
    const pinned = getPinnedPlaces(config, placeIndex);
    for (let i = 0; i < pinned.length; i++) {
      items.push(
        buildClockItem(nowDate, pinned[i], { localTz, timeFormat }, tz)
      );
    }
  } else if (parsed.kind === "place") {
    shouldRerun = true;
    const matches = placeIndex.searchPlaces(parsed.placeQuery, 8);
    if (matches.length === 0) {
      items.push(buildNotFoundItem(parsed.placeQuery));
    } else {
      for (let i = 0; i < matches.length; i++) {
        items.push(
          buildClockItem(nowDate, matches[i], { localTz, timeFormat }, tz)
        );
      }
    }
  } else if (parsed.kind === "offset") {
    shouldRerun = true;
    const targetDate = new Date(nowDate.getTime() + parsed.deltaMs);
    if (parsed.placeQuery) {
      const matches = placeIndex.searchPlaces(parsed.placeQuery, 6);
      if (matches.length === 0) {
        items.push(buildNotFoundItem(parsed.placeQuery));
      } else {
        for (let i = 0; i < matches.length; i++) {
          items.push(
            buildClockItem(targetDate, matches[i], { localTz, timeFormat }, tz)
          );
        }
      }
    } else {
      items.push(
        buildClockItem(targetDate, localPlace, { localTz, timeFormat, isHome: true }, tz)
      );
      const pinned = getPinnedPlaces(config, placeIndex);
      for (let i = 0; i < pinned.length; i++) {
        items.push(
          buildClockItem(targetDate, pinned[i], { localTz, timeFormat }, tz)
        );
      }
    }
  } else if (parsed.kind === "diff") {
    shouldRerun = true;
    const fromPlace = parsed.fromQuery
      ? placeIndex.resolvePlace(parsed.fromQuery)
      : localPlace;
    const toPlace = placeIndex.resolvePlace(parsed.toQuery);

    if (parsed.fromQuery && !fromPlace) {
      items.push(buildNotFoundItem(parsed.fromQuery));
    } else if (!toPlace) {
      items.push(buildNotFoundItem(parsed.toQuery));
    } else {
      const fromShort = parsed.fromQuery ? makePlaceLabelShort(fromPlace) : localPlace.label;
      const toShort = makePlaceLabelShort(toPlace);
      const diffMin =
        tz.getOffsetMinutes(nowDate, toPlace.tz) -
        tz.getOffsetMinutes(nowDate, fromPlace.tz);
      const relStr = tz.formatRelativeDiff(diffMin, fromShort);
      const toTime = tz.formatTime(nowDate, toPlace.tz, timeFormat);
      const fromTime = tz.formatTime(nowDate, fromPlace.tz, timeFormat);
      const toDate = tz.formatShortDate(nowDate, toPlace.tz);
      const fromDate = tz.formatShortDate(nowDate, fromPlace.tz);
      const toFlag = tz.countryCodeToFlag(toPlace.countryCode);
      const fromFlag = parsed.fromQuery ? tz.countryCodeToFlag(fromPlace.countryCode) : "🏠";

      const summary = `${toShort} is ${relStr}`;
      items.push({
        title: summary,
        subtitle: `${toFlag} ${toTime} (${toDate}) · ${fromFlag} ${fromTime} (${fromDate})`,
        arg: summary,
        valid: true,
        icon: { path: "icons/diff.png" },
        text: {
          copy: summary,
          largetype: `${summary}\n${toShort}: ${toTime} (${toDate})\n${fromShort}: ${fromTime} (${fromDate})`,
        },
      });
      items.push(
        buildClockItem(
          nowDate,
          toPlace,
          { localTz, baseTz: fromPlace.tz, baseLabel: fromShort, timeFormat },
          tz
        )
      );
      items.push(
        buildClockItem(
          nowDate,
          fromPlace,
          { localTz, timeFormat, isHome: !parsed.fromQuery },
          tz
        )
      );
    }
  } else if (parsed.kind === "convert") {
    const fromPlace = parsed.fromQuery
      ? placeIndex.resolvePlace(parsed.fromQuery)
      : localPlace;
    if (parsed.fromQuery && !fromPlace) {
      items.push(buildNotFoundItem(parsed.fromQuery));
    } else {
      const dateYmd = resolveDateInZone(parsed.dateSpec, nowDate, fromPlace.tz, tz);
      const instant = tz.wallClockToDate(
        {
          year: dateYmd.year,
          month: dateYmd.month,
          day: dateYmd.day,
          hour: parsed.hour,
          minute: parsed.minute,
          second: parsed.second,
        },
        fromPlace.tz
      );

      if (parsed.toQuery) {
        const targets = placeIndex.searchPlaces(parsed.toQuery, 6);
        if (targets.length === 0) {
          items.push(buildNotFoundItem(parsed.toQuery));
        } else {
          const primaryTarget = targets[0];
          items.push(
            buildConversionHeroItem(instant, fromPlace, primaryTarget, timeFormat, tz)
          );
          const fromShort = parsed.fromQuery ? makePlaceLabelShort(fromPlace) : "local";
          for (let i = 0; i < targets.length; i++) {
            items.push(
              buildClockItem(
                instant,
                targets[i],
                { localTz, baseTz: fromPlace.tz, baseLabel: fromShort, timeFormat },
                tz
              )
            );
          }
          if (fromPlace.tz !== localTz && primaryTarget.tz !== localTz) {
            items.push(
              buildClockItem(instant, localPlace, { localTz, timeFormat, isHome: true }, tz)
            );
          }
        }
      } else if (parsed.fromQuery) {
        // "5pm chennai" -> convert from Chennai to Local (+ pinned)
        items.push(
          buildConversionHeroItem(instant, fromPlace, localPlace, timeFormat, tz)
        );
        items.push(
          buildClockItem(instant, localPlace, { localTz, timeFormat, isHome: true }, tz)
        );
        items.push(
          buildClockItem(instant, fromPlace, { localTz, timeFormat }, tz)
        );
        const pinned = getPinnedPlaces(config, placeIndex);
        for (let i = 0; i < pinned.length; i++) {
          if (pinned[i].tz !== fromPlace.tz && pinned[i].tz !== localTz) {
            items.push(buildClockItem(instant, pinned[i], { localTz, timeFormat }, tz));
          }
        }
      } else {
        // Bare time "5pm" or "14:30 2026-07-01" -> local + pinned (World Clock 'meet' mode!)
        items.push(
          buildClockItem(instant, localPlace, { localTz, timeFormat, isHome: true }, tz)
        );
        const pinned = getPinnedPlaces(config, placeIndex);
        for (let i = 0; i < pinned.length; i++) {
          items.push(buildClockItem(instant, pinned[i], { localTz, timeFormat }, tz));
        }
      }
    }
  } else if (parsed.kind === "instant") {
    if (parsed.toQuery) {
      const targets = placeIndex.searchPlaces(parsed.toQuery, 6);
      if (targets.length === 0) {
        items.push(buildNotFoundItem(parsed.toQuery));
      } else {
        for (let i = 0; i < targets.length; i++) {
          items.push(
            buildClockItem(parsed.date, targets[i], { localTz, timeFormat }, tz)
          );
        }
      }
    } else {
      items.push(
        buildClockItem(parsed.date, localPlace, { localTz, timeFormat, isHome: true }, tz)
      );
      items.push(
        buildClockItem(
          parsed.date,
          { label: "UTC", countryCode: "", countryName: "", tz: "UTC", kind: "iana" },
          { localTz, timeFormat },
          tz
        )
      );
      const pinned = getPinnedPlaces(config, placeIndex);
      for (let i = 0; i < pinned.length; i++) {
        if (pinned[i].tz !== "UTC" && pinned[i].tz !== localTz) {
          items.push(buildClockItem(parsed.date, pinned[i], { localTz, timeFormat }, tz));
        }
      }
    }
  }

  const response = { items };
  if (liveRefresh && shouldRerun) {
    response.rerun = rerunSeconds;
  }
  return response;
}

const alfredModule = { evaluateQuery, parsePinnedConfig, DEFAULT_PINNED };

if (typeof module !== "undefined" && module.exports) {
  module.exports = alfredModule;
}
