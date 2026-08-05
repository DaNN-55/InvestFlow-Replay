import { spawn, spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, extname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const MODULE_DIR = dirname(fileURLToPath(import.meta.url));
const DEFAULT_WORKSPACE_ROOT = resolve(MODULE_DIR, "..", "..");

const CATEGORY_DEFINITIONS = [
  { id: "strategies", label: "研究策略", relativePath: ["strategies"] },
  { id: "journals", label: "研究日记", relativePath: ["journals"] },
  { id: "results", label: "结果归档", relativePath: ["results"] },
  { id: "docs", label: "文档", relativePath: ["docs"] },
  { id: "notebooks", label: "Notebook", relativePath: ["notebooks"] },
  { id: "exports", label: "导出文件", relativePath: ["exports"] },
  { id: "notes", label: "总日志", relativePath: ["notes.md"], kind: "file" },
];

const CATEGORY_MAP = new Map(
  CATEGORY_DEFINITIONS.map((definition) => [definition.id, definition]),
);

const LOCAL_PATH_PREFIX = "@local";
const BINARY_EXTENSIONS = new Set([
  ".7z",
  ".avi",
  ".bmp",
  ".doc",
  ".docx",
  ".gif",
  ".gz",
  ".ico",
  ".jpeg",
  ".jpg",
  ".mov",
  ".mp3",
  ".mp4",
  ".pdf",
  ".png",
  ".ppt",
  ".pptx",
  ".rar",
  ".so",
  ".tar",
  ".wav",
  ".xls",
  ".xlsx",
  ".zip",
]);

function normalizePath(value) {
  return String(value ?? "")
    .replaceAll("\\", "/")
    .replace(/^\/+/, "");
}

function isTextFile(pathname) {
  return !BINARY_EXTENSIONS.has(extname(pathname).toLowerCase());
}

function isSkippable(name) {
  return name === ".DS_Store" || name === "__pycache__" || name.startsWith(".");
}

function splitPathSegments(pathname) {
  return String(pathname)
    .split(/[\\/]+/)
    .filter(Boolean);
}

function isWithinRoot(rootPath, targetPath) {
  const relativePath = relative(rootPath, targetPath);
  return (
    relativePath === "" ||
    (!relativePath.startsWith("..") && !isAbsolute(relativePath))
  );
}

function resolveComparablePath(targetPath) {
  const absolutePath = resolve(targetPath);
  if (existsSync(absolutePath)) {
    return realpathSync(absolutePath);
  }

  const missingSegments = [];
  let currentPath = absolutePath;
  while (!existsSync(currentPath)) {
    const parentPath = dirname(currentPath);
    if (parentPath === currentPath) {
      return absolutePath;
    }
    missingSegments.unshift(basename(currentPath));
    currentPath = parentPath;
  }

  let comparablePath = realpathSync(currentPath);
  for (const segment of missingSegments) {
    comparablePath = resolve(comparablePath, segment);
  }
  return comparablePath;
}

function ensureInsideRoot(rootPath, targetPath, options = {}) {
  const allowMissing = Boolean(options.allowMissing);

  try {
    const resolvedRoot = realpathSync(rootPath);
    const resolvedTarget = resolveComparablePath(targetPath);
    if (!isWithinRoot(resolvedRoot, resolvedTarget)) {
      return false;
    }

    const segments = splitPathSegments(relative(resolvedRoot, resolvedTarget));
    let currentPath = resolvedRoot;

    for (let index = 0; index < segments.length; index += 1) {
      currentPath = resolve(currentPath, segments[index]);
      const isLast = index === segments.length - 1;

      if (!existsSync(currentPath)) {
        return allowMissing;
      }

      const stats = lstatSync(currentPath);
      if (stats.isSymbolicLink()) {
        return false;
      }
      if (!isLast && !stats.isDirectory()) {
        return false;
      }
    }

    return true;
  } catch {
    return false;
  }
}

function toIsoDate(value) {
  return value.toISOString();
}

function encodeLocalWorkspacePath(rootPath, relativePath) {
  return normalizePath(
    `${LOCAL_PATH_PREFIX}/${encodeURIComponent(rootPath)}/${normalizePath(relativePath)}`,
  );
}

function decodeLocalWorkspacePath(requestPath) {
  const normalizedPath = normalizePath(requestPath);
  if (!normalizedPath.startsWith(`${LOCAL_PATH_PREFIX}/`)) {
    return null;
  }

  const [, encodedRootPath, ...relativeSegments] = normalizedPath.split("/");
  if (!encodedRootPath || !relativeSegments.length) {
    return null;
  }

  const rootPath = resolve(decodeURIComponent(encodedRootPath));
  const relativePath = normalizePath(relativeSegments.join("/"));
  if (!relativePath) {
    return null;
  }

  return {
    rootPath,
    relativePath,
    requestPath: normalizedPath,
  };
}

function createWorkspaceEntryRecord(
  categoryId,
  absolutePath,
  relativePath,
  extra = {},
) {
  const stats = statSync(absolutePath);
  const kind = stats.isDirectory() ? "directory" : "file";
  const extension = extname(absolutePath).toLowerCase();
  const previewable = stats.isFile() && isTextFile(absolutePath);
  const editable = previewable && stats.isFile();

  return {
    path: normalizePath(relativePath),
    category: categoryId,
    kind,
    name: basename(absolutePath),
    extension: kind === "file" ? extension : "",
    size: stats.size,
    updatedAt: toIsoDate(stats.mtime),
    previewable,
    editable,
    ...extra,
  };
}

function walkDirectory(
  categoryId,
  absoluteDir,
  relativeDir = categoryId,
  options = {},
) {
  if (!existsSync(absoluteDir)) {
    return [];
  }

  const entries = readdirSync(absoluteDir, { withFileTypes: true })
    .filter((entry) => !isSkippable(entry.name) && !entry.isSymbolicLink())
    .sort((left, right) => left.name.localeCompare(right.name));

  const entriesList = [];
  for (const entry of entries) {
    const entryAbsolutePath = resolve(absoluteDir, entry.name);
    const entryRelativePath = normalizePath(`${relativeDir}/${entry.name}`);

    if (entry.isDirectory()) {
      if (options.includeDirectories) {
        const requestPath =
          typeof options.mapPath === "function"
            ? options.mapPath(entryRelativePath)
            : entryRelativePath;
        const extra =
          typeof options.getExtra === "function"
            ? options.getExtra(entryRelativePath)
            : {};
        entriesList.push(
          createWorkspaceEntryRecord(
            categoryId,
            entryAbsolutePath,
            requestPath,
            extra,
          ),
        );
      }
      entriesList.push(
        ...walkDirectory(
          categoryId,
          entryAbsolutePath,
          entryRelativePath,
          options,
        ),
      );
      continue;
    }

    if (entry.isFile()) {
      const requestPath =
        typeof options.mapPath === "function"
          ? options.mapPath(entryRelativePath)
          : entryRelativePath;
      const extra =
        typeof options.getExtra === "function"
          ? options.getExtra(entryRelativePath)
          : {};
      entriesList.push(
        createWorkspaceEntryRecord(
          categoryId,
          entryAbsolutePath,
          requestPath,
          extra,
        ),
      );
    }
  }

  return entriesList;
}

function createRecentFilePreview(file) {
  return {
    path: file.path,
    category: file.category,
    name: file.name,
    updatedAt: file.updatedAt,
    editable: file.editable,
  };
}

function openFolderInSystem(targetPath) {
  const platform = process.platform;
  let command = "xdg-open";
  let args = [targetPath];

  if (platform === "darwin") {
    command = "open";
  } else if (platform === "win32") {
    command = "explorer";
    args = [targetPath.replaceAll("/", "\\")];
  }

  const child = spawn(command, args, {
    detached: true,
    stdio: "ignore",
  });
  child.unref();
}

function resolveLocalFolder(rootPath) {
  if (typeof rootPath !== "string" || !rootPath.trim()) {
    return null;
  }

  const absolutePath = resolve(rootPath.trim());
  if (!existsSync(absolutePath) || !statSync(absolutePath).isDirectory()) {
    return null;
  }

  return absolutePath;
}

function createFolderPayload(rootPath) {
  return {
    category: "local",
    rootPath,
    label: basename(rootPath) || rootPath,
    path: rootPath,
  };
}

function pickFolderInSystem(defaultPath) {
  if (process.platform === "darwin") {
    const escapedDefaultPath = JSON.stringify(defaultPath);
    const script = [
      "set defaultLocation to POSIX file " + escapedDefaultPath,
      'set selectedFolder to choose folder with prompt "选择要打开的本地文件夹" default location defaultLocation',
      "return POSIX path of selectedFolder",
    ].join("\n");
    const result = spawnSync("osascript", ["-e", script], {
      encoding: "utf8",
    });
    if (result.status === 0) {
      return String(result.stdout ?? "")
        .trim()
        .replace(/\/$/, "");
    }
    const errorOutput = `${result.stderr ?? ""}\n${result.stdout ?? ""}`;
    if (/User canceled|(-128)/i.test(errorOutput)) {
      return null;
    }
    throw new Error("打开本地文件夹选择器失败");
  }

  throw new Error("当前系统暂不支持文件夹选择器，请手动输入目录路径");
}

export function createWorkspaceService(workspaceRoot = DEFAULT_WORKSPACE_ROOT) {
  function getCategoryRoot(categoryId) {
    const definition = CATEGORY_MAP.get(categoryId);
    if (!definition) {
      return null;
    }
    return resolve(workspaceRoot, ...definition.relativePath);
  }

  function resolveWorkspacePath(requestPath) {
    const normalizedPath = normalizePath(requestPath);
    if (!normalizedPath) {
      return null;
    }

    const localPath = decodeLocalWorkspacePath(normalizedPath);
    if (localPath) {
      const absolutePath = resolve(localPath.rootPath, localPath.relativePath);
      if (
        !ensureInsideRoot(localPath.rootPath, absolutePath, {
          allowMissing: true,
        })
      ) {
        return null;
      }
      return {
        categoryId: "local",
        rootPath: localPath.rootPath,
        absolutePath,
        relativePath: localPath.requestPath,
        displayPath: localPath.relativePath,
      };
    }

    if (normalizedPath === "notes.md") {
      const rootPath = getCategoryRoot("notes");
      return {
        categoryId: "notes",
        absolutePath: rootPath,
        relativePath: "notes.md",
      };
    }

    const [categoryId, ...rest] = normalizedPath.split("/");
    const categoryRoot = getCategoryRoot(categoryId);
    if (!categoryRoot || CATEGORY_MAP.get(categoryId)?.kind === "file") {
      return null;
    }

    const absolutePath = resolve(categoryRoot, ...rest);
    if (
      !ensureInsideRoot(categoryRoot, absolutePath, {
        allowMissing: true,
      })
    ) {
      return null;
    }

    return {
      categoryId,
      absolutePath,
      relativePath: normalizedPath,
    };
  }

  function listFiles(categoryId) {
    const definition = CATEGORY_MAP.get(categoryId);
    if (!definition) {
      return null;
    }

    if (definition.kind === "file") {
      const absolutePath = getCategoryRoot(categoryId);
      if (!existsSync(absolutePath)) {
        return [];
      }
      return [createWorkspaceEntryRecord(categoryId, absolutePath, "notes.md")];
    }

    return walkDirectory(categoryId, getCategoryRoot(categoryId), categoryId, {
      includeDirectories: true,
    });
  }

  function listLocalFiles(rootPath) {
    const absoluteRoot = resolveLocalFolder(rootPath);
    if (!absoluteRoot) {
      return null;
    }

    return walkDirectory("local", absoluteRoot, "", {
      includeDirectories: true,
      mapPath(relativePath) {
        return encodeLocalWorkspacePath(absoluteRoot, relativePath);
      },
      getExtra(relativePath) {
        return {
          displayPath: relativePath,
          rootPath: absoluteRoot,
          rootLabel: basename(absoluteRoot) || absoluteRoot,
        };
      },
    });
  }

  return {
    getCategoryDefinitions() {
      return CATEGORY_DEFINITIONS.map((item) => ({ ...item }));
    },

    getOverview() {
      const categories = CATEGORY_DEFINITIONS.map((definition) => {
        const entries = listFiles(definition.id) ?? [];
        const files = entries.filter((item) => item.kind !== "directory");
        return {
          id: definition.id,
          label: definition.label,
          count: files.length,
        };
      });

      const recentFiles = categories
        .flatMap((category) =>
          (listFiles(category.id) ?? []).filter(
            (item) => item.kind !== "directory",
          ),
        )
        .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
        .slice(0, 10)
        .map(createRecentFilePreview);

      const notesPath = getCategoryRoot("notes");
      const notesSnippet = existsSync(notesPath)
        ? readFileSync(notesPath, "utf8").slice(0, 220)
        : "";

      return {
        workspaceRoot,
        categories,
        recentFiles,
        notesSnippet,
        strategyCount:
          categories.find((item) => item.id === "strategies")?.count ?? 0,
        resultCount:
          categories.find((item) => item.id === "results")?.count ?? 0,
        journalCount:
          categories.find((item) => item.id === "journals")?.count ?? 0,
        notebookCount:
          categories.find((item) => item.id === "notebooks")?.count ?? 0,
      };
    },

    listFiles(target) {
      if (typeof target === "string") {
        return listFiles(target);
      }
      if (target?.rootPath) {
        return listLocalFiles(target.rootPath);
      }
      return null;
    },

    pickFolder(options = {}) {
      const directRootPath = resolveLocalFolder(options.rootPath ?? "");
      if (directRootPath) {
        return createFolderPayload(directRootPath);
      }

      const initialPath =
        resolveLocalFolder(options.initialPath ?? "") ?? workspaceRoot;
      const selectedPath = pickFolderInSystem(initialPath);
      if (!selectedPath) {
        return null;
      }

      return createFolderPayload(selectedPath);
    },

    openFolder(target) {
      const localRoot = resolveLocalFolder(target);
      if (localRoot) {
        openFolderInSystem(localRoot);
        return createFolderPayload(localRoot);
      }

      const definition = CATEGORY_MAP.get(target);
      if (!definition) {
        return null;
      }

      const absolutePath = getCategoryRoot(target);
      const targetPath =
        definition.kind === "file" ? dirname(absolutePath) : absolutePath;
      mkdirSync(targetPath, { recursive: true });
      openFolderInSystem(targetPath);

      return {
        category: target,
        path: targetPath,
      };
    },

    getFile(requestPath) {
      const resolved = resolveWorkspacePath(requestPath);
      if (!resolved || !existsSync(resolved.absolutePath)) {
        return null;
      }

      const file = createWorkspaceEntryRecord(
        resolved.categoryId,
        resolved.absolutePath,
        resolved.relativePath,
        resolved.displayPath
          ? {
              displayPath: resolved.displayPath,
              rootPath: resolved.rootPath,
              rootLabel: basename(resolved.rootPath) || resolved.rootPath,
            }
          : {},
      );

      if (!file.previewable) {
        return {
          file,
          content: null,
          contentKind: "binary",
        };
      }

      return {
        file,
        content: readFileSync(resolved.absolutePath, "utf8"),
        contentKind: "text",
      };
    },

    saveFile(requestPath, content) {
      const resolved = resolveWorkspacePath(requestPath);
      if (!resolved) {
        return null;
      }

      mkdirSync(dirname(resolved.absolutePath), { recursive: true });

      writeFileSync(resolved.absolutePath, content, "utf8");
      return this.getFile(resolved.relativePath);
    },

    createFolder(requestPath) {
      const resolved = resolveWorkspacePath(requestPath);
      if (!resolved) {
        return null;
      }

      if (resolved.relativePath === "notes.md") {
        throw new Error("总日志文件不支持创建目录");
      }

      if (existsSync(resolved.absolutePath)) {
        throw new Error("目标目录已存在，请换一个名称");
      }

      mkdirSync(resolved.absolutePath, { recursive: true });
      return createWorkspaceEntryRecord(
        resolved.categoryId,
        resolved.absolutePath,
        resolved.relativePath,
        resolved.displayPath
          ? {
              displayPath: resolved.displayPath,
              rootPath: resolved.rootPath,
              rootLabel: basename(resolved.rootPath) || resolved.rootPath,
            }
          : {},
      );
    },

    renameFolder(requestPath, nextPath) {
      const source = resolveWorkspacePath(requestPath);
      const target = resolveWorkspacePath(nextPath);
      if (!source || !target) {
        return null;
      }

      if (source.categoryId !== target.categoryId) {
        throw new Error("不支持跨目录重命名");
      }

      if (
        source.rootPath &&
        target.rootPath &&
        source.rootPath !== target.rootPath
      ) {
        throw new Error("不支持跨目录重命名");
      }

      if (
        source.relativePath === "notes.md" ||
        target.relativePath === "notes.md"
      ) {
        throw new Error("总日志文件不支持重命名");
      }

      if (!existsSync(source.absolutePath)) {
        return null;
      }

      const sourceStats = statSync(source.absolutePath);
      if (!sourceStats.isDirectory()) {
        throw new Error("当前只支持重命名目录，不支持重命名文件");
      }

      if (existsSync(target.absolutePath)) {
        throw new Error("目标目录名已存在，请换一个名称");
      }

      mkdirSync(dirname(target.absolutePath), { recursive: true });
      renameSync(source.absolutePath, target.absolutePath);
      return createWorkspaceEntryRecord(
        target.categoryId,
        target.absolutePath,
        target.relativePath,
        target.displayPath
          ? {
              displayPath: target.displayPath,
              rootPath: target.rootPath,
              rootLabel: basename(target.rootPath) || target.rootPath,
            }
          : {},
      );
    },

    renameFile(requestPath, nextPath) {
      const source = resolveWorkspacePath(requestPath);
      const target = resolveWorkspacePath(nextPath);
      if (!source || !target) {
        return null;
      }

      if (source.categoryId !== target.categoryId) {
        throw new Error("不支持跨目录重命名");
      }

      if (
        source.rootPath &&
        target.rootPath &&
        source.rootPath !== target.rootPath
      ) {
        throw new Error("不支持跨目录重命名");
      }

      if (
        source.relativePath === "notes.md" ||
        target.relativePath === "notes.md"
      ) {
        throw new Error("总日志文件不支持重命名");
      }

      if (!existsSync(source.absolutePath)) {
        return null;
      }

      if (existsSync(target.absolutePath)) {
        throw new Error("目标文件名已存在，请换一个名称");
      }

      mkdirSync(dirname(target.absolutePath), { recursive: true });
      renameSync(source.absolutePath, target.absolutePath);
      return this.getFile(target.relativePath);
    },

    copyFile(requestPath, nextPath) {
      const source = resolveWorkspacePath(requestPath);
      const target = resolveWorkspacePath(nextPath);
      if (!source || !target) {
        return null;
      }

      if (source.categoryId !== target.categoryId) {
        throw new Error("不支持跨目录复制");
      }

      if (
        source.rootPath &&
        target.rootPath &&
        source.rootPath !== target.rootPath
      ) {
        throw new Error("不支持跨目录复制");
      }

      if (
        source.relativePath === "notes.md" ||
        target.relativePath === "notes.md"
      ) {
        throw new Error("总日志文件不支持复制");
      }

      if (!existsSync(source.absolutePath)) {
        return null;
      }

      const sourceStats = statSync(source.absolutePath);
      if (!sourceStats.isFile()) {
        throw new Error("当前只支持复制文件，不支持复制目录");
      }

      if (existsSync(target.absolutePath)) {
        throw new Error("目标文件名已存在，请换一个名称");
      }

      mkdirSync(dirname(target.absolutePath), { recursive: true });
      copyFileSync(source.absolutePath, target.absolutePath);
      return this.getFile(target.relativePath);
    },

    deleteFolder(requestPath) {
      const resolved = resolveWorkspacePath(requestPath);
      if (!resolved) {
        return null;
      }

      if (resolved.relativePath === "notes.md") {
        throw new Error("总日志文件不支持删除");
      }

      if (!existsSync(resolved.absolutePath)) {
        return null;
      }

      const stats = statSync(resolved.absolutePath);
      if (!stats.isDirectory()) {
        throw new Error("当前只支持删除目录，不支持删除文件");
      }

      rmSync(resolved.absolutePath, { force: true, recursive: true });
      return {
        path: resolved.relativePath,
        category: resolved.categoryId,
        kind: "directory",
      };
    },

    deleteFile(requestPath) {
      const resolved = resolveWorkspacePath(requestPath);
      if (!resolved) {
        return null;
      }

      if (resolved.relativePath === "notes.md") {
        throw new Error("总日志文件不支持删除");
      }

      if (!existsSync(resolved.absolutePath)) {
        return null;
      }

      const stats = statSync(resolved.absolutePath);
      if (!stats.isFile()) {
        throw new Error("当前只支持删除文件，不支持删除目录");
      }

      rmSync(resolved.absolutePath, { force: true });
      return {
        path: resolved.relativePath,
        category: resolved.categoryId,
      };
    },
  };
}
