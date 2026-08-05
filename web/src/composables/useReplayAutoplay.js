import {
  onBeforeUnmount,
  onDeactivated,
  readonly,
  shallowRef,
  watch,
} from "vue";

import {
  getReplayAutoplayDelay,
  getReplayAutoplayStopReason,
} from "../utils/replayAutoplay.js";

export function useReplayAutoplay({
  session,
  isBusy,
  errorMessage,
  statusMessage,
  advanceSession,
  blindDraft,
}) {
  const playing = shallowRef(false);
  const speed = shallowRef("normal");
  const message = shallowRef("");
  let timerId = null;
  let stepInFlight = false;
  let playbackToken = 0;

  function clearTimer() {
    if (timerId != null) {
      clearTimeout(timerId);
      timerId = null;
    }
  }

  function pause(reason = "") {
    playbackToken += 1;
    playing.value = false;
    clearTimer();
    if (reason) {
      message.value = reason;
    } else {
      message.value = "";
    }
  }

  function scheduleNext(token) {
    clearTimer();
    if (!playing.value || token !== playbackToken) {
      return;
    }
    timerId = setTimeout(() => {
      runStep(token);
    }, getReplayAutoplayDelay(speed.value));
  }

  async function runStep(token) {
    timerId = null;
    if (!playing.value || token !== playbackToken || stepInFlight) {
      return;
    }
    const stopReason = getReplayAutoplayStopReason(session.value, {
      blindDraft: blindDraft?.value ?? null,
    });
    if (stopReason) {
      pause(stopReason);
      return;
    }
    if (isBusy.value) {
      pause("检测到其他操作正在进行，自动播放已暂停。");
      return;
    }

    const executionStartIndex = session.value.executions?.length ?? 0;
    stepInFlight = true;
    let nextSession;
    try {
      nextSession = await advanceSession();
    } catch (error) {
      pause(error?.message ?? "自动推进接口异常，自动播放已暂停。");
      return;
    } finally {
      stepInFlight = false;
    }

    if (!playing.value || token !== playbackToken) {
      return;
    }
    if (!nextSession) {
      pause(
        errorMessage.value ||
          statusMessage.value ||
          "自动推进未完成，可能发生会话冲突或接口异常，请确认后重试。",
      );
      return;
    }
    const postStepReason = getReplayAutoplayStopReason(nextSession, {
      executionStartIndex,
      blindDraft: blindDraft?.value ?? null,
    });
    if (postStepReason) {
      pause(postStepReason);
      return;
    }
    message.value = `自动播放中 · ${speedLabel(speed.value)}`;
    scheduleNext(token);
  }

  function start() {
    if (playing.value || stepInFlight) {
      return;
    }
    const stopReason = getReplayAutoplayStopReason(session.value, {
      blindDraft: blindDraft?.value ?? null,
    });
    if (stopReason) {
      pause(stopReason);
      return;
    }
    playbackToken += 1;
    playing.value = true;
    message.value = `自动播放中 · ${speedLabel(speed.value)}`;
    scheduleNext(playbackToken);
  }

  function toggle() {
    if (playing.value) {
      pause("自动播放已暂停。");
      return;
    }
    start();
  }

  function setSpeed(nextSpeed) {
    if (!["slow", "normal", "fast"].includes(nextSpeed)) {
      return;
    }
    speed.value = nextSpeed;
    if (playing.value) {
      message.value = `自动播放中 · ${speedLabel(nextSpeed)}`;
      scheduleNext(playbackToken);
    }
  }

  function speedLabel(value) {
    return {
      slow: "慢速",
      normal: "正常",
      fast: "快速",
    }[value];
  }

  watch(
    () => [
      session.value?.id,
      session.value?.status,
      session.value?.pendingOrders?.length ?? 0,
    ],
    ([sessionId, status, pendingCount], previous) => {
      if (!playing.value) {
        return;
      }
      if (previous?.[0] && sessionId !== previous[0]) {
        pause("演练会话已切换，自动播放已暂停。");
        return;
      }
      if (status !== "active" || pendingCount > 0) {
        pause(getReplayAutoplayStopReason(session.value));
      }
    },
  );

  watch(errorMessage, (value) => {
    if (playing.value && value) {
      pause(value);
    }
  });

  onDeactivated(() => pause());
  onBeforeUnmount(() => pause());

  return {
    playing: readonly(playing),
    speed: readonly(speed),
    message: readonly(message),
    start,
    pause,
    toggle,
    setSpeed,
  };
}
