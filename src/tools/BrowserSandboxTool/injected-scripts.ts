/**
 * injected-scripts.ts — JavaScript scripts injected into browser pages
 *
 * Two scripts:
 * 1. INTERCEPT_SCRIPT — Worker-compatible fetch/XHR interception for page context
 *    Used by CDP `Page.addScriptToEvaluateOnNewDocument` before page load.
 *    Captures Worker-initiated requests that CDP Network domain misses.
 * 2. COLLECTOR_SCRIPT — Post-load data collection script.
 *
 * Both scripts are self-contained (no external deps) and safe to inject.
 */

// ─── Worker-compatible intercept script ───────────────────────────────────────

/**
 * Injected into page before load (via Page.addScriptToEvaluateOnNewDocument).
 * Also auto-injected into Workers via CDP Target.setAutoAttach.
 *
 * Captures: fetch and XMLHttpRequest in both main thread and Workers.
 * Stores intercepted requests in window.__sandboxRequests (array).
 */
export const INTERCEPT_SCRIPT = `
(function() {
  if (self.__sandboxInterceptorInjected) return;
  self.__sandboxInterceptorInjected = true;
  if (!self.__sandboxRequests) self.__sandboxRequests = [];
  var MAX = 200;

  function store(entry) {
    var arr = self.__sandboxRequests;
    if (arr && arr.length < MAX) {
      arr.push(entry);
    }
  }

  // ── fetch ────────────────────────────────────────────────────────────────
  var _fetch = self.fetch;
  if (typeof _fetch === 'function') {
    self.fetch = function(input, init) {
      var url = typeof input === 'string' ? input : (input && input.url || '');
      var body = (init && init.body) || null;
      var method = (init && init.method) || 'GET';
      var startTime = Date.now();
      return _fetch.apply(self, arguments).then(function(res) {
        var clone = res.clone();
        clone.text().then(function(text) {
          store({ url: url, method: method, requestBody: body,
                  responseText: text, timestamp: startTime,
                  source: self === window ? 'sandbox-main' : 'sandbox-worker',
                  status: res.status, type: 'fetch' });
        }).catch(function() {});
        return res;
      }).catch(function(e) {
        store({ url: url, method: method, requestBody: body,
                error: e.message || String(e), timestamp: startTime,
                source: self === window ? 'sandbox-main' : 'sandbox-worker',
                type: 'fetch-error' });
        throw e;
      });
    };
  }

  // ── XMLHttpRequest ────────────────────────────────────────────────────────
  if (typeof XMLHttpRequest !== 'undefined') {
    var _open = XMLHttpRequest.prototype.open;
    var _send = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.open = function(method, url) {
      this.__sbUrl = url;
      this.__sbMethod = method;
      return _open.apply(this, arguments);
    };
    XMLHttpRequest.prototype.send = function(body) {
      var self2 = this;
      var startTime = Date.now();
      this.addEventListener('load', function() {
        store({ url: self2.__sbUrl, method: self2.__sbMethod,
                requestBody: body, responseText: self2.responseText,
                timestamp: startTime, source: self === window ? 'sandbox-main-xhr' : 'sandbox-worker-xhr',
                status: self2.status, type: 'xhr' });
      });
      this.addEventListener('error', function() {
        store({ url: self2.__sbUrl, method: self2.__sbMethod,
                requestBody: body, error: 'network error',
                timestamp: startTime, source: self === window ? 'sandbox-main-xhr' : 'sandbox-worker-xhr',
                type: 'xhr-error' });
      });
      return _send.apply(this, arguments);
    };
  }
})();
`;

/**
 * JS-side intercept script variant — used as a fallback when CDP network
 * interception is not available or misses requests. Injected into already-loaded
 * pages via Runtime.evaluate.
 */
export const JS_INTERCEPTOR_SCRIPT = `
(function() {
  if (window.__sandboxJsInterceptorInstalled) return;
  window.__sandboxJsInterceptorInstalled = true;
  if (!window.__sandboxRequests) window.__sandboxRequests = [];

  var MAX = 200;
  var map = new Map();

  function shouldIntercept(url) {
    if (!url) return false;
    // Default patterns: data APIs, json, graphql
    return /\\/api\\/|\\/data\\/|\\.json|graphql|query|fetch/i.test(url);
  }

  function store(entry) {
    if (window.__sandboxRequests.length < MAX) {
      window.__sandboxRequests.push(entry);
    }
  }

  // fetch
  var _fetch = window.fetch;
  window.fetch = function(input, init) {
    var url = typeof input === 'string' ? input : (input && input.url || '');
    if (!shouldIntercept(url)) return _fetch.apply(window, arguments);
    var body = (init && init.body) || null;
    var method = (init && init.method) || 'GET';
    var start = Date.now();
    return _fetch.apply(window, arguments).then(function(res) {
      var clone = res.clone();
      clone.text().then(function(text) {
        store({ url: url, method: method, requestBody: body, responseText: text,
                timestamp: start, source: 'sandbox-js', status: res.status });
      }).catch(function() {});
      return res;
    }).catch(function(e) {
      store({ url: url, method: method, requestBody: body, error: String(e),
              timestamp: start, source: 'sandbox-js' });
      throw e;
    });
  };

  // XHR
  var _o = XMLHttpRequest.prototype.open;
  var _s = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function(m, u) { this.__u = u; this.__m = m; return _o.apply(this, arguments); };
  XMLHttpRequest.prototype.send = function(b) {
    var self3 = this;
    var t = Date.now();
    this.addEventListener('load', function() {
      store({ url: self3.__u, method: self3.__m, requestBody: b,
              responseText: self3.responseText, timestamp: t, source: 'sandbox-js-xhr', status: self3.status });
    });
    this.addEventListener('error', function() {
      store({ url: self3.__u, method: self3.__m, requestBody: b, error: 'error',
              timestamp: t, source: 'sandbox-js-xhr' });
    });
    return _s.apply(this, arguments);
  };
})();
`;

/**
 * Collector script — run after navigation to collect intercepted data
 * and merge iframe data into the main window.
 */
export const COLLECTOR_SCRIPT = `
(function() {
  function collect() {
    var result = { intercepted: [], dom: {} };
    var main = window.__sandboxRequests || [];

    // Merge iframe requests
    try {
      var iframe = document.getElementById('view-dashboard-iframe');
      if (iframe && iframe.contentWindow && iframe.contentWindow.__sandboxRequests) {
        var seen = new Set();
        main.forEach(function(r) { seen.add(r.url + '_' + (r.timestamp || 0)); });
        iframe.contentWindow.__sandboxRequests.forEach(function(r) {
          var key = r.url + '_' + (r.timestamp || 0);
          if (!seen.has(key)) { main.push(r); seen.add(key); }
        });
      }
    } catch(e) {}

    result.intercepted = main;
    result.dom = {
      title: document.title || '',
      url: window.location.href || '',
      text: (document.body && document.body.innerText) ? document.body.innerText.slice(0, 2000) : ''
    };

    return result;
  }
  return JSON.stringify(collect());
})()
`;
