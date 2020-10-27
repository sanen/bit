import { EnvDefinition } from '@teambit/environments';
import { compact } from 'ramda-adjunct';
import { ComponentMap } from '@teambit/component';
import { Logger, LongProcessLogger } from '@teambit/logger';
import Bluebird from 'bluebird';
import prettyTime from 'pretty-time';
import { ArtifactFactory, ArtifactList } from './artifact';
import { BuildTask, BuildTaskHelper } from './build-task';
import { ComponentResult } from './types';
import { TasksQueue } from './tasks-queue';
import { EnvsBuildContext } from './builder.service';
import { TaskResultsList } from './task-results-list';

export type TaskResults = {
  /**
   * task itself. useful for getting its id/description later on.
   */
  task: BuildTask;

  /**
   * environment were the task was running
   */
  env: EnvDefinition;

  /**
   * component build results.
   */
  componentsResults: ComponentResult[];

  /**
   * artifacts generated by the build pipeline.
   * in case the task finished with errors, this prop is undefined.
   */
  artifacts: ComponentMap<ArtifactList> | undefined;

  /**
   * timestamp of start initiation.
   */
  startTime: number;

  /**
   * timestamp of task completion.
   */
  endTime: number;
};

export class BuildPipe {
  private failedTasks: BuildTask[] = [];
  private failedDependencyTask: BuildTask | undefined;
  private longProcessLogger: LongProcessLogger;
  constructor(
    /**
     * array of services to apply on the components.
     */
    readonly tasksQueue: TasksQueue,
    readonly envsBuildContext: EnvsBuildContext,
    readonly logger: Logger,
    readonly artifactFactory: ArtifactFactory
  ) {}

  /**
   * execute a pipeline of build tasks.
   */
  async execute(): Promise<TaskResultsList> {
    await this.executePreBuild();
    this.longProcessLogger = this.logger.createLongProcessLogger('running tasks', this.tasksQueue.length);
    const results = await Bluebird.mapSeries(this.tasksQueue, async ({ task, env }) => this.executeTask(task, env));
    this.longProcessLogger.end();
    const tasksResultsList = new TaskResultsList(this.tasksQueue, compact(results));
    await this.executePostBuild(tasksResultsList);

    return tasksResultsList;
  }

  private async executePreBuild() {
    this.logger.setStatusLine('executing pre-build for all tasks');
    await Bluebird.mapSeries(this.tasksQueue, async ({ task, env }) => {
      if (!task.preBuild) return;
      await task.preBuild(this.getBuildContext(env.id));
    });
    this.logger.consoleSuccess();
  }

  private async executeTask(task: BuildTask, env: EnvDefinition): Promise<TaskResults | null> {
    const taskId = BuildTaskHelper.serializeId(task);
    const taskName = `${taskId}${task.description ? ` (${task.description})` : ''}`;
    this.longProcessLogger.logProgress(`env "${env.id}", task "${taskName}"`);
    this.updateFailedDependencyTask(task);
    if (this.shouldSkipTask(taskId, env.id)) {
      return null;
    }
    const startTask = process.hrtime();
    const taskStartTime = Date.now();
    const buildContext = this.getBuildContext(env.id);
    const buildTaskResult = await task.execute(buildContext);
    const endTime = Date.now();
    const compsWithErrors = buildTaskResult.componentsResults.filter((c) => c.errors?.length);
    let artifacts;
    if (compsWithErrors.length) {
      this.logger.consoleFailure(`env: ${env.id}, task "${taskId}" has failed`);
      this.failedTasks.push(task);
    } else {
      const duration = prettyTime(process.hrtime(startTask));
      this.logger.consoleSuccess(`env "${env.id}", task "${taskName}" has completed successfully in ${duration}`);
      const defs = buildTaskResult.artifacts || [];
      artifacts = this.artifactFactory.generate(buildContext, defs, task);
    }

    const taskResults: TaskResults = {
      task,
      env,
      componentsResults: buildTaskResult.componentsResults,
      artifacts,
      startTime: taskStartTime,
      endTime,
    };

    return taskResults;
  }

  private async executePostBuild(tasksResults: TaskResultsList) {
    this.logger.setStatusLine('executing post-build for all tasks');
    await Bluebird.mapSeries(this.tasksQueue, async ({ task, env }) => {
      if (!task.postBuild) return;
      await task.postBuild(this.getBuildContext(env.id), tasksResults);
    });
    this.logger.consoleSuccess();
  }

  private updateFailedDependencyTask(task: BuildTask) {
    if (!this.failedDependencyTask && this.failedTasks.length && task.dependencies) {
      task.dependencies.forEach((dependency) => {
        const { aspectId, name } = BuildTaskHelper.deserializeId(dependency);
        this.failedDependencyTask = this.failedTasks.find((failedTask) => {
          if (name && name !== failedTask.name) return false;
          return aspectId === failedTask.aspectId;
        });
      });
    }
  }

  private shouldSkipTask(taskId: string, envId: string): boolean {
    if (!this.failedDependencyTask) return false;
    const failedTaskId = BuildTaskHelper.serializeId(this.failedDependencyTask);
    this.logger.consoleWarning(`env: ${envId}, task "${taskId}" has skipped due to "${failedTaskId}" failure`);
    return true;
  }

  private getBuildContext(envId: string) {
    const buildContext = this.envsBuildContext[envId];
    if (!buildContext) throw new Error(`unable to find buildContext for ${envId}`);
    return buildContext;
  }

  /**
   * create a build pipe from an array of tasks.
   */
  static from(
    tasksQueue: TasksQueue,
    envsBuildContext: EnvsBuildContext,
    logger: Logger,
    artifactFactory: ArtifactFactory
  ) {
    return new BuildPipe(tasksQueue, envsBuildContext, logger, artifactFactory);
  }
}
