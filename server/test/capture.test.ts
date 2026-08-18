import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express, { type Response } from 'express';
import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import { createCaptureRouter, handleUploadMiddlewareResult } from '../src/capture/index';
import type { CaptureResult, Screenshotter } from '../src/capture/screenshotter';

// Smallest-possible 1x1 pixel fixtures, verified to decode via image-size.
const ONE_PIXEL_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64',
);
const ONE_PIXEL_JPEG = Buffer.from(
  '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAMCAgICAgMCAgIDAwMDBAYEBAQEBAgGBgUGCQgKCgkICQkKDA8MCgsOCwkJDRENDg8QEBEQCgwSExIQEw8QEBD/2wBDAQMDAwQDBAgEBAgQCwkLEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBD/wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAj/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFQEBAQAAAAAAAAAAAAAAAAAAAAX/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIRAxEAPwCdABmX/9k=',
  'base64',
);

function fakeRes(): { res: Response; state: { status?: number; body?: unknown } } {
  const state: { status?: number; body?: unknown } = {};
  const res = {
    status(code: number) {
      state.status = code;
      return res;
    },
    json(body: unknown) {
      state.body = body;
      return res;
    },
  } as unknown as Response;
  return { res, state };
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCREENSHOTS_DIR = path.join(__dirname, '../data/screenshots');
const writtenFiles: string[] = [];

function appWith(screenshotter: Screenshotter) {
  const app = express();
  app.use(express.json());
  app.use('/api', createCaptureRouter(screenshotter));
  return app;
}

function fakeScreenshotter(result: CaptureResult | Error): Screenshotter {
  return {
    capture() {
      return result instanceof Error ? Promise.reject(result) : Promise.resolve(result);
    },
  };
}

afterEach(async () => {
  await Promise.all(writtenFiles.splice(0).map((f) => fs.rm(f, { force: true })));
});

describe('POST /api/capture', () => {
  it('captures a valid URL and returns a Background pointing at a fetchable screenshot', async () => {
    const app = appWith(fakeScreenshotter({ png: Buffer.from('fake-png'), width: 1440, height: 2200 }));

    const res = await request(app).post('/api/capture').send({ url: 'https://example.com' });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      imageUrl: expect.stringMatching(/^\/api\/screenshots\/.+\.png$/),
      width: 1440,
      height: 2200,
    });

    const filename = path.basename(res.body.imageUrl);
    writtenFiles.push(path.join(SCREENSHOTS_DIR, filename));

    const fileRes = await request(app).get(res.body.imageUrl);
    expect(fileRes.status).toBe(200);
    expect(fileRes.body).toEqual(Buffer.from('fake-png'));
  });

  it('rejects a non-http(s) scheme with 400 INVALID_URL', async () => {
    const app = appWith(fakeScreenshotter(new Error('should not be called')));

    const res = await request(app).post('/api/capture').send({ url: 'ftp://example.com/file' });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_URL');
  });

  it('rejects a payload that fails zCaptureReq validation with 400 INVALID_URL', async () => {
    const app = appWith(fakeScreenshotter(new Error('should not be called')));

    const res = await request(app).post('/api/capture').send({ url: 'not-a-url' });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_URL');
  });

  it('maps a capture failure to 502 CAPTURE_FAILED', async () => {
    const app = appWith(fakeScreenshotter(new Error('navigation timeout')));

    const res = await request(app).post('/api/capture').send({ url: 'https://example.com' });

    expect(res.status).toBe(502);
    expect(res.body.error.code).toBe('CAPTURE_FAILED');
  });

  it('passes through the boundary height (15000) unchanged', async () => {
    const app = appWith(fakeScreenshotter({ png: Buffer.from('tall-page'), width: 1440, height: 15000 }));

    const res = await request(app).post('/api/capture').send({ url: 'https://example.com/tall' });

    expect(res.status).toBe(200);
    expect(res.body.height).toBe(15000);

    const filename = path.basename(res.body.imageUrl);
    writtenFiles.push(path.join(SCREENSHOTS_DIR, filename));
  });
});

describe('POST /api/upload', () => {
  const noopScreenshotter: Screenshotter = {
    capture() {
      return Promise.reject(new Error('capture should not be invoked by upload tests'));
    },
  };

  it('accepts a PNG upload and returns its real dimensions', async () => {
    const app = appWith(noopScreenshotter);

    const res = await request(app)
      .post('/api/upload')
      .attach('image', ONE_PIXEL_PNG, { filename: 'pixel.png', contentType: 'image/png' });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      imageUrl: expect.stringMatching(/^\/api\/screenshots\/.+\.png$/),
      width: 1,
      height: 1,
    });

    writtenFiles.push(path.join(SCREENSHOTS_DIR, path.basename(res.body.imageUrl)));
  });

  it('rejects a disallowed mimetype with 400 INVALID_IMAGE', async () => {
    const app = appWith(noopScreenshotter);

    const res = await request(app)
      .post('/api/upload')
      .attach('image', Buffer.from('just some text'), { filename: 'note.txt', contentType: 'text/plain' });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_IMAGE');
  });

  it('accepts a JPEG upload (boundary of the allowed mimetype set) and stores it with a .jpg extension', async () => {
    const app = appWith(noopScreenshotter);

    const res = await request(app)
      .post('/api/upload')
      .attach('image', ONE_PIXEL_JPEG, { filename: 'pixel.jpg', contentType: 'image/jpeg' });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      imageUrl: expect.stringMatching(/^\/api\/screenshots\/.+\.jpg$/),
      width: 1,
      height: 1,
    });

    writtenFiles.push(path.join(SCREENSHOTS_DIR, path.basename(res.body.imageUrl)));
  });

  it('maps a multer middleware error (e.g. size-limit exceeded) to 400 INVALID_IMAGE', () => {
    const { res, state } = fakeRes();

    handleUploadMiddlewareResult(new Error('File too large'), undefined, res);

    expect(state.status).toBe(400);
    expect((state.body as { error: { code: string } }).error.code).toBe('INVALID_IMAGE');
  });
});
