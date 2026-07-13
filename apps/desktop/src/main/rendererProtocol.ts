import { readFile, realpath } from "node:fs/promises";
import { extname, relative, resolve, sep } from "node:path";

export const RAILGUN_RENDERER_URL = "railgun://app/";

const CONTENT_TYPES: Readonly<Record<string, string>> = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".otf": "font/otf",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

const isInside = (root: string, candidate: string): boolean => {
  const pathFromRoot = relative(root, candidate);
  return pathFromRoot === "" || (!pathFromRoot.startsWith(`..${sep}`) && pathFromRoot !== "..");
};

export interface RendererAssetRoute {
  readonly method: "GET" | "HEAD";
  readonly path: string;
}

export const resolveRendererAsset = (
  rendererRoot: string,
  requestUrl: string,
  requestMethod: string,
): RendererAssetRoute | undefined => {
  const method = requestMethod.toUpperCase();
  if (method !== "GET" && method !== "HEAD") return undefined;

  let url: URL;
  try {
    url = new URL(requestUrl);
  } catch {
    return undefined;
  }
  if (url.protocol !== "railgun:" || url.hostname !== "app" || url.username !== "" || url.password !== "") {
    return undefined;
  }

  const authorityEnd = requestUrl.indexOf("/", "railgun://".length);
  const rawPath = authorityEnd < 0 ? "/" : requestUrl.slice(authorityEnd).split(/[?#]/u, 1)[0] ?? "/";
  let decodedPath: string;
  try {
    decodedPath = decodeURIComponent(rawPath);
  } catch {
    return undefined;
  }
  if (decodedPath.includes("\\") || decodedPath.includes("\0")) return undefined;
  const segments = decodedPath.split("/");
  if (segments.some((segment) => segment === "." || segment === "..")) return undefined;

  const relativePath = decodedPath === "/" ? "index.html" : decodedPath.replace(/^\/+/, "");
  if (relativePath.length === 0) return undefined;
  const root = resolve(rendererRoot);
  const assetPath = resolve(root, relativePath);
  if (!isInside(root, assetPath)) return undefined;
  return { method, path: assetPath };
};

export const createRendererProtocolHandler = (rendererRoot: string) => {
  const rootPath = realpath(rendererRoot);
  return async (request: Request): Promise<Response> => {
    const route = resolveRendererAsset(rendererRoot, request.url, request.method);
    if (route === undefined) return new Response("Not found", { status: 404 });

    try {
      const [resolvedRoot, assetPath] = await Promise.all([rootPath, realpath(route.path)]);
      if (!isInside(resolvedRoot, assetPath)) return new Response("Not found", { status: 404 });
      const body = route.method === "HEAD" ? undefined : new Uint8Array(await readFile(assetPath));
      return new Response(body, {
        status: 200,
        headers: {
          "Content-Type": CONTENT_TYPES[extname(assetPath).toLowerCase()] ?? "application/octet-stream",
          "X-Content-Type-Options": "nosniff",
        },
      });
    } catch {
      return new Response("Not found", { status: 404 });
    }
  };
};
