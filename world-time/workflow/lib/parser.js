"use strict";

// Pure natural-language query parser for World Time.
// Returns a closed variant object:
//   { kind: "pinned" }
//   { kind: "place", placeQuery }
//   { kind: "offset", deltaMs, placeQuery }
//   { kind: "diff", fromQuery, toQuery }
//   { kind: "convert", hour, minute, second, dateSpec, fromQuery, toQuery }
//   { kind: "instant", date, toQuery }

const MONTHS = {
  jan: 1, january: 1,
  feb: 2, february: 2,
  mar: 3, march: 3,
  apr: 4, april: 4,
  may: 5,
  jun: 6, june: 6,
  jul: 7, july: 7,
  aug: 8, august: 8,
  sep: 9, sept: 9, september: 9,
  oct: 10, october: 10,
  nov: 11, november: 11,
  dec: 12, december: 12,
};

const UNIT_MS = {
  s: 1000, sec: 1000, secs: 1000, second: 1000, seconds: 1000,
  m: 60000, min: 60000, mins: 60000, minute: 60000, minutes: 60000,
  h: 3600000, hr: 3600000, hrs: 3600000, hour: 3600000, hours: 3600000,
  d: 86400000, day: 86400000, days: 86400000,
  w: 604800000, wk: 604800000, wks: 604800000, week: 604800000, weeks: 604800000,
};

function parseDurationMs(text) {
  const cleaned = text.trim().toLowerCase();
  if (!cleaned) return null;
  const tokenRe = /(\d+(?:\.\d+)?)\s*(weeks?|wks?|w|days?|d|hours?|hrs?|h|minutes?|mins?|m|seconds?|secs?|s)(?![a-z])/g;
  let total = 0;
  let matchedChars = 0;
  let match;
  while ((match = tokenRe.exec(cleaned)) !== null) {
    const val = parseFloat(match[1]);
    const unit = UNIT_MS[match[2]];
    if (!unit || Number.isNaN(val)) return null;
    total += val * unit;
    matchedChars += match[0].length;
  }
  const leftover = cleaned.replace(tokenRe, "").replace(/\band\b/g, "").trim();
  if (matchedChars === 0 || leftover.length > 0) return null;
  return Math.round(total);
}

function parseIsoOrEpoch(text) {
  // ISO 8601 with optional trailing "in <place>" or "to <place>"
  const isoMatch = text.match(
    /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2}))(?:\s+(?:in|to|->)\s+(.+))?$/i
  );
  if (isoMatch) {
    const date = new Date(isoMatch[1]);
    if (!Number.isNaN(date.getTime())) {
      return { kind: "instant", date, toQuery: isoMatch[2] ? isoMatch[2].trim() : null };
    }
  }

  // Unix epoch (10 digits seconds or 13 digits ms)
  const epochMatch = text.match(/^(\d{10}|\d{13})(?:\s+(?:in|to|->)\s+(.+))?$/i);
  if (epochMatch) {
    const num = Number(epochMatch[1]);
    const ms = epochMatch[1].length === 13 ? num : num * 1000;
    const date = new Date(ms);
    if (!Number.isNaN(date.getTime())) {
      return { kind: "instant", date, toQuery: epochMatch[2] ? epochMatch[2].trim() : null };
    }
  }
  return null;
}

function parseDiff(text) {
  const m = text.match(/^(?:time\s+)?diff(?:erence)?(?:\s+between)?\s+(.+)$/i);
  if (!m) return null;
  const body = m[1].trim();
  if (!body) return null;

  const pairMatch = body.match(/^(.+?)\s+(?:and|to|vs\.?|versus|from|->)\s+(.+)$/i);
  if (pairMatch) {
    return {
      kind: "diff",
      fromQuery: pairMatch[1].trim(),
      toQuery: pairMatch[2].trim(),
    };
  }
  return {
    kind: "diff",
    fromQuery: null,
    toQuery: body,
  };
}

function parseOffset(text) {
  // 1. Signed compact offset: "+2h30m", "-3h", "+1d in tokyo", "+4 hours in chennai"
  const signedMatch = text.match(/^([+-])\s*(.+)$/);
  if (signedMatch) {
    const sign = signedMatch[1] === "-" ? -1 : 1;
    const rest = signedMatch[2].trim();
    const splitMatch = rest.match(/^(.+?)\s+(?:in|to|at)\s+(.+)$/i);
    if (splitMatch) {
      const ms = parseDurationMs(splitMatch[1]);
      if (ms !== null) {
        return { kind: "offset", deltaMs: sign * ms, placeQuery: splitMatch[2].trim() };
      }
    }
    const ms = parseDurationMs(rest);
    if (ms !== null) {
      return { kind: "offset", deltaMs: sign * ms, placeQuery: null };
    }
  }

  // 2. Natural language "in <duration> [in <place>]"
  const inDurMatch = text.match(/^in\s+(\d.+)$/i);
  if (inDurMatch) {
    const rest = inDurMatch[1].trim();
    const splitMatch = rest.match(/^(.+?)\s+(?:in|at)\s+(.+)$/i);
    if (splitMatch) {
      const ms = parseDurationMs(splitMatch[1]);
      if (ms !== null) {
        return { kind: "offset", deltaMs: ms, placeQuery: splitMatch[2].trim() };
      }
    }
    const ms = parseDurationMs(rest);
    if (ms !== null) {
      return { kind: "offset", deltaMs: ms, placeQuery: null };
    }
  }

  // 3. Natural language "<duration> ago [in <place>]"
  const agoMatch = text.match(/^(.+?)\s+ago(?:\s+(?:in|at)\s+(.+))?$/i);
  if (agoMatch) {
    const ms = parseDurationMs(agoMatch[1]);
    if (ms !== null) {
      return {
        kind: "offset",
        deltaMs: -ms,
        placeQuery: agoMatch[2] ? agoMatch[2].trim() : null,
      };
    }
  }

  // 4. Place +/- duration: "tokyo + 4 hours", "in brisbane + 4h", "chennai - 30m"
  const placeOpMatch = text.match(/^(?:(?:time\s+)?(?:in|at)\s+)?(.+?)\s*([+-])\s*(\d.+)$/i);
  if (placeOpMatch) {
    const ms = parseDurationMs(placeOpMatch[3]);
    if (ms !== null) {
      const sign = placeOpMatch[2] === "-" ? -1 : 1;
      const place = placeOpMatch[1].trim();
      if (place) {
        return { kind: "offset", deltaMs: sign * ms, placeQuery: place };
      }
    }
  }

  return null;
}

function parseLeadingTime(text) {
  // Named times: noon, midnight
  const named = text.match(/^(noon|midnight)\b(.*)$/i);
  if (named) {
    return {
      hour: named[1].toLowerCase() === "noon" ? 12 : 0,
      minute: 0,
      second: 0,
      rest: named[2].trim(),
    };
  }

  // 12-hour format with am/pm: "5pm", "5:30pm", "5:30 pm", "12:05:30 am"
  const m12 = text.match(/^(\d{1,2})(?::(\d{2})(?::(\d{2}))?)?\s*(am|pm)\b(.*)$/i);
  if (m12) {
    let hour = Number(m12[1]);
    const minute = m12[2] !== undefined ? Number(m12[2]) : 0;
    const second = m12[3] !== undefined ? Number(m12[3]) : 0;
    const meridiem = m12[4].toLowerCase();
    if (hour >= 1 && hour <= 12 && minute <= 59 && second <= 59) {
      if (meridiem === "am") {
        hour = hour === 12 ? 0 : hour;
      } else {
        hour = hour === 12 ? 12 : hour + 12;
      }
      return { hour, minute, second, rest: m12[5].trim() };
    }
  }

  // 24-hour format with colon: "14:30", "09:00", "23:45:10"
  const m24 = text.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?\b(.*)$/);
  if (m24) {
    const hour = Number(m24[1]);
    const minute = Number(m24[2]);
    const second = m24[3] !== undefined ? Number(m24[3]) : 0;
    if (hour <= 23 && minute <= 59 && second <= 59) {
      return { hour, minute, second, rest: m24[4].trim() };
    }
  }

  return null;
}

function parseLeadingDateSpec(text) {
  if (!text) return { dateSpec: null, rest: "" };

  // Relative day keywords
  const rel = text.match(/^(today|tomorrow|tmr|yesterday)\b(.*)$/i);
  if (rel) {
    const word = rel[1].toLowerCase();
    const dayOffset = word === "yesterday" ? -1 : word === "today" ? 0 : 1;
    return { dateSpec: { kind: "relative", dayOffset }, rest: rel[2].trim() };
  }

  // ISO date: YYYY-MM-DD
  const iso = text.match(/^(\d{4})-(\d{2})-(\d{2})\b(.*)$/);
  if (iso) {
    return {
      dateSpec: {
        kind: "absolute",
        year: Number(iso[1]),
        month: Number(iso[2]),
        day: Number(iso[3]),
      },
      rest: iso[4].trim(),
    };
  }

  // "Dec 25 [2026]" or "December 25, 2026"
  const mdy = text.match(/^([a-z]{3,9})\s+(\d{1,2})(?:,?\s+(\d{4}))?\b(.*)$/i);
  if (mdy && MONTHS[mdy[1].toLowerCase()]) {
    const day = Number(mdy[2]);
    if (day >= 1 && day <= 31) {
      return {
        dateSpec: {
          kind: "absolute",
          year: mdy[3] ? Number(mdy[3]) : null,
          month: MONTHS[mdy[1].toLowerCase()],
          day,
        },
        rest: mdy[4].trim(),
      };
    }
  }

  // "25 Dec [2026]"
  const dmy = text.match(/^(\d{1,2})\s+([a-z]{3,9})(?:\s+(\d{4}))?\b(.*)$/i);
  if (dmy && MONTHS[dmy[2].toLowerCase()]) {
    const day = Number(dmy[1]);
    if (day >= 1 && day <= 31) {
      return {
        dateSpec: {
          kind: "absolute",
          year: dmy[3] ? Number(dmy[3]) : null,
          month: MONTHS[dmy[2].toLowerCase()],
          day,
        },
        rest: dmy[4].trim(),
      };
    }
  }

  return { dateSpec: null, rest: text };
}

function parseConvert(text) {
  // Strip optional leading "at "
  const cleaned = text.replace(/^at\s+/i, "").trim();

  // Case A: time first ("5pm ldn in sf", "5pm tomorrow in tokyo", "14:30 in chennai")
  const leadTime = parseLeadingTime(cleaned);
  if (leadTime) {
    const { dateSpec, rest } = parseLeadingDateSpec(leadTime.rest);
    return buildConvertFromRest(leadTime, dateSpec, rest);
  }

  // Case B: date first ("tomorrow 5pm ldn in sf", "2026-07-01 9am london in sf")
  const leadDate = parseLeadingDateSpec(cleaned);
  if (leadDate.dateSpec) {
    const timeAfterDate = parseLeadingTime(leadDate.rest);
    if (timeAfterDate) {
      return buildConvertFromRest(timeAfterDate, leadDate.dateSpec, timeAfterDate.rest);
    }
  }

  return null;
}

function buildConvertFromRest(timeInfo, dateSpec, rest) {
  if (!rest) {
    return {
      kind: "convert",
      hour: timeInfo.hour,
      minute: timeInfo.minute,
      second: timeInfo.second,
      dateSpec,
      fromQuery: null,
      toQuery: null,
    };
  }

  // Starts with "in <target>" or "to <target>" or "-> <target>" -> source is local
  const toOnly = rest.match(/^(?:in|to|->|=>)\s+(.+)$/i);
  if (toOnly) {
    return {
      kind: "convert",
      hour: timeInfo.hour,
      minute: timeInfo.minute,
      second: timeInfo.second,
      dateSpec,
      fromQuery: null,
      toQuery: toOnly[1].trim(),
    };
  }

  // "<source> in <target>" or "<source> to <target>" or "<source> -> <target>"
  const fromTo = rest.match(/^(.+?)\s+(?:in|to|->|=>)\s+(.+)$/i);
  if (fromTo) {
    return {
      kind: "convert",
      hour: timeInfo.hour,
      minute: timeInfo.minute,
      second: timeInfo.second,
      dateSpec,
      fromQuery: fromTo[1].trim(),
      toQuery: fromTo[2].trim(),
    };
  }

  // "<source>" only -> source is that place, target is local (+ pinned)
  return {
    kind: "convert",
    hour: timeInfo.hour,
    minute: timeInfo.minute,
    second: timeInfo.second,
    dateSpec,
    fromQuery: rest,
    toQuery: null,
  };
}

function parseQuery(rawInput) {
  const text = (rawInput || "").trim().replace(/\s+/g, " ");
  if (!text) return { kind: "pinned" };

  const instant = parseIsoOrEpoch(text);
  if (instant) return instant;

  const diff = parseDiff(text);
  if (diff) return diff;

  const offset = parseOffset(text);
  if (offset) return offset;

  const conv = parseConvert(text);
  if (conv) return conv;

  // Default: current time in a place (strip optional leading "time in", "in", "at")
  const placeQuery = text
    .replace(/^(?:(?:current\s+)?time\s+)?(?:in|at)\s+/i, "")
    .trim();

  if (!placeQuery) return { kind: "pinned" };
  return { kind: "place", placeQuery };
}

const parserModule = { parseQuery, parseDurationMs };

if (typeof module !== "undefined" && module.exports) {
  module.exports = parserModule;
}
