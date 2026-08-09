import {
  computed,
  onMounted,
  readonly,
  shallowRef,
} from "vue";

import { api } from "../services/api.js";
import { buildReplayRestartOptions } from "../utils/replayRestart.js";

const REPLAY_SESSION_STORAGE_KEY = "investflow.replay.active-session-id";

function createActionId() {
  if (globalThis.crypto?.randomUUID) {
    return globalThis.crypto.randomUUID();
  }
  return `replay-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function browserStorage() {
  return typeof window === "undefined" ? null : window.localStorage;
}

function readStoredSessionId(storage) {
  return storage?.getItem(REPLAY_SESSION_STORAGE_KEY) ?? "";
}

function storeSessionId(storage, sessionId) {
  if (sessionId) {
    storage?.setItem(REPLAY_SESSION_STORAGE_KEY, sessionId);
    return;
  }
  storage?.removeItem(REPLAY_SESSION_STORAGE_KEY);
}

export function useReplaySession(options = {}) {
  const client = options.client ?? api;
  const storage = options.storage ?? browserStorage();
  const session = shallowRef(null);
  const isRestoring = shallowRef(false);
  const isCreating = shallowRef(false);
  const isSubmitting = shallowRef(false);
  const isAdvancing = shallowRef(false);
  const isFinishing = shallowRef(false);
  const isRevealing = shallowRef(false);
  const isSavingBlindReview = shallowRef(false);
  const isSavingPostReview = shallowRef(false);
  const isSavingBlindCorrection = shallowRef(false);
  const isSavingPostCorrection = shallowRef(false);
  const isCancellingRetrain = shallowRef(false);
  const errorMessage = shallowRef("");
  const statusMessage = shallowRef("");

  const hasSession = computed(() => Boolean(session.value?.id));
  const isCompleted = computed(() => session.value?.status === "completed");
  const isRevealed = computed(() => Boolean(session.value?.revealed));
  const isBusy = computed(
    () =>
      isRestoring.value ||
      isCreating.value ||
      isSubmitting.value ||
      isAdvancing.value ||
      isFinishing.value ||
      isRevealing.value ||
      isSavingBlindReview.value ||
      isSavingPostReview.value ||
      isSavingBlindCorrection.value ||
      isSavingPostCorrection.value ||
      isCancellingRetrain.value,
  );

  function setSession(nextSession) {
    session.value = nextSession ?? null;
    storeSessionId(storage, nextSession?.id ?? "");
  }

  function clearMessages() {
    errorMessage.value = "";
    statusMessage.value = "";
  }

  async function refreshSession(options = {}) {
    const sessionId =
      options.sessionId ?? session.value?.id ?? readStoredSessionId(storage);
    if (!sessionId) {
      return null;
    }
    try {
      const payload = await client.getReplaySession(sessionId);
      setSession(payload.session);
      if (options.conflict) {
        statusMessage.value =
          "检测到会话已更新，已刷新到最新进度，请确认后重试。";
      }
      return payload.session;
    } catch (error) {
      if (error?.status === 404) {
        setSession(null);
        errorMessage.value = "上次演练记录不存在，请重新创建一局。";
        return null;
      }
      errorMessage.value = error?.message ?? "行情演练加载失败";
      return null;
    }
  }

  async function restoreSession() {
    const sessionId = readStoredSessionId(storage);
    if (!sessionId) {
      return;
    }
    isRestoring.value = true;
    clearMessages();
    try {
      await refreshSession({ sessionId });
    } finally {
      isRestoring.value = false;
    }
  }

  async function syncStoredSession() {
    const sessionId = readStoredSessionId(storage);
    if (
      !sessionId ||
      sessionId === session.value?.id ||
      isRestoring.value
    ) {
      return session.value;
    }
    isRestoring.value = true;
    clearMessages();
    try {
      return await refreshSession({ sessionId });
    } finally {
      isRestoring.value = false;
    }
  }

  async function createSession(options) {
    if (isBusy.value) {
      return null;
    }
    isCreating.value = true;
    clearMessages();
    try {
      const payload = await client.createReplaySession(options);
      setSession(payload.session);
      statusMessage.value = payload.session.interval === "hybrid"
        ? `日内模拟已创建：主图保留 250 根日线，分时区按${Number(payload.session.stepMinutes ?? 1)}分钟推进。`
        : payload.session.interval === "1m"
          ? "分钟盲测场景已创建，已展示 250 根观察分钟线。"
          : "盲测场景已创建，已展示 250 根观察日线。";
      return payload.session;
    } catch (error) {
      errorMessage.value = error?.message ?? "创建行情演练失败";
      return null;
    } finally {
      isCreating.value = false;
    }
  }

  async function submitOrder(order) {
    if (!session.value || isBusy.value || isCompleted.value) {
      return null;
    }
    isSubmitting.value = true;
    clearMessages();
    try {
      const payload = await client.submitReplayOrder(session.value.id, {
        actionId: createActionId(),
        expectedRevision: session.value.revision,
        ...order,
      });
      setSession(payload.session);
      statusMessage.value = session.value.interval === "hybrid"
        ? `委托已提交，将在下一根${Number(session.value.stepMinutes ?? 1)}分钟K线开盘尝试成交。`
        : session.value.interval === "1m"
        ? "委托已提交，将在下一分钟开盘尝试成交。"
        : "委托已提交，将在下一交易日开盘尝试成交。";
      return payload.session;
    } catch (error) {
      if (error?.status === 409) {
        await refreshSession({ conflict: true });
        return null;
      }
      errorMessage.value = error?.message ?? "提交委托失败";
      return null;
    } finally {
      isSubmitting.value = false;
    }
  }

  async function advanceSession(mode = "minute") {
    if (!session.value || isBusy.value || isCompleted.value) {
      return null;
    }
    const pendingBeforeAdvance = session.value.pendingOrders?.length ?? 0;
    const executionsBeforeAdvance = session.value.executions?.length ?? 0;
    isAdvancing.value = true;
    clearMessages();
    try {
      const payload = await client.advanceReplaySession(session.value.id, {
        actionId: createActionId(),
        expectedRevision: session.value.revision,
        mode,
      });
      setSession(payload.session);
      const minuteReplay = ["1m", "hybrid"].includes(payload.session.interval);
      const advancedWholeDay = payload.session.interval === "hybrid" && mode === "day";
      statusMessage.value = payload.session.status === "completed"
        ? "本局演练已完成，持仓按最后收盘价估值。"
        : pendingBeforeAdvance > 0 ||
            (payload.session.executions?.length ?? 0) >
              executionsBeforeAdvance
          ? advancedWholeDay
            ? "已处理委托并推进到当日收盘。"
            : minuteReplay
            ? payload.session.interval === "hybrid"
              ? `已处理委托并推进${Number(payload.session.stepMinutes ?? 1)}分钟。`
              : "已处理委托并推进到下一分钟。"
            : "已处理委托并推进到下一交易日。"
          : advancedWholeDay
            ? "已推进到当日收盘。"
            : minuteReplay
            ? payload.session.interval === "hybrid"
              ? `已推进${Number(payload.session.stepMinutes ?? 1)}分钟。`
              : "已推进到下一分钟。"
            : "已推进到下一交易日。";
      return payload.session;
    } catch (error) {
      if (error?.status === 409) {
        await refreshSession({ conflict: true });
        return null;
      }
      errorMessage.value = error?.message ?? "推进行情失败";
      return null;
    } finally {
      isAdvancing.value = false;
    }
  }

  async function finishSession() {
    if (!session.value || isBusy.value || isCompleted.value) {
      return null;
    }
    isFinishing.value = true;
    clearMessages();
    try {
      const payload = await client.finishReplaySession(session.value.id, {
        actionId: createActionId(),
        expectedRevision: session.value.revision,
      });
      setSession(payload.session);
      statusMessage.value =
        "已提前交卷，未执行委托已取消，当前持仓按交卷时收盘价估值。";
      return payload.session;
    } catch (error) {
      if (error?.status === 409) {
        await refreshSession({ conflict: true });
        return null;
      }
      errorMessage.value = error?.message ?? "提前交卷失败";
      return null;
    } finally {
      isFinishing.value = false;
    }
  }

  async function skipSessionAndRestart() {
    if (!session.value || isBusy.value || isCompleted.value) {
      return null;
    }
    const restartOptions = buildReplayRestartOptions(session.value);
    if (!restartOptions.benchmarkCode) {
      errorMessage.value = "当前演练缺少指数基准，无法按原配置换一局。";
      return null;
    }

    isFinishing.value = true;
    clearMessages();
    let finishedSession = null;
    try {
      const finished = await client.finishReplaySession(session.value.id, {
        actionId: createActionId(),
        expectedRevision: session.value.revision,
        reason: "no_opportunity",
      });
      finishedSession = finished.session;
      setSession(finishedSession);

      const created = await client.createReplaySession(restartOptions);
      setSession(created.session);
      statusMessage.value = "上一局已记录为无交易机会，并按相同配置换了一局。";
      return created.session;
    } catch (error) {
      if (!finishedSession && error?.status === 409) {
        await refreshSession({ conflict: true });
        return null;
      }
      errorMessage.value = finishedSession
        ? `上一局已记录为无交易机会，但新行情创建失败：${error?.message ?? "未知错误"}`
        : error?.message ?? "结束并换一局失败";
      return null;
    } finally {
      isFinishing.value = false;
    }
  }

  async function revealSession() {
    if (
      !session.value ||
      isBusy.value ||
      !isCompleted.value ||
      isRevealed.value ||
      !session.value.review?.blindSaved
    ) {
      return null;
    }
    isRevealing.value = true;
    clearMessages();
    try {
      const payload = await client.revealReplaySession(session.value.id, {
        actionId: createActionId(),
        expectedRevision: session.value.revision,
      });
      setSession(payload.session);
      statusMessage.value = "答案已揭晓，现已展示真实标的与完整行情窗口。";
      return payload.session;
    } catch (error) {
      if (error?.status === 409) {
        await refreshSession({ conflict: true });
        return null;
      }
      errorMessage.value = error?.message ?? "揭晓答案失败";
      return null;
    } finally {
      isRevealing.value = false;
    }
  }

  async function saveBlindReview(review) {
    if (
      !session.value ||
      isBusy.value ||
      !isCompleted.value ||
      isRevealed.value ||
      session.value.review?.blindSaved
    ) {
      return null;
    }
    isSavingBlindReview.value = true;
    clearMessages();
    try {
      const payload = await client.saveReplayBlindReview(session.value.id, {
        actionId: createActionId(),
        expectedRevision: session.value.revision,
        ...review,
      });
      setSession(payload.session);
      statusMessage.value =
        "原始盲评已保存并锁定；后续补充请使用“追加修正”。";
      return payload.session;
    } catch (error) {
      if (error?.status === 409) {
        await refreshSession({ conflict: true });
        return null;
      }
      errorMessage.value = error?.message ?? "保存盲评失败";
      return null;
    } finally {
      isSavingBlindReview.value = false;
    }
  }

  async function savePostReview(review) {
    if (
      !session.value ||
      isBusy.value ||
      !isRevealed.value ||
      session.value.review?.postSaved
    ) {
      return null;
    }
    isSavingPostReview.value = true;
    clearMessages();
    try {
      const payload = await client.saveReplayPostReview(session.value.id, {
        actionId: createActionId(),
        expectedRevision: session.value.revision,
        ...review,
      });
      setSession(payload.session);
      statusMessage.value =
        "原始事后复盘已保存并锁定；原始评分不会再改变。";
      return payload.session;
    } catch (error) {
      if (error?.status === 409) {
        await refreshSession({ conflict: true });
        return null;
      }
      errorMessage.value = error?.message ?? "保存事后复盘失败";
      return null;
    } finally {
      isSavingPostReview.value = false;
    }
  }

  async function addReviewCorrection(stage, correction) {
    const isBlind = stage === "blind";
    const savingState = isBlind
      ? isSavingBlindCorrection
      : isSavingPostCorrection;
    const reviewSaved = isBlind
      ? session.value?.review?.blindSaved
      : session.value?.review?.postSaved;
    if (
      !session.value ||
      isBusy.value ||
      !reviewSaved ||
      (!isBlind && !isRevealed.value)
    ) {
      return null;
    }
    savingState.value = true;
    clearMessages();
    try {
      const apiMethod = isBlind
        ? client.addReplayBlindReviewCorrection
        : client.addReplayPostReviewCorrection;
      const payload = await apiMethod(session.value.id, {
        actionId: createActionId(),
        expectedRevision: session.value.revision,
        ...correction,
      });
      setSession(payload.session);
      statusMessage.value =
        `${isBlind ? "盲评" : "事后复盘"}修正已追加；原始记录与原始评分均未改变。`;
      return payload.session;
    } catch (error) {
      if (error?.status === 409) {
        await refreshSession({ conflict: true });
        return null;
      }
      errorMessage.value =
        error?.message ?? `追加${isBlind ? "盲评" : "事后复盘"}修正失败`;
      return null;
    } finally {
      savingState.value = false;
    }
  }

  function addBlindReviewCorrection(correction) {
    return addReviewCorrection("blind", correction);
  }

  function addPostReviewCorrection(correction) {
    return addReviewCorrection("post", correction);
  }

  async function updateReviewCorrection(correctionId, stage, correction) {
    const savingState = stage === "blind"
      ? isSavingBlindCorrection
      : isSavingPostCorrection;
    if (!session.value || isBusy.value || savingState.value) return null;
    savingState.value = true;
    clearMessages();
    try {
      const payload = await client.updateReplayReviewCorrection(
        session.value.id,
        stage,
        correctionId,
        {
          actionId: createActionId(),
          expectedRevision: session.value.revision,
          ...correction,
        },
      );
      setSession(payload.session);
      statusMessage.value = "复盘修正记录已更新。";
      return payload.session;
    } catch (error) {
      if (error?.status === 409) {
        await refreshSession({ conflict: true });
        return null;
      }
      errorMessage.value = error?.message ?? "复盘修正记录更新失败";
      return null;
    } finally {
      savingState.value = false;
    }
  }

  async function deleteReviewCorrection(correctionId, stage) {
    if (!session.value || isBusy.value) return null;
    clearMessages();
    try {
      const payload = await client.deleteReplayReviewCorrection(
        session.value.id,
        stage,
        correctionId,
        {
          actionId: createActionId(),
          expectedRevision: session.value.revision,
        },
      );
      setSession(payload.session);
      statusMessage.value = "复盘修正记录已删除。";
      return payload.session;
    } catch (error) {
      if (error?.status === 409) {
        await refreshSession({ conflict: true });
        return null;
      }
      errorMessage.value = error?.message ?? "复盘修正记录删除失败";
      return null;
    }
  }

  async function cancelRetrain() {
    const retrainId = session.value?.id;
    const sourceSessionId = session.value?.attemptInfo?.sourceSessionId;
    if (!retrainId || !sourceSessionId || isBusy.value) {
      return null;
    }
    isCancellingRetrain.value = true;
    clearMessages();
    try {
      await client.deleteReplaySession(retrainId);
      const restored = await refreshSession({ sessionId: sourceSessionId });
      if (restored) {
        statusMessage.value = "本次复练已取消，已返回首次演练结果。";
      }
      return restored;
    } catch (error) {
      errorMessage.value = error?.message ?? "取消复练失败";
      return null;
    } finally {
      isCancellingRetrain.value = false;
    }
  }

  function startNewSession() {
    if (isBusy.value) {
      return;
    }
    setSession(null);
    clearMessages();
  }

  if (options.restoreOnMount !== false) {
    onMounted(restoreSession);
  }

  return {
    session: readonly(session),
    hasSession,
    isCompleted,
    isRevealed,
    isBusy,
    isRestoring: readonly(isRestoring),
    isCreating: readonly(isCreating),
    isSubmitting: readonly(isSubmitting),
    isAdvancing: readonly(isAdvancing),
    isFinishing: readonly(isFinishing),
    isRevealing: readonly(isRevealing),
    isSavingBlindReview: readonly(isSavingBlindReview),
    isSavingPostReview: readonly(isSavingPostReview),
    isSavingBlindCorrection: readonly(isSavingBlindCorrection),
    isSavingPostCorrection: readonly(isSavingPostCorrection),
    isCancellingRetrain: readonly(isCancellingRetrain),
    errorMessage: readonly(errorMessage),
    statusMessage: readonly(statusMessage),
    createSession,
    submitOrder,
    advanceSession,
    finishSession,
    skipSessionAndRestart,
    revealSession,
    saveBlindReview,
    savePostReview,
    addBlindReviewCorrection,
    addPostReviewCorrection,
    updateReviewCorrection,
    deleteReviewCorrection,
    cancelRetrain,
    refreshSession,
    syncStoredSession,
    startNewSession,
    clearMessages,
  };
}
