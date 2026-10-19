// Minimal router. A route is registered with a method, a path such as
// "/api/admin/devices/:id", and options:
//   public: true   no sign-in required
//   perm: "x.y"    caller needs this permission (checked in the company scope)
//   any: true      any signed-in user (default requires nothing beyond sign-in)
//   allowTemp: true  usable while a temporary password is still active
export function createRouter() {
  const routes = [];
  const add = (method) => (pattern, options, handler) => {
    if (typeof options === "function") [handler, options] = [options, {}];
    const keys = [];
    const regex = new RegExp(
      "^" +
        pattern.replace(/:([a-z]+)/gi, (_, k) => (keys.push(k), "([^/]+)")) +
        "$",
    );
    routes.push({ method, regex, keys, options, handler });
  };
  return {
    get: add("GET"),
    post: add("POST"),
    put: add("PUT"),
    patch: add("PATCH"),
    delete: add("DELETE"),
    match(method, path) {
      let pathMatched = false;
      for (const r of routes) {
        const m = r.regex.exec(path);
        if (!m) continue;
        pathMatched = true;
        if (r.method !== method) continue;
        return {
          route: r,
          params: Object.fromEntries(
            r.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])]),
          ),
        };
      }
      return { route: null, pathMatched };
    },
  };
}
