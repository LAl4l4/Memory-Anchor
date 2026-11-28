import { fromDirectoryTreeRegistry, isChartOwner, type DirectoryTreeNode } from '../chartBuild/partition/directoryTree.js';

export interface ProjectStateLayout {
  /** Module line ranges, `end` exclusive; ranges include trailing blank lines. */
  modules: { name: string; start: number; end: number }[];
  /** First `## Module Status` section, `end` exclusive. */
  status?: { start: number; end: number };
}

/** Read module boundaries by line without treating headings in fenced examples as modules. */
export function projectStateLayout(lines: string[]): ProjectStateLayout {
  const layout: ProjectStateLayout = { modules: [] };
  let fence = '';
  let active = false;
  let current: { name: string; start: number } | undefined;
  const flush = (end: number) => {
    if (current) layout.modules.push({ ...current, end });
    current = undefined;
  };
  lines.forEach((line, index) => {
    const marker = line.match(/^\s{0,3}(`{3,}|~{3,})/);
    if (marker) {
      if (!fence) fence = marker[1];
      else if (marker[1][0] === fence[0] && marker[1].length >= fence.length) fence = '';
      return;
    }
    if (fence) return;
    if (/^#{1,2} /.test(line)) {
      flush(index);
      if (active && layout.status && layout.status.end === lines.length) layout.status.end = index;
      active = /^## Module Status\s*#*\s*$/.test(line);
      if (active && !layout.status) layout.status = { start: index, end: lines.length };
    }
    const heading = active && line.match(/^###\s+(.+?)\s*#*\s*$/);
    if (heading) { flush(index); current = { name: heading[1], start: index }; }
  });
  flush(lines.length);
  return layout;
}

export function projectStateModules(content: string): { name: string; content: string }[] {
  const lines = content.split(/\r?\n/);
  const modules = projectStateLayout(lines).modules.map(module => ({ name: module.name,
    content: lines.slice(module.start, module.end).join('\n').trim() }));
  // Legacy/unstructured state stays accessible without injecting its body.
  return modules.length || !content.trim() ? modules : [{ name: '(whole document)', content: content.trim() }];
}

/** One chart level; file-less split wrappers route to their first chart owners. */
export function chartEntryDirectories(registry: string): string[] {
  const root = fromDirectoryTreeRegistry(JSON.parse(registry));
  const entries = ['.'];
  const visit = (node: DirectoryTreeNode): void => {
    if (isChartOwner(node)) entries.push(node.directory);
    else node.children.forEach(visit);
  };
  if (root.isSplit) root.children.forEach(visit);
  return entries;
}

export function compactDirectory(entries: string[], query: string): string {
  const lines: string[] = [];
  let chars = 0;
  for (const entry of entries) {
    const line = `- ${JSON.stringify(entry)}`;
    if (lines.length === 20 || chars + line.length + 1 > 1400) break;
    lines.push(line);
    chars += line.length + 1;
  }
  if (lines.length < entries.length) lines.push(`... ${entries.length - lines.length} more entries; use ${query}.`);
  return lines.join('\n');
}
