#!/usr/bin/env osascript -l JavaScript
"use strict";

ObjC.import("Foundation");

function readUtf8(filePath) {
  const nsStr = $.NSString.stringWithContentsOfFileEncodingError(
    filePath,
    $.NSUTF8StringEncoding,
    null
  );
  if (!nsStr || nsStr.isNil()) {
    throw new Error("Could not read file: " + filePath);
  }
  return nsStr.js;
}

function loadCommonJs(filePath) {
  const src = readUtf8(filePath);
  const mod = { exports: {} };
  const fn = new Function("module", "exports", src);
  fn(mod, mod.exports);
  return mod.exports;
}

function getEnv(name, fallback) {
  const env = $.NSProcessInfo.processInfo.environment;
  const val = env.objectForKey(name);
  if (!val || val.isNil()) return fallback;
  return val.js;
}

function run(argv) {
  const query = argv && argv.length > 0 ? argv.join(" ") : "";
  const cwd = $.NSFileManager.defaultManager.currentDirectoryPath.js;

  const tz = loadCommonJs(cwd + "/lib/tz.js");
  const places = loadCommonJs(cwd + "/lib/places.js");
  const parser = loadCommonJs(cwd + "/lib/parser.js");
  const alfred = loadCommonJs(cwd + "/lib/alfred.js");

  const rawData = JSON.parse(readUtf8(cwd + "/data/places.json"));
  const placeIndex = places.createPlaceIndex(rawData);

  const config = {
    pinnedLocations: getEnv("pinned_locations", ""),
    timeFormat: getEnv("time_format", "12h"),
    liveRefresh: getEnv("live_refresh", "1") !== "0",
  };

  const result = alfred.evaluateQuery(query, new Date(), config, placeIndex, {
    tz,
    parser,
  });

  return JSON.stringify(result);
}
