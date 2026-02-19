# WeatherTool

Fetches current conditions and forecasts from **wttr.in** (primary) with automatic failover to **open-meteo**. A single tool call returns all weather data the LLM needs — no chaining required.

## Operation: `get`

| Parameter  | Type   | Required | Default    | Description                                       |
|------------|--------|----------|------------|---------------------------------------------------|
| `location` | string | yes      | —          | City name, ZIP code, or "City, State/Country"     |
| `days`     | number | no       | `3`        | Forecast days to return (1–10)                    |
| `units`    | string | no       | `imperial` | `"imperial"` (°F, mph, in) or `"metric"` (°C, km/h, mm) |

### Source selection
- **days ≤ 3**: tries **wttr.in** first, falls back to **open-meteo** on failure.
- **days > 3**: goes directly to **open-meteo** (wttr.in only provides 3 days).

## Response

```json
{
  "success": true,
  "source": "wttr.in",
  "location": "Seattle, WA",
  "days_returned": 3,
  "units": {
    "temp": "°F",
    "speed": "mph",
    "precip": "in",
    "visibility": "mi"
  },
  "current": {
    "temp": 52,
    "feels_like": 48,
    "condition": "Partly cloudy",
    "humidity": 78,
    "wind_speed": 9,
    "wind_dir": "SW",
    "wind_deg": 225,
    "wind_gusts": 14,
    "visibility": 10,
    "uv_index": 2,
    "cloud_cover": 40,
    "pressure_mb": 1012
  },
  "daily": [
    {
      "date": "2024-01-15",
      "sunrise": "7:52 AM",
      "sunset": "4:36 PM",
      "high": 54,
      "low": 44,
      "condition": "Light rain",
      "precip": 0.18,
      "precip_chance": 65,
      "snow_chance": 0,
      "wind_max": 14,
      "wind_gusts_max": 22,
      "uv_index": 1,
      "sun_hours": 1.4
    }
  ],
  "hourly": [
    {
      "time": "2024-01-15T09:00",
      "temp": 49,
      "feels_like": 46,
      "condition": "Light rain",
      "wind_speed": 11,
      "wind_dir": "SW",
      "wind_deg": 220,
      "wind_gusts": 18,
      "precip": 0.04,
      "precip_chance": 70,
      "snow_chance": 0,
      "humidity": 85,
      "cloud_cover": 90,
      "visibility": 7,
      "uv_index": 0,
      "pressure_mb": 1010
    }
  ]
}
```

## Location format guidance

- **US locations — always prefer ZIP codes.** ZIP codes are resolved correctly by both sources and avoid city-name ambiguity. If the user's address or ZIP is known from memory, use it.
  - ✅ `"49286"` (ZIP)
  - ✅ `"London"` (unambiguous international city)
  - ⚠️  `"Tecumseh, MI"` — will work but requires an extra resolution step; prefer the ZIP.
- For non-US locations, a city name or `"City, Country"` string is fine.

## Usage examples

```json
{ "op": "get", "location": "49286" }
{ "op": "get", "location": "London", "units": "metric" }
{ "op": "get", "location": "10001", "days": 7 }
{ "op": "get", "location": "90210", "days": 10 }
{ "op": "get", "location": "Paris, France" }
```

## Notes
- `current` conditions come from wttr.in when available; open-meteo derives them from the first forecast hour.
- Hourly slots are 3-hour intervals (wttr.in) or 1-hour intervals (open-meteo).
- `wind_gusts` / `wind_gusts_max` may be `null` if the source did not report them.
- All precipitation values are cumulative per hour/day in the chosen unit.
