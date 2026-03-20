const ALLOWED_REPO = "XMOJ-Script-dev/ELXMOJ";

function json(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      "content-type": "application/json; charset=UTF-8",
      "cache-control": "no-store"
    }
  });
}

function parseVersionAndExt(fileToken) {
  // Supports examples like:
  // - 1.2.3.exe
  // - v1.2.3-x64.exe
  // - 1.2.3-beta.1.zip
  const dotIndex = fileToken.lastIndexOf(".");
  if (dotIndex <= 0 || dotIndex === fileToken.length - 1) {
    return null;
  }

  const version = fileToken.slice(0, dotIndex).trim();
  const ext = fileToken.slice(dotIndex + 1).trim().toLowerCase();
  if (!version || !ext) {
    return null;
  }

  return { version, ext };
}

function normalizeOs(osSegment) {
  const raw = osSegment.toLowerCase();
  if (["win", "windows"].includes(raw)) return "windows";
  if (["linux"].includes(raw)) return "linux";
  if (["mac", "macos", "darwin", "osx"].includes(raw)) return "macos";
  return raw;
}

function normalizeArch(arch) {
  const raw = arch.toLowerCase();
  if (["x64", "amd64"].includes(raw)) return "x64";
  if (["x86", "ia32", "i386"].includes(raw)) return "x86";
  if (["arm64", "aarch64"].includes(raw)) return "arm64";
  if (["armv7", "arm"].includes(raw)) return "armv7";
  return raw;
}

function inferArchFromUserAgent(userAgent = "") {
  const ua = userAgent.toLowerCase();
  if (ua.includes("aarch64") || ua.includes("arm64")) return "arm64";
  if (ua.includes("arm")) return "armv7";
  if (ua.includes("x86_64") || ua.includes("win64") || ua.includes("x64")) return "x64";
  if (ua.includes("i386") || ua.includes("i686") || ua.includes("x86")) return "x86";
  return "x64";
}

function buildAssetName(version, os, arch, ext) {
  return `ELXMOJ-${version}-${os}-${arch}.${ext}`;
}

function buildTagCandidates(version) {
  const normalized = version.replace(/^v/i, "");
  const candidates = [version, `v${normalized}`];
  return [...new Set(candidates)];
}

function getGitHubToken(env) {
  // Support common secret names and strip accidental wrapping quotes.
  const raw = env.GITHUB_TOKEN || env.GITHUBTOKEN || env.GH_TOKEN || "";
  return String(raw).trim().replace(/^['\"]|['\"]$/g, "");
}

function buildCacheKey(requestUrl, parsed) {
  const keyUrl = new URL(requestUrl);
  // Ensure cache key is stable and architecture-safe even when arch is inferred from UA.
  keyUrl.searchParams.set("__resolved_arch", parsed.arch);
  return new Request(keyUrl.toString(), { method: "GET" });
}

function withCacheStatus(response, status) {
  const headers = new Headers(response.headers);
  headers.set("x-downhelper-cache", status);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers
  });
}

async function fetchReleaseAsset(repo, version, assetName, request, env) {
  const token = getGitHubToken(env);
  const range = request.headers.get("range");

  const upstreamHeaders = new Headers({
    "user-agent": "downhelper-worker"
  });
  if (range) {
    upstreamHeaders.set("range", range);
  }
  if (token) {
    upstreamHeaders.set("authorization", `Bearer ${token}`);
  }

  const tagCandidates = buildTagCandidates(version);
  let lastNon404 = null;

  for (const tag of tagCandidates) {
    const downloadUrl = `https://github.com/${repo}/releases/download/${encodeURIComponent(tag)}/${encodeURIComponent(assetName)}`;
    const resp = await fetch(downloadUrl, {
      method: "GET",
      headers: upstreamHeaders,
      redirect: "follow"
    });

    if (resp.ok || resp.status === 206) {
      return { ok: true, response: resp, matchedTag: tag };
    }

    if (resp.status !== 404) {
      lastNon404 = { status: resp.status, tag };
    }
  }

  if (lastNon404) {
    return { ok: false, errorType: "upstream", ...lastNon404 };
  }

  return { ok: false, errorType: "not_found", tagCandidates };
}

function pickResponseHeaders(upstreamHeaders, fallbackFileName) {
  const headers = new Headers();
  const passthrough = [
    "content-type",
    "content-length",
    "content-range",
    "accept-ranges",
    "etag",
    "last-modified",
    "cache-control"
  ];

  for (const key of passthrough) {
    const value = upstreamHeaders.get(key);
    if (value) {
      headers.set(key, value);
    }
  }

  if (!headers.get("content-disposition")) {
    headers.set("content-disposition", `attachment; filename=\"${fallbackFileName}\"`);
  }

  // Versioned release assets are immutable and suitable for long edge/browser caching.
  if (!headers.get("cache-control")) {
    headers.set("cache-control", "public, max-age=86400, s-maxage=31536000, immutable");
  }

  // Keep browser/proxy behavior explicit.
  headers.set("x-accel-source", "cloudflare-worker-proxy");
  return headers;
}

function parseRequest(url, request) {
  // Path format:
  // /{os}/{version}[***].{ext}
  // Example:
  // /win/1.2.3.exe
  // /linux/v1.2.3-x64.tar.gz  (treated ext as gz; recommend simple ext like exe/zip/dmg/AppImage)
  const parts = url.pathname.split("/").filter(Boolean);
  if (parts.length < 2) {
    return {
      error: "Path should be /{os}/{version}.{ext}, for example /win/1.2.3.exe"
    };
  }

  const os = normalizeOs(parts[0]);
  const fileToken = parts.slice(1).join("/");
  const parsed = parseVersionAndExt(fileToken);
  if (!parsed) {
    return {
      error: "Cannot parse version/ext from URL. Expected /{os}/{version}.{ext}"
    };
  }

  const requestArch = url.searchParams.get("arch");
  const arch = normalizeArch(requestArch || inferArchFromUserAgent(request.headers.get("user-agent") || ""));

  return {
    os,
    version: parsed.version,
    ext: parsed.ext,
    arch
  };
}

export default {
  async fetch(request, env) {
    try {
      const url = new URL(request.url);

      if (url.pathname === "/" || url.pathname === "/healthz") {
        return json({
          ok: true,
          usage: "GET /{os}/{version}.{ext}?arch=x64",
          naming: "ELXMOJ-${version}-${os}-${arch}.${ext}",
          repo: ALLOWED_REPO
        });
      }

      const parsed = parseRequest(url, request);
      if (parsed.error) {
        return json({ ok: false, error: parsed.error }, 400);
      }

      const repo = ALLOWED_REPO;
      const assetName = buildAssetName(parsed.version, parsed.os, parsed.arch, parsed.ext);
      const cache = caches.default;

      // Proxy download through Cloudflare Worker instead of redirecting.
      // This keeps client URL on your domain and supports resume via Range.
      const method = request.method.toUpperCase();
      const range = request.headers.get("range");
      const canUseCache = method === "GET" && !range;
      const cacheKey = canUseCache ? buildCacheKey(request.url, parsed) : null;

      if (canUseCache && cacheKey) {
        const hit = await cache.match(cacheKey);
        if (hit) {
          return withCacheStatus(hit, "HIT");
        }
      }

      const upstreamResult = await fetchReleaseAsset(repo, parsed.version, assetName, request, env);
      if (!upstreamResult.ok) {
        if (upstreamResult.errorType === "not_found") {
          return json(
            {
              ok: false,
              error: "Asset not found",
              expectedAssetName: assetName,
              repo,
              tagCandidatesTried: upstreamResult.tagCandidates
            },
            404
          );
        }

        return json(
          {
            ok: false,
            error: "Failed to fetch GitHub asset",
            status: upstreamResult.status,
            matchedTag: upstreamResult.tag
          },
          502
        );
      }

      const upstreamResp = upstreamResult.response;

      if (!upstreamResp.ok && upstreamResp.status !== 206) {
        return json(
          {
            ok: false,
            error: "Failed to fetch GitHub asset",
            status: upstreamResp.status,
            expectedAssetName: assetName
          },
          502
        );
      }

      const proxiedResponse = new Response(upstreamResp.body, {
        status: upstreamResp.status,
        headers: pickResponseHeaders(upstreamResp.headers, assetName)
      });

      if (canUseCache && cacheKey && proxiedResponse.status === 200) {
        await cache.put(cacheKey, proxiedResponse.clone());
        return withCacheStatus(proxiedResponse, "MISS-STORED");
      }

      if (range) {
        return withCacheStatus(proxiedResponse, "BYPASS-RANGE");
      }

      return withCacheStatus(proxiedResponse, "BYPASS");
    } catch (error) {
      return json(
        {
          ok: false,
          error: "Internal error",
          detail: String(error)
        },
        500
      );
    }
  }
};
