import {
  Telemetry,
  requestTrace,
  traceContext,
} from './modules/operations/telemetry';
import type { Request, Response, NextFunction } from 'express';
import { enrichOpenApi } from './common/openapi';
import { INestApplication } from '@nestjs/common';
import { SwaggerModule, DocumentBuilder } from '@nestjs/swagger';
import { json } from 'express';
import helmet from 'helmet';
import { ApiErrors } from './common/http';
import { loadConfig } from './config';
export function configure(app: INestApplication) {
  app.use(helmet());
  app.use(
    (
      _req: unknown,
      res: { setHeader: (name: string, value: string) => void },
      next: () => void,
    ) => {
      res.setHeader('Cache-Control', 'no-store');
      next();
    },
  );
  const telemetry = app.get(Telemetry);
  app.use((req: Request, res: Response, next: NextFunction) => {
    const started = performance.now();
    const trace = requestTrace(req.headers.traceparent);
    res.setHeader('X-Request-Id', trace.traceId);
    res.setHeader('traceparent', `00-${trace.traceId}-${trace.spanId}-00`);
    res.on('finish', () => {
      const seconds = (performance.now() - started) / 1000;
      const route = telemetry.route(req.route?.path);
      telemetry.record(route, req.method, res.statusCode, seconds);
      console.log(
        JSON.stringify({
          event: 'http_span',
          ...trace,
          route,
          method: telemetry.method(req.method),
          status: res.statusCode,
          durationMs: Math.round(seconds * 1000),
        }),
      );
    });
    traceContext.run(trace, next);
  });
  app.use(
    '/v1/commerce/webhook',
    json({
      limit: '256kb',
      verify: (req, _res, bytes) => {
        (req as typeof req & { rawBody: Buffer }).rawBody = Buffer.from(bytes);
      },
    }),
  );
  app.use(json({ limit: '15mb' }));
  app.useGlobalFilters(new ApiErrors());
  app.enableCors({
    origin: loadConfig().WEB_ORIGIN,
    credentials: true,
    allowedHeaders: [
      'Content-Type',
      'Authorization',
      'Idempotency-Key',
      'X-CSRF-Token',
      'X-Partner-Token',
    ],
  });
  const builder = new DocumentBuilder()
    .setTitle('RAUI.RU Core API')
    .setVersion('1.0')
    .addBearerAuth()
    .addCookieAuth('raui_session')
    .build();
  const document = SwaggerModule.createDocument(app, builder);
  enrichOpenApi(document);
  telemetry.routes(
    Object.keys(document.paths).map((path) =>
      path.replace(/\{([^}]+)\}/g, ':$1'),
    ),
  );

  SwaggerModule.setup('v1/docs', app, document, {
    jsonDocumentUrl: 'v1/openapi.json',
  });
}
