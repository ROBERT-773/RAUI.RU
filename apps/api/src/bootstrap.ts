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
  app.use(
    (
      req: { url: string; method: string },
      res: {
        on: (event: string, listener: () => void) => void;
        statusCode: number;
      },
      next: () => void,
    ) => {
      const started = Date.now();
      res.on('finish', () =>
        console.log(
          JSON.stringify({
            event: 'http',
            method: req.method,
            status: res.statusCode,
            durationMs: Date.now() - started,
          }),
        ),
      );
      next();
    },
  );
  const builder = new DocumentBuilder()
    .setTitle('RAUI.RU Core API')
    .setVersion('1.0')
    .addBearerAuth()
    .addCookieAuth('raui_session')
    .build();
  const document = SwaggerModule.createDocument(app, builder);
  enrichOpenApi(document);
  SwaggerModule.setup('v1/docs', app, document, {
    jsonDocumentUrl: 'v1/openapi.json',
  });
}
