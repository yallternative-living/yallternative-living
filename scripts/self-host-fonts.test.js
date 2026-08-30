const fs = require('fs');
const https = require('https');
const { getJson, download } = require('./self-host-fonts.js');

let passed = 0;
let failed = 0;

function ok(msg) {
  passed++;
  console.log('  ✓ ' + msg);
}

function fail(msg) {
  failed++;
  console.error('  ✗ ' + msg);
}

function eq(actual, expected, msg) {
  if (actual === expected) ok(msg);
  else fail(`${msg}\n      Expected: ${expected}\n      Actual:   ${actual}`);
}

async function testGetJson() {
  console.log('\n--- getJson ---');
  const originalGet = https.get;

  // 1. Success (200 OK, valid JSON)
  https.get = (url, options, callback) => {
    eq(options.headers['User-Agent'], 'yallternative-living', 'Sends User-Agent header');
    const res = {
      statusCode: 200,
      on: (event, handler) => {
        if (event === 'data') handler('{"foo":"bar"}');
        if (event === 'end') handler();
      }
    };
    callback(res);
    return { on: () => {} }; // Mock request object
  };

  try {
    const data = await getJson('https://example.com/api');
    eq(data.foo, 'bar', 'Resolves parsed JSON on 200 OK');
  } catch (err) {
    fail('Unexpected rejection on 200 OK: ' + err.message);
  }

  // 2. HTTP Error (Non-200)
  https.get = (url, options, callback) => {
    const res = {
      statusCode: 404,
      on: (event, handler) => {
        if (event === 'end') handler();
      }
    };
    callback(res);
    return { on: () => {} };
  };

  try {
    await getJson('https://example.com/api');
    fail('Should have rejected on 404');
  } catch (err) {
    eq(err.message, 'Status 404', 'Rejects with status code error on non-200');
  }

  // 3. JSON Parse Error
  https.get = (url, options, callback) => {
    const res = {
      statusCode: 200,
      on: (event, handler) => {
        if (event === 'data') handler('invalid json');
        if (event === 'end') handler();
      }
    };
    callback(res);
    return { on: () => {} };
  };

  try {
    await getJson('https://example.com/api');
    fail('Should have rejected on invalid JSON');
  } catch (err) {
    ok('Rejects on invalid JSON parsing: ' + err.name);
  }

  // 4. Network Error
  https.get = (url, options, callback) => {
    return {
      on: (event, handler) => {
        if (event === 'error') handler(new Error('Network failure'));
      }
    };
  };

  try {
    await getJson('https://example.com/api');
    fail('Should have rejected on network error');
  } catch (err) {
    eq(err.message, 'Network failure', 'Rejects on request error');
  }

  https.get = originalGet;
}

async function testDownload() {
  console.log('\n--- download ---');
  const originalGet = https.get;
  const originalCreateWriteStream = fs.createWriteStream;
  const originalUnlink = fs.unlink;

  let streamClosed = false;
  let unlinkedFile = null;

  fs.createWriteStream = (dest) => ({
    on: (event, handler) => {
      if (event === 'finish') setTimeout(handler, 0); // Simulate async finish
    },
    close: (cb) => {
      streamClosed = true;
      if (cb) cb();
    }
  });

  fs.unlink = (dest, cb) => {
    unlinkedFile = dest;
    if (cb) cb();
  };

  // 1. Success (200 OK)
  https.get = (url, callback) => {
    const res = {
      statusCode: 200,
      pipe: () => {} // Mock piping
    };
    callback(res);
    return { on: () => {} };
  };

  try {
    await download('https://example.com/font.woff2', '/fake/path');
    ok('Resolves on 200 OK stream finish');
    eq(streamClosed, true, 'File stream is closed after success');
  } catch (err) {
    fail('Unexpected rejection on 200 OK: ' + err.message);
  }

  // 2. HTTP Error (Non-200)
  https.get = (url, callback) => {
    const res = { statusCode: 403 };
    callback(res);
    return { on: () => {} };
  };

  try {
    await download('https://example.com/font.woff2', '/fake/path');
    fail('Should have rejected on 403');
  } catch (err) {
    ok('Rejects with HTTP error on non-200: ' + err.message);
  }

  // 3. Network Error & Cleanup
  https.get = (url, callback) => {
    return {
      on: (event, handler) => {
        if (event === 'error') handler(new Error('Connection reset'));
      }
    };
  };

  try {
    await download('https://example.com/font.woff2', '/fake/path');
    fail('Should have rejected on network error');
  } catch (err) {
    eq(err.message, 'Connection reset', 'Rejects on request error');
    eq(unlinkedFile, '/fake/path', 'Unlinks destination file on error');
  }

  https.get = originalGet;
  fs.createWriteStream = originalCreateWriteStream;
  fs.unlink = originalUnlink;
}

(async () => {
  await testGetJson();
  await testDownload();
  console.log(`\nself-host-fonts.test.js: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
})().catch((err) => {
  console.error('self-host-fonts.test.js crashed:', err);
  process.exit(1);
});
