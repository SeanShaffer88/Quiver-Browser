import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EndpointStatus, loopbackEndpoint } from '../main/endpoint-status';

test('endpoint identity keeps the exact loopback family, address, and effective port', () => {
  assert.equal(loopbackEndpoint('http://127.0.0.1/p'), '127.0.0.1:80');
  assert.equal(loopbackEndpoint('https://127.0.0.2/p'), '127.0.0.2:443');
  assert.equal(loopbackEndpoint('http://[::1]:8080/a?x=2#b'), '[::1]:8080');
  assert.equal(loopbackEndpoint('http://localhost:8080/'), null);
  assert.equal(loopbackEndpoint('https://example.test/'), null);
  assert.equal(loopbackEndpoint('file://127.0.0.1/test'), null);
});

test('a failed scan and an unrelated listener cannot recover a failed local URL', () => {
  const tracker = new EndpointStatus();
  const original = 'http://[::1]:4173/orders/42?draft=true#total';
  assert.equal(tracker.failure(original, -102), null);
  tracker.observe(['http://[::1]:4173/']);
  assert.equal(tracker.failure(original, -202), null);
  tracker.observe(null);
  assert.equal(tracker.status(original), null);
  tracker.observe(['http://127.0.0.1:4173/']);
  assert.equal(tracker.status(original), 'missing');
  const failure = tracker.failure(original, -102);
  tracker.observe(null);
  assert.equal(tracker.retry(original, failure), null);
  tracker.observe(['http://127.0.0.1:4173/', 'http://[::1]:4173/']);
  assert.equal(tracker.retry(original, failure), original);
  assert.equal(tracker.retry(original.replace('#total', '#other'), failure), null);
  const laterFailure = tracker.failure(original, -102);
  assert.equal(tracker.retry(original, laterFailure), null);
  tracker.clear();
  assert.equal(tracker.status(original), null);
  tracker.observe(['http://[::1]:4173/']);
  tracker.observe([]);
  tracker.observe(['http://[::1]:4173/']);
  assert.equal(tracker.retry(original, failure), null);
});
