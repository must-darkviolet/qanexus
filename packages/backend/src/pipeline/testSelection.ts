/**
 * Which generated specs a pull-request review runs, in tiers.
 *
 *   Tier 1 - required: specs of modules whose own files the change touches,
 *            and specs the traceability graph links to a changed file.
 *   Tier 2 - related regression: modules the impact analysis reaches
 *            indirectly (a shared component, an importer), and the specs it
 *            names as related.
 *   Tier 3 - broader regression: everything else. Only for a cross-cutting
 *            change (dependencies, root layout, routing, auth plumbing) or
 *            when a full regression is explicitly requested.
 *
 * A spec is never selected merely because it has never passed: that rule made
 * every review run the whole suite once the suite was failing for an unrelated
 * reason (a login it could not get past). An empty selection stays empty and
 * is reported as such, never widened to "everything".
 */

export type SelectionTier = 1 | 2 | 3;

export interface TieredSpec {
  specFile: string;
  tier: SelectionTier;
  /** Why this spec is relevant to the change. */
  reasons: string[];
  /** The module (feature key) the spec belongs to. */
  feature: string;
}

export interface TieredSelection {
  specs: TieredSpec[];
  /** The highest tier included. */
  depth: SelectionTier;
  /** Why tier 3 was included, when it was. */
  broadReason: string | null;
}

/** The generated suite names a feature's spec tests/<feature>.spec.ts. */
export const featureOfSpec = (specFile: string): string =>
  specFile.split('/').pop()!.replace(/\.spec\.[cm]?[jt]sx?$/, '');

export function selectTieredSpecs(input: {
  availableSpecs: string[];
  changedFiles: string[];
  /** Modules the impact analysis found, with the files each owns. */
  affectedFeatures: { key: string; name: string; files: string[] }[];
  /** Spec -> reason, from the traceability graph (spec exercises a changed file). */
  traced: { specFile: string; reason: string }[];
  /** Specs the impact analysis names as related to the change. */
  related: { specFile: string; reason: string }[];
  /** Set for a cross-cutting change or an explicit request for full regression. */
  broadReason: string | null;
  /** The module a spec belongs to (from the test registry); defaults to its file name. */
  featureOf?: (specFile: string) => string;
}): TieredSelection {
  const featureOf = input.featureOf ?? featureOfSpec;
  const available = new Set(input.availableSpecs);
  const changed = new Set(input.changedFiles);
  const picked = new Map<string, TieredSpec>();
  const add = (specFile: string, tier: SelectionTier, reason: string) => {
    if (!available.has(specFile)) return;
    const existing = picked.get(specFile);
    if (existing) {
      existing.tier = Math.min(existing.tier, tier) as SelectionTier;
      if (!existing.reasons.includes(reason)) existing.reasons.push(reason);
      return;
    }
    picked.set(specFile, { specFile, tier, reasons: [reason], feature: featureOf(specFile) });
  };
  for (const f of input.affectedFeatures) {
    const own = f.files.filter((file) => changed.has(file));
    for (const spec of input.availableSpecs.filter((s) => featureOf(s) === f.key)) {
      if (own.length) add(spec, 1, `${f.name} owns the changed file(s) ${own.slice(0, 3).join(', ')}.`);
      else add(spec, 2, `${f.name} is reached indirectly by the change (shared code or an importer).`);
    }
  }
  for (const t of input.traced) add(t.specFile, 1, t.reason);
  for (const r of input.related) add(r.specFile, 2, r.reason);

  if (input.broadReason) {
    for (const spec of input.availableSpecs) add(spec, 3, `Broader regression: ${input.broadReason}`);
  }

  const specs = [...picked.values()].sort((a, b) => a.tier - b.tier || a.specFile.localeCompare(b.specFile));
  const depth = specs.reduce<SelectionTier>((d, s) => (s.tier > d ? s.tier : d), 1);
  return { specs, depth, broadReason: input.broadReason };
}
