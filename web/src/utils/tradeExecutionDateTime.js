import { toDateInput } from "./datePresentation.js";

export { toDateInput };

export function toExecutionEventDate(value) {
  return toDateInput(value);
}
