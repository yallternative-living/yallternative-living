/**
 * @fileoverview 2026 SOTA Proxy-based State Store.
 * Provides lightweight, zero-dependency reactive state management
 * using native JavaScript Proxy and CustomEvents.
 */
(function (global) {
  'use strict';

  function createStore(initialState) {
    var target = initialState || {};
    var listeners = {};

    var proxy = new Proxy(target, {
      set: function (obj, prop, value) {
        var oldValue = obj[prop];
        obj[prop] = value;

        if (oldValue !== value) {
          var eventName = 'yl:state:' + prop;
          if (typeof window !== 'undefined') {
            window.dispatchEvent(
              new CustomEvent(eventName, {
                detail: { key: prop, value: value, oldValue: oldValue },
              })
            );
          }
          if (listeners[prop]) {
            listeners[prop].forEach(function (fn) {
              fn(value, oldValue);
            });
          }
        }
        return true;
      },
    });

    return {
      state: proxy,
      subscribe: function (prop, callback) {
        if (!listeners[prop]) listeners[prop] = [];
        listeners[prop].push(callback);
        return function unsubscribe() {
          listeners[prop] = listeners[prop].filter(function (fn) {
            return fn !== callback;
          });
        };
      },
    };
  }

  global.YL_Store = createStore({
    cartCount: 0,
    activeCategory: 'all',
    restockProduct: null,
    socialFeedLoaded: false,
  });
})(typeof window !== 'undefined' ? window : this);
