import { fromDirectoryTreeRegistry, isChartOwner, type DirectoryTreeNode } from '../chartBuild/partition/directoryTree.js';

/** Read module boundaries without treating headings in fenced examples as modules. */
export function projectStateModules(content: string): { name: string; content: string }[] {
  const modules: { name: string; content: string }[] = [];
  const lines = content.split(/\r?\n/);
  let fence = '';
  let active = false;
  let current: { name: string; lines: string[] } | undefined;
  const flush = () => {
    if (current) modules.push({ name: current.name, content: current.lines.join('\n').trim() });
    current = undefined;
  };
  for (const line of lines) {
    const marker = line.match(/^\s{0,3}(`{3,}|~{3,})/);
    if (marker) {
      if (!fence) fence = marker[1];
      else if (marker[1][0] === fence[0] && marker[1].length >= fence.length) fence = '';
      current?.lines.push(line);
      continue;
    }
    if (!fence) {
      if (/^#{1,2} /.test(line)) {
        flush();
        active = /^## Module Status\s*#*\s*$/.test(line);
      }
      const heading = active && line.match(/^###\s+(.+?)\s*#*\s*$/);
      if (heading) { flush(); current = { name: heading[1], lines: [line] }; continue; }
    }
    current?.lines.push(line);
  }
  flush();
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
