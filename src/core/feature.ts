import type {
  ChatInputCommandInteraction,
  ClientEvents,
  MessageComponentInteraction,
  ModalSubmitInteraction,
  SlashCommandBuilder,
  SlashCommandOptionsOnlyBuilder,
  SlashCommandSubcommandsOnlyBuilder,
} from "discord.js";
import type { DatabaseSync } from "node:sqlite";
import type { Env } from "./env.js";
import type { Logger } from "./logger.js";

/** Injected into every feature. Keeps features testable without a live gateway. */
export interface FeatureContext {
  db: DatabaseSync;
  env: Env;
  logger: Logger;
}

export type CommandBuilder =
  SlashCommandBuilder | SlashCommandOptionsOnlyBuilder | SlashCommandSubcommandsOnlyBuilder;

export interface CommandModule {
  data: CommandBuilder;
  execute(interaction: ChatInputCommandInteraction, ctx: FeatureContext): Promise<void>;
}

export interface EventModule<K extends keyof ClientEvents = keyof ClientEvents> {
  name: K;
  once?: boolean;
  execute(ctx: FeatureContext, ...args: ClientEvents[K]): Promise<void>;
}

/**
 * Handles button/select/modal interactions whose custom_id starts with `prefix`.
 * Prefixes must be unique across features; the registry enforces that at boot.
 */
export interface ComponentHandler {
  prefix: string;
  execute(
    interaction: MessageComponentInteraction | ModalSubmitInteraction,
    ctx: FeatureContext,
  ): Promise<void>;
}

/**
 * The entire extension surface. A new feature is one folder exporting one of
 * these -- no edits to core code, which is the property that keeps the bot
 * cheap to grow.
 */
export interface Feature {
  name: string;
  description: string;
  /** Kill-switch: return false to leave the feature dormant without deleting it. */
  enabled?: (env: Env) => boolean;
  commands?: CommandModule[];
  events?: EventModule[];
  components?: ComponentHandler[];
  /** Runs once at boot, before login. Create tables and start timers here. */
  init?: (ctx: FeatureContext) => Promise<void> | void;
}

export function defineFeature(feature: Feature): Feature {
  return feature;
}
