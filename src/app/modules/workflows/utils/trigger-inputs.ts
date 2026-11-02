import { ContextMapping, EnrichmentBinding, WorkflowTemplate } from '../models/workflow-template.model';

export const CONTACT_PREFIX = 'contact.';

export type ContactKey = 'phone' | 'name' | 'email';

export interface EnrichmentInputField {
  /** Source key the value is collected under (e.g. "supplier_id"). */
  key: string;
  required: boolean;
}

/**
 * The values a trigger (CSV / API) must still supply for a template once Data
 * Function enrichments are accounted for. Mirrors the backend TriggerInputResolver —
 * keep the two in sync.
 */
export interface TriggerInputs {
  /** Contact fields to collect (those not produced by an enrichment). */
  contactKeys: ContactKey[];
  /** Context params to collect directly (those not produced by an enrichment). */
  contextParams: ContextMapping[];
  /** Deduped enrichment input source keys to collect (not produced by enrichment, not a context param). */
  enrichmentInputs: EnrichmentInputField[];
}

function enrichedContextKeys(enrichments: EnrichmentBinding[]): Set<string> {
  const out = new Set<string>();
  for (const b of enrichments) {
    if (b.acceptInputs) continue; // field keeps its own sheet column — see resolveTriggerInputs
    for (const target of Object.values(b.outputBindings ?? {})) {
      if (target && !target.startsWith(CONTACT_PREFIX)) out.add(target);
    }
  }
  return out;
}

function enrichedContactFields(enrichments: EnrichmentBinding[]): Set<string> {
  const out = new Set<string>();
  for (const b of enrichments) {
    if (b.acceptInputs) continue;
    for (const target of Object.values(b.outputBindings ?? {})) {
      if (target?.startsWith(CONTACT_PREFIX)) out.add(target.slice(CONTACT_PREFIX.length));
    }
  }
  return out;
}

/**
 * Maps a context mapping's field name to the contact kind it's an alias for (e.g. "contact_name" ->
 * "name"), by matching its JSON path against the template's own contact extraction config — the same
 * pairing `onAgentFieldSheetToggle` sets up when a contact-kind Exchange field is added to the sheet.
 */
function contactKeyForFieldName(fieldName: string, cfg: WorkflowTemplate['contactExtractionConfig']): ContactKey | null {
  if (!cfg) return null;
  const path = `$.${fieldName}`;
  if (cfg.phoneJsonPath === path) return 'phone';
  if (cfg.nameJsonPath === path) return 'name';
  if (cfg.emailJsonPath === path) return 'email';
  return null;
}

export function resolveTriggerInputs(template: WorkflowTemplate): TriggerInputs {
  const enrichments = template.enrichments ?? [];
  const contextMappings = template.contextMappings ?? [];
  const contactCfg = template.contactExtractionConfig;

  const producedCtx = enrichedContextKeys(enrichments);
  const producedContact = enrichedContactFields(enrichments);
  const contextParamNames = new Set(contextMappings.map((m) => m.fieldName));

  // A contact kind already collected via one of its own literal context-mapping aliases (e.g.
  // "contact_phone", sharing the same JSON path as contactExtractionConfig.phoneJsonPath) doesn't
  // need its own separate "phone" column too — that would ask for the same value twice.
  const aliasedKinds = new Set(
    contextMappings
      .map((m) => contactKeyForFieldName(m.fieldName, contactCfg))
      .filter((k): k is ContactKey => k !== null)
  );
  const contactKeys = (['phone', 'name', 'email'] as ContactKey[]).filter(
    (k) => !producedContact.has(k) && !aliasedKinds.has(k)
  );

  const contextParams = contextMappings.filter((m) => {
    if (producedCtx.has(m.fieldName)) return false;
    const kind = contactKeyForFieldName(m.fieldName, contactCfg);
    if (kind && producedContact.has(kind)) return false;
    return true;
  });

  // Deduped enrichment input source keys: context-typed, not chained, not a context param.
  const inputRequired = new Map<string, boolean>();
  for (const b of enrichments) {
    for (const source of Object.values(b.inputBindings ?? {})) {
      if (!source || source.startsWith(CONTACT_PREFIX)) continue;
      if (producedCtx.has(source)) continue; // produced by another enrichment
      if (contextParamNames.has(source)) continue; // collected as a context param instead
      inputRequired.set(source, (inputRequired.get(source) ?? false) || b.required);
    }
  }
  const enrichmentInputs = Array.from(inputRequired.entries()).map(([key, required]) => ({ key, required }));

  return { contactKeys, contextParams, enrichmentInputs };
}
