import { readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { CommandModule, ComponentHandler, Feature, FeatureContext } from "./feature.js";

export interface LoadedFeatures {
  features: Feature[];
  commands: Map<string, CommandModule>;
  components: ComponentHandler[];
}

const FEATURES_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "features");

/**
 * Discovers every `src/features/<name>/index.ts` and wires it up. Adding a
 * feature therefore never requires touching core -- drop in a folder and it
 * loads on next boot.
 */
export async function loadFeatures(ctx: FeatureContext): Promise<LoadedFeatures> {
  const entries = await readdir(FEATURES_DIR, { withFileTypes: true });
  const features: Feature[] = [];
  const commands = new Map<string, CommandModule>();
  const components: ComponentHandler[] = [];

  for (const entry of entries
    .filter((e) => e.isDirectory())
    .sort((a, b) => a.name.localeCompare(b.name))) {
    // tsx/node resolve the .js specifier back to the .ts source in dev.
    const moduleUrl = pathToFileURL(join(FEATURES_DIR, entry.name, "index.js")).href;
    const mod = (await import(moduleUrl)) as { default?: Feature };
    const feature = mod.default;

    if (!feature?.name) {
      ctx.logger.warn({ folder: entry.name }, "Skipping feature: no default export with a name");
      continue;
    }

    if (feature.enabled && !feature.enabled(ctx.env)) {
      ctx.logger.info({ feature: feature.name }, "Feature disabled by config");
      continue;
    }

    for (const command of feature.commands ?? []) {
      const name = command.data.name;
      const existing = commands.get(name);
      if (existing) {
        // Two features claiming one command name means one silently wins at
        // runtime. Fail loudly at boot instead.
        throw new Error(`Duplicate slash command "/${name}" (feature "${feature.name}")`);
      }
      commands.set(name, command);
    }

    for (const handler of feature.components ?? []) {
      const clash = components.find((c) => c.prefix === handler.prefix);
      if (clash) {
        throw new Error(
          `Duplicate component prefix "${handler.prefix}" (feature "${feature.name}")`,
        );
      }
      components.push(handler);
    }

    features.push(feature);
  }

  // init() after all features load, so a failure in one is reported with every
  // other feature's name already known.
  for (const feature of features) {
    await feature.init?.(ctx);
    ctx.logger.info(
      { feature: feature.name, commands: feature.commands?.length ?? 0 },
      "Feature loaded",
    );
  }

  return { features, commands, components };
}
