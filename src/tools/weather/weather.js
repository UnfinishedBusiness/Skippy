const https = require('https');
const http  = require('http');
const path  = require('path');
const fs    = require('fs');
const { URL } = require('url');
const Tool  = require('../tool_prototype');

// WMO weather code → description (used for open-meteo)
const WMO_CODES = {
  0: 'Clear sky',
  1: 'Mainly clear', 2: 'Partly cloudy', 3: 'Overcast',
  45: 'Foggy', 48: 'Icy fog',
  51: 'Light drizzle', 53: 'Drizzle', 55: 'Heavy drizzle',
  56: 'Light freezing drizzle', 57: 'Heavy freezing drizzle',
  61: 'Light rain', 63: 'Rain', 65: 'Heavy rain',
  66: 'Light freezing rain', 67: 'Heavy freezing rain',
  71: 'Light snow', 73: 'Snow', 75: 'Heavy snow',
  77: 'Snow grains',
  80: 'Light showers', 81: 'Showers', 82: 'Heavy showers',
  85: 'Light snow showers', 86: 'Heavy snow showers',
  95: 'Thunderstorm',
  96: 'Thunderstorm with light hail', 99: 'Thunderstorm with heavy hail',
};

function wmoDesc(code) {
  return WMO_CODES[code] ?? `Code ${code}`;
}

// Simple HTTPS/HTTP GET → resolves with parsed JSON or rejects
function fetchJson(urlStr, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    let urlObj;
    try { urlObj = new URL(urlStr); } catch (e) { return reject(e); }

    const lib = urlObj.protocol === 'https:' ? https : http;
    const req = lib.get(urlStr, { headers: { 'User-Agent': 'Skippy/1.0' } }, (res) => {
      if (res.statusCode < 200 || res.statusCode >= 300) {
        res.resume();
        return reject(new Error(`HTTP ${res.statusCode} from ${urlStr}`));
      }
      let raw = '';
      res.on('data', c => { raw += c; });
      res.on('end', () => {
        try { resolve(JSON.parse(raw)); }
        catch (e) { reject(new Error(`JSON parse error: ${e.message}`)); }
      });
      res.on('error', reject);
    });

    req.setTimeout(timeoutMs, () => {
      req.destroy();
      reject(new Error(`Request timed out: ${urlStr}`));
    });
    req.on('error', reject);
  });
}

// ---- Normalisation helpers -----------------------------------------------

function pad2(n) { return String(n).padStart(2, '0'); }

// Convert wttr.in time field ("0", "100" … "2300") to HH:MM
function wttrTimeToHHMM(timeStr) {
  const n = parseInt(timeStr, 10);
  const h = Math.floor(n / 100);
  const m = n % 100;
  return `${pad2(h)}:${pad2(m)}`;
}

// Build ISO datetime string from date ("2024-01-15") + wttr time ("900")
function wttrDatetime(dateStr, timeStr) {
  return `${dateStr}T${wttrTimeToHHMM(timeStr)}`;
}

// Parse wttr.in j1 response → normalised output
function normalizeWttr(data, days, imperial) {
  const cur = data.current_condition?.[0] ?? {};

  const temp       = imperial ? num(cur.temp_F)       : num(cur.temp_C);
  const feelsLike  = imperial ? num(cur.FeelsLikeF)   : num(cur.FeelsLikeC);
  const windSpeed  = imperial ? num(cur.windspeedMiles): num(cur.windspeedKmph);

  const current = {
    temp,
    feels_like:  feelsLike,
    condition:   cur.weatherDesc?.[0]?.value ?? '',
    humidity:    num(cur.humidity),
    wind_speed:  windSpeed,
    wind_dir:    cur.winddir16Point ?? '',
    wind_deg:    num(cur.winddirDegree),
    visibility:  imperial ? num(cur.visibilityMiles) : num(cur.visibility),
    uv_index:    num(cur.uvIndex),
    cloud_cover: num(cur.cloudcover),
    pressure_mb: num(cur.pressure),
  };

  const dailySlice = (data.weather ?? []).slice(0, days);

  const daily = dailySlice.map(d => {
    const astro = d.astronomy?.[0] ?? {};
    return {
      date:         d.date,
      sunrise:      astro.sunrise ?? '',
      sunset:       astro.sunset  ?? '',
      high:         imperial ? num(d.maxtempF) : num(d.maxtempC),
      low:          imperial ? num(d.mintempF) : num(d.mintempC),
      condition:    d.hourly?.[4]?.weatherDesc?.[0]?.value ?? '',
      precip:       imperial ? num(d.hourly?.reduce((s,h) => s + parseFloat(h.precipInches||0), 0).toFixed(2))
                             : num(d.hourly?.reduce((s,h) => s + parseFloat(h.precipMM||0), 0).toFixed(1)),
      precip_chance: num(d.hourly?.reduce((s,h) => Math.max(s, parseFloat(h.chanceofrain||0)), 0)),
      snow_chance:   num(d.hourly?.reduce((s,h) => Math.max(s, parseFloat(h.chanceofsnow||0)), 0)),
      wind_max:     imperial ? num(d.hourly?.reduce((s,h) => Math.max(s, parseFloat(h.windspeedMiles||0)), 0))
                             : num(d.hourly?.reduce((s,h) => Math.max(s, parseFloat(h.windspeedKmph||0)), 0)),
      wind_gusts_max: imperial ? num(d.hourly?.reduce((s,h) => Math.max(s, parseFloat(h.WindGustMiles||0)), 0))
                               : num(d.hourly?.reduce((s,h) => Math.max(s, parseFloat(h.WindGustKmph||0)), 0)),
      uv_index:     num(d.uvIndex),
      sun_hours:    parseFloat(d.sunHour ?? 0),
    };
  });

  const hourly = [];
  for (const d of dailySlice) {
    for (const h of (d.hourly ?? [])) {
      hourly.push({
        time:          wttrDatetime(d.date, h.time),
        temp:          imperial ? num(h.tempF)       : num(h.tempC),
        feels_like:    imperial ? num(h.FeelsLikeF)  : num(h.FeelsLikeC),
        condition:     h.weatherDesc?.[0]?.value ?? '',
        wind_speed:    imperial ? num(h.windspeedMiles) : num(h.windspeedKmph),
        wind_dir:      h.winddir16Point ?? '',
        wind_deg:      num(h.winddirDegree),
        wind_gusts:    imperial ? num(h.WindGustMiles)  : num(h.WindGustKmph),
        precip:        imperial ? num(h.precipInches) : num(h.precipMM),
        precip_chance: num(h.chanceofrain),
        snow_chance:   num(h.chanceofsnow),
        humidity:      num(h.humidity),
        cloud_cover:   num(h.cloudcover),
        visibility:    imperial ? num(h.visibilityMiles) : num(h.visibility),
        uv_index:      num(h.uvIndex),
        pressure_mb:   num(h.pressure),
      });
    }
  }

  return { current, daily, hourly };
}

// Parse open-meteo response → normalised output
function normalizeOpenMeteo(forecastData, geoName, days, imperial) {
  const d = forecastData;
  const daily  = d.daily  ?? {};
  const hourly = d.hourly ?? {};

  const tempUnit  = imperial ? '°F'  : '°C';
  const speedUnit = imperial ? 'mph' : 'km/h';
  const precipUnit= imperial ? 'in'  : 'mm';

  // Daily
  const dailyCount = Math.min(days, (daily.time ?? []).length);
  const dailyOut = [];
  for (let i = 0; i < dailyCount; i++) {
    dailyOut.push({
      date:          daily.time[i],
      sunrise:       daily.sunrise?.[i] ?? '',
      sunset:        daily.sunset?.[i]  ?? '',
      high:          daily.temperature_2m_max?.[i]       ?? null,
      low:           daily.temperature_2m_min?.[i]       ?? null,
      feels_like_max:daily.apparent_temperature_max?.[i] ?? null,
      feels_like_min:daily.apparent_temperature_min?.[i] ?? null,
      condition:     wmoDesc(daily.weathercode?.[i]),
      precip:        daily.precipitation_sum?.[i]        ?? null,
      precip_chance: daily.precipitation_probability_max?.[i] ?? null,
      snow:          daily.snowfall_sum?.[i]             ?? null,
      wind_max:      daily.windspeed_10m_max?.[i]        ?? null,
      wind_gusts_max:daily.windgusts_10m_max?.[i]        ?? null,
      wind_dir_dom:  daily.winddirection_10m_dominant?.[i] ?? null,
      uv_index:      daily.uv_index_max?.[i]             ?? null,
    });
  }

  // Hourly — only include hours for the requested days
  const cutoffDate = dailyOut.length > 0
    ? dailyOut[dailyOut.length - 1].date
    : null;
  const hourlyOut = [];
  for (let i = 0; i < (hourly.time ?? []).length; i++) {
    const t = hourly.time[i];
    if (cutoffDate && t.slice(0, 10) > cutoffDate) break;
    hourlyOut.push({
      time:          t,
      temp:          hourly.temperature_2m?.[i]           ?? null,
      feels_like:    hourly.apparent_temperature?.[i]     ?? null,
      condition:     wmoDesc(hourly.weathercode?.[i]),
      wind_speed:    hourly.windspeed_10m?.[i]            ?? null,
      wind_dir:      null, // open-meteo hourly dir not requested by default
      wind_deg:      hourly.winddirection_10m?.[i]        ?? null,
      wind_gusts:    hourly.windgusts_10m?.[i]            ?? null,
      precip:        hourly.precipitation?.[i]            ?? null,
      precip_chance: hourly.precipitation_probability?.[i]?? null,
      snow:          hourly.snowfall?.[i]                 ?? null,
      humidity:      hourly.relative_humidity_2m?.[i]     ?? null,
      cloud_cover:   hourly.cloudcover?.[i]               ?? null,
      visibility:    hourly.visibility?.[i]               ?? null,
      uv_index:      hourly.uv_index?.[i]                 ?? null,
      pressure_mb:   hourly.surface_pressure?.[i]         ?? null,
    });
  }

  return { current: null, daily: dailyOut, hourly: hourlyOut };
}

function num(v) {
  const n = parseFloat(v);
  return isNaN(n) ? null : n;
}

// ---- Tool -------------------------------------------------------------------

class WeatherTool extends Tool {
  getContext() {
    const registryPath = path.join(__dirname, 'registry.md');
    try { return fs.readFileSync(registryPath, 'utf8'); } catch { return ''; }
  }

  async run(args) {
    const logger = global.logger || console;
    let op, params = {};

    if (Array.isArray(args)) {
      [op, ...params] = args;
      params = params[0] || {};
    } else if (args && typeof args === 'object') {
      ({ op, ...params } = args);
    } else {
      return { success: false, error: 'Invalid arguments' };
    }

    if (op !== 'get') {
      return { success: false, error: `Unknown operation: ${op}. Only "get" is supported.` };
    }

    const { location, days: daysRaw, units } = params;
    if (!location) return { success: false, error: 'Missing required parameter: location' };

    const days     = Math.min(Math.max(parseInt(daysRaw ?? 3, 10), 1), 10);
    const imperial = (units ?? 'imperial') !== 'metric';
    const unitLabel = imperial ? 'imperial' : 'metric';

    logger.info(`[WeatherTool] Fetching weather for "${location}", days=${days}, units=${unitLabel}`);

    // Strategy: wttr.in for short forecasts (≤3 days), open-meteo for longer
    // Always try wttr.in first and fall through on failure.
    let result = null;
    let source  = null;

    if (days <= 3) {
      try {
        const raw = await this._fetchWttr(location);
        result = normalizeWttr(raw, days, imperial);
        source = 'wttr.in';
        logger.info(`[WeatherTool] wttr.in succeeded for "${location}"`);
      } catch (e) {
        logger.warn(`[WeatherTool] wttr.in failed (${e.message}), falling back to open-meteo`);
      }
    }

    if (!result) {
      try {
        result = await this._fetchOpenMeteo(location, days, imperial);
        source = 'open-meteo';
        logger.info(`[WeatherTool] open-meteo succeeded for "${location}"`);
      } catch (e) {
        logger.error(`[WeatherTool] open-meteo also failed: ${e.message}`);
        return { success: false, error: `Weather fetch failed: ${e.message}` };
      }
    }

    const tempUnit   = imperial ? '°F'  : '°C';
    const speedUnit  = imperial ? 'mph' : 'km/h';
    const precipUnit = imperial ? 'in'  : 'mm';
    const visUnit    = imperial ? 'mi'  : 'km';

    return {
      success:  true,
      source,
      location,
      days_returned: result.daily.length,
      units: {
        temp:   tempUnit,
        speed:  speedUnit,
        precip: precipUnit,
        visibility: visUnit,
      },
      current: result.current,
      daily:   result.daily,
      hourly:  result.hourly,
    };
  }

  // ---- Data sources ---------------------------------------------------------

  // Returns true if the string looks like a US ZIP code (5 digits)
  _isUsZip(location) {
    return /^\d{5}$/.test(location.trim());
  }

  async _fetchWttr(location) {
    // Disambiguate 5-digit ZIPs: without a country suffix wttr.in may resolve
    // to a matching European postal code instead of the US one.
    const query   = this._isUsZip(location) ? `${location},USA` : location;
    const encoded = encodeURIComponent(query);
    const url = `https://wttr.in/${encoded}?format=j1`;
    return fetchJson(url, 8000);
  }

  // Resolve a US ZIP code → { latitude, longitude, name } via zippopotam.us
  async _resolveUsZip(zip) {
    const data = await fetchJson(`https://api.zippopotam.us/us/${zip}`, 6000);
    const place = data.places?.[0];
    if (!place) throw new Error(`ZIP code not found: ${zip}`);
    return {
      latitude:  parseFloat(place.latitude),
      longitude: parseFloat(place.longitude),
      name:      place['place name'],
      admin1:    place.state,
      country:   'United States',
    };
  }

  async _fetchOpenMeteo(location, days, imperial) {
    // 1. Geocode — resolve to lat/lon before calling the forecast API.
    let latitude, longitude, name, admin1, country;

    if (this._isUsZip(location)) {
      // Use zippopotam.us for accurate US ZIP → coordinates (avoids open-meteo
      // geocoder which doesn't understand ZIP codes at all).
      const geo = await this._resolveUsZip(location);
      ({ latitude, longitude, name, admin1, country } = geo);
    } else {
      // open-meteo geocoder — extract just the city name; it doesn't parse
      // "City, State" compound strings.
      const parts     = location.split(',').map(s => s.trim());
      const cityQuery = parts[0];
      const stateHint = parts[1]?.toLowerCase() ?? null;

      const geoUrl = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(cityQuery)}&count=5&language=en&format=json`;
      const geoData = await fetchJson(geoUrl, 8000);
      const results  = geoData.results ?? [];

      let geo = null;
      if (stateHint && results.length > 0) {
        geo = results.find(r =>
          r.admin1?.toLowerCase().includes(stateHint) ||
          r.admin1_code?.toLowerCase() === stateHint ||
          r.country_code?.toLowerCase() === stateHint
        ) ?? results[0];
      } else {
        geo = results[0] ?? null;
      }

      if (!geo) throw new Error(`Location not found: "${location}"`);
      ({ latitude, longitude, name, admin1, country } = geo);
    }

    const geoName = [name, admin1, country].filter(Boolean).join(', ');

    // 2. Build forecast URL
    const tempUnit  = imperial ? 'fahrenheit' : 'celsius';
    const speedUnit = imperial ? 'mph'        : 'kmh';
    const precipUnit= imperial ? 'inch'       : 'mm';

    const dailyVars = [
      'temperature_2m_max', 'temperature_2m_min',
      'apparent_temperature_max', 'apparent_temperature_min',
      'precipitation_sum', 'snowfall_sum',
      'precipitation_probability_max',
      'windspeed_10m_max', 'windgusts_10m_max',
      'winddirection_10m_dominant',
      'weathercode',
      'sunrise', 'sunset',
      'uv_index_max',
    ].join(',');

    const hourlyVars = [
      'temperature_2m', 'apparent_temperature',
      'relative_humidity_2m',
      'precipitation_probability', 'precipitation',
      'snowfall',
      'weathercode',
      'windspeed_10m', 'windgusts_10m', 'winddirection_10m',
      'cloudcover',
      'visibility',
      'uv_index',
      'surface_pressure',
    ].join(',');

    const forecastUrl = [
      `https://api.open-meteo.com/v1/forecast`,
      `?latitude=${latitude}`,
      `&longitude=${longitude}`,
      `&daily=${dailyVars}`,
      `&hourly=${hourlyVars}`,
      `&temperature_unit=${tempUnit}`,
      `&windspeed_unit=${speedUnit}`,
      `&precipitation_unit=${precipUnit}`,
      `&forecast_days=${days}`,
      `&timezone=auto`,
    ].join('');

    const forecastData = await fetchJson(forecastUrl, 10000);
    const normalized   = normalizeOpenMeteo(forecastData, geoName, days, imperial);

    // open-meteo doesn't provide current conditions — pull from first hourly slot
    if (!normalized.current && normalized.hourly.length > 0) {
      const h = normalized.hourly[0];
      normalized.current = {
        temp:        h.temp,
        feels_like:  h.feels_like,
        condition:   h.condition,
        humidity:    h.humidity,
        wind_speed:  h.wind_speed,
        wind_dir:    null,
        wind_deg:    h.wind_deg,
        wind_gusts:  h.wind_gusts,
        precip:      h.precip,
        visibility:  h.visibility,
        uv_index:    h.uv_index,
        cloud_cover: h.cloud_cover,
        pressure_mb: h.pressure_mb,
        note:        `Sourced from first forecast hour (${h.time})`,
      };
    }

    // Attach resolved location name
    normalized.resolved_location = geoName;
    return normalized;
  }
}

module.exports = WeatherTool;
