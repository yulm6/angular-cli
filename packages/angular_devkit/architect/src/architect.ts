/**
 * @license
 * Copyright Google Inc. All Rights Reserved.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://angular.io/license
 */
import { experimental, json, logging } from '@angular-devkit/core';
import { Observable, from, of } from 'rxjs';
import { concatMap, first, map, shareReplay } from 'rxjs/operators';
import {
  BuilderInfo,
  BuilderInput,
  BuilderOutput,
  BuilderRegistry,
  BuilderRun,
  Target,
  targetStringFromTarget,
} from './api';
import { ArchitectHost, BuilderDescription, BuilderJobHandler } from './internal';
import { scheduleByName, scheduleByTarget } from './schedule-by-name';

const inputSchema = require('./input-schema.json');
const outputSchema = require('./output-schema.json');

function _createJobHandlerFromBuilderInfo(
  info: BuilderInfo,
  target: Target | undefined,
  host: ArchitectHost,
  registry: json.schema.SchemaRegistry,
  baseOptions: json.JsonObject,
): Observable<BuilderJobHandler> {
  const jobDescription: BuilderDescription = {
    name: target ? `{${targetStringFromTarget(target)}}` : info.builderName,
    argument: { type: 'object' },
    input: inputSchema,
    output: outputSchema,
    info,
  };

  function handler(argument: json.JsonObject, context: experimental.jobs.JobHandlerContext) {
    const inboundBus = context.inboundBus.pipe(
      concatMap(message => {
        if (message.kind === experimental.jobs.JobInboundMessageKind.Input) {
          const v = message.value as BuilderInput;
          const options = {
            ...baseOptions,
            ...v.options,
          };

          // Validate v against the options schema.
          return registry.compile(info.optionSchema).pipe(
            concatMap(validation => validation(options)),
            map(result => {
              if (result.success) {
                return { ...v, options: result.data } as BuilderInput;
              } else if (result.errors) {
                throw new Error('Options did not validate.' + result.errors.join());
              } else {
                return v;
              }
            }),
            map(value => ({ ...message, value })),
          );
        } else {
          return of(message as experimental.jobs.JobInboundMessage<BuilderInput>);
        }
      }),
      // Using a share replay because the job might be synchronously sending input, but
      // asynchronously listening to it.
      shareReplay(1),
    );

    return from(host.loadBuilder(info)).pipe(
      concatMap(builder => {
        if (builder === null) {
          throw new Error(`Cannot load builder for builderInfo ${JSON.stringify(info, null, 2)}`);
        }

        return builder.handler(argument, { ...context, inboundBus }).pipe(
          map(output => {
            if (output.kind === experimental.jobs.JobOutboundMessageKind.Output) {
              // Add target to it.
              return {
                ...output,
                value: {
                  ...output.value,
                  ...target ? { target } : 0,
                } as json.JsonObject,
              };
            } else {
              return output;
            }
          }),
        );
      }),
    );
  }

  return of(Object.assign(handler, { jobDescription }) as BuilderJobHandler);
}

export interface ScheduleOptions {
  logger?: logging.Logger;
}


/**
 * A JobRegistry that resolves builder targets from the host.
 */
export class ArchitectBuilderJobRegistry implements BuilderRegistry {
  constructor(
    protected _host: ArchitectHost,
    protected _registry: json.schema.SchemaRegistry,
    protected _jobCache?: Map<string, Observable<BuilderJobHandler | null>>,
    protected _infoCache?: Map<string, Observable<BuilderInfo | null>>,
  ) {}

  protected _resolveBuilder(name: string): Observable<BuilderInfo | null> {
    const cache = this._infoCache;
    if (cache) {
      const maybeCache = cache.get(name);
      if (maybeCache !== undefined) {
        return maybeCache;
      }

      const info = from(this._host.resolveBuilder(name)).pipe(
        shareReplay(1),
      );
      cache.set(name, info);

      return info;
    }

    return from(this._host.resolveBuilder(name));
  }

  protected _createBuilder(
    info: BuilderInfo,
    target?: Target,
    options?: json.JsonObject,
  ): Observable<BuilderJobHandler | null> {
    const cache = this._jobCache;
    if (target) {
      const maybeHit = cache && cache.get(targetStringFromTarget(target));
      if (maybeHit) {
        return maybeHit;
      }
    } else {
      const maybeHit = cache && cache.get(info.builderName);
      if (maybeHit) {
        return maybeHit;
      }
    }

    const result = _createJobHandlerFromBuilderInfo(
      info,
      target,
      this._host,
      this._registry,
      options || {},
    );

    if (cache) {
      if (target) {
        cache.set(targetStringFromTarget(target), result.pipe(shareReplay(1)));
      } else {
        cache.set(info.builderName, result.pipe(shareReplay(1)));
      }
    }

    return result;
  }

  get<
    A extends json.JsonObject,
    I extends BuilderInput,
    O extends BuilderOutput,
    >(name: string): Observable<experimental.jobs.JobHandler<A, I, O> | null> {
    const m = name.match(/^([^:]+):([^:]+)$/i);
    if (!m) {
      return of(null);
    }

    return from(this._resolveBuilder(name)).pipe(
      concatMap(builderInfo => builderInfo ? this._createBuilder(builderInfo) : of(null)),
      first(null, null),
    ) as Observable<experimental.jobs.JobHandler<A, I, O> | null>;
  }
}

/**
 * A JobRegistry that resolves targets from the host.
 */
export class ArchitectTargetJobRegistry extends ArchitectBuilderJobRegistry {
  get<
    A extends json.JsonObject,
    I extends BuilderInput,
    O extends BuilderOutput,
    >(name: string): Observable<experimental.jobs.JobHandler<A, I, O> | null> {
    const m = name.match(/^{([^:]+):([^:]+)(?::([^:]*))?}$/i);
    if (!m) {
      return of(null);
    }

    const target = {
      project: m[1],
      target: m[2],
      configuration: m[3],
    };

    return from(Promise.all([
      this._host.getBuilderNameForTarget(target),
      this._host.getOptionsForTarget(target),
    ])).pipe(
      concatMap(([builderStr, options]) => {
        if (builderStr === null || options === null) {
          return of(null);
        }

        return this._resolveBuilder(builderStr).pipe(
          concatMap(builderInfo => {
            if (builderInfo === null) {
              return of(null);
            }

            return this._createBuilder(builderInfo, target, options);
          }),
        );
      }),
      first(null, null),
    ) as Observable<experimental.jobs.JobHandler<A, I, O> | null>;
  }
}


export class Architect {
  private readonly _scheduler: experimental.jobs.Scheduler;
  private readonly _jobCache = new Map<string, Observable<BuilderJobHandler>>();
  private readonly _infoCache = new Map<string, Observable<BuilderInfo>>();

  constructor(
    private _host: ArchitectHost,
    private _registry: json.schema.SchemaRegistry = new json.schema.CoreSchemaRegistry(),
    additionalJobRegistry?: experimental.jobs.Registry,
  ) {
    const jobRegistry = new experimental.jobs.FallbackRegistry([
      new ArchitectTargetJobRegistry(_host, _registry, this._jobCache, this._infoCache),
      new ArchitectBuilderJobRegistry(_host, _registry, this._jobCache, this._infoCache),
      ...(additionalJobRegistry ? [additionalJobRegistry] : []),
    ] as experimental.jobs.Registry[]);

    this._scheduler = new experimental.jobs.SimpleScheduler(jobRegistry, _registry);
  }

  has(name: experimental.jobs.JobName) {
    return this._scheduler.has(name);
  }

  scheduleBuilder(
    name: string,
    options: json.JsonObject,
    scheduleOptions: ScheduleOptions = {},
  ): Promise<BuilderRun> {
    if (!/^[^:]+:[^:]+$/.test(name)) {
      throw new Error('Invalid builder name: ' + JSON.stringify(name));
    }

    return scheduleByName(name, options, {
      scheduler: this._scheduler,
      logger: scheduleOptions.logger || new logging.NullLogger(),
      currentDirectory: this._host.getCurrentDirectory(),
      workspaceRoot: this._host.getWorkspaceRoot(),
    });
  }
  scheduleTarget(
    target: Target,
    overrides: json.JsonObject = {},
    scheduleOptions: ScheduleOptions = {},
  ): Promise<BuilderRun> {
    return scheduleByTarget(target, overrides, {
      scheduler: this._scheduler,
      logger: scheduleOptions.logger || new logging.NullLogger(),
      currentDirectory: this._host.getCurrentDirectory(),
      workspaceRoot: this._host.getWorkspaceRoot(),
    });
  }
}
