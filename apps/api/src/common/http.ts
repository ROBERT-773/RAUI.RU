import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
} from '@nestjs/common';
import type { Response } from 'express';
@Catch()
export class ApiErrors implements ExceptionFilter {
  catch(error: unknown, host: ArgumentsHost) {
    const res = host.switchToHttp().getResponse<Response>();
    if (error instanceof HttpException) {
      res.status(error.getStatus()).json(error.getResponse());
      return;
    }
    const fields =
      typeof error === 'object' && error !== null
        ? (error as { type?: unknown; code?: unknown })
        : {};
    const kind = fields.type;
    if (kind === 'entity.too.large') {
      res.status(413).json({ message: 'Request too large' });
      return;
    }
    if (kind === 'entity.parse.failed') {
      res.status(400).json({ message: 'Invalid JSON' });
      return;
    }
    const code = typeof fields.code === 'string' ? fields.code : undefined;
    if (['40P01', '40001', '55P03'].includes(code ?? '')) {
      res
        .status(409)
        .json({ message: 'Concurrent update; retry the operation' });
      return;
    }
    if (code === '23505') {
      res.status(409).json({ message: 'Conflict' });
      return;
    }
    if (['23503', '23514', '22P02'].includes(code ?? '')) {
      res.status(400).json({ message: 'Invalid reference or constraint' });
      return;
    }
    console.error(JSON.stringify({ event: 'request_error', code: 'internal' }));
    res.status(500).json({ message: 'Internal server error' });
  }
}
