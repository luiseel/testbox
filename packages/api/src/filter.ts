import { ArgumentsHost, Catch, ExceptionFilter, HttpException } from '@nestjs/common';
import type { Response } from 'express';
import { AppError } from '@testbox/shared';

@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost): void {
    const res = host.switchToHttp().getResponse<Response>();
    if (res.headersSent) return;
    if (exception instanceof AppError) {
      res.status(exception.status).json({ error: { code: exception.code, message: exception.message } });
      return;
    }
    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const body = exception.getResponse();
      const message =
        typeof body === 'string'
          ? body
          : Array.isArray((body as { message?: unknown }).message)
            ? ((body as { message: string[] }).message).join(', ')
            : String((body as { message?: unknown }).message ?? exception.message);
      const code = status === 401 ? 'AUTH' : status === 403 ? 'FORBIDDEN' : 'BAD_REQUEST';
      res.status(status).json({ error: { code, message } });
      return;
    }
    const message = exception instanceof Error ? exception.message : 'internal error';
    process.stderr.write(`api error: ${message}\n`);
    res.status(500).json({ error: { code: 'INTERNAL', message: 'internal error' } });
  }
}
