import type { FastifyError, FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Logger } from 'pino';
import { FailureError, renderAlertText } from '../../failure-model/index.js';
import { toHttpError } from '../errors.js';
import { httpFailure } from '../failures.js';

/**
 * The last line of the pipeline: every rejection is mapped to a stable failure and a minimal,
 * PII-free response. Framework parser errors are classified into the request codes; anything
 * unexpected becomes INTERNAL_ERROR. Full operational detail goes to the log; the response
 * body carries only `{ error, message, request_id }`. Request bodies, headers, cookies,
 * tokens, signatures, stack traces, and `error.message` are never logged or returned.
 */
export interface ErrorHandlerDeps {
  logger: Logger;
  environment: string;
}

/** Map a thrown error to a FailureError without ever surfacing its raw message. */
function classify(error: FastifyError, environment: string): FailureError {
  if (error instanceof FailureError) {
    return error;
  }
  const code = typeof error.code === 'string' ? error.code : '';
  if (code.startsWith('FST_ERR_CTP_')) {
    if (code.includes('BODY_TOO_LARGE')) {
      return httpFailure('REQUEST_BODY_TOO_LARGE', environment);
    }
    if (code.includes('MEDIA_TYPE')) {
      return httpFailure('UNSUPPORTED_MEDIA_TYPE', environment);
    }
    return httpFailure('REQUEST_MALFORMED', environment);
  }
  switch (error.statusCode) {
    case 413:
      return httpFailure('REQUEST_BODY_TOO_LARGE', environment);
    case 415:
      return httpFailure('UNSUPPORTED_MEDIA_TYPE', environment);
    case 400:
      return httpFailure('REQUEST_MALFORMED', environment);
    default:
      return httpFailure('INTERNAL_ERROR', environment);
  }
}

export function installErrorHandler(app: FastifyInstance, deps: ErrorHandlerDeps): void {
  app.setErrorHandler((error: FastifyError, request: FastifyRequest, reply: FastifyReply) => {
    const failure = classify(error, deps.environment);
    const { status, body } = toHttpError(failure);

    // Only safe fields — no content-field keys (the logger's redaction guard would throw),
    // no raw url (its query string may hold PII); the route pattern is safe.
    const logFields = {
      error_code: failure.error_code,
      request_id: request.id,
      method: request.method,
      route: request.routeOptions.url ?? 'unknown',
      status,
    };
    const line = renderAlertText(failure, {
      environment: deps.environment,
      timestamp: new Date().toISOString(),
    });
    if (status >= 500) {
      deps.logger.error(logFields, line);
    } else {
      deps.logger.warn(logFields, line);
    }

    void reply.status(status).send({ ...body, request_id: request.id });
  });

  app.setNotFoundHandler((request: FastifyRequest, reply: FastifyReply) => {
    void reply
      .status(404)
      .send({ error: 'NOT_FOUND', message: 'Not found.', request_id: request.id });
  });
}
