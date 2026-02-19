const Tool = require('../tool_prototype');
const https = require('https');
const http = require('http');
const { URL } = require('url');
const { Agent } = require('http');

class HttpRequestTool extends Tool {
  async run(args) {
    // args: [method, url, body, headers, options] or { method, url, body, headers, options }
    const logger = global.logger || console;

    // Normalize: accept named-key object or positional array
    if (!Array.isArray(args) && args && typeof args === 'object') {
      args = [args.method, args.url, args.body, args.headers, args.options];
    }

    const method = (args[0] || 'GET').toUpperCase();
    let url = args[1];
    let rawBody = args[2] ?? null;
    const headers = args[3] || {};
    const options = args[4] || {};

    // For state-mutating methods (POST, PUT, PATCH, DELETE): if the LLM put
    // parameters in the query string instead of the body and there is no body,
    // automatically extract them into the body and strip them from the URL.
    const BODY_METHODS = ['POST', 'PUT', 'PATCH', 'DELETE'];
    let paramsExtractedFromUrl = false;
    if (BODY_METHODS.includes(method) && rawBody === null && url) {
      try {
        const urlObj = new URL(url);
        if (urlObj.searchParams.size > 0) {
          const extracted = {};
          urlObj.searchParams.forEach((v, k) => { extracted[k] = v; });
          rawBody = extracted;
          paramsExtractedFromUrl = true;
          urlObj.search = '';
          url = urlObj.toString();
          logger.debug(`[HttpRequestTool] Moved query params to body for ${method}: ${JSON.stringify(extracted)}`);
        }
      } catch (_) { /* invalid URL — will be caught below */ }
    }

    // Serialize body and set Content-Type if not already set.
    // - object body + explicit Content-Type: honour it
    // - object body auto-extracted from URL (no explicit Content-Type) → form-encode
    // - object body explicitly provided (no explicit Content-Type) → JSON
    // - string body → send as-is
    const finalHeaders = { ...headers };
    let body = null;
    if (rawBody !== null && rawBody !== undefined) {
      if (typeof rawBody === 'object') {
        const ctKey = Object.keys(finalHeaders).find(k => k.toLowerCase() === 'content-type');
        const ct = ctKey ? finalHeaders[ctKey].toLowerCase() : '';
        if (ct.includes('application/x-www-form-urlencoded') || (!ctKey && paramsExtractedFromUrl)) {
          body = new URLSearchParams(rawBody).toString();
          if (!ctKey) finalHeaders['Content-Type'] = 'application/x-www-form-urlencoded';
        } else {
          body = JSON.stringify(rawBody);
          if (!ctKey) finalHeaders['Content-Type'] = 'application/json';
        }
      } else {
        body = String(rawBody);
      }
      finalHeaders['Content-Length'] = Buffer.byteLength(body);
    }
    
    // Default timeout: 30 seconds
    const timeout = options.timeout || 30000;
    // Whether to reject invalid SSL certificates (default: true for security)
    const rejectUnauthorized = options.rejectUnauthorized !== false;
    
    if (!url) {
      return { method, url, body, headers, result: null, error: 'No URL provided', exitCode: 1 };
    }
    
    // Track redirects to prevent infinite loops
    const maxRedirects = options.maxRedirects || 5;
    const redirectCount = options._redirectCount || 0;
    
    try {
      const urlObj = new URL(url);
      const isHttps = urlObj.protocol === 'https:';
      const lib = isHttps ? https : http;
      
      // Configure request options
      const requestOptions = {
        method,
        headers: finalHeaders,
        timeout: timeout,
        // HTTPS-specific options
        ...(isHttps && {
          rejectUnauthorized: rejectUnauthorized,
          // Allow custom CA cert
          ca: options.ca,
          // Allow custom client certificate
          cert: options.cert,
          // Allow custom client key
          key: options.key,
          // Set minimum TLS version for security
          secureProtocol: options.secureProtocol || 'TLS_method',
          // Allow using legacy SSL versions (not recommended)
          secureOptions: options.secureOptions,
        })
      };
      
      return await new Promise((resolve, reject) => {
        const req = lib.request(urlObj, requestOptions, (res) => {
          let data = '';
          
          res.on('data', (chunk) => {
            data += chunk;
          });
          
          res.on('end', () => {
            // Handle redirects
            if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
              if (redirectCount < maxRedirects) {
                // Build the next args with updated redirect count
                const nextOptions = { ...options, _redirectCount: redirectCount + 1 };
                // Resolve the redirect by calling run again with new URL
                this.run([method, res.headers.location, body, headers, nextOptions])
                  .then(resolve)
                  .catch(reject);
                return;
              } else {
                resolve({ 
                  method, 
                  url, 
                  body, 
                  headers, 
                  statusCode: res.statusCode, 
                  result: null, 
                  error: 'Too many redirects', 
                  exitCode: 1 
                });
                return;
              }
            }
            
            resolve({
              method,
              url,
              body,
              headers,
              statusCode: res.statusCode,
              result: data,
              error: null,
              exitCode: 0
            });
          });
        });
        
        // Handle request timeout
        req.on('timeout', () => {
          req.destroy();
          logger.error(`HttpRequestTool: ${method} ${url} timed out after ${timeout}ms`);
          resolve({ 
            method, 
            url, 
            body, 
            headers, 
            result: null, 
            error: `Request timed out after ${timeout}ms`, 
            exitCode: 1 
          });
        });
        
        // Handle request errors
        req.on('error', (err) => {
          // Provide more helpful error messages for common HTTPS issues
          let errorMessage = err.message;
          
          if (err.code === 'DEPTH_ZERO_SELF_SIGNED_CERT') {
            errorMessage = 'Self-signed SSL certificate is not trusted. Use rejectUnauthorized: false to allow (not recommended for production).';
          } else if (err.code === 'UNABLE_TO_VERIFY_LEAF_SIGNATURE') {
            errorMessage = 'Unable to verify the SSL certificate chain. The certificate may be malformed.';
          } else if (err.code === 'CERT_HAS_EXPIRED') {
            errorMessage = 'The SSL certificate has expired.';
          } else if (err.code === 'CERT_NOT_YET_VALID') {
            errorMessage = 'The SSL certificate is not yet valid.';
          } else if (err.code === 'ECONNREFUSED') {
            errorMessage = `Connection refused. The server may be down or the port may be incorrect.`;
          } else if (err.code === 'ENOTFOUND') {
            errorMessage = `DNS lookup failed. The hostname "${urlObj.hostname}" could not be resolved.`;
          } else if (err.code === 'ETIMEDOUT') {
            errorMessage = `Connection timed out while connecting to ${urlObj.hostname}.`;
          }
          
          logger.error(`HttpRequestTool: ${method} ${url} failed: ${errorMessage}`);
          resolve({ 
            method, 
            url, 
            body, 
            headers, 
            result: null, 
            error: errorMessage, 
            exitCode: 1 
          });
        });
        
        // Write body for any method that has one
        if (body) {
          req.write(body);
        }
        
        req.end();
      });
    } catch (err) {
      // Handle URL parsing errors
      let errorMessage = err.message;
      
      if (err.message.includes('Invalid URL')) {
        errorMessage = 'Invalid URL format. Please provide a valid URL (e.g., https://example.com).';
      }
      
      logger.error(`HttpRequestTool: ${method} ${url} failed: ${errorMessage}`);
      return { 
        method, 
        url, 
        body, 
        headers, 
        result: null, 
        error: errorMessage, 
        exitCode: 1 
      };
    }
  }
  
  getContext() {
    const fs = require('fs');
    const path = require('path');
    const registryPath = path.join(__dirname, 'registry.md');
    if (fs.existsSync(registryPath)) {
      return fs.readFileSync(registryPath, 'utf8');
    } else {
      return '';
    }
  }
}

module.exports = HttpRequestTool;
