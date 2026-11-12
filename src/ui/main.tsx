import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider, createBrowserRouter } from "react-router-dom";
import { WorkspaceScreen } from "./screens/WorkspaceScreen";
import { DeckScreen } from "./screens/DeckScreen";
import { SlideEditor } from "./screens/SlideEditor";
import "./styles.css";

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } },
});

// A data router, so the editor can block navigation while it has unsaved changes.
const router = createBrowserRouter([
  { path: "/", element: <WorkspaceScreen /> },
  { path: "/decks/:id", element: <DeckScreen /> },
  { path: "/decks/:id/slides/:slideId", element: <SlideEditor /> },
]);

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  </StrictMode>,
);
