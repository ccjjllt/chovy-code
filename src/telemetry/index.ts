export type {
  TelemetryEvent,
  TelemetryEventInput,
  AgentRole,
  PromptShape,
} from "./events.js";

export {
  getTelemetrySink,
  setTelemetrySink,
  createTelemetrySink,
  emitTelemetry,
  type TelemetrySink,
  type TelemetrySinkOptions,
} from "./localSink.js";
