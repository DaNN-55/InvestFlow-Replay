export const INITIAL_REPLAY_SESSION_OPERATION = Object.freeze({
  activity: null,
  errorMessage: "",
  statusMessage: "",
});

export function reduceReplaySessionOperation(state, event) {
  switch (event.type) {
    case "started":
      return state.activity ? state : {
        activity: event.activity,
        errorMessage: "",
        statusMessage: "",
      };
    case "status":
      return { ...state, statusMessage: event.message };
    case "failed":
      return { ...state, errorMessage: event.message };
    case "settled":
      return { ...state, activity: null };
    case "messagesCleared":
      return { ...state, errorMessage: "", statusMessage: "" };
    default:
      throw new Error(`Unknown replay operation event: ${event.type}`);
  }
}
