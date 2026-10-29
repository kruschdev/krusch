import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';

/**
 * Default path to the 100-trajectory golden evaluation fixture corpus.
 */
export const DEFAULT_GOLDEN_FIXTURE_PATH = fileURLToPath(
  new URL('../../test/fixtures/golden-trajectories-100.json', import.meta.url)
);

/**
 * Resolve a direct or dot-delimited field path from a tool step's `args` object.
 *
 * @param {Record<string, unknown>} args
 * @param {string | undefined} field
 * @returns {unknown}
 */
function resolveArgField(args, field) {
  if (!field) {
    return args;
  }
  if (!args || typeof args !== 'object') {
    return undefined;
  }
  if (Object.prototype.hasOwnProperty.call(args, field)) {
    return args[field];
  }
  if (typeof field === 'string' && field.includes('.')) {
    const segments = field.split('.');
    let cursor = args;
    for (const seg of segments) {
      if (cursor === null || cursor === undefined || typeof cursor !== 'object') {
        return undefined;
      }
      if (!Object.prototype.hasOwnProperty.call(cursor, seg)) {
        return undefined;
      }
      cursor = cursor[seg];
    }
    return cursor;
  }
  return undefined;
}

/**
 * Check whether an extracted argument value contains a target substring or element.
 *
 * @param {unknown} actualValue
 * @param {unknown} pattern
 * @returns {boolean}
 */
function valueContainsPattern(actualValue, pattern) {
  if (actualValue === undefined || actualValue === null) {
    return false;
  }
  const needle = String(pattern);
  if (typeof actualValue === 'string') {
    return actualValue.includes(needle);
  }
  if (Array.isArray(actualValue)) {
    return actualValue.some(
      (item) =>
        isDeepStrictEqual(item, pattern) ||
        (typeof item === 'string' && item.includes(needle))
    );
  }
  if (typeof actualValue === 'object') {
    return JSON.stringify(actualValue).includes(needle);
  }
  return String(actualValue).includes(needle);
}

/**
 * Deterministically evaluate a single recorded/simulated agent trajectory against
 * all 6 Golden DAG invariants:
 *   1. `requiredTools`
 *   2. `forbiddenTools`
 *   3. `precedenceEdges`
 *   4. `requirePassingPrerequisite`
 *   5. `argGuards` (`mustContain`, `mustNotContain`, `equals`)
 *   6. `maxSteps`
 *
 * @param {object} trajectory
 * @returns {{
 *   id: string,
 *   category: string,
 *   passed: boolean,
 *   stepCount: number,
 *   executedTools: string[],
 *   violations: Array<Record<string, unknown>>
 * }}
 */
export function evaluateSingleTrajectoryDag(trajectory) {
  if (!trajectory || typeof trajectory !== 'object') {
    return {
      id: 'unknown',
      category: 'unknown',
      passed: false,
      stepCount: 0,
      executedTools: [],
      violations: [
        {
          rule: 'invalidTrajectory',
          message: 'Trajectory entry must be a non-null object.'
        }
      ]
    };
  }

  const id =
    typeof trajectory.id === 'string' && trajectory.id.trim().length > 0
      ? trajectory.id.trim()
      : 'unknown';
  const category =
    typeof trajectory.category === 'string' && trajectory.category.trim().length > 0
      ? trajectory.category.trim()
      : 'uncategorized';

  const violations = [];

  if (!Array.isArray(trajectory.steps)) {
    violations.push({
      rule: 'invalidSteps',
      message: `Trajectory "${id}" must define a "steps" array.`
    });
  }

  const steps = Array.isArray(trajectory.steps) ? trajectory.steps : [];
  const executedTools = [];

  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    if (!step || typeof step !== 'object' || typeof step.tool !== 'string' || !step.tool.trim()) {
      executedTools.push('<invalid_step>');
      violations.push({
        rule: 'invalidStep',
        stepIndex: i,
        message: `Trajectory "${id}" step ${i} must be an object with a non-empty string "tool".`
      });
    } else {
      executedTools.push(step.tool);
    }
  }

  const goldenDag = trajectory.goldenDag;
  if (!goldenDag || typeof goldenDag !== 'object') {
    violations.push({
      rule: 'missingGoldenDag',
      message: `Trajectory "${id}" is missing a valid "goldenDag" specification.`
    });
    return {
      id,
      category,
      passed: false,
      stepCount: steps.length,
      executedTools,
      violations
    };
  }

  const executedToolSet = new Set(executedTools.filter((t) => t !== '<invalid_step>'));

  // 1. requiredTools: every tool in requiredTools MUST appear in steps
  if (Array.isArray(goldenDag.requiredTools)) {
    for (const requiredTool of goldenDag.requiredTools) {
      if (!executedToolSet.has(requiredTool)) {
        violations.push({
          rule: 'requiredTools',
          tool: requiredTool,
          message: `Required tool "${requiredTool}" was not called in trajectory "${id}".`
        });
      }
    }
  }

  // 2. forbiddenTools: NO tool in forbiddenTools may appear anywhere in steps
  if (Array.isArray(goldenDag.forbiddenTools) && goldenDag.forbiddenTools.length > 0) {
    const forbiddenSet = new Set(goldenDag.forbiddenTools);
    for (let i = 0; i < steps.length; i++) {
      const toolName = steps[i]?.tool;
      if (typeof toolName === 'string' && forbiddenSet.has(toolName)) {
        violations.push({
          rule: 'forbiddenTools',
          tool: toolName,
          stepIndex: i,
          message: `Forbidden tool "${toolName}" was invoked at step ${i} in trajectory "${id}".`
        });
      }
    }
  }

  // 3. precedenceEdges: for each [u, v], u MUST appear strictly before v
  //    (firstIndex(u) < firstIndex(v) and every occurrence of v is preceded by at least one u)
  if (Array.isArray(goldenDag.precedenceEdges)) {
    for (const edge of goldenDag.precedenceEdges) {
      if (!Array.isArray(edge) || edge.length < 2) {
        continue;
      }
      const [u, v] = edge;
      const firstU = executedTools.indexOf(u);

      for (let k = 0; k < steps.length; k++) {
        if (steps[k]?.tool !== v) {
          continue;
        }
        if (firstU === -1 || firstU >= k) {
          violations.push({
            rule: 'precedenceEdges',
            edge: [u, v],
            stepIndex: k,
            message:
              firstU === -1
                ? `Precedence violation [${u} -> ${v}] in "${id}": "${v}" called at step ${k} without prior "${u}".`
                : `Precedence violation [${u} -> ${v}] in "${id}": "${v}" called at step ${k} before "${u}" (first seen at step ${firstU}).`
          });
        }
      }
    }
  }

  // 4. requirePassingPrerequisite: for each [prereq, target], whenever target is called at step k,
  //    there MUST exist an earlier step j < k calling prereq with step.ok === true
  if (Array.isArray(goldenDag.requirePassingPrerequisite)) {
    for (const pair of goldenDag.requirePassingPrerequisite) {
      if (!Array.isArray(pair) || pair.length < 2) {
        continue;
      }
      const [prereq, target] = pair;

      for (let k = 0; k < steps.length; k++) {
        if (steps[k]?.tool !== target) {
          continue;
        }
        let hasPassingPrereq = false;
        for (let j = 0; j < k; j++) {
          if (steps[j]?.tool === prereq && steps[j]?.ok === true) {
            hasPassingPrereq = true;
            break;
          }
        }
        if (!hasPassingPrereq) {
          violations.push({
            rule: 'requirePassingPrerequisite',
            prerequisite: [prereq, target],
            stepIndex: k,
            message: `Passing prerequisite violation [${prereq} (ok: true) -> ${target}] in "${id}": "${target}" called at step ${k} without an earlier passing "${prereq}".`
          });
        }
      }
    }
  }

  // 5. argGuards: validates mustContain, mustNotContain, and equals rules on matching tool step args
  if (Array.isArray(goldenDag.argGuards)) {
    for (const guard of goldenDag.argGuards) {
      if (!guard || typeof guard !== 'object' || typeof guard.tool !== 'string') {
        continue;
      }
      for (let i = 0; i < steps.length; i++) {
        const step = steps[i];
        if (!step || (guard.tool !== '*' && step.tool !== guard.tool)) {
          continue;
        }
        const args = step.args && typeof step.args === 'object' ? step.args : {};
        const actualValue = resolveArgField(args, guard.field);
        const fieldLabel = guard.field || '*';

        if (Object.prototype.hasOwnProperty.call(guard, 'equals') && guard.equals !== undefined) {
          if (!isDeepStrictEqual(actualValue, guard.equals)) {
            violations.push({
              rule: 'argGuards',
              constraint: 'equals',
              tool: step.tool,
              field: fieldLabel,
              expected: guard.equals,
              actual: actualValue,
              stepIndex: i,
              message: `Arg guard "equals" failed on "${step.tool}.${fieldLabel}" at step ${i} in "${id}": expected ${JSON.stringify(guard.equals)}, received ${JSON.stringify(actualValue)}.`
            });
          }
        }

        if (guard.mustContain !== undefined) {
          const requiredPatterns = Array.isArray(guard.mustContain)
            ? guard.mustContain
            : [guard.mustContain];
          for (const pattern of requiredPatterns) {
            if (!valueContainsPattern(actualValue, pattern)) {
              violations.push({
                rule: 'argGuards',
                constraint: 'mustContain',
                tool: step.tool,
                field: fieldLabel,
                pattern,
                actual: actualValue,
                stepIndex: i,
                message: `Arg guard "mustContain" failed on "${step.tool}.${fieldLabel}" at step ${i} in "${id}": missing ${JSON.stringify(pattern)}.`
              });
            }
          }
        }

        if (guard.mustNotContain !== undefined) {
          const forbiddenPatterns = Array.isArray(guard.mustNotContain)
            ? guard.mustNotContain
            : [guard.mustNotContain];
          for (const pattern of forbiddenPatterns) {
            if (valueContainsPattern(actualValue, pattern)) {
              violations.push({
                rule: 'argGuards',
                constraint: 'mustNotContain',
                tool: step.tool,
                field: fieldLabel,
                pattern,
                actual: actualValue,
                stepIndex: i,
                message: `Arg guard "mustNotContain" failed on "${step.tool}.${fieldLabel}" at step ${i} in "${id}": matched forbidden pattern ${JSON.stringify(pattern)}.`
              });
            }
          }
        }
      }
    }
  }

  // 6. maxSteps: steps.length <= goldenDag.maxSteps
  if (goldenDag.maxSteps !== undefined && goldenDag.maxSteps !== null) {
    if (
      typeof goldenDag.maxSteps !== 'number' ||
      !Number.isFinite(goldenDag.maxSteps) ||
      goldenDag.maxSteps < 1
    ) {
      violations.push({
        rule: 'maxSteps',
        maxSteps: goldenDag.maxSteps,
        message: `Invalid goldenDag.maxSteps (${String(goldenDag.maxSteps)}) in "${id}"; expected a positive number.`
      });
    } else if (steps.length > goldenDag.maxSteps) {
      violations.push({
        rule: 'maxSteps',
        stepCount: steps.length,
        maxSteps: goldenDag.maxSteps,
        message: `Trajectory "${id}" executed ${steps.length} steps, exceeding maxSteps (${goldenDag.maxSteps}).`
      });
    }
  }

  return {
    id,
    category,
    passed: violations.length === 0,
    stepCount: steps.length,
    executedTools,
    violations
  };
}

/**
 * Run the Trajectory Evaluation CI Gate across a trajectory list or JSON fixture file.
 * Blocks PRs if any trajectory deviates from its Golden DAG or if fixture count shrinks
 * below `minRequiredCount`.
 *
 * @param {object} [options]
 * @param {string} [options.fixturePath=DEFAULT_GOLDEN_FIXTURE_PATH]
 * @param {Array<object> | null} [options.trajectories=null]
 * @param {number} [options.minRequiredCount=100]
 * @returns {{
 *   ok: boolean,
 *   tool: 'krusch_eval_trajectories',
 *   summary: string,
 *   data: {
 *     total: number,
 *     passed: number,
 *     failed: number,
 *     passRate: number,
 *     minRequiredCount: number,
 *     categories: Record<string, { total: number, passed: number, failed: number, passRate: number }>,
 *     failures: Array<object>,
 *     results: Array<object>
 *   }
 * }}
 */
export function runTrajectoryEvalGate({
  fixturePath = DEFAULT_GOLDEN_FIXTURE_PATH,
  trajectories = null,
  minRequiredCount = 100
} = {}) {
  const effectiveMinCount =
    typeof minRequiredCount === 'number' && Number.isFinite(minRequiredCount) && minRequiredCount >= 0
      ? minRequiredCount
      : 100;

  let list = trajectories;

  if (list === null || list === undefined) {
    try {
      const raw = fs.readFileSync(fixturePath, 'utf8');
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        list = parsed;
      } else if (parsed && typeof parsed === 'object' && Array.isArray(parsed.trajectories)) {
        list = parsed.trajectories;
      } else {
        return {
          ok: false,
          tool: 'krusch_eval_trajectories',
          summary: `Trajectory fixture at "${fixturePath}" does not contain a trajectory array.`,
          data: {
            total: 0,
            passed: 0,
            failed: 0,
            passRate: 0,
            minRequiredCount: effectiveMinCount,
            categories: {},
            failures: [
              {
                id: 'fixture_load_error',
                category: 'fixture',
                passed: false,
                stepCount: 0,
                executedTools: [],
                violations: [
                  {
                    rule: 'invalidFixtureFormat',
                    message: `Expected JSON array in "${fixturePath}".`
                  }
                ]
              }
            ],
            results: []
          }
        };
      }
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      return {
        ok: false,
        tool: 'krusch_eval_trajectories',
        summary: `Failed to load trajectory fixture "${fixturePath}": ${reason}`,
        data: {
          total: 0,
          passed: 0,
          failed: 0,
          passRate: 0,
          minRequiredCount: effectiveMinCount,
          categories: {},
          failures: [
            {
              id: 'fixture_read_error',
              category: 'fixture',
              passed: false,
              stepCount: 0,
              executedTools: [],
              violations: [
                {
                  rule: 'fixtureReadError',
                  message: reason
                }
              ]
            }
          ],
          results: []
        }
      };
    }
  } else if (!Array.isArray(list)) {
    return {
      ok: false,
      tool: 'krusch_eval_trajectories',
      summary: 'Provided "trajectories" option must be an array.',
      data: {
        total: 0,
        passed: 0,
        failed: 0,
        passRate: 0,
        minRequiredCount: effectiveMinCount,
        categories: {},
        failures: [
          {
            id: 'invalid_trajectories_option',
            category: 'input',
            passed: false,
            stepCount: 0,
            executedTools: [],
            violations: [
              {
                rule: 'invalidInput',
                message: 'Option "trajectories" must be an array when supplied.'
              }
            ]
          }
        ],
        results: []
      }
    };
  }

  const results = list.map((traj) => evaluateSingleTrajectoryDag(traj));
  const failures = results.filter((r) => !r.passed);
  const total = results.length;
  const failed = failures.length;
  const passed = total - failed;
  const passRate = total > 0 ? Number((passed / total).toFixed(4)) : 0;

  /** @type {Record<string, { total: number, passed: number, failed: number, passRate: number }>} */
  const categories = {};
  for (const res of results) {
    if (!categories[res.category]) {
      categories[res.category] = { total: 0, passed: 0, failed: 0, passRate: 0 };
    }
    const bucket = categories[res.category];
    bucket.total += 1;
    if (res.passed) {
      bucket.passed += 1;
    } else {
      bucket.failed += 1;
    }
    bucket.passRate = Number((bucket.passed / bucket.total).toFixed(4));
  }

  const meetsMinCount = list.length >= effectiveMinCount;
  const ok = failed === 0 && meetsMinCount;

  let summary;
  if (ok) {
    summary = `Trajectory eval gate PASSED: ${passed}/${total} golden trajectories satisfied all 6 DAG invariants across ${Object.keys(categories).length} categories.`;
  } else if (!meetsMinCount && failed === 0) {
    summary = `Trajectory eval gate FAILED: evaluated ${total} trajectories, below minimum required count (${effectiveMinCount}).`;
  } else if (!meetsMinCount) {
    summary = `Trajectory eval gate FAILED: ${failed}/${total} trajectories failed DAG invariants AND count ${total} is below minimum required (${effectiveMinCount}).`;
  } else {
    summary = `Trajectory eval gate FAILED: ${failed}/${total} trajectories violated Golden DAG invariants (${passed}/${total} passed).`;
  }

  return {
    ok,
    tool: 'krusch_eval_trajectories',
    summary,
    data: {
      total,
      passed,
      failed,
      passRate,
      minRequiredCount: effectiveMinCount,
      categories,
      failures,
      results
    }
  };
}
