import {
  Controller,
  Get,
  ServiceUnavailableException,
  Header,
} from '@nestjs/common';
import { Dependencies } from './dependencies';
@Controller('health')
export class HealthController {
  constructor(private readonly dependencies: Dependencies) {}
  @Get() @Header('Cache-Control', 'no-store') live() {
    return { status: 'ok', service: 'api' };
  }
  @Get('ready') @Header('Cache-Control', 'no-store') async ready() {
    try {
      await this.dependencies.check();
      return {
        status: 'ok',
        service: 'api',
        dependencies: { postgres: 'ok', redis: 'ok' },
      };
    } catch {
      throw new ServiceUnavailableException('Dependencies unavailable');
    }
  }
}
