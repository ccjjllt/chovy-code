#!/usr/bin/env bun
import { Command } from "commander";
import { render } from "ink";
import { version } from "../version.js";
import { loadConfig } from "../config/index.js";
import { logger } from "../logger/index.js";
import { listProviders } from "../providers/index.js"; // side-effect: registers providers
import { listTools } from "../tools/index.js"; // side-effect: registers tools
import { AgentRepl } from "./components/AgentRepl.js";
import type { ProviderId } from "../types/index.js";

// Force import side effects even when tree-shaking is aggressive.
void listProviders;
void listTools;

const program = new Command();

program
  .name("chovy")
  .description("A coding agent built with Bun + TypeScript + React/Ink.")
  .version(version)
  .argument("[prompt]", "one-shot prompt to run")
  .option("-p, --provider <id>", "provider: openai|anthropic|gemini|deepseek|minimax|glm|kimi")
  .option("-m, --model <id>", "override the provider's default model")
  .option("-v, --verbose", "enable debug logging")
  .action((prompt: string | undefined, opts: {
    provider?: string;
    model?: string;
    verbose?: boolean;
  }) => {
    if (opts.verbose) logger.setLevel("debug");
    const config = loadConfig();

    const provider = (opts.provider ?? config.provider) as ProviderId;
    const model = opts.model ?? config.model;

    if (!prompt) {
      // No prompt: print a friendly banner + available providers/tools.
      program.outputHelp();
      logger.info(`providers: ${listProviders().map((p) => p.info.id).join(", ")}`);
      logger.info(`tools: ${listTools().map((t) => t.name).join(", ") ?? "(none)"}`);
      logger.info("Run `chovy \"your prompt here\"` to start.");
      return;
    }

    logger.debug(`provider=${provider} model=${model ?? "(default)"}`);
    render(
      <AgentRepl prompt={prompt} provider={provider} model={model} />,
      { exitOnCtrlC: true },
    );
  });

program.parseAsync(process.argv).catch((err: unknown) => {
  logger.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
