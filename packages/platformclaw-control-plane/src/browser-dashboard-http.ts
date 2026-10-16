import type { IncomingMessage, ServerResponse } from "node:http";
import { readPlatformClawSessionCookie } from "./browser-auth-http.js";
import type { BrowserAuthService } from "./browser-auth-service.js";
import { sendBrowserJson } from "./browser-http-shared.js";
import {
  DashboardQueryError,
  DashboardBusyError,
  parseDashboardQuery,
  type DashboardService,
} from "./dashboard-service.js";

const PLATFORMCLAW_DASHBOARD_PATH = "/platformclaw/api/dashboard";

export async function handlePlatformClawDashboardRequest(
  req: IncomingMessage,
  res: ServerResponse,
  options: {
    authService: Pick<BrowserAuthService, "authenticateToken">;
    service: DashboardService;
  },
): Promise<boolean> {
  const url = new URL(req.url ?? "/", "http://localhost");
  if (url.pathname !== PLATFORMCLAW_DASHBOARD_PATH) {
    return false;
  }
  try {
    const token = readPlatformClawSessionCookie(req);
    // Aggregate visibility is explicitly available to every active member.
    // Browser Gateway access stays personal and cannot expose other transcripts.
    const authentication = token ? await options.authService.authenticateToken(token) : null;
    if (!token || authentication?.status !== "active") {
      sendBrowserJson(res, 401, { error: "authentication required" });
      return true;
    }
    if (req.method !== "GET") {
      res.setHeader("Allow", "GET");
      sendBrowserJson(res, 405, { error: "method not allowed" });
      return true;
    }
    const report = await options.service.report(parseDashboardQuery(url), authentication.user.id);
    const workbook =
      url.searchParams.get("format") === "xlsx"
        ? await import("./dashboard-export.js").then((module) =>
            module.createDashboardWorkbook(report),
          )
        : null;
    if ((await options.authService.authenticateToken(token, false)).status !== "active") {
      sendBrowserJson(res, 401, { error: "authentication required" });
      return true;
    }
    if (workbook) {
      res.statusCode = 200;
      res.setHeader(
        "Content-Type",
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      );
      res.setHeader(
        "Content-Disposition",
        `attachment; filename="platformclaw-dashboard-${report.query.startDate}-${report.query.endDate}.xlsx"`,
      );
      res.setHeader("Cache-Control", "no-store");
      res.setHeader("X-Content-Type-Options", "nosniff");
      res.end(workbook);
    } else {
      sendBrowserJson(res, 200, report);
    }
  } catch (error) {
    if (error instanceof DashboardBusyError) {
      res.setHeader("Retry-After", "60");
    }
    sendBrowserJson(
      res,
      error instanceof DashboardQueryError ? 400 : error instanceof DashboardBusyError ? 429 : 503,
      {
        error:
          error instanceof DashboardQueryError || error instanceof DashboardBusyError
            ? error.message
            : "Dashboard unavailable. Refresh to retry.",
      },
    );
  }
  return true;
}
