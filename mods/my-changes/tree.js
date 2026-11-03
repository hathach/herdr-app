// The changed files as a folder tree for the Changes list. Pure (no herdr imports) so `node --test` loads it.

// Files ({ path, ... }) -> a root folder { name, path, dirs: [], files: [] }, each list sorted by name as Files
// sorts; file objects are kept, not copied.
export function fileTree(files) {
  const root = { name: "", path: "", dirs: new Map(), files: [] };
  for (const file of files) {
    const parts = file.path.split("/");
    let dir = root;
    for (const name of parts.slice(0, -1)) {
      if (!dir.dirs.has(name)) dir.dirs.set(name, { name, path: dir.path ? `${dir.path}/${name}` : name, dirs: new Map(), files: [] });
      dir = dir.dirs.get(name);
    }
    dir.files.push(file);
  }
  const sort = (dir) => {
    dir.dirs = [...dir.dirs.values()].sort((a, b) => a.name.localeCompare(b.name));
    dir.files.sort((a, b) => a.path.localeCompare(b.path));
    dir.dirs.forEach(sort);
  };
  sort(root);
  return root;
}

// The rows shown, folders before files; a collapsed folder's (path in `collapsed`) contents are left out.
export function treeRows(dir, collapsed, depth = 0, out = []) {
  for (const sub of dir.dirs) {
    out.push({ dir: sub.path, name: sub.name, depth });
    if (!collapsed.has(sub.path)) treeRows(sub, collapsed, depth + 1, out);
  }
  for (const file of dir.files) out.push({ file, depth });
  return out;
}
