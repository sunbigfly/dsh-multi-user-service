import * as v from '../core/validation.js';
import { reject } from '../core/errors.js';

const CHECKS = new Set(['native-sandbox', 'member-directory-boundary']);
const CODES = new Set(['ISOLATION_UNAVAILABLE', 'SUPERVISOR_UNAVAILABLE', 'SUPERVISOR_TIMEOUT', 'INVALID_DISTRIBUTION', 'RUNTIME_UNAVAILABLE', 'RUNTIME_EXITED', 'WORKER_CHANNEL_CLOSED', 'RESOURCE_STOP_UNCONFIRMED', 'CANCELLED', 'HOME_ROOT_OVERLAP', 'UNSAFE_PROJECT_ROOT', 'INVALID_PROJECT_ROOT']);

/** User-only initialization of the real enforcement backend, shared by both
 * carriers. No project, account grant, model request or host fallback is created.
 * Live admin and CSRF authority remain held until the bounded probe settles. */
export function createIsolationCheck({ core, runtime, now = Date.now }) {
  if (!core?.runAdministratorOperation || !runtime?.start) throw new TypeError('Isolation checks require the trusted core and runtime.');
  let report = null;
  const snapshot = () => {
    if (runtime.ready === true && report?.status !== 'failed') return { status: 'ready', checkedAt: report?.checkedAt ?? null, checks: [...CHECKS].filter(check => runtime.capabilities?.checks?.includes(check)), restartRequired: false };
    const restartRequired = runtime.closed === true || runtime.closing === true || Boolean(runtime.failed);
    if (report || restartRequired) return { status: 'failed', checkedAt: report?.checkedAt ?? null, checks: [], code: report?.status === 'failed' ? report.code : 'RUNTIME_UNAVAILABLE', restartRequired };
    return { status: 'unchecked', checkedAt: null, checks: [], restartRequired: false };
  };
  async function check(request, caller) {
    v.object(request, ['action']);
    if (request.action !== 'admin.checkIsolation') reject('UNKNOWN_ACTION', 'Unknown isolation check action.', 404);
    return core.runAdministratorOperation(caller, async () => {
      try {
        const result = await runtime.start();
        if (runtime.ready !== true || result?.ready !== true || result.backend !== 'dsh-native') reject('ISOLATION_UNAVAILABLE', 'Native DSH execution was not confirmed.', 503);
        report = { status: 'ready', checkedAt: now(), checks: [...CHECKS].filter(check => result.checks?.includes(check)), restartRequired: false };
      } catch (error) {
        report = { status: 'failed', checkedAt: now(), checks: [], code: CODES.has(error?.code) ? error.code : 'ISOLATION_UNAVAILABLE', restartRequired: runtime.closed === true || runtime.closing === true || Boolean(runtime.failed) };
      }
      return snapshot();
    });
  }
  return { check, snapshot };
}
