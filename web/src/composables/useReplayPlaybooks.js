import {
  computed,
  onMounted,
  readonly,
  shallowRef,
} from "vue";

import { api } from "../services/api";

export function useReplayPlaybooks(options = {}) {
  const playbooks = shallowRef([]);
  const selectedId = shallowRef("");
  const selectedDetail = shallowRef(null);
  const loadingList = shallowRef(false);
  const loadingDetail = shallowRef(false);
  const activeAction = shallowRef("");
  const error = shallowRef("");
  const success = shallowRef("");
  let detailRequestSequence = 0;

  const selectedSummary = computed(
    () =>
      playbooks.value.find((playbook) => playbook.id === selectedId.value) ??
      null,
  );
  const busy = computed(
    () =>
      loadingList.value ||
      loadingDetail.value ||
      Boolean(activeAction.value),
  );

  function clearFeedback() {
    error.value = "";
    success.value = "";
  }

  async function loadPlaybooks() {
    loadingList.value = true;
    error.value = "";
    try {
      const result = await api.listReplayPlaybooks();
      playbooks.value = Array.isArray(result.items) ? result.items : [];
      if (!playbooks.value.some((item) => item.id === selectedId.value)) {
        selectedId.value = playbooks.value[0]?.id ?? "";
      }
      if (selectedId.value) {
        await loadPlaybook(selectedId.value);
      } else {
        selectedDetail.value = null;
      }
      return playbooks.value;
    } catch (loadError) {
      error.value = loadError?.message ?? "战法库加载失败";
      return [];
    } finally {
      loadingList.value = false;
    }
  }

  async function loadPlaybook(playbookId = selectedId.value) {
    if (!playbookId) {
      selectedDetail.value = null;
      return null;
    }
    const sequence = ++detailRequestSequence;
    loadingDetail.value = true;
    error.value = "";
    try {
      const result = await api.getReplayPlaybook(playbookId);
      if (sequence !== detailRequestSequence) {
        return null;
      }
      selectedId.value = playbookId;
      selectedDetail.value = {
        playbook: result.playbook,
        versions: Array.isArray(result.versions) ? result.versions : [],
        candidates: Array.isArray(result.candidates) ? result.candidates : [],
      };
      return selectedDetail.value;
    } catch (loadError) {
      if (sequence === detailRequestSequence) {
        selectedDetail.value = null;
        error.value = loadError?.message ?? "战法详情加载失败";
      }
      return null;
    } finally {
      if (sequence === detailRequestSequence) {
        loadingDetail.value = false;
      }
    }
  }

  async function selectPlaybook(playbookOrId) {
    const id =
      typeof playbookOrId === "string"
        ? playbookOrId
        : String(playbookOrId?.id ?? "");
    if (!id || id === selectedId.value && selectedDetail.value) {
      return selectedDetail.value;
    }
    selectedId.value = id;
    return loadPlaybook(id);
  }

  async function runAction(key, action, successMessage) {
    if (activeAction.value) {
      return null;
    }
    activeAction.value = key;
    clearFeedback();
    try {
      const result = await action();
      success.value = successMessage;
      await loadPlaybooks();
      return result;
    } catch (actionError) {
      error.value = actionError?.message ?? "战法操作失败";
      return null;
    } finally {
      activeAction.value = "";
    }
  }

  function createPlaybook(payload) {
    return runAction(
      "create-playbook",
      async () => {
        const result = await api.createReplayPlaybook(payload);
        selectedId.value = result.playbook?.id ?? selectedId.value;
        return result;
      },
      "战法已创建，并生成首个不可变版本。",
    );
  }

  function createVersion(payload) {
    if (!selectedId.value) {
      return null;
    }
    return runAction(
      "create-version",
      () => api.createReplayPlaybookVersion(selectedId.value, payload),
      "新版本已创建，旧版本保持不变。",
    );
  }

  function deleteVersion(versionId) {
    if (!selectedId.value) {
      return null;
    }
    return runAction(
      `delete-version:${versionId}`,
      () => api.deleteReplayPlaybookVersion(selectedId.value, versionId),
      "历史版本已删除。",
    );
  }

  function renamePlaybook(playbookId, payload) {
    return runAction(
      `rename:${playbookId}`,
      () => api.renameReplayPlaybook(playbookId, payload),
      "战法名称已修改。",
    );
  }

  function deletePlaybook(playbookId) {
    return runAction(
      `delete:${playbookId}`,
      () => api.deleteReplayPlaybook(playbookId),
      "战法已从战法库删除，历史快照仍会保留。",
    );
  }

  function acceptCandidate(candidateId, payload) {
    return runAction(
      `accept:${candidateId}`,
      () => api.acceptReplayPlaybookCandidate(candidateId, payload),
      "候选改进已采纳并生成新版本。",
    );
  }

  function rejectCandidate(candidateId, reason = "") {
    return runAction(
      `reject:${candidateId}`,
      () =>
        api.rejectReplayPlaybookCandidate(candidateId, {
          reason: String(reason).trim(),
        }),
      "候选改进已拒绝，原战法未发生变化。",
    );
  }

  if (options.immediate !== false) {
    onMounted(loadPlaybooks);
  }

  return {
    playbooks: readonly(playbooks),
    selectedId: readonly(selectedId),
    selectedSummary,
    selectedDetail: readonly(selectedDetail),
    loadingList: readonly(loadingList),
    loadingDetail: readonly(loadingDetail),
    activeAction: readonly(activeAction),
    busy,
    error: readonly(error),
    success: readonly(success),
    loadPlaybooks,
    loadPlaybook,
    selectPlaybook,
    createPlaybook,
    createVersion,
    deleteVersion,
    renamePlaybook,
    deletePlaybook,
    acceptCandidate,
    rejectCandidate,
    clearFeedback,
  };
}
