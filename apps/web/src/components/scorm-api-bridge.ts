/**
 * Copyright (c) VA360 LABS S.L.
 * SPDX-License-Identifier: LicenseRef-Didacta-Sustainable-Use
 */

/**
 * SCORM 1.2 runtime API expuesta al iframe del paquete via `window.API`.
 *
 * El paquete SCORM busca `window.API` (1.2) o `window.API_1484_11` (2004) en
 * la chain `window.parent` cuando arranca. Si lo encuentra, llama a
 * LMSInitialize/LMSGetValue/LMSSetValue/LMSCommit/LMSFinish para reportar
 * progreso y score.
 *
 * Esta implementación cubre **SCORM 1.2** completo y **2004** mínimo (suficiente
 * para que paquetes simples funcionen — completion_status + score.scaled). El
 * scope de runtime full 2004 (interactions, sequencing, navigation requests)
 * queda como follow-up.
 *
 * Cómo se usa desde el componente React del player:
 *   const bridge = createScormBridge({ onCommit: async (cmi) => {...} });
 *   bridge.attach(window);    // antes de cargar el iframe
 *   // ...iframe carga y llama window.API.LMSInitialize, etc.
 *   bridge.detach();          // al desmontar
 */

export interface ScormBridgeOptions {
  /** State inicial del cmi (cargado desde el server al iniciar el attempt). */
  initialCmi: Record<string, string>;
  /** Llamado cuando el SCO hace LMSCommit. Debe persistir en el server. */
  onCommit: (cmi: Record<string, string>) => Promise<void> | void;
  /** Llamado cuando el SCO hace LMSFinish (lo trata como commit final). */
  onFinish?: (cmi: Record<string, string>) => Promise<void> | void;
  /** Llamado en cada SetValue (útil para diagnostic). */
  onSetValue?: (key: string, value: string) => void;
}

interface ScormApi12 {
  LMSInitialize(param: ''): 'true' | 'false';
  LMSFinish(param: ''): 'true' | 'false';
  LMSGetValue(key: string): string;
  LMSSetValue(key: string, value: string): 'true' | 'false';
  LMSCommit(param: ''): 'true' | 'false';
  LMSGetLastError(): string;
  LMSGetErrorString(code: string): string;
  LMSGetDiagnostic(code: string): string;
}

interface ScormApi2004 {
  Initialize(param: ''): 'true' | 'false';
  Terminate(param: ''): 'true' | 'false';
  GetValue(key: string): string;
  SetValue(key: string, value: string): 'true' | 'false';
  Commit(param: ''): 'true' | 'false';
  GetLastError(): string;
  GetErrorString(code: string): string;
  GetDiagnostic(code: string): string;
}

interface ScormBridgeHandle {
  attach(target: Window): void;
  detach(): void;
}

declare global {
  interface Window {
    API?: ScormApi12;
    API_1484_11?: ScormApi2004;
  }
}

/**
 * Errores SCORM comunes (1.2):
 *   0   = no error
 *   101 = general exception
 *   201 = invalid argument error
 *   401 = not implemented error
 */
export function createScormBridge(opts: ScormBridgeOptions): ScormBridgeHandle {
  const cmi: Record<string, string> = { ...opts.initialCmi };
  let initialized = false;
  let lastError = '0';
  let attached: Window | null = null;

  function commit(): void {
    Promise.resolve(opts.onCommit({ ...cmi })).catch(() => {
      // El commit falló — el SCO no lo nota. Dejamos un best-effort.
    });
  }

  const api12: ScormApi12 = {
    LMSInitialize: () => {
      if (initialized) {
        lastError = '101';
        return 'false';
      }
      initialized = true;
      lastError = '0';
      return 'true';
    },
    LMSFinish: () => {
      if (!initialized) {
        lastError = '301';
        return 'false';
      }
      initialized = false;
      Promise.resolve(opts.onFinish?.({ ...cmi }) ?? opts.onCommit({ ...cmi })).catch(() => {});
      lastError = '0';
      return 'true';
    },
    LMSGetValue: (key) => {
      lastError = '0';
      return cmi[key] ?? '';
    },
    LMSSetValue: (key, value) => {
      cmi[key] = String(value);
      opts.onSetValue?.(key, String(value));
      lastError = '0';
      return 'true';
    },
    LMSCommit: () => {
      if (!initialized) {
        lastError = '301';
        return 'false';
      }
      commit();
      lastError = '0';
      return 'true';
    },
    LMSGetLastError: () => lastError,
    LMSGetErrorString: (code) => SCORM_12_ERRORS[code] ?? '',
    LMSGetDiagnostic: (code) => SCORM_12_ERRORS[code] ?? '',
  };

  const api2004: ScormApi2004 = {
    Initialize: api12.LMSInitialize,
    Terminate: api12.LMSFinish,
    GetValue: api12.LMSGetValue,
    SetValue: api12.LMSSetValue,
    Commit: api12.LMSCommit,
    GetLastError: api12.LMSGetLastError,
    GetErrorString: api12.LMSGetErrorString,
    GetDiagnostic: api12.LMSGetDiagnostic,
  };

  return {
    attach(target) {
      attached = target;
      target.API = api12;
      target.API_1484_11 = api2004;
    },
    detach() {
      if (!attached) return;
      try {
        delete attached.API;
        delete attached.API_1484_11;
      } catch {
        // En Edge antiguos no se puede delete; ignorable.
      }
      attached = null;
    },
  };
}

const SCORM_12_ERRORS: Record<string, string> = {
  '0': 'No error',
  '101': 'General exception',
  '201': 'Invalid argument error',
  '301': 'Not initialized',
  '401': 'Not implemented error',
  '402': 'Invalid set value, element is a keyword',
  '403': 'Element is read only',
  '404': 'Element is write only',
  '405': 'Incorrect data type',
};
