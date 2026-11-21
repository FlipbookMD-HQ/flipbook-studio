import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider, createBrowserRouter } from "react-router-dom";
import { WorkspaceScreen } from "./screens/WorkspaceScreen";
import { DeckScreen } from "./screens/DeckScreen";
import { SlideEditor } from "./screens/SlideEditor";
import { ThemesScreen } from "./screens/ThemesScreen";
import { ThemeEditor } from "./screens/ThemeEditor";
import { TemplatesScreen } from "./screens/TemplatesScreen";
import { TemplateEditor } from "./screens/TemplateEditor";
import { BlueprintsScreen } from "./screens/BlueprintsScreen";
import { BlueprintScreen } from "./screens/BlueprintScreen";
import { MediaKitsScreen } from "./screens/MediaKitsScreen";
import { MediaKitScreen } from "./screens/MediaKitScreen";
import { SettingsScreen } from "./screens/SettingsScreen";
import { registerStudioWorker } from "./pwa";
import "./styles.css";

registerStudioWorker();

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } },
});

// A data router, so the editor can block navigation while it has unsaved changes.
const router = createBrowserRouter([
  { path: "/", element: <WorkspaceScreen /> },
  { path: "/decks/:id", element: <DeckScreen /> },
  { path: "/decks/:id/slides/:slideId", element: <SlideEditor /> },
  { path: "/kits/themes", element: <ThemesScreen /> },
  { path: "/kits/themes/new", element: <ThemeEditor /> },
  { path: "/kits/themes/:scope/:name", element: <ThemeEditor /> },
  { path: "/kits/templates", element: <TemplatesScreen /> },
  { path: "/kits/templates/new", element: <TemplateEditor /> },
  { path: "/kits/templates/library/:name", element: <TemplateEditor /> },
  { path: "/kits/templates/deck/:deckId/:name", element: <TemplateEditor /> },
  { path: "/kits/blueprints", element: <BlueprintsScreen /> },
  { path: "/kits/blueprints/new", element: <BlueprintScreen /> },
  { path: "/kits/blueprints/library/:name", element: <BlueprintScreen /> },
  { path: "/kits/blueprints/deck/:deckId", element: <BlueprintScreen /> },
  { path: "/kits/media", element: <MediaKitsScreen /> },
  { path: "/settings", element: <SettingsScreen /> },
  { path: "/kits/media/new", element: <MediaKitScreen /> },
  { path: "/kits/media/library/:name", element: <MediaKitScreen /> },
  { path: "/kits/media/builtin/:name", element: <MediaKitScreen /> },
]);

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  </StrictMode>,
);
