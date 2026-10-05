import { SearchModule } from './modules/search/search';
import { GeoLayersModule } from './modules/geo/layers';
import { ProductModule } from './modules/product/product';
import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { HealthController } from './health.controller';
import { Dependencies } from './dependencies';
import { DatabaseModule } from './modules/database/database';
import { AuditModule } from './modules/audit/audit';
import { AuthModule } from './modules/auth/auth';
import { OrganizationsModule } from './modules/organizations/organizations';
import { PropertiesModule } from './modules/properties/properties';
import { StructuresModule } from './modules/properties/structures';
import { CatalogModule } from './modules/catalog/catalog';
import { GeoModule } from './modules/geo/geo';
import { MediaModule } from './modules/media/media';
import { ListingsModule } from './modules/listings/listings';
import { AdminModule } from './modules/admin/admin';
import { RateGuard, SessionGuard } from './common/security';
@Module({
  imports: [
    DatabaseModule,
    AuditModule,
    AuthModule,
    OrganizationsModule,
    PropertiesModule,
    StructuresModule,
    CatalogModule,
    GeoModule,
    MediaModule,
    ListingsModule,
    AdminModule,
    SearchModule,
    ProductModule,
    GeoLayersModule,
  ],
  controllers: [HealthController],
  providers: [
    Dependencies,
    { provide: APP_GUARD, useClass: RateGuard },
    { provide: APP_GUARD, useClass: SessionGuard },
  ],
})
export class AppModule {}
