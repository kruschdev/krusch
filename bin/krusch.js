#!/usr/bin/env node

import { Command } from 'commander';
import chalk from 'chalk';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.resolve(__dirname, '../.env'), quiet: true });

import { KruschStateMachine } from '../src/workflow/state-machine.js';
import { KruschCascadeRouter, DEFAULT_SPECIALISTS } from '../src/router/cascade.js';
import { KruschStateManager } from '../src/brain/state-manager.js';
import { startMcpServer } from '../src/server/mcp-server.js';
import { migrate } from '../db/migrate.js';

const program = new Command();

program
  .name('krusch')
  .description('The sovereign, PostgreSQL-grounded coding harness for interchangeable LLMs')
  .version('1.0.0');

// 1. krusch run
program
  .command('run <goal>')
  .description('Execute an engineering task through the Krusch invariant harness')
  .option('-m, --model <id>', 'Override model specialist')
  .option('-t, --max-turns <turns>', 'Maximum turns budget', '10')
  .option('-a, --auto-approve', 'Automatically approve staged diffs and actions', false)
  .option('--mock', 'Run with local deterministic mock adapter', false)
  .action(async (goal, options) => {
    console.log(chalk.bold.cyan('\n⚡ KRUSCH CODING HARNESS ⚡'));
    console.log(chalk.gray(`Goal: "${goal}"`));
    console.log(chalk.gray(`Substrate: PostgreSQL (${process.env.DATABASE_URL || 'default kdcode'})`));

    const harness = new KruschStateMachine({
      autoApprove: options.autoApprove,
      useMock: options.mock,
    });

    try {
      const result = await harness.runTask({
        goal,
        projectPath: process.cwd(),
        maxTurns: parseInt(options.maxTurns, 10),
        modelOverride: options.model,
      });

      console.log('\n' + chalk.bold.green('✓ Task Execution Finished:'));
      console.log(`  Task ID:        ${chalk.yellow(result.taskId)}`);
      console.log(`  Final Phase:    ${chalk.cyan(result.status)}`);
      console.log(`  Turns Executed: ${result.turnsExecuted}`);
      console.log(`  Staged Diffs:   ${result.stagedDiffsCount}`);
      console.log(`  Final Model:    ${chalk.magenta(result.finalModel)}\n`);
      process.exit(0);
    } catch (err) {
      console.error(chalk.red(`\n✗ Harness Execution Error: ${err.message}`));
      process.exit(1);
    }
  });

// 2. krusch route
program
  .command('route <prompt>')
  .description('Inspect cascade router decision for a prompt without executing it')
  .action((prompt) => {
    const router = new KruschCascadeRouter();
    const route = router.route(prompt);
    console.log(chalk.bold.cyan('\n🎯 Cascade Router Dispatch Decision:'));
    console.log(`  Stage:       ${chalk.green(route.stage)}`);
    console.log(`  Model:       ${chalk.yellow(route.modelId)}`);
    console.log(`  Role:        ${chalk.magenta(route.role)}`);
    console.log(`  Confidence:  ${route.confidence}`);
    console.log(`  Rationale:   ${chalk.gray(route.rationale)}\n`);
    process.exit(0);
  });

// 3. krusch models
program
  .command('models')
  .description('List current specialist model pool and routing mappings')
  .action(() => {
    console.log(chalk.bold.cyan('\n📋 Active Specialist Model Pool:'));
    for (const [role, model] of Object.entries(DEFAULT_SPECIALISTS)) {
      console.log(`  ${chalk.bold(role.padEnd(16))}: ${chalk.yellow(model)}`);
    }
    console.log();
    process.exit(0);
  });

// 4. krusch status
program
  .command('status <taskId>')
  .description('Inspect task execution details, turns, and staged diffs from PostgreSQL')
  .action(async (taskId) => {
    try {
      const task = await KruschStateManager.getTask(taskId);
      if (!task) {
        console.error(chalk.red(`Task not found: ${taskId}`));
        process.exit(1);
      }
      console.log(chalk.bold.cyan(`\n📦 Task Status: ${task.id}`));
      console.log(`  Goal:          ${task.goal}`);
      console.log(`  Phase:         ${chalk.yellow(task.phase)}`);
      console.log(`  Active Model:  ${task.current_model || 'none'}`);
      console.log(`  Turns:         ${task.turns.length}`);
      console.log(`  Staged Diffs:  ${task.stagedDiffs.length}`);
      console.log(`  Approvals:     ${task.approvals.length}`);
      console.log(`  Verifications: ${task.verifications.length}\n`);
      process.exit(0);
    } catch (err) {
      console.error(chalk.red(`Error inspecting task: ${err.message}`));
      process.exit(1);
    }
  });

// 5. krusch mcp
program
  .command('mcp')
  .description('Start Model Context Protocol (MCP) server over stdio')
  .action(async () => {
    await startMcpServer();
  });

// 6. krusch migrate
program
  .command('migrate')
  .description('Run PostgreSQL schema migrations for Krusch')
  .action(async () => {
    await migrate();
    process.exit(0);
  });

program.parse(process.argv);
