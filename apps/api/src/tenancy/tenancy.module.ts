import { Global, Module, type MiddlewareConsumer, type NestModule } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { TenantContextService } from './tenant-context.service';
import { TenantMiddleware } from './tenant.middleware';

@Global()
@Module({
  imports: [AuthModule],
  providers: [TenantContextService, TenantMiddleware],
  exports: [TenantContextService],
})
export class TenancyModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    consumer.apply(TenantMiddleware).forRoutes('*');
  }
}
