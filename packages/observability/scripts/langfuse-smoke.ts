import {
  createLangfuseTracer,
  LangfuseTracer,
  shutdownLangfuse,
} from '../src/index.js';

const tracer = createLangfuseTracer({
  warn: (message) => console.error(message),
});

if (!(tracer instanceof LangfuseTracer)) {
  throw new Error(
    'Set valid LANGFUSE_PUBLIC_KEY, LANGFUSE_SECRET_KEY, and LANGFUSE_BASE_URL values before running the Langfuse smoke test.',
  );
}

try {
  await tracer.withSpan(
    'datascout.observability.smoke',
    { kind: 'span' },
    async (span) => {
      span.setAttributes({
        component: 'datascout-observability',
        smokeTest: true,
      });
      span.score('observability_smoke', true, 'SDK export smoke test');
      await tracer.withSpan(
        'datascout.observability.smoke_generation',
        { kind: 'generation' },
        async (generation) => {
          generation.setAttributes({
            component: 'datascout-observability',
            smokeTest: true,
          });
          generation.setGenerationDetails?.({
            modelId: 'datascout-synthetic-smoke',
            inputTokens: 12,
            outputTokens: 4,
            latencyMs: 42,
          });
          generation.score(
            'generation_metadata_smoke',
            true,
            'Synthetic metadata only; no prompt or completion sent.',
          );
        },
      );
    },
  );
  await tracer.flush(10_000);
} finally {
  await shutdownLangfuse(10_000, (message) => console.error(message));
}

console.log(
  'Smoke telemetry was flushed. Verify the datascout.observability.smoke trace in the configured Langfuse project.',
);
