"use strict";

// Pure timezone math and formatting using standard Intl.DateTimeFormat.
// Works identically in macOS JXA (JavaScriptCore) and Node.js.

const partsFormatCache = new Map();

function getPartsFormatter(timeZone) {
  let fmt = partsFormatCache.get(timeZone);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat("en-US", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    });
    partsFormatCache.set(timeZone, fmt);
  }
  return fmt;
}

function getZoneParts(date, timeZone) {
  const parts = getPartsFormatter(timeZone).formatToParts(date);
  const out = {};
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i];
    if (p.type !== "literal") {
      out[p.type] = Number(p.value);
    }
  }
  // Guard against rare ICU 24:00 representation
  if (out.hour === 24) out.hour = 0;
  return out;
}

/**
 * Return the timezone's UTC offset in minutes at `date` (east of UTC is positive, e.g. IST = +330, PDT = -420).
 */
function getOffsetMinutes(date, timeZone) {
  const p = getZoneParts(date, timeZone);
  const asUtcMs = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  const truncatedDateMs = Math.floor(date.getTime() / 1000) * 1000;
  return Math.round((asUtcMs - truncatedDateMs) / 60000);
}

/**
 * Convert a wall-clock date/time in `timeZone` into a UTC Date.
 */
function wallClockToDate({ year, month, day, hour, minute, second = 0 }, timeZone) {
  const guess = Date.UTC(year, month - 1, day, hour, minute, second);
  const offset1 = getOffsetMinutes(new Date(guess), timeZone);
  let candidate = guess - offset1 * 60000;
  const offset2 = getOffsetMinutes(new Date(candidate), timeZone);
  if (offset2 !== offset1) {
    candidate = guess - offset2 * 60000;
  }
  return new Date(candidate);
}

function getZoneAbbrev(date, timeZone) {
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone,
      timeZoneName: "short",
    }).formatToParts(date);
    for (let i = 0; i < parts.length; i++) {
      if (parts[i].type === "timeZoneName") {
        const val = parts[i].value;
        if (val === "GMT+0" || val === "GMT-0") return "GMT";
        if (val.startsWith("GMT+") || val.startsWith("GMT-")) {
          return "UTC" + val.slice(3);
        }
        return val;
      }
    }
  } catch (_) {
    // Fallback to UTC offset below
  }
  return formatUtcOffset(getOffsetMinutes(date, timeZone));
}

function pad2(n) {
  return n < 10 ? "0" + n : String(n);
}

function formatUtcOffset(offsetMinutes) {
  if (offsetMinutes === 0) return "UTC";
  const sign = offsetMinutes > 0 ? "+" : "-";
  const abs = Math.abs(offsetMinutes);
  const h = Math.floor(abs / 60);
  const m = abs % 60;
  return m === 0 ? `UTC${sign}${h}` : `UTC${sign}${h}:${pad2(m)}`;
}

function formatTime(date, timeZone, timeFormat) {
  const showSeconds = timeFormat === "12h_sec" || timeFormat === "24h_sec";
  const use24h = timeFormat === "24h" || timeFormat === "24h_sec";
  const opts = {
    timeZone,
    hour: use24h ? "2-digit" : "numeric",
    minute: "2-digit",
    hour12: !use24h,
  };
  if (use24h) {
    opts.hourCycle = "h23";
  }
  if (showSeconds) {
    opts.second = "2-digit";
  }
  return new Intl.DateTimeFormat("en-US", opts).format(date);
}

function formatShortDate(date, timeZone) {
  return new Intl.DateTimeFormat("en-US", {
    timeZone,
    weekday: "short",
    month: "short",
    day: "numeric",
  }).format(date);
}

function formatIso8601(date, timeZone) {
  const p = getZoneParts(date, timeZone);
  const offsetMin = getOffsetMinutes(date, timeZone);
  let offsetStr = "Z";
  if (offsetMin !== 0) {
    const sign = offsetMin > 0 ? "+" : "-";
    const abs = Math.abs(offsetMin);
    offsetStr = `${sign}${pad2(Math.floor(abs / 60))}:${pad2(abs % 60)}`;
  }
  return `${p.year}-${pad2(p.month)}-${pad2(p.day)}T${pad2(p.hour)}:${pad2(p.minute)}:${pad2(p.second)}${offsetStr}`;
}

/**
 * Difference in calendar days between `targetTz` and `baseTz` at `date` (e.g. +1, 0, -1).
 */
function getCalendarDayDelta(date, targetTz, baseTz) {
  const t = getZoneParts(date, targetTz);
  const b = getZoneParts(date, baseTz);
  const tDay = Date.UTC(t.year, t.month - 1, t.day);
  const bDay = Date.UTC(b.year, b.month - 1, b.day);
  return Math.round((tDay - bDay) / 86400000);
}

function formatRelativeDiff(diffMinutes, baseLabel) {
  if (diffMinutes === 0) return `same as ${baseLabel}`;
  const abs = Math.abs(diffMinutes);
  const h = Math.floor(abs / 60);
  const m = abs % 60;
  const parts = [];
  if (h > 0) parts.push(`${h}h`);
  if (m > 0) parts.push(`${m}m`);
  const dir = diffMinutes > 0 ? "ahead of" : "behind";
  return `${parts.join(" ")} ${dir} ${baseLabel}`;
}

function getDayPhaseIcon(date, timeZone) {
  const { hour } = getZoneParts(date, timeZone);
  if (hour >= 5 && hour < 8) return "icons/dawn.png";
  if (hour >= 8 && hour < 18) return "icons/day.png";
  if (hour >= 18 && hour < 21) return "icons/dusk.png";
  return "icons/night.png";
}

function countryCodeToFlag(cc) {
  if (!cc || cc.length !== 2) return "🌐";
  const upper = cc.toUpperCase();
  const a = upper.charCodeAt(0);
  const b = upper.charCodeAt(1);
  if (a < 65 || a > 90 || b < 65 || b > 90) return "🌐";
  return String.fromCodePoint(0x1f1e6 + (a - 65), 0x1f1e6 + (b - 65));
}

function getLocalTimeZone() {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}

function isValidTimeZone(tz) {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch (_) {
    return false;
  }
}

const tzModule = {
  getZoneParts,
  getOffsetMinutes,
  wallClockToDate,
  getZoneAbbrev,
  formatUtcOffset,
  formatTime,
  formatShortDate,
  formatIso8601,
  getCalendarDayDelta,
  formatRelativeDiff,
  getDayPhaseIcon,
  countryCodeToFlag,
  getLocalTimeZone,
  isValidTimeZone,
};

if (typeof module !== "undefined" && module.exports) {
  module.exports = tzModule;
}
