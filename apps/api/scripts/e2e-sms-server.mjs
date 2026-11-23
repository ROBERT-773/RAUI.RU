import 'reflect-metadata';
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { Test } from '@nestjs/testing';
import { AppModule } from '../dist/app.module.js';
import { configure } from '../dist/bootstrap.js';
import { PhoneOtpDelivery } from '../dist/modules/auth/phone-otp-delivery.js';

const db = new URL(process.env.DATABASE_URL ?? '');
const privateDirectory = process.env.LOCAL_PRIVATE_DIR;
if (
  process.env.NODE_ENV !== 'test' ||
  !['local', undefined].includes(process.env.DEPLOYMENT_ENV) ||
  !['localhost', '127.0.0.1'].includes(db.hostname) ||
  !/^\/raui_test_[0-9a-f]{16}$/.test(db.pathname) ||
  !privateDirectory
)
  throw new Error(
    'SMS browser fixture requires an isolated local test database',
  );

const module = await Test.createTestingModule({ imports: [AppModule] })
  .overrideProvider(PhoneOtpDelivery)
  .useValue({
    async send({ destination, challengeId, code }) {
      if (
        !/^\+700000000[0-9]{2}$/.test(destination) ||
        !/^[0-9a-f-]{36}$/.test(challengeId) ||
        !/^[0-9]{6}$/.test(code)
      )
        return 'unavailable';
      await writeFile(resolve(privateDirectory, 'sms-' + challengeId), code, {
        flag: 'wx',
        mode: 0o600,
      });
      return 'accepted';
    },
  })
  .compile();
const app = module.createNestApplication({ bodyParser: false });
configure(app);
app.enableShutdownHooks();
await app.listen(Number(process.env.API_PORT), '127.0.0.1');
