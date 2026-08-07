export const REPLAY_DRAWING_GROUP_ID = "replay-user-drawings";

export const REPLAY_RECTANGLE_OVERLAY = Object.freeze({
  name: "replayRectangle",
  totalStep: 3,
  needDefaultPointFigure: true,
  needDefaultXAxisFigure: true,
  needDefaultYAxisFigure: true,
  createPointFigures: ({ coordinates }) => {
    if (coordinates.length < 2) {
      return [];
    }
    const start = coordinates[0];
    const end = coordinates[1];
    return [{
      type: "rect",
      attrs: {
        x: Math.min(start.x, end.x),
        y: Math.min(start.y, end.y),
        width: Math.abs(end.x - start.x),
        height: Math.abs(end.y - start.y),
      },
    }];
  },
});

export const REPLAY_DRAWING_TOOLS = Object.freeze([
  Object.freeze({ id: "trend", label: "趋势线", overlayName: "segment" }),
  Object.freeze({ id: "horizontal", label: "水平线", overlayName: "horizontalStraightLine" }),
  Object.freeze({ id: "ray", label: "射线", overlayName: "rayLine" }),
  Object.freeze({ id: "rectangle", label: "矩形", overlayName: "replayRectangle" }),
  Object.freeze({ id: "fibonacci", label: "斐波那契", overlayName: "fibonacciLine" }),
]);

export function createReplayDrawingOverlay(toolId, callbacks = {}) {
  const tool = REPLAY_DRAWING_TOOLS.find((item) => item.id === toolId);
  if (!tool) {
    return null;
  }
  return {
    name: tool.overlayName,
    groupId: REPLAY_DRAWING_GROUP_ID,
    lock: false,
    ...callbacks,
  };
}
