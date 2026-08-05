import {
  computed,
  onMounted,
  readonly,
  ref,
  shallowRef,
} from "vue";

import { api } from "../services/api";

export function useReplayHistory() {
  const items = shallowRef([]);
  const total = ref(0);
  const page = ref(1);
  const pageSize = ref(20);
  const state = ref("all");
  const attemptKind = ref("all");
  const keyword = ref("");
  const loading = ref(false);
  const error = ref("");
  const selectedId = ref("");
  const selectedDetail = shallowRef(null);
  const detailLoading = ref(false);
  const detailError = ref("");
  let requestSequence = 0;
  let detailRequestSequence = 0;

  const selectedItem = computed(
    () => items.value.find((item) => item.id === selectedId.value) ?? null,
  );
  const selectedDetailItem = computed(() => {
    if (selectedDetail.value?.id !== selectedId.value) {
      return null;
    }
    const listItem = selectedItem.value ?? {};
    const detail = selectedDetail.value;
    return {
      ...listItem,
      ...detail,
      blindReview:
        detail.review?.blindReview ?? detail.blindReview ?? null,
      postReview:
        detail.review?.postReview ?? detail.postReview ?? null,
      corrections: Array.isArray(detail.corrections)
        ? detail.corrections
        : [],
    };
  });
  const pageCount = computed(() =>
    Math.max(1, Math.ceil(total.value / pageSize.value)),
  );

  async function loadHistory(options = {}) {
    const sequence = ++requestSequence;
    ++detailRequestSequence;
    selectedDetail.value = null;
    detailError.value = "";
    detailLoading.value = false;
    loading.value = true;
    error.value = "";

    try {
      const result = await api.listReplaySessions({
        state: state.value,
        attemptKind: attemptKind.value,
        keyword: keyword.value,
        page: page.value,
        pageSize: pageSize.value,
      });
      if (sequence !== requestSequence) {
        return;
      }

      items.value = Array.isArray(result.items) ? result.items : [];
      total.value = Number(result.total ?? 0);
      page.value = Number(result.page ?? page.value);
      pageSize.value = Number(result.pageSize ?? pageSize.value);

      if (!items.value.some((item) => item.id === selectedId.value)) {
        selectedId.value = items.value[0]?.id ?? "";
      }
      if (options.loadDetail !== false && selectedId.value) {
        await loadSelectedDetail(selectedId.value);
      }
    } catch (loadError) {
      if (sequence !== requestSequence) {
        return;
      }
      items.value = [];
      total.value = 0;
      selectedId.value = "";
      error.value = loadError?.message ?? "历史演练记录加载失败";
    } finally {
      if (sequence === requestSequence) {
        loading.value = false;
      }
    }
  }

  async function applyFilters(filters = {}) {
    state.value = filters.state ?? state.value;
    attemptKind.value = filters.attemptKind ?? attemptKind.value;
    keyword.value = String(filters.keyword ?? keyword.value).trim();
    page.value = 1;
    await loadHistory();
  }

  async function goToPage(nextPage) {
    const normalizedPage = Math.min(
      pageCount.value,
      Math.max(1, Number(nextPage) || 1),
    );
    if (normalizedPage === page.value) {
      return;
    }
    page.value = normalizedPage;
    await loadHistory();
  }

  function selectItem(itemOrId) {
    const id =
      typeof itemOrId === "string" ? itemOrId : String(itemOrId?.id ?? "");
    if (items.value.some((item) => item.id === id)) {
      selectedId.value = id;
      void loadSelectedDetail(id);
    }
  }

  async function loadSelectedDetail(sessionId = selectedId.value) {
    const normalizedId = String(sessionId ?? "");
    const sequence = ++detailRequestSequence;
    selectedDetail.value = null;
    detailError.value = "";
    if (!normalizedId) {
      detailLoading.value = false;
      return null;
    }
    detailLoading.value = true;
    try {
      const result = await api.getReplaySession(normalizedId);
      if (
        sequence !== detailRequestSequence ||
        normalizedId !== selectedId.value
      ) {
        return null;
      }
      selectedDetail.value = result.session ?? null;
      return selectedDetail.value;
    } catch (loadError) {
      if (
        sequence !== detailRequestSequence ||
        normalizedId !== selectedId.value
      ) {
        return null;
      }
      detailError.value =
        loadError?.message ?? "历史演练详情加载失败";
      return null;
    } finally {
      if (sequence === detailRequestSequence) {
        detailLoading.value = false;
      }
    }
  }

  async function refresh() {
    await loadHistory({ loadDetail: false });
    if (selectedId.value) {
      await loadSelectedDetail(selectedId.value);
    }
  }

  onMounted(loadHistory);

  return {
    items: readonly(items),
    total: readonly(total),
    page: readonly(page),
    pageSize: readonly(pageSize),
    state: readonly(state),
    attemptKind: readonly(attemptKind),
    keyword: readonly(keyword),
    loading: readonly(loading),
    error: readonly(error),
    selectedId: readonly(selectedId),
    selectedItem,
    selectedDetailItem,
    detailLoading: readonly(detailLoading),
    detailError: readonly(detailError),
    pageCount,
    loadHistory,
    applyFilters,
    goToPage,
    selectItem,
    loadSelectedDetail,
    refresh,
  };
}
