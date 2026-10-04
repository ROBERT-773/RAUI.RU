import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { loadConfig } from './config';
import { configure } from './bootstrap';
async function bootstrap() {
  const config = loadConfig();
  const app = await NestFactory.create(AppModule, { bodyParser: false });
  configure(app);
  app.enableShutdownHooks();
  await app.listen(config.API_PORT, '127.0.0.1');
}
void bootstrap().catch(() => {
  console.error(
    'API startup failed. Check environment configuration and service availability.',
  );
  process.exitCode = 1;
});
