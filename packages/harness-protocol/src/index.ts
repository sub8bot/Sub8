export {
  HARNESS_PORT,
  HEALTH_PATH,
  TURN_PATH,
  STOP_PATH,
  NDJSON_CONTENT_TYPE,
  TURN_EVENT_TYPES,
} from "./constants.js";
export type { TurnEventType } from "./constants.js";

export { isClaudeProvider, isOAuthProvider } from "./provider.js";

export type {
  ChatRole,
  HistoryMessage,
  ModelSpec,
  TurnCallback,
  GrokAuthRecord,
  GrokAuthFile,
  ClaudeCredentials,
  TurnRequest,
  SimpleTurnRequest,
  HarnessTurnBody,
} from "./turn.js";
export {
  isHistoryMessage,
  isModelSpec,
  isTurnCallback,
  isGrokAuthRecord,
  isGrokAuthFile,
  turnRequestProblems,
  isTurnRequest,
  assertTurnRequest,
  isSimpleTurnRequest,
  isHarnessTurnBody,
} from "./turn.js";

export type {
  ToolEvent,
  DeltaEvent,
  DoneEvent,
  ErrorEvent,
  TurnEvent,
  TurnUsage,
  MalformedReason,
  ParsedLine,
} from "./events.js";
export {
  isToolEvent,
  isDeltaEvent,
  isDoneEvent,
  isErrorEvent,
  isTurnEvent,
  isTurnUsage,
  turnEventReject,
  eventType,
  parseTurnEventLine,
  encodeTurnEvent,
} from "./events.js";

export type { HarnessHealth, HarnessToolsState, StopResponse } from "./health.js";
export {
  isHarnessHealth,
  isStopResponse,
  harnessIsUp,
  harnessCanTurn,
  harnessToolsState,
  harnessHasTools,
  parseHarnessHealth,
} from "./health.js";

export type {
  MalformedLine,
  TurnStreamResult,
  TurnEventDecoder,
  TurnEventDecoderOptions,
} from "./ndjson.js";
export { createTurnEventDecoder, decodeTurnEvents } from "./ndjson.js";
