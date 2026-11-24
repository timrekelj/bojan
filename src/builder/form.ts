import { DEFAULT_BUILDER_MODEL, type BuilderSettings } from '../db.js';
import { parseModelRef } from './parse.js';

/** Parse the dashboard "Self-building" form. An invalid model keeps `current` (the saved value). */
export function parseBuilderForm(form: Record<string, unknown>, current: BuilderSettings): { settings: BuilderSettings; modelError: string | null } {
  const raw = typeof form.model === 'string' ? form.model.trim() : '';
  const enabled = form.enabled === '1';
  if (raw === '') return { settings: { enabled, model: DEFAULT_BUILDER_MODEL }, modelError: null };
  if (!parseModelRef(raw) || /\s/.test(raw)) return { settings: { enabled, model: current.model }, modelError: 'Model must look like provider/model' };
  return { settings: { enabled, model: raw }, modelError: null };
}
