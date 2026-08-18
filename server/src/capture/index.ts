import { Router, type Request, type Response } from 'express';

// Real screenshot/upload implementation is out of scope for this task (owned
// by the capture task); this stub only reserves the contract (D16) so other
// tasks can build against a stable mount point.
const captureRouter = Router();

function notImplemented(_req: Request, res: Response): void {
  res.status(501).json({
    error: { code: 'NOT_IMPLEMENTED', message: 'capture is not implemented yet' },
  });
}

captureRouter.post('/capture', notImplemented);
captureRouter.post('/upload', notImplemented);

export default captureRouter;
