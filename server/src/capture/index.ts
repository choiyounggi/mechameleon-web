import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express, { Router, type Request, type Response } from 'express';
import { imageSize } from 'image-size';
import multer from 'multer';
import { zCaptureReq, type Background } from 'shared/protocol';
import { playwrightScreenshotter, withConcurrencyLimit, type Screenshotter } from './screenshotter';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCREENSHOTS_DIR = path.join(__dirname, '../../data/screenshots');

// D6: directory must exist before any request handler can write into it, so
// this runs synchronously at module init rather than as a fire-and-forget.
fs.mkdirSync(SCREENSHOTS_DIR, { recursive: true });

const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
const ALLOWED_UPLOAD_MIME_EXT: Record<string, string> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
};

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_UPLOAD_BYTES },
  fileFilter: (_req, file, cb) => {
    cb(null, file.mimetype in ALLOWED_UPLOAD_MIME_EXT);
  },
});

// D8/D7: any failure from the multer middleware (size limit exceeded, or the
// fileFilter above rejecting the mimetype) maps to the same 400 INVALID_IMAGE.
// Exported so this mapping is unit-testable without driving a real multer
// upload (e.g. a real 10MB body) through the router.
export function handleUploadMiddlewareResult(
  err: unknown,
  file: Express.Multer.File | undefined,
  res: Response,
): void | Promise<void> {
  if (err || !file) {
    res.status(400).json({ error: { code: 'INVALID_IMAGE', message: 'invalid image upload' } });
    return;
  }
  return saveUploadedImage(file, res);
}

async function saveUploadedImage(file: Express.Multer.File, res: Response): Promise<void> {
  let dims: { width?: number; height?: number };
  try {
    dims = imageSize(file.buffer);
  } catch {
    res.status(400).json({ error: { code: 'INVALID_IMAGE', message: 'invalid image upload' } });
    return;
  }
  if (!dims.width || !dims.height) {
    res.status(400).json({ error: { code: 'INVALID_IMAGE', message: 'invalid image upload' } });
    return;
  }

  try {
    const ext = ALLOWED_UPLOAD_MIME_EXT[file.mimetype];
    const filename = `${randomUUID()}${ext}`;
    await fsPromises.writeFile(path.join(SCREENSHOTS_DIR, filename), file.buffer);
    const background: Background = {
      imageUrl: `/api/screenshots/${filename}`,
      width: dims.width,
      height: dims.height,
    };
    res.status(200).json(background);
  } catch {
    res.status(500).json({ error: { code: 'INTERNAL', message: 'internal error' } });
  }
}

export function createCaptureRouter(s: Screenshotter): Router {
  const router = Router();

  router.post('/upload', (req: Request, res: Response) => {
    upload.single('image')(req, res, (err: unknown) => {
      void handleUploadMiddlewareResult(err, req.file, res);
    });
  });

  router.post('/capture', async (req: Request, res: Response) => {
    const parsed = zCaptureReq.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: { code: 'INVALID_URL', message: 'invalid capture request' } });
      return;
    }

    // zod's `.url()` already guarantees `new URL()` parses this without throwing.
    const parsedUrl = new URL(parsed.data.url);
    if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
      res.status(400).json({ error: { code: 'INVALID_URL', message: 'only http(s) URLs are supported' } });
      return;
    }

    // D9: no SSRF/private-IP filtering here -- accepted risk for this internal
    // LAN tool (brief-level decision), scheme check above is the only gate.
    let result;
    try {
      result = await s.capture(parsed.data.url);
    } catch {
      res.status(502).json({ error: { code: 'CAPTURE_FAILED', message: 'failed to capture the page' } });
      return;
    }

    try {
      const filename = `${randomUUID()}.png`;
      // D6: write must complete before the response is sent, since the
      // response body references the file by name.
      await fsPromises.writeFile(path.join(SCREENSHOTS_DIR, filename), result.png);
      const background: Background = {
        imageUrl: `/api/screenshots/${filename}`,
        width: result.width,
        height: result.height,
      };
      res.status(200).json(background);
    } catch {
      res.status(500).json({ error: { code: 'INTERNAL', message: 'internal error' } });
    }
  });

  router.use('/screenshots', express.static(SCREENSHOTS_DIR));

  return router;
}

const captureRouter = createCaptureRouter(withConcurrencyLimit(playwrightScreenshotter, 2));
export default captureRouter;
