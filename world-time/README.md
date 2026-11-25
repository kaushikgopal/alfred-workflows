# World Time

Instant offline world clock and Raycast-style timezone converter for Alfred 6.

Runs natively on macOS JavaScript (JXA) with **zero external dependencies** — no Python, Node.js, Homebrew, or Xcode Command Line Tools required.

## Install

1. Double-click `World Time.alfredworkflow` (or run `open "world-time/World Time.alfredworkflow"`).
2. Import into Alfred.
3. Optional: open **Configure Workflow** in Alfred to change the trigger keyword (default: `now`), pinned locations, 12h/24h/seconds format, or live refresh.

## Usage

| Query | Result |
| --- | --- |
| `now` | Local time + your pinned locations |
| `now in chennai` / `now chennai` | Current time in Chennai (12,900+ cities offline) |
| `now in india` / `now in beijing` | Countries, states, regions, and non-IANA cities |
| `now in sf` / `now in jfk` / `now in ist` | Nicknames, airport IATA codes, and timezone codes |
| `now 5pm ldn in sf` | Convert 5:00 PM London to San Francisco |
| `now 14:30 tokyo to chennai` | 24-hour conversion between any two places |
| `now 5pm in chennai` | Convert 5:00 PM local time to Chennai |
| `now 5pm chennai` | Convert 5:00 PM Chennai time to your local time |
| `now 5pm tomorrow in tokyo` | Convert on a relative or specific date (`2026-07-01`, `Dec 25`) |
| `now +2h30m` / `now in 4 hours in chennai` | Relative time offsets |
| `now tokyo + 4 hours` | Add or subtract time on a city's clock |
| `now diff paris` / `now diff sf to chennai` | Time difference between locations |
| `now 2026-03-15T14:30:00Z in chennai` | ISO 8601 timestamp lookup |
| `now 1700000000 in tokyo` | Unix epoch timestamp lookup |

### Actions

- `↩` Copy formatted summary (`12:30 PM IST · Chennai, India (Tue, Apr 21)`)
- `⌘↩` Copy time only (`12:30 PM`)
- `⌥↩` Copy ISO 8601 timestamp
- `⌃↩` Copy Unix timestamp
- `⌘L` Display in Alfred Large Type

## Development & Validation

```fish
# Run unit + end-to-end JXA tests
node --test world-time/tests/world_time.test.ts

# Validate plist
plutil -lint world-time/workflow/info.plist

# Rebuild offline place database from GeoNames (optional)
python3 world-time/scripts/build-places.py

# Re-render PNG icons (optional)
swift world-time/scripts/render-icons.swift

# Package importable .alfredworkflow archive
./scripts/pack.sh world-time "World Time.alfredworkflow"
```

Place data is derived from [GeoNames](https://www.geonames.org/) (`cities15000` and `countryInfo`, CC BY 4.0).
