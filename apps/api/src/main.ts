import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import helmet from 'helmet';
import { AppModule } from './app.module';
import { loadConfig } from './config';
async function bootstrap() {
  const config = loadConfig();
  const app = await NestFactory.create(AppModule);
  app.use(helmet());
  app.enableCors({ origin: config.WEB_ORIGIN });
  app.enableShutdownHooks();
  await app.listen(config.API_PORT, '127.0.0.1');
}
void bootstrap().catch(() => {
  console.error(
    'API startup failed. Check environment configuration and service availability.',
  );
  process.exitCode = 1;
});
