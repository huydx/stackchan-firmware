import test from 'node:test';
import assert from 'node:assert/strict';
import { createFaceDetector, largestFace } from '../face-detector.mjs';

test('largest face is converted to -1..1 from the image center', () => {
  assert.deepEqual(largestFace([]), { found: false });
  assert.deepEqual(largestFace([{ x: 0.5, y: 0.5, w: 0.1, h: 0.1 }, { x: 0.75, y: 0.25, w: 0.3, h: 0.3 }]),
    { found: true, x: 0.5, y: -0.5 });
  assert.deepEqual(largestFace([{ x: 'bad' }]), { found: false });
});

test('face detection is unavailable off macOS without starting anything', async () => {
  let prepared = false;
  const detector = createFaceDetector({ platform: 'linux', prepare: async () => { prepared = true; } });
  assert.equal(detector.state, 'unavailable');
  assert.deepEqual(await detector.detect(Buffer.from('x')), { found: false });
  assert.equal(prepared, false);
});

test('a failed helper build reports unavailable instead of throwing', async () => {
  const detector = createFaceDetector({ platform: 'darwin', log: { error() {} }, prepare: async () => { throw Error('no swiftc'); } });
  assert.deepEqual(await detector.detect(Buffer.from('x')), { found: false });
  assert.equal(detector.state, 'unavailable');
});
