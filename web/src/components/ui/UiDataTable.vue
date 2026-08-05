<script setup>
import {
  FlexRender,
  getCoreRowModel,
  getSortedRowModel,
  useVueTable,
} from "@tanstack/vue-table";
import { computed, getCurrentInstance, ref } from "vue";

const props = defineProps({
  rows: {
    type: Array,
    default: () => [],
  },
  columns: {
    type: Array,
    default: () => [],
  },
  loading: {
    type: Boolean,
    default: false,
  },
  emptyText: {
    type: String,
    default: "暂无数据",
  },
  rowKey: {
    type: [String, Function],
    default: "id",
  },
  selectable: {
    type: Boolean,
    default: false,
  },
  selectedKeys: {
    type: Array,
    default: () => [],
  },
  minWidth: {
    type: String,
    default: "960px",
  },
});

const emit = defineEmits(["update:selectedKeys", "row-click"]);

const sorting = ref([]);
const instance = getCurrentInstance();

const selectedKeySet = computed(() => new Set(props.selectedKeys));
const hasRowClick = computed(() => Boolean(instance?.vnode.props?.onRowClick));

const tableColumns = computed(() => {
  const dataColumns = props.columns.map((column) => ({
    id: column.key,
    accessorKey: column.key,
    header: () => column.header,
    cell: (context) => {
      const row = context.row.original;
      if (typeof column.cell === "function") {
        return column.cell(row);
      }
      return row?.[column.key] ?? "";
    },
    enableSorting: Boolean(column.sortable),
    meta: {
      class: column.class,
      headerClass: column.headerClass,
      sortable: Boolean(column.sortable),
    },
  }));

  if (!props.selectable) {
    return dataColumns;
  }

  return [
    {
      id: "__select",
      header: () => "",
      cell: () => "",
      enableSorting: false,
      meta: {
        class: "ql-w-10 ql-text-center",
        headerClass: "ql-w-10 ql-text-center",
        selection: true,
      },
    },
    ...dataColumns,
  ];
});

const table = useVueTable({
  get data() {
    return props.rows;
  },
  get columns() {
    return tableColumns.value;
  },
  getRowId: (row, index) => String(getRowKey(row) ?? index),
  getCoreRowModel: getCoreRowModel(),
  getSortedRowModel: getSortedRowModel(),
  state: {
    get sorting() {
      return sorting.value;
    },
  },
  onSortingChange: (updater) => {
    sorting.value = typeof updater === "function" ? updater(sorting.value) : updater;
  },
});

const visibleRows = computed(() => table.getRowModel().rows);
const allVisibleSelected = computed(() =>
  visibleRows.value.length > 0 && visibleRows.value.every((row) => isSelected(row.original)),
);
const someVisibleSelected = computed(() =>
  visibleRows.value.some((row) => isSelected(row.original)) && !allVisibleSelected.value,
);
const columnCount = computed(() => table.getAllLeafColumns().length || 1);

function getRowKey(row) {
  if (typeof props.rowKey === "function") {
    return props.rowKey(row);
  }
  return row?.[props.rowKey];
}

function isSelected(row) {
  return selectedKeySet.value.has(getRowKey(row));
}

function updateSelectedKeys(keys) {
  emit("update:selectedKeys", keys);
}

function toggleRow(row, checked) {
  const key = getRowKey(row);
  const nextKeys = props.selectedKeys.filter((selectedKey) => selectedKey !== key);
  if (checked) {
    nextKeys.push(key);
  }
  updateSelectedKeys(nextKeys);
}

function toggleAllVisible(checked) {
  const visibleKeys = visibleRows.value.map((row) => getRowKey(row.original));
  if (checked) {
    updateSelectedKeys([...new Set([...props.selectedKeys, ...visibleKeys])]);
    return;
  }
  updateSelectedKeys(props.selectedKeys.filter((key) => !visibleKeys.includes(key)));
}

function handleRowClick(row) {
  emit("row-click", row.original);
}

function handleHeaderClick(header, event) {
  if (!header.column.getCanSort()) {
    return;
  }
  header.column.getToggleSortingHandler()?.(event);
}

function resolveClass(value, row) {
  if (typeof value === "function") {
    return value(row);
  }
  return value || "";
}

function resolveCellClass(cell) {
  return resolveClass(cell.column.columnDef.meta?.class, cell.row.original);
}

function resolveHeaderClass(header) {
  return resolveClass(header.column.columnDef.meta?.headerClass);
}

function sortLabel(column) {
  const sorted = column.getIsSorted();
  if (sorted === "asc") {
    return "Asc";
  }
  if (sorted === "desc") {
    return "Desc";
  }
  return "";
}
</script>

<template>
  <div class="ql-ui-data-table">
    <div class="ql-ui-data-table__scroll">
      <table class="ql-ui-data-table__table" :style="{ minWidth }">
        <thead class="ql-ui-data-table__head">
          <tr v-for="headerGroup in table.getHeaderGroups()" :key="headerGroup.id">
            <th
              v-for="header in headerGroup.headers"
              :key="header.id"
              class="ql-ui-data-table__header-cell"
              :class="[
                resolveHeaderClass(header),
                header.column.getCanSort() ? 'ql-ui-data-table__header-cell--sortable' : '',
              ]"
            >
              <template v-if="header.column.columnDef.meta?.selection">
                <input
                  type="checkbox"
                  class="ql-ui-data-table__checkbox"
                  :checked="allVisibleSelected"
                  :indeterminate="someVisibleSelected"
                  :disabled="!visibleRows.length"
                  aria-label="选择全部"
                  @change="toggleAllVisible($event.target.checked)"
                />
              </template>
              <button
                v-else-if="header.column.getCanSort()"
                type="button"
                class="ql-ui-data-table__sort-button"
                @click="handleHeaderClick(header, $event)"
              >
                <FlexRender
                  v-if="!header.isPlaceholder"
                  :render="header.column.columnDef.header"
                  :props="header.getContext()"
                />
                <span v-if="sortLabel(header.column)" class="ql-ui-data-table__sort-mark">
                  {{ sortLabel(header.column) }}
                </span>
              </button>
              <FlexRender
                v-else-if="!header.isPlaceholder"
                :render="header.column.columnDef.header"
                :props="header.getContext()"
              />
            </th>
          </tr>
        </thead>
        <tbody class="ql-ui-data-table__body">
          <tr v-if="loading">
            <td :colspan="columnCount" class="ql-ui-data-table__state-cell">
              正在加载...
            </td>
          </tr>
          <tr v-else-if="!visibleRows.length">
            <td :colspan="columnCount" class="ql-ui-data-table__state-cell">
              {{ emptyText }}
            </td>
          </tr>
          <template v-else>
            <tr
              v-for="row in visibleRows"
              :key="row.id"
              class="ql-ui-data-table__row ql-table-hover-row"
              :class="{ 'ql-ui-data-table__row--clickable ql-table-hover-row-clickable': hasRowClick }"
              @click="handleRowClick(row)"
            >
              <td
                v-for="cell in row.getVisibleCells()"
                :key="cell.id"
                class="ql-ui-data-table__cell"
                :class="resolveCellClass(cell)"
              >
                <template v-if="cell.column.columnDef.meta?.selection">
                  <input
                    type="checkbox"
                    class="ql-ui-data-table__checkbox"
                    :checked="isSelected(row.original)"
                    aria-label="选择行"
                    @click.stop
                    @change="toggleRow(row.original, $event.target.checked)"
                  />
                </template>
                <FlexRender
                  v-else
                  :render="cell.column.columnDef.cell"
                  :props="cell.getContext()"
                />
              </td>
            </tr>
          </template>
        </tbody>
      </table>
    </div>
  </div>
</template>

<style scoped>
.ql-ui-data-table {
  overflow: hidden;
  border: 1px solid rgba(15, 23, 42, 0.12);
  border-radius: 8px;
  background: var(--ql-color-bg-surface-strong);
}

.ql-ui-data-table__scroll {
  overflow-x: auto;
}

.ql-ui-data-table__table {
  width: 100%;
  border-collapse: collapse;
  text-align: left;
  font-size: 0.875rem;
}

.ql-ui-data-table__head {
  background: var(--ql-color-bg-muted);
  color: var(--ql-color-text-muted);
  font-size: 0.8125rem;
  letter-spacing: 0;
  text-transform: uppercase;
}

.ql-ui-data-table__header-cell,
.ql-ui-data-table__cell {
  padding: 0.75rem 1rem;
  vertical-align: top;
}

.ql-ui-data-table__body {
  border-top: 1px solid rgba(15, 23, 42, 0.08);
}

.ql-ui-data-table__body > tr + tr {
  border-top: 1px solid rgba(15, 23, 42, 0.08);
}

.ql-ui-data-table__sort-button {
  display: inline-flex;
  align-items: center;
  gap: 0.375rem;
  width: 100%;
  border: 0;
  background: transparent;
  color: inherit;
  cursor: pointer;
  font: inherit;
  font-weight: 600;
  padding: 0;
  text-align: left;
  text-transform: inherit;
}

.ql-ui-data-table__sort-mark {
  color: var(--ql-color-text-strong);
  font-size: 0.6875rem;
  text-transform: none;
}

.ql-ui-data-table__row--clickable {
  cursor: pointer;
}

.ql-ui-data-table__state-cell {
  padding: 1.5rem 1rem;
  text-align: center;
  color: var(--ql-color-text-muted);
}

.ql-ui-data-table__checkbox {
  width: 1rem;
  height: 1rem;
  border-radius: 4px;
}
</style>
