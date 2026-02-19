const https = require('https');
const http  = require('http');
const path  = require('path');
const fs    = require('fs');
const { URL } = require('url');
const Tool  = require('../tool_prototype');

// Simple HTTPS/HTTP GET → resolves with parsed JSON or rejects
function fetchJson(urlStr, headers = {}, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    let urlObj;
    try { urlObj = new URL(urlStr); } catch (e) { return reject(e); }

    const lib     = urlObj.protocol === 'https:' ? https : http;
    const options = {
      headers: { 'User-Agent': 'Skippy/1.0', 'Accept': 'application/json', ...headers },
    };

    const req = lib.get(urlStr, options, (res) => {
      if (res.statusCode < 200 || res.statusCode >= 300) {
        let body = '';
        res.on('data', c => { body += c; });
        res.on('end', () => reject(new Error(`HTTP ${res.statusCode}: ${body.slice(0, 200)}`)));
        return;
      }
      let raw = '';
      res.on('data',  c => { raw += c; });
      res.on('end',   () => {
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

// ---- Engine implementations --------------------------------------------------

/**
 * Brave Search Web API
 * Docs: https://api.search.brave.com/app/documentation/web-search
 */
async function braveSearch(query, options, apiKey) {
  const params = new URLSearchParams({ q: query });

  if (options.count   != null) params.set('count',       String(Math.min(Math.max(parseInt(options.count, 10), 1), 20)));
  if (options.offset  != null) params.set('offset',      String(options.offset));
  if (options.freshness)       params.set('freshness',   options.freshness);   // pd|pw|pm|py
  if (options.country)         params.set('country',     options.country);
  if (options.search_lang)     params.set('search_lang', options.search_lang);
  if (options.safesearch)      params.set('safesearch',  options.safesearch);  // off|moderate|strict
  if (options.extra_snippets)  params.set('extra_snippets', 'true');

  const url  = `https://api.search.brave.com/res/v1/web/search?${params.toString()}`;
  const data = await fetchJson(url, { 'X-Subscription-Token': apiKey });

  const raw = data.web?.results ?? [];
  const results = raw.map(r => ({
    title:          r.title       ?? '',
    url:            r.url         ?? '',
    description:    r.description ?? '',
    age:            r.age         ?? null,
    extra_snippets: r.extra_snippets ?? [],
  }));

  return {
    engine:       'brave',
    query,
    result_count: results.length,
    results,
  };
}

/**
 * SearchAPI.io — Google (and other engine) results via a managed SERP API
 * Docs: https://www.searchapi.io/docs/google
 */
async function searchapiSearch(query, options, apiKey) {
  const params = new URLSearchParams({ engine: 'google', q: query });

  // Pagination: page number (1-based) derived from offset / 10
  if (options.offset != null) {
    const page = Math.floor(parseInt(options.offset, 10) / 10) + 1;
    if (page > 1) params.set('page', String(page));
  }

  // Freshness → Google tbs (time-based search) parameter
  const freshnessMap = { pd: 'd', pw: 'w', pm: 'm', py: 'y' };
  if (options.freshness && freshnessMap[options.freshness]) {
    params.set('tbs', `qdr:${freshnessMap[options.freshness]}`);
  }

  if (options.country)      params.set('gl', options.country);
  if (options.search_lang)  params.set('hl', options.search_lang);

  const url  = `https://www.searchapi.io/api/v1/search?${params.toString()}`;
  const data = await fetchJson(url, { 'Authorization': `Bearer ${apiKey}` });

  const raw     = data.organic_results ?? [];
  const count   = options.count != null ? parseInt(options.count, 10) : raw.length;
  const sliced  = raw.slice(0, count);

  const results = sliced.map(r => ({
    title:       r.title   ?? '',
    url:         r.link    ?? '',
    description: r.snippet ?? '',
    age:         r.date    ?? null,
  }));

  return {
    engine:       'searchapi',
    query,
    result_count: results.length,
    results,
  };
}

// ---- Engine dispatcher --------------------------------------------------------

const ENGINE_MAP = {
  brave:     braveSearch,
  searchapi: searchapiSearch,
};

// ---- Tool class --------------------------------------------------------------

class WebSearchTool extends Tool {
  getContext() {
    const registryPath = path.join(__dirname, 'registry.md');
    try { return fs.readFileSync(registryPath, 'utf8'); } catch { return ''; }
  }

  async run(args) {
    const logger = global.logger || console;
    let op, params = {};

    if (Array.isArray(args)) {
      [op, ...params] = args;
      params = params[0] ?? {};
    } else if (args && typeof args === 'object') {
      ({ op = 'search', ...params } = args);
    } else {
      return { success: false, error: 'Invalid arguments' };
    }

    if (op !== 'search') {
      return { success: false, error: `Unknown operation: "${op}". Only "search" is supported.` };
    }

    const { query } = params;
    if (!query || !String(query).trim()) {
      return { success: false, error: 'Missing required parameter: query' };
    }

    const config = global.SkippyConfig || {};

    const webSearchCfg = config.tools?.web_search ?? {};
    const engineName   = params.engine ?? webSearchCfg.default_engine ?? 'brave';
    const engineCfg    = webSearchCfg.engines?.[engineName] ?? {};

    const engineFn = ENGINE_MAP[engineName];
    if (!engineFn) {
      return { success: false, error: `Unknown search engine: "${engineName}". Available: ${Object.keys(ENGINE_MAP).join(', ')}` };
    }

    const apiKey = engineCfg.apiKey;
    if (!apiKey) {
      return { success: false, error: `No apiKey configured for engine "${engineName}" in Skippy.json tools.web_search.engines.${engineName}.apiKey` };
    }

    const options = {
      count:          params.count,
      offset:         params.offset,
      freshness:      params.freshness,
      country:        params.country,
      search_lang:    params.search_lang,
      safesearch:     params.safesearch,
      extra_snippets: params.extra_snippets,
    };

    logger.info(`[WebSearchTool] search via ${engineName}: "${query}"`);

    try {
      const result = await engineFn(String(query).trim(), options, apiKey);
      return { success: true, ...result };
    } catch (e) {
      logger.error(`[WebSearchTool] ${engineName} search failed: ${e.message}`);
      return { success: false, error: e.message };
    }
  }
}

module.exports = WebSearchTool;
