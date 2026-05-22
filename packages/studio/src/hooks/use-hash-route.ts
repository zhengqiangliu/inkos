import { useState, useEffect, useCallback } from "react";

export type HashRoute =
  | { page: "dashboard" }
  | { page: "book"; bookId: string }
  | { page: "book-create" }
  | { page: "services" }
  | { page: "service-detail"; serviceId: string }
  | { page: "chapter"; bookId: string; chapterNumber: number }
  | { page: "analytics"; bookId: string }
  | { page: "truth"; bookId: string }
  | { page: "daemon" }
  | { page: "logs" }
  | { page: "tasks" }
  | { page: "genres" }
  | { page: "style" }
  | { page: "import" }
  | { page: "radar" }
  | { page: "doctor" };

function parseHash(hash: string): HashRoute {
  const path = hash.replace(/^#\/?/, "");

  if (!path || path === "/") return { page: "dashboard" };
  if (path === "config" || path === "services") return { page: "services" };
  if (path === "tasks") return { page: "tasks" };
  if (path === "logs") return { page: "logs" };
  if (path === "genres") return { page: "genres" };
  if (path === "style") return { page: "style" };
  if (path === "import") return { page: "import" };
  if (path === "radar") return { page: "radar" };
  if (path === "doctor") return { page: "doctor" };
  if (path === "book/new") return { page: "book-create" };

  const analyticsMatch = path.match(/^analytics\/([^/]+)$/);
  if (analyticsMatch) return { page: "analytics", bookId: decodeURIComponent(analyticsMatch[1]) };

  const truthMatch = path.match(/^truth\/([^/]+)$/);
  if (truthMatch) return { page: "truth", bookId: decodeURIComponent(truthMatch[1]) };

  const chapterMatch = path.match(/^chapter\/([^/]+)\/(\d+)$/);
  if (chapterMatch) {
    return {
      page: "chapter",
      bookId: decodeURIComponent(chapterMatch[1]),
      chapterNumber: Number(chapterMatch[2]),
    };
  }

  const serviceMatch = path.match(/^services\/([^/]+)$/);
  if (serviceMatch) return { page: "service-detail", serviceId: decodeURIComponent(serviceMatch[1]) };

  const bookMatch = path.match(/^book\/([^/]+)$/);
  if (bookMatch) return { page: "book", bookId: decodeURIComponent(bookMatch[1]) };

  return { page: "dashboard" };
}

function routeToHash(route: HashRoute): string {
  switch (route.page) {
    case "dashboard": return "#/";
    case "book": return `#/book/${encodeURIComponent(route.bookId)}`;
    case "book-create": return "#/book/new";
    case "services": return "#/services";
    case "service-detail": return `#/services/${encodeURIComponent(route.serviceId)}`;
    case "analytics": return `#/analytics/${encodeURIComponent(route.bookId)}`;
    case "truth": return `#/truth/${encodeURIComponent(route.bookId)}`;
    case "chapter": return `#/chapter/${encodeURIComponent(route.bookId)}/${route.chapterNumber}`;
    case "tasks": return "#/tasks";
    case "logs": return "#/logs";
    case "genres": return "#/genres";
    case "style": return "#/style";
    case "import": return "#/import";
    case "radar": return "#/radar";
    case "doctor": return "#/doctor";
    default: return "";
  }
}

export { parseHash, routeToHash }; // for testing

const HASH_PAGES = new Set(["dashboard", "book", "book-create", "services", "service-detail", "chapter", "analytics", "truth", "tasks", "logs", "genres", "style", "import", "radar", "doctor"]);

export function useHashRoute() {
  const [route, setRouteState] = useState<HashRoute>(() => parseHash(window.location.hash));

  useEffect(() => {
    const onHashChange = () => setRouteState(parseHash(window.location.hash));
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, []);

  const setRoute = useCallback((newRoute: HashRoute) => {
    if (HASH_PAGES.has(newRoute.page)) {
      const hash = routeToHash(newRoute);
      if (hash) {
        window.location.hash = hash;
        return;
      }
    }
    setRouteState(newRoute);
  }, []);

  const nav = {
    toServices: () => setRoute({ page: "services" }),
    toServiceDetail: (id: string) => setRoute({ page: "service-detail", serviceId: id }),
  };

  return { route, setRoute, nav };
}
