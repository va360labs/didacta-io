import { Injectable, Logger } from '@nestjs/common';
import type {
  ModuleDidactaConfig,
  ModuleHttpConfig,
} from '../module-manifest.schema';
import type { ModuleJobTickHandler } from './mod-jobs.types';

/// Configuración que el `InstallPackageService` registra junto al handler
/// para que el worker pueda armar el ctx scoped sin volver a Postgres.
/// Mismo patrón que `RegisteredRoute` en `ModuleRouterService`: lo que
/// importa para construir clients (db, http, didacta) viaja con el
/// registro, no se vuelve a leer en cada tick.
export interface ModuleJobLifecycleEntry {
  handler: ModuleJobTickHandler;
  manifest: {
    /// `manifest.http` (alpha.49). NULL si el módulo no declara HTTP
    /// saliente — el worker inyecta `BlockedSandboxedHttp`.
    httpConfig: ModuleHttpConfig | null;
    /// `manifest.requiresDb` (alpha.51). Si false → `BlockedSandboxedDb`.
    dbEnabled: boolean;
    /// `manifest.tablePrefix` — siempre presente. Necesario para armar
    /// el cliente scoped en SandboxedDbService.
    tablePrefix: string;
    /// `manifest.didacta` (alpha.52). NULL si el módulo no declara la
    /// API pública del core — el worker inyecta `BlockedDidactaApi`.
    didactaConfig: ModuleDidactaConfig | null;
    /// Versión del módulo. Se inyecta en el ctx.moduleVersion para que
    /// el handler pueda branch lógica condicional a la versión instalada.
    moduleVersion: string;
  };
}

/// Registro runtime de los `onJobTick` declarados por módulos third-party.
/// El `InstallPackageService` registra al instalar un módulo; el
/// `ModJobsWorkerService` lee al procesar cada job.
///
/// Mismo patrón que `ModuleRouterService.registerModule`: per-module
/// (un solo handler por nombre), upgrade in-place reemplaza al previo.
/// Al desinstalar un módulo se borra el handler — los jobs encolados
/// que lleguen al worker después se descartan con log de warning.
@Injectable()
export class ModuleJobLifecycleRegistry {
  private readonly logger = new Logger(ModuleJobLifecycleRegistry.name);
  private readonly entries = new Map<string, ModuleJobLifecycleEntry>();

  /// Registra el handler de un módulo. Si ya había un registro previo
  /// (caso upgrade in-place), se reemplaza — la versión nueva queda
  /// activa para el próximo job que entre.
  register(
    moduleName: string,
    handler: ModuleJobTickHandler,
    manifest: ModuleJobLifecycleEntry['manifest'],
  ): void {
    const existed = this.entries.has(moduleName);
    this.entries.set(moduleName, { handler, manifest });
    this.logger.log(
      `Módulo "${moduleName}" ${existed ? 're-registró' : 'registró'} onJobTick (db=${manifest.dbEnabled ? 'enabled' : 'blocked'}, http=${manifest.httpConfig ? 'enabled' : 'blocked'}, didacta=${manifest.didactaConfig ? 'enabled' : 'blocked'}, version=${manifest.moduleVersion}).`,
    );
  }

  /// Borra el handler. Idempotente — si no existía, no-op silencioso.
  unregister(moduleName: string): void {
    const had = this.entries.delete(moduleName);
    if (had) {
      this.logger.log(`Módulo "${moduleName}" desregistró onJobTick.`);
    }
  }

  /// Busca el entry registrado. Devuelve undefined si el módulo no está
  /// registrado (desinstalado, nunca instalado, o instalado sin
  /// `jobLifecycle` en su manifest).
  get(moduleName: string): ModuleJobLifecycleEntry | undefined {
    return this.entries.get(moduleName);
  }

  /// Listado para diagnostics / admin endpoints. NO usar en hot path
  /// del worker — usar `get()` directo.
  list(): Array<{ moduleName: string; moduleVersion: string }> {
    return Array.from(this.entries.entries()).map(([name, entry]) => ({
      moduleName: name,
      moduleVersion: entry.manifest.moduleVersion,
    }));
  }
}
