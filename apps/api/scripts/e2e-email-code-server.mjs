import 'reflect-metadata';
import { createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { Test } from '@nestjs/testing';
import { AppModule } from '../dist/app.module.js';
import { configure } from '../dist/bootstrap.js';
import { EmailSignInDelivery } from '../dist/modules/auth/email-sign-in-delivery.js';

const db = new URL(process.env.DATABASE_URL ?? '');
const privateDirectory = process.env.LOCAL_PRIVATE_DIR;
if (
  process.env.NODE_ENV !== 'test' ||
  process.env.E2E_EMAIL_CODE !== 'true' ||
  !['local', undefined].includes(process.env.DEPLOYMENT_ENV) ||
  !['localhost', '127.0.0.1'].includes(db.hostname) ||
  !/^\/raui_test_[0-9a-f]{16}$/.test(db.pathname) ||
  !privateDirectory
)
  throw new Error(
    'Email-code browser fixture requires an isolated local test database',
  );

const module = await Test.createTestingModule({ imports: [AppModule] })
  .overrideProvider(EmailSignInDelivery)
  .useValue({
    async send(destination, code) {
      if (
        !/^(?:agent|code-buyer|code-owner|code-recovery)-(?:chromium|firefox|webkit|ios-webkit|android-chromium)@e2e\.test$/.test(
          destination,
        ) ||
        !/^\d{6}$/.test(code)
      )
        throw new Error('Unexpected test email delivery');
      const id = createHash('sha256').update(destination).digest('hex');
      await writeFile(resolve(privateDirectory, 'email-code-' + id), code, {
        mode: 0o600,
        flag: 'wx',
      });
    },
  })
  .compile();
const app = module.createNestApplication({ bodyParser: false });
configure(app);
app.enableShutdownHooks();
await app.listen(Number(process.env.API_PORT), '127.0.0.1');
