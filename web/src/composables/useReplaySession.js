import {
  computed,
  onMounted,
  readonly,
  shallowRef,
} from "vue";

import { api } from "../services/api.js";
import { buildReplayRestartOptions } from "../utils/replayRestart.js";
import {
  INITIAL_REPLAY_SESSION_OPERATION,
  reduceReplaySessionOperation,
} from "../utils/replaySessionOperation.js";

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
  const operation = shallowRef(INITIAL_REPLAY_SESSION_OPERATION);
  const activity = computed(() => operation.value.activity);
  const errorMessage = computed(() => operation.value.errorMessage);
  const statusMessage = computed(() => operation.value.statusMessage);
  const hasSession = computed(() => Boolean(session.value?.id));
  const isCompleted = computed(() => session.value?.status === "completed");
  const isRevealed = computed(() => Boolean(session.value?.revealed));
  const isBusy = computed(() => activity.value !== null);

  function dispatch(event) {
    operation.value = reduceReplaySessionOperation(operation.value, event);
  }

  function setError(message) {
    dispatch({ type: "failed", message });
  }

  function setStatus(message) {
    dispatch({ type: "status", message });
  }

  async function runOperation(nextActivity, execute) {
    if (isBusy.value) return null;
    dispatch({ type: "started", activity: nextActivity });
    try {
      return await execute();
    } finally {
      dispatch({ type: "settled" });
    }
  }

  function setSession(nextSession) {
    session.value = nextSession ?? null;
    storeSessionId(storage, nextSession?.id ?? "");
  }

  function clearMessages() {
    dispatch({ type: "messagesCleared" });
  }

  async function readSession(options = {}) {
    const sessionId =
      options.sessionId ?? session.value?.id ?? readStoredSessionId(storage);
    if (!sessionId) {
      return null;
    }
    try {
      const payload = await client.getReplaySession(sessionId);
      setSession(payload.session);
      if (options.conflict) {
        setStatus("检测到会话已更新，已刷新到最新进度，请确认后重试。");
      }
      return payload.session;
    } catch (error) {
      if (error?.status === 404) {
        setSession(null);
        setError("上次演练记录不存在，请重新创建一局。");
        return null;
      }
      setError(error?.message ?? "行情演练加载失败");
      return null;
    }
  }

  async function refreshSession(options = {}) {
    const sessionId =
      options.sessionId ?? session.value?.id ?? readStoredSessionId(storage);
    if (!sessionId) return null;
    return runOperation("restoring", () => readSession({ ...options, sessionId }));
  }

  async function resumeSession(sessionId) {
    if (!sessionId) return null;
    return refreshSession({ sessionId });
  }

  async function restoreSession() {
    return resumeSession(readStoredSessionId(storage));
  }

  async function syncStoredSession() {
    const sessionId = readStoredSessionId(storage);
    if (!sessionId || sessionId === session.value?.id || isBusy.value) {
      return session.value;
    }
    return refreshSession({ sessionId });
  }

  async function createSession(options) {
    return runOperation("creating", async () => {
      try {
        const payload = await client.createReplaySession(options);
        setSession(payload.session);
        setStatus(payload.session.interval === "hybrid"
          ? `日内模拟已创建：主图保留 250 根日线，分时区按${Number(payload.session.stepMinutes ?? 1)}分钟推进。`
          : payload.session.interval === "1m"
            ? "分钟盲测场景已创建，已展示 250 根观察分钟线。"
            : "盲测场景已创建，已展示 250 根观察日线。");
        return payload.session;
      } catch (error) {
        setError(error?.message ?? "创建行情演练失败");
        return null;
      }
    });
  }

  async function submitOrder(order) {
    if (!session.value || isCompleted.value) {
      return null;
    }
    return runOperation("submitting", async () => {
      try {
        const payload = await client.submitReplayOrder(session.value.id, {
          actionId: createActionId(),
          expectedRevision: session.value.revision,
          ...order,
        });
        setSession(payload.session);
        setStatus(order.orderType === "stop"
          ? "持仓止损已设置；触发后持续退出，直到卖完或主动取消。"
          : order.orderType === "limit"
            ? "限价委托已提交，从下一根K线起等待到价；该交易日收盘取消未成交余量。"
          : session.value.interval === "hybrid"
          ? `委托已提交，将在下一根${Number(session.value.stepMinutes ?? 1)}分钟K线开盘尝试成交。`
          : session.value.interval === "1m"
          ? "委托已提交，将在下一分钟开盘尝试成交。"
          : "委托已提交，将在下一交易日开盘尝试成交。");
        return payload.session;
      } catch (error) {
        if (error?.status === 409) {
          await readSession({ conflict: true });
          return null;
        }
        setError(error?.message ?? "提交委托失败");
        return null;
      }
    });
  }

  async function advanceSession(mode = "minute") {
    if (!session.value || isCompleted.value) {
      return null;
    }
    return runOperation("advancing", async () => {
      try {
        const payload = await client.advanceReplaySession(session.value.id, {
          actionId: createActionId(),
          expectedRevision: session.value.revision,
          mode,
        });
        setSession(payload.session);
        setStatus(payload.session.status === "completed"
          ? "本局演练已完成，持仓按最后收盘价估值。"
          : "");
        return payload.session;
      } catch (error) {
        if (error?.status === 409) {
          await readSession({ conflict: true });
          return null;
        }
        setError(error?.message ?? "推进行情失败");
        return null;
      }
    });
  }

  async function finishSession() {
    if (!session.value || isCompleted.value) {
      return null;
    }
    return runOperation("finishing", async () => {
      try {
        const payload = await client.finishReplaySession(session.value.id, {
          actionId: createActionId(),
          expectedRevision: session.value.revision,
        });
        setSession(payload.session);
        setStatus("已提前交卷，未执行委托已取消，当前持仓按交卷时收盘价估值。");
        return payload.session;
      } catch (error) {
        if (error?.status === 409) {
          await readSession({ conflict: true });
          return null;
        }
        setError(error?.message ?? "提前交卷失败");
        return null;
      }
    });
  }

  async function skipSessionAndRestart() {
    if (!session.value || isBusy.value || isCompleted.value) {
      return null;
    }
    const restartOptions = buildReplayRestartOptions(session.value);
    if (!restartOptions.benchmarkCode) {
      setError("当前演练缺少指数基准，无法按原配置换一局。");
      return null;
    }

    return runOperation("finishing", async () => {
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
        setStatus("上一局已记录为无交易机会，并按相同配置换了一局。");
        return created.session;
      } catch (error) {
        if (!finishedSession && error?.status === 409) {
          await readSession({ conflict: true });
          return null;
        }
        setError(finishedSession
          ? `上一局已记录为无交易机会，但新行情创建失败：${error?.message ?? "未知错误"}`
          : error?.message ?? "结束并换一局失败");
        return null;
      }
    });
  }

  async function revealSession() {
    if (
      !session.value ||
      !isCompleted.value ||
      isRevealed.value ||
      !session.value.review?.blindSaved
    ) {
      return null;
    }
    return runOperation("revealing", async () => {
      try {
        const payload = await client.revealReplaySession(session.value.id, {
          actionId: createActionId(),
          expectedRevision: session.value.revision,
        });
        setSession(payload.session);
        setStatus("答案已揭晓，现已展示真实标的与完整行情窗口。");
        return payload.session;
      } catch (error) {
        if (error?.status === 409) {
          await readSession({ conflict: true });
          return null;
        }
        setError(error?.message ?? "揭晓答案失败");
        return null;
      }
    });
  }

  async function saveBlindReview(review) {
    if (
      !session.value ||
      !isCompleted.value ||
      isRevealed.value ||
      session.value.review?.blindSaved
    ) {
      return null;
    }
    return runOperation("savingBlindReview", async () => {
      try {
        const payload = await client.saveReplayBlindReview(session.value.id, {
          actionId: createActionId(),
          expectedRevision: session.value.revision,
          ...review,
        });
        setSession(payload.session);
        setStatus("原始盲评已保存并锁定；后续补充请使用“追加修正”。");
        return payload.session;
      } catch (error) {
        if (error?.status === 409) {
          await readSession({ conflict: true });
          return null;
        }
        setError(error?.message ?? "保存盲评失败");
        return null;
      }
    });
  }

  async function savePostReview(review) {
    if (
      !session.value ||
      !isRevealed.value ||
      session.value.review?.postSaved
    ) {
      return null;
    }
    return runOperation("savingPostReview", async () => {
      try {
        const payload = await client.saveReplayPostReview(session.value.id, {
          actionId: createActionId(),
          expectedRevision: session.value.revision,
          ...review,
        });
        setSession(payload.session);
        setStatus("原始事后复盘已保存并锁定；原始评分不会再改变。");
        return payload.session;
      } catch (error) {
        if (error?.status === 409) {
          await readSession({ conflict: true });
          return null;
        }
        setError(error?.message ?? "保存事后复盘失败");
        return null;
      }
    });
  }

  async function addReviewCorrection(stage, correction) {
    const isBlind = stage === "blind";
    const nextActivity = isBlind
      ? "savingBlindCorrection"
      : "savingPostCorrection";
    const reviewSaved = isBlind
      ? session.value?.review?.blindSaved
      : session.value?.review?.postSaved;
    if (
      !session.value ||
      !reviewSaved ||
      (!isBlind && !isRevealed.value)
    ) {
      return null;
    }
    return runOperation(nextActivity, async () => {
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
        setStatus(`${isBlind ? "盲评" : "事后复盘"}修正已追加；原始记录与原始评分均未改变。`);
        return payload.session;
      } catch (error) {
        if (error?.status === 409) {
          await readSession({ conflict: true });
          return null;
        }
        setError(error?.message ?? `追加${isBlind ? "盲评" : "事后复盘"}修正失败`);
        return null;
      }
    });
  }

  function addBlindReviewCorrection(correction) {
    return addReviewCorrection("blind", correction);
  }

  function addPostReviewCorrection(correction) {
    return addReviewCorrection("post", correction);
  }

  async function updateReviewCorrection(correctionId, stage, correction) {
    const nextActivity = stage === "blind"
      ? "savingBlindCorrection"
      : "savingPostCorrection";
    if (!session.value) return null;
    return runOperation(nextActivity, async () => {
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
        setStatus("复盘修正记录已更新。");
        return payload.session;
      } catch (error) {
        if (error?.status === 409) {
          await readSession({ conflict: true });
          return null;
        }
        setError(error?.message ?? "复盘修正记录更新失败");
        return null;
      }
    });
  }

  async function deleteReviewCorrection(correctionId, stage) {
    if (!session.value) return null;
    const nextActivity = stage === "blind" ? "savingBlindCorrection" : "savingPostCorrection";
    return runOperation(nextActivity, async () => {
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
        setStatus("复盘修正记录已删除。");
        return payload.session;
      } catch (error) {
        if (error?.status === 409) {
          await readSession({ conflict: true });
          return null;
        }
        setError(error?.message ?? "复盘修正记录删除失败");
        return null;
      }
    });
  }

  async function cancelRetrain() {
    const retrainId = session.value?.id;
    const sourceSessionId = session.value?.attemptInfo?.sourceSessionId;
    if (!retrainId || !sourceSessionId) {
      return null;
    }
    return runOperation("cancellingRetrain", async () => {
      try {
        await client.deleteReplaySession(retrainId);
        // The delete is committed. Never restore its ID while the source loads.
        setSession(null);
        storeSessionId(storage, sourceSessionId);
        setStatus("本次复练已取消，正在返回首次演练结果。");
        const restored = await readSession({ sessionId: sourceSessionId });
        if (restored) {
          setStatus("本次复练已取消，已返回首次演练结果。");
        } else {
          setStatus("本次复练已取消；来源演练尚未加载。");
        }
        return restored;
      } catch (error) {
        setError(error?.message ?? "取消复练失败");
        return null;
      }
    });
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
    activity,
    errorMessage: readonly(errorMessage),
    statusMessage: readonly(statusMessage),
    createSession,
    submitOrder,
    async cancelOrder(orderId) {
      if (!session.value || isCompleted.value) return null;
      return runOperation("submitting", async () => {
        try {
          const payload = await client.cancelReplayOrder(session.value.id, orderId, {
            actionId: createActionId(), expectedRevision: session.value.revision,
          });
          setSession(payload.session);
          setStatus("未成交余量已取消，已有成交保留。");
          return payload.session;
        } catch (error) {
          if (error?.status === 409) await readSession({ conflict: true });
          else setError(error?.message ?? "撤单失败");
          return null;
        }
      });
    },
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
    resumeSession,
    syncStoredSession,
    startNewSession,
    clearMessages,
  };
}
