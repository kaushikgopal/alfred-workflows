import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

interface Place {
  label: string;
  countryCode: string;
  countryName: string;
  tz: string;
  kind: string;
}

interface PlaceIndex {
  searchPlaces(rawQuery: string, limit?: number): Place[];
  resolvePlace(rawQuery: string): Place | null;
  normalizeQuery(text: string): string;
}

interface AlfredMod {
  valid: boolean;
  arg: string;
  subtitle: string;
}

interface AlfredItem {
  title: string;
  subtitle: string;
  arg?: string;
  valid: boolean;
  icon: { path: string };
  text?: { copy: string; largetype: string };
  mods?: {
    cmd?: AlfredMod;
    alt?: AlfredMod;
    ctrl?: AlfredMod;
  };
}

interface AlfredResponse {
  items: AlfredItem[];
  rerun?: number;
}

interface WorldTimeConfig {
  localTz: string;
  timeFormat: "12h" | "24h" | "12h_sec" | "24h_sec";
  pinnedLocations: string;
  liveRefresh: boolean;
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const workflowDir = path.resolve(__dirname, "../workflow");
function loadCommonJs<T>(filePath: string): T {
  const src = fs.readFileSync(filePath, "utf8");
  const mod: { exports: unknown } = { exports: {} };
  const fn = new Function("module", "exports", src);
  fn(mod, mod.exports);
  return mod.exports as T;
}

const tz = loadCommonJs<unknown>(path.join(workflowDir, "lib/tz.js"));
const places = loadCommonJs<{
  createPlaceIndex(raw: unknown): PlaceIndex;
}>(path.join(workflowDir, "lib/places.js"));
const parser = loadCommonJs<{
  parseQuery(rawInput: string): Record<string, unknown>;
}>(path.join(workflowDir, "lib/parser.js"));
const alfred = loadCommonJs<{
  evaluateQuery(
    rawQuery: string,
    nowDate: Date,
    config: WorldTimeConfig,
    placeIndex: PlaceIndex,
    deps: { tz: unknown; parser: unknown }
  ): AlfredResponse;
}>(path.join(workflowDir, "lib/alfred.js"));

const rawData: unknown = JSON.parse(
  fs.readFileSync(path.join(workflowDir, "data/places.json"), "utf8")
);
const placeIndex = places.createPlaceIndex(rawData);

const deps = { tz, parser };

// Fixed reference instants:
// Winter (Jan 15, 2026 20:00 UTC -> 12:00 PM PST in SF, 1:30 AM Jan 16 IST in Chennai)
const WINTER_NOW = new Date("2026-01-15T20:00:00Z");
// Summer (Jul 15, 2026 19:00 UTC -> 12:00 PM PDT in SF, 12:30 AM Jul 16 IST in Chennai)
const SUMMER_NOW = new Date("2026-07-15T19:00:00Z");

const baseConfig: WorldTimeConfig = {
  localTz: "America/Los_Angeles",
  timeFormat: "12h",
  pinnedLocations: "San Francisco, New York, London, India, Tokyo, UTC",
  liveRefresh: true,
};

test("places: resolves cities, countries, airports, aliases, diacritics, and IANA", () => {
  assert.equal(placeIndex.resolvePlace("chennai")?.tz, "Asia/Kolkata");
  assert.equal(placeIndex.resolvePlace("india")?.tz, "Asia/Kolkata");
  assert.equal(placeIndex.resolvePlace("beijing")?.tz, "Asia/Shanghai");
  assert.equal(placeIndex.resolvePlace("sao paulo")?.tz, "America/Sao_Paulo");
  assert.equal(placeIndex.resolvePlace("sf")?.tz, "America/Los_Angeles");
  assert.equal(placeIndex.resolvePlace("ldn")?.tz, "Europe/London");
  assert.equal(placeIndex.resolvePlace("jfk")?.tz, "America/New_York");
  assert.equal(placeIndex.resolvePlace("maa")?.tz, "Asia/Kolkata");
  assert.equal(placeIndex.resolvePlace("ist")?.tz, "Asia/Kolkata");
  assert.equal(placeIndex.resolvePlace("Asia/Kolkata")?.tz, "Asia/Kolkata");
  assert.equal(placeIndex.resolvePlace("madras")?.tz, "Asia/Kolkata");
  assert.equal(placeIndex.resolvePlace("peking")?.tz, "Asia/Shanghai");
  assert.equal(placeIndex.resolvePlace("tamil nadu")?.tz, "Asia/Kolkata");
});

test("places: prefix typing finds Chennai and Beijing immediately", () => {
  const chen = placeIndex.searchPlaces("chen", 5);
  assert.ok(chen.some((p) => p.label.startsWith("Chennai")));

  const bei = placeIndex.searchPlaces("bei", 5);
  assert.ok(bei.some((p) => p.label.startsWith("Beijing")));
});

test("places: multi-zone country expands major zones", () => {
  const us = placeIndex.searchPlaces("united states", 6);
  const zones = new Set(us.map((p) => p.tz));
  assert.ok(zones.has("America/New_York"));
  assert.ok(zones.has("America/Los_Angeles"));
  assert.ok(zones.has("America/Chicago"));
});

test("places: country-qualified city disambiguates Hyderabad", () => {
  const pk = placeIndex.resolvePlace("hyderabad pakistan");
  assert.equal(pk?.countryCode, "PK");
  assert.equal(pk?.tz, "Asia/Karachi");

  const ind = placeIndex.resolvePlace("hyderabad india");
  assert.equal(ind?.countryCode, "IN");
  assert.equal(ind?.tz, "Asia/Kolkata");
});

test("parser: parses all query forms cleanly", () => {
  assert.deepEqual(parser.parseQuery(""), { kind: "pinned" });
  assert.deepEqual(parser.parseQuery("in chennai"), { kind: "place", placeQuery: "chennai" });
  assert.deepEqual(parser.parseQuery("now in beijing"), { kind: "place", placeQuery: "now in beijing" });
  assert.deepEqual(parser.parseQuery("time in india"), { kind: "place", placeQuery: "india" });

  assert.deepEqual(parser.parseQuery("+2h30m"), {
    kind: "offset",
    deltaMs: 150 * 60000,
    placeQuery: null,
  });
  assert.deepEqual(parser.parseQuery("in 4 hours in chennai"), {
    kind: "offset",
    deltaMs: 4 * 3600000,
    placeQuery: "chennai",
  });
  assert.deepEqual(parser.parseQuery("tokyo + 4 hours"), {
    kind: "offset",
    deltaMs: 4 * 3600000,
    placeQuery: "tokyo",
  });
  assert.deepEqual(parser.parseQuery("3 hours ago in london"), {
    kind: "offset",
    deltaMs: -3 * 3600000,
    placeQuery: "london",
  });

  assert.deepEqual(parser.parseQuery("diff paris"), {
    kind: "diff",
    fromQuery: null,
    toQuery: "paris",
  });
  assert.deepEqual(parser.parseQuery("diff london to sf"), {
    kind: "diff",
    fromQuery: "london",
    toQuery: "sf",
  });

  assert.deepEqual(parser.parseQuery("5pm ldn in sf"), {
    kind: "convert",
    hour: 17,
    minute: 0,
    second: 0,
    dateSpec: null,
    fromQuery: "ldn",
    toQuery: "sf",
  });
  assert.deepEqual(parser.parseQuery("5pm in chennai"), {
    kind: "convert",
    hour: 17,
    minute: 0,
    second: 0,
    dateSpec: null,
    fromQuery: null,
    toQuery: "chennai",
  });
  assert.deepEqual(parser.parseQuery("14:30 chennai"), {
    kind: "convert",
    hour: 14,
    minute: 30,
    second: 0,
    dateSpec: null,
    fromQuery: "chennai",
    toQuery: null,
  });
  assert.deepEqual(parser.parseQuery("5pm tomorrow in tokyo"), {
    kind: "convert",
    hour: 17,
    minute: 0,
    second: 0,
    dateSpec: { kind: "relative", dayOffset: 1 },
    fromQuery: null,
    toQuery: "tokyo",
  });

  const iso = parser.parseQuery("2026-03-15T14:30:00Z in chennai");
  assert.equal(iso.kind, "instant");
  assert.equal(iso.toQuery, "chennai");
  assert.equal((iso.date as Date).toISOString(), "2026-03-15T14:30:00.000Z");

  const epoch = parser.parseQuery("1700000000 in tokyo");
  assert.equal(epoch.kind, "instant");
  assert.equal(epoch.toQuery, "tokyo");
  assert.equal((epoch.date as Date).getTime(), 1700000000 * 1000);
});

test("alfred: empty query returns local + pinned with live rerun", () => {
  const res = alfred.evaluateQuery("", WINTER_NOW, baseConfig, placeIndex, deps);
  assert.equal(res.rerun, 10);
  assert.equal(res.items.length, 7);
  assert.match(res.items[0].title, /12:00 PM · Los Angeles/);
  assert.equal(res.items[0].icon.path, "icons/home.png");
});

test("alfred: 'in chennai' shows accurate IST time and next-day badge", () => {
  const res = alfred.evaluateQuery("in chennai", WINTER_NOW, baseConfig, placeIndex, deps);
  assert.equal(res.rerun, 10);
  assert.equal(res.items[0].title, "1:30 AM (+1d) · Chennai, India");
  assert.match(res.items[0].subtitle, /13h 30m ahead of local/);
  assert.equal(res.items[0].icon.path, "icons/night.png");
});

test("alfred: DST shift changes SF-Chennai offset between winter (13h30m) and summer (12h30m)", () => {
  const winter = alfred.evaluateQuery("in chennai", WINTER_NOW, baseConfig, placeIndex, deps);
  const summer = alfred.evaluateQuery("in chennai", SUMMER_NOW, baseConfig, placeIndex, deps);
  assert.match(winter.items[0].subtitle, /13h 30m ahead of local/);
  assert.match(summer.items[0].subtitle, /12h 30m ahead of local/);
  assert.equal(summer.items[0].title, "12:30 AM (+1d) · Chennai, India");
});

test("alfred: Raycast-style conversion '5pm ldn in sf' and '5pm in chennai'", () => {
  const ldnToSf = alfred.evaluateQuery("5pm ldn in sf", WINTER_NOW, baseConfig, placeIndex, deps);
  assert.equal(ldnToSf.rerun, undefined);
  assert.equal(ldnToSf.items[0].title, "5:00 PM London → 9:00 AM San Francisco");
  assert.equal(ldnToSf.items[0].icon.path, "icons/convert.png");
  assert.equal(ldnToSf.items[0].mods?.cmd?.arg, "9:00 AM");

  const localToChennai = alfred.evaluateQuery("5pm in chennai", SUMMER_NOW, baseConfig, placeIndex, deps);
  assert.equal(localToChennai.items[0].title, "5:00 PM Los Angeles → 5:30 AM (+1d) Chennai");
});

test("alfred: '5pm chennai' converts Chennai time to local time", () => {
  const res = alfred.evaluateQuery("5pm chennai", SUMMER_NOW, baseConfig, placeIndex, deps);
  assert.equal(res.items[0].title, "5:00 PM Chennai → 4:30 AM Los Angeles");
});

test("alfred: 'diff sf to chennai' computes exact difference", () => {
  const res = alfred.evaluateQuery("diff sf to chennai", SUMMER_NOW, baseConfig, placeIndex, deps);
  assert.equal(res.items[0].title, "Chennai is 12h 30m ahead of San Francisco");
  assert.equal(res.items[0].icon.path, "icons/diff.png");
});

test("alfred: 'in 4 hours in chennai' and 'tokyo + 4 hours' apply offset", () => {
  const res1 = alfred.evaluateQuery("in 4 hours in chennai", WINTER_NOW, baseConfig, placeIndex, deps);
  assert.equal(res1.items[0].title, "5:30 AM (+1d) · Chennai, India");

  const res2 = alfred.evaluateQuery("tokyo + 4 hours", WINTER_NOW, baseConfig, placeIndex, deps);
  assert.equal(res2.items[0].title, "9:00 AM (+1d) · Tokyo, Japan");
});

test("alfred: 24h_sec time format enables 1-second rerun and 24-hour clock", () => {
  const cfg: WorldTimeConfig = { ...baseConfig, timeFormat: "24h_sec" };
  const res = alfred.evaluateQuery("in beijing", WINTER_NOW, cfg, placeIndex, deps);
  assert.equal(res.rerun, 1);
  assert.equal(res.items[0].title, "04:00:00 (+1d) · Beijing, China");
});

test("alfred: unknown location returns helpful non-valid fallback item", () => {
  const res = alfred.evaluateQuery("in atlantisxyz", WINTER_NOW, baseConfig, placeIndex, deps);
  assert.equal(res.items.length, 1);
  assert.equal(res.items[0].valid, false);
  assert.match(res.items[0].title, /No location found/);
});

test("e2e JXA: ./world_time.js runs via macOS osascript and returns valid Alfred JSON", () => {
  const queries = ["", "in chennai", "in india", "in beijing", "5pm ldn in sf", "diff paris"];
  for (const q of queries) {
    const out = execFileSync("./world_time.js", q ? [q] : [], {
      cwd: workflowDir,
      encoding: "utf8",
    });
    const parsed = JSON.parse(out) as AlfredResponse;
    assert.ok(Array.isArray(parsed.items), `items array missing for query: ${q}`);
    assert.ok(parsed.items.length > 0, `no items returned for query: ${q}`);
    assert.ok(parsed.items[0].title, `missing title for query: ${q}`);
  }
});
