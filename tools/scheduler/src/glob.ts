/** Minimal gitignore-style matcher: `dir/` is a prefix, `*` is within a segment, `**` spans segments. */
export function globToRegExp(glob: string): RegExp {
  if (glob.endsWith("/")) return new RegExp("^" + escape(glob) + ".*$");
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*") {
      if (glob[i + 1] === "*") {
        i++;
        if (glob[i + 1] === "/") {
          i++;
          re += "(?:.*/)?";
        } else re += ".*";
      } else re += "[^/]*";
    } else if (c === "?") re += "[^/]";
    else re += escape(c);
  }
  return new RegExp("^" + re + "$");
}

function escape(s: string): string {
  return s.replace(/[.+^${}()|[\]\\]/g, "\\$&");
}

export function matchesAny(path: string, globs: string[]): boolean {
  return globs.some((g) => globToRegExp(g).test(path));
}
