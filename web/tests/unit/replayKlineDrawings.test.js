import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  REPLAY_DRAWING_GROUP_ID,
  REPLAY_DRAWING_TOOLS,
  REPLAY_RECTANGLE_OVERLAY,
  createReplayDrawingOverlay,
} from "../../src/utils/replayKlineDrawings.js";

describe("replay KLineChart drawing tools", () => {
  it("maps the common toolbar to native KLineChart overlays", () => {
    assert.deepEqual(
      REPLAY_DRAWING_TOOLS.map(({ id, overlayName }) => [id, overlayName]),
      [
        ["trend", "segment"],
        ["horizontal", "horizontalStraightLine"],
        ["ray", "rayLine"],
        ["rectangle", "replayRectangle"],
        ["fibonacci", "fibonacciLine"],
      ],
    );
    assert.deepEqual(createReplayDrawingOverlay("rectangle"), {
      name: "replayRectangle",
      groupId: REPLAY_DRAWING_GROUP_ID,
      lock: false,
    });
    assert.equal(REPLAY_RECTANGLE_OVERLAY.totalStep, 3);
    assert.deepEqual(
      REPLAY_RECTANGLE_OVERLAY.createPointFigures({
        coordinates: [{ x: 10, y: 20 }, { x: 40, y: 60 }],
      }),
      [{
        type: "rect",
        attrs: { x: 10, y: 20, width: 30, height: 40 },
      }],
    );
    assert.equal(createReplayDrawingOverlay("unknown"), null);
  });
});
