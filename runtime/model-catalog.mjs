import { createHash } from 'node:crypto';
import * as v from '../core/validation.js';

export const modelVariantId = (provider, model, reasoningEffort = null) => 'rte_' + createHash('sha256').update(JSON.stringify([provider, model, reasoningEffort])).digest('hex').slice(0, 32);
export const sameModelVariant = (a, b) => a?.provider === b?.provider && a?.model === b?.model && (a?.reasoningEffort ?? null) === (b?.reasoningEffort ?? null);
export const requiresModelCatalog = action => ['admin.upsertRoute', 'admin.createUser', 'admin.createInvite', 'admin.updateUser', 'admin.batchUpdateAccess', 'projects.create', 'projects.open', 'routes.select', 'terminal.open'].includes(action);

/** Read-only adapter metadata catalog. Never discovers draft endpoints, changes
 * provider configuration or invokes a model. An unresolved provider/model is
 * omitted, never converted into a caller-supplied or guessed model route. */
export class ModelCatalog {
  #llm; #pending; #snapshot = []; #warnings = [];
  status() { return { available: this.#snapshot.length, warnings: structuredClone(this.#warnings) }; }
  constructor({ llm }) {
    if (!llm || typeof llm.listProviders !== 'function' || typeof llm.listModels !== 'function' || typeof llm.resolveModelInfo !== 'function') throw new TypeError('ModelCatalog requires the actual read-only LLM metadata methods.');
    this.#llm = llm;
  }
  snapshot() { return structuredClone(this.#snapshot); }
  async refresh() {
    if (this.#pending) return this.#pending;
    const operation = this.#read(); this.#pending = operation;
    try { return structuredClone(await operation); } finally { if (this.#pending === operation) this.#pending = undefined; }
  }
  async #read() {
    const variants = [], seen = new Set(), warnings = [];
    let providers;
    try { providers = v.list(await this.#llm.listProviders(), 1024); }
    catch { this.#snapshot = []; this.#warnings = [{ code: 'CATALOG_UNAVAILABLE', message: 'The configured model directory is unavailable.' }]; return []; }
    for (const provider of providers) {
      try {
        const providerId = v.key(provider.id), providerName = v.text(provider.name, 'provider name', 160);
        const models = v.list(await this.#llm.listModels(providerId), 1024);
        for (const model of models) {
          try {
            if (model.provider !== providerId) continue;
            const modelId = v.text(model.id, 'model id', 256);
            const resolved = await this.#llm.resolveModelInfo(providerId, modelId);
            if (resolved.provider !== providerId || resolved.id !== modelId) continue;
            const modelName = v.text(resolved.name, 'model name', 160);
            const efforts = resolved.reasoning === undefined ? [] : v.list(resolved.reasoning.efforts, 32).map(effort => ({
              id: v.key(effort.id), name: v.text(effort.name, 'reasoning effort name', 160),
            }));
            // Native model selection offers the provider's default when this
            // model declares levels without a fixed defaultEffort. Authorize
            // that distinct, omitted-effort request as well as explicit levels.
            if (resolved.reasoning?.defaultEffort === undefined) efforts.unshift({ id: null, name: null });
            for (const effort of efforts) {
              const reasoningEffort = effort.id === null ? null : v.key(effort.id);
              const effortName = effort.name === null ? null : v.text(effort.name, 'reasoning effort name', 160);
              const id = modelVariantId(providerId, modelId, reasoningEffort); if (seen.has(id)) continue;
              seen.add(id);
              variants.push({ id, label: `${providerName} · ${modelName}${effortName ? ` · ${effortName}` : ''}`.slice(0, 160).trim(), provider: providerId, providerName, model: modelId, modelName, reasoningEffort, effortName });
              if (variants.length > 1024) throw new Error('Model variant catalog exceeds its bound.');
            }
          } catch { warnings.push({ code: 'MODEL_METADATA_UNAVAILABLE', message: 'A configured model has unavailable capability metadata.' }); }
        }
      } catch { warnings.push({ code: 'PROVIDER_MODELS_UNAVAILABLE', message: 'A configured provider model directory is unavailable.' }); }
    }
    const result = v.modelCatalog(variants.slice(0, 1024)).sort((a, b) => a.id.localeCompare(b.id));
    this.#snapshot = structuredClone(result); this.#warnings = warnings.slice(0, 64); return result;
  }
}
