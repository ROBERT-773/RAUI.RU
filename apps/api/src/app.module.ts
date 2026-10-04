import { Module } from '@nestjs/common';
import { HealthController } from './health.controller';
import { Dependencies } from './dependencies';
@Module({ controllers: [HealthController], providers: [Dependencies] })
export class AppModule {}
