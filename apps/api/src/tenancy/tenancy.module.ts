import { Global, Module, type MiddlewareConsumer, type NestModule } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { TenantContextService } from './tenant-context.service';
import { TenantMiddleware } from './tenant.middleware';
import { TenantResolverService } from './tenant-resolver.service';

@Global()
@Module({
  imports: [AuthModule],
  providers: [TenantContextService, TenantMiddleware, TenantResolverService],
  exports: [TenantContextService, TenantResolverService],
})
export class TenancyModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    consumer.apply(TenantMiddleware).forRoutes('*');
  }
}
